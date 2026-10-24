// scripts/check-node.mjs, which `pnpm start` runs before it installs anything: it reads the
// minimum Node version from engines.node in the package.json of the directory it runs in and
// exits 1 with a plain message naming the version needed and the version found.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot, tempDir } from './test/helpers.ts';

function checkNode(engines: unknown) {
  const dir = tempDir('check-node');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', engines }));
  return spawnSync(process.execPath, [join(repoRoot, 'scripts/check-node.mjs')], { cwd: dir, encoding: 'utf8' });
}

describe('check-node', () => {
  it('passes silently on the repo itself', () => {
    const r = spawnSync(process.execPath, [join(repoRoot, 'scripts/check-node.mjs')], { cwd: repoRoot, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout + r.stderr).toBe('');
  });

  it('exits 1 naming the version needed and the version found when Node is too old', () => {
    const r = checkNode({ node: '>=99.1' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`needs Node 99.1 or newer; this is Node ${process.versions.node}`);
    expect(r.stderr).toMatch(/nodejs\.org/);
  });

  it('compares numerically, not as text', () => {
    const [major, minor] = process.versions.node.split('.').map(Number) as [number, number];
    expect(checkNode({ node: `>=${major}.${minor}` }).status).toBe(0);
    expect(checkNode({ node: `>=${major - 1}.${minor + 10}` }).status).toBe(0);
    expect(checkNode({ node: `>=${major}.${minor + 1}` }).status).toBe(1);
    expect(checkNode({ node: `>=${major + 1}` }).status).toBe(1);
  });

  it('exits 1 when engines.node is missing or not of the form >=X.Y', () => {
    expect(checkNode(undefined).status).toBe(1);
    expect(checkNode({ node: '^22' }).status).toBe(1);
  });

  it('runs first in pnpm start', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { scripts: { start: string } };
    expect(pkg.scripts.start.startsWith('node scripts/check-node.mjs && ')).toBe(true);
  });
});
