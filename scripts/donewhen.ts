// Prints one PASS/FAIL line per done-when clause (1)-(7) with the evidence it read,
// and exits 0 only on 7/7. Run from the repo root: `pnpm donewhen`.
//
// Where a CLI command exists for a clause, this script only runs it and reads its exit code
// and JSON; it computes nothing itself. A command that is not built yet (the dispatcher exits
// 127) is a FAIL with reason 'command not built'. The CLI contracts it relies on:
//   cli oracle --task all --json        exit 0 when every task passes; {tasks: [{id, score}]}
//   cli summary <run> --require ... --json
//                                       exit 0 when the requirements hold;
//                                       {tasks: {<id>: {passes, trials}}, initial_state_hashes: [...]}
//   cli audit-check <run> --json        exit 0 when every failure is labelled and none is
//                                       environment or grader; {failures, labelled, environment, grader}
//   cli spend --json                    {total_usd}, printed as an INFO line
//   cli runner-check --mock --json      exit 0 when the local runner passes every check;
//                                       {events_equal}: its streamed events equal run-one's
//
// Clause (1) passes when `runner-check --mock` exits 0 and README.md names LOCAL_START_COMMAND
// (apps/web/src/surface/command.ts) and the hosted URL. Clause (2) passes when cli/run-one.ts,
// cli/run.ts, apps/runner/main.ts and a Worker module under apps/web/src (a file named *worker*)
// each reach packages/core/run.ts through their relative value imports (`import type`, `export
// type` and imports inside comments do not count: none loads the module), and runner-check
// reports events_equal: the runner streams the trajectory run-one writes. runner-check --mock
// runs once; both clauses read its result.
//
// Test hooks, honored only when NODE_ENV=test: DONEWHEN_CLI replaces `node cli/index.ts`
// (space-separated command prefix); DONEWHEN_MIN_TASKS replaces the minimum of 5 tasks;
// DONEWHEN_INCLUDE_UNDERSCORE=1 makes clause (3) count _-prefixed task directories (tasks/_toy),
// so the real oracle can be checked before any real task exists.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { LOCAL_START_COMMAND } from '../apps/web/src/surface/command.ts';

const FINAL_RUN = 'results/runs/final-1';
const MODEL = 'claude-opus-5-5';
const HOSTED_URL = 'https://wth-lg.github.io/clinical-agent-env/';
const MIN_TASKS = 5;
const TASK_FILES = ['instruction.md', 'task.toml', 'tests/grader.ts', 'solution/solve.ts'];
const README_SECTIONS = ['findings', 'surprises', 'changes', 'next steps'];
const CORE_RUN = 'packages/core/run.ts';
// The entry points clause (2) follows to packages/core/run.ts.
const RUN_ENTRIES = ['cli/run-one.ts', 'cli/run.ts', 'apps/runner/main.ts'];
// A relative module specifier in a static import or re-export that is not `type`-only, a
// dynamic import() or a side-effect import.
const RELATIVE_IMPORT = /\b(?:import|export)\s+(?!type\b)[^;'"]*?\bfrom\s*['"](\.{1,2}\/[^'"]+)['"]|\bimport\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g;
// Block comments, and line comments that start a line or follow whitespace (not the // of a URL).
const COMMENTS = /\/\*[\s\S]*?\*\/|(^|\s)\/\/.*$/gm;
const RUNNER_CHECK = ['runner-check', '--mock', '--json'];
const NOT_BUILT = 127;

const root = process.cwd();
const isTest = process.env.NODE_ENV === 'test';

type Verdict = { pass: boolean; evidence: string };
type CliResult = { exit: number | null; json: unknown };

const cliCache = new Map<string, CliResult>();

function cli(args: string[]): CliResult {
  const key = args.join(' ');
  const cached = cliCache.get(key);
  if (cached) return cached;
  const override = isTest ? process.env.DONEWHEN_CLI : undefined;
  const [cmd, ...prefix] = override ? override.split(' ') : [process.execPath, join(root, 'cli/index.ts')];
  const r = spawnSync(cmd!, [...prefix, ...args], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 });
  let json: unknown;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    json = undefined;
  }
  const result = { exit: r.status, json };
  cliCache.set(key, result);
  return result;
}

