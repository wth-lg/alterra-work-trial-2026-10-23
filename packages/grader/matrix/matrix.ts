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
//   alternatives      at least MIN_ALTERNATIVES, each PASS with no judge item unknown and
//                     exactly its declared `loses` rubric items lost ([] when absent)
//   mutants           at least MIN_MUTANTS, each FAIL with exactly its declared failed gates
//                     and exactly its declared `loses` rubric items lost ([] for none); every
//                     trap task.toml declares has one, and every mutant's trap is declared
//   loses             checked before any case runs, and nothing runs when it fails: every
//                     mutant declares it, and each id is a nonzero rubric item of the task,
//                     named once
//   null, spray, output-gap, and status-only where the task declares it
//                     FAIL (a model FAIL: outcome FAIL, fault model)
//   every case        graded validly (a GRADER_ERROR names its check), no judge cache miss,
//                     the same grade each time from the record (regrade idempotence), and the
//                     same trajectory and final hash when run again (replay determinism)
//   isolation         every grade in one process equals the same case graded in a fresh module
//                     graph (a child process, given as MatrixOptions.fresh). The process grades
//                     the cases in a fixed interleaved order: the oracle, each other case, the
//                     oracle again, then all of that reversed. A grade that differs means a check
//                     carried state from an earlier grading: 'cross-trial grader state'. This is
//                     the real guard; lint (no-grader-module-state) is the cheap first layer,
//                     blind to aliases, closures, class statics and helper modules
//   policy imports    policy.ts reaches no expected.ts and no overlay module (given as
//                     MatrixOptions.policyImports, which follows the whole import graph)
//   double derivation expected.ts equals policy.ts applied to the initial world
//   traceability      every check's traces_to resolves to a line of instruction.md
//                     (instruction.md:<n>) or a policy (<policy id>, optionally ' §<section>'
//                     found in its text)
// MatrixOptions narrow a run for a unit test: a subset of cases, one trial, one grade. The CI
// step runs the whole matrix with the defaults.
import { MODEL, type CallResult, type ContentBlock, type MessageParam } from '../../core/anthropic.ts';
import type { TrialEvent } from '../../core/events.ts';
import type { TrialClient } from '../../core/loop.ts';
import { gradeTrajectory, run, type TrialRecord } from '../../core/run.ts';
import type { TaskSource } from '../../core/tasks.ts';
import { stripTimestamps, toJsonl } from '../../core/trajectory.ts';
import { loadStore, type FixtureSource } from '../../env/fixture-source.ts';
import { canonicalJson } from '../../env/hash.ts';
import type { indexDefinitions } from '../../env/validate.ts';
import type { Check, Json, RubricCheck, RubricCtx } from '../check.ts';
import type { Grade } from '../grade.ts';
import { JudgeCacheMiss, type Judge } from '../judge.ts';
import type { Alternative, Declares, MatrixTask, Mutant, Script, WorldView } from './types.ts';

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
  // The rubric items it must lose: an alternative's (default []) or a mutant's (absent when a
  // task file leaves it out); absent for the other kinds, whose losses are not checked.
  loses?: readonly string[];
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
    ...task.alternatives.map((a: Alternative) => ({ kind: 'alternative' as const, id: a.id, script: a.script, loses: a.loses ?? [] })),
    ...task.mutants.map((m) => ({ kind: 'mutant' as const, id: m.id, script: m.script, mutant: m, ...(Array.isArray(m.loses) ? { loses: m.loses } : {}) })),
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

export interface MatrixOptions {
  // The cases to run, by id ('oracle', 'null', 'spray', 'output-gap', 'status-only' or an
  // alternative's or mutant's id); default every case. The counts, traps, traceability and
  // double derivation are checked whatever runs.
  cases?: readonly string[];
  // Runs of each case: 2 (default) checks replay determinism, 1 does not.
  trials?: 1 | 2;
  // Grades of each case from its record when there is no isolation check: default 2 (regrade
  // idempotence); 1 skips it.
  regrades?: number;
  // The isolation check, on by default when `fresh` is given.
  isolation?: boolean;
  // Grades one case's recorded run in a fresh module graph (cli/matrix.ts: a child process).
  fresh?: FreshGrade;
  // policy.ts's import graph (cli/matrix.ts policyImports): modules reached, and each problem.
  policyImports?: () => { modules: number; problems: string[] };
  // Given both runs of a case whose second run differs (cli/matrix.ts saves them), so the
  // first divergent step of a replay failure can be read after the fact.
  onReplayMismatch?: (c: Case, first: CaseRun, again: CaseRun, diff: ReplayDiff) => void;
}

