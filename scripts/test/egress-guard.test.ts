// The runtime egress guard, in real processes: each child stubs the network with a recording
// fetch (and fake XMLHttpRequest, WebSocket, EventSource and sendBeacon), installs the guard
// the way an entry point does, then runs the review's plants. A plant that reaches the stub
// is an unmetered send. MessagesClient's own call must still reach it, exactly once.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fakeKey, repoRoot, tempDir, write } from './helpers.ts';

const HOST = ['api', 'anthropic', 'com'].join('.');
const repo = (rel: string) => pathToFileURL(join(repoRoot, rel)).href;
const POST = `{ method: 'POST', headers: { 'x-api-key': 'sk-fake', 'content-type': 'application/json' }, body: '{}' }`;
const client = `import { MessagesClient } from '${repo('packages/core/anthropic.ts')}';\nimport { openNodeLedger } from '${repo('cli/adapters/ledger-node.ts')}';\n`;

// The review's 13 lint-clean shapes (pr-review-P2-7 defect 1, plants a to m) that resolve to the
// API host, as runtime code. Lint and file-type evasions (j to m) reduce to a literal-host fetch.
const PLANTS: Record<string, string> = {
  'a-template-expr': `const sub = 'api'; export const go = () => fetch(\`https://\${sub}.anthropic.com/v1/messages\`, ${POST});`,
  'b-array-join': `export const go = () => fetch(['https://api', 'anthropic', 'com/v1/messages'].join('.'), ${POST});`,
  'c-percent-host': `export const go = () => fetch('https://api%2Eanthropic%2Ecom/v1/messages', ${POST});`,
  'd-fullwidth-dot': `export const go = () => fetch('https://api\u3002anthropic\u3002com/v1/messages', ${POST});`,
  'e-fromcharcode': `const h = String.fromCharCode(${[...HOST].map((c) => c.charCodeAt(0)).join(', ')}); export const go = () => fetch('https://' + h + '/v1/messages', ${POST});`,
  'f-concat-var-middle': `const mid = 'anthropic.'; export const go = () => fetch('https://api.' + mid + 'com/v1/messages', ${POST});`,
  'g-read-client-source': `import { readFileSync } from 'node:fs';
export const go = () => { const src = readFileSync(new URL('${repo('packages/core/anthropic.ts')}'), 'utf8'); return fetch(/'(https:\\/\\/[^']+\\/v1\\/messages)'/.exec(src)[1], ${POST}); };`,
  'h-read-csp': `import { readFileSync } from 'node:fs';
export const go = () => { const html = readFileSync(new URL('${repo('apps/web/index.html')}'), 'utf8'); return fetch(/connect-src 'self' (https:\\/\\/[^;" ]+)/.exec(html)[1] + '/v1/messages', ${POST}); };`,
  'i-json-import': `import cfg from './host.json' with { type: 'json' }; export const go = () => fetch(cfg.url, ${POST});`,
  'j-eslint-disable-line': `export const go = () => fetch('https://${HOST}/v1/messages', ${POST});`,
  'k-url-object': `export const go = () => fetch(new URL('/v1/messages', 'https://${HOST.toUpperCase()}.'), ${POST});`,
  'l-to-string-swap': `let n = 0; const u = { toString: () => (n++ === 0 ? 'https://example.org/' : 'https://${HOST}/v1/messages') }; export const go = () => fetch(u, ${POST});`,
  'm-foreign-request': `export const go = () => fetch(new Request('https://${HOST}/v1/messages', ${POST}));`,
  'x-xhr': `export const go = () => { const x = new XMLHttpRequest(); x.open('POST', 'https://api%2Eanthropic.com/v1/messages'); x.send('{}'); };`,
  'x-websocket': `export const go = () => new WebSocket('wss://${HOST}/v1/messages');`,
  'x-eventsource': `export const go = () => new EventSource('https://${HOST}/v1/messages');`,
  'x-beacon': `export const go = () => navigator.sendBeacon('https://${HOST}/v1/messages', '{}');`,
  // The two hook plants (defect 2): the client's injected transport keeps what it was handed.
  'n-hook-replay': `${client}
export async function go(apiKey) {
  const { ledger } = openNodeLedger({ transport: 'live' });
  const grant = await ledger.batchStart(0.1);
  let captured;
  const c = new MessagesClient({ grant, ledger, apiKey, maxAttempts: 1, fetch: async (req) => { captured = req; return new Response('{}', { status: 401 }); } });
  await c.send([{ role: 'user', content: 'hi' }], { max_tokens: 1 }).catch(() => undefined);
  await grant.close();
  const errors = [];
  const tryFetch = async (...a) => { try { await fetch(...a); } catch (e) { errors.push(e.message); } };
  for (let i = 0; i < 3; i++) await tryFetch(captured.url, { method: 'POST', headers: captured.headers, body: '{"max_tokens":64000}' });
  await tryFetch(captured);
  if (errors.length < 4) return 'sent';
  throw new TypeError(errors.join(' | '));
}`,
  'o-hook-multisend': `${client}
export async function go(apiKey) {
  const { ledger } = openNodeLedger({ transport: 'live' });
  const grant = await ledger.batchStart(0.1);
  const errors = [];
  let first;
  const c = new MessagesClient({ grant, ledger, apiKey, maxAttempts: 1, fetch: async (req) => {
    for (const send of [() => fetch(req), () => fetch(req), () => fetch(req.clone()), () => fetch(new Request(req)), () => fetch(req, { body: '{"max_tokens":64000}' })]) {
      try { const r = await send(); first ??= r; } catch (e) { errors.push(e.message); }
    }
    return first;
  } });
  await c.send([{ role: 'user', content: 'hi' }], { max_tokens: 1 });
  await grant.close();
  throw new TypeError(errors.join(' | '));
}`,
  'p-hook-mutate': `${client}
export async function go(apiKey) {
  const { ledger } = openNodeLedger({ transport: 'live' });
  const grant = await ledger.batchStart(0.1);
  const c = new MessagesClient({ grant, ledger, apiKey, maxAttempts: 1, fetch: async (req) => { req.headers.set('anthropic-beta', 'server-tools'); return fetch(req); } });
  await c.send([{ role: 'user', content: 'hi' }], { max_tokens: 1 });
  await grant.close();
}`,
};

