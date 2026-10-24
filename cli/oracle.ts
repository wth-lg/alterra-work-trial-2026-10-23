// pnpm cli oracle --task <id|all> [--json] [--live-judge] [--dry-run]
// Runs each task's oracle (solution/solve.ts) as a scripted model through run() and grades it.
//   offline (default)  judge items answer only from tasks/<id>/tests/judge-cache.json; a miss
//                      fails the task and names the item. No client, no ledger, no call.
//   --live-judge       the one live path of the matrix: every matrix case of the task (oracle,
//                      alternatives, mutants, agents) is run once and graded with the judge asked
//                      live through one Judge, so each distinct question is asked once. The
//                      answers replace tests/judge-cache.json, the canned outputs the matrix and
//                      CI grade from, each with provenance {source: 'live', model, at}, and only
//                      when every case graded and the oracle passed (PASS, score 1.0, no judge
//                      item unknown) on them; otherwise nothing is written. The judge client is
//                      a MessagesClient whose grant comes from batchStart(projection) on the Node
//                      ledger, so the ledger's caps hold before any call: batchStart refuses when
//                      its exposure plus the projection would cross PROJECTED_CAP_USD.
//                      Projection: before any call, the cases are graded once with a recording
//                      client that sends nothing, which yields every distinct judge request at
//                      the task's judge effort; each is priced at its worst case from its real
//                      body and max_tokens, times two (the schema retry).
//   --dry-run          prints that projection (LIVE_PROJECTION_USD) and makes no call and opens
//                      nothing
//   --json             {tasks: [{id, outcome, score, judge_unknown, misses}]} only (scripts/donewhen.ts)
// `all` is every task (with _-prefixed ones only in test mode). Exit 0 when every oracle is PASS
// with score 1.0, no judge item unknown and no cache miss; 1 otherwise, or when no task was
// graded; 2 on a usage error.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MessagesClient, MODEL, reserveRequest, type CallResult, type Transport } from '../packages/core/anthropic.ts';
import { money, worstCaseUsd } from '../packages/core/cost.ts';
import { installEgressGuard } from '../packages/core/egress.ts';
import { redactText } from '../packages/core/redact.ts';
import type { Grade } from '../packages/grader/grade.ts';
import { Judge, JUDGE_CALLS_PER_ITEM, type JudgeCacheEntry, type JudgeClient } from '../packages/grader/judge.ts';
import { cases, gradeRunWith, runCases, selectCases, trial, type Case, type CaseRun, type MatrixEnv } from '../packages/grader/matrix/matrix.ts';
import type { MatrixTask } from '../packages/grader/matrix/types.ts';
import { nodeNow } from './adapters/clock-node.ts';
import { openNodeLedger } from './adapters/ledger-node.ts';
import { isTestMode, nodeTaskSource, TASKS_DIR } from './adapters/tasks-node.ts';
import { loadMatrixTask, matrixEnv, TASK_ID } from './matrix.ts';

const USAGE = 'usage: pnpm cli oracle --task <id|all> [--json] [--live-judge] [--dry-run]';
const FLAGS = new Set(['--json', '--live-judge', '--dry-run']);

export interface Deps {
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  // The live transport of --live-judge.
  fetch: Transport;
  // A task's matrix inputs; default loadMatrixTask.
  load?: (task: string) => Promise<MatrixTask>;
  // Where --live-judge puts the answers; default tasks/<id>/tests/judge-cache.json.
  writeCache?: (task: string, entries: JudgeCacheEntry[]) => void;
}

interface Row {
  id: string;
  outcome: string | null;
  score: number | null;
  judge_unknown: number;
  misses: string[];
}

const writeCacheFile = (task: string, entries: JudgeCacheEntry[]) => writeFileSync(join(TASKS_DIR, task, 'tests/judge-cache.json'), `${JSON.stringify(entries, null, 2)}\n`);

