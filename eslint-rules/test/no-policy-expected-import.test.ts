import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { policyImports } from '../../cli/matrix.ts';
import { tempDir, write } from '../../scripts/test/helpers.ts';

// Lints code through the real eslint.config.js as if it lived at a repo path, so these tests
// cover the rule and its file scope together.
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const eslint = new ESLint({ cwd: root });
async function lint(code: string, path: string) {
  const [result] = await eslint.lintText(code, { filePath: join(root, path) });
  return result?.messages ?? [];
}
const ruleIds = async (code: string, path: string) => (await lint(code, path)).map((m) => m.ruleId ?? `fatal: ${m.message}`);

const RULE = 'local/no-policy-expected-import';
const POLICY = 'tasks/t9/policy.ts';

describe('no-policy-expected-import', () => {
  it.each([
    "import { expected } from './expected.ts'; export const derive = () => expected;",
    "import { expected } from './expected'; export const derive = () => expected;",
    "import * as E from './expected.ts'; export const derive = () => E;",
    "export { expected } from './expected.ts';",
    "export * from './expected.ts';",
    "export const derive = async () => (await import('./expected.ts')).expected;",
    "import { PATIENT } from './overlay.ts'; export const derive = () => PATIENT;",
    "import { OVERLAY } from '../../packages/env/overlay.ts'; export const derive = () => OVERLAY;",
    "import { expected } from './expected.ts#h'; export const derive = () => expected;",
    "const name = 'expected'; export const derive = async () => (await import(`./${name}.ts`)).expected;",
  ])('flags %s', async (code) => {
    const messages = (await lint(code, POLICY)).filter((m) => m.ruleId === RULE);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0]!.message).toMatch(/derive it from the initial world/);
  });

  it('allows type-only imports and the world modules', async () => {
    const code = "import type { Json } from '../../packages/grader/check.ts'; import { STAFF } from '../../packages/env/world.ts'; export const derive = (): Json => STAFF[0];";
    expect(await ruleIds(code, POLICY)).not.toContain(RULE);
  });

  it('covers the task root and tests/ copies of policy.ts', async () => {
    expect(await ruleIds("import { expected } from '../expected.ts'; export const d = expected;", 'tasks/t9/tests/policy.ts')).toContain(RULE);
  });

  it('lets the grader import expected.ts', async () => {
    expect(await ruleIds("import { expected } from '../expected.ts'; export const d = expected;", 'tasks/t9/tests/grader.ts')).not.toContain(RULE);
  });
});

// The rule above sees only the specifiers policy.ts writes. The real guard follows the whole
// module graph (cli/matrix.ts policyImports, run by the matrix): every module policy.ts reaches,
// resolved with the TypeScript compiler's module resolution, through re-exports, '#' and '?'
// suffixes and case variants, with type-only imports skipped. Each plant below is a task
// directory in a temp dir that reaches expected.ts or an overlay module some other way.
describe('policy.ts module graph (builder-33 item 3)', () => {
  const plantTask = (files: Record<string, string>) => {
    const dir = tempDir('policy-graph');
    write(dir, 'expected.ts', 'export const expected = { a: 1 };\n');
    for (const [rel, text] of Object.entries(files)) write(dir, rel, text);
    return dir;
  };

  it('every tasks/*/policy.ts reaches no expected.ts and no overlay module', async () => {
    const tasks = readdirSync(join(root, 'tasks')).filter((t) => existsSync(join(root, 'tasks', t, 'policy.ts')));
    expect(tasks.length).toBeGreaterThan(0);
    for (const t of tasks) {
      const r = policyImports(join(root, 'tasks', t));
      expect(r.problems, t).toEqual([]);
      expect(r.modules).toBeGreaterThan(1);
    }
  });

  it.each([
    ['a re-export through another module', { 'policy.ts': "import { e } from './launder.ts'; export const derive = () => e;", 'launder.ts': "export { expected as e } from './expected.ts';" }, /expected\.ts .*launder\.ts/],
    ["a '#' fragment", { 'policy.ts': "import { expected } from './expected.ts#h'; export const derive = () => expected;" }, /expected\.ts/],
    ["a '?' query", { 'policy.ts': "import { expected } from './expected.ts?x=1'; export const derive = () => expected;" }, /expected\.ts/],
    ['a case variant', { 'policy.ts': "import { expected } from './Expected.ts'; export const derive = () => expected;" }, /xpected\.ts/],
    ['a template dynamic import', { 'policy.ts': "const name = 'expected'; export const derive = async () => (await import(`./${name}.ts`)).expected;" }, /dynamic import with a non-constant specifier/],
    ['a dynamic import in an imported module', { 'policy.ts': "import { load } from './loader.ts'; export const derive = () => load('expected');", 'loader.ts': 'export const load = (n: string) => import(n);' }, /loader\.ts: dynamic import with a non-constant specifier/],
    ['an overlay subdirectory', { 'policy.ts': "import { PT } from './overlay/constants.ts'; export const derive = () => PT;", 'overlay/constants.ts': "export const PT = 'pt-0002';" }, /overlay\/constants\.ts/],
    ["the env's overlay module", { 'policy.ts': `import * as O from ${JSON.stringify(join(root, 'packages/env/overlay.ts'))}; export const derive = () => Object.keys(O);` }, /packages\/env\/overlay\.ts/],
    ['an import that does not resolve', { 'policy.ts': "import { x } from './nowhere.ts'; export const derive = () => x;" }, /cannot resolve '\.\/nowhere\.ts'/],
  ])('fails on %s', (_name, files, problem) => {
    const r = policyImports(plantTask(files));
    expect(r.problems.join('\n')).toMatch(problem);
  });

  it('allows a type-only import of expected.ts and an import of the world', () => {
    const dir = plantTask({ 'policy.ts': `import type { expected } from './expected.ts'; import { STAFF } from ${JSON.stringify(join(root, 'packages/env/world.ts'))}; export const derive = (): typeof expected | string => STAFF[0]!;` });
    expect(policyImports(dir).problems).toEqual([]);
  });
});
