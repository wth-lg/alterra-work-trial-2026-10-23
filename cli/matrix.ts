// pnpm cli matrix --task <id>|all
// pnpm cli matrix --list-tasks
// The grader validation matrix of one task (packages/grader/matrix/matrix.ts), offline: the
// oracle, the alternatives, the mutants and the null, spray, output-gap and status-only agents
// run as scripted models through run(), graded by tasks/<id>/tests/grader.ts with judge items
// answered only from tasks/<id>/tests/judge-cache.json. It prints the oracle's score and
// judge.unknown, every count and verdict, double derivation, regrade idempotence, replay
// determinism and traceability, and exits 0 when the matrix holds, 1 when it does not (a judge
// cache miss included: it names the item and never makes a call), 2 on a usage error.
// --task all runs the matrix of every directory under tasks/ that has tests/, one after the
// other, prints a summary line per task and exits 1 when any task fails (a usage error
// included), 0 when all pass.
// --list-tasks prints the ids --task all runs as one line of JSON and exits 1 when there are
// none. CI's matrix job fans out over it and runs --task <id> once per task, in parallel.
// A case whose second run differs leaves both runs under results/replay-mismatch/<task>/ (or
// $REPLAY_MISMATCH_DIR): each trajectory, raw and stripped, each record, and the first
// divergent line.
// It never builds a Messages client and opens no ledger: `pnpm cli oracle --live-judge` is the
// only command that asks the judge live and refreshes the cache.
// Two checks need Node and live here, given to the matrix as options:
//   isolation       each case is graded again in a child process (`node cli/matrix.ts
//                   --fresh-grade`, the run on stdin), which imports tests/grader.ts afresh;
//                   the matrix compares every in-process grade with it
//   policy imports  policyImports follows policy.ts's whole import graph with the TypeScript
//                   compiler's module resolution and fails on any expected.ts or overlay module
//                   it reaches, and on any dynamic import whose specifier is not a constant
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { availableParallelism } from 'node:os';
import { basename, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { installEgressGuard } from '../packages/core/egress.ts';
import { stripTimestamps, toJsonl } from '../packages/core/trajectory.ts';
import type { Check, Json } from '../packages/grader/check.ts';
import type { Grade } from '../packages/grader/grade.ts';
import type { JudgeCacheEntry } from '../packages/grader/judge.ts';
import { declaresOf, gradeRun, runMatrix, type CaseRun, type FreshGrade, type MatrixEnv, type MatrixOptions, type ReplayDiff } from '../packages/grader/matrix/matrix.ts';
import type { Agents, Alternative, MatrixTask, Mutant, Script, WorldView } from '../packages/grader/matrix/types.ts';
import { nodeNow } from './adapters/clock-node.ts';
import type { TaskSource } from '../packages/core/tasks.ts';
import { nodeTaskSource, TASKS_DIR } from './adapters/tasks-node.ts';

const REPO = fileURLToPath(new URL('../', import.meta.url));
// A task id is a directory name: no path separators, no '..'.
export const TASK_ID = /^[A-Za-z0-9_-]+$/;
const USAGE = 'usage: pnpm cli matrix --task <id>|all\n       pnpm cli matrix --list-tasks';

// The TOML parser is packages/core's dependency (its task parser's); it is resolved from there,
// so reading [matrix] needs no new dependency.
const toml = (await import(pathToFileURL(createRequire(join(REPO, 'packages/core/package.json')).resolve('smol-toml')).href)) as { parse(text: string): Record<string, unknown> };

export interface Deps {
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  // A task's matrix inputs; default loadMatrixTask.
  load?: (task: string) => Promise<MatrixTask>;
  // Narrows the run (a unit test's subset of cases, one trial, one grade); default the whole
  // matrix with the isolation check and the policy import graph.
  options?: MatrixOptions;
  // The task ids --task all runs and --list-tasks prints; default matrixTaskIds.
  tasks?: () => string[];
}

// The tasks --task all runs: each directory under tasks/ with a tests/ directory, sorted.
export function matrixTaskIds(root: string = TASKS_DIR): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && TASK_ID.test(d.name) && existsSync(join(root, d.name, 'tests')))
    .map((d) => d.name)
    .sort();
}

