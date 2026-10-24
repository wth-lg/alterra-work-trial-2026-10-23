import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { git, repoRoot, tempRepo, write } from './helpers.ts';

// The public repo names no company and does not say what it was built for. The words are built at
// runtime so this file never matches itself. The lockfile is pnpm's to write, not ours.
const FORBIDDEN = new RegExp([['al', 'terra'].join(''), ['char', 'tr'].join(''), ['work', 'trial'].join('[-_ ]?')].join('|'), 'i');
const SKIP = new Set(['pnpm-lock.yaml']);

// Tracked files plus untracked ones git does not ignore, so a file planted before `git add` counts.
function listed(root: string): string[] {
  const r = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ls-files failed: ${r.stderr}`);
  return [...new Set(r.stdout.split('\0').filter(Boolean))];
}

function companyNameHits(root: string): string[] {
  const hits: string[] = [];
  for (const rel of listed(root)) {
    if (SKIP.has(rel)) continue;
    if (FORBIDDEN.test(rel)) hits.push(`${rel}: path`);
    const path = join(root, rel);
    if (!existsSync(path) || !statSync(path).isFile()) continue;
    const text = readFileSync(path, 'utf8');
    if (text.includes('\0')) continue;
    text.split('\n').forEach((line, i) => {
      const m = FORBIDDEN.exec(line);
      if (m) hits.push(`${rel}:${i + 1}: ${m[0]}`);
    });
  }
  return hits;
}

const temps: string[] = [];
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

function repo(): string {
  const dir = tempRepo();
  temps.push(dir);
  return dir;
}

describe('no company names', () => {
  it('the repo tree has no forbidden name', () => {
    expect(companyNameHits(repoRoot)).toEqual([]);
  });

  it.each([
    ['a committed file', true],
    ['an untracked file', false],
  ])('fails on a planted name in %s and names file:line', (_name, commit) => {
    const dir = repo();
    write(dir, 'src/a.ts', `export const x = 1;\nexport const app = '${['Char', 'tr'].join('')}-runner';\n`);
    if (commit) {
      git(dir, 'add', '-A');
      git(dir, 'commit', '-q', '-m', 'plant');
    }
    expect(companyNameHits(dir)).toEqual([`src/a.ts:2: ${['Char', 'tr'].join('')}`]);
  });

  it.each([
    ['the company', ['AL', 'TERRA'].join('')],
    ['the hyphenated phrase', ['work', 'trial'].join('-')],
    ['the spaced phrase', ['Work', 'Trial'].join(' ')],
  ])('catches %s in any case', (_name, word) => {
    const dir = repo();
    write(dir, 'docs/x.md', `# ${word}\n`);
    expect(companyNameHits(dir)).toEqual([`docs/x.md:1: ${word}`]);
  });

  it('catches a name in a path and skips the lockfile and ignored files', () => {
    const dir = repo();
    const name = ['char', 'tr'].join('');
    write(dir, `${name}/ok.txt`, 'clean\n');
    write(dir, 'pnpm-lock.yaml', `  ${name}: 1\n`);
    write(dir, 'dist/out.js', name);
    expect(companyNameHits(dir)).toEqual([`${name}/ok.txt: path`]);
  });
});
