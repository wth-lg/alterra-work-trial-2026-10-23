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
async function ruleIds(code: string, path: string): Promise<string[]> {
  return (await lint(code, path)).map((m) => m.ruleId ?? `fatal: ${m.message}`);
}

const RULE = 'local/no-direct-dispatcher';

// The X2 plants from reports/verifier-phase-P2-13.md (evidence/verifier-phase-P2-13/ts-plants/x2),
// verbatim. At a679bed both lint clean in cli/, and sym.ts reaches the API host with 0 ledger rows.
const X2_SYM = `// X2 plant: call the global undici dispatcher's request() directly, bypassing fetch and the guard.
// SYM is '1' or '2'. The host is built at runtime, as the no-direct-anthropic rule says it cannot see.
const HOST = ['api', 'anthropic', 'com'].join('.');
interface R { statusCode: number; body: { text(): Promise<string> } }
interface D { request(o: object): Promise<R> }
export async function sym(which: string, key: string): Promise<string> {
  await fetch('data:,');
  const d = (globalThis as unknown as Record<symbol, D | undefined>)[Symbol.for(\`undici.globalDispatcher.\${which}\`)];
  if (!d || typeof d.request !== 'function') return \`no dispatcher at .\${which}\`;
  const r = await d.request({ origin: \`https://\${HOST}\`, path: '/v1/messages', method: 'POST', headers: { 'x-api-key': key, 'content-type': 'application/json' }, body: '{}' });
  await r.body.text();
  return \`status \${r.statusCode}\`;
}
`;
const X2_IMP = `// X2 plant: import undici and call request() against the API host.
import { request } from 'undici';
const HOST = ['api', 'anthropic', 'com'].join('.');
export async function imp(key: string): Promise<string> {
  const r = await request(\`https://\${HOST}/v1/messages\`, { method: 'POST', headers: { 'x-api-key': key }, body: '{}' });
  await r.body.text();
  return \`status \${r.statusCode}\`;
}
`;

// The registry key built at runtime, so an evasion below fails for its own mechanism, not for
// the 'undici.' string check.
const K = "const k = ['undici', 'globalDispatcher', '2'].join('.');\n";

