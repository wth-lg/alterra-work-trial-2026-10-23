// The browser TaskSource: every tasks/*/task.toml, bundled by Vite's import.meta.glob with each
// task directory's files as text. Test mode, in which `all` also returns _-prefixed
// directories, is Vite's test mode.
import { taskSource, type TaskFiles, type TaskSource } from '../../../../packages/core/tasks.ts';

const FILES = import.meta.glob<string>('../../../../tasks/**/*', { query: '?raw', import: 'default', eager: true });

function taskDirs(): TaskFiles[] {
  const dirs = new Map<string, Record<string, string>>();
  for (const [path, text] of Object.entries(FILES)) {
    const m = /\/tasks\/([^/]+)\/(.+)$/.exec(path);
    if (!m) continue;
    const [, id, rel] = m as unknown as [string, string, string];
    if (!dirs.has(id)) dirs.set(id, {});
    dirs.get(id)![rel] = text;
  }
  return [...dirs].map(([id, files]) => ({ id, files }));
}

export function browserTaskSource(opts: { testMode?: boolean } = {}): TaskSource {
  return taskSource(async () => taskDirs(), { testMode: opts.testMode ?? import.meta.env.MODE === 'test' });
}