// A judge client that sends nothing: it records each request's worst case and answers
// "unknown", which is a valid judge and extractor answer, so no question is retried.
function recordingClient(worst: number[]): JudgeClient {
  return {
    async send(history, params): Promise<CallResult> {
      worst.push(worstCaseUsd(reserveRequest(history, params)));
      const content = [{ type: 'text', text: JSON.stringify({ verdict: 'unknown', value: null, quote: '' }) }];
      return { status: 200, message: { id: `msg_plan_${worst.length}`, model: MODEL, role: 'assistant', content, stop_reason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 } }, refusal: null, attempts: 1 };
    },
  };
}

interface Plan {
  task: MatrixTask;
  runs: Array<{ case: Case; run: CaseRun }>;
  // The distinct judge requests' worst cases, one call each.
  worst: number[];
  usd: number;
}

// Runs every case once and finds the task's distinct judge requests, sending nothing.
async function plan(env: MatrixEnv, task: MatrixTask): Promise<Plan> {
  const runs: Plan['runs'] = [];
  for (const c of cases(task)) runs.push({ case: c, run: await trial(env, task, c) });
  const worst: number[] = [];
  const judge = new Judge({ client: recordingClient(worst), effort: task.judgeEffort });
  for (const { run } of runs) await gradeRunWith(env, task, run, judge);
  return { task, runs, worst, usd: JUDGE_CALLS_PER_ITEM * worst.reduce((s, x) => s + x, 0) };
}

const unknownOf = (g: Grade) => g.checks.filter((r) => r.method !== 'code' && r.met === 'unknown').length;

