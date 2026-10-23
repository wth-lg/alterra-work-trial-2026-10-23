import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

// Lints code through the real eslint.config.js as if it lived at a repo path, so these tests
// cover the rule and its file scope together.
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const eslint = new ESLint({ cwd: root });
async function ruleIds(code: string, path: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: join(root, path) });
  return (result?.messages ?? []).map((m) => m.ruleId ?? `fatal: ${m.message}`);
}

const RULE = 'local/no-ledger-factory';

describe('no-ledger-factory', () => {
  it.each([
    "import { createLedger } from '../packages/core/ledger.ts'; export { createLedger };",
    "import { admitStore as a } from '../packages/core/ledger.ts'; export { a };",
    "export { createLedger } from '../packages/core/ledger.ts';",
    "import * as L from '../packages/core/ledger.ts'; export const c = L.createLedger;",
    "import * as L from '../packages/core/ledger.ts'; export const { admitStore } = L;",
    "export const m = await import('../packages/core/ledger.ts');",
    "export const m = await import(`../packages/core/ledger.ts`);",
  ])('flags %s in cli/', async (code) => {
    expect(await ruleIds(code, 'cli/planted.ts')).toContain(RULE);
  });

  it('flags the import from a relative path inside packages/core too', async () => {
    expect(await ruleIds("import { createLedger } from './ledger.ts'; export { createLedger };", 'packages/core/loop.ts')).toContain(RULE);
  });

  it.each(['cli/adapters/ledger-node.ts', 'apps/web/src/adapters/ledger-browser.ts', 'packages/core/test/ledger.test.ts', 'cli/adapters/test/x.test.ts'])(
    'allows %s',
    async (path) => {
      const depth = path.split('/').length - 1;
      const code = `import { admitStore, createLedger } from '${'../'.repeat(depth)}packages/core/ledger.ts'; export const use = [admitStore, createLedger];`;
      expect(await ruleIds(code, path)).not.toContain(RULE);
    },
  );

  // The allowance is for test files, not for any file under a test/ directory.
  it.each(['cli/test/helper.ts', 'packages/core/test/helpers.ts'])('flags %s', async (path) => {
    const depth = path.split('/').length - 1;
    expect(await ruleIds(`import { createLedger } from '${'../'.repeat(depth)}packages/core/ledger.ts'; export const c = [createLedger];`, path)).toContain(RULE);
  });

  // A re-export would launder the factory to files the rule forbids, so only ledger.ts exports it.
  it.each(['cli/adapters/launder.ts', 'apps/web/src/adapters/launder.ts', 'packages/core/test/launder.test.ts'])('flags a re-export in %s', async (path) => {
    const up = '../'.repeat(path.split('/').length - 1);
    for (const code of [
      `import { createLedger } from '${up}packages/core/ledger.ts'; export { createLedger };`,
      `import { admitStore as a } from '${up}packages/core/ledger.ts'; export { a as admit };`,
      `export { createLedger } from '${up}packages/core/ledger.ts';`,
      `export * from '${up}packages/core/ledger.ts';`,
      `import { createLedger } from '${up}packages/core/ledger.ts'; export default createLedger;`,
    ]) {
      expect(await ruleIds(code, path), code).toContain(RULE);
    }
  });

  it.each(['cli/planted.mts', 'cli/planted.cts', 'cli/planted.cjs', 'cli/planted.tsx', 'cli/planted.js', 'cli/planted.mjs'])('applies to %s', async (path) => {
    expect(await ruleIds("import { createLedger } from '../packages/core/ledger.ts'; export const c = [createLedger];", path)).toContain(RULE);
  });

  it('allows the rest of ledger.ts anywhere', async () => {
    const code = "import { assertGrant, totals, type BatchGrant } from '../packages/core/ledger.ts'; export { assertGrant, totals }; export type G = BatchGrant;";
    expect(await ruleIds(code, 'cli/a.ts')).not.toContain(RULE);
  });

  it('ignores a same-named import from another module', async () => {
    expect(await ruleIds("import { createLedger } from './fake.ts'; export { createLedger };", 'cli/a.ts')).not.toContain(RULE);
  });
});
