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
  // pr-review-P2-9 defect 1: the guard must read a Request's url and headers from its internal
  // slots, not from properties the caller can shadow.
  'q-url-shadow': `export const go = () => { const r = new Request('https://${HOST}/v1/messages', ${POST}); Object.defineProperty(r, 'url', { value: 'https://example.test/' }); return fetch(r); };`,
  'r-request-subclass': `class R extends Request { get url() { return 'https://example.test/'; } }
export const go = () => fetch(new R('https://${HOST}/v1/messages', ${POST}));`,
  's-prototype-url-patch': `export async function go() {
  const d = Object.getOwnPropertyDescriptor(Request.prototype, 'url');
  Object.defineProperty(Request.prototype, 'url', { configurable: true, get: () => 'https://example.test/' });
  try { return await fetch(new Request('https://${HOST}/v1/messages', ${POST})); } finally { Object.defineProperty(Request.prototype, 'url', d); }
}`,
  't-transport-header-swap': `${client}
export async function go(apiKey) {
  const { ledger } = openNodeLedger({ transport: 'live' });
  const grant = await ledger.batchStart(0.1);
  const c = new MessagesClient({ grant, ledger, apiKey, maxAttempts: 1, fetch: async (req) => {
    const shown = new Headers(req.headers);
    req.headers.set('anthropic-beta', 'context-1m-2025-08-07');
    Object.defineProperty(req, 'headers', { value: shown });
    return fetch(req);
  } });
  try { await c.send([{ role: 'user', content: 'hi' }], { max_tokens: 1 }); } finally { await grant.close(); }
}`,
  'u-transport-copies': `${client}
export async function go(apiKey) {
  const { ledger } = openNodeLedger({ transport: 'live' });
  const grant = await ledger.batchStart(0.1);
  const errors = [];
  const c = new MessagesClient({ grant, ledger, apiKey, maxAttempts: 1, fetch: async (req) => {
    const copies = [1, 2, 3].map(() => { const r = new Request(req, { body: '{"max_tokens":64000}' }); Object.defineProperty(r, 'url', { value: 'https://example.test/' }); return r; });
    const res = await fetch(req);
    for (const r of copies) { try { await fetch(r); } catch (e) { errors.push(e.message); } }
    return res;
  } });
  await c.send([{ role: 'user', content: 'hi' }], { max_tokens: 1 });
  await grant.close();
  throw new TypeError(errors.join(' | '));
}`,
  // pr-review-P2-9 defect 2: a dispatcher in init would pick the host below the guard.
  'v-dispatcher-init': `const dispatcher = { dispatch: () => { throw new Error('dispatcher used'); } };
export async function go() {
  await fetch('https://example.test/v1/messages', { ...${POST}, dispatcher });
  await fetch(new Request('https://example.test/v1/messages', ${POST}), { dispatcher });
  await fetch('https://example.test/v1/messages', Object.create({ dispatcher }));
}`,
};