export interface CaseRun {
  record: TrialRecord;
  events: readonly TrialEvent[];
}

export type FreshGrade = (c: Case, run: CaseRun) => Promise<Grade>;

// Where a second run of a case departs from the first: the 0-based line of the stripped
// trajectory (stripTimestamps) that first differs and both lines, or line null when the
// trajectories agree and only the final hash differs.
export interface ReplayDiff {
  line: number | null;
  first: string;
  again: string;
  summary: string;
}

// null when the second run reproduces the first: the same trajectory once timestamps are
// stripped, and the same final state hash. The matrix's replay determinism check.
export function replayDiff(first: CaseRun, again: CaseRun): ReplayDiff | null {
  const a = stripTimestamps(toJsonl(first.events)).split('\n');
  const b = stripTimestamps(toJsonl(again.events)).split('\n');
  const hashA = first.record.state_hash.final;
  const hashB = again.record.state_hash.final;
  // Both end in a newline, so a longer `b` differs at a's final empty line.
  const k = a.findIndex((l, i) => l !== b[i]);
  if (k === -1 && hashA === hashB) return null;
  const hash = hashA === hashB ? 'same final hash' : `final hash ${hashA} then ${hashB}`;
  if (k === -1) return { line: null, first: hashA ?? 'null', again: hashB ?? 'null', summary: `trajectories agree, ${hash}` };
  return { line: k, first: a[k] ?? '(no line)', again: b[k] ?? '(no line)', summary: `trajectory line ${k + 1} of ${a.length - 1} differs, ${hash}` };
}

// One grading of a recorded run from the cache, each judge cache miss recorded in `misses`
// instead of thrown. The matrix and its fresh-process grade both grade through this.
export function gradeRun(env: Pick<MatrixEnv, 'tasks' | 'world' | 'definitions'>, task: Pick<MatrixTask, 'id' | 'cache'>, checks: readonly Check[], run: CaseRun, misses: Miss[] = []): Promise<Grade> {
  return gradeTrajectory(task.id, {
    tasks: env.tasks, world: env.world, events: run.events, checks: missRecording(checks, misses),
    record: { ...run.record, judge: { cache: [...task.cache] } },
    ...(env.definitions ? { definitions: env.definitions } : {}),
  });
}

// Grades a recorded run with `judge` answering every judge and hybrid item instead of the
// record's cache. oracle --live-judge passes one Judge across all of a task's cases, so each
// distinct question is asked once, and the Judge's entries are the task's new cache.
export function gradeRunWith(env: Pick<MatrixEnv, 'tasks' | 'world' | 'definitions'>, task: Pick<MatrixTask, 'id' | 'checks'>, run: CaseRun, judge: Judge): Promise<Grade> {
  const checks = task.checks.map((c): Check => (c.kind !== 'rubric' ? c : { ...c, fn: (ctx: RubricCtx) => c.fn({ ...ctx, judge: (q) => judge.judge(q), extract: (q) => judge.extract(q) }) }));
  return gradeTrajectory(task.id, {
    tasks: env.tasks, world: env.world, events: run.events, checks,
    record: { ...run.record, judge: { cache: [] } },
    ...(env.definitions ? { definitions: env.definitions } : {}),
  });
}

export interface CaseResult {
  case: Case;
  grade: Grade;
  // Judge and hybrid items unknown for a reason other than a cache miss.
  unknown: number;
  misses: Miss[];
  failed_gates: string[];
  // Rubric items lost: a positive item not met, a penalty met (an unknown item is neither).
  lost_items: string[];
  // null when not checked (one grade, one trial, no fresh process).
  regrade_same: boolean | null;
  replay_same: boolean | null;
  // In-process grades of the case that equal its fresh-process grade, of how many.
  isolation: { equal: number; of: number } | null;
  // Why the case fails the matrix; empty when it holds.
  problems: string[];
}

