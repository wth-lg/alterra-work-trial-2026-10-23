// The grader validation matrix (design section 5, plan phase P9): every case of a task, run as
// a scripted model through run() (the same loop, tools, replay and hashes as a live trial),
// then graded by the task's checks from the trajectory, with judge items answered only from the
// task's canned judge cache. It never makes a live call: the scripted client is the only
// client, and a judge question the cache does not hold is a miss, named and failed, never sent
// and never counted as unknown. `pnpm cli oracle --live-judge` is the one path that asks the
// judge live and refreshes the cache (cli/oracle.ts).
//
// The matrix passes when:
//   oracle            PASS, score 1.0, no judge item unknown
//   alternatives      at least MIN_ALTERNATIVES, each PASS
//   mutants           at least MIN_MUTANTS, each FAIL with exactly its declared failed gates;
//                     every trap task.toml declares has one, and every mutant's trap is declared
//   null, spray, output-gap, and status-only where the task declares it
//                     FAIL (a model FAIL: outcome FAIL, fault model)
//   every case        graded validly (a GRADER_ERROR names its check), no judge cache miss,
//                     the same grade twice from the record (regrade idempotence), and the same
//                     trajectory and final hash when run again (replay determinism)
//   double derivation expected.ts equals policy.ts applied to the initial world
//   traceability      every check's traces_to resolves to a line of instruction.md
//                     (instruction.md:<n>) or a policy (<policy id>, optionally ' §<section>'
//                     found in its text)
import { MODEL, type CallResult, type ContentBlock, type MessageParam } from '../../core/anthropic.ts';
import type { TrialEvent } from '../../core/events.ts';
import type { TrialClient } from '../../core/loop.ts';
import { gradeTrajectory, run, type TrialRecord } from '../../core/run.ts';
import type { TaskSource } from '../../core/tasks.ts';
import { stripTimestamps, toJsonl } from '../../core/trajectory.ts';
import { loadStore, type FixtureSource } from '../../env/fixture-source.ts';
import { canonicalJson } from '../../env/hash.ts';
import type { indexDefinitions } from '../../env/validate.ts';
import type { Check, RubricCheck } from '../check.ts';
import type { Grade } from '../grade.ts';
import { JudgeCacheMiss } from '../judge.ts';
import type { Agent, Declares, MatrixTask, Mutant, Script, WorldView } from './types.ts';

export const MIN_ALTERNATIVES = 3;
export const MIN_MUTANTS = 4;

// The null agent: finishes at once, having done nothing.
export const NULL_AGENT: Script = [{ calls: [{ name: 'finish', input: { summary: 'No action taken.' } }] }];

export interface MatrixEnv {
  tasks: TaskSource;
  world: FixtureSource;
  worldHash: string;
  definitions?: Parameters<typeof indexDefinitions>[0];
  now: () => number;
}

export type CaseKind = 'oracle' | 'alternative' | 'mutant' | 'null' | 'spray' | 'output-gap' | 'status-only';

export interface Case {
  kind: CaseKind;
  id: string;
  script: Script;
  mutant?: Mutant;
}

// What task.toml's [matrix] table declares, from the parsed task.toml; absent, nothing is.
export function declaresOf(toml: Record<string, unknown>): Declares {
  const m = (toml.matrix ?? {}) as { traps?: unknown; status_only?: unknown };
  const traps = m.traps ?? [];
  if (!Array.isArray(traps) || !traps.every((t) => typeof t === 'string')) throw new Error('task.toml [matrix] traps must be a list of strings');
  if (m.status_only !== undefined && typeof m.status_only !== 'boolean') throw new Error('task.toml [matrix] status_only must be true or false');
  return { traps, status_only: m.status_only === true };
}

// A model that answers from the script: each send appends the next answer to history, as
// MessagesClient does, with no usage and no cost. Past the last answer it ends its turn.
export function scriptedClient(script: Script, label: string): TrialClient {
  let n = 0;
  return {
    async send(history: MessageParam[]): Promise<CallResult> {
      const turn = script[n++];
      const calls = turn?.calls ?? [];
      const content: ContentBlock[] = [
        ...(turn?.text !== undefined ? [{ type: 'text', text: turn.text }] : turn === undefined ? [{ type: 'text', text: 'Script ended.' }] : []),
        ...calls.map((c, i) => ({ type: 'tool_use', id: `toolu_${label}_${n}_${i + 1}`, name: c.name, input: structuredClone(c.input) })),
      ];
      history.push({ role: 'assistant', content });
      const usage = { input_tokens: 0, output_tokens: 0 };
      return { status: 200, message: { id: `msg_${label}_${n}`, model: MODEL, role: 'assistant', content, stop_reason: calls.length > 0 ? 'tool_use' : 'end_turn', usage }, refusal: null, attempts: 1 };
    },
  };
}

