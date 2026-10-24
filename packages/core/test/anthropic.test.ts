// The Messages client against a mocked fetch: retries, stream handling, refusal and model
// checks, request rules, and that every attempt is reserved before fetch and settled after.
// This is the one test file no-forged-grant exempts by name: it forges grants on purpose.
import { describe, expect, it } from 'vitest';
import { fakeKey, tempDir, write } from '../../../scripts/test/helpers.ts';
import { main as liveNode, projection as liveNodeProjection } from '../../../scripts/live-node.ts';
import * as anthropic from '../anthropic.ts';
import { installEgressGuard } from '../egress.ts';
import { ApiError, MessagesClient, type MessageParam, type Transport } from '../anthropic.ts';
import { ACTUAL_CAP_USD, admitStore, createLedger, PROJECTED_CAP_USD, SpendRefused, type BatchGrant, type Ledger, type LedgerRow, type LedgerStore } from '../ledger.ts';

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

function setup() {
  const store = new MemoryStore();
  admitStore(store);
  let n = 0;
  const ledger = createLedger({
    store, clock: { now: () => 't' }, newId: () => `id-${++n}`, source: 'node', runId: null, pid: 1, host: 'h', isAlive: () => true,
  });
  return { store, ledger };
}

type Step = () => Response | Promise<Response>;

// The client hands its transport one Request; the mock records what that Request would send.
function mockFetch(steps: Step[]) {
  const calls: Array<{ url: string; init: { headers: Record<string, string>; body: string }; args: number; request: boolean }> = [];
  const fetch = (async (...args: unknown[]) => {
    const [input, init] = args as [string | URL | Request, RequestInit | undefined];
    const req = input instanceof Request ? input : new Request(input, init);
    calls.push({ url: req.url, init: { headers: Object.fromEntries(req.headers), body: await req.text() }, args: args.length, request: input instanceof Request });
    const step = steps.shift();
    if (step === undefined) throw new Error('unexpected fetch');
    return step();
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const sse = (events: object[]) => events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join('');

function body(chunks: string[], end: 'close' | 'error' = 'close'): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const chunk of chunks) c.enqueue(enc.encode(chunk));
      if (end === 'error') c.error(new TypeError('terminated'));
      else c.close();
    },
  });
}


function start(model = 'claude-opus-5-5') {
  return { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 100, output_tokens: 1 } } };
}

function textEvents(text: string, opts: { model?: string; stop?: string; stop_details?: object } = {}): object[] {
  return [
    start(opts.model),
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: opts.stop ?? 'end_turn', stop_details: opts.stop_details ?? null }, usage: { output_tokens: 20 } },
    { type: 'message_stop' },
  ];
}

const ok = (text = 'done', opts: Parameters<typeof textEvents>[1] = {}): Step => () =>
  new Response(body([sse(textEvents(text, opts))]), { status: 200, headers: { 'content-type': 'text/event-stream' } });

const status = (code: number, type: string, headers: Record<string, string> = {}): Step => () =>
  new Response(JSON.stringify({ type: 'error', error: { type, message: `${type} happened` } }), { status: code, headers: { 'content-type': 'application/json', ...headers } });

// A stream that sends a partial answer, then ends: closed without message_stop, cut by a
// network error, or with an error event.
const partial = (how: 'eof' | 'error' | 'overloaded'): Step => () => {
  const head = sse(textEvents('PARTIAL').slice(0, 3));
  const tail = how === 'overloaded' ? [sse([{ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }])] : [];
  return new Response(body([head, ...tail], how === 'error' ? 'error' : 'close'), { status: 200 });
};

const PARAMS = { max_tokens: 1024, output_config: { effort: 'low' } };
const user = (): MessageParam[] => [{ role: 'user', content: 'hello' }];

async function client(steps: Step[], opts: { setupLedger?: ReturnType<typeof setup>; projection?: number; fetch?: Transport; maxAttempts?: number; random?: () => number } = {}) {
  const s = opts.setupLedger ?? setup();
  const grant = await s.ledger.batchStart(opts.projection ?? 1);
  const m = mockFetch(steps);
  const sleeps: number[] = [];
  const c = new MessagesClient({
    grant, ledger: s.ledger, apiKey: fakeKey(), fetch: opts.fetch ?? m.fetch, sleep: async (ms) => void sleeps.push(ms),
    // The top of the jitter range: each backoff is its full exponential step.
    random: opts.random ?? (() => 1),
    ...(opts.maxAttempts ? { maxAttempts: opts.maxAttempts } : {}),
  });
  return { ...s, ...m, grant, c, sleeps };
}