const expectFail = (c: Case) => c.kind !== 'oracle' && c.kind !== 'alternative';
const nameOf = (c: Case) => (c.id === c.kind ? c.kind : `${c.kind} ${c.id}`);
// A grade as JSON carries it (the fresh process sends its grade as JSON), so the two compare.
const asJson = (g: Grade) => canonicalJson(JSON.parse(JSON.stringify(g)) as Json);

// The checks whose results differ between two grades, or 'the grade' when the checks agree.
function differing(a: Grade, b: Grade): string {
  const ids = a.checks.filter((r) => canonicalJson(r as unknown as Json) !== canonicalJson((b.checks.find((x) => x.id === r.id) ?? null) as unknown as Json)).map((r) => r.id);
  return ids.length ? ids.join(', ') : 'the grade';
}

// The case's verdict problems, from its first grade.
function verdict(c: Case, run: CaseRun, grade: Grade, misses: Miss[]): Pick<CaseResult, 'unknown' | 'failed_gates' | 'lost_items' | 'problems'> {
  const unknown = grade.checks.filter((r) => r.method !== 'code' && r.met === 'unknown' && !('judge_cache_miss' in r.evidence)).length;
  const failed_gates = grade.checks.filter((r) => r.kind === 'gate' && r.met === false).map((r) => r.id);
  const lost_items = grade.checks.filter((r) => r.kind === 'rubric' && ((r.points! > 0 && r.met === false) || (r.points! < 0 && r.met === true))).map((r) => r.id);
  const problems: string[] = [];
  if (grade.error !== null) problems.push(`${grade.outcome} in ${grade.error.check ?? 'trial'}: ${grade.error.message}`);
  else if (!grade.valid) problems.push(`outcome ${grade.outcome} (${run.record.status}${run.record.detail ? ` ${run.record.detail}` : ''}), not a graded trial`);
  else if (expectFail(c) && (grade.outcome !== 'FAIL' || grade.fault !== 'model')) problems.push(`outcome ${grade.outcome}, want a model FAIL`);
  else if (!expectFail(c) && grade.outcome !== 'PASS') problems.push(`outcome ${grade.outcome}, want PASS (failed: ${failed_gates.join(', ') || 'none'})`);
  if (c.kind === 'oracle' && grade.valid && grade.score !== 1) problems.push(`oracle score ${grade.score ?? 'n/a'}, want 1.0`);
  if (c.kind === 'oracle' && unknown > 0) problems.push(`oracle judge.unknown ${unknown}, want 0`);
  if (c.kind === 'alternative' && unknown > 0) problems.push(`judge.unknown ${unknown}, want 0`);
  if (c.mutant && !sameSet(failed_gates, c.mutant.fails)) problems.push(`failed [${failed_gates.join(', ')}], declared [${c.mutant.fails.join(', ')}]`);
  if (c.loses && grade.valid) {
    for (const id of c.loses) if (!lost_items.includes(id)) problems.push(`declares it loses rubric item ${kept(grade, id, misses)}`);
    for (const id of lost_items) if (!c.loses.includes(id)) problems.push(`loses rubric item ${id} (${pointsOf(grade, id)}${pointsOf(grade, id).startsWith('-') ? ', a penalty that applied' : ''}), not declared`);
  }
  for (const m of misses) problems.push(`judge cache miss: ${m.check} (cache key ${m.key})`);
  return { unknown, failed_gates, lost_items, problems };
}

const pointsOf = (grade: Grade, id: string) => {
  const p = grade.checks.find((r) => r.id === id)?.points ?? 0;
  return p > 0 ? `+${p}` : `${p}`;
};

// A declared loss the grade does not show, and why: the item graded unknown (a judge cache miss
// says so), a positive item was met, or a penalty did not apply.
function kept(grade: Grade, id: string, misses: readonly Miss[]): string {
  const r = grade.checks.find((x) => x.id === id);
  if (r === undefined) return `${id}, which the grade does not hold`;
  const points = pointsOf(grade, id);
  if (r.met === 'unknown') return `${id} (${points}), which graded unknown${misses.some((m) => m.check === id) ? ' (judge cache miss)' : ''}`;
  return r.points! < 0 ? `${id} (${points}, a penalty), which did not apply` : `${id} (${points}), which it keeps`;
}

