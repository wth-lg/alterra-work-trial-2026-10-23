// Cancelling a trial through opts.signal (plan phase P7): an abort during a call sends that one
// request and no retry, settles it at its worst case, and ends the trial with a cancelled event
// and status CANCELLED; an abort between turns sends nothing more. The client half: a
// per-request signal, combined with the grant's, that is never retried.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { scriptedTransport, SCENARIOS, stallingTransport, type ScriptedTransport } from '../../../apps/web/src/harness/scenarios.ts';
import { nodeTaskSource } from '../../../cli/adapters/tasks-node.ts';
import { MessagesClient, type Transport } from '../anthropic.ts';
import { parseEvent, terminalEvent, type TrialEvent } from '../events.ts';
import { admitStore, createLedger, type LedgerRow, type LedgerStore } from '../ledger.ts';
import { run, type RunOptions } from '../run.ts';
import { toJsonl } from '../trajectory.ts';

const root = new URL('../../../', import.meta.url);
const WORLD = new Uint8Array(readFileSync(new URL('fixtures/world.ndjson.gz', root)));
const MANIFEST = JSON.parse(readFileSync(new URL('fixtures/manifest.json', root), 'utf8')) as { world: { state_hash: string } };

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

async function clientOver(transport: Transport) {
  const store = new MemoryStore();
  admitStore(store);
  let id = 0;
  const ledger = createLedger({ store, clock: { now: () => 't' }, newId: () => `id-${++id}`, source: 'node', runId: null, pid: 1, host: 'h', isAlive: () => true });
  const grant = await ledger.batchStart(6);
  const client = new MessagesClient({ grant, ledger, apiKey: 'test-key-not-real', fetch: transport, sleep: async () => {} });
  return { client, store };
}

async function cancelledTrial(mock: ScriptedTransport, controller: AbortController, onEvent: (e: TrialEvent) => void = () => {}, over: Partial<RunOptions> = {}) {
  const { client, store } = await clientOver(mock.transport);
  const events: TrialEvent[] = [];
  const result = await run('_toy', 'claude-opus-5-5', {
    tasks: nodeTaskSource({ testMode: true }),
    client,
    world: { read: async () => WORLD },
    worldHash: MANIFEST.world.state_hash,
    now: () => 0,
    signal: controller.signal,
    onEvent: (e) => {
      events.push(e);
      onEvent(e);
    },
    ...over,
  });
  return { result, events, store };
}

const kinds = (rows: LedgerRow[], kind: LedgerRow['kind']) => rows.filter((r) => r.kind === kind);
// What the ledger settled, in micro-dollars, to compare with a record's cost_usd.
const settledMicros = (rows: LedgerRow[]) => Math.round(kinds(rows, 'settle').reduce((a, r) => a + r.cost_usd, 0) * 1e6);

describe('cancel through opts.signal', () => {
  it.each(['before-response', 'mid-stream'] as const)('an abort during a call (%s) makes 1 fetch, 1 worst-case settle, and ends cancelled', async (when) => {
    const controller = new AbortController();
    const mock = stallingTransport(when, () => controller.abort());
    const { result, events, store } = await cancelledTrial(mock, controller);
    expect(mock.raw).toHaveLength(1);
    const reserves = kinds(store.rows, 'reserve');
    const settles = kinds(store.rows, 'settle');
    expect(reserves).toHaveLength(1);
    expect(settles).toHaveLength(1);
    expect(settles[0]).toMatchObject({ call_id: reserves[0]!.call_id, usage: null, cost_usd: reserves[0]!.cost_usd });
    expect(result.record.status).toBe('CANCELLED');
    expect(terminalEvent(events)!.type).toBe('cancelled');
    expect(events.at(-1)!.type).toBe('graded');
    // The record's cost includes the worst-case settle, so it equals the ledger.
    expect(Math.round(result.record.cost_usd * 1e6)).toBe(settledMicros(store.rows));
    for (const e of events) parseEvent(JSON.parse(JSON.stringify(e)));
    expect(toJsonl(result.events)).toBe(events.map((e) => `${JSON.stringify(e)}\n`).join(''));
  });

  it('an abort between turns makes no further call', async () => {
    const controller = new AbortController();
    const mock = scriptedTransport(SCENARIOS.forever);
    const { result, events, store } = await cancelledTrial(mock, controller, (e) => {
      if (e.type === 'response') controller.abort();
    });
    expect(mock.raw).toHaveLength(1);
    expect(kinds(store.rows, 'settle')).toHaveLength(1);
    expect(kinds(store.rows, 'settle')[0]!.usage).not.toBeNull();
    expect(result.record.status).toBe('CANCELLED');
    expect(terminalEvent(events)!.type).toBe('cancelled');
    expect(events.at(-1)!.type).toBe('graded');
  });

  it('an abort before run() starts makes no call at all', async () => {
    const controller = new AbortController();
    controller.abort();
    const mock = scriptedTransport(SCENARIOS.toy);
    const { result, store } = await cancelledTrial(mock, controller);
    expect(mock.raw).toHaveLength(0);
    expect(store.rows.filter((r) => r.kind === 'reserve')).toHaveLength(0);
    expect(result.record.status).toBe('CANCELLED');
  });
});

