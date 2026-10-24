// Task discovery through the injected TaskSource (plan phase P7): tasks are found by globbing
// tasks/*/task.toml, `all` skips _-prefixed directories outside test mode, an explicit id
// such as _toy always resolves, and there is no registry file.
import { describe, expect, it } from 'vitest';
import { tempDir, write } from '../../../scripts/test/helpers.ts';
import { nodeTaskSource } from '../../../cli/adapters/tasks-node.ts';
import { parseTask, taskSource, taskVersions, type TaskFiles } from '../tasks.ts';

const toml = (id: string) => `[task]\nid = "${id}"\ntitle = "Task ${id}"\nmax_turns = 12\n`;

function fixtureRoot(): string {
  const root = tempDir('tasks');
  for (const id of ['_toy', 'a', 'b']) {
    write(root, `${id}/task.toml`, toml(id));
    write(root, `${id}/instruction.md`, `Do ${id}.\n`);
  }
  write(root, 'notask/instruction.md', 'no task.toml here\n');
  return root;
}

describe('TaskSource over tasks/*/task.toml', () => {
  it('all() returns [a, b] outside test mode and [_toy, a, b] in test mode', async () => {
    const root = fixtureRoot();
    expect((await nodeTaskSource({ root, testMode: false }).all()).map((t) => t.id)).toEqual(['a', 'b']);
    expect((await nodeTaskSource({ root, testMode: true }).all()).map((t) => t.id)).toEqual(['_toy', 'a', 'b']);
  });

  it('an explicit _toy resolves outside test mode; an unknown id names the tasks', async () => {
    const source = nodeTaskSource({ root: fixtureRoot(), testMode: false });
    const toy = await source.get('_toy');
    expect(toy).toMatchObject({ id: '_toy', title: 'Task _toy', maxTurns: 12, instruction: 'Do _toy.\n' });
    await expect(source.get('nope')).rejects.toThrow(/no task 'nope'.*_toy, a, b/);
    await expect(source.get('notask')).rejects.toThrow(/no task 'notask'/);
  });

  it('the committed tasks/_toy resolves from the repo by default', async () => {
    const toy = await nodeTaskSource({ testMode: false }).get('_toy');
    expect(toy.id).toBe('_toy');
    expect(toy.tools).not.toBeNull();
    expect(toy.instruction.length).toBeGreaterThan(20);
  });

  it('parseTask reads [judge] effort: low, medium or high, default medium', async () => {
    const files = { 'instruction.md': 'Do it.\n' };
    expect((await parseTask({ id: 'a', files: { ...files, 'task.toml': toml('a') } })).judgeEffort).toBe('medium');
    expect((await parseTask({ id: 'a', files: { ...files, 'task.toml': `${toml('a')}[judge]\neffort = "high"\n` } })).judgeEffort).toBe('high');
    await expect(parseTask({ id: 'a', files: { ...files, 'task.toml': `${toml('a')}[judge]\neffort = "max"\n` } })).rejects.toThrow(/effort must be one of low, medium, high/);
  });

  it('parseTask checks the id and the fields; task_version covers the files and the world hash', async () => {
    const taskVersion = async (t: Awaited<ReturnType<typeof parseTask>>, world: string) => (await taskVersions(t, world)).task_version;
    const files = { 'task.toml': toml('a'), 'instruction.md': 'Do a.\n' };
    const a = await parseTask({ id: 'a', files });
    await expect(parseTask({ id: 'b', files })).rejects.toThrow(/id "a" .* directory b/);
    await expect(parseTask({ id: 'a', files: { 'task.toml': toml('a') } })).rejects.toThrow(/instruction\.md/);
    await expect(parseTask({ id: 'a', files: { ...files, 'task.toml': `${toml('a')}max_turns = 0\n` } })).rejects.toThrow();
    const edited = await parseTask({ id: 'a', files: { ...files, 'instruction.md': 'Do a!\n' } });
    expect(await taskVersion(a, 'h1')).not.toBe(await taskVersion(edited, 'h1'));
    expect(await taskVersion(a, 'h1')).not.toBe(await taskVersion(a, 'h2'));
    expect(await taskVersion(a, 'h1')).toBe(await taskVersion(await parseTask({ id: 'a', files: { 'instruction.md': 'Do a.\n', 'task.toml': toml('a') } }), 'h1'));
  });

  it('env_version covers what the agent sees and the world; grader_task_version covers every other file', async () => {
    const files = { 'task.toml': toml('a'), 'instruction.md': 'Do a.\n', 'policy/p.md': 'P\n', 'overlay.ts': 'o', 'tests/grader.ts': 'g', 'expected.ts': 'e', 'policy.ts': 'd', 'solution/solve.ts': 's', 'x.test.ts': 't' };
    const base = await taskVersions(await parseTask({ id: 'a', files }), 'h1');
    const changed = async (path: keyof typeof files, world = 'h1') => taskVersions(await parseTask({ id: 'a', files: { ...files, [path]: `${files[path]}\n` } }), world);
    for (const p of ['task.toml', 'instruction.md', 'policy/p.md', 'overlay.ts'] as const) {
      const v = await changed(p);
      expect([p, v.env_version !== base.env_version, v.grader_task_version === base.grader_task_version, v.task_version !== base.task_version]).toEqual([p, true, true, true]);
    }
    for (const p of ['tests/grader.ts', 'expected.ts', 'policy.ts', 'solution/solve.ts', 'x.test.ts'] as const) {
      const v = await changed(p);
      expect([p, v.env_version === base.env_version, v.grader_task_version !== base.grader_task_version, v.task_version !== base.task_version]).toEqual([p, true, true, true]);
    }
    const world = await taskVersions(await parseTask({ id: 'a', files }), 'h2');
    expect([world.env_version !== base.env_version, world.grader_task_version === base.grader_task_version]).toEqual([true, true]);
  });
});

describe('a TaskSource reads its task directories once', () => {
  // A run of many trials (the matrix, a batch) resolves the task for each one; a file that
  // changes under tasks/<id>/ mid-run must not give two trials of one run two task versions.
  it('get() and all() return the files as first read, whatever list() returns later', async () => {
    let reads = 0;
    const list = async (): Promise<TaskFiles[]> => {
      reads++;
      return [{ id: 'a', files: { 'task.toml': toml('a'), 'instruction.md': `Do a, read ${reads}.\n` } }];
    };
    const source = taskSource(list, { testMode: false });
    const first = await source.get('a');
    const again = await source.get('a');
    const [listed] = await source.all();
    expect(again.instruction).toBe(first.instruction);
    expect(again.filesHash).toBe(first.filesHash);
    expect(listed!.filesHash).toBe(first.filesHash);
    expect(reads).toBe(1);
  });

  it('reads again after a failed read', async () => {
    let reads = 0;
    const source = taskSource(async () => {
      if (++reads === 1) throw new Error('EMFILE');
      return [{ id: 'a', files: { 'task.toml': toml('a'), 'instruction.md': 'Do a.\n' } }];
    }, { testMode: false });
    await expect(source.get('a')).rejects.toThrow('EMFILE');
    expect((await source.get('a')).id).toBe('a');
  });
});