// The world, manifest hash, definitions and task files (under `root`, or `tasks`) every matrix
// trial starts from.
export function matrixEnv(root: string = TASKS_DIR, tasks: TaskSource = nodeTaskSource({ root, testMode: false })): MatrixEnv {
  const world = new Uint8Array(readFileSync(join(REPO, 'fixtures/world.ndjson.gz')));
  return {
    tasks,
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

// Reads a task's matrix inputs from tasks/<id> (layout: packages/grader/matrix/types.ts); the
// instruction and policies through `tasks`.
export async function loadMatrixTask(id: string, root: string = TASKS_DIR, tasks: TaskSource = nodeTaskSource({ root, testMode: true })): Promise<MatrixTask> {
  const task = await tasks.get(id);
  const dir = join(root, id);
  const cacheFile = join(dir, 'tests/judge-cache.json');
  const checksModule = join(dir, 'tests/grader.ts');
  return {
    id,
    instruction: task.instruction,
    policies: task.policies.map((p) => ({ id: p.id, text: p.text })),
    declares: declaresOf(toml.parse(readFileSync(join(dir, 'task.toml'), 'utf8'))),
    checks: await exported<Check[]>(dir, 'tests/grader.ts', 'checks', []),
    ...(existsSync(checksModule) ? { checksModule } : {}),
    oracle: await exported<Script | null>(dir, 'solution/solve.ts', 'oracle', null),
    alternatives: await exported<Alternative[]>(dir, 'tests/alternatives.ts', 'alternatives', []),
    mutants: await exported<Mutant[]>(dir, 'tests/mutants.ts', 'mutants', []),
    agents: existsSync(join(dir, 'tests/agents.ts')) ? ((await import(pathToFileURL(join(dir, 'tests/agents.ts')).href)) as Agents) : {},
    expected: await exported<Json | undefined>(dir, 'expected.ts', 'expected', undefined),
    derive: await exported<((w: WorldView) => Json) | undefined>(dir, 'policy.ts', 'derive', undefined),
    cache: existsSync(cacheFile) ? (JSON.parse(readFileSync(cacheFile, 'utf8')) as JudgeCacheEntry[]) : [],
    judgeEffort: task.judgeEffort,
  };
}

export async function main(args: string[], deps: Deps): Promise<number> {
  if (args.length === 1 && args[0] === '--list-tasks') return listTasks(deps);
  if (args.length !== 2 || args[0] !== '--task') return usage(deps, args.length === 0 ? '--task is required' : `unexpected arguments ${args.join(' ')}`);
  const id = args[1]!;
  if (id === 'all') return all(deps);
  const r = await one(id, deps);
  return r.usage === undefined ? r.code : usage(deps, r.usage);
}

// The ids as JSON, for CI's strategy.matrix; an empty matrix would fail there less clearly.
function listTasks(deps: Deps): number {
  const ids = (deps.tasks ?? matrixTaskIds)();
  if (ids.length === 0) {
    deps.out('matrix: no task directory has tests/');
    return 1;
  }
  deps.out(JSON.stringify(ids));
  return 0;
}

// Every task's matrix in turn, then one summary line per task.
async function all(deps: Deps): Promise<number> {
  const ids = (deps.tasks ?? matrixTaskIds)();
  const results: Array<{ id: string; pass: boolean; usage?: string }> = [];
  for (const id of ids) {
    const r = await one(id, deps);
    if (r.usage !== undefined) deps.out(`matrix ${id}: ${r.usage}`);
    results.push({ id, pass: r.code === 0, ...(r.usage !== undefined ? { usage: r.usage } : {}) });
  }
  const passed = results.filter((r) => r.pass).length;
  deps.out(`matrix all: ${ids.length} tasks, ${passed} PASS, ${ids.length - passed} FAIL`);
  for (const r of results) deps.out(`  ${r.id}: ${r.pass ? 'PASS' : 'FAIL'}${r.usage !== undefined ? ` (usage: ${r.usage})` : ''}`);
  return ids.length > 0 && passed === ids.length ? 0 : 1;
}

// One task's matrix, its lines written to deps.out; a usage problem (not a task id, cannot be
// loaded) is returned for the caller to print.
async function one(id: string, deps: Deps): Promise<{ code: number; usage?: string }> {
  if (!TASK_ID.test(id)) return { code: 2, usage: `--task ${JSON.stringify(id)} is not a task id (letters, digits, _ and - only)` };
  // One read of tasks/ for the whole run: the instruction and policies the cases are built from
  // and the task every trial resolves are the same files.
  const tasks = nodeTaskSource({ root: TASKS_DIR, testMode: true });
  let task: MatrixTask;
  try {
    task = await (deps.load ?? ((t) => loadMatrixTask(t, TASKS_DIR, tasks)))(id);
  } catch (e) {
    return { code: 2, usage: `--task: ${(e as Error).message}` };
  }
  const options: MatrixOptions = {
    policyImports: () => policyImports(join(TASKS_DIR, id)),
    onReplayMismatch: (c, first, again, diff) => {
      const dir = writeReplayMismatch(deps.env.REPLAY_MISMATCH_DIR || join(REPO, 'results/replay-mismatch'), id, c.id, first, again, diff);
      deps.out(`replay mismatch ${id}/${c.id}: ${diff.summary}; both runs in ${dir}`);
    },
    ...(task.checksModule ? { fresh: freshGrader(task, task.checksModule) } : {}),
    ...deps.options,
  };
  let result;
  try {
    result = await runMatrix(matrixEnv(TASKS_DIR, tasks), task, options);
  } catch (e) {
    deps.out(`matrix ${id}: FAIL\n  - ${(e as Error).message}`);
    return { code: 1 };
  }
  for (const line of result.lines) deps.out(line);
  return { code: result.pass ? 0 : 1 };
}

// Writes both runs of a case that did not replay to <root>/<task>/<case>-<n>/, n the first
// unused number, and returns the directory: first and again as raw and stripped JSONL, their
// records, and diff.txt with the first divergent line.
export function writeReplayMismatch(root: string, task: string, caseId: string, first: CaseRun, again: CaseRun, diff: ReplayDiff): string {
  let n = 1;
  while (existsSync(join(root, task, `${caseId}-${n}`))) n++;
  const dir = join(root, task, `${caseId}-${n}`);
  mkdirSync(dir, { recursive: true });
  for (const [name, r] of [['first', first], ['again', again]] as const) {
    writeFileSync(join(dir, `${name}.jsonl`), toJsonl(r.events));
    writeFileSync(join(dir, `${name}.stripped.jsonl`), stripTimestamps(toJsonl(r.events)));
    writeFileSync(join(dir, `${name}.record.json`), `${JSON.stringify(r.record, null, 2)}\n`);
  }
  writeFileSync(join(dir, 'diff.txt'), `${diff.summary}\nfirst: ${diff.first}\nagain: ${diff.again}\n`);
  return dir;
}

// What the fresh process reads on stdin.
interface FreshInput {
  task: string;
  checksModule: string;
  cache: JudgeCacheEntry[];
  run: CaseRun;
}

const SELF = fileURLToPath(import.meta.url);

// Grades each case in a child process of its own, a few at a time. The child gets no API key.
function freshGrader(task: MatrixTask, checksModule: string): FreshGrade {
  const limit = Math.max(2, Math.min(8, availableParallelism() - 1));
  let active = 0;
  const waiting: Array<() => void> = [];
  const child = (input: FreshInput) =>
    new Promise<Grade>((resolve, reject) => {
      const p = spawn(process.execPath, [SELF, '--fresh-grade'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ANTHROPIC_API_KEY: '' } });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      p.stdout.on('data', (b: Buffer) => out.push(b));
      p.stderr.on('data', (b: Buffer) => err.push(b));
      p.on('error', reject);
      p.on('close', (code) => {
        if (code === 0) resolve(JSON.parse(Buffer.concat(out).toString('utf8')) as Grade);
        else reject(new Error(`fresh-process grade exited ${code}: ${Buffer.concat(err).toString('utf8').trim().split('\n').slice(-3).join(' ')}`));
      });
      p.stdin.end(JSON.stringify(input));
    });
  return async (_c, run) => {
    while (active >= limit) await new Promise<void>((r) => waiting.push(r));
    active++;
    try {
      return await child({ task: task.id, checksModule, cache: [...task.cache], run });
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

// The child: imports the checks module in this new process and grades the run once.
async function freshGrade(): Promise<number> {
  const chunks: Buffer[] = [];
  for await (const b of process.stdin) chunks.push(b as Buffer);
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as FreshInput;
  const { checks } = (await import(pathToFileURL(input.checksModule).href)) as { checks: Check[] };
  const grade = await gradeRun(matrixEnv(), { id: input.task, cache: input.cache }, checks, input.run);
  process.stdout.write(JSON.stringify(grade));
  return 0;
}

const COMPILER = (() => {
  const file = join(REPO, 'tsconfig.json');
  const { config } = ts.readConfigFile(file, ts.sys.readFile);
  return ts.parseJsonConfigFileContent(config, ts.sys, REPO, undefined, file).options;
})();
const BANNED_BASE = /^(expected|overlay)\.[cm]?[jt]sx?$/i;
const isBanned = (file: string) => BANNED_BASE.test(basename(file)) || file.split(sep).slice(0, -1).some((d) => d.toLowerCase() === 'overlay');

// The module specifiers a file imports for values, and each dynamic import whose specifier is
// not a constant. Type-only imports and exports carry no values and are skipped.
function importsOf(file: string): { specs: string[]; dynamic: number } {
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const specs: string[] = [];
  let dynamic = 0;
  const typeOnly = (names: ts.NamedImportBindings | ts.NamedExportBindings | undefined) => names !== undefined && 'elements' in names && names.elements.length > 0 && names.elements.every((e) => e.isTypeOnly);
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const c = node.importClause;
      if (!(c && (c.isTypeOnly || (c.name === undefined && typeOnly(c.namedBindings))))) specs.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!node.isTypeOnly && !typeOnly(node.exportClause)) specs.push(node.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteral(node.moduleReference.expression)) {
      if (!node.isTypeOnly) specs.push(node.moduleReference.expression.text);
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      const arg = node.arguments[0];
      if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) specs.push(arg.text);
      else dynamic++;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { specs, dynamic };
}

// Follows the whole import graph of <taskDir>/policy.ts and reports each expected.ts or overlay
// module it reaches (by name, path segment 'overlay' included, compared on the real path so a
// case variant cannot hide one), each import that does not resolve, and each dynamic import with
// a non-constant specifier. Packages under node_modules are not followed. No policy.ts: nothing.
export function policyImports(taskDir: string): { modules: number; problems: string[] } {
  const entry = join(taskDir, 'policy.ts');
  if (!existsSync(entry)) return { modules: 0, problems: [] };
  const show = (f: string) => (f.startsWith(taskDir + sep) ? relative(taskDir, f) : relative(REPO, f)).split(sep).join('/');
  const root = realpathSync.native(entry);
  const via = new Map<string, string[]>([[root, ['policy.ts']]]);
  const queue = [root];
  const problems: string[] = [];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    const chain = via.get(file)!;
    const { specs, dynamic } = importsOf(file);
    if (dynamic > 0) problems.push(`${show(file)}: dynamic import with a non-constant specifier`);
    for (const spec of specs) {
      // A '?' query or '#' fragment does not change the file a URL names; a leading '#' is a
      // package.json subpath import and stays.
      const bare = spec.startsWith('#') ? spec : spec.split(/[?#]/)[0]!;
      const resolved = ts.resolveModuleName(bare, file, COMPILER, ts.sys).resolvedModule;
      if (resolved === undefined) {
        problems.push(`${show(file)}: cannot resolve '${spec}'`);
        continue;
      }
      if (resolved.isExternalLibraryImport) continue;
      const target = realpathSync.native(resolved.resolvedFileName);
      if (isBanned(target)) problems.push(`policy.ts reaches ${show(target)} via ${chain.join(' -> ')}`);
      else if (!via.has(target)) {
        via.set(target, [...chain, show(target)]);
        queue.push(target);
      }
    }
  }
  return { modules: via.size, problems };
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
  process.exitCode = process.argv[2] === '--fresh-grade' ? await freshGrade() : await main(process.argv.slice(2), defaults);
}
