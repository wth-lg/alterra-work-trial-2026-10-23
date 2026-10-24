// pnpm cli matrix --task all: every task directory with tests runs through the matrix, a
// per-task summary is printed, and the exit code is 1 when any task fails. The tasks here are
// the toy task listed under other ids, each narrowed to its oracle, so the test stays offline
// and fast.
import { describe, expect, it } from 'vitest';
import { installEgressGuard } from '../../packages/core/egress.ts';
import { gate } from '../../packages/grader/check.ts';
import type { MatrixOptions } from '../../packages/grader/matrix/matrix.ts';
import type { MatrixTask } from '../../packages/grader/matrix/types.ts';
import { loadMatrixTask, main, matrixTaskIds } from '../matrix.ts';

installEgressGuard(globalThis);

const TOY = await loadMatrixTask('_toy');
const ONE: MatrixOptions = { trials: 1, regrades: 1, isolation: false, cases: ['oracle'] };
const boom = gate({ id: 'boom', category: 'process', traces_to: 'instruction.md:1', decisive_ids: [], fn: () => { throw new Error('planted'); } });

async function all(tasks: Record<string, Partial<MatrixTask>>) {
  const lines: string[] = [];
  const code = await main(['--task', 'all'], {
    env: process.env,
    out: (l) => lines.push(l),
    tasks: () => Object.keys(tasks),
    load: async (id) => ({ ...TOY, ...tasks[id] }),
    options: ONE,
  });
  return { code, text: lines.join('\n') };
}

describe('matrix --task all', () => {
  it('lists every task directory that has tests, the toy task and T1 included', () => {
    const ids = matrixTaskIds();
    expect(ids).toContain('_toy');
    expect(ids).toContain('renal-dose-review');
    expect(ids).toEqual([...ids].sort());
  });

  it('exits 0 when every task passes and prints one summary line per task', async () => {
    const { code, text } = await all({ a: {}, b: {} });
    expect(code).toBe(0);
    expect(text).toMatch(/^matrix all: 2 tasks, 2 PASS, 0 FAIL$/m);
    expect(text).toMatch(/^ {2}a: PASS$/m);
    expect(text).toMatch(/^ {2}b: PASS$/m);
  });

  it('exits 1 and names the task when one task fails, and still runs the others', async () => {
    const { code, text } = await all({ a: { checks: [...TOY.checks, boom] }, b: {} });
    expect(code).toBe(1);
    expect(text).toMatch(/^matrix all: 2 tasks, 1 PASS, 1 FAIL$/m);
    expect(text).toMatch(/^ {2}a: FAIL$/m);
    expect(text).toMatch(/^ {2}b: PASS$/m);
    expect(text).toMatch(/GRADER_ERROR in boom/);
  });

  it('counts a task that cannot be loaded as a failure', async () => {
    const lines: string[] = [];
    const code = await main(['--task', 'all'], {
      env: process.env,
      out: (l) => lines.push(l),
      tasks: () => ['broken'],
      load: async () => { throw new Error('no task.toml'); },
      options: ONE,
    });
    expect(code).toBe(1);
    expect(lines.join('\n')).toMatch(/^ {2}broken: FAIL \(usage: --task: no task\.toml\)$/m);
  });
});

// CI's matrix job fans out over this list, one job per task, so a new task needs no CI edit.
describe('matrix --list-tasks', () => {
  async function list(tasks: string[]) {
    const lines: string[] = [];
    const code = await main(['--list-tasks'], { env: process.env, out: (l) => lines.push(l), tasks: () => tasks });
    return { code, lines };
  }

  it('prints the ids --task all runs as one line of JSON', async () => {
    expect(await list(['_toy', 'b'])).toEqual({ code: 0, lines: ['["_toy","b"]'] });
    const lines: string[] = [];
    expect(await main(['--list-tasks'], { env: process.env, out: (l) => lines.push(l) })).toBe(0);
    expect(lines.map((l) => JSON.parse(l) as string[])).toEqual([matrixTaskIds()]);
  });

  it('exits 1 when there is no task, so CI never runs an empty matrix', async () => {
    expect(await list([])).toEqual({ code: 1, lines: ['matrix: no task directory has tests/'] });
  });

  it('takes no other argument', async () => {
    expect(await main(['--list-tasks', 'x'], { env: process.env, out: () => {} })).toBe(2);
  });
});
