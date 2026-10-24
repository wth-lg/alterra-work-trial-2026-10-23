// Gate case (2), key secrecy. Two runtime-built sentinel keys (one plain, one sk-ant-shaped) go to
// POST /api/key and in a POST /api/trials body; then a mocked trial, a mocked 401 Validate, a
// mocked 500, a cancel and a shutdown. The sentinel must appear in no captured stdout or stderr,
// no request-log line, no file under CLINENV_RUNS_DIR, no ledger row, and no response body or
// header (the full SSE streams included). The spy transport sees every outbound request: each
// goes to the Messages URL, and its x-api-key header is the only place the sentinel leaves the
// process. A runner whose environment holds ANTHROPIC_API_KEY never reads it, and a key in a
// query string gets 400.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isApiHost } from '../../../packages/core/anthropic.ts';
import {
  fakeDist, http, jsonError, launch, readSse, sentinels, spawnRunner, stallAnswer, tempDir, tokenMeta, toyTrial, until, type HttpResult, type Launched, type SseResult,
} from './helpers.ts';

const filesUnder = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name)) : [];

let printed = '';
beforeEach(() => {
  printed = '';
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream);
    vi.spyOn(stream, 'write').mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
      printed += String(chunk);
      return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof stream.write);
  }
});
afterEach(() => vi.restoreAllMocks());

const isMessagesUrl = (u: string) => {
  const url = new URL(u);
  return url.protocol === 'https:' && isApiHost(url.hostname) && url.pathname === '/v1/messages' && url.search === '';
};

