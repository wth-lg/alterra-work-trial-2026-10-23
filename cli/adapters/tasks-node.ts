// The Node TaskSource: every tasks/*/task.toml under the repo (or `root`), read with fs. Test
// mode, in which `all` also returns _-prefixed directories, is on under vitest unless the
// caller says otherwise.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { taskSource, type TaskFiles, type TaskSource } from '../../packages/core/tasks.ts';

export const TASKS_DIR = fileURLToPath(new URL('../../tasks/', import.meta.url));

export const isTestMode = (env: Record<string, string | undefined> = process.env): boolean => env.VITEST === 'true' || env.NODE_ENV === 'test';

// Every task directory under root, as TaskFiles.
export function nodeTaskDirs(root: string = TASKS_DIR): TaskFiles[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(root, e.name, 'task.toml')))
    .map((e) => {
      const dir = join(root, e.name);
      const files: Record<string, string> = {};
      for (const f of readdirSync(dir, { recursive: true, withFileTypes: true })) {
        if (!f.isFile()) continue;
        const abs = join(f.parentPath, f.name);
        files[relative(dir, abs).split(sep).join('/')] = readFileSync(abs, 'utf8');
      }
      return { id: e.name, files };
    });
}

export function nodeTaskSource(opts: { root?: string; testMode?: boolean } = {}): TaskSource {
  const root = opts.root ?? TASKS_DIR;
  return taskSource(async () => nodeTaskDirs(root), { testMode: opts.testMode ?? isTestMode() });
}
