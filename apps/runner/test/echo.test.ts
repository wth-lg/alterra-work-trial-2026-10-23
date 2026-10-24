// Security review P12b-4 G1 and G2: no response or log line echoes request input or upstream
// error text, so key text an encoding hides from redaction (a percent-encoded key, a key without
// its sk-ant- prefix) cannot come back. An unknown field is counted, not named; an unknown task
// id is not named; an upstream error reaches the log, the trial and the Validate answer as its
// status and type only, and Validate answers a fixed message per class.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sse, turnEvents } from '../../web/src/harness/scenarios.ts';
import { jsonError, launch, readSse, sentinels, toyTrial, until, type Answer, type HttpResult, type Launched } from './helpers.ts';

// The key with its first 's' percent-encoded `depth` times: %73, %2573, ...
const enc = (key: string, depth: number) => key.replace('s', `%${'25'.repeat(depth - 1)}73`);
// The key's text after the sk-ant-api03- prefix, less one character: what an echo would carry.
const tailOf = (key: string) => key.slice(14);
const filesUnder = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? filesUnder(join(dir, n)) : [join(dir, n)]));
const message = (r: HttpResult) => (r.json() as { error: { message: string } }).error.message;

function expectClean(l: Launched, r: HttpResult, tail: string, from: number, what: string) {
  expect(JSON.stringify(r.headers) + r.text, what).not.toContain(tail);
  expect(l.logs.slice(from).join('\n'), what).not.toContain(tail);
}

describe('no echo of request input (security review P12b-4 G1)', () => {
  it('counts unknown fields instead of naming them, in POST api/trials and POST api/key', async () => {
    const key = sentinels().skAnt;
    const tail = tailOf(key);
    const l = await launch();
    try {
      for (const [path, body, want] of [
        ['/api/trials?dry_run=1', { ...toyTrial(), [enc(key, 1)]: 1 }, 'trials request: 1 unknown field'],
        ['/api/trials', { ...toyTrial(), [tail]: 1, [enc(key, 2)]: 2 }, 'trials request: 2 unknown fields'],
        ['/api/key', { key, [enc(key, 1)]: 1 }, 'key request: 1 unknown field'],
        ['/api/key', { key, [tail]: 1 }, 'key request: 1 unknown field'],
      ] as const) {
        const from = l.logs.length;
        const r = await l.http('POST', path, { body });
        expect(r.status, path).toBe(400);
        expect(message(r), path).toBe(want);
        expectClean(l, r, tail, from, path);
      }
      expect(l.calls).toHaveLength(0);
    } finally {
      await l.runner.shutdown();
    }
  });

  it('does not name an unknown task id, in a batch or a smoke batch', async () => {
    const key = sentinels().skAnt;
    const tail = tailOf(key);
    const l = await launch({ env: { CLINENV_FORCED_FAIL: '1' } });
    try {
      for (const body of [toyTrial({ tasks: [tail] }), toyTrial({ tasks: ['_toy', tail], smoke: true }), toyTrial({ tasks: [tail.slice(0, 40)] })]) {
        for (const path of ['/api/trials?dry_run=1', '/api/trials']) {
          const from = l.logs.length;
          const r = await l.http('POST', path, { body });
          expect(r.status, path).toBe(400);
          expect(message(r), path).toBe('tasks: 1 task id is not a task this runner has');
          expectClean(l, r, tail, from, path);
        }
      }
      expect(l.calls).toHaveLength(0);
    } finally {
      await l.runner.shutdown();
    }
  });
});

