// Which API failures stop the batch (design section 1, "Failure modes"), through both paths that
// send: the trial loop and the judge. 401, 403, a 404 (the model: /v1/messages is the only
// endpoint) and a billing 400 are INFRA_API and stop the batch; any other 400 is a request we
// built wrong, INFRA_HARNESS, and stops it too, as does every other INFRA_HARNESS: an egress
// refusal, a spend refusal and a local client error. A substituted model (INVALID) stops it too.
// A batch stop always closes the grant, and the grant closes only on a batch stop. Retries
// exhausted (a 429 or 529 on all 8 attempts) is INFRA_API, rerun, and does not stop the batch
// (design section 5, "Outcomes"), and neither does an abort. The loop and the judge read one
// classification, classifyFailure.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { okResponse, scriptedTransport, SCENARIOS } from '../../../apps/web/src/harness/scenarios.ts';
import { nodeTaskSource } from '../../../cli/adapters/tasks-node.ts';
import { judged, type Check } from '../../grader/check.ts';
import { ApiError, classifyFailure, EgressRefusal, MAX_ATTEMPTS, MessagesClient, type Transport } from '../anthropic.ts';
import { admitStore, createLedger, SpendRefused, type LedgerRow, type LedgerStore } from '../ledger.ts';
import { run } from '../run.ts';

const root = new URL('../../../', import.meta.url);
const WORLD = new Uint8Array(readFileSync(new URL('fixtures/world.ndjson.gz', root)));
const MANIFEST = JSON.parse(readFileSync(new URL('fixtures/manifest.json', root), 'utf8')) as { world: { state_hash: string } };

class MemoryStore implements LedgerStore {
  rows: LedgerRow[] = [];
  reserves = 0;
  // Throws this error in place of the n-th reserve: a local fault or a spend refusal.
  failReserve: { at: number; error: () => Error } | null = null;
  async transact<T>(fn: (rows: readonly LedgerRow[]) => { append: LedgerRow[]; result: T }): Promise<T> {
    const { append, result } = fn(this.rows);
    if (append.some((r) => r.kind === 'reserve') && ++this.reserves === this.failReserve?.at) throw this.failReserve.error();
    this.rows.push(...append);
    return result;
  }
  async read(): Promise<LedgerRow[]> {
    return [...this.rows];
  }
}

const BILLING = 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.';
const error = (status: number, type: string, message: string) => () =>
  new Response(JSON.stringify({ type: 'error', error: { type, message } }), { status, headers: { 'content-type': 'application/json' } });

// [name, status, error type, message, outcome, stops the batch, code]
const CASES = [
  ['401', 401, 'authentication_error', 'invalid x-api-key', 'INFRA_API', true, 'authentication_error'],
  ['403', 403, 'permission_error', 'Your API key does not have permission to use the specified resource.', 'INFRA_API', true, 'permission_error'],
  ['404 model', 404, 'not_found_error', 'model: claude-opus-5-5', 'INFRA_API', true, 'not_found_error'],
  ['billing 400', 400, 'invalid_request_error', BILLING, 'INFRA_API', true, 'billing_error'],
  ['billing_error', 402, 'billing_error', 'billing problem', 'INFRA_API', true, 'billing_error'],
  ['other 400', 400, 'invalid_request_error', 'messages: roles must alternate', 'INFRA_HARNESS', true, 'invalid_request_error'],
] as const;

// The judge item: its text is the trial's final text, so it is asked once the toy trial ends.
const CHECKS: Check[] = [judged({ id: 'J1', points: 1, category: 'documentation', traces_to: 'instruction L5', decisive_ids: [], criterion: 'The summary names the patient.', text: (ctx) => ctx.final_text ?? '' })];

// The toy trial through a real MessagesClient and an in-memory ledger. Trial requests (they
// carry tools) go to `trial`, judge requests to `judge`.
async function trial(t: { trial?: Transport; judge?: () => Response; failReserve?: MemoryStore['failReserve']; signal?: AbortSignal }) {
  const store = new MemoryStore();
  store.failReserve = t.failReserve ?? null;
  admitStore(store);
  let id = 0;
  const ledger = createLedger({ store, clock: { now: () => 't' }, newId: () => `id-${++id}`, source: 'node', runId: null, pid: 1, host: 'h', isAlive: () => true });
  const grant = await ledger.batchStart(6);
  const toy = scriptedTransport(SCENARIOS.toy).transport;
  let judgeSends = 0;
  let trialSends = 0;
  const transport: Transport = async (request) => {
    const body = JSON.parse(await request.clone().text()) as { tools?: unknown };
    if (body.tools !== undefined) return trialSends++, (t.trial ?? toy)(request);
    judgeSends++;
    return (t.judge ?? (() => okResponse({ text: '{"verdict":"met","quote":"Patient/pt-0001"}' }, 100)))();
  };
  let clock = Date.UTC(2026, 9, 23, 12);
  const client = new MessagesClient({ grant, ledger, apiKey: 'test-key-not-real', fetch: (q) => ((clock += 4000), transport(q)), sleep: async () => {} });
  const { record } = await run('_toy', 'claude-opus-5-5', {
    tasks: nodeTaskSource({ testMode: true }), client, world: { read: async () => WORLD }, worldHash: MANIFEST.world.state_hash, now: () => clock, checks: CHECKS,
    ...(t.signal ? { signal: t.signal } : {}),
  });
  const closes = store.rows.filter((r) => r.kind === 'close').length;
  // A closed grant refuses the next call before it sends anything.
  const judgeSent = judgeSends;
  const before = trialSends + judgeSends;
  const after = await client.send([{ role: 'user', content: 'again' }], { max_tokens: 16 }).then(
    () => 'sent',
    (e: unknown) => (e as Error).message,
  );
  return { record, closes, after, sent: trialSends + judgeSends - before, judgeSends: judgeSent };
}

