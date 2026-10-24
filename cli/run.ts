// pnpm cli run --task all|<id,...> --model claude-opus-5-5 --out <run dir> [--trials 10] [--effort high]
//              [--concurrency 4] [--cost-from <run,...>] [--mock <scenario>] [--dry-run]
// A batch of trials through packages/core/batch.ts runBatch, the loop a UI batch runs too: keyed
// by (task_version, model, effort, index), so a rerun with the same arguments resumes with the
// keys not yet recorded, and a killed batch's open ledger batch is closed first.
//   --task         all, or a comma list of task ids; an unknown id exits 1
//   --out          the run directory (results/runs/<run_id>); its name is the run id
//   --cost-from    runs whose trial costs project this batch: per task, the p90 of the latest run
//                  holding its task_version (an earlier version as fallback), else the $6 cap
//   --mock         answers from a scripted scenario (apps/web/src/harness/scenarios.ts), no key; it
//                  meters through SPEND_LEDGER, else <out>/mock-spend.jsonl, never ~/.clinenv or the
//                  canonical ledger. A run directory holds one mode (live or mock-<scenario>)
//   --dry-run      prints the projection (trials x per-trial cost x 1.15 + judge allowance) and
//                  LIVE_PROJECTION_USD=<x>, and opens nothing
// The client comes only from batchStart(projection), which refuses the batch, with no call, when
// the projection would cross PROJECTED_CAP_USD (packages/core/ledger.ts). The manifest records env_git_sha and env_dirty: whether
// `git status --porcelain -- tasks fixtures packages/env packages/core packages/grader` is
// non-empty. A live batch on a dirty tree (or outside git) is refused with no call: a committed
// run must name the code it ran. Ctrl-C cancels the batch through its AbortSignal. Exit 0 when
// every key is recorded and the batch was not stopped; 1 otherwise; 2 on a usage error.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MessagesClient, MODEL, type Transport } from '../packages/core/anthropic.ts';
import { BatchRefused, planBatch, runBatch, type BatchSpec } from '../packages/core/batch.ts';
import { formatProjection, money, type TrialObservation } from '../packages/core/cost.ts';
import { installEgressGuard } from '../packages/core/egress.ts';
import { SpendRefused } from '../packages/core/ledger.ts';
import { redactText } from '../packages/core/redact.ts';
import { DEFAULT_EFFORT, EFFORTS, type Effort } from '../packages/core/run.ts';
import type { TaskSource } from '../packages/core/tasks.ts';
import type { Check } from '../packages/grader/check.ts';
import { isScenario, scenarioTransport, type ScenarioName } from '../apps/web/src/harness/scenarios.ts';
import { nodeNow } from './adapters/clock-node.ts';
import { loadTrialObservations, openNodeLedger } from './adapters/ledger-node.ts';
import { nodeResultSink } from './adapters/result-sink-node.ts';
import { nodeTaskSource } from './adapters/tasks-node.ts';

export const REPO = fileURLToPath(new URL('../', import.meta.url));
const TASK_ID = /^[A-Za-z0-9_-]+$/;
const DIRTY_PATHS = ['tasks', 'fixtures', 'packages/env', 'packages/core', 'packages/grader'];
const WITH_VALUE = new Set(['--task', '--model', '--trials', '--effort', '--concurrency', '--out', '--cost-from', '--mock']);
const USAGE = 'usage: pnpm cli run --task all|<id,...> --model claude-opus-5-5 --out <run dir> [--trials 10] [--effort high] [--concurrency 4] [--cost-from <run,...>] [--mock <scenario>] [--dry-run]';

export interface Deps {
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  // The live transport.
  fetch: Transport;
  // The transport of one trial attempt under --mock <scenario>.
  mock: (name: ScenarioName, trial: string) => Transport;
  tasks?: TaskSource;
  checks?: (task: string) => Promise<readonly Check[]>;
  // The checkout env_git_sha and env_dirty are read from; default this repo.
  repo?: string;
  signal?: AbortSignal;
}