const RUNNER = `
const sends = [];
const record = (api, url) => sends.push({ api, host: new URL(String(url)).hostname });
const sse = (events) => events.map((e) => 'event: ' + e.type + '\\ndata: ' + JSON.stringify(e) + '\\n\\n').join('');
const OK = sse([
  { type: 'message_start', message: { id: 'm', model: 'claude-opus-5-5', role: 'assistant', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
  { type: 'message_stop' },
]);
globalThis.fetch = async (input, init) => { const r = input instanceof Request ? input : new Request(input, init); record('fetch', r.url); return new Response(OK, { status: 200 }); };
globalThis.XMLHttpRequest = class { open(_m, u) { this.u = u; } send() { record('xhr', this.u); } };
globalThis.WebSocket = class { constructor(u) { record('websocket', u); } };
globalThis.EventSource = class { constructor(u) { record('eventsource', u); } };
Object.defineProperty(globalThis.navigator, 'sendBeacon', { configurable: true, writable: true, value: (u) => { record('beacon', u); return true; } });
let guard = 'missing';
try {
  const { installEgressGuard } = await import(process.env.EGRESS_MODULE);
  installEgressGuard(globalThis);
  guard = 'installed';
} catch (e) { guard = 'missing: ' + e.message.split('\\n')[0]; }
const out = { guard, plants: {} };
for (const name of process.env.PLANTS.split(',')) {
  const before = sends.length;
  let error = null;
  try { await (await import('./' + name + '.mjs')).go(process.env.KEY); } catch (e) { error = e.message; }
  out.plants[name] = { sends: sends.slice(before), error };
}
if (process.env.CLIENT === '1') {
  const { MessagesClient } = await import(process.env.CLIENT_MODULE);
  const { openNodeLedger } = await import(process.env.LEDGER_MODULE);
  const { ledger } = openNodeLedger({ transport: 'live' });
  const grant = await ledger.batchStart(0.1);
  const before = sends.length;
  const r = await new MessagesClient({ grant, ledger, apiKey: process.env.KEY, maxAttempts: 1 }).send([{ role: 'user', content: 'hi' }], { max_tokens: 1 });
  await grant.close();
  out.client = { status: r.status, sends: sends.slice(before) };
}
process.stdout.write(JSON.stringify(out));
`;

