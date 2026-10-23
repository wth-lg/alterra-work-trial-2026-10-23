import { describe, expect, it } from 'vitest';
import { commitFile, fakeKey, git, runScript, tempDir, tempRepo, write } from './helpers.ts';

const keyscan = (cwd: string, args: string[] = [], env: Record<string, string | undefined> = {}) =>
  runScript('scripts/keyscan.ts', args, { cwd, env });

function expectHit(r: ReturnType<typeof keyscan>, location: string, secret: string) {
  expect(r.status).toBe(1);
  expect(r.stdout).toContain(location);
  expect(r.stdout + r.stderr).not.toContain(secret);
}

describe('keyscan working tree and build output', () => {
  it('exits 0 on a clean repo', () => {
    const repo = tempRepo();
    expect(keyscan(repo).status).toBe(0);
  });

  it('flags a key in a tracked file and prints file:line only', () => {
    const repo = tempRepo();
    commitFile(repo, 'notes.txt', `line one\nkey=${fakeKey()}\n`);
    expectHit(keyscan(repo), 'notes.txt:2', fakeKey());
  });

  it('flags a key in an untracked, not ignored file', () => {
    const repo = tempRepo();
    write(repo, 'scratch.ts', `const k = "${fakeKey('B')}";\n`);
    expectHit(keyscan(repo), 'scratch.ts:1', fakeKey('B'));
  });

  it('flags a key in build output even though dist/ is ignored', () => {
    const repo = tempRepo();
    write(repo, 'apps/web/dist/assets/index.js', `a\nb\nconst k="${fakeKey('C')}"\n`);
    expectHit(keyscan(repo), 'apps/web/dist/assets/index.js:3', fakeKey('C'));
  });

  it('flags a named path outside the repo', () => {
    const repo = tempRepo();
    const outside = tempDir('keyscan-outside');
    write(outside, 'log.txt', fakeKey('D'));
    const r = keyscan(repo, [`${outside}/log.txt`]);
    expectHit(r, 'log.txt:1', fakeKey('D'));
  });

  it('flags the exact ANTHROPIC_API_KEY value even when it is not sk-ant-shaped', () => {
    const repo = tempRepo();
    const sentinel = ['SENTINEL', 'not', 'a', 'key', '7f3a9c'].join('_');
    expect(keyscan(repo, [], { ANTHROPIC_API_KEY: sentinel }).status).toBe(0);
    write(repo, 'tmp.txt', `x ${sentinel} y\n`);
    expectHit(keyscan(repo, [], { ANTHROPIC_API_KEY: sentinel }), 'tmp.txt:1', sentinel);
    expect(keyscan(repo).status).toBe(0);
  });
});

describe('keyscan history', () => {
  it('finds a key committed then deleted only with --history', () => {
    const repo = tempRepo();
    git(repo, 'checkout', '-q', '-b', 'scratch');
    const added = commitFile(repo, 'leak.txt', `${fakeKey('E')}\n`);
    commitFile(repo, 'leak.txt', 'gone\n');
    git(repo, 'checkout', '-q', 'main');
    expect(keyscan(repo).status).toBe(0);
    const r = keyscan(repo, ['--history']);
    expectHit(r, `${added.slice(0, 12)}:leak.txt:1`, fakeKey('E'));
  });

  it('finds a key in a commit message', () => {
    const repo = tempRepo();
    commitFile(repo, 'a.txt', 'a\n', `oops ${fakeKey('F')}`);
    const r = keyscan(repo, ['--history']);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('(commit message)');
    expect(r.stdout).not.toContain(fakeKey('F'));
  });

  it('--range scans only the named commits', () => {
    const repo = tempRepo();
    const base = git(repo, 'rev-parse', 'HEAD');
    const leak = commitFile(repo, 'leak.txt', `${fakeKey('G')}\n`);
    commitFile(repo, 'leak.txt', 'gone\n');
    const head = commitFile(repo, 'b.txt', 'b\n');
    expectHit(keyscan(repo, ['--range', `${base}..${head}`]), 'leak.txt:1', fakeKey('G'));
    expect(keyscan(repo, ['--range', `${leak}..${head}`]).status).toBe(0);
    // A bare revision scans everything reachable from it (used by the hook for a new branch).
    expect(keyscan(repo, ['--range', head]).status).toBe(1);
  });

  it('exits 2 on a range git cannot resolve', () => {
    const repo = tempRepo();
    expect(keyscan(repo, ['--range', 'nope..alsonope']).status).toBe(2);
  });
});
