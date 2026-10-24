// pnpm cli summary <run> [--require <spec>] [--task all|<id,...>] [--allow-mock] [--json]
// Summarizes a run (packages/core/summary.ts): per task pass k/n over its valid trials with a
// Wilson 95% interval, ENV_ERROR counted raw over settled and re-queued attempts, the models seen,
// the initial state hashes and replay.json's verdicts. Writes <run>/summary.json, validated
// against the schema before it is written. --require checks the run:
//   valid=N          every task has exactly N valid trials (donewhen: trials=N)
//   band=a-b         every task passes a to b of them (donewhen: pass-min=a,pass-max=b)
//   env_error_raw=N  at most N ENV_ERROR attempts in the run, re-queued ones included
//   model=M          every record requested M and every response came from M
//   replay=all       replay.json exists and every trial reproduced; every record's replay_final
//                    equals its final hash
//   grader_error=N   at most N records whose current grade (the last regrade, else the recorded
//                    outcome) is GRADER_ERROR. GRADER_ERROR is settled, never re-queued as a
//                    model trial; the records that were GRADER_ERROR in an earlier grade are
//                    printed as history, never required
//   mode=M           the manifest's mode is M (mode=live)
// With any requirement, every task the run must hold has records: those of --task (all, or a
// comma list), else the manifest's task_versions; and a run that is not live is a violation
// unless --allow-mock is given. --json prints only the summary on stdout (the lines go to stderr). Exit 0 when every
// requirement holds; 1 on a violation or a missing run; 2 on a usage error.
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BatchRecord } from '../packages/core/batch.ts';
import { installEgressGuard } from '../packages/core/egress.ts';
import { assertSummary, checkRequirements, parseRequire, summarize, type Requirements, type SummaryTrial } from '../packages/core/summary.ts';
import type { TaskSource } from '../packages/core/tasks.ts';
import { readManifest, requeuedRecords, settledRecords, writeJson } from './adapters/result-sink-node.ts';
import { nodeTaskSource } from './adapters/tasks-node.ts';

export interface Deps {
  out: (line: string) => void;
  err: (line: string) => void;
  // Resolves --task all; default this checkout's tasks.
  tasks?: TaskSource;
}

const defaults: Deps = { out: (l) => process.stdout.write(`${l}\n`), err: (l) => process.stderr.write(`${l}\n`) };
const USAGE = 'usage: pnpm cli summary <run> [--require valid=N,band=a-b,env_error_raw=N,grader_error=N,model=M,replay=all,mode=live] [--task all|<id,...>] [--allow-mock] [--json]';

// A record as cli regrade leaves it: its regrades[] entries appended.
const toTrial = (r: BatchRecord & { regrades?: Array<{ outcome: string }> }): SummaryTrial => ({
  task_id: r.task_id, task_version: r.task_version ?? null, index: r.index, outcome: r.outcome, model_requested: r.model_requested,
  models_returned: r.models_returned ?? [], state_hash: r.state_hash, tool_errors: r.tool_errors ?? {}, cost_usd: r.cost_usd ?? 0,
  judge_cost_usd: r.judge_cost_usd ?? 0, score: r.score ?? null,
  ...(r.regrades ? { regrades: r.regrades } : {}),
});

// replay.json as trial -> reproduced; null when replay has not run.
export function readReplay(dir: string): Record<string, boolean> | null {
  const file = join(dir, 'replay.json');
  if (!existsSync(file)) return null;
  const trials = (JSON.parse(readFileSync(file, 'utf8')) as { trials?: Record<string, { match?: unknown }> }).trials ?? {};
  return Object.fromEntries(Object.entries(trials).map(([k, v]) => [k, v.match === true]));
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export async function main(args: string[], deps: Deps = defaults): Promise<number> {
  let dir: string | undefined;
  let spec = '';
  let json = false;
  let allowMock = false;
  let taskArg: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === '--json') json = true;
    else if (a === '--allow-mock') allowMock = true;
    else if (a === '--require' && args[i + 1] !== undefined) spec = args[++i] as string;
    else if (a === '--task' && args[i + 1] !== undefined) taskArg = args[++i] as string;
    else if (!a.startsWith('--') && dir === undefined) dir = a;
    else {
      deps.err(`summary: unexpected argument ${a}\n${USAGE}`);
      return 2;
    }
  }
  if (dir === undefined) {
    deps.err(`summary: a run directory is required\n${USAGE}`);
    return 2;
  }
  let req: Requirements;
  try {
    req = parseRequire(spec);
  } catch (e) {
    deps.err(`summary: ${(e as Error).message}\n${USAGE}`);
    return 2;
  }
  if (!existsSync(join(dir, 'trials'))) {
    deps.err(`summary: ${dir} has no trials/ directory`);
    return 1;
  }
  if (allowMock) req.allow_mock = true;
  const manifest = readManifest(dir);
  let expected: { tasks: string[]; from: string } | undefined;
  if (taskArg !== undefined) {
    try {
      const tasks = taskArg === 'all' ? (await (deps.tasks ?? nodeTaskSource({ testMode: false })).all()).map((t) => t.id) : taskArg.split(',').map((t) => t.trim()).filter((t) => t !== '');
      expected = { tasks, from: '--task' };
    } catch (e) {
      deps.err(`summary: --task: ${(e as Error).message}`);
      return 1;
    }
  } else if (manifest?.task_versions) expected = { tasks: Object.keys(manifest.task_versions), from: 'the run manifest' };
  const s = summarize({
    run_id: manifest?.run_id ?? basename(dir),
    trials: settledRecords(dir).map((x) => toTrial(x.record)),
    requeued: requeuedRecords(dir).map((x) => toTrial(x.record)),
    replay: readReplay(dir),
    mode: manifest?.mode ?? null,
    ...(expected ? { expected } : {}),
  });
  s.requirements = req;
  s.violations = checkRequirements(s, req);
  assertSummary(s);
  writeJson(join(dir, 'summary.json'), s);

  const say = json ? deps.err : deps.out;
  const width = Math.max(...Object.keys(s.tasks).map((id) => id.length), 4);
  for (const [id, t] of Object.entries(s.tasks)) {
    const w = t.wilson95 === null ? 'n/a' : `${pct(t.wilson95.lo)}-${pct(t.wilson95.hi)}`;
    say(`${id.padEnd(width)}  ${t.passes}/${t.trials}  Wilson 95% ${w}  ENV_ERROR raw ${t.env_error_raw}  re-queued ${t.requeued}`);
  }
  say(`GRADER_ERROR ${s.totals.grader_error} at the current grade; history ${s.totals.grader_error_history} (GRADER_ERROR in an earlier grade, disclosed only). A GRADER_ERROR is never re-queued as a model trial: regrade grades it again`);
  for (const v of s.violations) say(`violation: ${v}`);
  say(`summary: ${s.violations.length === 0 ? 'every requirement holds' : `${s.violations.length} violation(s)`}; wrote ${join(dir, 'summary.json')}`);
  if (json) deps.out(JSON.stringify(s));
  return s.violations.length === 0 ? 0 : 1;
}

export default (args: string[]) => {
  installEgressGuard(globalThis);
  return main(args);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  installEgressGuard(globalThis);
  process.exitCode = await main(process.argv.slice(2));
}