function describeExit(name: string, r: CliResult): string {
  if (r.exit === NOT_BUILT) return `${name}: command not built`;
  return `${name}: exit ${r.exit}${r.json === undefined ? ', no JSON output' : ''}`;
}

function read(rel: string): string {
  const path = join(root, rel);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function walk(rel: string): string[] {
  const dir = join(root, rel);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name));
}

const yesNo = (b: boolean) => (b ? 'yes' : 'no');

function clause1(): Verdict {
  const readme = read('README.md');
  const url = readme.includes(HOSTED_URL);
  const command = readme.includes(LOCAL_START_COMMAND);
  const r = cli(RUNNER_CHECK);
  return {
    pass: url && command && r.exit === 0,
    evidence: `README names LOCAL_START_COMMAND: ${yesNo(command)}, hosted URL: ${yesNo(url)}; ${describeExit('runner-check --mock', r)}`,
  };
}

// Whether `rel` reaches packages/core/run.ts through relative imports (itself included).
function reachesCoreRun(rel: string): boolean {
  const target = join(root, CORE_RUN);
  const seen = new Set<string>();
  const todo = [join(root, rel)];
  while (todo.length > 0) {
    const file = todo.pop() as string;
    if (file === target) return existsSync(file);
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    for (const m of readFileSync(file, 'utf8').replace(COMMENTS, '$1').matchAll(RELATIVE_IMPORT)) {
      const next = resolve(dirname(file), (m[1] ?? m[2]) as string);
      if (/\.tsx?$/.test(next)) todo.push(next);
    }
  }
  return false;
}

function clause2(): Verdict {
  const entries = RUN_ENTRIES.map((rel) => [rel, reachesCoreRun(rel)] as const);
  const workers = walk('apps/web/src').filter((f) => /worker[^/]*\.tsx?$/i.test(f)).map((f) => f.slice(root.length + 1));
  const worker = workers.some(reachesCoreRun);
  const r = cli(RUNNER_CHECK);
  const equal = (r.json as { events_equal?: unknown } | undefined)?.events_equal === true;
  return {
    pass: existsSync(join(root, CORE_RUN)) && entries.every(([, ok]) => ok) && worker && equal,
    evidence: `${[...entries.map(([rel, ok]) => `${rel}: ${yesNo(ok)}`), `apps/web/src worker: ${yesNo(worker)}`].join(', ')} reach ${CORE_RUN}; runner-check events equal run-one: ${r.exit === NOT_BUILT ? 'command not built' : yesNo(equal)}`,
  };
}