describe('no-direct-dispatcher', () => {
  it.each([
    ['X2a/b: Symbol.for with a template naming the .1 or .2 symbol', 'cli/zz-v13x2/sym.ts', X2_SYM],
    ['X2d: import undici', 'cli/zz-v13x2/imp.ts', X2_IMP],
  ])('flags the verifier plant %s', async (_name, path, code) => {
    expect(await ruleIds(code, path)).toContain(RULE);
  });

  // Builder evasions: each reaches the global dispatcher, undici or a raw socket module without
  // a literal Symbol.for('undici...') call.
  it.each([
    ['e1 a split constant', "export const d = (globalThis as any)[Symbol.for('undici.' + 'globalDispatcher.2')];"],
    ['e1b a template of constants', "export const d = (globalThis as any)[Symbol.for(`undici.${'globalDispatcher'}.1`)];"],
    ['e1c a literal', "export const d = (globalThis as any)[Symbol.for('undici.globalDispatcher.1')];"],
    ['e2 a key held in a variable', K + "export const d = (globalThis as any)[Symbol.for(k)];"],
    ['e2b a spread argument', K + "const a = [k];\nexport const d = (globalThis as any)[Symbol.for(...a)];"],
    ['e3 an alias of Symbol.for', K + "const f = Symbol.for;\nexport const d = (globalThis as any)[f(k)];"],
    ['e3b Symbol.for.call', K + "export const d = (globalThis as any)[Symbol.for.call(null, k)];"],
    ['e3c Reflect.get on Symbol', K + "export const d = (globalThis as any)[Reflect.get(Symbol, 'for')(k)];"],
    ['e3d a destructured for', K + "const { for: f } = Symbol;\nexport const d = (globalThis as any)[f(k)];"],
    ['e3e Symbol cast to any', K + "export const d = (globalThis as any)[(Symbol as any).for(k)];"],
    ['e4 a computed for', K + "export const d = (globalThis as any)[Symbol['f' + 'or'](k)];"],
    ['e4b a non-constant computed key on Symbol', K + "const m = 'for';\nexport const d = (globalThis as any)[(Symbol as any)[m](k)];"],
    ['e4c Symbol read off globalThis', K + "export const d = (globalThis as any)[globalThis.Symbol.for(k)];"],
    ['e4d Symbol read off a computed constant', K + "const g: any = globalThis;\nexport const d = g[g['Sym' + 'bol'].for(k)];"],
    ['e4e Symbol destructured from globalThis', K + "const { Symbol: S } = globalThis;\nexport const d = (globalThis as any)[S.for(k)];"],
    ['e4f a .for call on an unknown object', "const g: any = globalThis;\nconst n = 'Sym' + 'bol';\nexport const d = g[g[n].for('undici.globalDispatcher.2')];"],
    ['e5 enumerating global symbols', "export const d = Object.getOwnPropertySymbols(globalThis).map((s) => (globalThis as any)[s]).find((v) => typeof v?.request === 'function');"],
    ['e5b Reflect.ownKeys', "export const d = Reflect.ownKeys(globalThis).map((s) => (globalThis as any)[s]).find((v) => typeof v?.request === 'function');"],
    ['e5c a destructured getOwnPropertySymbols', "const { getOwnPropertySymbols: g } = Object;\nexport const d = g(globalThis);"],
    ['e5d getOwnPropertyDescriptors into a recording proxy', "const keys: PropertyKey[] = [];\nObject.defineProperties(new Proxy({}, { defineProperty: (_t, k) => (keys.push(k), true) }), Object.getOwnPropertyDescriptors(globalThis));\nexport { keys };"],
    ['e5e a computed Object method', "const m = 'getOwnPropertySymbols';\nexport const d = (Object as any)[m](globalThis);"],
    ['e6 process.getBuiltinModule', "export const https = process.getBuiltinModule('node:https');"],
    ['e6b a destructured getBuiltinModule', "const { getBuiltinModule } = process;\nexport const https = getBuiltinModule('node:https');"],
    ['e6c a computed getBuiltinModule', "export const https = (process as any)['getBuiltin' + 'Module']('node:https');"],
    ['e6d a non-constant computed key on process', "const m = ['get', 'Builtin', 'Module'].join('');\nexport const https = (process as any)[m]('node:https');"],
    ['e6e getBuiltinModule off globalThis.process', "export const https = globalThis.process.getBuiltinModule('node:https');"],
    ['e7 node:undici', "export { request } from 'node:undici';"],
    ['e7b a dynamic import', "export const u = await import('undici');"],
    ['e7c require through createRequire', "import { createRequire } from 'node:module';\nexport const u = createRequire(import.meta.url)('undici');"],
    ['e7d a subpath', "export * from 'undici/lib/global.js';"],
    ['e7e import = require', "import u = require('undici');\nexport { u };"],
    ['e7f a type-only import', "import type { Dispatcher } from 'undici';\nexport type D = Dispatcher;"],
  ])('flags %s', async (_name, code) => {
    expect(await ruleIds(code, 'cli/planted.ts')).toContain(RULE);
  });

  it('names the fix in its message', async () => {
    const [m] = (await lint(X2_SYM, 'cli/zz-v13x2/sym.ts')).filter((x) => x.ruleId === RULE);
    expect(m?.message).toContain('send through MessagesClient (packages/core/anthropic.ts)');
  });

  it.each(['apps/web/src/a.ts', 'apps/web/e2e/live/a.spec.ts', 'scripts/a.ts', 'scripts/test/a.test.ts', 'packages/core/loop.ts', 'packages/core/test/a.test.ts', 'eslint-rules/fixtures/a.ts', 'cli/a.js', 'cli/a.mjs', 'cli/a.cjs', 'apps/web/src/a.tsx'])(
    'applies in %s',
    async (path) => {
      expect(await ruleIds("export const d = Symbol.for('undici.globalDispatcher.2');", path)).toContain(RULE);
    },
  );

  it('ignores inline config: it cannot be turned off outside eslint.config.js', async () => {
    const code = `// eslint-disable-next-line ${RULE}\nexport const d = Symbol.for('undici.globalDispatcher.2');`;
    expect(await ruleIds(code, 'cli/planted.ts')).toContain(RULE);
  });

  it('allows packages/core/egress.ts, the one reader of the global dispatcher', async () => {
    const code = "export const d = (globalThis as any)[Symbol.for('undici.globalDispatcher.2')] ?? (globalThis as any)[Symbol.for('undici.globalDispatcher.1')];";
    expect(await ruleIds(code, 'packages/core/egress.ts')).not.toContain(RULE);
  });

  it.each([
    "export const REMOVE = Symbol('remove');",
    'export class C { *[Symbol.iterator]() { yield 1; } async *[Symbol.asyncIterator]() { yield 1; } }',
    "export const k = Symbol.for('app.key');",
    "export const k = Symbol.for('app.undici');",
    "export const k = Symbol.keyFor(Symbol.for('app.key'));",
    "export const t = typeof Symbol === 'function';",
    "export type S = typeof Symbol;",
    "export const code = `globalThis[Symbol.for('undici.globalDispatcher.2')]`;",
    "export const code = \"process.getBuiltinModule('node:https')\";",
    "import type { Dispatcher } from 'undici-types';\nexport type D = Dispatcher;",
    "import { createServer } from 'node:http';\nexport { createServer };",
    "export const o = { for: 1, Symbol: 2, getBuiltinModule: 3 };",
    "export const k = Object.keys({ a: 1 });",
    'export const env = (k: string) => process.env[k];',
  ])('allows %s', async (code) => {
    expect(await ruleIds(code, 'cli/a.ts')).not.toContain(RULE);
  });
});
