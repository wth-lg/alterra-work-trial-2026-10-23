// pnpm cli matrix --task <id>
// The grader validation matrix of one task (packages/grader/matrix/matrix.ts), offline: the
// oracle, the alternatives, the mutants and the null, spray, output-gap and status-only agents
// run as scripted models through run(), graded by tasks/<id>/tests/grader.ts with judge items
// answered only from tasks/<id>/tests/judge-cache.json. It prints the oracle's score and
// judge.unknown, every count and verdict, double derivation, regrade idempotence, replay
// determinism and traceability, and exits 0 when the matrix holds, 1 when it does not (a judge
// cache miss included: it names the item and never makes a call), 2 on a usage error.
// It never builds a Messages client and opens no ledger: `pnpm cli oracle --live-judge` is the
// only command that asks the judge live and refreshes the cache.
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installEgressGuard } from '../packages/core/egress.ts';
import type { Check, Json } from '../packages/grader/check.ts';
import type { JudgeCacheEntry } from '../packages/grader/judge.ts';
import { declaresOf, runMatrix, type MatrixEnv } from '../packages/grader/matrix/matrix.ts';
import type { Agent, Agents, MatrixTask, Mutant, Script, WorldView } from '../packages/grader/matrix/types.ts';
import { nodeNow } from './adapters/clock-node.ts';
import { nodeTaskSource, TASKS_DIR } from './adapters/tasks-node.ts';

const REPO = fileURLToPath(new URL('../', import.meta.url));
// A task id is a directory name: no path separators, no '..'.
export const TASK_ID = /^[A-Za-z0-9_-]+$/;
const USAGE = 'usage: pnpm cli matrix --task <id>';

// The TOML parser is packages/core's dependency (its task parser's); it is resolved from there,
// so reading [matrix] needs no new dependency.
const toml = (await import(pathToFileURL(createRequire(join(REPO, 'packages/core/package.json')).resolve('smol-toml')).href)) as { parse(text: string): Record<string, unknown> };

export interface Deps {
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  // A task's matrix inputs; default loadMatrixTask.
  load?: (task: string) => Promise<MatrixTask>;
}

// The world, manifest hash and definitions every matrix trial starts from.
export function matrixEnv(): MatrixEnv {
  const world = new Uint8Array(readFileSync(join(REPO, 'fixtures/world.ndjson.gz')));
  return {
    tasks: nodeTaskSource({ testMode: false }),
    world: { read: async () => world },
    worldHash: (JSON.parse(readFileSync(join(REPO, 'fixtures/manifest.json'), 'utf8')) as { world: { state_hash: string } }).world.state_hash,
    definitions: JSON.parse(readFileSync(join(REPO, 'fixtures/definitions-pruned.json'), 'utf8')),
    now: nodeNow,
  };
}

// One export of a task module, or `fallback` when the file does not exist.
async function exported<T>(dir: string, rel: string, name: string, fallback: T): Promise<T> {
  const file = join(dir, rel);
  if (!existsSync(file)) return fallback;
  const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  if (!(name in mod)) throw new Error(`tasks/${dir.split('/').filter(Boolean).at(-1)}/${rel} does not export ${name}`);
  return mod[name] as T;
}

// Reads a task's matrix inputs from tasks/<id> (layout: packages/grader/matrix/types.ts).
export async function loadMatrixTask(id: string, root: string = TASKS_DIR): Promise<MatrixTask> {
  const task = await nodeTaskSource({ root, testMode: true }).get(id);
  const dir = join(root, id);
  const cacheFile = join(dir, 'tests/judge-cache.json');
  return {
    id,
    instruction: task.instruction,
    policies: task.policies.map((p) => ({ id: p.id, text: p.text })),
    declares: declaresOf(toml.parse(readFileSync(join(dir, 'task.toml'), 'utf8'))),
    checks: await exported<Check[]>(dir, 'tests/grader.ts', 'checks', []),
    oracle: await exported<Script | null>(dir, 'solution/solve.ts', 'oracle', null),
    alternatives: await exported<Agent[]>(dir, 'tests/alternatives.ts', 'alternatives', []),
    mutants: await exported<Mutant[]>(dir, 'tests/mutants.ts', 'mutants', []),
    agents: existsSync(join(dir, 'tests/agents.ts')) ? ((await import(pathToFileURL(join(dir, 'tests/agents.ts')).href)) as Agents) : {},
    expected: await exported<Json | undefined>(dir, 'expected.ts', 'expected', undefined),
    derive: await exported<((w: WorldView) => Json) | undefined>(dir, 'policy.ts', 'derive', undefined),
    cache: existsSync(cacheFile) ? (JSON.parse(readFileSync(cacheFile, 'utf8')) as JudgeCacheEntry[]) : [],
  };
}

export async function main(args: string[], deps: Deps): Promise<number> {
  if (args.length !== 2 || args[0] !== '--task') return usage(deps, args.length === 0 ? '--task is required' : `unexpected arguments ${args.join(' ')}`);
  const id = args[1]!;
  if (!TASK_ID.test(id)) return usage(deps, `--task ${JSON.stringify(id)} is not a task id (letters, digits, _ and - only)`);
  let task: MatrixTask;
  try {
    task = await (deps.load ?? loadMatrixTask)(id);
  } catch (e) {
    return usage(deps, `--task: ${(e as Error).message}`);
  }
  const result = await runMatrix(matrixEnv(), task);
  for (const line of result.lines) deps.out(line);
  return result.pass ? 0 : 1;
}

function usage(deps: Deps, problem: string): number {
  deps.out(`matrix: ${problem}\n${USAGE}`);
  return 2;
}

const defaults: Deps = { env: process.env, out: (l) => process.stdout.write(`${l}\n`) };

export default (args: string[]) => {
  installEgressGuard(globalThis);
  return main(args, defaults);
};

// Run as a script, it installs the egress guard first (pnpm cli matrix gets it from cli/index.ts
// too); imported by tests, it leaves the importer's globals alone.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  installEgressGuard(globalThis);
  process.exitCode = await main(process.argv.slice(2), defaults);
}