// tasks/<id>/tests/grader.ts exports `checks`; a task without one has no checks.
export async function taskChecks(task: string): Promise<readonly Check[]> {
  const file = join(REPO, 'tasks', task, 'tests', 'grader.ts');
  if (!existsSync(file)) return [];
  const { checks } = (await import(pathToFileURL(file).href)) as { checks?: unknown };
  if (!Array.isArray(checks)) throw new Error(`${file} does not export checks: Check[]`);
  return checks as Check[];
}

// The world every trial starts from, its manifest hash and the definitions bundle.
export function repoWorld() {
  const bytes = new Uint8Array(readFileSync(join(REPO, 'fixtures/world.ndjson.gz')));
  return {
    world: { read: async () => bytes },
    worldHash: (JSON.parse(readFileSync(join(REPO, 'fixtures/manifest.json'), 'utf8')) as { world: { state_hash: string } }).world.state_hash,
    definitions: JSON.parse(readFileSync(join(REPO, 'fixtures/definitions-pruned.json'), 'utf8')),
  };
}

// HEAD and the dirty paths of a checkout; null where git cannot say.
export function gitState(repo: string): { sha: string | null; dirty: string[] | null } {
  const git = (...args: string[]) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  const sha = git('rev-parse', 'HEAD');
  const status = git('status', '--porcelain', '--', ...DIRTY_PATHS);
  return { sha: sha.status === 0 ? sha.stdout.trim() : null, dirty: status.status === 0 ? status.stdout.split('\n').filter((l) => l !== '') : null };
}

const defaults: Deps = {
  env: process.env,
  out: (l) => process.stdout.write(`${l}\n`),
  fetch: (request) => fetch(request),
  mock: (name) => scenarioTransport(name).transport,
};

