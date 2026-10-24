// pnpm cli run-one --task <id> --model claude-opus-5-5 [--effort high] [--index 0] [--out <dir>]
//                  [--mock <scenario>] [--dry-run]
// One trial through packages/core/run.ts in Node, metered through the spend ledger.
//   --task      a task id, resolved through the TaskSource before anything is written; an
//               explicit _-prefixed id (_toy) resolves too
//   --effort    low | medium | high | xhigh | max; default high
//   --index     the trial's index in its key (task, model, effort, mode, index); default 0
//   --out       the run directory: trials/<key>.json and trajectories/<key>.jsonl, where <key> is
//               <task>/<model>/<effort>/<mode>/<index> and mode is live or mock-<scenario>
//               (default $CHARTR_RUNS_DIR, else ~/.chartr/runs/run-one)
//   --mock      answers from a scripted scenario (apps/web/src/harness/scenarios.ts) instead of
//               the API. It needs no key and still meters through the ledger, at the mocked usage,
//               with trial labels starting mock:, so the cap checks run as they do live. Its
//               records have their own mode in the key, so a live run never reads one
//   --dry-run   prints the projection batchStart is given, and makes no call and opens nothing
// The trial is graded with the task's checks, tasks/<id>/tests/grader.ts (none when the task
// has no grader), and its judge items go through the trial's client and ledger.
// The projection is the per-trial cap ($6) plus the judge allowance for the task's judge and
// hybrid items: the loop stops a trial once its cost reaches the cap, one trial makes no reruns,
// and each judge item makes at most two bounded calls. batchStart refuses it, before any call,
// when the ledger's exposure plus the projection would cross $450. Each event is appended to the
// trajectory as it arrives, so a crash leaves a valid prefix, and the last line is the graded
// record; the record (outcome, gate checks, rubric scores included) is written at the end. A
// check that throws or a judge call that fails does not make run() throw: the trial is graded
// GRADER_ERROR or INFRA_API with its real cost and turns. If run() throws (the task cannot be
// resolved again, before any spend), the record says ENV_ERROR INTERNAL: never a valid trial,
// never the model's failure. That record is written only while the ledger shows no call for the
// trial: after a call, run-one writes no record and says so, so no record claims $0 for spend.
// A trial key whose record exists is not run again (live mode checks for the key first). Exit 0
// when the trial completed, was graded validly and replay_final equals final; 1 otherwise; 2 on
// a usage error, an unknown task included.
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MODEL, MessagesClient, type Transport } from '../packages/core/anthropic.ts';
import { money, PER_TRIAL_CAP_USD } from '../packages/core/cost.ts';
import { installEgressGuard } from '../packages/core/egress.ts';
import { redactText } from '../packages/core/redact.ts';
import { DEFAULT_EFFORT, EFFORTS, internalErrorRecord, run, type Effort, type TrialRecord } from '../packages/core/run.ts';
import type { TaskSource } from '../packages/core/tasks.ts';
import { toJsonLine } from '../packages/core/trajectory.ts';
import type { Check } from '../packages/grader/check.ts';
import { judgeAllowanceUsd } from '../packages/grader/judge.ts';
import { isScenario, scenarioTransport, type ScenarioName } from '../apps/web/src/harness/scenarios.ts';
import { nodeNow } from './adapters/clock-node.ts';
import { openNodeLedger, readRows } from './adapters/ledger-node.ts';
import { nodeTaskSource } from './adapters/tasks-node.ts';

const REPO = fileURLToPath(new URL('../', import.meta.url));
// A task id is a directory name: no path separators, no '..'.
const TASK_ID = /^[A-Za-z0-9_-]+$/;
const WITH_VALUE = new Set(['--task', '--model', '--effort', '--index', '--out', '--mock']);
const USAGE = 'usage: pnpm cli run-one --task <id> --model claude-opus-5-5 [--effort high] [--index 0] [--out <dir>] [--mock <scenario>] [--dry-run]';

export interface Deps {
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  // The live transport.
  fetch: Transport;
  // The transport for --mock <scenario>.
  mock: (name: ScenarioName) => Transport;
  // The task's checks; default tasks/<id>/tests/grader.ts's `checks`, or none.
  checks?: (task: string) => Promise<readonly Check[]>;
  // Default every tasks/*/task.toml, outside test mode.
  tasks?: TaskSource;
  // The trial runner; default packages/core/run.ts run().
  run?: typeof run;
}

