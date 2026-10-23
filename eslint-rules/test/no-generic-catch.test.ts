import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

// Lints code through the real eslint.config.js as if it lived at a scoped path, so these
// tests cover the rule logic and its file scope together.
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const eslint = new ESLint({ cwd: root });
const RULE = 'local/no-generic-catch';

async function ruleIds(code: string, path: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: join(root, path) });
  return (result?.messages ?? []).map((m) => m.ruleId ?? `fatal: ${m.message}`);
}

const PRELUDE = `
class ToolError extends Error {}
class SearchError extends Error {}
declare function f(): number;
declare function cleanup(): void;
`;
const TOOL = 'packages/env/tools/read/planted.ts';

describe('no-generic-catch flags a catch that can swallow an error', () => {
  it.each([
    ['returns a fallback', 'export function g() { try { return f(); } catch (e) { return 0; } }'],
    ['has no binding', 'export function g() { try { return f(); } catch { return 0; } }'],
    ['logs and falls through', 'export function g() { try { f(); } catch (e) { cleanup(); } }'],
    ['is empty', 'export function g() { try { f(); } catch (e) {} }'],
    ['narrows to a class that is not ToolError', 'export function g() { try { return f(); } catch (e) { if (e instanceof TypeError) return 0; throw e; } }'],
    ['replaces the error', "export function g() { try { return f(); } catch (e) { throw new Error('x'); } }"],
    ['returns on a test that is not instanceof', 'export function g() { try { return f(); } catch (e) { if (f() > 1) return 0; throw e; } }'],
    ['swallows a SearchError without a ToolError', 'export function g() { try { return f(); } catch (e) { if (e instanceof SearchError) return 0; throw e; } }'],
    ['rethrows on one branch only', 'export function g() { try { return f(); } catch (e) { if (f()) throw e; } }'],
    ['breaks out of a loop', 'export function g() { for (;;) { try { f(); } catch (e) { break; } } }'],
    ['uses a Promise catch', 'export const p = Promise.resolve(1).catch(() => 0);'],
    ['uses a then rejection handler', 'export const p = Promise.resolve(1).then((x) => x, () => 0);'],
    ['destructures the error', 'export function g() { try { return f(); } catch ({ message }) { throw message; } }'],
  ])('%s', async (_name, body) => {
    expect(await ruleIds(PRELUDE + body, TOOL)).toContain(RULE);
  });
});

describe('no-generic-catch allows a catch that rethrows or narrows to ToolError', () => {
  it.each([
    ['rethrows after cleanup', 'export function g() { try { return f(); } catch (e) { cleanup(); throw e; } }'],
    ['narrows to ToolError, then rethrows', 'export function g() { try { return f(); } catch (e) { if (e instanceof ToolError) return 0; throw e; } }'],
    ['narrows with an else rethrow', 'export function g() { try { return f(); } catch (e) { if (e instanceof ToolError) { return 0; } else { throw e; } } }'],
    ['turns a SearchError into a ToolError', "export function g() { try { return f(); } catch (e) { if (e instanceof SearchError) throw new ToolError('x', { cause: e }); throw e; } }"],
    ['returns inside a nested function', 'export function g() { try { return f(); } catch (e) { const h = () => 1; h(); throw e; } }'],
  ])('%s', async (_name, body) => {
    expect(await ruleIds(PRELUDE + body, TOOL)).not.toContain(RULE);
  });
});

describe('no-generic-catch scope', () => {
  const generic = PRELUDE + 'export function g() { try { return f(); } catch (e) { return 0; } }';
  it.each(['packages/env/tools/registry.ts', 'packages/env/tools/errors.ts', 'packages/env/tools/read/a.ts', 'packages/env/tools/write/a.ts'])(
    'applies in %s',
    async (path) => {
      expect(await ruleIds(generic, path)).toContain(RULE);
    },
  );
  it.each(['packages/env/store.ts', 'packages/core/a.ts', 'cli/a.ts', 'packages/env/tools/test/read.test.ts'])('does not apply in %s', async (path) => {
    expect(await ruleIds(generic, path)).not.toContain(RULE);
  });
});
