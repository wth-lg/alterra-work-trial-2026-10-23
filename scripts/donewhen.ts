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
//
// Test hooks, honored only when NODE_ENV=test: DONEWHEN_CLI replaces `node cli/index.ts`
// (space-separated command prefix); DONEWHEN_MIN_TASKS replaces the minimum of 5 tasks.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const FINAL_RUN = 'results/runs/final-1';
const MODEL = 'claude-opus-5-5';
const HOSTED_URL = 'https://wth-lg.github.io/clinical-agent-env/';
const MIN_TASKS = 5;
const TASK_FILES = ['instruction.md', 'task.toml', 'tests/grader.ts', 'solution/solve.ts'];
const README_SECTIONS = ['findings', 'surprises', 'changes', 'next steps'];
const CORE_RUN_IMPORT = /packages\/core\/run|@riverbend\/core(\/run)?['"]/;
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
  const dev = /\bpnpm dev\b/.test(readme);
  const shell = existsSync(join(root, 'apps/web/index.html'));
  return {
    pass: (url || dev) && shell,
    evidence: `README names hosted URL: ${yesNo(url)}, pnpm dev: ${yesNo(dev)}; apps/web/index.html: ${yesNo(shell)}`,
  };
}

function clause2(): Verdict {
  const cliRun = read('cli/run.ts');
  const coreRun = existsSync(join(root, 'packages/core/run.ts'));
  const cliUses = CORE_RUN_IMPORT.test(cliRun);
  const uiUses = walk('apps/web/src').some((f) => /\.tsx?$/.test(f) && CORE_RUN_IMPORT.test(readFileSync(f, 'utf8')));
  return {
    pass: coreRun && cliUses && uiUses,
    evidence: `packages/core/run.ts: ${yesNo(coreRun)}; cli/run.ts imports it: ${yesNo(cliUses)}; apps/web/src imports it: ${yesNo(uiUses)}`,
  };
}

function hasRubric(taskDir: string): boolean {
  if (/^\s*\[\[?rubric\b/m.test(read(`${taskDir}/task.toml`))) return true;
  return walk(taskDir).some((f) => /(^|\/)rubric\.[^/]+$/.test(f));
}

function clause3(): Verdict {
  const min = isTest && process.env.DONEWHEN_MIN_TASKS ? Number(process.env.DONEWHEN_MIN_TASKS) : MIN_TASKS;
  const tasksDir = join(root, 'tasks');
  const ids = existsSync(tasksDir)
    ? readdirSync(tasksDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.'))
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
  ['UI starts from one command or URL', clause1],
  ['CLI run() shares the UI code path', clause2],
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