// Every case of the task, in report order.
export function cases(task: MatrixTask): Case[] {
  return [
    ...(task.oracle === null ? [] : [{ kind: 'oracle' as const, id: 'oracle', script: task.oracle }]),
    ...task.alternatives.map((a: Agent) => ({ kind: 'alternative' as const, id: a.id, script: a.script })),
    ...task.mutants.map((m) => ({ kind: 'mutant' as const, id: m.id, script: m.script, mutant: m })),
    { kind: 'null' as const, id: 'null', script: NULL_AGENT },
    ...(task.agents.spray ? [{ kind: 'spray' as const, id: 'spray', script: task.agents.spray }] : []),
    ...(task.agents.output_gap ? [{ kind: 'output-gap' as const, id: 'output-gap', script: task.agents.output_gap }] : []),
    ...(task.agents.status_only ? [{ kind: 'status-only' as const, id: 'status-only', script: task.agents.status_only }] : []),
  ];
}

const labelOf = (c: Case) => `${c.kind}-${c.id}`.replace(/[^A-Za-z0-9_-]/g, '_');

// One scripted trial. With `judge`, run() grades it with the task's checks, judge items through
// that client (oracle --live-judge); without, it is not graded here.
export function trial(env: MatrixEnv, task: MatrixTask, c: Case, judge?: TrialClient): Promise<{ record: TrialRecord; events: readonly TrialEvent[] }> {
  return run(task.id, MODEL, {
    tasks: env.tasks, client: scriptedClient(c.script, labelOf(c)), world: env.world, worldHash: env.worldHash, now: env.now,
    ...(env.definitions ? { definitions: env.definitions } : {}),
    trialId: `matrix:${task.id}:${labelOf(c)}`,
    checks: judge ? task.checks : [],
    judge: judge ?? null,
  });
}

export interface Miss {
  check: string;
  key: string;
}

// The task's checks, each judge-asking rubric item reporting a cache miss instead of throwing,
// so one grading names every item the cache lacks.
function missRecording(checks: readonly Check[], misses: Miss[]): Check[] {
  return checks.map((c): Check => {
    if (c.kind !== 'rubric') return c;
    const fn: RubricCheck['fn'] = async (ctx) => {
      try {
        return await c.fn(ctx);
      } catch (e) {
        if (!(e instanceof JudgeCacheMiss)) throw e;
        const key = /judge cache miss ([0-9a-f]+)/.exec(e.message)?.[1] ?? e.message;
        misses.push({ check: c.id, key });
        return { met: 'unknown', evidence: { judge_cache_miss: key } };
      }
    };
    return { ...c, fn };
  });
}

export interface CaseResult {
  case: Case;
  grade: Grade;
  // Judge and hybrid items unknown for a reason other than a cache miss.
  unknown: number;
  misses: Miss[];
  failed_gates: string[];
  regrade_same: boolean;
  replay_same: boolean;
  // Why the case fails the matrix; empty when it holds.
  problems: string[];
}

const expectFail = (c: Case) => c.kind !== 'oracle' && c.kind !== 'alternative';