// Each problem with what the task's alternatives and mutants declare they lose, which runMatrix
// checks before any case runs: a mutant without `loses`, a list that is not one, an id that is no
// rubric item of the task, a 0-point item (it can never be lost), an id named twice.
export function lossDeclarations(task: Pick<MatrixTask, 'checks' | 'alternatives' | 'mutants'>): string[] {
  const points = new Map(task.checks.flatMap((c) => (c.kind === 'rubric' ? [[c.id, c.points] as const] : [])));
  const declared = [
    ...task.alternatives.map((a) => ({ who: `alternative ${a.id}`, loses: (a.loses ?? []) as unknown, required: false })),
    ...task.mutants.map((m) => ({ who: `mutant ${m.id}`, loses: m.loses as unknown, required: true })),
  ];
  return declared.flatMap(({ who, loses, required }) => {
    if (loses === undefined && required) return [`${who} declares no loses (the rubric items it loses; [] for none)`];
    if (!Array.isArray(loses) || !loses.every((id) => typeof id === 'string')) return [`${who}: loses must be a list of rubric item ids`];
    const ids = loses as string[];
    return [...new Set(ids)].flatMap((id) => [
      ...(ids.indexOf(id) !== ids.lastIndexOf(id) ? [`${who} declares loses ${id} more than once`] : []),
      ...(!points.has(id) ? [`${who} declares loses ${id}, which is not a rubric item of the task`] : []),
      ...(points.get(id) === 0 ? [`${who} declares loses ${id}, a 0-point rubric item, which cannot be lost`] : []),
    ]);
  });
}

// The cases `ids` names, in report order; every case when absent.
export function selectCases(task: MatrixTask, ids?: readonly string[]): Case[] {
  const all = cases(task);
  if (ids === undefined) return all;
  for (const id of ids) if (!all.some((c) => c.id === id)) throw new Error(`no case ${id} in task ${task.id} (cases: ${all.map((c) => c.id).join(', ')})`);
  return all.filter((c) => ids.includes(c.id));
}