describe('classifyFailure', () => {
  it.each(CASES)('%s from the API stops the batch with the classification the design gives', async (_name, status, type, message, outcome, stops, code) => {
    const store = new MemoryStore();
    admitStore(store);
    const ledger = createLedger({ store, clock: { now: () => 't' }, newId: () => 'id', source: 'node', runId: null, pid: 1, host: 'h', isAlive: () => true });
    const client = new MessagesClient({ grant: await ledger.batchStart(1), ledger, apiKey: 'test-key-not-real', fetch: async () => error(status, type, message)(), sleep: async () => {} });
    const e = await client.send([{ role: 'user', content: 'hi' }], { max_tokens: 16 }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ stopsBatch: stops, retryable: false });
    expect(classifyFailure(e)).toMatchObject({ status: outcome, stopsBatch: stops, code });
    expect(store.rows.filter((r) => r.kind === 'close')).toHaveLength(1);
  });

  it('retries exhausted, a network error, a substituted model, a spend refusal and a local bug', () => {
    const exhausted = new ApiError('HTTP 529 overloaded_error', { status: 529, type: 'overloaded_error', retryable: true, stopsBatch: false });
    expect(classifyFailure(exhausted)).toEqual({ status: 'INFRA_API', code: 'overloaded_error', stopsBatch: false, message: exhausted.message });
    expect(classifyFailure(new ApiError('network error: reset', { status: null, type: null, retryable: true, stopsBatch: false, partial: true }))).toMatchObject({ status: 'INFRA_API', code: 'network', stopsBatch: false });
    expect(classifyFailure(new ApiError('response model x is not y', { status: 200, type: 'model_mismatch', retryable: false, stopsBatch: true }))).toMatchObject({ status: 'INVALID', code: 'model_mismatch', stopsBatch: true });
    expect(classifyFailure(new ApiError('refused', { status: null, type: 'egress_refused', retryable: false, stopsBatch: true }))).toMatchObject({ status: 'INFRA_HARNESS', code: 'egress_refused', stopsBatch: true });
    expect(classifyFailure(new SpendRefused('projected', 'over the cap'))).toMatchObject({ status: 'INFRA_HARNESS', code: 'spend_refused_projected', stopsBatch: true });
    expect(classifyFailure(new TypeError('bad request'))).toEqual({ status: 'INFRA_HARNESS', code: 'client_error', stopsBatch: true, message: 'TypeError: bad request' });
  });

  it('every INFRA_HARNESS stops the batch, whatever the error says', () => {
    // An ApiError built with stopsBatch false still stops it when it is INFRA_HARNESS.
    expect(classifyFailure(new ApiError('refused', { status: null, type: 'egress_refused', retryable: false, stopsBatch: false }))).toMatchObject({ status: 'INFRA_HARNESS', stopsBatch: true });
    expect(classifyFailure(new ApiError('HTTP 400', { status: 400, type: 'invalid_request_error', retryable: false, stopsBatch: false }))).toMatchObject({ status: 'INFRA_HARNESS', stopsBatch: true });
  });
});

describe('through the trial loop', () => {
  it.each(CASES)('a %s on a model call: the trial outcome, the grant closed, the next call sends nothing', async (_name, status, type, message, outcome, _stops, code) => {
    const r = await trial({ trial: async () => error(status, type, message)() });
    expect(r.record).toMatchObject({ status: outcome, outcome, valid: false, fault: 'infra', detail: code, turns: 1 });
    expect(r.closes).toBe(1);
    expect(r.after).toMatch(/closed/);
    expect(r.sent).toBe(0);
    expect(r.judgeSends).toBe(0);
  });

  it('retries exhausted (529 on every attempt): INFRA_API, rerun, the batch goes on', async () => {
    let sends = 0;
    const r = await trial({ trial: async () => (sends++, error(529, 'overloaded_error', 'Overloaded')()) });
    // Design section 1: the same backoff as a 429, 8 attempts.
    expect(MAX_ATTEMPTS).toBe(8);
    expect(sends).toBe(8);
    expect(r.record).toMatchObject({ status: 'INFRA_API', outcome: 'INFRA_API', valid: false, fault: 'infra', detail: 'overloaded_error' });
    expect(r.closes).toBe(0);
    expect(r.after).not.toMatch(/closed/);
  });
});

