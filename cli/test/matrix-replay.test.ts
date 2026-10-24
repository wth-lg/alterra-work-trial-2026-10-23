// Replay determinism when the task directory changes during a matrix run. Every trial resolves
// its task through MatrixEnv.tasks, and the record's task_version hashes every file under
// tasks/<id>/ (tests and stray files included). A file added between a case's first and second
// trial, such as a probe test or an edit made while the matrix runs, must not make the second
// run differ: both runs of a case are runs of the task as the matrix found it.
import { cpSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runCases, selectCases, type ReplayDiff } from '../../packages/grader/matrix/matrix.ts';
import { tempDir } from '../../scripts/test/helpers.ts';
import { taskSource } from '../../packages/core/tasks.ts';
import { nodeTaskDirs, TASKS_DIR } from '../adapters/tasks-node.ts';
import { loadMatrixTask, matrixEnv } from '../matrix.ts';

const TOY = fileURLToPath(new URL('../../tasks/_toy', import.meta.url));

describe('matrix replay determinism', () => {
  it('holds when a file appears under the task directory between the two trials of a case', async () => {
    const root = tempDir('matrix-replay');
    cpSync(TOY, join(root, '_toy'), { recursive: true });
    // The scripts and checks import repo modules, so they load from tasks/_toy; the trials
    // resolve the task's files from the copy.
    const task = await loadMatrixTask('_toy');
    const env = matrixEnv(root);
    // The first trial resolves its task, then a file lands in the task directory, before the
    // second trial resolves it.
    let gets = 0;
    const tasks = {
      all: () => env.tasks.all(),
      get: async (id: string) => {
        const t = await env.tasks.get(id);
        if (++gets === 1) writeFileSync(join(root, '_toy', 'probe.test.ts'), '// written while the matrix runs\n');
        return t;
      },
    };
    const mismatches: ReplayDiff[] = [];
    const [r] = await runCases({ ...env, tasks }, task, selectCases(task, ['oracle']), { trials: 2, regrades: 1, isolation: false, onReplayMismatch: (_c, _a, _b, d) => mismatches.push(d) });
    expect(mismatches.map((d) => d.summary)).toEqual([]);
    expect(r!.replay_same).toBe(true);
  });

  it('reads tasks/ once when the task and the env share a source', async () => {
    let reads = 0;
    const tasks = taskSource(async () => (reads++, nodeTaskDirs(TASKS_DIR)), { testMode: true });
    const task = await loadMatrixTask('_toy', TASKS_DIR, tasks);
    const env = matrixEnv(TASKS_DIR, tasks);
    const [r] = await runCases(env, task, selectCases(task, ['oracle']), { trials: 2, regrades: 1, isolation: false });
    expect(r!.replay_same).toBe(true);
    expect((await env.tasks.get('_toy')).instruction).toBe(task.instruction);
    expect(reads).toBe(1);
  });
});
