// redactHeaders, and that the API key reaches no log line, ledger row, trajectory or error.
import { describe, expect, it } from 'vitest';
import { fakeKey } from '../../../scripts/test/helpers.ts';
import { MessagesClient, type MessageParam } from '../anthropic.ts';
import { admitStore, createLedger, type LedgerRow, type LedgerStore } from '../ledger.ts';
import { REDACTED, redactHeaders, redactText } from '../redact.ts';

const SENTINEL = fakeKey('S');

class MemoryStore implements LedgerStore {
  rows: LedgerRow[] = [];
  async transact<T>(fn: (rows: readonly LedgerRow[]) => { append: LedgerRow[]; result: T }): Promise<T> {
    const { append, result } = fn(this.rows);
    this.rows.push(...append);
    return result;
  }
  async read(): Promise<LedgerRow[]> {
    return [...this.rows];
  }
}

describe('redactHeaders', () => {
  it('replaces x-api-key in any case and every value that contains the key, keeping names and other values', () => {
    const out = redactHeaders(
      { 'X-Api-Key': SENTINEL, authorization: `Bearer ${SENTINEL}`, 'anthropic-version': '2026-10-21', 'content-type': 'application/json' },
      [SENTINEL],
    );
    expect(out).toEqual({ 'X-Api-Key': REDACTED, authorization: REDACTED, 'anthropic-version': '2026-10-21', 'content-type': 'application/json' });
  });

  it('redacts x-api-key even when the key is not passed', () => {
    expect(redactHeaders({ 'x-api-key': 'anything' })).toEqual({ 'x-api-key': REDACTED });
  });

  it('takes the name/value array Playwright headersArray() returns', () => {
    expect(redactHeaders([{ name: 'x-api-key', value: SENTINEL }, { name: 'x-trace', value: `k=${SENTINEL}` }, { name: 'accept', value: '*/*' }], [SENTINEL])).toEqual([
      { name: 'x-api-key', value: REDACTED },
      { name: 'x-trace', value: REDACTED },
      { name: 'accept', value: '*/*' },
    ]);
  });

  it('a recorded Playwright-shaped request and preflight dump holds no sentinel after redaction, and every header name survives', () => {
    const dump = {
      request: {
        url: 'https://example.invalid/v1/messages', method: 'POST',
        headers: { 'x-api-key': SENTINEL, 'x-echo': `echo ${SENTINEL} echo`, 'anthropic-version': '2026-10-21', 'anthropic-dangerous-direct-browser-access': 'true', 'content-type': 'application/json' },
      },
      preflight: {
        method: 'OPTIONS',
        headers: { 'access-control-request-method': 'POST', 'access-control-request-headers': 'anthropic-dangerous-direct-browser-access,anthropic-version,content-type,x-api-key', origin: 'http://localhost:4173' },
        response: { 'access-control-allow-origin': '*', 'x-mirror': SENTINEL },
      },
      response: { status: 200, headers: { 'request-id': 'req_1', 'x-api-key': SENTINEL } },
    };
    const names = (h: Record<string, string>) => Object.keys(h).sort();
    const redacted = {
      request: { ...dump.request, headers: redactHeaders(dump.request.headers, [SENTINEL]) },
      preflight: { ...dump.preflight, headers: redactHeaders(dump.preflight.headers, [SENTINEL]), response: redactHeaders(dump.preflight.response, [SENTINEL]) },
      response: { ...dump.response, headers: redactHeaders(dump.response.headers, [SENTINEL]) },
    };
    expect(JSON.stringify(redacted)).not.toContain(SENTINEL);
    expect(names(redacted.request.headers)).toEqual(names(dump.request.headers));
    expect(names(redacted.preflight.headers)).toEqual(names(dump.preflight.headers));
    expect(names(redacted.preflight.response)).toEqual(names(dump.preflight.response));
    expect(names(redacted.response.headers)).toEqual(names(dump.response.headers));
    expect(redacted.preflight.headers['access-control-request-headers']).toContain('x-api-key');
  });

  it('redactText removes every occurrence of each secret', () => {
    expect(redactText(`a ${SENTINEL} b ${SENTINEL}`, [SENTINEL])).toBe(`a ${REDACTED} b ${REDACTED}`);
  });
});

describe('the key appears in no log, ledger row or trajectory', () => {
  const sse = (events: object[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
  const answer = sse([
    { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'ping', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"value":' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '42}' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } },
    { type: 'message_stop' },
  ]);

  it('across a 429 retry, a network error, a tool_use answer and a 400', async () => {
    const store = new MemoryStore();
    admitStore(store);
    const ledger = createLedger({ store, clock: { now: () => 't' }, newId: () => crypto.randomUUID(), source: 'node', runId: null, pid: 1, host: 'h', isAlive: () => true });
    const grant = await ledger.batchStart(1);
    const replies: Array<() => Response> = [
      () => new Response('{"type":"error","error":{"type":"rate_limit_error","message":"slow"}}', { status: 429 }),
      () => { throw new TypeError(`fetch failed for key ${SENTINEL}`); },
      () => new Response(answer, { status: 200 }),
      () => new Response(`{"type":"error","error":{"type":"invalid_request_error","message":"bad key ${SENTINEL}"}}`, { status: 400 }),
    ];
    const fetch = (async () => (replies.shift() as () => Response)()) as typeof globalThis.fetch;
    const logs: string[] = [];
    const c = new MessagesClient({ grant, ledger, apiKey: SENTINEL, fetch, sleep: async () => {}, log: (l) => logs.push(l) });
    const history: MessageParam[] = [{ role: 'user', content: 'call ping' }];
    const result = await c.send(history, { max_tokens: 64 });
    expect(result.message.content).toEqual([{ type: 'tool_use', id: 't1', name: 'ping', input: { value: 42 } }]);
    const err = await c.send([...history, { role: 'user', content: 'again' }], { max_tokens: 64 }).catch((e: unknown) => e as Error);
    expect(logs.length).toBeGreaterThan(0);
    for (const [what, text] of [
      ['logs', logs.join('\n')],
      ['ledger rows', JSON.stringify(store.rows)],
      ['trajectory', JSON.stringify({ history, result })],
      ['error', `${(err as Error).message} ${(err as Error).stack ?? ''}`],
    ] as const) {
      expect(text, what).not.toContain(SENTINEL);
    }
  });
});
