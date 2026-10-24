import { copyFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot, runScript, tempDir, write } from './helpers.ts';

const FIXTURES = join(repoRoot, 'scripts/fixtures/donewhen');
const ALL_STUBS = { oracle: 'oracle-pass', summary: 'summary-pass', 'audit-check': 'audit-pass', spend: 'spend', 'runner-check': 'runner-check-pass' };

function makeTask(root: string, id: string, omit: string[] = []) {
  const files: Record<string, string> = {
    'instruction.md': 'Do the thing.\n',
    'task.toml': '[task]\nid = "x"\n\n[[rubric]]\nkey = "r1"\n',
    'tests/grader.ts': 'export {};\n',
    'solution/solve.ts': 'export {};\n',
  };
  for (const [rel, content] of Object.entries(files)) if (!omit.includes(rel)) write(root, `tasks/${id}/${rel}`, content);
}

function completeRepo(): string {
  const root = tempDir('donewhen');
  copyFileSync(join(FIXTURES, 'README-pass.md'), join(root, 'README.md'));
  write(root, 'apps/web/index.html', '<!doctype html>\n');
  write(root, 'packages/core/run.ts', 'export function run() {}\n');
  write(root, 'cli/run.ts', "import { runBatch } from '../packages/core/batch.ts';\n");
  write(root, 'packages/core/batch.ts', "import { run } from './run.ts';\nexport const runBatch = run;\n");
  write(root, 'cli/run-one.ts', "import { run } from '../packages/core/run.ts';\n");
  write(root, 'apps/runner/main.ts', "import { startRunner } from './server.ts';\n");
  write(root, 'apps/runner/server.ts', "import {\n  runBatch,\n} from '../../packages/core/batch.ts';\nexport const startRunner = runBatch;\n");
  write(root, 'apps/web/src/worker.ts', "import { run } from '../../../packages/core/run.ts';\n");
  for (const id of ['t1', 't2', 't3', 't4', 't5']) makeTask(root, id);
  makeTask(root, '_template');
  return root;
}

function donewhen(root: string, stubs: Record<string, string>, env: Record<string, string> = {}) {
  const log = join(root, 'stub.log');
  const r = runScript('scripts/donewhen.ts', [], {
    cwd: root,
    env: {
      NODE_ENV: 'test',
      DONEWHEN_CLI: `${process.execPath} ${join(FIXTURES, 'stub-cli.ts')}`,
      DONEWHEN_STUB: JSON.stringify(stubs),
      DONEWHEN_STUB_LOG: log,
      ...env,
    },
  });
  const lines = r.stdout.split('\n');
  const clause = (n: number) => {
    const line = lines.find((l) => new RegExp(`^(PASS|FAIL) \\(${n}\\)`).test(l));
    if (!line) throw new Error(`no line for clause ${n} in:\n${r.stdout}\n${r.stderr}`);
    return line;
  };
  const calls = existsSync(log) ? readFileSync(log, 'utf8') : '';
  return { ...r, clause, calls };
}

