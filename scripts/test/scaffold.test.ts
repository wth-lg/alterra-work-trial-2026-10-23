import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './helpers.ts';

function run(cmd: string, args: string[], env: Record<string, string | undefined> = {}) {
  const merged: Record<string, string | undefined> = { ...process.env, ...env };
  for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
  return spawnSync(cmd, args, { cwd: repoRoot, env: merged, encoding: 'utf8' });
}

describe('package.json scripts', () => {
  const scripts: Record<string, string> = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).scripts;

  // Script names later phases' gates run, declared now so only their bodies change later.
  it.each([
    ['live:node', 'P2'],
  ])('declares %s as a placeholder that names %s and exits 1', (name, phase) => {
    expect(Object.keys(scripts)).toContain(name);
    const r = run('pnpm', ['-s', 'run', name]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`not built yet (${phase})`);
  });

  it('declares no placeholder that the plan never uses', () => {
    expect(Object.keys(scripts)).not.toContain('live:cors');
    expect(Object.keys(scripts)).not.toContain('live:smoke');
  });
});

describe('live Playwright project without a key', () => {
  it('lists the live specs instead of reporting no tests', () => {
    const r = run('pnpm', ['--filter', 'web', 'exec', 'playwright', 'test', '--project=live', '--list'], {
      ANTHROPIC_API_KEY: undefined,
    });
    expect(r.stdout + r.stderr).not.toContain('No tests found');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/\[live\] › live\//);
  });
});

describe('static checks', () => {
  it('pnpm typecheck covers the eslint rule tests and the donewhen stub cli', () => {
    const r = run('pnpm', ['exec', 'tsc', '-p', 'tsconfig.json', '--listFilesOnly']);
    expect(r.status).toBe(0);
    const files = r.stdout.split('\n').map((f) => f.trim());
    expect(files).toContain(join(repoRoot, 'eslint-rules/rules.test.ts'));
    expect(files).toContain(join(repoRoot, 'scripts/fixtures/donewhen/stub-cli.ts'));
  });

  // GitHub's ubuntu runners ship shellcheck; locally the check skips when it is not installed.
  const hasShellcheck = run('shellcheck', ['--version']).status === 0;
  it.skipIf(!hasShellcheck && !process.env.CI)('the pre-push hook passes shellcheck', () => {
    const r = run('shellcheck', ['scripts/hooks/pre-push']);
    expect(r.stdout + r.stderr).toBe('');
    expect(r.status).toBe(0);
  });
});