describe('the wall-clock cap in flight', () => {
  it.each(['before-response', 'mid-stream'] as const)('aborts a stalled call (%s) at the remaining budget: 1 fetch, a worst-case settle, LIMIT', async (when) => {
    const trialSignal = new AbortController();
    const wall = new AbortController();
    const asked: number[] = [];
    // The injected clock: 1 s has passed when the request goes out; the timer fires once it is in flight.
    let clock = 0;
    const mock = stallingTransport(when, () => wall.abort(new DOMException('wall clock', 'TimeoutError')));
    const { result, events, store } = await cancelledTrial(mock, trialSignal, () => {}, {
      now: () => (clock += 500),
      maxWallMs: 60_000,
      timeout: (ms) => (asked.push(ms), wall.signal),
    });
    expect(mock.raw).toHaveLength(1);
    expect(asked).toEqual([59_500]);
    expect(kinds(store.rows, 'reserve')).toHaveLength(1);
    expect(kinds(store.rows, 'settle').map((r) => r.usage)).toEqual([null]);
    expect(result.record).toMatchObject({ status: 'LIMIT', detail: 'wall_clock' });
    expect(terminalEvent(events)).toMatchObject({ type: 'limit', limit: 'wall_clock', cap: 60_000 });
    expect(events.at(-1)!.type).toBe('graded');
    expect(Math.round(result.record.cost_usd * 1e6)).toBe(settledMicros(store.rows));
  });
});

describe('record cost and the ledger', () => {
  it('a completed trial records what the ledger settled', async () => {
    const mock = scriptedTransport(SCENARIOS.toy);
    const { result, store } = await cancelledTrial(mock, new AbortController());
    expect(result.record.status).toBe('COMPLETED');
    expect(Math.round(result.record.cost_usd * 1e6)).toBe(settledMicros(store.rows));
  });
});

describe('MessagesClient per-request signal', () => {
  it('rejects an aborted send before reserving, and never retries an abort mid-stream', async () => {
    const pre = new AbortController();
    pre.abort();
    const idle = scriptedTransport(SCENARIOS.toy);
    const a = await clientOver(idle.transport);
    await expect(a.client.send([{ role: 'user', content: 'hi' }], { max_tokens: 16 }, { signal: pre.signal })).rejects.toThrow();
    expect(idle.raw).toHaveLength(0);
    expect(a.store.rows.filter((r) => r.kind === 'reserve')).toHaveLength(0);

    const mid = new AbortController();
    const stall = stallingTransport('mid-stream', () => mid.abort());
    const b = await clientOver(stall.transport);
    const history = [{ role: 'user' as const, content: 'hi' }];
    await expect(b.client.send(history, { max_tokens: 16 }, { signal: mid.signal })).rejects.toThrow();
    expect(stall.raw).toHaveLength(1);
    expect(history).toHaveLength(1);
    expect(kinds(b.store.rows, 'settle').map((r) => r.usage)).toEqual([null]);
  });
});
