// Task discovery through the injected TaskSource (plan phase P7): tasks are found by globbing
// tasks/*/task.toml, `all` skips _-prefixed directories outside test mode, an explicit id
// such as _toy always resolves, and there is no registry file.
import { describe, expect, it } from 'vitest';
import { tempDir, write } from '../../../scripts/test/helpers.ts';
import { nodeTaskSource } from '../../../cli/adapters/tasks-node.ts';
import { parseTask, taskVersion } from '../tasks.ts';

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

  it('parseTask checks the id and the fields; taskVersion covers the files and the world hash', async () => {
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
});