const rows = (store: MemoryStore, kind: LedgerRow['kind']) => store.rows.filter((r) => r.kind === kind);

describe('retries', () => {
  it('429 then ok: waits retry-after, reserves and settles each attempt, returns the answer', async () => {
    const t = await client([status(429, 'rate_limit_error', { 'retry-after': '3' }), ok('fine')]);
    const history = user();
    const r = await t.c.send(history, PARAMS);
    expect(r.status).toBe(200);
    expect(t.calls).toHaveLength(2);
    expect(t.sleeps).toEqual([3000]);
    expect(rows(t.store, 'reserve')).toHaveLength(2);
    expect(rows(t.store, 'settle').map((x) => x.cost_usd)).toEqual([0, (100 * 4 + 20 * 20) / 1e6]);
    expect(history.at(-1)).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'fine' }] });
  });

  // Design section 1, "Failure modes": a 429 honours retry-after, else exponential backoff with
  // jitter from 2 s to 60 s, 8 attempts; a 529 or other 5xx gets the same backoff.
  it('529 on every attempt: throws a retryable ApiError after 8 attempts, backing off 2 s to 60 s, each one settled', async () => {
    expect(anthropic.MAX_ATTEMPTS).toBe(8);
    const t = await client(Array.from({ length: 8 }, () => status(529, 'overloaded_error')));
    const err = await t.c.send(user(), PARAMS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 529, retryable: true, stopsBatch: false });
    expect(t.calls).toHaveLength(8);
    expect(t.sleeps).toEqual([2000, 4000, 8000, 16000, 32000, 60000, 60000]);
    expect(rows(t.store, 'settle')).toHaveLength(8);
  });

  it('429 on every attempt without retry-after: 8 attempts, the same backoff', async () => {
    const t = await client(Array.from({ length: 8 }, () => status(429, 'rate_limit_error')));
    const err = await t.c.send(user(), PARAMS).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 429, retryable: true, stopsBatch: false });
    expect(t.calls).toHaveLength(8);
    expect(t.sleeps).toEqual([2000, 4000, 8000, 16000, 32000, 60000, 60000]);
  });

  it('jitter: the bottom of the range waits half the step, never under 2 s', async () => {
    const t = await client(Array.from({ length: 8 }, () => status(429, 'rate_limit_error')), { random: () => 0 });
    await t.c.send(user(), PARAMS).catch(() => {});
    expect(t.sleeps).toEqual([2000, 2000, 4000, 8000, 16000, 30000, 30000]);
    // Retries exhausted does not stop the batch: the trial is INFRA_API and rerun.
    expect(rows(t.store, 'close')).toHaveLength(0);
  });

  it('400 stops the batch: no retry, the grant is closed, and the next call sends nothing', async () => {
    const t = await client([status(400, 'invalid_request_error'), ok()]);
    await expect(t.c.send(user(), PARAMS)).rejects.toMatchObject({ status: 400, stopsBatch: true });
    expect(t.calls).toHaveLength(1);
    expect(rows(t.store, 'close')).toHaveLength(1);
    await expect(t.c.send(user(), PARAMS)).rejects.toThrow(/closed|stopped/);
    expect(t.calls).toHaveLength(1);
  });
});

describe('response checks', () => {
  it('a refusal stops without retry, reports its category and leaves the history unchanged', async () => {
    const t = await client([ok('', { stop: 'refusal', stop_details: { type: 'refusal', category: 'bio', explanation: 'x' } }), ok()]);
    const history = user();
    const r = await t.c.send(history, PARAMS);
    expect(r.refusal).toEqual({ category: 'bio', explanation: 'x' });
    expect(r.message.stop_reason).toBe('refusal');
    expect(history).toEqual(user());
    expect(t.calls).toHaveLength(1);
    expect(rows(t.store, 'settle')).toHaveLength(1);
  });

  it('a response from another model is rejected, settled at its usage, and not appended', async () => {
    const t = await client([ok('x', { model: 'claude-opus-5' })]);
    const history = user();
    await expect(t.c.send(history, PARAMS)).rejects.toMatchObject({ stopsBatch: true, message: expect.stringMatching(/claude-opus-5\b.*claude-opus-5-5|model/) });
    expect(history).toEqual(user());
    expect(rows(t.store, 'settle').map((x) => x.cost_usd)).toEqual([(100 * 4 + 20 * 20) / 1e6]);
  });
});

