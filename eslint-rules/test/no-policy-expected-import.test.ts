import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

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