// Runs the cases offline: each trial (twice for replay), then its grades from the canned cache,
// in the isolation check's interleaved order when there is one, else `regrades` in a row.
export async function runCases(env: MatrixEnv, task: MatrixTask, selected: readonly Case[], opts: MatrixOptions = {}): Promise<CaseResult[]> {
  const trials = opts.trials ?? 2;
  const runs = new Map<Case, CaseRun>();
  const replays = new Map<Case, boolean | null>();
  for (const c of selected) {
    const first = await trial(env, task, c);
    runs.set(c, first);
    if (trials < 2) {
      replays.set(c, null);
      continue;
    }
    const again = await trial(env, task, c);
    const diff = replayDiff(first, again);
    replays.set(c, diff === null);
    if (diff !== null) opts.onReplayMismatch?.(c, first, again, diff);
  }

  const fresh = opts.isolation !== false ? opts.fresh : undefined;
  // The order the process grades in, each with the case graded just before it.
  let order: Case[];
  if (fresh) {
    const oracle = selected.filter((c) => c.kind === 'oracle');
    const forward = [...oracle, ...selected.filter((c) => c.kind !== 'oracle'), ...(selected.length > 1 ? oracle : [])];
    order = [...forward, ...[...forward].reverse()];
  } else {
    order = selected.flatMap((c) => Array.from({ length: Math.max(1, opts.regrades ?? 2) }, () => c));
  }
  const grades = new Map<Case, Array<{ grade: Grade; misses: Miss[]; after: Case | null }>>();
  for (const [i, c] of order.entries()) {
    const misses: Miss[] = [];
    const grade = await gradeRun(env, task, task.checks, runs.get(c)!, misses);
    grades.set(c, [...(grades.get(c) ?? []), { grade, misses, after: order[i - 1] ?? null }]);
  }
  const freshGrades = new Map<Case, Grade>();
  if (fresh) await Promise.all(selected.map(async (c) => freshGrades.set(c, await fresh(c, runs.get(c)!))));

  return selected.map((c) => {
    const run = runs.get(c)!;
    const graded = grades.get(c)!;
    const { grade, misses } = graded[0]!;
    const v = verdict(c, run, grade, misses);
    const regrade_same = graded.length > 1 ? graded.every((g) => asJson(g.grade) === asJson(grade)) : null;
    const replay_same = replays.get(c)!;
    let isolation: CaseResult['isolation'] = null;
    if (fresh) {
      const want = freshGrades.get(c)!;
      const equal = graded.filter((g) => asJson(g.grade) === asJson(want)).length;
      isolation = { equal, of: graded.length };
      graded.forEach((g, k) => {
        if (asJson(g.grade) !== asJson(want)) v.problems.push(`cross-trial grader state: in-process grade ${k + 1} of ${graded.length} (after ${g.after ? nameOf(g.after) : 'nothing'}) differs from a fresh process in ${differing(g.grade, want)}`);
      });
    }
    if (regrade_same === false) v.problems.push('a second grade from the same record differs');
    if (replay_same === false) v.problems.push('a second run gives a different trajectory or final hash');
    return { case: c, grade, misses, regrade_same, replay_same, isolation, ...v };
  });
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
const lostLine = (r: CaseResult) => `lost [${r.lost_items.join(', ')}] ${r.case.loses === undefined ? '(no loses)' : `declared [${r.case.loses.join(', ')}]`}`;

// Runs the matrix and reports it, one line per fact, the failures last.
export async function runMatrix(env: MatrixEnv, task: MatrixTask, opts: MatrixOptions = {}): Promise<MatrixResult> {
  const all = cases(task);
  const selected = selectCases(task, opts.cases);
  const declared = task.mutants.filter((m) => Array.isArray(m.loses)).length;
  const losses = `rubric losses: ${declared}/${task.mutants.length} mutants declare loses`;
  const declarations = lossDeclarations(task);
  if (declarations.length > 0) {
    const lines = [`matrix ${task.id}`, losses, 'cases: not run (fix the loses declarations first)', `matrix ${task.id}: FAIL`, ...declarations.map((d) => `  - ${d}`)];
    return { pass: false, lines, results: [] };
  }
  const results = await runCases(env, task, selected, opts);
  const failures: string[] = [];
  const lines: string[] = [`matrix ${task.id}`];
  const fail = (what: string) => failures.push(what);
  const byKind = (k: CaseKind) => results.filter((r) => r.case.kind === k);
  const noteProblems = (r: CaseResult) => r.problems.forEach((p) => fail(`${nameOf(r.case)}: ${p}`));

  const oracle = byKind('oracle')[0];
  if (task.oracle === null) {
    lines.push('oracle: missing (solution/solve.ts exports no oracle)');
    fail('no oracle');
  } else if (oracle === undefined) {
    lines.push('oracle: not run');
  } else {
    const missed = [...new Set(oracle.misses.map((m) => m.check))];
    lines.push(missed.length ? `oracle: MISS judge cache misses ${missed.join(', ')}` : `oracle: ${oracle.grade.outcome} score ${score(oracle.grade)} judge.unknown ${oracle.unknown}`);
    noteProblems(oracle);
  }

  const alternatives = byKind('alternative');
  lines.push(`alternatives: n=${task.alternatives.length} (min ${MIN_ALTERNATIVES})${alternatives.length < task.alternatives.length ? `, ${alternatives.length} run` : ''}`);
  if (task.alternatives.length < MIN_ALTERNATIVES) fail(`${task.alternatives.length} alternatives, need ${MIN_ALTERNATIVES}`);
  for (const r of alternatives) {
    lines.push(`  alternative ${r.case.id}: ${r.grade.outcome} score ${score(r.grade)} judge.unknown ${r.unknown}, ${lostLine(r)}${r.problems.length ? ` (${r.problems.join('; ')})` : ''}`);
    noteProblems(r);
  }

  const mutants = byKind('mutant');
  lines.push(`mutants: n=${task.mutants.length} (min ${MIN_MUTANTS})${mutants.length < task.mutants.length ? `, ${mutants.length} run` : ''}`);
  if (task.mutants.length < MIN_MUTANTS) fail(`${task.mutants.length} mutants, need ${MIN_MUTANTS}`);
  for (const r of mutants) {
    const m = r.case.mutant!;
    const verdict = r.grade.outcome !== 'FAIL' ? 'not FAIL' : sameSet(r.failed_gates, m.fails) && r.case.loses !== undefined && sameSet(r.lost_items, r.case.loses) ? 'ok' : 'MISMATCH';
    lines.push(`  mutant ${m.id} [trap ${m.trap}]: ${r.grade.outcome} failed [${r.failed_gates.join(', ')}] declared [${m.fails.join(', ')}], ${lostLine(r)} ${verdict}`);
    noteProblems(r);
  }

  for (const kind of ['null', 'spray', 'output-gap', 'status-only'] as const) {
    const r = byKind(kind)[0];
    if (r === undefined) {
      if (all.some((c) => c.kind === kind)) lines.push(`${kind}: not run`);
      else if (kind === 'status-only') {
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
  const counted = (pick: (r: CaseResult) => boolean | null) => results.filter((r) => pick(r) === true).length;
  lines.push(results.some((r) => r.regrade_same !== null) ? `regrade idempotence: ${counted((r) => r.regrade_same)}/${n} same grade` : 'regrade idempotence: not run (1 grade per case)');
  lines.push(results.some((r) => r.replay_same !== null) ? `replay determinism: ${counted((r) => r.replay_same)}/${n} same trajectory and final hash` : 'replay determinism: not run (1 trial per case)');
  const iso = results.flatMap((r) => (r.isolation ? [r.isolation] : []));
  lines.push(iso.length ? `isolation: ${iso.reduce((s, x) => s + x.equal, 0)}/${iso.reduce((s, x) => s + x.of, 0)} grades equal a fresh process` : 'isolation: not run');

  const untraced = traceability(task);
  lines.push(`traceability: ${task.checks.length - untraced.length}/${task.checks.length} checks resolve${untraced.length ? ` (unresolved: ${untraced.map((u) => u.check).join(', ')})` : ''}`);
  for (const u of untraced) fail(`traceability: ${u.check}: ${u.reason}`);

  if (opts.policyImports) {
    const p = opts.policyImports();
    lines.push(p.problems.length ? `policy imports: ${p.problems.length} problem${p.problems.length === 1 ? '' : 's'}` : `policy imports: clean (${p.modules} modules reached)`);
    for (const x of p.problems) fail(`policy imports: ${x}`);
  } else lines.push('policy imports: not checked');

  const covered = new Set(task.mutants.map((m) => m.trap));
  const uncovered = task.declares.traps.filter((t) => !covered.has(t));
  lines.push(`traps: ${task.declares.traps.length - uncovered.length}/${task.declares.traps.length} declared traps have a mutant`);
  for (const t of uncovered) fail(`trap ${t} has no mutant`);
  for (const m of task.mutants) if (!task.declares.traps.includes(m.trap)) fail(`mutant ${m.id} names trap ${m.trap}, which task.toml [matrix] traps does not declare`);

  lines.push(losses);

  const misses = results.flatMap((r) => r.misses.map((m) => ({ ...m, case: nameOf(r.case) })));
  const sources = new Map<string, number>();
  for (const e of task.cache) sources.set(e.provenance?.source ?? 'unrecorded', (sources.get(e.provenance?.source ?? 'unrecorded') ?? 0) + 1);
  const source = [...sources].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k} ${v}`).join(', ') || 'empty';
  lines.push(`judge cache: ${misses.length} miss${misses.length === 1 ? '' : 'es'}; source ${source}`);
  for (const m of misses) lines.push(`  miss ${m.case}: ${m.check} (cache key ${m.key})`);

  lines.push(`matrix ${task.id}: ${failures.length === 0 ? 'PASS' : 'FAIL'}`);
  for (const f of failures) lines.push(`  - ${f}`);
  return { pass: failures.length === 0, lines, results };
}