describe('partial streams', () => {
  it('a partial stream is discarded from the history; only the retried answer is appended', async () => {
    const t = await client([partial('eof'), ok('whole')]);
    const history = user();
    await t.c.send(history, PARAMS);
    expect(history).toEqual([...user(), { role: 'assistant', content: [{ type: 'text', text: 'whole' }] }]);
    expect(JSON.stringify(history)).not.toContain('PARTIAL');
  });

  it.each([['eof'], ['error']] as const)('a dropped stream (%s) settles a row at the worst case', async (how) => {
    const t = await client([partial(how), ok()]);
    await t.c.send(user(), PARAMS);
    const [reserve] = rows(t.store, 'reserve');
    const [first] = rows(t.store, 'settle');
    expect(first?.call_id).toBe(reserve?.call_id);
    expect(first?.cost_usd).toBe(reserve?.cost_usd);
    expect(first?.usage).toBeNull();
  });

  it('a 529 error event after a partial stream settles a row at the worst case and retries', async () => {
    const t = await client([partial('overloaded'), ok()]);
    const r = await t.c.send(user(), PARAMS);
    expect(r.attempts).toBe(2);
    const [reserve] = rows(t.store, 'reserve');
    expect(rows(t.store, 'settle')[0]).toMatchObject({ call_id: reserve?.call_id, cost_usd: reserve?.cost_usd, usage: null });
  });
});

