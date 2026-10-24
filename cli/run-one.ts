// pnpm cli run-one --task <id> --model claude-opus-5-5 [--effort high] [--index 0] [--out <dir>]
//                  [--mock <scenario>] [--dry-run]
// One trial through packages/core/run.ts in Node, metered through the spend ledger.
//   --task      a task id; an explicit _-prefixed id (_toy) resolves too
//   --effort    low | medium | high | xhigh | max; default high
//   --index     the trial's index in its key (task, model, effort, index); default 0
//   --out       the run directory: trials/<task>/<index>.json and trajectories/<task>/<index>.jsonl
//               (default $CHARTR_RUNS_DIR, else ~/.chartr/runs/run-one)
//   --mock      answers from a scripted scenario (apps/web/src/harness/scenarios.ts) instead of
//               the API. It needs no key and still meters through the ledger, at the mocked usage,
//               with trial labels starting mock:, so the cap checks run as they do live
//   --dry-run   prints the projection batchStart is given, and makes no call and opens nothing
// The projection is the per-trial cap ($6): the loop stops a trial once its cost reaches the cap
// and one trial makes no reruns and, until P8, no judge calls. batchStart refuses it, before
// any call, when the ledger's exposure plus the projection would cross $450. Each event is
// appended to the trajectory as it arrives, so a crash leaves a valid prefix; the record is
// written at the end. A trial key whose record exists is not run again. Exit 0 when the trial
// completed and replay_final equals final; 1 otherwise; 2 on a usage error.
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MODEL, MessagesClient, type Transport } from '../packages/core/anthropic.ts';
import { money, PER_TRIAL_CAP_USD } from '../packages/core/cost.ts';
import { installEgressGuard } from '../packages/core/egress.ts';
import { redactText } from '../packages/core/redact.ts';
import { DEFAULT_EFFORT, EFFORTS, run, type Effort } from '../packages/core/run.ts';
import { toJsonLine } from '../packages/core/trajectory.ts';
import { isScenario, scenarioTransport, type ScenarioName } from '../apps/web/src/harness/scenarios.ts';
import { nodeNow } from './adapters/clock-node.ts';
import { openNodeLedger } from './adapters/ledger-node.ts';
import { nodeTaskSource } from './adapters/tasks-node.ts';

const REPO = fileURLToPath(new URL('../', import.meta.url));
const WITH_VALUE = new Set(['--task', '--model', '--effort', '--index', '--out', '--mock']);
const USAGE = 'usage: pnpm cli run-one --task <id> --model claude-opus-5-5 [--effort high] [--index 0] [--out <dir>] [--mock <scenario>] [--dry-run]';

export interface Deps {
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  // The live transport.
  fetch: Transport;
  // The transport for --mock <scenario>.
  mock: (name: ScenarioName) => Transport;
}

const defaults: Deps = {
  env: process.env,
  out: (l) => process.stdout.write(`${l}\n`),
  fetch: (request) => fetch(request),
  mock: (name) => scenarioTransport(name).transport,
};

export const projection = (): number => PER_TRIAL_CAP_USD;

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
  if (opts.get('--model') !== MODEL) return usage(deps, `--model must be ${MODEL}`);
  const effort = (opts.get('--effort') ?? DEFAULT_EFFORT) as Effort;
  if (!EFFORTS.includes(effort)) return usage(deps, `--effort must be one of ${EFFORTS.join(', ')}`);
  const index = Number(opts.get('--index') ?? '0');
  if (!Number.isSafeInteger(index) || index < 0) return usage(deps, '--index must be a whole number >= 0');
  const mock = opts.get('--mock');
  if (mock !== undefined && !isScenario(mock)) return usage(deps, `--mock: unknown scenario ${mock}`);
  const outDir = resolve(opts.get('--out') ?? deps.env.CHARTR_RUNS_DIR ?? join(deps.env.HOME || homedir(), '.chartr', 'runs', 'run-one'));

  const p = projection();
  if (opts.has('--dry-run')) {
    deps.out(`run-one dry run: 1 trial of ${task} at effort ${effort}, per-trial cap ${money(PER_TRIAL_CAP_USD)}`);
    deps.out(`projection ${money(p)}`);
    deps.out(`LIVE_PROJECTION_USD=${p.toFixed(6)}`);
    return 0;
  }

  const recordFile = join(outDir, 'trials', task, `${index}.json`);
  const trajectoryRel = `trajectories/${task}/${index}.jsonl`;
  if (existsSync(recordFile)) {
    const prior = JSON.parse(readFileSync(recordFile, 'utf8')) as { status?: string; state_hash?: { final?: unknown; replay_final?: unknown } };
    deps.out(`trial ${task}:${index} is already recorded in ${recordFile} (status ${prior.status}); not run again`);
    return succeeded(prior) ? 0 : 1;
  }

  const key = mock === undefined ? (deps.env.ANTHROPIC_API_KEY ?? '') : 'mock-key-not-sent';
  if (key === '') {
    deps.out('run-one: ANTHROPIC_API_KEY is not set');
    return 1;
  }
  const label = `${mock === undefined ? '' : 'mock:'}run-one:${task}:${index}`;
  try {
    const { ledger, mode, path } = openNodeLedger({ transport: mock === undefined ? 'live' : 'offline', env: deps.env });
    deps.out(`ledger ${mode} ${path}`);
    const grant = await ledger.batchStart(p);
    try {
      const client = new MessagesClient({ grant, ledger, apiKey: key, fetch: mock === undefined ? deps.fetch : deps.mock(mock), trial: label, log: (l) => deps.out(l) });
      const trajectory = join(outDir, trajectoryRel);
      mkdirSync(dirname(trajectory), { recursive: true });
      writeFileSync(trajectory, '');
      const { record } = await run(task, MODEL, {
        tasks: nodeTaskSource({ testMode: false }),
        client,
        world: { read: async () => new Uint8Array(readFileSync(join(REPO, 'fixtures/world.ndjson.gz'))) },
        worldHash: (JSON.parse(readFileSync(join(REPO, 'fixtures/manifest.json'), 'utf8')) as { world: { state_hash: string } }).world.state_hash,
        definitions: JSON.parse(readFileSync(join(REPO, 'fixtures/definitions-pruned.json'), 'utf8')),
        now: nodeNow,
        effort,
        trialId: label,
        onEvent: (e) => appendFileSync(trajectory, toJsonLine(e)),
      });
      const full = { ...record, ...(mock === undefined ? {} : { mock }), trajectory: trajectoryRel };
      mkdirSync(dirname(recordFile), { recursive: true });
      writeFileSync(recordFile, `${JSON.stringify(full, null, 2)}\n`);
      deps.out(`status ${record.status}${record.detail ? ` (${record.detail})` : ''}, ${record.turns} turns, ${record.tool_calls} tool calls, cost ${money(record.cost_usd)}`);
      deps.out(`models_returned ${JSON.stringify(record.models_returned)}; final ${record.state_hash.final}; replay_final ${record.state_hash.replay_final}`);
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

function succeeded(r: { status?: string; state_hash?: { final?: unknown; replay_final?: unknown } }): boolean {
  return r.status === 'COMPLETED' && r.state_hash?.final != null && r.state_hash.replay_final === r.state_hash.final;
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
