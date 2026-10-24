// Shared by the runner tests: an in-process runner over temp HOME, runs dir and dist, a spy
// transport that answers like the API and records every outbound request, a raw HTTP client
// that can set Host and Origin, an SSE reader and a child-process launcher for main.ts.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { okResponse, scriptedTransport, SCENARIOS } from '../../web/src/harness/scenarios.ts';
import type { Transport } from '../../../packages/core/anthropic.ts';
import { parseSse, TOKEN_HEADER, type SseFrame } from '../../../packages/core/runner-api.ts';
import { startRunner, type Runner, type RunnerOptions } from '../server.ts';

// A test that inherited the live-run form's marker would meter into the canonical ledger.
delete process.env.CLINENV_CANONICAL_LEDGER;

export const REPO = fileURLToPath(new URL('../../../', import.meta.url));
export const MAIN = join(REPO, 'apps/runner/main.ts');
export const BASE = '/clinical-agent-env/';

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

// Two sentinel keys built at runtime, so no key-shaped literal is committed: one plain, one
// sk-ant-shaped (the shape keyscan and redaction look for).
export function sentinels(): { plain: string; skAnt: string } {
  return {
    plain: `clinenv-sentinel-${randomBytes(16).toString('hex')}`,
    skAnt: ['sk', 'ant', 'api03', randomBytes(36).toString('base64url')].join('-'),
  };
}

// The CSP meta content of apps/web/index.html: the design string the built page must carry.
export function designCsp(): string {
  const html = readFileSync(join(REPO, 'apps/web/index.html'), 'utf8');
  const m = /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html);
  if (!m) throw new Error('apps/web/index.html has no CSP meta');
  return m[1] as string;
}

export function cspMeta(html: string): string | null {
  return /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)?.[1] ?? null;
}

export function tokenMeta(html: string): string | null {
  return /<meta name="clinenv-runner-token" content="([^"]*)"/.exec(html)?.[1] ?? null;
}

// A stand-in for apps/web/dist: index.html with the design CSP meta, assets/, data/ and the two
// test pages the runner must never serve.
export function fakeDist(): string {
  const dir = tempDir('runner-dist');
  const write = (rel: string, text: string) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };
  write('index.html', `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${designCsp()}" />\n    <title>t</title>\n    <script type="module" crossorigin src="${BASE}assets/index-abc.js"></script>\n  </head>\n  <body><div id="root"></div></body>\n</html>\n`);
  write('assets/index-abc.js', 'console.log("app");\n');
  write('assets/index-abc.css', 'body{}\n');
  write('data/tasks.json', '{"tasks":[]}\n');
  write('api/health', '{"app":"static","surface":"browser-direct"}');
  write('probe.html', '<!doctype html><title>probe</title>');
  write('harness.html', '<!doctype html><title>harness</title>');
  return dir;
}

export interface Call {
  label: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}

export const jsonError = (status: number, type: string, message: string): Response =>
  new Response(JSON.stringify({ type: 'error', error: { type, message } }), { status, headers: { 'content-type': 'application/json' } });

// A transport factory that records each Request and answers it: by `answer` when it returns a
// Response, else the Validate call with a short text and each trial with the toy scenario.
export type Answer = (label: string, n: number, call: Call) => Response | undefined | Promise<Response | undefined>;

export function spyTransport(calls: Call[], answer?: Answer): (label: string) => Transport {
  return (label) => {
    const toy = scriptedTransport(SCENARIOS.toy);
    let n = 0;
    return async (request) => {
      const body = await request.clone().text();
      const call: Call = { label, url: request.url, method: request.method, headers: Object.fromEntries(request.headers), body, signal: request.signal };
      calls.push(call);
      n++;
      const custom = await answer?.(label, n, call);
      if (custom) return custom;
      if (label.includes('validate')) return okResponse({ text: 'ok' }, 1);
      return toy.transport(request);
    };
  };
}

// An Answer that holds every trial call until its signal aborts (the Validate call answers).
// The held calls stay in `held`, strongly referenced: a request's signal follows the client's
// only weakly, so a stalled call nothing else holds can be collected with its abort listener
// and never end (verifier P12b-2 O1).
export function stallAnswer(held: Set<object> = new Set()): Answer {
  return (label, _n, call) => {
    if (label.includes('validate')) return undefined;
    const entry: { signal: AbortSignal; response?: Promise<Response> } = { signal: call.signal };
    held.add(entry);
    entry.response = new Promise<Response>((_, reject) =>
      call.signal.addEventListener('abort', () => {
        held.delete(entry);
        reject(call.signal.reason);
      }, { once: true }));
    return entry.response;
  };
}

export interface Launched {
  runner: Runner;
  port: number;
  home: string;
  env: Record<string, string | undefined>;
  logs: string[];
  calls: Call[];
  dist: string;
  http: (method: string, path: string, opts?: HttpOpts) => Promise<HttpResult>;
}

