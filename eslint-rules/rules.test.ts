import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
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

describe('isomorphic-imports bans every Node builtin', () => {
  // Derived the same way as the rule, so a builtin added in a later Node release is covered too.
  const names = [...new Set(builtinModules.map((m) => m.replace(/^node:/, '')))];
  it.each(names)('flags %s in bare and node: forms', async (name) => {
    expect(await ruleIds(`import * as m from 'node:${name}'; export { m };`, 'packages/env/a.ts')).toContain(ISO);
    if (!builtinModules.includes(`node:${name}`)) {
      expect(await ruleIds(`import * as m from '${name}'; export { m };`, 'packages/env/a.ts')).toContain(ISO);
    }
  });
  it.each([
    "import { randomUUID, randomBytes } from 'node:crypto'; export const a = [randomUUID, randomBytes];",
    "import { performance as perf } from 'node:perf_hooks'; export const t = perf.now();",
    "import { setTimeout as sleep } from 'node:timers/promises'; export { sleep };",
    "import { setTimeout as sleep } from 'timers/promises'; export { sleep };",
    "import { request } from 'node:http'; export { request };",
    "import { gzipSync } from 'node:zlib'; export { gzipSync };",
    "import { inspect } from 'node:util'; export { inspect };",
    "import { Buffer as B } from 'node:buffer'; export const b = B.from('x');",
    "import { createHash } from 'crypto'; export { createHash };",
    "import { readFile } from 'fs/promises'; export { readFile };",
    "import { test } from 'node:test'; export { test };",
    'export const m = await import(`node:fs`);',
    'export const m = await import(`crypto`);',
    "export const m = await import('node:crypto');",
    "import fs = require('fs'); export const r = fs.readFileSync;",
  ])('flags %s', async (code) => {
    expect(await ruleIds(code, 'packages/core/a.ts')).toContain(ISO);
  });
  it.each([
    "export const b64 = Buffer.from('x').toString('base64');",
    'setImmediate(() => {});',
    'export const c = clearImmediate;',
    'export const d = __dirname;',
    'export const f = __filename;',
    "export const r = require('fs');",
    'export const g = global;',
    'export const b = globalThis.Buffer.alloc(1);',
    'export const s = globalThis.setImmediate;',
  ])('flags the Node-only global in %s', async (code) => {
    expect(await ruleIds(code, 'tasks/t1/a.ts')).toContain(ISO);
  });
  it.each([
    "import { x } from './fs.ts'; export { x };",
    "import { x } from 'fs-extra'; export { x };",
    "import { x } from 'node-fetch'; export { x };",
    "import { x } from '@acme/path'; export { x };",
    "export const m = await import('./crypto.ts');",
  ])('allows %s, which is not a builtin', async (code) => {
    expect(await ruleIds(code, 'packages/core/a.ts')).not.toContain(ISO);
  });
});

describe('determinism catches Intl clock reads', () => {
  it.each([
    "export const s = new Intl.DateTimeFormat('en-US').format();",
    'export const s = Intl.DateTimeFormat().format();',
    "export const p = new Intl.DateTimeFormat('en-US').formatToParts();",
    'export const s = Intl.DateTimeFormat().format(undefined);',
    "export const s = globalThis.Intl.DateTimeFormat('en-US').format();",
    "const f = new Intl.DateTimeFormat('en-US'); export const s = f.format();",
    "const f = Intl.DateTimeFormat('en-US'); export const p = f.formatToParts();",
    'export const d = new Date(...([] as []));',
  ])('flags %s', async (code) => {
    expect(await ruleIds(code, 'packages/env/a.ts')).toContain(DET);
  });
  it.each([
    "export const s = new Intl.DateTimeFormat('en-US').format(0);",
    "const f = new Intl.DateTimeFormat('en-US'); export const s = f.formatToParts(new Date(0));",
    "export const n = new Intl.NumberFormat('en-US').format(1);",
    "export const l = Intl.DateTimeFormat.supportedLocalesOf(['en-US']);",
  ])('allows %s', async (code) => {
    expect(await ruleIds(code, 'packages/env/a.ts')).not.toContain(DET);
  });
});

describe('string evaluation is banned in shared code', () => {
  it.each([
    ["export const t = eval('Date.now()');", 'no-eval'],
    ["export const t = Function('return Date.now()')();", 'no-new-func'],
    ["export const f = new Function('return 1');", 'no-new-func'],
    ["setTimeout('Date.now()', 0);", 'no-implied-eval'],
  ])('flags %s with %s', async (code, rule) => {
    for (const path of ['packages/env/a.ts', 'packages/core/a.ts', 'packages/grader/a.ts', 'tasks/t1/a.ts']) {
      expect(await ruleIds(code, path)).toContain(rule);
    }
  });
});

describe('package tests run under Node', () => {
  const NODE_ONLY = "import { readFileSync } from 'node:fs';\nexport const t = Date.now() + readFileSync('x').length;\nexport const a = [1, , 3];";

  it('lets a package test use Node builtins, the clock and sparse arrays', async () => {
    for (const path of ['packages/env/test/x.test.ts', 'packages/core/test/x.test.ts']) {
      expect(await ruleIds(NODE_ONLY, path)).toEqual([]);
    }
  });

  it('still bans them in the package source next to the tests', async () => {
    const ids = await ruleIds(NODE_ONLY, 'packages/env/x.ts');
    expect(ids).toContain(ISO);
    expect(ids).toContain(DET);
    expect(ids).toContain('no-sparse-arrays');
  });

  it('ignores an inline disable of a P2 rule in a package test', async () => {
    const host = ['api', 'anthropic', 'com'].join('.');
    const code = `/* eslint-disable local/no-direct-anthropic */\nexport const r = fetch('https://${host}/v1/messages');`;
    expect(await ruleIds(code, 'packages/env/test/x.test.ts')).toContain('local/no-direct-anthropic');
  });
});

describe('clean fixture', () => {
  it('passes every rule in every scoped directory', async () => {
    for (const path of ['packages/env/a.ts', 'packages/core/loop.ts', 'packages/grader/a.ts', 'tasks/t1/a.ts']) {
      expect(await ruleIds('clean.ts', path)).toEqual([]);
    }
  });
});