describe('donewhen', () => {
  it('passes 7/7 and exits 0 when every clause holds', () => {
    const r = donewhen(completeRepo(), ALL_STUBS);
    for (let n = 1; n <= 7; n++) expect(r.clause(n)).toMatch(/^PASS/);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('INFO spend');
  });

  it('prints 7 FAIL lines, exits 1 and does not crash on an empty repo with no commands built', () => {
    const root = tempDir('donewhen-empty');
    const r = donewhen(root, {});
    for (let n = 1; n <= 7; n++) expect(r.clause(n)).toMatch(/^FAIL/);
    expect(r.stdout.match(/^FAIL /gm)).toHaveLength(7);
    expect(r.stdout).toContain('command not built');
    expect(r.status).toBe(1);
  });

  it('shells out to the CLI commands the plan names', () => {
    const r = donewhen(completeRepo(), ALL_STUBS);
    expect(r.calls).toContain('oracle --task all --json');
    expect(r.calls).toContain('summary results/runs/final-1 --require trials=10,pass-min=2,pass-max=7,model=claude-opus-5-5 --json');
    expect(r.calls).toContain('audit-check results/runs/final-1 --json');
    expect(r.calls).toContain('spend --json');
    expect(r.calls).toContain('runner-check --mock --json');
  });

  it('clause 1 fails when README documents no start command or URL', () => {
    const root = completeRepo();
    write(root, 'README.md', '# Riverbend\n');
    expect(donewhen(root, ALL_STUBS).clause(1)).toMatch(/^FAIL/);
  });

  it('clause 1 fails when runner-check --mock exits 1, passes with it and the README, and fails without LOCAL_START_COMMAND', () => {
    expect(donewhen(completeRepo(), ALL_STUBS).clause(1)).toMatch(/^PASS/);
    const failed = donewhen(completeRepo(), { ...ALL_STUBS, 'runner-check': 'runner-check-fail' }).clause(1);
    expect(failed).toMatch(/^FAIL/);
    expect(failed).toContain('runner-check --mock: exit 1');
    const root = completeRepo();
    write(root, 'README.md', readFileSync(join(FIXTURES, 'README-pass.md'), 'utf8').replace(/`git clone[^`]*pnpm start`/, '`pnpm start`'));
    const line = donewhen(root, ALL_STUBS).clause(1);
    expect(line).toMatch(/^FAIL/);
    expect(line).toContain('LOCAL_START_COMMAND: no');
  });

  it('clause 1 fails with command not built when runner-check is missing', () => {
    const { 'runner-check': _r, ...rest } = ALL_STUBS;
    const line = donewhen(completeRepo(), rest).clause(1);
    expect(line).toMatch(/^FAIL/);
    expect(line).toContain('command not built');
  });

  it('clause 2 fails when the runner\'s events differ from run-one\'s', () => {
    const line = donewhen(completeRepo(), { ...ALL_STUBS, 'runner-check': 'runner-check-differ' }).clause(2);
    expect(line).toMatch(/^FAIL/);
    expect(line).toContain('events equal run-one: no');
  });

  it.each(['cli/run-one.ts', 'apps/runner/main.ts', 'apps/runner/server.ts', 'packages/core/batch.ts'])('clause 2 fails when %s is missing from the import path', (rel) => {
    const root = completeRepo();
    rmSync(join(root, rel));
    expect(donewhen(root, ALL_STUBS).clause(2)).toMatch(/^FAIL/);
  });

  it('clause 2 follows imports only: a comment naming packages/core/run.ts does not count', () => {
    const root = completeRepo();
    write(root, 'apps/runner/main.ts', '// see packages/core/run.ts\nexport {};\n');
    expect(donewhen(root, ALL_STUBS).clause(2)).toMatch(/^FAIL/);
  });

  it.each([
    ['a type-only import', "import type { Run } from '../../packages/core/run.ts';\nexport {};\n"],
    ['an export type', "export type { Run } from '../../packages/core/run.ts';\n"],
    ['a line comment', "// import { run } from '../../packages/core/run.ts';\nexport {};\n"],
    ['a block comment', "/* import { run } from '../../packages/core/run.ts'; */\nexport {};\n"],
  ])('clause 2 counts value imports only: %s of packages/core/run.ts does not count', (_what, text) => {
    const root = completeRepo();
    write(root, 'apps/runner/main.ts', text);
    expect(donewhen(root, ALL_STUBS).clause(2)).toMatch(/^FAIL/);
  });

  it('clause 2 counts a value import, a re-export and a dynamic import', () => {
    for (const text of [
      "import { type Run, run } from '../../packages/core/run.ts';\n",
      "export { run } from '../../packages/core/run.ts';\n",
      "const m = await import('../../packages/core/run.ts');\n",
      "import {\n  run, // the loop\n} from '../../packages/core/run.ts';\n",
    ]) {
      const root = completeRepo();
      write(root, 'apps/runner/main.ts', text);
      expect(donewhen(root, ALL_STUBS).clause(2), text).toMatch(/^PASS/);
    }
  });

  it('runs runner-check --mock once for clauses 1 and 2', () => {
    const r = donewhen(completeRepo(), ALL_STUBS);
    expect(r.calls.split('\n').filter((l) => l === 'runner-check --mock --json')).toHaveLength(1);
  });

  it('clause 2 fails without a CLI run entry point', () => {
    const root = completeRepo();
    rmSync(join(root, 'cli/run.ts'));
    expect(donewhen(root, ALL_STUBS).clause(2)).toMatch(/^FAIL/);
  });

  it('clause 2 fails when the UI does not use packages/core/run.ts', () => {
    const root = completeRepo();
    rmSync(join(root, 'apps/web/src/worker.ts'));
    expect(donewhen(root, ALL_STUBS).clause(2)).toMatch(/^FAIL/);
  });

  it('clause 3 fails with 4 complete non-_ tasks', () => {
    const root = completeRepo();
    rmSync(join(root, 'tasks/t5'), { recursive: true });
    const line = donewhen(root, ALL_STUBS).clause(3);
    expect(line).toMatch(/^FAIL/);
    expect(line).toContain('4 task(s), need 5');
  });

  it('clause 3 fails with 5 tasks when one lacks solve.ts', () => {
    const root = completeRepo();
    rmSync(join(root, 'tasks/t4/solution/solve.ts'));
    const line = donewhen(root, ALL_STUBS).clause(3);
    expect(line).toMatch(/^FAIL/);
    expect(line).toContain('t4');
  });

  it.each(['instruction.md', 'task.toml', 'tests/grader.ts'])('clause 3 fails when a task lacks %s', (rel) => {
    const root = completeRepo();
    rmSync(join(root, 'tasks/t2', rel));
    expect(donewhen(root, ALL_STUBS).clause(3)).toMatch(/^FAIL/);
  });

  it('clause 3 fails when a task has no rubric', () => {
    const root = completeRepo();
    write(root, 'tasks/t2/task.toml', '[task]\nid = "x"\n');
    expect(donewhen(root, ALL_STUBS).clause(3)).toMatch(/^FAIL/);
  });

  it('clause 3 fails when the oracle scores a task below 1.0', () => {
    expect(donewhen(completeRepo(), { ...ALL_STUBS, oracle: 'oracle-fail' }).clause(3)).toMatch(/^FAIL/);
  });

  it('clause 3 fails with command not built when oracle is missing', () => {
    const { oracle: _o, ...rest } = ALL_STUBS;
    const line = donewhen(completeRepo(), rest).clause(3);
    expect(line).toMatch(/^FAIL/);
    expect(line).toContain('command not built');
  });

  it('clause 3 fails on output that is not JSON', () => {
    expect(donewhen(completeRepo(), { ...ALL_STUBS, oracle: 'garbage' }).clause(3)).toMatch(/^FAIL/);
  });

  it('DONEWHEN_MIN_TASKS is honored only when NODE_ENV=test', () => {
    const root = tempDir('donewhen-min');
    makeTask(root, 't1');
    const stubs = { ...ALL_STUBS, oracle: 'oracle-one' };
    expect(donewhen(root, stubs, { DONEWHEN_MIN_TASKS: '1' }).clause(3)).toMatch(/^PASS/);
    const prod = donewhen(root, stubs, { DONEWHEN_MIN_TASKS: '1', NODE_ENV: 'production' }).clause(3);
    expect(prod).toMatch(/^FAIL/);
    expect(prod).toContain('1 task(s), need 5');
  });

  it('clause 4 fails when trials start from more than one state hash', () => {
    const r = donewhen(completeRepo(), { ...ALL_STUBS, summary: 'summary-fail' });
    expect(r.clause(4)).toMatch(/^FAIL/);
  });

  it('clause 5 passes on summary exit 0 and fails on summary exit 1', () => {
    expect(donewhen(completeRepo(), ALL_STUBS).clause(5)).toMatch(/^PASS/);
    expect(donewhen(completeRepo(), { ...ALL_STUBS, summary: 'summary-fail' }).clause(5)).toMatch(/^FAIL/);
  });

  it('clause 6 fails on audit-check exit 1', () => {
    expect(donewhen(completeRepo(), { ...ALL_STUBS, 'audit-check': 'audit-fail' }).clause(6)).toMatch(/^FAIL/);
  });

  it('clause 7 fails on a README without a dated reference', () => {
    const root = completeRepo();
    copyFileSync(join(FIXTURES, 'README-undated.md'), join(root, 'README.md'));
    expect(donewhen(root, ALL_STUBS).clause(7)).toMatch(/^FAIL/);
  });

  it('clause 7 fails on a README missing a writeup section', () => {
    const root = completeRepo();
    copyFileSync(join(FIXTURES, 'README-nosurprises.md'), join(root, 'README.md'));
    const line = donewhen(root, ALL_STUBS).clause(7);
    expect(line).toMatch(/^FAIL/);
    expect(line).toContain('surprises');
  });

  it('ignores DONEWHEN_CLI outside NODE_ENV=test', () => {
    const r = donewhen(completeRepo(), ALL_STUBS, { NODE_ENV: 'production' });
    expect(r.calls).toBe('');
    expect(r.clause(5)).toMatch(/^FAIL/);
  });
});