// transport null: the runner's own (the toy scenario under mock); default the spy.
export async function launch(over: Partial<Omit<RunnerOptions, 'transport'>> & { transport?: RunnerOptions['transport'] | null; answer?: Answer } = {}): Promise<Launched> {
  const home = tempDir('runner-home');
  const { answer, env: envOver, transport, ...rest } = over;
  const env = { HOME: home, CLINENV_RUNS_DIR: join(home, 'runs'), ...envOver };
  const logs: string[] = [];
  const calls: Call[] = [];
  const dist = rest.dist ?? fakeDist();
  const spy = transport === null ? {} : { transport: transport ?? spyTransport(calls, answer) };
  const runner = await startRunner({ env, mock: false, port: 0, dist, log: (l) => logs.push(l), pingMs: 100, sleep: async () => {}, ...spy, ...rest });
  const port = runner.port;
  return { runner, port, home, env, logs, calls, dist, http: (method, path, opts = {}) => http(port, method, path, { token: runner.token, ...opts }) };
}

export interface HttpOpts {
  headers?: Record<string, string>;
  body?: unknown;
  // The X-Clinenv-Token value; false sends none.
  token?: string | false;
  host?: string;
  // The Origin header; null sends none. Default: http://<host> on any method but GET and HEAD.
  origin?: string | null;
  contentType?: string;
}

export interface HttpResult {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
  json: () => unknown;
}

// One request over node:http, which sends Host and Origin exactly as given.
export function http(port: number, method: string, path: string, opts: HttpOpts = {}): Promise<HttpResult> {
  const host = opts.host ?? `127.0.0.1:${port}`;
  const headers: Record<string, string> = { host, ...opts.headers };
  const origin = opts.origin === undefined ? (method === 'GET' || method === 'HEAD' ? null : `http://${host}`) : opts.origin;
  if (origin !== null) headers.origin = origin;
  if (opts.token) headers[TOKEN_HEADER] = opts.token;
  let payload: string | undefined;
  if (opts.body !== undefined) {
    payload = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    headers['content-type'] = opts.contentType ?? 'application/json';
    headers['content-length'] = String(Buffer.byteLength(payload));
  }
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers, setHost: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json: () => JSON.parse(text) });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

export interface SseResult {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
  frames: SseFrame[];
}

// Reads a trial's event stream until the runner closes it (or timeoutMs passes, which fails).
export function readSse(port: number, path: string, opts: { token: string; lastEventId?: string; host?: string; timeoutMs?: number }): Promise<SseResult> {
  const host = opts.host ?? `127.0.0.1:${port}`;
  const headers: Record<string, string> = { host, accept: 'text/event-stream', [TOKEN_HEADER]: opts.token };
  if (opts.lastEventId !== undefined) headers['last-event-id'] = opts.lastEventId;
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method: 'GET', path, headers, setHost: false }, (res) => {
      let text = '';
      const timer = setTimeout(() => {
        req.destroy();
        reject(new Error(`SSE ${path} still open after ${opts.timeoutMs ?? 30_000} ms:\n${text.slice(-500)}`));
      }, opts.timeoutMs ?? 30_000);
      res.setEncoding('utf8');
      res.on('data', (c: string) => (text += c));
      res.on('end', () => {
        clearTimeout(timer);
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, frames: parseSse(text).frames });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

export const until = async (what: string, ok: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!(await ok())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

export interface Child {
  child: ChildProcessWithoutNullStreams;
  stdout: () => string;
  stderr: () => string;
  // The URL main.ts prints.
  url: Promise<string>;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

// node apps/runner/main.ts as a child, with exactly `env` (plus PATH).
export function spawnRunner(args: string[], env: Record<string, string | undefined>): Child {
  const clean: Record<string, string> = { PATH: process.env.PATH ?? '' };
  for (const [k, v] of Object.entries(env)) if (v !== undefined) clean[k] = v;
  const child = spawn(process.execPath, [MAIN, ...args], { env: clean, cwd: REPO });
  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  const url = new Promise<string>((resolve, reject) => {
    child.stdout.on('data', (c: string) => {
      out += c;
      const m = /^clinenv local runner: (http:\/\/127\.0\.0\.1:\d+\/clinical-agent-env\/)$/m.exec(out);
      if (m) resolve(m[1] as string);
    });
    child.on('exit', () => reject(new Error(`runner exited before printing its URL:\n${out}\n${err}`)));
  });
  url.catch(() => {});
  child.stderr.on('data', (c: string) => (err += c));
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  return { child, stdout: () => out, stderr: () => err, url, exit };
}

export const portOf = (url: string): number => Number(new URL(url).port);

// A POST /api/trials body for one _toy trial.
export const toyTrial = (over: Record<string, unknown> = {}) => ({ tasks: ['_toy'], trials: 1, concurrency: 1, effort: 'high', session_cap_usd: 50, ...over });
