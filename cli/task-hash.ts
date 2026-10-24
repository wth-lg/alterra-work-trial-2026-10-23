// pnpm cli task-hash [--task all|<id,...> | all | <id,...>] [--json]
// Prints each task's files hash (sha256 over its files, path and content, in path order) and its
// task_version (sha256 of that hash and the world's state hash, packages/core/tasks.ts), so a
// change of one byte in a task directory, or in the world, is a new version. The tasks are named
// by --task, as matrix, oracle and run name them, or positionally; not both. Default all; an
// explicit _-prefixed id (_toy) resolves too. Exit 0; 1 on an unknown task; 2 on a usage error.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installEgressGuard } from '../packages/core/egress.ts';
import { taskVersion, type TaskSource } from '../packages/core/tasks.ts';
import { nodeTaskSource } from './adapters/tasks-node.ts';
import { REPO } from './run.ts';

export interface Deps {
  out: (line: string) => void;
  err: (line: string) => void;
  tasks?: TaskSource;
}

const defaults: Deps = { out: (l) => process.stdout.write(`${l}\n`), err: (l) => process.stderr.write(`${l}\n`) };
const USAGE = 'usage: pnpm cli task-hash [--task all|<id,...> | all | <id,...>] [--json]';

export async function main(args: string[], deps: Deps = defaults): Promise<number> {
  let json = false;
  const rest: string[] = [];
  let flag: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === '--json') json = true;
    else if (a === '--task' && flag === undefined && args[i + 1] !== undefined && !args[i + 1]!.startsWith('--')) flag = args[++i] as string;
    else if (a.startsWith('--')) {
      deps.err(USAGE);
      return 2;
    } else rest.push(a);
  }
  if (rest.length + (flag === undefined ? 0 : 1) > 1) {
    deps.err(USAGE);
    return 2;
  }
  if (flag !== undefined) rest.push(flag);
  const tasks = deps.tasks ?? nodeTaskSource({ testMode: false });
  const worldHash = (JSON.parse(readFileSync(join(REPO, 'fixtures/manifest.json'), 'utf8')) as { world: { state_hash: string } }).world.state_hash;
  const out: Array<{ id: string; files_hash: string; task_version: string }> = [];
  try {
    const list = rest[0] === undefined || rest[0] === 'all' ? await tasks.all() : await Promise.all(rest[0].split(',').map((id) => tasks.get(id.trim())));
    for (const t of list) out.push({ id: t.id, files_hash: t.filesHash, task_version: await taskVersion(t, worldHash) });
  } catch (e) {
    deps.err(`task-hash: ${(e as Error).message}`);
    return 1;
  }
  if (json) deps.out(JSON.stringify({ world_hash: worldHash, tasks: out }));
  else for (const t of out) deps.out(`${t.id} task_version ${t.task_version} files ${t.files_hash}`);
  return 0;
}

export default (args: string[]) => {
  installEgressGuard(globalThis);
  return main(args);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  installEgressGuard(globalThis);
  process.exitCode = await main(process.argv.slice(2));
}