describe('key secrecy (gate case 2)', () => {
  for (const kind of ['plain', 'skAnt'] as const) {
    it(`keeps a ${kind} sentinel key out of every log, file, ledger row and response`, async () => {
      const key = sentinels()[kind];
      let mode: 'ok' | '401' | '500' | 'stall' = 'ok';
      const stall = stallAnswer();
      const l: Launched = await launch({
        answer: (label, n, call) => {
          if (label.includes('validate') && mode === '401') return jsonError(401, 'authentication_error', `invalid x-api-key: ${key}`);
          if (label.includes('validate') && mode === '500') return jsonError(500, 'api_error', `internal error for ${key}`);
          if (mode === 'stall') return stall(label, n, call);
          return undefined;
        },
      });
      const responses: Array<HttpResult | SseResult> = [];
      const send = async (method: string, path: string, body?: unknown) => {
        const r = await l.http(method, path, body === undefined ? {} : { body });
        responses.push(r);
        return r;
      };
      try {
        await send('GET', '/api/health');
        expect((await send('POST', '/api/key', { key })).status).toBe(200);
        expect((await send('GET', '/api/health')).json()).toMatchObject({ key_loaded: true });

        // A mocked trial, with the key in the trials body too.
        const a = (await send('POST', '/api/trials', toyTrial({ key }))).json() as { run_id: string; trial_ids: string[] };
        const stream = await readSse(l.port, `/api/trials/${a.trial_ids[0]}/events`, { token: l.runner.token });
        responses.push(stream);
        expect(stream.frames.at(-1)?.event).toBe('graded');
        await send('GET', `/api/trials/${a.trial_ids[0]}`);
        await send('GET', '/api/runs');

        // A mocked 401 Validate and a mocked 500: the answer is the class's fixed message, with
        // no upstream text to redact (security review P12b-4 G2).
        mode = '401';
        const e401 = await send('POST', '/api/key', { key });
        expect(e401.status).toBe(401);
        expect(e401.json()).toEqual({ error: { type: 'authentication_error', message: 'The API refused this key (unauthorized). Check the key and press Validate again.' } });
        mode = '500';
        const e500 = await send('POST', '/api/key', { key });
        expect(e500.status).toBeGreaterThanOrEqual(500);

        // A cancel mid-call, with the key in the body.
        mode = 'stall';
        const c = (await send('POST', '/api/trials', toyTrial({ key }))).json() as { trial_ids: string[] };
        const calls = l.calls.length;
        await until('the stalled call', () => l.calls.length > calls);
        await send('DELETE', `/api/trials/${c.trial_ids[0]}`);
        responses.push(await readSse(l.port, `/api/trials/${c.trial_ids[0]}/events`, { token: l.runner.token }));
        await send('GET', `/api/trials/${c.trial_ids[0]}`);

        // The key in a query string: refused, never logged.
        expect((await send('POST', `/api/key?key=${encodeURIComponent(key)}`, { key })).status).toBe(400);
        expect((await send('GET', `/api/health?api_key=${encodeURIComponent(key)}`)).status).toBe(400);
        expect((await send('GET', `/clinical-agent-env/?key=${encodeURIComponent(key)}`)).status).toBe(400);
        await send('DELETE', '/api/key');
      } finally {
        await l.runner.shutdown();
      }

      const ledger = join(l.home, '.clinenv', 'spend.jsonl');
      expect(existsSync(ledger)).toBe(true);
      const haystacks: Array<[string, string]> = [
        ['stdout and stderr', printed],
        ['request log', l.logs.join('\n')],
        ['ledger', readFileSync(ledger, 'utf8')],
        ...filesUnder(l.env.CLINENV_RUNS_DIR as string).map((f): [string, string] => [f, readFileSync(f, 'utf8')]),
        ...filesUnder(join(l.home, '.clinenv')).map((f): [string, string] => [f, readFileSync(f, 'utf8')]),
        ...responses.map((r, i): [string, string] => [`response ${i}`, `${JSON.stringify(r.headers)}\n${r.text}`]),
      ];
      expect(filesUnder(l.env.CLINENV_RUNS_DIR as string).length).toBeGreaterThan(0);
      expect(l.logs.some((line) => /^POST \/api\/key 400 \d+ms$/.test(line))).toBe(true);
      for (const [where, text] of haystacks) expect(text.includes(key), where).toBe(false);

      // Every outbound request went to the Messages URL, with the key only in x-api-key.
      expect(l.calls.length).toBeGreaterThanOrEqual(5);
      for (const call of l.calls) {
        expect(isMessagesUrl(call.url), call.url).toBe(true);
        expect(call.method).toBe('POST');
        expect(call.headers['x-api-key']).toBe(key);
        const elsewhere = Object.entries(call.headers).filter(([h, v]) => h !== 'x-api-key' && v.includes(key));
        expect(elsewhere).toEqual([]);
        expect(call.body.includes(key)).toBe(false);
      }
    });
  }

  it('never reads ANTHROPIC_API_KEY: key_loaded false, and a trial is refused with 0 calls', async () => {
    const key = sentinels().skAnt;
    const l = await launch({ env: { ANTHROPIC_API_KEY: key } });
    try {
      expect((await l.http('GET', '/api/health')).json()).toMatchObject({ key_loaded: false });
      const r = await l.http('POST', '/api/trials', { body: toyTrial() });
      expect(r.status).toBe(409);
      expect(r.text).not.toContain(key);
      expect(l.calls).toHaveLength(0);
    } finally {
      await l.runner.shutdown();
    }
  });

  it('a child runner\'s stdout and stderr hold no sentinel after a key, a trial and SIGINT', async () => {
    const key = sentinels().skAnt;
    const home = tempDir('runner-secrecy');
    const runs = join(home, 'runs');
    const c = spawnRunner(['--port', '0'], {
      HOME: home, CLINENV_RUNS_DIR: runs, NODE_ENV: 'test', CLINENV_TEST_HOOKS: '1', CLINENV_RUNNER_TEST_TRANSPORT: 'toy', ANTHROPIC_API_KEY: key,
      CLINENV_WEB_DIST: join(home, 'no-dist'),
    });
    const port = Number(new URL(await c.url).port);
    // Started with ANTHROPIC_API_KEY in its environment, it holds no key.
    expect((await http(port, 'GET', '/api/health')).json()).toMatchObject({ key_loaded: false });
    c.child.kill('SIGINT');
    expect((await c.exit).code).toBe(0);
    const d = spawnRunner(['--port', '0'], { HOME: home, CLINENV_RUNS_DIR: runs, NODE_ENV: 'test', CLINENV_TEST_HOOKS: '1', CLINENV_RUNNER_TEST_TRANSPORT: 'toy', CLINENV_WEB_DIST: fakeDist() });
    const p2 = Number(new URL(await d.url).port);
    const token = tokenMeta((await http(p2, 'GET', '/clinical-agent-env/')).text) as string;
    expect((await http(p2, 'POST', '/api/key', { token, body: { key } })).status).toBe(200);
    const t = (await http(p2, 'POST', '/api/trials', { token, body: toyTrial({ key }) })).json() as { trial_ids: string[] };
    const s = await readSse(p2, `/api/trials/${t.trial_ids[0]}/events`, { token });
    expect(s.frames.at(-1)?.event).toBe('graded');
    expect((await http(p2, 'POST', `/api/trials?key=${key}`, { token, body: toyTrial() })).status).toBe(400);
    d.child.kill('SIGINT');
    expect((await d.exit).code).toBe(0);
    const outputs: Array<[string, string]> = [['stdout', c.stdout() + d.stdout()], ['stderr', c.stderr() + d.stderr()], ['ledger', readFileSync(join(home, '.clinenv', 'spend.jsonl'), 'utf8')], ['sse', s.text]];
    for (const [where, text] of outputs) {
      expect(text.includes(key), where).toBe(false);
    }
    for (const f of filesUnder(runs)) expect(readFileSync(f, 'utf8').includes(key), f).toBe(false);
    expect(d.stdout()).toMatch(/^POST \/api\/trials 400 \d+ms$/m);
  });
});