// Runs one case offline: the trial, its grade from the canned cache (twice), and a second run.
export async function runCase(env: MatrixEnv, task: MatrixTask, c: Case): Promise<CaseResult> {
  const first = await trial(env, task, c);
  const misses: Miss[] = [];
  const regrade = async () =>
    gradeTrajectory(task.id, {
      tasks: env.tasks, world: env.world, events: first.events, checks: missRecording(task.checks, misses),
      record: { ...first.record, judge: { cache: [...task.cache] } },
      ...(env.definitions ? { definitions: env.definitions } : {}),
    });
  const grade = await regrade();
  const firstMisses = misses.splice(0);
  const regrade_same = canonicalJson(await regrade()) === canonicalJson(grade);
  const again = await trial(env, task, c);
  const replay_same = stripTimestamps(toJsonl(again.events)) === stripTimestamps(toJsonl(first.events)) && again.record.state_hash.final === first.record.state_hash.final;

  const unknown = grade.checks.filter((r) => r.method !== 'code' && r.met === 'unknown' && !('judge_cache_miss' in r.evidence)).length;
  const failed_gates = grade.checks.filter((r) => r.kind === 'gate' && r.met === false).map((r) => r.id);
  const problems: string[] = [];
  if (grade.error !== null) problems.push(`${grade.outcome} in ${grade.error.check ?? 'trial'}: ${grade.error.message}`);
  else if (!grade.valid) problems.push(`outcome ${grade.outcome} (${first.record.status}${first.record.detail ? ` ${first.record.detail}` : ''}), not a graded trial`);
  else if (expectFail(c) && (grade.outcome !== 'FAIL' || grade.fault !== 'model')) problems.push(`outcome ${grade.outcome}, want a model FAIL`);
  else if (!expectFail(c) && grade.outcome !== 'PASS') problems.push(`outcome ${grade.outcome}, want PASS (failed: ${failed_gates.join(', ') || 'none'})`);
  if (c.kind === 'oracle' && grade.valid && grade.score !== 1) problems.push(`oracle score ${grade.score ?? 'n/a'}, want 1.0`);
  if (c.kind === 'oracle' && unknown > 0) problems.push(`oracle judge.unknown ${unknown}, want 0`);
  if (c.mutant && !sameSet(failed_gates, c.mutant.fails)) problems.push(`failed [${failed_gates.join(', ')}], declared [${c.mutant.fails.join(', ')}]`);
  for (const m of firstMisses) problems.push(`judge cache miss: ${m.check} (cache key ${m.key})`);
  if (!regrade_same) problems.push('a second grade from the same record differs');
  if (!replay_same) problems.push('a second run gives a different trajectory or final hash');
  return { case: c, grade, unknown, misses: firstMisses, failed_gates, regrade_same, replay_same, problems };
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');

// Each check whose traces_to resolves to nothing, with the reason.
export function traceability(task: MatrixTask): Array<{ check: string; reason: string }> {
  const lines = task.instruction.split('\n');
  return task.checks.flatMap((c) => {
    const t = c.traces_to.trim();
    const line = /^instruction\.md:(\d+)$/.exec(t);
    if (line) {
      const text = lines[Number(line[1]) - 1];
      return text === undefined || text.trim() === '' ? [{ check: c.id, reason: `${t} is ${text === undefined ? 'past the end of' : 'a blank line in'} instruction.md` }] : [];
    }
    const policy = /^([A-Za-z0-9-]+)(?: (§\S+))?$/.exec(t);
    const p = policy && task.policies.find((x) => x.id === policy[1]);
    if (!policy || !p) return [{ check: c.id, reason: `${JSON.stringify(c.traces_to)} names no line of instruction.md and no policy of the task` }];
    if (policy[2] !== undefined && !p.text.includes(policy[2])) return [{ check: c.id, reason: `policy ${p.id} has no ${policy[2]}` }];
    return [];
  });
}

async function doubleDerivation(env: MatrixEnv, task: MatrixTask): Promise<string | null> {
  if (task.expected === undefined) return 'no expected.ts (export const expected)';
  if (task.derive === undefined) return 'no policy.ts (export function derive)';
  const store = await loadStore(env.world);
  const all = [...store.resources()];
  const world: WorldView = { get: (type, id) => store.get(type, id), all: (type) => (type === undefined ? all : all.filter((r) => r.resourceType === type)) };
  const derived = task.derive(world);
  return canonicalJson(derived) === canonicalJson(task.expected) ? null : `expected.ts ${canonicalJson(task.expected)} != policy.ts ${canonicalJson(derived)}`;
}

export interface MatrixResult {
  pass: boolean;
  lines: string[];
  results: CaseResult[];
}

const score = (g: Grade) => (g.score === null ? 'n/a' : g.score.toFixed(3));

// Runs the whole matrix and reports it, one line per fact, the failures last.
export async function runMatrix(env: MatrixEnv, task: MatrixTask): Promise<MatrixResult> {
  const results: CaseResult[] = [];
  for (const c of cases(task)) results.push(await runCase(env, task, c));
  const failures: string[] = [];
  const lines: string[] = [`matrix ${task.id}`];
  const fail = (what: string) => failures.push(what);
  const byKind = (k: CaseKind) => results.filter((r) => r.case.kind === k);
  const nameOf = (c: Case) => (c.id === c.kind ? c.kind : `${c.kind} ${c.id}`);
  const noteProblems = (r: CaseResult) => r.problems.forEach((p) => fail(`${nameOf(r.case)}: ${p}`));

  const oracle = byKind('oracle')[0];
  if (oracle === undefined) {
    lines.push('oracle: missing (solution/solve.ts exports no oracle)');
    fail('no oracle');
  } else {
    lines.push(`oracle: ${oracle.grade.outcome} score ${score(oracle.grade)} judge.unknown ${oracle.unknown}`);
    noteProblems(oracle);
  }

  const alternatives = byKind('alternative');
  lines.push(`alternatives: n=${alternatives.length} (min ${MIN_ALTERNATIVES})`);
  if (alternatives.length < MIN_ALTERNATIVES) fail(`${alternatives.length} alternatives, need ${MIN_ALTERNATIVES}`);
  for (const r of alternatives) {
    lines.push(`  alternative ${r.case.id}: ${r.grade.outcome} score ${score(r.grade)}${r.problems.length ? ` (${r.problems.join('; ')})` : ''}`);
    noteProblems(r);
  }

  const mutants = byKind('mutant');
  lines.push(`mutants: n=${mutants.length} (min ${MIN_MUTANTS})`);
  if (mutants.length < MIN_MUTANTS) fail(`${mutants.length} mutants, need ${MIN_MUTANTS}`);
  for (const r of mutants) {
    const m = r.case.mutant!;
    const verdict = r.grade.outcome !== 'FAIL' ? 'not FAIL' : sameSet(r.failed_gates, m.fails) ? 'ok' : 'MISMATCH';
    lines.push(`  mutant ${m.id} [trap ${m.trap}]: ${r.grade.outcome} failed [${r.failed_gates.join(', ')}] declared [${m.fails.join(', ')}] ${verdict}`);
    noteProblems(r);
  }

  for (const kind of ['null', 'spray', 'output-gap', 'status-only'] as const) {
    const r = byKind(kind)[0];
    if (r === undefined) {
      if (kind === 'status-only') {
        lines.push(`status-only: ${task.declares.status_only ? 'MISSING, declared in task.toml' : 'not declared'}`);
        if (task.declares.status_only) fail('task.toml declares a status-only case and tests/agents.ts exports no status_only');
      } else {
        lines.push(`${kind}: MISSING`);
        fail(`no ${kind} agent (tests/agents.ts)`);
      }
      continue;
    }
    const attribution = r.grade.attribution ? ` attribution ${r.grade.attribution.auto}` : '';
    lines.push(`${kind}: ${r.grade.outcome} (want FAIL) failed [${r.failed_gates.join(', ')}]${attribution}${kind === 'status-only' && !task.declares.status_only ? ' (not declared)' : ''}`);
    noteProblems(r);
  }

  const derivation = await doubleDerivation(env, task);
  lines.push(`double derivation: ${derivation === null ? 'equal' : 'DIFFER'}`);
  if (derivation !== null) fail(`double derivation: ${derivation}`);

  const n = results.length;
  lines.push(`regrade idempotence: ${results.filter((r) => r.regrade_same).length}/${n} same grade`);
  lines.push(`replay determinism: ${results.filter((r) => r.replay_same).length}/${n} same trajectory and final hash`);

  const untraced = traceability(task);
  lines.push(`traceability: ${task.checks.length - untraced.length}/${task.checks.length} checks resolve${untraced.length ? ` (unresolved: ${untraced.map((u) => u.check).join(', ')})` : ''}`);
  for (const u of untraced) fail(`traceability: ${u.check}: ${u.reason}`);

  const covered = new Set(task.mutants.map((m) => m.trap));
  const uncovered = task.declares.traps.filter((t) => !covered.has(t));
  lines.push(`traps: ${task.declares.traps.length - uncovered.length}/${task.declares.traps.length} declared traps have a mutant`);
  for (const t of uncovered) fail(`trap ${t} has no mutant`);
  for (const m of task.mutants) if (!task.declares.traps.includes(m.trap)) fail(`mutant ${m.id} names trap ${m.trap}, which task.toml [matrix] traps does not declare`);

  const misses = results.flatMap((r) => r.misses.map((m) => ({ ...m, case: nameOf(r.case) })));
  lines.push(`judge cache: ${misses.length} miss${misses.length === 1 ? '' : 'es'}`);
  for (const m of misses) lines.push(`  miss ${m.case}: ${m.check} (cache key ${m.key})`);

  lines.push(`matrix ${task.id}: ${failures.length === 0 ? 'PASS' : 'FAIL'}`);
  for (const f of failures) lines.push(`  - ${f}`);
  return { pass: failures.length === 0, lines, results };
}