describe('request rules', () => {
  it('sends the version and browser headers, the pinned model and stream, and none of the banned params', async () => {
    const t = await client([ok()]);
    await t.c.send(user(), { ...PARAMS, cache_control: { type: 'ephemeral' }, tool_choice: { type: 'auto' } });
    const [call] = t.calls;
    expect(new URL(call?.url ?? '').pathname).toBe('/v1/messages');
    expect(call?.init.headers).toMatchObject({ 'anthropic-version': '2026-10-21', 'anthropic-dangerous-direct-browser-access': 'true' });
    const sent = JSON.parse(call?.init.body as string) as Record<string, unknown>;
    expect(sent).toMatchObject({ model: 'claude-opus-5-5', stream: true });
    for (const k of ['temperature', 'top_p', 'top_k', 'fallbacks']) expect(sent).not.toHaveProperty(k);
  });

  it.each([
    ['temperature', { temperature: 1 }],
    ['top_p', { top_p: 0.9 }],
    ['top_k', { top_k: 5 }],
    ['fallbacks', { fallbacks: 'default' }],
    ['forced tool_choice any', { tool_choice: { type: 'any' } }],
    ['forced tool_choice tool', { tool_choice: { type: 'tool', name: 'x' } }],
    ['another model', { model: 'claude-opus-5' }],
  ])('rejects %s before any reserve or fetch', async (_name, extra) => {
    const t = await client([ok()]);
    await expect(t.c.send(user(), { ...PARAMS, ...extra } as typeof PARAMS)).rejects.toThrow();
    expect(t.calls).toHaveLength(0);
    expect(rows(t.store, 'reserve')).toHaveLength(0);
  });

  it('rejects a prefill (history ending in an assistant turn) with 0 fetch calls', async () => {
    const t = await client([ok()]);
    await expect(t.c.send([...user(), { role: 'assistant', content: 'Sure' }], PARAMS)).rejects.toThrow(/prefill/);
    expect(t.calls).toHaveLength(0);
  });

  it.each([
    ['top-level', { cache_control: { type: 'ephemeral', ttl: '1h' } }],
    ['in system', { system: [{ type: 'text', text: 's', cache_control: { type: 'ephemeral', ttl: '1h' } }] }],
  ])('a 1h cache ttl (%s) makes 0 fetch calls', async (_where, extra) => {
    const t = await client([ok()]);
    await expect(t.c.send(user(), { ...PARAMS, ...extra } as typeof PARAMS)).rejects.toThrow(/1h|ttl/);
    expect(t.calls).toHaveLength(0);
    expect(rows(t.store, 'reserve')).toHaveLength(0);
  });

  it('a 1h cache ttl inside a message makes 0 fetch calls', async () => {
    const t = await client([ok()]);
    const history: MessageParam[] = [{ role: 'user', content: [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral', ttl: '1h' } }] }];
    await expect(t.c.send(history, PARAMS)).rejects.toThrow(/ttl/);
    expect(t.calls).toHaveLength(0);
  });
});

describe('spend caps', () => {
  it('with the ledger $0.10 under the actual cap, a reservation that would cross it makes 0 fetch calls', async () => {
    const s = setup();
    const t = await client([ok()], { setupLedger: s });
    // Spend another process settled after this batch started.
    s.store.rows.push({ ts: 't', call_id: 'other', kind: 'settle', source: 'node', run_id: null, batch_id: null, trial: null, usage: null, cost_usd: ACTUAL_CAP_USD - 0.1 });
    // max_tokens 8192 reserves about $0.20 (8192 x $20/MTok plus the input bound), which crosses ACTUAL_CAP_USD.
    await expect(t.c.send(user(), { ...PARAMS, max_tokens: 8192 })).rejects.toBeInstanceOf(SpendRefused);
    expect(t.calls).toHaveLength(0);
    expect(rows(t.store, 'reserve')).toHaveLength(0);
  });
});

describe('the constructor checks its grant before any fetch', () => {
  const build = (grant: unknown, ledger: Ledger, f: typeof fetch) => new MessagesClient({ grant: grant as BatchGrant, ledger, apiKey: fakeKey(), fetch: f });

  it('a cast {} throws', () => {
    const { ledger } = setup();
    const m = mockFetch([ok()]);
    expect(() => build({} as BatchGrant, ledger, m.fetch)).toThrow(/grant/);
    expect(m.calls).toHaveLength(0);
  });

  it('a structural copy of a real grant throws', async () => {
    const { ledger } = setup();
    const real = await ledger.batchStart(1);
    const m = mockFetch([ok()]);
    expect(() => build({ ...real }, ledger, m.fetch)).toThrow(/grant/);
    expect(() => build(Object.create(real), ledger, m.fetch)).toThrow(/grant/);
    expect(m.calls).toHaveLength(0);
  });

  it('a closed grant throws', async () => {
    const { ledger } = setup();
    const grant = await ledger.batchStart(1);
    await grant.close();
    const m = mockFetch([ok()]);
    expect(() => build(grant, ledger, m.fetch)).toThrow(/closed/);
    expect(m.calls).toHaveLength(0);
  });
});

describe('pnpm live:node refuses before any call', () => {
  const run = async (env: Record<string, string>) => {
    const m = mockFetch([ok()]);
    const out: string[] = [];
    const code = await liveNode([], { env: { ANTHROPIC_API_KEY: fakeKey(), ...env }, fetch: m.fetch, out: (l) => out.push(l) });
    return { code, calls: m.calls, out: out.join('\n') };
  };

  it('own-run mode with SPEND_LEDGER=/tmp/x makes 0 calls and errors', async () => {
    const dir = tempDir('p2-own-run');
    write(dir, 'spend.jsonl', '');
    const r = await run({ CLINENV_CANONICAL_LEDGER: `${dir}/spend.jsonl`, SPEND_LEDGER: '/tmp/x' });
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/SPEND_LEDGER/);
    expect(r.calls).toHaveLength(0);
  });

  it('ledger + projection one cent over the projected cap makes 0 calls', async () => {
    const dir = tempDir('p2-cap');
    const settled = PROJECTED_CAP_USD + 0.01 - liveNodeProjection();
    const row: LedgerRow = { ts: 't', call_id: 'prior', kind: 'settle', source: 'node', run_id: null, batch_id: null, trial: null, usage: null, cost_usd: settled };
    write(dir, 'spend.jsonl', JSON.stringify(row) + '\n');
    const r = await run({ SPEND_LEDGER: `${dir}/spend.jsonl` });
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/projected cap/);
    expect(r.out).toContain(`= $${(PROJECTED_CAP_USD + 0.01).toFixed(2)} > $${PROJECTED_CAP_USD}`);
    expect(r.calls).toHaveLength(0);
  });

  it('--dry-run prints the projection and makes 0 calls without a key', async () => {
    const m = mockFetch([]);
    const out: string[] = [];
    const code = await liveNode(['--dry-run'], { env: {}, fetch: m.fetch, out: (l) => out.push(l) });
    expect(code).toBe(0);
    expect(out.join('\n')).toContain(`LIVE_PROJECTION_USD=${liveNodeProjection().toFixed(6)}`);
    expect(m.calls).toHaveLength(0);
  });
});

// P2 fix round (findings p2-findings-1): each test below failed at 63259f5.
describe('MessagesClient is the only way to send', () => {
  it('exports only the metered client, its error and pure helpers', () => {
    expect(Object.keys(anthropic).sort()).toEqual(['ANTHROPIC_VERSION', 'ApiError', 'EgressRefusal', 'MAX_ATTEMPTS', 'MODEL', 'MessagesClient', 'claimOutbound', 'classifyFailure', 'isApiHost', 'requestUrl', 'reserveRequest']);
  });

  it('no exported function sends without a grant', async () => {
    const m = mockFetch([ok(), ok(), ok(), ok()]);
    const real = globalThis.fetch;
    globalThis.fetch = m.fetch;
    try {
      const { ledger } = setup();
      const shapes = [[user(), PARAMS], [{ apiKey: fakeKey(), history: user(), params: PARAMS, fetch: m.fetch }], [fakeKey(), JSON.stringify({})]];
      for (const [name, value] of Object.entries(anthropic)) {
        if (typeof value !== 'function') continue;
        for (const args of shapes) {
          try {
            if (name === 'MessagesClient') new MessagesClient({ grant: {} as BatchGrant, ledger, apiKey: fakeKey(), fetch: m.fetch });
            else await (value as (...a: unknown[]) => unknown)(...args);
          } catch {
            // a throw is fine; a fetch is not
          }
        }
      }
    } finally {
      globalThis.fetch = real;
    }
    expect(m.calls).toHaveLength(0);
  });
});

describe('request rules hold for the serialized body', () => {
  it('a 1h cache ttl smuggled through toJSON makes 0 fetch calls', async () => {
    const t = await client([ok()]);
    const block = { type: 'text', text: 's', toJSON: () => ({ type: 'text', text: 's', cache_control: { type: 'ephemeral', ttl: '1h' } }) };
    await expect(t.c.send(user(), { ...PARAMS, system: [block] })).rejects.toThrow(/ttl/);
    expect(t.calls).toHaveLength(0);
    expect(rows(t.store, 'reserve')).toHaveLength(0);
  });
});

describe('max_tokens truncation', () => {
  const truncated = (stop: string): Step => () =>
    new Response(
      body([
        sse([
          start(),
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'calling' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_1', name: 'record_ping', input: {} } },
          { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"value": 4' } },
          { type: 'content_block_stop', index: 1 },
          { type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 1024 } },
          { type: 'message_stop' },
        ]),
      ]),
      { status: 200 },
    );

  it('a tool_use cut at max_tokens is a max_tokens stop with the complete blocks, settled at its usage', async () => {
    const t = await client([truncated('max_tokens')]);
    const r = await t.c.send(user(), PARAMS);
    expect(r.message.stop_reason).toBe('max_tokens');
    expect(r.message.content).toEqual([{ type: 'text', text: 'calling' }]);
    expect(t.calls).toHaveLength(1);
    expect(rows(t.store, 'settle')).toMatchObject([{ usage: { input_tokens: 100, output_tokens: 1024 }, cost_usd: (100 * 4 + 1024 * 20) / 1e6 }]);
  });

  it('invalid tool_use JSON under any other stop reason still throws', async () => {
    const t = await client([truncated('tool_use')]);
    await expect(t.c.send(user(), PARAMS)).rejects.toMatchObject({ errorType: 'invalid_tool_input', retryable: false });
  });
});

describe('status and local failure handling', () => {
  it.each([[408, 'timeout_error'], [409, 'conflict_error']])('%i is retried and does not close the batch', async (code, type) => {
    const t = await client([status(code, type), ok('fine')]);
    const r = await t.c.send(user(), PARAMS);
    expect(r.attempts).toBe(2);
    expect(rows(t.store, 'close')).toHaveLength(0);
  });

  it.each([[401, 'authentication_error'], [403, 'permission_error'], [404, 'not_found_error'], [402, 'billing_error']])('a %i %s is not retried and stops the batch: the grant is closed, the next call sends nothing', async (code, type) => {
    const t = await client([status(code, type), ok()]);
    await expect(t.c.send(user(), PARAMS)).rejects.toMatchObject({ status: code, retryable: false, stopsBatch: true });
    expect(t.calls).toHaveLength(1);
    expect(rows(t.store, 'close')).toHaveLength(1);
    expect(rows(t.store, 'settle').map((x) => x.cost_usd)).toEqual([0]);
    await expect(t.c.send(user(), PARAMS)).rejects.toThrow(/closed|stopped/);
    expect(t.calls).toHaveLength(1);
  });

  it('a 422 fails the call only', async () => {
    const t = await client([status(422, 'invalid_request_error'), ok()]);
    await expect(t.c.send(user(), PARAMS)).rejects.toMatchObject({ status: 422, retryable: false, stopsBatch: false });
    expect(rows(t.store, 'close')).toHaveLength(0);
  });

  it('a key that is not a valid header value throws in the constructor with 0 reserves and 0 fetch calls', async () => {
    const { ledger, store } = setup();
    const grant = await ledger.batchStart(1);
    const m = mockFetch([ok()]);
    const bad = `${fakeKey()}\nx`;
    let err: unknown;
    try {
      new MessagesClient({ grant, ledger, apiKey: bad, fetch: m.fetch });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TypeError);
    expect(String((err as Error).message)).not.toContain(fakeKey());
    expect(m.calls).toHaveLength(0);
    expect(rows(store, 'reserve')).toHaveLength(0);
  });

  it('a malformed stream frame is not retried as a network error; it settles at the worst case', async () => {
    const bad: Step = () => new Response(body([sse([start()]), 'event: content_block_start\ndata: {not json\n\n']), { status: 200 });
    const t = await client([bad, ok()]);
    const err = await t.c.send(user(), PARAMS).catch((e: unknown) => e);
    expect(err).toMatchObject({ errorType: 'invalid_frame', retryable: false, stopsBatch: false });
    expect((err as Error).message).not.toMatch(/network error/);
    expect(t.calls).toHaveLength(1);
    const [reserve] = rows(t.store, 'reserve');
    expect(rows(t.store, 'settle')).toMatchObject([{ call_id: reserve?.call_id, cost_usd: reserve?.cost_usd, usage: null }]);
  });
});

// The live browser spec sends through MessagesClient with the probe page as its transport, so
// the browser call gets the client's metering and checks.
describe('the probe page transport', () => {
  const relay = async (reply: unknown) => {
    const { relayFetch } = await import('../../../apps/web/src/probe/transport.ts');
    const seen: { url?: string } = {};
    const f = relayFetch(async (url) => {
      seen.url = url;
      return reply as never;
    });
    return { f, seen };
  };

  it('an HTTP error status from the browser settles at $0 and does not retry', async () => {
    const { f } = await relay({ status: 401, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'no' } }) });
    const t = await client([], { fetch: f, maxAttempts: 1 });
    await expect(t.c.send(user(), PARAMS)).rejects.toMatchObject({ status: 401 });
    expect(rows(t.store, 'settle').map((x) => x.cost_usd)).toEqual([0]);
  });

  it('a response from another model is rejected on the probe path', async () => {
    const { f } = await relay({ status: 200, headers: {}, body: sse(textEvents('x', { model: 'claude-opus-5' })) });
    const t = await client([], { fetch: f, maxAttempts: 1 });
    await expect(t.c.send(user(), PARAMS)).rejects.toMatchObject({ errorType: 'model_mismatch' });
  });

  it('a browser TypeError reaches the caller once, settled at the worst case', async () => {
    const { f } = await relay({ error: { name: 'TypeError', message: 'Failed to fetch' } });
    const t = await client([], { fetch: f, maxAttempts: 1 });
    await expect(t.c.send(user(), PARAMS)).rejects.toThrow(/Failed to fetch/);
    const [reserve] = rows(t.store, 'reserve');
    expect(rows(t.store, 'settle')).toMatchObject([{ cost_usd: reserve?.cost_usd, usage: null }]);
  });

  it('a 200 from the browser is parsed by the client', async () => {
    const { f, seen } = await relay({ status: 200, headers: {}, body: sse(textEvents('hi')) });
    const t = await client([], { fetch: f, maxAttempts: 1 });
    const r = await t.c.send(user(), PARAMS);
    expect(r.message.content).toEqual([{ type: 'text', text: 'hi' }]);
    expect(new URL(seen.url ?? '').pathname).toBe('/v1/messages');
  });
});