export async function main(args: string[], deps: Deps): Promise<number> {
  const flags = new Set<string>();
  let id: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (FLAGS.has(a)) flags.add(a);
    else if (a === '--task' && args[i + 1] !== undefined) id = args[++i];
    else return usage(deps, a === '--task' ? '--task needs a value' : `unknown argument ${a}`);
  }
  if (id === undefined) return usage(deps, '--task is required');
  if (id !== 'all' && !TASK_ID.test(id)) return usage(deps, `--task ${JSON.stringify(id)} is not a task id (letters, digits, _ and - only)`);
  const live = flags.has('--live-judge');
  const json = flags.has('--json');
  let tasks: MatrixTask[];
  try {
    const ids = id === 'all' ? (await nodeTaskSource({ testMode: isTestMode(deps.env) }).all()).map((t) => t.id) : [id];
    tasks = await Promise.all(ids.map((t) => (deps.load ?? loadMatrixTask)(t)));
  } catch (e) {
    return usage(deps, `--task: ${(e as Error).message}`);
  }
  if (tasks.length === 0) {
    deps.out(`oracle: no tasks graded (--task ${id} names none${id === 'all' ? '; _-prefixed tasks count only in test mode' : ''})`);
    return 1;
  }

  const env = matrixEnv();
  if (flags.has('--dry-run')) {
    let p = 0;
    for (const t of tasks) {
      if (!live) {
        deps.out(`oracle dry run: ${t.id} offline, no live call`);
        continue;
      }
      const { worst, usd, runs } = await plan(env, t);
      p += usd;
      deps.out(`oracle dry run: --live-judge on ${t.id}: ${runs.length} cases, ${worst.length} distinct judge questions x ${JUDGE_CALLS_PER_ITEM} calls, worst case ${money(usd)}`);
    }
    deps.out(`projection ${money(p)}`);
    deps.out(`LIVE_PROJECTION_USD=${p.toFixed(6)}`);
    return 0;
  }

  const rows: Row[] = [];
  const problems: string[] = [];
  if (live) {
    const key = deps.env.ANTHROPIC_API_KEY ?? '';
    if (key === '') {
      deps.out('oracle: ANTHROPIC_API_KEY is not set');
      return 1;
    }
    try {
      const plans: Plan[] = [];
      for (const t of tasks) plans.push(await plan(env, t));
      const { ledger, mode, path } = openNodeLedger({ transport: 'live', env: deps.env });
      deps.out(`ledger ${mode} ${path}`);
      const grant = await ledger.batchStart(plans.reduce((s, x) => s + x.usd, 0));
      try {
        for (const { task, runs, worst } of plans) {
          const client = new MessagesClient({ grant, ledger, apiKey: key, fetch: deps.fetch, trial: `oracle-judge:${task.id}`, log: (l) => deps.out(l) });
          const judge = new Judge({ client, maxCalls: JUDGE_CALLS_PER_ITEM * worst.length, effort: task.judgeEffort });
          let oracle: Grade | null = null;
          let failed = false;
          for (const { case: c, run } of runs) {
            const g = await gradeRunWith(env, task, run, judge);
            if (g.error !== null) {
              deps.out(`oracle: ${task.id} ${c.kind} ${c.id}: ${g.outcome} in ${g.error.check ?? 'trial'}: ${redactText(g.error.message, [key])}; no cache written`);
              return 1;
            }
            if (c.kind === 'oracle') oracle = g;
          }
          if (oracle !== null) rows.push({ id: task.id, outcome: oracle.outcome, score: oracle.score, judge_unknown: unknownOf(oracle), misses: [] });
          else problems.push(`${task.id}: no oracle (solution/solve.ts)`);
          if (oracle === null || oracle.outcome !== 'PASS' || oracle.score !== 1 || unknownOf(oracle) > 0) {
            problems.push(`${task.id}: the oracle does not pass on the live judge's answers; no cache written`);
            failed = true;
          }
          if (failed) continue;
          const at = new Date(nodeNow()).toISOString();
          const entries = judge.entries().map((e) => ({ ...e, provenance: { source: 'live' as const, model: e.model, at } })).sort((a, b) => (a.key < b.key ? -1 : 1));
          (deps.writeCache ?? writeCacheFile)(task.id, entries);
          deps.out(`judge cache ${task.id}: ${entries.length} answers written, ${judge.calls} calls`);
        }
      } finally {
        await grant.close();
      }
    } catch (e) {
      deps.out(`oracle: ${redactText((e as Error).message, [key])}`);
      return 1;
    }
  } else {
    for (const task of tasks) {
      if (task.oracle === null) {
        rows.push({ id: task.id, outcome: null, score: null, judge_unknown: 0, misses: [] });
        problems.push(`${task.id}: no oracle (solution/solve.ts)`);
        continue;
      }
      // One run, one grade: replay and regrade are the matrix's checks, not this command's.
      const [r] = await runCases(env, task, selectCases(task, ['oracle']), { trials: 1, regrades: 1 });
      rows.push({ id: task.id, outcome: r!.grade.outcome, score: r!.grade.score, judge_unknown: r!.unknown, misses: r!.misses.map((m) => `${m.check} ${m.key}`) });
      for (const p of r!.problems) problems.push(`${task.id}: ${p}`);
    }
  }

  const ok = (r: Row) => r.outcome === 'PASS' && r.score === 1 && r.judge_unknown === 0 && r.misses.length === 0;
  if (json) deps.out(JSON.stringify({ tasks: rows }));
  else {
    for (const r of rows) deps.out(`oracle ${r.id}: ${r.outcome ?? 'none'} score ${r.score === null ? 'n/a' : r.score.toFixed(3)} judge.unknown ${r.judge_unknown}${r.misses.length ? ` judge cache misses ${r.misses.join(', ')}` : ''}`);
    for (const p of problems) deps.out(`  - ${p}`);
  }
  return rows.length > 0 && rows.every(ok) && problems.length === 0 ? 0 : 1;
}

function usage(deps: Deps, problem: string): number {
  deps.out(`oracle: ${problem}\n${USAGE}`);
  return 2;
}

const defaults: Deps = { env: process.env, out: (l) => process.stdout.write(`${l}\n`), fetch: (request) => fetch(request) };

export default (args: string[]) => {
  installEgressGuard(globalThis);
  return main(args, defaults);
};

// Run as a script, it installs the egress guard first (pnpm cli oracle gets it from cli/index.ts
// too); imported by tests, it leaves the importer's globals alone.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  installEgressGuard(globalThis);
  process.exitCode = await main(process.argv.slice(2), defaults);
}