export async function main(args: string[], deps: Deps = defaults): Promise<number> {
  const opts = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === '--dry-run') opts.set(a, '');
    else if (WITH_VALUE.has(a) && args[i + 1] !== undefined) opts.set(a, args[++i] as string);
    else return usage(deps, WITH_VALUE.has(a) ? `${a} needs a value` : `unknown argument ${a}`);
  }
  const taskArg = opts.get('--task');
  if (!taskArg) return usage(deps, '--task is required: all, or a comma list of task ids');
  if (opts.get('--model') !== MODEL) return usage(deps, `--model must be ${MODEL}`);
  const effort = (opts.get('--effort') ?? DEFAULT_EFFORT) as Effort;
  if (!EFFORTS.includes(effort)) return usage(deps, `--effort must be one of ${EFFORTS.join(', ')}`);
  const whole = (flag: string, fallback: number) => {
    const v = Number(opts.get(flag) ?? fallback);
    return Number.isSafeInteger(v) && v >= 1 ? v : null;
  };
  const trials = whole('--trials', 10);
  if (trials === null) return usage(deps, '--trials must be a whole number >= 1');
  const concurrency = whole('--concurrency', 4);
  if (concurrency === null) return usage(deps, '--concurrency must be a whole number >= 1');
  const outArg = opts.get('--out');
  if (!outArg) return usage(deps, '--out <run dir> is required');
  const mock = opts.get('--mock');
  if (mock !== undefined && !isScenario(mock)) return usage(deps, `--mock: unknown scenario ${mock}`);

  const tasks = deps.tasks ?? nodeTaskSource({ testMode: false });
  let taskIds: string[];
  try {
    taskIds = taskArg === 'all' ? (await tasks.all()).map((t) => t.id) : taskArg.split(',').map((s) => s.trim());
    for (const id of taskIds) {
      if (!TASK_ID.test(id)) throw new Error(`${JSON.stringify(id)} is not a task id (letters, digits, _ and - only)`);
      await tasks.get(id);
    }
  } catch (e) {
    deps.out(`run: --task: ${(e as Error).message}`);
    return 1;
  }
  if (taskIds.length === 0) {
    deps.out('run: --task all: no tasks');
    return 1;
  }
  let observations: TrialObservation[] = [];
  try {
    const from = opts.get('--cost-from');
    if (from) observations = loadTrialObservations(from.split(',').map((p) => resolve(p)));
  } catch (e) {
    return usage(deps, (e as Error).message);
  }

  const out = resolve(outArg);
  const runId = basename(out);
  const mode = mock === undefined ? 'live' : `mock-${mock}`;
  const { world, worldHash, definitions } = repoWorld();
  const sink = nodeResultSink(out);
  const spec: BatchSpec = { runId, taskIds, trials, model: MODEL, effort, mode, concurrency, observations, log: (l) => deps.out(l), ...(deps.signal ? { signal: deps.signal } : {}) };
  if (opts.has('--dry-run')) {
    try {
      const plan = await planBatch(spec, { tasks, sink, worldHash });
      deps.out(`run dry run: ${plan.remaining.length} of ${plan.keys.length} trials to run (${plan.keys.length - plan.remaining.length} recorded in ${out}), effort ${effort}, ${mode}`);
      for (const line of formatProjection(plan.projection, 'projection')) deps.out(line);
      deps.out(`LIVE_PROJECTION_USD=${plan.projection.total.toFixed(6)}`);
      return 0;
    } catch (e) {
      deps.out(`run: ${(e as Error).message}`);
      return 1;
    }
  }

  const git = gitState(deps.repo ?? REPO);
  if (mode === 'live') {
    if (git.sha === null || git.dirty === null) {
      deps.out('run: refusing a live batch: git cannot say which commit this tree is');
      return 1;
    }
    if (git.dirty.length > 0) {
      deps.out(`run: refusing a live batch: the tree is dirty under ${DIRTY_PATHS.join(', ')}; commit first, so the run names the code it ran:\n  ${git.dirty.join('\n  ')}`);
      return 1;
    }
  }
  const key = mock === undefined ? (deps.env.ANTHROPIC_API_KEY ?? '') : 'mock-key-not-sent';
  if (key === '') {
    deps.out('run: ANTHROPIC_API_KEY is not set');
    return 1;
  }
  if (mock !== undefined && deps.env.CLINENV_CANONICAL_LEDGER !== undefined) {
    return usage(deps, '--mock never meters through the canonical ledger; unset CLINENV_CANONICAL_LEDGER');
  }
  try {
    const env = mock === undefined ? deps.env : { ...deps.env, SPEND_LEDGER: deps.env.SPEND_LEDGER ?? join(out, 'mock-spend.jsonl') };
    const { ledger, store, mode: ledgerMode, path } = openNodeLedger({ transport: mock === undefined ? 'live' : 'offline', env, runId });
    deps.out(`ledger ${ledgerMode} ${path}`);
    const result = await runBatch(
      { ...spec, manifest: { env_git_sha: git.sha, env_dirty: git.dirty === null ? null : git.dirty.length > 0 } },
      {
        ledger, rows: () => store.read(), sink, tasks, checks: deps.checks ?? taskChecks, world, worldHash, definitions, now: nodeNow,
        client: (grant, trial) => new MessagesClient({ grant, ledger, apiKey: key, fetch: mock === undefined ? deps.fetch : deps.mock(mock, trial), trial }),
      },
    );
    const recorded = (await sink.settled()).length;
    deps.out(`projection ${money(result.plan.projection.total)}; batch ${result.batch_id ?? '(none: every key recorded)'}: ${result.settled} settled, ${result.requeued} re-queued; ${recorded} of ${result.plan.keys.length} keys recorded in ${out}`);
    if (result.stopped) deps.out(`run: batch stopped (${result.stopped.code}): ${redactText(result.stopped.message, [key])}`);
    if (result.cancelled) deps.out('run: batch cancelled');
    return result.stopped === null && !result.cancelled && recorded >= result.plan.keys.length ? 0 : 1;
  } catch (e) {
    const what = e instanceof SpendRefused ? 'refused' : e instanceof BatchRefused ? 'refused' : 'error';
    deps.out(`run: ${what}: ${redactText((e as Error).message, [key])}`);
    return 1;
  }
}

function usage(deps: Deps, problem: string): number {
  deps.out(`run: ${problem}\n${USAGE}`);
  return 2;
}

// Ctrl-C cancels the batch: the trials in flight end CANCELLED, the batch closes.
function withInterrupt(args: string[]): Promise<number> {
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort(new Error('SIGINT')));
  return main(args, { ...defaults, signal: controller.signal });
}

export default (args: string[]) => {
  installEgressGuard(globalThis);
  return withInterrupt(args);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  installEgressGuard(globalThis);
  process.exitCode = await withInterrupt(process.argv.slice(2));
}