// P2 second fix round (pr-review-P2-7 defects 2 and 3): each test below fails at 6e517a9.
describe('the transport gets one single-use Request', () => {
  it('is called with exactly one argument, a Request that carries the URL, headers and body', async () => {
    const t = await client([ok()]);
    await t.c.send(user(), PARAMS);
    expect(t.calls.map((c) => [c.args, c.request])).toEqual([[1, true]]);
  });

  it('claimOutbound admits a client Request once, and never a copy, a clone, a mutated one, one with an init or one kept past its call', async () => {
    const claims: boolean[][] = [];
    const plans: Array<(req: Request) => boolean[]> = [
      (req) => [anthropic.claimOutbound(req.clone()), anthropic.claimOutbound(req), anthropic.claimOutbound(req)],
      // a copy takes the body, so the original cannot be claimed after it either
      (req) => [anthropic.claimOutbound(new Request(req)), anthropic.claimOutbound(req)],
      (req) => [anthropic.claimOutbound(req, { body: '{}' }), anthropic.claimOutbound(req)],
      (req) => (req.headers.set('anthropic-beta', 'x'), [anthropic.claimOutbound(req)]),
      () => [],
    ];
    let kept: Request | undefined;
    const t = await client([], { fetch: (async (req: Request) => (kept = req, claims.push(plans[claims.length]?.(req) ?? []), ok()())) as Transport });
    for (let i = 0; i < plans.length; i++) await t.c.send(user(), PARAMS);
    expect(claims).toEqual([[false, true, false], [false, false], [false, false], [false], []]);
    expect(anthropic.claimOutbound(kept)).toBe(false);
  });

  it('isApiHost matches the API host however the URL spells it', () => {
    for (const u of ['https://api%2Eanthropic%2Ecom/v1', 'https://API%2EANTHROPIC.COM./v1', 'https://api\u3002anthropic\u3002com/']) expect(anthropic.isApiHost(new URL(u).hostname)).toBe(true);
    for (const u of ['https://example.org/', 'https://anthropic.com.example.org/']) expect(anthropic.isApiHost(new URL(u).hostname)).toBe(false);
  });

  it('the probe relay refuses a Request the client did not make', async () => {
    const { relayFetch } = await import('../../../apps/web/src/probe/transport.ts');
    let sent = 0;
    const f = relayFetch(async () => (sent++, { status: 200, headers: {}, body: '' }));
    await expect(f(new Request('https://example.org/v1/messages', { method: 'POST', body: '{}' }))).rejects.toThrow(/MessagesClient/);
    expect(sent).toBe(0);
  });
});

