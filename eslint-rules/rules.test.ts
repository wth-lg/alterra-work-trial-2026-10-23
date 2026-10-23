import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

// Lints each fixture through the real eslint.config.js, as if it lived at a scoped path,
// so these tests cover the rule logic and the per-rule file scopes together.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const eslint = new ESLint({ cwd: root });

async function ruleIds(fixtureOrCode: string, path: string): Promise<string[]> {
  const code = fixtureOrCode.endsWith('.ts')
    ? readFileSync(join(root, 'eslint-rules/fixtures', fixtureOrCode), 'utf8')
    : fixtureOrCode;
  const [result] = await eslint.lintText(code, { filePath: join(root, path) });
  return (result?.messages ?? []).map((m) => m.ruleId ?? `fatal: ${m.message}`);
}

const ISO = 'local/isomorphic-imports';
const DET = 'local/determinism';

describe('banned patterns fail their fixtures', () => {
  const cases: Array<[string, string, string]> = [
    ['fs import', 'fs-import.ts', ISO],
    ['node:fs import', 'node-fs-import.ts', ISO],
    ['process', 'process.ts', ISO],
    ['DOM globals', 'dom.ts', ISO],
    ['Date.now()', 'date-now.ts', DET],
    ['argument-less new Date()', 'new-date.ts', DET],
    ['Math.random()', 'math-random.ts', DET],
  ];
  for (const [name, fixture, rule] of cases) {
    it(`${name} fails in packages/env and tasks/`, async () => {
      expect(await ruleIds(fixture, 'packages/env/fixture.ts')).toContain(rule);
      expect(await ruleIds(fixture, 'tasks/t1/fixture.ts')).toContain(rule);
    });
  }
});

describe('isomorphic-imports scope and variants', () => {
  it.each(['packages/env/a.ts', 'packages/core/a.ts', 'packages/grader/a.ts', 'tasks/t1/a.ts'])(
    'applies in %s',
    async (path) => {
      expect(await ruleIds('fs-import.ts', path)).toContain(ISO);
    },
  );
  it.each([
    "import { readFile } from 'fs/promises';",
    "import { readFile } from 'node:fs/promises';",
    "import process from 'process';",
    "import { env } from 'node:process';",
    "export { readFileSync } from 'node:fs';",
    "export const m = await import('node:fs');",
    'export const s = localStorage.getItem("k");',
    'export const n = navigator.userAgent;',
  ])('flags %s', async (code) => {
    expect(await ruleIds(code, 'packages/core/a.ts')).toContain(ISO);
  });
  it('does not apply in apps/web, cli or scripts', async () => {
    for (const path of ['apps/web/src/a.ts', 'cli/a.ts', 'scripts/a.ts']) {
      expect(await ruleIds('fs-import.ts', path)).not.toContain(ISO);
      expect(await ruleIds('dom.ts', path)).not.toContain(ISO);
    }
  });
  it('allows a locally declared name that shadows a banned global', async () => {
    const code = 'export function f(document: string) { return document; }';
    expect(await ruleIds(code, 'packages/env/a.ts')).not.toContain(ISO);
  });
});

describe('determinism scope', () => {
  it.each(['packages/env/a.ts', 'packages/core/loop.ts', 'packages/grader/a.ts', 'tasks/t1/a.ts'])(
    'applies in %s',
    async (path) => {
      expect(await ruleIds('math-random.ts', path)).toContain(DET);
    },
  );
  it('does not apply to the rest of packages/core, apps/web or cli', async () => {
    for (const path of ['packages/core/client.ts', 'apps/web/src/a.ts', 'cli/a.ts']) {
      expect(await ruleIds('date-now.ts', path)).not.toContain(DET);
    }
  });
});

describe('determinism catches non-literal forms', () => {
  it.each([
    'export const s = Date();',
    "export const t = Date['now']();",
    'export const t = Date[`now`]();',
    "export const r = Math['random']();",
    'export const t = globalThis.Date.now();',
    'export const d = new globalThis.Date();',
    'export const t = window.Date.now();',
    'export const r = self.Math.random();',
    "export const t = globalThis['Date']['now']();",
    'const now = Date.now; export const t = now();',
    'const { random } = Math; export const r = random();',
    'const { now: clock } = Date; export const t = clock();',
    'const D = Date; export const d = new D();',
    'const M = Math; export const r = M.random();',
    'export const t = (Date as DateConstructor).now();',
    'export const t = performance.now();',
    'export const b = crypto.getRandomValues(new Uint8Array(4));',
    'export const u = crypto.randomUUID();',
    'export const u = globalThis.crypto.randomUUID();',
  ])('flags %s', async (code) => {
    expect(await ruleIds(code, 'packages/env/a.ts')).toContain(DET);
  });
  it.each([
    'export const d = new Date(0);',
    'export const t = Date.UTC(2026, 0, 1);',
    "export const t = Date.parse('2026-01-01');",
    'export const f = Math.floor(1.5);',
    'const { floor } = Math; export const f = floor(1.5);',
    'export const isDate = (x: unknown) => x instanceof Date;',
    'export type Clock = { now: () => number; at: Date };',
    'export function f(Date: { now(): number }) { return Date.now(); }',
  ])('allows %s', async (code) => {
    expect(await ruleIds(code, 'packages/env/a.ts')).not.toContain(DET);
  });
});

describe('isomorphic-imports catches global-object access and more node modules', () => {
  it.each([
    'export const e = globalThis.process.env;',
    "export const e = globalThis['process'].env;",
    'export const t = globalThis.document.title;',
    'export const w = globalThis.window;',
    'export const t = self.document.title;',
    'export const t = window.document.title;',
    'const { process: p } = globalThis; export const e = p.env;',
    'export const g = global.process;',
  ])('flags %s', async (code) => {
    expect(await ruleIds(code, 'packages/core/a.ts')).toContain(ISO);
  });
  it.each(['child_process', 'os', 'module', 'path', 'url', 'worker_threads', 'path/posix'])(
    'flags imports of %s in bare and node: forms',
    async (name) => {
      expect(await ruleIds(`import * as m from '${name}'; export { m };`, 'tasks/t1/a.ts')).toContain(ISO);
      expect(await ruleIds(`import * as m from 'node:${name}'; export { m };`, 'tasks/t1/a.ts')).toContain(ISO);
    },
  );
  it.each(['export const s = self.postMessage;', 'export const c = globalThis.crypto.subtle;'])(
    'allows %s, which works in a Worker and in Node',
    async (code) => {
      expect(await ruleIds(code, 'packages/core/a.ts')).not.toContain(ISO);
    },
  );
});

describe('clean fixture', () => {
  it('passes every rule in every scoped directory', async () => {
    for (const path of ['packages/env/a.ts', 'packages/core/loop.ts', 'packages/grader/a.ts', 'tasks/t1/a.ts']) {
      expect(await ruleIds('clean.ts', path)).toEqual([]);
    }
  });
});
