// pnpm cli oracle --task <id|all> [--json] [--live-judge] [--dry-run]
// Runs each task's oracle (solution/solve.ts) as a scripted model through run() and grades it.
//   offline (default)  judge items answer only from tasks/<id>/tests/judge-cache.json; a miss
//                      fails the task and names the item. No client, no ledger, no call.
//   --live-judge       the one live path of the matrix: every matrix case of the task (oracle,
//                      alternatives, mutants, agents) is graded with the judge asked live, and
//                      the answers replace tests/judge-cache.json, the canned outputs the matrix
//                      and CI grade from. The judge client is a MessagesClient whose grant comes
//                      from batchStart(projection) on the Node ledger, so the ledger's caps hold
//                      before any call: batchStart refuses when its exposure plus the projection
//                      would cross $450. Projection = cases x the task's judge allowance (two
//                      bounded calls per judge or hybrid item, packages/grader/judge.ts).
//   --dry-run          prints that projection (LIVE_PROJECTION_USD) and makes no call and opens
//                      nothing
//   --json             {tasks: [{id, outcome, score, judge_unknown, misses}]} only (scripts/donewhen.ts)
// `all` is every task (with _-prefixed ones only in test mode). Exit 0 when every oracle is PASS
// with score 1.0, no judge item unknown and no cache miss; 1 otherwise; 2 on a usage error.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MessagesClient, type Transport } from '../packages/core/anthropic.ts';
import { money } from '../packages/core/cost.ts';
import { installEgressGuard } from '../packages/core/egress.ts';
import { redactText } from '../packages/core/redact.ts';
import type { JudgeCacheEntry } from '../packages/grader/judge.ts';
import { judgeAllowanceUsd } from '../packages/grader/judge.ts';
import { cases, runCase, trial } from '../packages/grader/matrix/matrix.ts';
import type { MatrixTask } from '../packages/grader/matrix/types.ts';
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

// The live judge pass's worst case: every case asks every judge and hybrid item twice.
export const projection = (task: MatrixTask): number => cases(task).length * judgeAllowanceUsd(task.checks);

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

  if (flags.has('--dry-run')) {
    const p = live ? tasks.reduce((s, t) => s + projection(t), 0) : 0;
    for (const t of tasks) deps.out(live ? `oracle dry run: --live-judge on ${t.id}: ${cases(t).length} cases x judge allowance ${money(judgeAllowanceUsd(t.checks))}` : `oracle dry run: ${t.id} offline, no live call`);
    deps.out(`projection ${money(p)}`);
    deps.out(`LIVE_PROJECTION_USD=${p.toFixed(6)}`);
    return 0;
  }

  const env = matrixEnv();
  const rows: Row[] = [];
  const problems: string[] = [];
  if (live) {
    const key = deps.env.ANTHROPIC_API_KEY ?? '';
    if (key === '') {
      deps.out('oracle: ANTHROPIC_API_KEY is not set');
      return 1;
    }
    try {
      const { ledger, mode, path } = openNodeLedger({ transport: 'live', env: deps.env });
      deps.out(`ledger ${mode} ${path}`);
      const grant = await ledger.batchStart(tasks.reduce((s, t) => s + projection(t), 0));
      try {
        for (const task of tasks) {
          const entries = new Map<string, JudgeCacheEntry>();
          for (const c of cases(task)) {
            const client = new MessagesClient({ grant, ledger, apiKey: key, fetch: deps.fetch, trial: `oracle-judge:${task.id}:${c.kind}-${c.id}`, log: (l) => deps.out(l) });
            const { record } = await trial(env, task, c, client);
            if (record.error !== null) {
              deps.out(`oracle: ${task.id} ${c.kind} ${c.id}: ${record.outcome} in ${record.error.check ?? 'trial'}: ${redactText(record.error.message, [key])}; no cache written`);
              return 1;
            }
            for (const e of record.judge.cache) entries.set(e.key, e);
            if (c.kind === 'oracle') rows.push({ id: task.id, outcome: record.outcome, score: record.score, judge_unknown: record.judge.unknown, misses: [] });
          }
          const sorted = [...entries.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
          (deps.writeCache ?? writeCacheFile)(task.id, sorted);
          deps.out(`judge cache ${task.id}: ${sorted.length} answers written`);
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
      const r = await runCase(env, task, cases(task)[0]!);
      rows.push({ id: task.id, outcome: r.grade.outcome, score: r.grade.score, judge_unknown: r.unknown, misses: r.misses.map((m) => `${m.check} ${m.key}`) });
      for (const p of r.problems) problems.push(`${task.id}: ${p}`);
    }
  }

  const ok = (r: Row) => r.outcome === 'PASS' && r.score === 1 && r.judge_unknown === 0 && r.misses.length === 0;
  if (json) deps.out(JSON.stringify({ tasks: rows }));
  else {
    for (const r of rows) deps.out(`oracle ${r.id}: ${r.outcome ?? 'none'} score ${r.score === null ? 'n/a' : r.score.toFixed(3)} judge.unknown ${r.judge_unknown}${r.misses.length ? ` judge cache misses ${r.misses.join(', ')}` : ''}`);
    for (const p of problems) deps.out(`  - ${p}`);
  }
  return rows.every(ok) && problems.length === 0 ? 0 : 1;
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