describe('server tools and server-billed features are rejected before reserve or fetch', () => {
  it.each([
    ['web search', { type: 'web_search_20250305', name: 'web_search', max_uses: 50 }],
    ['code execution', { type: 'code_execution_20250825', name: 'code_execution' }],
    ['web fetch', { type: 'web_fetch_20250910', name: 'web_fetch' }],
    ['a tool without an input_schema', { name: 'x' }],
    ['a tool that is not an object', 'web_search'],
  ])('rejects %s with 0 reserves and 0 fetch calls', async (_name, tool) => {
    const t = await client([ok()]);
    await expect(t.c.send(user(), { ...PARAMS, tools: [tool as Record<string, unknown>] })).rejects.toThrow(/tool/);
    expect(t.calls).toHaveLength(0);
    expect(rows(t.store, 'reserve')).toHaveLength(0);
  });

  it('accepts a plain client tool, with or without type custom', async () => {
    const t = await client([ok(), ok()]);
    const schema = { type: 'object', properties: {} };
    await t.c.send(user(), { ...PARAMS, tools: [{ name: 'a', description: 'd', input_schema: schema, strict: true }] });
    await t.c.send(user(), { ...PARAMS, tools: [{ type: 'custom', name: 'b', input_schema: schema }] });
    expect(t.calls).toHaveLength(2);
  });

  it.each([['mcp_servers', { mcp_servers: [{ type: 'url', url: 'https://example.org', name: 'x' }] }], ['container', { container: 'c' }], ['speed', { speed: 'fast' }]])(
    'rejects %s with 0 fetch calls',
    async (_name, extra) => {
      const t = await client([ok()]);
      await expect(t.c.send(user(), { ...PARAMS, ...extra } as never)).rejects.toThrow(/rejected/);
      expect(t.calls).toHaveLength(0);
    },
  );

  it('a settle above 2x its reservation is recorded at actual and flagged in its row', async () => {
    const big: Step = () =>
      new Response(body([sse([{ ...start(), message: { ...start().message, usage: { input_tokens: 200_000, output_tokens: 1 } } }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 10 } }, { type: 'message_stop' }])]), { status: 200 });
    const t = await client([big, ok()]);
    await t.c.send(user(), PARAMS);
    await t.c.send(user(), PARAMS);
    const [r1, r2] = rows(t.store, 'reserve');
    const [s1, s2] = rows(t.store, 'settle');
    expect(s1?.cost_usd).toBeGreaterThan(2 * (r1?.cost_usd ?? 0));
    expect(s1?.reason).toMatch(/exceeds 2x its reservation/);
    expect(s2?.cost_usd).toBeLessThanOrEqual(r2?.cost_usd ?? 0);
    expect(s2).not.toHaveProperty('reason');
  });
});

