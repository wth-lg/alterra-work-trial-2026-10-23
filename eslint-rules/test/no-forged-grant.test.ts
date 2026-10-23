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

const RULE = 'local/no-forged-grant';
const LEDGER = "import type { BatchGrant } from '../packages/core/ledger.ts';\n";

describe('no-forged-grant', () => {
  it.each([
    'export const g = {} as BatchGrant;',
    'export const g = ({} as unknown) as BatchGrant;',
    'export const g = <BatchGrant>{};',
    'export const g: BatchGrant = { batch_id: "x" } as never;',
    'export const g: BatchGrant = Object.assign({}, { batch_id: "x" }) as never;',
    'const make = (): BatchGrant => ({}) as never; export { make };',
    'export const gs = [{}] as BatchGrant[];',
    'export const g = {} satisfies Partial<BatchGrant> as Readonly<BatchGrant>;',
  ])('flags %s in cli/', async (code) => {
    expect(await ruleIds(LEDGER + code, 'cli/planted.ts')).toContain(RULE);
  });

  it('flags a qualified name through a namespace import', async () => {
    const code = "import type * as L from '../packages/core/ledger.ts';\nexport const g = {} as L.BatchGrant;";
    expect(await ruleIds(code, 'cli/planted.ts')).toContain(RULE);
  });

  it.each([
    'type G = BatchGrant;\nexport const g = {} as G;',
    'export const g = {} as H;\ntype H = G;\ntype G = Readonly<BatchGrant>;',
    'export type G = BatchGrant;\nexport const g: G = {} as never;',
    "import type { ClientOptions } from '../packages/core/anthropic.ts';\nexport const g = {} as ClientOptions['grant'];",
    "export const g = {} as Parameters<typeof f>[0]['grant'];\ndeclare function f(o: { grant: unknown }): void;",
    "import type { BatchGrant as BG } from '../packages/core/ledger.ts';\nexport const g = {} as A;\ntype A = BG;",
  ])('flags a cast through a type alias or an indexed access type: %s', async (code) => {
    expect(await ruleIds(LEDGER + code, 'cli/planted.ts')).toContain(RULE);
  });

  it.each(['cli/planted.mts', 'cli/planted.cts', 'cli/planted.tsx'])('applies to %s', async (path) => {
    expect(await ruleIds(LEDGER + 'export const g = {} as BatchGrant;', path)).toContain(RULE);
  });

  it('allows ledger.ts and the one exempt test file', async () => {
    for (const path of ['packages/core/ledger.ts', 'packages/core/test/anthropic.test.ts']) {
      expect(await ruleIds(LEDGER + 'export const g = {} as BatchGrant;', path)).not.toContain(RULE);
    }
  });

  it('applies to every other test file', async () => {
    expect(await ruleIds(LEDGER + 'export const g = {} as BatchGrant;', 'packages/core/test/ledger.test.ts')).toContain(RULE);
  });

  it.each([
    'export let g: BatchGrant | undefined;',
    'export function use(g: BatchGrant) { return g.batch_id; }',
    'export async function f(l: { batchStart(p: number): Promise<BatchGrant> }) { const g: BatchGrant = await l.batchStart(1); return g; }',
  ])('allows %s', async (code) => {
    expect(await ruleIds(LEDGER + code, 'cli/a.ts')).not.toContain(RULE);
  });
});