describe('upstream error text never reaches a body, record or log (security review P12b-4 G2)', () => {
  it('answers a failed Validate with a fixed message per class, whatever the upstream text', async () => {
    const key = sentinels().skAnt;
    const tail = tailOf(key);
    let fail: { status: number; type: string } | null = null;
    let text = '';
    const l = await launch({ answer: (label) => (fail && label.includes('validate') ? jsonError(fail.status, fail.type, text) : undefined) });
    try {
      const classes = [
        { status: 401, type: 'authentication_error', want: 401, message: 'The API refused this key (unauthorized). Check the key and press Validate again.' },
        { status: 403, type: 'permission_error', want: 403, message: 'This key may not use the model (forbidden). Check the key\'s workspace and press Validate again.' },
        { status: 429, type: 'rate_limit_error', want: 429, message: 'The API is rate limiting this key. Wait a minute, then press Validate again.' },
        { status: 400, type: 'invalid_request_error', want: 502, message: 'The API call failed (upstream error). Press Validate again in a minute.' },
        { status: 500, type: 'api_error', want: 502, message: 'The API call failed (upstream error). Press Validate again in a minute.' },
      ];
      const echoes = [`bad key ${key}`, `bad key ${enc(key, 1)}`, `bad key ${enc(key, 2)}`, `bad key ...${tail}`, `x-api-key ${encodeURIComponent(tail)} invalid`];
      for (const c of classes) {
        for (const e of echoes) {
          fail = { status: c.status, type: c.type };
          text = e;
          const from = l.logs.length;
          const r = await l.http('POST', '/api/key', { body: { key } });
          expect(r.status, `${c.status} ${e}`).toBe(c.want);
          expect(r.json(), `${c.status} ${e}`).toEqual({ error: { type: c.type, message: c.message } });
          expectClean(l, r, tail, from, `${c.status} ${e}`);
          // The attempt is logged as its status and type only.
          await until('the request line', () => l.logs.slice(from).some((x) => x.startsWith('POST /api/key')));
          expect(l.logs.slice(from).filter((x) => x.includes('runner:validate'))).toEqual([`runner:validate: attempt 1: HTTP ${c.status} ${c.type}`]);
        }
      }
      // An upstream type that is not a plain error type name is dropped too.
      fail = { status: 401, type: `x ${tail}` };
      const r = await l.http('POST', '/api/key', { body: { key } });
      expect(r.text).not.toContain(tail);
      expect(message(r)).toBe(classes[0]?.message);
      fail = null;
      expect((await l.http('POST', '/api/key', { body: { key } })).status).toBe(200);
    } finally {
      await l.runner.shutdown();
    }
  });

  it('keeps upstream text out of trial logs, events, records and runs: an error answer, a stream error and a dropped connection', async () => {
    const key = sentinels().skAnt;
    const tail = tailOf(key);
    const echo = `bad key ${enc(key, 1)} ${enc(key, 2)} ...${tail}`;
    const modes = ['http', 'stream', 'network'] as const;
    let mode: (typeof modes)[number] = 'http';
    const answer: Answer = (label, n) => {
      if (label.includes('validate')) return undefined;
      if (mode === 'http') return jsonError(400, 'invalid_request_error', echo);
      if (mode === 'network') throw new TypeError(`connect failed: ${echo}`);
      const ev = turnEvents({ thinking: `t${n}`, tools: [{ id: `toolu_${n}`, name: 'get_context', input: {} }] }, n) as object[];
      return new Response(sse([...ev.slice(0, 2), { type: 'error', error: { type: 'invalid_request_error', message: echo } }]), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
    const l = await launch({ answer });
    try {
      expect((await l.http('POST', '/api/key', { body: { key } })).status).toBe(200);
      const texts: string[] = [];
      for (mode of modes) {
        const a = await l.http('POST', '/api/trials', { body: toyTrial() });
        expect(a.status, mode).toBe(202);
        const { trial_ids: [id] } = a.json() as { trial_ids: string[] };
        const stream = await readSse(l.port, `/api/trials/${id}/events`, { token: l.runner.token, timeoutMs: 30_000 });
        texts.push(stream.text, (await l.http('GET', `/api/trials/${id}`)).text);
        await until(`${mode} done`, async () => ((await l.http('GET', '/api/runs')).json() as { runs: Array<{ done: boolean }> }).runs.every((r) => r.done), 30_000);
      }
      texts.push((await l.http('GET', '/api/runs')).text);
      const haystacks: Array<[string, string]> = [
        ['log', l.logs.join('\n')],
        ...texts.map((t, i): [string, string] => [`response ${i}`, t]),
        ...filesUnder(l.env.CLINENV_RUNS_DIR as string).map((f): [string, string] => [f, readFileSync(f, 'utf8')]),
        ...filesUnder(join(l.home, '.clinenv')).map((f): [string, string] => [f, readFileSync(f, 'utf8')]),
      ];
      for (const [where, text] of haystacks) {
        expect(text.includes(tail), where).toBe(false);
        expect(text.includes('bad key'), where).toBe(false);
      }
      // What a log line keeps: the status and the type.
      expect(l.logs.some((x) => /attempt 1: HTTP 400 invalid_request_error$/.test(x))).toBe(true);
      expect(l.logs.some((x) => /attempt 1: stream error invalid_request_error$/.test(x))).toBe(true);
    } finally {
      await l.runner.shutdown();
    }
  }, 120_000);
});