describe('through the judge', () => {
  it.each(CASES)('a judge %s: the trial outcome with stops_batch, the grant closed, nothing cached', async (_name, status, type, message, outcome, stops) => {
    const r = await trial({ judge: error(status, type, message) });
    expect(r.record).toMatchObject({ status: 'COMPLETED', outcome, valid: false, fault: 'infra', error: { check: 'J1', stops_batch: stops } });
    expect(r.record.judge.cache).toEqual([]);
    expect(r.record.turns).toBe(2);
    expect(r.closes).toBe(1);
    expect(r.after).toMatch(/closed/);
    expect(r.sent).toBe(0);
  });

  it('retries exhausted on the judge: INFRA_API, stops_batch false, the batch goes on', async () => {
    const r = await trial({ judge: error(529, 'overloaded_error', 'Overloaded') });
    expect(r.judgeSends).toBe(8);
    expect(r.record).toMatchObject({ status: 'COMPLETED', outcome: 'INFRA_API', valid: false, fault: 'infra', error: { check: 'J1', stops_batch: false } });
    expect(r.closes).toBe(0);
    expect(r.after).not.toMatch(/closed/);
  });
});

// The INFRA_HARNESS failures that are not an HTTP status: [name, outcome code, how it fails on
// the trial's first model call, how it fails on the judge call]. The toy trial makes two model
// calls, so the judge's reserve is the third.
const egress: Transport = async () => {
  throw new EgressRefusal('egress guard: request to the API host refused');
};
const LOCAL = [
  ['egress refused', 'egress_refused', { trial: egress }, { judge: () => { throw new EgressRefusal('egress guard: request to the API host refused'); } }],
  ['a local client error', 'client_error', { failReserve: { at: 1, error: () => new Error('ledger lock lost') } }, { failReserve: { at: 3, error: () => new Error('ledger lock lost') } }],
  ['a spend refusal', 'spend_refused_actual', { failReserve: { at: 1, error: () => new SpendRefused('actual', 'actual spend is at the cap') } }, { failReserve: { at: 3, error: () => new SpendRefused('actual', 'actual spend is at the cap') } }],
] as const;

describe('every INFRA_HARNESS stops the batch', () => {
  it.each(LOCAL)('%s on a model call: INFRA_HARNESS, the grant closed, the next call sends nothing', async (_name, code, onTrial) => {
    const r = await trial(onTrial);
    expect(r.record).toMatchObject({ status: 'INFRA_HARNESS', outcome: 'INFRA_HARNESS', valid: false, fault: 'infra', detail: code });
    expect(r.closes).toBe(1);
    expect(r.after).toMatch(/closed/);
    expect(r.sent).toBe(0);
  });

  it.each(LOCAL)('%s on the judge call: INFRA_HARNESS with stops_batch, the grant closed, nothing cached', async (_name, _code, _onTrial, onJudge) => {
    const r = await trial(onJudge);
    expect(r.record).toMatchObject({ status: 'COMPLETED', outcome: 'INFRA_HARNESS', valid: false, fault: 'infra', error: { check: 'J1', stops_batch: true } });
    expect(r.record.judge.cache).toEqual([]);
    expect(r.closes).toBe(1);
    expect(r.after).toMatch(/closed/);
    expect(r.sent).toBe(0);
  });
});

// Coordinator decision (P8 fix round 3, 2026-10-23): a substituted model is an API-side fault a
// rerun does not cure, so it stops the batch. The trial stays INVALID (never counted).
describe('a substituted model stops the batch', () => {
  const substituted = () => okResponse({ text: '{"verdict":"met","quote":"Patient/pt-0001"}', model: 'claude-sonnet-5-5' }, 1);

  it('on a model call: INVALID, the grant closed, the next call sends nothing', async () => {
    const r = await trial({ trial: async () => substituted() });
    expect(r.record).toMatchObject({ status: 'INVALID', outcome: 'INVALID', valid: false, detail: 'model_mismatch' });
    expect(r.closes).toBe(1);
    expect(r.after).toMatch(/closed/);
    expect(r.sent).toBe(0);
  });

  it('on the judge call: INVALID with stops_batch, the grant closed, nothing cached', async () => {
    const r = await trial({ judge: substituted });
    expect(r.record).toMatchObject({ status: 'COMPLETED', outcome: 'INVALID', valid: false, error: { check: 'J1', stops_batch: true } });
    expect(r.record.judge.cache).toEqual([]);
    expect(r.closes).toBe(1);
    expect(r.after).toMatch(/closed/);
  });
});

describe('the grant closes only on a batch stop', () => {
  it('an abort mid-call: CANCELLED, the grant stays open', async () => {
    const ac = new AbortController();
    const r = await trial({
      signal: ac.signal,
      trial: async () => {
        ac.abort();
        throw new DOMException('This operation was aborted', 'AbortError');
      },
    });
    expect(r.record).toMatchObject({ status: 'CANCELLED', valid: false });
    expect(r.closes).toBe(0);
    expect(r.after).not.toMatch(/closed/);
  });
});
