import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
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
    ['write-all', PAGES.replace('permissions:\n  contents: read', 'permissions: write-all')],
  ])('fails on %s', (_name, workflow) => {
    const r = guard(workflow);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/ci\.yml:\d+:/);
  });
});

describe('ci-guard reads workflows as YAML and run values as shell words', () => {
  const STEPS = `name: ci
on: pull_request
permissions:
  contents: read
jobs:
  t:
    runs-on: ubuntu-latest
    steps:
`;

  it.each([
    // Playwright declares --project <project-name...> as variadic.
    ['a variadic live project', '      - run: pnpm exec playwright test --project mocked live\n'],
    ['a third variadic project', '      - run: pnpm exec playwright test --project mocked xbrowser LIVE\n'],
    ['a variadic project after an = form', '      - run: pnpm exec playwright test --project=mocked --project xbrowser live\n'],
    ['a folded run with a wildcard on the next line', '      - run: >\n          npx playwright test --project=mocked\n          --project=*ive\n'],
    ['a plain multi-line run with a wildcard', '      - run: npx playwright test --project=mocked\n          --project=*\n'],
    ['a literal run with a continued live project', '      - run: |\n          npx playwright test --project mocked \\\n            live\n'],
    ['a double-quoted run with an escaped wildcard', '      - run: "npx playwright test --project=\\x2a"\n'],
    ['a single-quoted run with a live project', "      - run: 'npx playwright test --project ''live'''\n"],
    ['a --project with no value', '      - run: npx playwright test --project\n'],
    ['a playwright argument read from a variable', '      - run: npx playwright test --project=mocked $EXTRA\n'],
    ['a --project outside a playwright line', '      - run: pnpm e2e --project live\n'],
    ['an escaped secrets reference', '      - run: "echo ${{ \\x73ecrets.X }}"\n'],
    ['a run value that is not valid shell', '      - run: npx playwright test --project="mocked\n'],
  ])('fails on %s', (_name, step) => {
    const r = guard(STEPS + step);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/ci\.yml:\d+:/);
  });

  it.each([
    ['variadic allowed projects', '      - run: npx playwright test --project mocked xbrowser\n'],
    ['a test filter after an = form', '      - run: npx playwright test --project=mocked tests/a.spec.ts\n'],
    ['a redirected run', '      - run: npx playwright test --project=mocked > out.txt 2>&1\n'],
    ['a folded allowed run', '      - run: >\n          npx playwright test\n          --project=mocked --project=xbrowser\n'],
  ])('passes %s', (_name, step) => {
    const r = guard(STEPS + step);
    expect(r.stdout + r.stderr).toContain('ci-guard: ok');
    expect(r.status).toBe(0);
  });

  it('fails on a file that is not valid YAML', () => {
    const r = guard('jobs:\n  t: [\n');
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/ci\.yml:\d+:/);
  });
});

describe('ci-guard permissions after YAML resolution', () => {
  const DEPLOY = `    runs-on: ubuntu-latest
    steps:
      - uses: actions/deploy-pages@v4
`;
  const BUILD = `    runs-on: ubuntu-latest
    steps:
      - run: pnpm build
`;

  it.each([
    ['quoted write values on a build job', `on: push\njobs:\n  b:\n    permissions:\n      pages: 'write'\n      id-token: "write"\n${BUILD}`],
    ['a quoted scope key on a build job', `on: push\njobs:\n  b:\n    permissions:\n      "pages": write\n${BUILD}`],
    ['an upper-case WRITE on a build job', `on: push\njobs:\n  b:\n    permissions:\n      id-token: WRITE\n${BUILD}`],
    [
      'an alias that reuses the deploy grants on a build job',
      `on: push\njobs:\n  d:\n    permissions: &deploy\n      pages: write\n      id-token: write\n${DEPLOY}  b:\n    permissions: *deploy\n${BUILD}`,
    ],
    [
      'a merge key that reuses the deploy grants on a build job',
      `on: push\njobs:\n  d:\n    permissions: &deploy\n      pages: write\n${DEPLOY}  b:\n    permissions:\n      <<: *deploy\n      contents: read\n${BUILD}`,
    ],
    ['a quoted write at workflow level', `on: push\npermissions:\n  pages: "write"\njobs:\n  d:\n${DEPLOY}`],
    ['a quoted write-all on a job', `on: push\njobs:\n  b:\n    permissions: 'write-all'\n${BUILD}`],
  ])('fails on %s', (_name, workflow) => {
    const r = guard(workflow);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/ci\.yml:\d+:/);
  });

  it.each([
    ['quoted grants on the deploy job', `on: push\njobs:\n  d:\n    permissions:\n      'pages': "write"\n      id-token: 'write'\n${DEPLOY}`],
    [
      'deploy grants reached through an alias on the deploy job',
      `on: push\nx-grants: &deploy\n  pages: write\njobs:\n  d:\n    permissions: *deploy\n${DEPLOY}`,
    ],
  ])('passes %s', (_name, workflow) => {
    const r = guard(workflow);
    expect(r.stdout + r.stderr).toContain('ci-guard: ok');
    expect(r.status).toBe(0);
  });
});

// verifier-phase-P2-9 defect 1: ESLint looks up a config from each file's directory, so a
// nested eslint.config.js could turn the P2 rules off for its directory.
describe('nested eslint configs', () => {
  const HOST = ['api', 'anthropic', 'com'].join('.');
  const plant = join('cli', `zz-nested-config-${process.pid}`);
  afterAll(() => rmSync(join(repoRoot, plant), { recursive: true, force: true }));

  it('pnpm lint uses the root config only: a nested config that turns every rule off does not hide a planted send', () => {
    write(repoRoot, join(plant, 'eslint.config.js'), 'export default [{}];\n');
    write(repoRoot, join(plant, 'send.ts'), `export const go = () => fetch('https://${HOST}/v1/messages');\n`);
    const [bin, ...args] = (JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { scripts: { lint: string } }).scripts.lint.split(' ');
    expect(bin).toBe('eslint');
    const r = spawnSync(join(repoRoot, 'node_modules/.bin/eslint'), [...args.filter((a) => a !== '.'), plant], { cwd: repoRoot, encoding: 'utf8' });
    expect(r.stdout).toContain('local/no-direct-anthropic');
    expect(r.status).toBe(1);
  });

  it('ci:guard fails on an eslint.config.* outside the repo root and names it', () => {
    const dir = tempDir('ci-guard-eslint');
    write(dir, '.github/workflows/ci.yml', CLEAN);
    write(dir, 'eslint.config.js', 'export default [];\n');
    write(dir, 'node_modules/pkg/eslint.config.js', 'export default [];\n');
    expect(runScript('scripts/ci-guard.ts', [], { cwd: dir }).status).toBe(0);
    write(dir, 'cli/x/eslint.config.mjs', 'export default [{}];\n');
    const r = runScript('scripts/ci-guard.ts', [], { cwd: dir });
    expect(r.stdout).toContain('cli/x/eslint.config.mjs');
    expect(r.status).toBe(1);
  });
});
