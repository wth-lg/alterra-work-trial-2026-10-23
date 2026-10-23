import { describe, expect, it } from 'vitest';
import { repoRoot, runScript, tempDir, write } from './helpers.ts';

const CLEAN = `name: ci
on: pull_request
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm --filter web exec playwright test --project=mocked --project=xbrowser
      - run: |
          pnpm --filter web exec playwright test \\
            --project=mocked
`;

function guard(workflow: string) {
  const dir = tempDir('ci-guard');
  write(dir, 'ci.yml', workflow);
  return runScript('scripts/ci-guard.ts', [dir], { cwd: repoRoot });
}

describe('ci-guard', () => {
  it('passes the repo workflows', () => {
    const r = runScript('scripts/ci-guard.ts', [], { cwd: repoRoot });
    expect(r.stdout + r.stderr).toContain('ci-guard: ok');
    expect(r.status).toBe(0);
  });

  it('passes a clean workflow, including a continued playwright line', () => {
    expect(guard(CLEAN).status).toBe(0);
  });

  it.each([
    ['a secrets reference', '      - run: echo ${{ secrets.X }}\n'],
    ['secrets: inherit', '    secrets: inherit\n'],
    ['a vars reference', '      - run: echo ${{ vars.X }}\n'],
    ['a live project', '      - run: pnpm exec playwright test --project=live\n'],
    ['a live project with a space', '      - run: pnpm exec playwright test --project live\n'],
    ['a playwright test line with no project', '      - run: pnpm exec playwright test\n'],
    ['a playwright test line with another project', '      - run: npx playwright test --project=mocked --project=chromium\n'],
  ])('fails on %s and names file:line', (_name, line) => {
    const r = guard(CLEAN + line);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/ci\.yml:\d+:/);
  });
});