const RUNNER = `
const sends = [];
// What the platform would send: a Request's internal slots, never a property a plant shadowed.
// Reading Request loads undici, which sets the global dispatcher.
const nativeUrl = Object.getOwnPropertyDescriptor(Request.prototype, 'url').get;
// A dispatcher other than the global one (the Agent at install, or the guarded one that replaces
// it in the slot) would pick the connection below the guard.
const agent = globalThis[Symbol.for('undici.globalDispatcher.2')];
const foreign = (init) => init?.dispatcher !== undefined && init.dispatcher !== agent && init.dispatcher !== globalThis[Symbol.for('undici.globalDispatcher.2')];
const record = (api, url, init) => sends.push({ api, host: new URL(String(url)).hostname, ...(foreign(init) ? { dispatcher: true } : {}) });
const sse = (events) => events.map((e) => 'event: ' + e.type + '\\ndata: ' + JSON.stringify(e) + '\\n\\n').join('');
const OK = sse([
  { type: 'message_start', message: { id: 'm', model: 'claude-opus-5-5', role: 'assistant', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
  { type: 'message_stop' },
]);
globalThis.fetch = async (input, init) => { const r = input instanceof Request ? input : new Request(input, init); record('fetch', nativeUrl.call(r), init); return new Response(OK, { status: 200 }); };
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

  const MIXED = ['o-hook-multisend', 'l-to-string-swap', 'u-transport-copies', 'v-dispatcher-init'];
  it.each(names.filter((n) => !MIXED.includes(n)))('%s: refused, 0 sends', (name) => {
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

  it('u-transport-copies: the registered Request goes out once; 3 copies with a shadowed url are refused', () => {
    const p = out.plants['u-transport-copies'];
    expect(p?.sends).toEqual([{ api: 'fetch', host: HOST }]);
    expect(p?.error?.split(' | ')).toHaveLength(3);
    for (const e of p?.error?.split(' | ') ?? []) expect(e).toMatch(/egress guard/);
  });

  it('v-dispatcher-init: a dispatcher key in init, own or inherited, is dropped, so the checked host is the one contacted', () => {
    const sent = { api: 'fetch', host: 'example.test' };
    expect(out.plants['v-dispatcher-init']).toEqual({ sends: [sent, sent, sent], error: null });
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

describe('Node fetch never sees a dispatcher the caller passed', () => {
  // Real fetch against local servers. Each route hands fetch a dispatcher that reroutes the
  // connection from the checked host to a second server, the stand-in for the API host. Guard off
  // is the control: the same call reaches the second server.
  const CHILD = `
import { createServer } from 'node:http';
const listen = async (hits) => { const srv = createServer((req, res) => { hits.push(req.url); res.end('ok'); }); await new Promise((r) => srv.listen(0, '127.0.0.1', r)); return srv; };
const checkedHits = [], otherHits = [];
const checked = await listen(checkedHits), other = await listen(otherHits);
const otherOrigin = 'http://127.0.0.1:' + other.address().port;
const agent = globalThis[Symbol.for('undici.globalDispatcher.2')];
const used = [];
const dispatcher = { dispatch: (opts, handler) => { used.push('dispatch'); return agent.dispatch({ ...opts, origin: otherOrigin }, handler); } };
if (process.env.GUARD === '1') (await import(process.env.EGRESS_MODULE)).installEgressGuard(globalThis);
const url = 'http://127.0.0.1:' + checked.address().port + '/x';
const init = Object.assign(() => undefined, { dispatcher });
const routes = {
  init: () => fetch(url, { dispatcher }),
  'request-ctor': () => fetch(new Request(url, { dispatcher })),
  'request-copy': () => fetch(new Request(new Request(url, { dispatcher }))),
  'request-ctor-init-undefined': () => fetch(new Request(url, { dispatcher }), { dispatcher: undefined }),
  'init-function': () => fetch(url, init),
};
let error = null;
try { await (await routes[process.env.ROUTE]()).text(); } catch (e) { error = e.message; }
checked.close(); other.close();
process.stdout.write(JSON.stringify({ checked: checkedHits, other: otherHits, used, error }));
`;
  const runChild = (guard: boolean, route: string) => {
    const dir = tempDir('egress-dispatcher');
    write(dir, 'child.mjs', CHILD);
    const r = spawnSync(process.execPath, [join(dir, 'child.mjs')], {
      encoding: 'utf8', env: { PATH: process.env.PATH ?? '', GUARD: guard ? '1' : '0', ROUTE: route, EGRESS_MODULE: repo('packages/core/egress.ts') },
    });
    if (r.status !== 0) throw new Error(`child exited ${r.status}: ${r.stderr}`);
    return JSON.parse(r.stdout) as { checked: string[]; other: string[]; used: string[]; error: string | null };
  };
  const ROUTES = ['init', 'request-ctor', 'request-copy', 'request-ctor-init-undefined', 'init-function'];

  it.each(ROUTES)('guard on, %s: the request goes through the global dispatcher to the host fetch was given', (route) => {
    expect(runChild(true, route)).toEqual({ checked: ['/x'], other: [], used: [], error: null });
  });

  it.each(ROUTES)('control, guard off, %s: the passed dispatcher reroutes the request', (route) => {
    expect(runChild(false, route)).toEqual({ checked: [], other: ['/x'], used: ['dispatch'], error: null });
  });
});

describe('the guard owns undici\'s global dispatcher slots', () => {
  // Real undici against a local TLS stub. Before the guard installs, each child points undici's
  // global Agent at the stub, so a request to the API host lands there (SNI and Host intact)
  // instead of leaving the machine. Every route then reaches for the API host below fetch: the
  // slot dispatchers by each of their methods, the verifier's x3b plant (P2h-1), a fetch captured
  // before install, a redirect from another host and a swap of the slots. Guard off is the control.
  const certDir = tempDir('egress-tls');
  const openssl = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=stub', '-keyout', join(certDir, 'key.pem'), '-out', join(certDir, 'cert.pem')], { encoding: 'utf8' });
  if (openssl.status !== 0) throw new Error(`openssl: ${openssl.stderr}`);

  // The plant from evidence/verifier-phase-P2h-1/plants/ev/x3b-runtime-name-on-globalthis-typed.ts.
  const X3B = `const HOST = ["api", "anthropic", "com"].join(".");