// P2 final fix round (pr-review-P2-9 defects 1, 2 and 5): each test below fails at 9b3d4b9.
describe('the claim and the guard read a Request from its internal slots', () => {
  it('claimOutbound refuses a client Request whose headers were edited behind an own headers property', async () => {
    const claims: boolean[] = [];
    const t = await client([], { fetch: (async (req: Request) => {
      const shown = new Headers(req.headers);
      req.headers.set('anthropic-beta', 'context-1m-2025-08-07');
      Object.defineProperty(req, 'headers', { value: shown });
      claims.push(anthropic.claimOutbound(req));
      return ok()();
    }) as Transport });
    await t.c.send(user(), PARAMS);
    expect(claims).toEqual([false]);
  });

  it('the client Request is sent with redirect: error, so a redirect cannot move it to another host', async () => {
    const redirects: string[] = [];
    const t = await client([], { fetch: (async (req: Request) => (redirects.push(req.redirect), ok()())) as Transport });
    await t.c.send(user(), PARAMS);
    expect(redirects).toEqual(['error']);
  });
});

describe('a request the egress guard refuses', () => {
  // The guard over a recording fetch in a scope object, so this file's globals stay as they are.
  const sends: string[] = [];
  const scope: { fetch: typeof fetch } = { fetch: (async (input: Request) => (sends.push(input.url), ok()())) as typeof fetch };
  installEgressGuard(scope);

  it('is settled at $0 and not retried: 1 reserve, 1 settle at $0, 0 sends', async () => {
    sends.length = 0;
    const t = await client([], { fetch: ((req: Request) => scope.fetch(req.clone())) as Transport });
    await expect(t.c.send(user(), PARAMS)).rejects.toMatchObject({ errorType: 'egress_refused', retryable: false });
    expect(sends).toEqual([]);
    expect(rows(t.store, 'reserve')).toHaveLength(1);
    expect(rows(t.store, 'settle').map((x) => x.cost_usd)).toEqual([0]);
  });

  it('after the registered Request went out, a refusal of a second send still settles at the worst case', async () => {
    sends.length = 0;
    const t = await client([], { maxAttempts: 1, fetch: (async (req: Request) => {
      await scope.fetch(req);
      return scope.fetch(req);
    }) as Transport });
    await expect(t.c.send(user(), PARAMS)).rejects.toThrow(/egress guard/);
    expect(sends).toHaveLength(1);
    const [reserve] = rows(t.store, 'reserve');
    expect(rows(t.store, 'settle')).toMatchObject([{ cost_usd: reserve?.cost_usd, usage: null }]);
  });
});