function run(names: string[], opts: { client?: boolean } = {}) {
  const dir = tempDir('egress');
  write(dir, 'package.json', '{"type":"module"}');
  write(dir, 'host.json', JSON.stringify({ url: `https://${HOST}/v1/messages` }));
  write(dir, 'runner.mjs', RUNNER);
  for (const n of names) write(dir, `${n}.mjs`, PLANTS[n] ?? '');
  const home = tempDir('egress-home');
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '', HOME: home, SPEND_LEDGER: join(home, 'spend.jsonl'), KEY: fakeKey('E'), PLANTS: names.join(','),
    EGRESS_MODULE: repo('packages/core/egress.ts'), CLIENT_MODULE: repo('packages/core/anthropic.ts'), LEDGER_MODULE: repo('cli/adapters/ledger-node.ts'),
    CLIENT: opts.client ? '1' : '0',
  };
  const r = spawnSync(process.execPath, ['runner.mjs'], { cwd: dir, env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`runner exited ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout) as {
    guard: string;
    plants: Record<string, { sends: Array<{ api: string; host: string }>; error: string | null }>;
    client?: { status: number; sends: Array<{ api: string; host: string }> };
  };
}

describe('the egress guard refuses every send to the API host that MessagesClient did not make', () => {
  const names = Object.keys(PLANTS);
  const out = run(names, { client: true });

  it('installs', () => {
    expect(out.guard).toBe('installed');
  });

  it('l-to-string-swap: the URL is resolved once, so the request goes where the guard checked, never to the API host', () => {
    expect(out.plants['l-to-string-swap']).toEqual({ sends: [{ api: 'fetch', host: 'example.org' }], error: null });
  });

  it.each(names.filter((n) => n !== 'o-hook-multisend' && n !== 'l-to-string-swap'))('%s: refused, 0 sends', (name) => {
    const p = out.plants[name];
    expect(p?.sends).toEqual([]);
    expect(p?.error).toMatch(/egress guard/);
  });

  it('o-hook-multisend: the client request goes out once; the second fetch, a clone, a copy and an init override are refused', () => {
    const p = out.plants['o-hook-multisend'];
    expect(p?.sends).toEqual([{ api: 'fetch', host: HOST }]);
    expect(p?.error?.split(' | ')).toHaveLength(4);
    for (const e of p?.error?.split(' | ') ?? []) expect(e).toMatch(/egress guard/);
  });

  it('a MessagesClient call through the guarded global fetch still passes, once', () => {
    expect(out.client).toEqual({ status: 200, sends: [{ api: 'fetch', host: HOST }] });
  });
});

describe('entry points install the guard before anything else runs', () => {
  // The first top-level statements after the imports, by file. live-node.ts installs it as the
  // first statement of its run-as-script block, so importing it (tests do) changes no globals;
  // the probe page first keeps the fetch its relay forwards client Requests through.
  const firstStatements = (file: string, after?: RegExp) => {
    const lines = readFileSync(join(repoRoot, file), 'utf8').split('\n');
    const from = after ? lines.findIndex((l) => after.test(l)) + 1 : 0;
    return lines.slice(from).filter((l) => l.trim() !== '' && !l.trim().startsWith('//') && !/^import |^\s|^}|^\)|^declare /.test(l) || (after !== undefined && /^\s+\S/.test(l) && !l.trim().startsWith('//'))).map((l) => l.trim());
  };
  it.each([
    ['cli/index.ts', undefined, ['installEgressGuard(globalThis);']],
    ['apps/web/src/main.tsx', undefined, ['installEgressGuard(globalThis);']],
    ['apps/web/src/probe/main.ts', undefined, ['const send = globalThis.fetch.bind(globalThis);', 'installEgressGuard(globalThis);']],
    ['scripts/live-node.ts', /^if \(process\.argv\[1\]/, ['installEgressGuard(globalThis);']],
  ] as const)('%s installs the guard first', (file, after, expected) => {
    expect(firstStatements(file, after).slice(0, expected.length)).toEqual(expected);
  });

  it('pnpm live:node, run as a process with a stubbed network, sends its one call through the guard', () => {
    const dir = tempDir('egress-live');
    write(dir, 'stub.mjs', RUNNER.split('let guard')[0] + `const stubFetch = globalThis.fetch;\nprocess.on('exit', () => process.stderr.write('SENDS ' + JSON.stringify(sends) + ' WRAPPED ' + (globalThis.fetch !== stubFetch) + '\\n'));\n`);
    const home = tempDir('egress-home');
    const r = spawnSync(process.execPath, ['--import', pathToFileURL(join(dir, 'stub.mjs')).href, join(repoRoot, 'scripts/live-node.ts')], {
      cwd: repoRoot, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: home, SPEND_LEDGER: join(home, 'spend.jsonl'), ANTHROPIC_API_KEY: fakeKey('L') },
    });
    expect(r.stdout).toContain('status 200');
    expect(/SENDS (.*)/.exec(r.stderr)?.[1]).toBe(`${JSON.stringify([{ api: 'fetch', host: HOST }])} WRAPPED true`);
    expect(r.status).toBe(1); // the stubbed reply has no tool_use
  });
});
