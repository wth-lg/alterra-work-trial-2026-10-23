import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Built at runtime so no key-shaped literal is ever committed.
export function fakeKey(fill = 'A'): string {
  return ['sk', 'ant', 'api03', fill.repeat(40)].join('-');
}

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

export function write(root: string, rel: string, content: string | Uint8Array): void {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

export function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

export function tempRepo(): string {
  const dir = tempDir('keyscan-repo');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  write(dir, 'README.md', 'hello\n');
  write(dir, '.gitignore', 'dist/\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

export function commitFile(repo: string, rel: string, content: string | Uint8Array, message = `edit ${rel}`): string {
  write(repo, rel, content);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

export function runScript(
  script: string,
  args: string[],
  opts: { cwd: string; env?: Record<string, string | undefined> },
): SpawnSyncReturns<string> {
  const env: Record<string, string | undefined> = { ...process.env, ANTHROPIC_API_KEY: undefined, ...opts.env };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  return spawnSync(process.execPath, [join(repoRoot, script), ...args], { cwd: opts.cwd, env, encoding: 'utf8' });
}