// tasks/<id>/tests/grader.ts exports `checks`; a task without one has no checks.
async function taskChecks(task: string): Promise<readonly Check[]> {
  const file = join(REPO, 'tasks', task, 'tests', 'grader.ts');
  if (!existsSync(file)) return [];
  const { checks } = (await import(pathToFileURL(file).href)) as { checks?: unknown };
  if (!Array.isArray(checks)) throw new Error(`${file} does not export checks: Check[]`);
  return checks as Check[];
}

const defaults: Deps = {
  env: process.env,
  out: (l) => process.stdout.write(`${l}\n`),
  fetch: (request) => fetch(request),
  mock: (name) => scenarioTransport(name).transport,
};

export const projection = (checks: readonly Check[] = []): number => PER_TRIAL_CAP_USD + judgeAllowanceUsd(checks);

export async function main(args: string[], deps: Deps = defaults): Promise<number> {
  const opts = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === '--dry-run') opts.set(a, '');
    else if (WITH_VALUE.has(a) && args[i + 1] !== undefined) opts.set(a, args[++i] as string);
    else return usage(deps, WITH_VALUE.has(a) ? `${a} needs a value` : `unknown argument ${a}`);
  }
  const task = opts.get('--task');
  if (!task) return usage(deps, '--task is required');
  if (!TASK_ID.test(task)) return usage(deps, `--task ${JSON.stringify(task)} is not a task id (letters, digits, _ and - only)`);
  const tasks = deps.tasks ?? nodeTaskSource({ testMode: false });
  try {
    await tasks.get(task);
  } catch (e) {
    return usage(deps, `--task: ${(e as Error).message}`);
  }
  if (opts.get('--model') !== MODEL) return usage(deps, `--model must be ${MODEL}`);
  const effort = (opts.get('--effort') ?? DEFAULT_EFFORT) as Effort;
  if (!EFFORTS.includes(effort)) return usage(deps, `--effort must be one of ${EFFORTS.join(', ')}`);
  const index = Number(opts.get('--index') ?? '0');
  if (!Number.isSafeInteger(index) || index < 0) return usage(deps, '--index must be a whole number >= 0');
  const mock = opts.get('--mock');
  if (mock !== undefined && !isScenario(mock)) return usage(deps, `--mock: unknown scenario ${mock}`);
  const outDir = resolve(opts.get('--out') ?? deps.env.CHARTR_RUNS_DIR ?? join(deps.env.HOME || homedir(), '.chartr', 'runs', 'run-one'));

  let checks: readonly Check[];
  try {
    checks = await (deps.checks ?? taskChecks)(task);
  } catch (e) {
    return usage(deps, `--task: ${(e as Error).message}`);
  }
  const p = projection(checks);
  if (opts.has('--dry-run')) {
    deps.out(`run-one dry run: 1 trial of ${task} at effort ${effort}, per-trial cap ${money(PER_TRIAL_CAP_USD)}, judge allowance ${money(judgeAllowanceUsd(checks))}`);
    deps.out(`projection ${money(p)}`);
    deps.out(`LIVE_PROJECTION_USD=${p.toFixed(6)}`);
    return 0;
  }

  const key = mock === undefined ? (deps.env.ANTHROPIC_API_KEY ?? '') : 'mock-key-not-sent';
  if (key === '') {
    deps.out('run-one: ANTHROPIC_API_KEY is not set');
    return 1;
  }
  const trialKey = `${task}/${MODEL}/${effort}/${mock === undefined ? 'live' : `mock-${mock}`}/${index}`;
  const recordFile = join(outDir, 'trials', `${trialKey}.json`);
  const trajectoryRel = `trajectories/${trialKey}.jsonl`;
  if (existsSync(recordFile)) {
    const prior = JSON.parse(readFileSync(recordFile, 'utf8')) as Prior;
    const mismatch = prior.task_id !== task || prior.model_requested !== MODEL || prior.effort !== effort || prior.mock !== mock;
    if (mismatch) {
      deps.out(`run-one: ${recordFile} does not hold trial ${trialKey}; not run, not counted`);
      return 1;
    }
    deps.out(`trial ${trialKey} is already recorded in ${recordFile} (status ${prior.status}); not run again`);
    return succeeded(prior) ? 0 : 1;
  }
  const label = `${mock === undefined ? '' : 'mock:'}run-one:${trialKey}`;
  try {
    const { ledger, mode, path } = openNodeLedger({ transport: mock === undefined ? 'live' : 'offline', env: deps.env });
    deps.out(`ledger ${mode} ${path}`);
    const grant = await ledger.batchStart(p);
    try {
      const client = new MessagesClient({ grant, ledger, apiKey: key, fetch: mock === undefined ? deps.fetch : deps.mock(mock), trial: label, log: (l) => deps.out(l) });
      const trajectory = join(outDir, trajectoryRel);
      mkdirSync(dirname(trajectory), { recursive: true });
      writeFileSync(trajectory, '');
      const worldHash = (JSON.parse(readFileSync(join(REPO, 'fixtures/manifest.json'), 'utf8')) as { world: { state_hash: string } }).world.state_hash;
      const started = nodeNow();
      let record: TrialRecord;
      try {
        ({ record } = await (deps.run ?? run)(task, MODEL, {
          tasks,
          client,
          world: { read: async () => new Uint8Array(readFileSync(join(REPO, 'fixtures/world.ndjson.gz'))) },
          worldHash,
          definitions: JSON.parse(readFileSync(join(REPO, 'fixtures/definitions-pruned.json'), 'utf8')),
          now: nodeNow,
          effort,
          trialId: label,
          checks,
          onEvent: (e) => appendFileSync(trajectory, toJsonLine(e)),
        }));
      } catch (e) {
        deps.out(`run-one: run() threw: ${redactText((e as Error).message, [key])}`);
        // ENV_ERROR INTERNAL with cost 0 is true only before any call: never write it after one.
        const calls = readRows(path).filter((r) => r.trial === label && (r.kind === 'settle' || r.kind === 'reserve'));
        const settled = calls.filter((r) => r.kind === 'settle').length;
        if (calls.length > 0) {
          deps.out(`run-one: run() threw after spend: ${settled} settled call${settled === 1 ? '' : 's'} for ${label}; no record written, the trajectory holds what ran`);
          return 1;
        }
        record = internalErrorRecord({ trialId: label, taskId: task, worldHash, effort, started, ended: nodeNow() });
      }
      const full = { ...record, ...(mock === undefined ? {} : { mock }), trajectory: trajectoryRel };
      mkdirSync(dirname(recordFile), { recursive: true });
      writeFileSync(recordFile, `${JSON.stringify(full, null, 2)}\n`);
      deps.out(`status ${record.status}${record.detail ? ` (${record.detail})` : ''}, ${record.turns} turns, ${record.tool_calls} tool calls, cost ${money(record.cost_usd)}`);
      deps.out(`models_returned ${JSON.stringify(record.models_returned)}; final ${record.state_hash.final}; replay_final ${record.state_hash.replay_final}`);
      const gates = record.checks.filter((c) => c.kind === 'gate');
      deps.out(`outcome ${record.outcome}, score ${record.score === null ? 'n/a' : record.score.toFixed(3)}, gates ${gates.filter((c) => c.met === true).length}/${gates.length}, judge ${record.judge.calls} calls (${record.judge.unknown} unknown) ${money(record.judge_cost_usd)}`);
      if (record.error) deps.out(`not graded (${record.fault}): ${record.error.check ?? 'trial'}: ${redactText(record.error.message, [key])}${record.error.stops_batch ? '; the batch stops' : ''}`);
      deps.out(`record ${recordFile}`);
      deps.out(`trajectory ${trajectory}`);
      return succeeded(record) ? 0 : 1;
    } finally {
      await grant.close();
    }
  } catch (e) {
    deps.out(`run-one: ${redactText((e as Error).message, [key])}`);
    return 1;
  }
}

interface Prior {
  task_id?: string;
  model_requested?: string;
  effort?: string;
  mock?: string;
  status?: string;
  valid?: boolean;
  state_hash?: { final?: unknown; replay_final?: unknown };
}

function succeeded(r: Prior): boolean {
  return r.status === 'COMPLETED' && r.valid !== false && r.state_hash?.final != null && r.state_hash.replay_final === r.state_hash.final;
}

function usage(deps: Deps, problem: string): number {
  deps.out(`run-one: ${problem}\n${USAGE}`);
  return 2;
}

export default (args: string[]) => main(args);

// Run as a script, it installs the egress guard before anything else (pnpm cli run-one gets it
// from cli/index.ts); imported by tests, it leaves the importer's globals alone.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  installEgressGuard(globalThis);
  process.exitCode = await main(process.argv.slice(2));
}