function hasRubric(taskDir: string): boolean {
  if (/^\s*\[\[?rubric\b/m.test(read(`${taskDir}/task.toml`))) return true;
  return walk(taskDir).some((f) => /(^|\/)rubric\.[^/]+$/.test(f));
}

function clause3(): Verdict {
  const min = isTest && process.env.DONEWHEN_MIN_TASKS ? Number(process.env.DONEWHEN_MIN_TASKS) : MIN_TASKS;
  const underscore = isTest && process.env.DONEWHEN_INCLUDE_UNDERSCORE === '1';
  const tasksDir = join(root, 'tasks');
  const ids = existsSync(tasksDir)
    ? readdirSync(tasksDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && (underscore || !e.name.startsWith('_')) && !e.name.startsWith('.'))
        .map((e) => e.name)
        .sort()
    : [];
  if (ids.length < min) return { pass: false, evidence: `${ids.length} task(s), need ${min}` };
  const gaps: string[] = [];
  for (const id of ids) {
    const missing = TASK_FILES.filter((f) => !existsSync(join(tasksDir, id, f)));
    if (!hasRubric(`tasks/${id}`)) missing.push('rubric');
    if (missing.length) gaps.push(`${id} lacks ${missing.join(', ')}`);
  }
  if (gaps.length) return { pass: false, evidence: `${ids.length} task(s); ${gaps.join('; ')}` };
  const r = cli(['oracle', '--task', 'all', '--json']);
  const scores = new Map(
    ((r.json as { tasks?: Array<{ id: string; score: number }> } | undefined)?.tasks ?? []).map((t) => [t.id, t.score]),
  );
  const below = ids.filter((id) => scores.get(id) !== 1);
  const pass = r.exit === 0 && below.length === 0;
  const detail = r.exit === NOT_BUILT || r.json === undefined ? '' : `, ${ids.length - below.length}/${ids.length} at 1.0`;
  return {
    pass,
    evidence: `${ids.length} complete task(s); ${describeExit('oracle', r)}${detail}${below.length && detail ? ` (not 1.0: ${below.join(', ')})` : ''}`,
  };
}

const summaryArgs = [
  'summary',
  FINAL_RUN,
  '--require',
  `trials=10,pass-min=2,pass-max=7,model=${MODEL}`,
  '--json',
];

function clause4(): Verdict {
  const r = cli(summaryArgs);
  const hashes = (r.json as { initial_state_hashes?: unknown } | undefined)?.initial_state_hashes;
  if (!Array.isArray(hashes)) return { pass: false, evidence: `${describeExit('summary', r)}, no initial_state_hashes` };
  return {
    pass: hashes.length === 1,
    evidence: `summary: ${hashes.length} distinct initial state hash(es) across trials`,
  };
}

function clause5(): Verdict {
  const r = cli(summaryArgs);
  const tasks = (r.json as { tasks?: Record<string, { passes: number; trials: number }> } | undefined)?.tasks;
  const rates = tasks ? Object.entries(tasks).map(([id, t]) => `${id} ${t.passes}/${t.trials}`).join(', ') : '';
  return { pass: r.exit === 0, evidence: `${describeExit('summary', r)}${rates ? `; ${rates}` : ''}` };
}

function clause6(): Verdict {
  const r = cli(['audit-check', FINAL_RUN, '--json']);
  const j = r.json as { failures?: number; labelled?: number; environment?: number; grader?: number } | undefined;
  const counts =
    j && typeof j.failures === 'number'
      ? `; labelled ${j.labelled}/${j.failures} failures, environment ${j.environment}, grader ${j.grader}`
      : '';
  return { pass: r.exit === 0, evidence: `${describeExit('audit-check', r)}${counts}` };
}

function clause7(): Verdict {
  const readme = read('README.md');
  const missing = README_SECTIONS.filter((s) => !new RegExp(`^#{1,6}\\s+.*\\b${s}\\b`, 'im').test(readme));
  const refs = /^(#{1,6})\s+.*\b(references|sources|bibliography)\b.*$/im.exec(readme);
  let dated = 0;
  if (refs) {
    const after = readme.slice(refs.index + refs[0].length);
    const next = new RegExp(`^#{1,${refs[1]!.length}}\\s`, 'm').exec(after);
    const body = next ? after.slice(0, next.index) : after;
    dated = body.split('\n').filter((l) => /\b(19|20)\d{2}-\d{2}(-\d{2})?\b/.test(l)).length;
  }
  const parts = [
    missing.length ? `missing section(s): ${missing.join(', ')}` : 'all writeup sections present',
    refs ? `${dated} dated reference line(s)` : 'no references section',
  ];
  return { pass: missing.length === 0 && dated > 0, evidence: `README: ${parts.join('; ')}` };
}

const CLAUSES: Array<[string, () => Verdict]> = [
  ['UI starts from one command (local runner) and the hosted URL', clause1],
  ['CLI, local runner and Worker share run()', clause2],
  ['>= 5 complete tasks, oracle scores 1.0', clause3],
  ['every trial starts from the same state hash', clause4],
  ['10 trials per task, pass rate 2/10 to 7/10', clause5],
  ['every failure attributed, none to environment or grader', clause6],
  ['README writeup and dated references', clause7],
];

let passed = 0;
CLAUSES.forEach(([name, check], i) => {
  let v: Verdict;
  try {
    v = check();
  } catch (err) {
    v = { pass: false, evidence: `error: ${(err as Error).message}` };
  }
  if (v.pass) passed++;
  process.stdout.write(`${v.pass ? 'PASS' : 'FAIL'} (${i + 1}) ${name}: ${v.evidence}\n`);
});

const spend = cli(['spend', '--json']);
const total = (spend.json as { total_usd?: number } | undefined)?.total_usd;
process.stdout.write(`INFO spend: ${typeof total === 'number' ? `$${total.toFixed(2)} recorded` : describeExit('spend', spend)}\n`);
process.stdout.write(`donewhen: ${passed}/${CLAUSES.length} PASS\n`);
process.exit(passed === CLAUSES.length ? 0 : 1);