interface R { statusCode: number; body: { text(): Promise<string> } }
interface D { request(o: object): Promise<R> }
async function send(d: D | undefined, which: string, key: string): Promise<string> {
  if (!d || typeof d.request !== "function") return \`no dispatcher at .\${which}\`;
  const r = await d.request({ origin: \`https://\${HOST}\`, path: "/v1/messages", method: "POST", headers: { "x-api-key": key, "content-type": "application/json" }, body: "{}" });
  await r.body.text();
  return \`status \${r.statusCode}\`;
}
const keyOf = (which: string): string => [["un", "dici"].join(""), "globalDispatcher", which].join(".");
export async function run(which: string, key: string): Promise<string> {
  await fetch("data:,");
  const S = (globalThis as unknown as Record<string, unknown>)[["Sym", "bol"].join("")] as { for(k: string): symbol };
  return send(Reflect.get(globalThis, S.for(keyOf(which))) as D | undefined, which, key);
}
`;

  const CHILD = `
import { createServer } from 'node:https';
import { connect as tlsConnect } from 'node:tls';
import { readFileSync } from 'node:fs';
import { Writable } from 'node:stream';
const API = ['api', 'anthropic', 'com'].join('.');
const OTHER = 'example.test';
const KEY = process.env.KEY;
const S1 = Symbol.for('undici.globalDispatcher.1'), S2 = Symbol.for('undici.globalDispatcher.2');
const sse = (events) => events.map((e) => 'event: ' + e.type + '\\ndata: ' + JSON.stringify(e) + '\\n\\n').join('');
const OK = sse([
  { type: 'message_start', message: { id: 'm', model: 'claude-opus-5-5', role: 'assistant', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
  { type: 'message_stop' },
]);
const hits = [];
const hostOf = (req) => (req.headers.host ?? '').replace(/:\\d+$/, '');
const server = createServer({ key: readFileSync(process.env.KEY_PEM), cert: readFileSync(process.env.CERT_PEM) }, (req, res) => {
  hits.push({ kind: 'request', host: hostOf(req) });
  req.resume();
  req.on('end', () => {
    if (req.url === '/redirect') { res.writeHead(307, { location: 'https://' + API + '/v1/messages' }); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(OK);
  });
});
server.on('secureConnection', (s) => hits.push({ kind: 'tls', host: s.servername || null }));
server.on('connect', (req, socket) => { hits.push({ kind: 'connect', host: hostOf(req) }); socket.end('HTTP/1.1 200 Connection Established\\r\\n\\r\\n'); });
server.on('upgrade', (req, socket) => { hits.push({ kind: 'upgrade', host: hostOf(req) }); socket.end('HTTP/1.1 101 Switching Protocols\\r\\nconnection: upgrade\\r\\nupgrade: websocket\\r\\n\\r\\n'); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

// Point undici's global Agent (both slots, as setGlobalDispatcher does) at the stub.
await fetch('data:,');
const Agent = globalThis[S2].constructor, Legacy = globalThis[S1].constructor;
const toStub = (opts, cb) => {
  const s = tlsConnect({ host: '127.0.0.1', port, servername: opts.servername || opts.hostname, rejectUnauthorized: false, ALPNProtocols: ['http/1.1'] });
  s.once('secureConnect', () => cb(null, s));
  s.once('error', (e) => cb(e));
};
const stub = new Agent({ connect: toStub });
globalThis[S2] = stub;
globalThis[S1] = new Legacy(stub);
const early = globalThis.fetch;
if (process.env.GUARD === '1') (await import(process.env.EGRESS_MODULE)).installEgressGuard(globalThis);

const POST = { method: 'POST', headers: { 'x-api-key': KEY, 'content-type': 'application/json' }, body: '{}' };
const apiOpts = () => ({ origin: 'https://' + API, path: '/v1/messages', ...POST });
const slot = (n) => globalThis[n === '1' ? S1 : S2];
const METHODS = {
  request: (d) => d.request(apiOpts()).then((r) => r.body.text()),
  dispatch: (d) => new Promise((resolve, reject) => d.dispatch(apiOpts(), {
    onRequestStart() {}, onResponseStart() {}, onResponseData() {}, onResponseEnd: () => resolve('end'), onResponseError: (_c, e) => reject(e),
  })),
  stream: (d) => d.stream(apiOpts(), () => new Writable({ write: (_c, _e, cb) => cb() })),
  pipeline: (d) => new Promise((resolve, reject) => {
    const p = d.pipeline(apiOpts(), ({ body }) => body);
    p.on('error', reject).on('data', () => undefined).on('end', () => resolve('end'));
    p.end();
  }),
  connect: (d) => d.connect({ origin: 'https://' + API, path: '/' }).then(({ socket }) => socket.destroy()),
  upgrade: (d) => d.upgrade({ origin: 'https://' + API, path: '/' }).then(({ socket }) => socket.destroy()),
  compose: (d) => d.compose((dispatch) => (opts, handler) => dispatch(opts, handler)).request(apiOpts()).then((r) => r.body.text()),
};
const routes = {
  'x3b-1': async () => (await import('./x3b.ts')).run('1', KEY),
  'x3b-2': async () => (await import('./x3b.ts')).run('2', KEY),
  'early-fetch-api': () => early('https://' + API + '/v1/messages', POST).then((r) => r.text()),
  'early-fetch-other': () => early('https://' + OTHER + '/ok').then((r) => r.status),
  'fetch-other': () => fetch('https://' + OTHER + '/ok').then((r) => r.status),
  redirect: () => fetch('https://' + OTHER + '/redirect', POST).then((r) => r.status),
  swap: async () => {
    const fresh = new Agent({ connect: toStub });
    const errors = [];
    for (const s of [S2, S1]) {
      try { globalThis[s] = fresh; } catch (e) { errors.push('assign: ' + e.constructor.name); }
      try { Object.defineProperty(globalThis, s, { value: fresh, writable: true, enumerable: false, configurable: false }); } catch (e) { errors.push('define: ' + e.constructor.name); }
    }
    const swapped = [S2, S1].map((s) => globalThis[s] === fresh);
    let sent = null;
    try { sent = (await early('https://' + API + '/v1/messages', POST)).status; } catch (e) { sent = e.cause?.message ?? e.message; }
    return { errors, swapped, sent };
  },
};
for (const n of ['1', '2']) for (const [m, call] of Object.entries(METHODS)) routes['slot' + n + '-' + m] = () => call(slot(n));
if (process.env.CLIENT === '1') routes.client = async () => {
  const { MessagesClient } = await import(process.env.CLIENT_MODULE);
  const { openNodeLedger } = await import(process.env.LEDGER_MODULE);
  const { ledger } = openNodeLedger({ transport: 'live' });
  const grant = await ledger.batchStart(0.1);
  try { return (await new MessagesClient({ grant, ledger, apiKey: KEY, maxAttempts: 1 }).send([{ role: 'user', content: 'hi' }], { max_tokens: 1 })).status; } finally { await grant.close(); }
};

const message = (e) => [e?.message, e?.cause?.message].filter(Boolean).join(' / ');
const out = {};
for (const [name, call] of Object.entries(routes)) {
  const before = hits.length;
  let value = null, error = null;
  try {
    value = await Promise.race([call(), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))]);
  } catch (e) { error = message(e); }
  const seen = hits.slice(before);
  // HTTP requests (CONNECT and Upgrade included) by Host, and TLS handshakes by SNI.
  const http = (host) => seen.filter((h) => h.kind !== 'tls' && h.host === host).length;
  out[name] = { api: http(API), apiTls: seen.filter((h) => h.kind === 'tls' && h.host === API).length, other: http(OTHER), value: value ?? null, error };
}
process.stdout.write(JSON.stringify({ routes: out, apiTotal: hits.filter((h) => h.kind !== 'tls' && h.host === API).length }));
process.exit(0);
`;

  type Route = { api: number; apiTls: number; other: number; value: unknown; error: string | null };
  const runSlots = (guard: boolean) => {
    const dir = tempDir('egress-slots');
    write(dir, 'package.json', '{"type":"module"}');
    write(dir, 'child.mjs', CHILD);
    write(dir, 'x3b.ts', X3B);
    const home = tempDir('egress-home');
    const r = spawnSync(process.execPath, [join(dir, 'child.mjs')], {
      cwd: dir, encoding: 'utf8', env: {
        PATH: process.env.PATH ?? '', HOME: home, SPEND_LEDGER: join(home, 'spend.jsonl'), KEY: fakeKey('S'), GUARD: guard ? '1' : '0', CLIENT: '1',
        KEY_PEM: join(certDir, 'key.pem'), CERT_PEM: join(certDir, 'cert.pem'),
        EGRESS_MODULE: repo('packages/core/egress.ts'), CLIENT_MODULE: repo('packages/core/anthropic.ts'), LEDGER_MODULE: repo('cli/adapters/ledger-node.ts'),
      },
    });
    if (r.status !== 0) throw new Error(`child exited ${r.status}: ${r.stderr}`);
    return JSON.parse(r.stdout) as { routes: Record<string, Route>; apiTotal: number };
  };
  const on = runSlots(true);
  const off = runSlots(false);

  const METHODS = ['request', 'dispatch', 'stream', 'pipeline', 'connect', 'upgrade', 'compose'];
  const REFUSED = ['x3b-1', 'x3b-2', ...['1', '2'].flatMap((n) => METHODS.map((m) => `slot${n}-${m}`)), 'early-fetch-api', 'redirect'];

  it.each(REFUSED)('guard on, %s: refused, 0 requests reach the API stub', (name) => {
    const r = on.routes[name];
    expect(r?.api).toBe(0);
    expect(r?.apiTls).toBe(0);
    expect(r?.error).toMatch(/egress guard/);
  });

  it.each(REFUSED)('control, guard off, %s: reaches the API stub', (name) => {
    expect(off.routes[name]?.api).toBeGreaterThan(0);
  });

  it('a redirect from another host is refused at the hop to the API host', () => {
    expect(on.routes.redirect).toMatchObject({ api: 0, apiTls: 0, other: 1 });
  });

  it('after install the slots cannot be swapped: each assignment and defineProperty throws, and the slots still refuse', () => {
    expect(on.routes.swap?.value).toEqual({
      errors: ['assign: TypeError', 'define: TypeError', 'assign: TypeError', 'define: TypeError'],
      swapped: [false, false],
      sent: expect.stringMatching(/egress guard/),
    });
    expect(on.routes.swap).toMatchObject({ api: 0, apiTls: 0 });
    expect(off.routes.swap?.value).toMatchObject({ errors: [], swapped: [true, true], sent: 200 });
  });

  it('a fetch with no dispatcher of its own goes through the guarded slot: another host answers, the API host is refused', () => {
    expect(on.routes['early-fetch-other']).toMatchObject({ api: 0, apiTls: 0, other: 1, value: 200, error: null });
    expect(on.routes['fetch-other']).toMatchObject({ api: 0, apiTls: 0, other: 1, value: 200, error: null });
    expect(on.routes['early-fetch-api']).toMatchObject({ api: 0, apiTls: 0, value: null });
  });

  it('MessagesClient still sends exactly once, the only request from this process the API stub saw', () => {
    expect(on.routes.client).toMatchObject({ api: 1, other: 0, value: 200, error: null });
    expect(on.apiTotal).toBe(1);
  });
});
