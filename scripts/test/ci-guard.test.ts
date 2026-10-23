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
    // The runner resolves expression named values case-insensitively.
    ['an upper-case SECRETS reference', '      - run: echo ${{ SECRETS.ANTHROPIC_API_KEY }}\n'],
    ['a mixed-case Vars reference', '        env:\n          K: ${{ Vars.KEY }}\n'],
    // Playwright lowercases --project values and treats * as a wildcard.
    ['--project=*', '      - run: pnpm exec playwright test --project=mocked --project=*\n'],
    ['--project=*ive', '      - run: pnpm exec playwright test --project=mocked --project=*ive\n'],
    ["--project '*'", "      - run: pnpm exec playwright test --project '*'\n"],
    ['--project "*"', '      - run: pnpm exec playwright test --project="*"\n'],
    ['a quoted project name', '      - run: pnpm exec playwright test --project="mocked"\n'],
    ['an upper-case LIVE project', '      - run: pnpm exec playwright test --project=LIVE\n'],
  ])('fails on %s and names file:line', (_name, line) => {
    const r = guard(CLEAN + line);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/ci\.yml:\d+:/);
  });

  it('accepts an allowed project in another case, since Playwright lowercases it', () => {
    expect(guard(CLEAN + '      - run: pnpm exec playwright test --project=Mocked\n').status).toBe(0);
  });
});

describe('ci-guard workflow permissions', () => {
  const PAGES = `name: pages
on: push
permissions:
  contents: read
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm build
  deploy:
    needs: build
    runs-on: ubuntu-latest
    permissions:
      pages: write
      id-token: write
    steps:
      - uses: actions/deploy-pages@v4
`;

  it('passes when only the deploy-pages job holds pages and id-token write', () => {
    expect(guard(PAGES).status).toBe(0);
  });

  it.each([
    ['pages: write at workflow level', PAGES.replace('  contents: read\n', '  contents: read\n  pages: write\n')],
    ['id-token: write at workflow level', PAGES.replace('  contents: read\n', '  contents: read\n  id-token: write\n')],
    [
      'pages: write in a job that does not deploy',
      PAGES.replace('  build:\n    runs-on: ubuntu-latest\n', '  build:\n    runs-on: ubuntu-latest\n    permissions:\n      pages: write\n'),
    ],
    ['write-all', PAGES.replace('  contents: read\n', '  contents: read\n').replace('permissions:\n  contents: read', 'permissions: write-all')],
  ])('fails on %s', (_name, workflow) => {
    const r = guard(workflow);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/ci\.yml:\d+:/);
  });
});
