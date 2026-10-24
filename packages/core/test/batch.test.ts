// The batch loop (plan phase P12, packages/core/batch.ts) over an in-memory ResultSink and
// LedgerStore, with the toy task's scripted model: 60 trials complete, an abort cancels the
// trials in flight and closes the batch with no reservation left open, a kill during trial 31
// resumes with exactly the 30 unfinished trials, and the projected and actual caps hold.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { scenarioTransport, sse, turnEvents } from '../../../apps/web/src/harness/scenarios.ts';
import { nodeTaskSource } from '../../../cli/adapters/tasks-node.ts';
import { checks as toyChecks } from '../../../tasks/_toy/tests/grader.ts';
import { MessagesClient, MODEL, type Transport } from '../anthropic.ts';
import { BatchRefused, memorySink, runBatch, type BatchDeps, type BatchSpec, type ResultSink } from '../batch.ts';
import { JUDGE_ALLOWANCE_USD, PER_TRIAL_CAP_USD, PRICE_USD_PER_MTOK, RERUN_FACTOR } from '../cost.ts';
import { run } from '../run.ts';
import { ACTUAL_CAP_USD, admitStore, createLedger, PROJECTED_CAP_USD, SpendRefused, totals, type LedgerRow, type LedgerStore } from '../ledger.ts';

const root = new URL('../../../', import.meta.url);
const WORLD = new Uint8Array(readFileSync(new URL('fixtures/world.ndjson.gz', root)));
const WORLD_HASH = (JSON.parse(readFileSync(new URL('fixtures/manifest.json', root), 'utf8')) as { world: { state_hash: string } }).world.state_hash;
const DEFINITIONS = JSON.parse(readFileSync(new URL('fixtures/definitions-pruned.json', root), 'utf8'));
const CALLS_PER_TOY_TRIAL = 5; // three loop turns and two judge items
// What one trial with no cost data adds to a projection, and the fewest trials whose projection
// crosses the projected cap; the caps come from ledger.ts, never as literals.
const PER_TRIAL = PER_TRIAL_CAP_USD * RERUN_FACTOR;
const CROSSING = Math.floor((PROJECTED_CAP_USD - JUDGE_ALLOWANCE_USD) / PER_TRIAL) + 1;

class MemoryStore implements LedgerStore {
  rows: LedgerRow[] = [];
  dead = false; // a killed process writes nothing more
  async transact<T>(fn: (rows: readonly LedgerRow[]) => { append: LedgerRow[]; result: T }): Promise<T> {
    if (this.dead) return new Promise<T>(() => {});
    const { append, result } = fn(this.rows);
    this.rows.push(...append);
    return result;
  }
  async read(): Promise<LedgerRow[]> {
    return [...this.rows];
  }
}

// One "process": its own ledger over the shared store, with its pid; pids in `alive` are running.
function processLedger(store: MemoryStore, pid: number, alive: Set<number>, runId = 'run-1') {
  admitStore(store);
  let id = 0;
  return createLedger({ store, clock: { now: () => '2026-10-24T00:00:00.000Z' }, newId: () => `p${pid}-${++id}`, source: 'node', runId, pid, host: 'h', isAlive: (p) => alive.has(p) });
}

interface Calls {
  n: number;
  byTrial: Map<string, number>;
}

function deps(store: MemoryStore, sink: ResultSink, calls: Calls, opts: { pid?: number; alive?: Set<number>; transport?: (trial: string) => Transport } = {}): BatchDeps {
  const pid = opts.pid ?? 1;
  const ledger = processLedger(store, pid, opts.alive ?? new Set([pid]));
  return {
    ledger,
    rows: () => store.read(),
    sink,
    tasks: nodeTaskSource({ testMode: true }),
    checks: async () => toyChecks,
    world: { read: async () => WORLD },
    worldHash: WORLD_HASH,
    definitions: DEFINITIONS,
    now: () => 0,
    client: (grant, trial) => {
      const inner = opts.transport?.(trial) ?? scenarioTransport('toy').transport;
      const fetch: Transport = (request) => {
        calls.n++;
        calls.byTrial.set(trial, (calls.byTrial.get(trial) ?? 0) + 1);
        return inner(request);
      };
      return new MessagesClient({ grant, ledger, apiKey: 'test-key-not-real', fetch, trial, sleep: async () => {} });
    },
  };
}

const spec = (over: Partial<BatchSpec> = {}): BatchSpec => ({
  runId: 'run-1', taskIds: ['_toy'], trials: 60, model: MODEL, effort: 'high', mode: 'mock-toy', concurrency: 4, observations: [], ...over,
});

const newCalls = (): Calls => ({ n: 0, byTrial: new Map() });
const unsettled = (rows: readonly LedgerRow[]) => {
  const settled = new Set(rows.filter((r) => r.kind === 'settle').map((r) => r.call_id));
  return rows.filter((r) => r.kind === 'reserve' && !settled.has(r.call_id));
};
const keysOf = async (sink: ResultSink) => (await sink.settled()).map((r) => `${r.task_version}/${r.model_requested}/${r.effort}/${r.index}`);

// Each mocked trial loads and hashes the world (about 0.5 s), so the 60-trial cases get 8 minutes (125 s seen under a parallel run).
describe('runBatch', { timeout: 480_000 }, () => {
  it('60 mocked trials complete, each key once, five calls each, and the batch closes', async () => {
    const store = new MemoryStore();
    const sink = memorySink();
    const calls = newCalls();
    const result = await runBatch(spec(), deps(store, sink, calls));
    expect(result.stopped).toBeNull();
    expect(result.settled).toBe(60);
    const keys = await keysOf(sink);
    expect(new Set(keys).size).toBe(60);
    expect((await sink.settled()).every((r) => r.outcome === 'PASS')).toBe(true);
    expect(calls.n).toBe(60 * CALLS_PER_TOY_TRIAL);
    expect(store.rows.filter((r) => r.kind === 'open')).toHaveLength(1);
    expect(store.rows.filter((r) => r.kind === 'close' && r.batch_id === result.batch_id)).toHaveLength(1);
    expect(unsettled(store.rows)).toEqual([]);
    // A rerun of a finished batch finds every key done: no batch, no call.
    const again = newCalls();
    const rerun = await runBatch(spec(), deps(store, sink, again));
    expect(rerun.batch_id).toBeNull();
    expect(again.n).toBe(0);
    expect(store.rows.filter((r) => r.kind === 'open')).toHaveLength(1);
  });

  // A toy trial's requests 1-3 are loop turns and 4-5 judge items; the judge's client gets no
  // signal from run(), so the batch's own signal must reach a judge call in flight.
  it.each([
    ['a loop call', 2],
    ['a judge call', 4],
  ])('aborting its signal with %s in flight cancels the trials in flight, writes the close row and leaves 0 unsettled reservations', async (_what, ordinal) => {
    const store = new MemoryStore();
    const sink = memorySink();
    const calls = newCalls();
    const controller = new AbortController();
    let stalled: string | null = null;
    // From the 40th request on, the first request with this ordinal in its trial stalls until the
    // abort, which comes as it is sent.
    const stall = (trial: string): Transport => {
      const toy = scenarioTransport('toy').transport;
      return async (request) => {
        if (stalled !== null || calls.n < 40 || calls.byTrial.get(trial) !== ordinal) return toy(request);
        stalled = trial;
        await request.text();
        queueMicrotask(() => controller.abort(new Error('operator cancel')));
        return new Promise<Response>((_, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }));
      };
    };
    const result = await runBatch(spec({ signal: controller.signal }), deps(store, sink, calls, { transport: stall }));
    expect(result.cancelled).toBe(true);
    expect(result.stopped).toBeNull();
    expect(result.settled).toBeLessThan(60);
    const requeued = await sink.requeued();
    expect(requeued.some((r) => r.trial_id === stalled)).toBe(true);
    expect((await sink.settled()).some((r) => r.trial_id === stalled)).toBe(false);
    // A judge call cancelled with the batch ends its trial CANCELLED, like a loop call.
    expect(requeued.find((r) => r.trial_id === stalled)).toMatchObject({ status: 'CANCELLED', outcome: 'CANCELLED' });
    expect(store.rows.filter((r) => r.kind === 'close' && r.batch_id === result.batch_id)).toHaveLength(1);
    expect(unsettled(store.rows)).toEqual([]);
    const sent = calls.n;
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.n).toBe(sent);
  });

  it('a sink write that throws mid-batch stops it, lets the trials in flight settle, then closes the grant and writes the manifest last', async () => {
    const store = new MemoryStore();
    const inner = memorySink();
    const ops: string[] = [];
    let finishes = 0;
    const sink: ResultSink = {
      ...inner,
      writeManifest: async (m) => {
        ops.push('manifest');
        await inner.writeManifest(m);
      },
      begin: async (k, a) => {
        ops.push('begin');
        await inner.begin(k, a);
      },
      finish: async (k, r) => {
        if (++finishes === 1) throw new Error('ENOSPC: no space left on device');
        ops.push('finish');
        await inner.finish(k, r);
      },
    };
    await expect(runBatch(spec({ trials: 12 }), deps(store, sink, newCalls()))).rejects.toThrow(/ENOSPC/);
    const closeAt = store.rows.findIndex((r) => r.kind === 'close');
    expect(closeAt).toBeGreaterThan(-1);
    expect(unsettled(store.rows)).toEqual([]);
    const settledAtClose = ops.length;
    expect(ops.at(-1)).toBe('manifest');
    // Nothing is written once the manifest is: the siblings were done before the grant closed.
    await new Promise((r) => setTimeout(r, 3000));
    expect(ops).toHaveLength(settledAtClose);
    expect(store.rows.slice(closeAt + 1)).toEqual([]);
    expect((await inner.manifest())!.batches.at(-1)).toMatchObject({ stopped: 'harness', cancelled: false });
  });

  it('a signal that aborts once the last trial has finished leaves cancelled false; so does an aborted signal with every key recorded', async () => {
    const store = new MemoryStore();
    const sink = memorySink();
    const controller = new AbortController();
    let n = 0;
    const late: typeof run = async (...a) => {
      const r = await run(...a);
      if (++n === 3) controller.abort(new Error('late Ctrl-C'));
      return r;
    };
    const result = await runBatch(spec({ trials: 3, concurrency: 1, signal: controller.signal }), { ...deps(store, sink, newCalls()), run: late });
    expect(result.settled).toBe(3);
    expect(result.cancelled).toBe(false);
    expect((await sink.manifest())!.batches.at(-1)!.cancelled).toBe(false);
    const again = await runBatch(spec({ trials: 3, signal: controller.signal }), deps(store, sink, newCalls()));
    expect(again.batch_id).toBeNull();
    expect(again.cancelled).toBe(false);
  });

  it('two batches started at once on one run: one is refused on the run lock, and each key runs once', async () => {
    const store = new MemoryStore();
    const sink = memorySink();
    const calls = newCalls();
    const alive = new Set([1, 2]);
    const results = await Promise.allSettled([
      runBatch(spec({ trials: 4 }), deps(store, sink, calls, { pid: 1, alive })),
      runBatch(spec({ trials: 4 }), deps(store, sink, calls, { pid: 2, alive })),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toBeInstanceOf(BatchRefused);
    expect((refused.reason as Error).message).toMatch(/locked/);
    expect(calls.n).toBe(4 * CALLS_PER_TOY_TRIAL);
    expect(new Set(await keysOf(sink)).size).toBe(4);
    // The lock is released: a later batch on the run is not refused.
    const later = await runBatch(spec({ trials: 5 }), deps(store, sink, newCalls(), { pid: 3 }));
    expect(later).toMatchObject({ settled: 1, stopped: null });
  });

  it('a kill during trial 31 resumes with 60 unique keys, the partial call billed once, and only the 30 unfinished trials called', async () => {
    const store = new MemoryStore();
    const sink = memorySink();
    const first = newCalls();
    const trial31 = 'mock:run:run-1:_toy/30';
    // Trial 31's second request kills the process: its reserve row is written, nothing after.
    const kill = (trial: string): Transport => {
      const toy = scenarioTransport('toy').transport;
      return async (request) => {
        if (trial === trial31 && first.byTrial.get(trial) === 2) {
          store.dead = true;
          return new Promise<Response>(() => {});
        }
        return toy(request);
      };
    };
    void runBatch(spec({ concurrency: 1 }), deps(store, sink, first, { pid: 101, transport: kill }));
    await expect.poll(() => store.dead, { timeout: 150_000, interval: 50 }).toBe(true);
    expect((await sink.settled()).length).toBe(30);
    const partial = unsettled(store.rows);
    expect(partial).toHaveLength(1);
    expect(partial[0]!.trial).toBe(trial31);

    store.dead = false; // the next process reads the same ledger file
    const second = newCalls();
    // The dead process still holds its in-memory lock; the next one takes over the stale lock.
    const result = await runBatch(spec({ concurrency: 1 }), deps(store, { ...sink, lock: memorySink().lock }, second, { pid: 202 }));
    expect(result.stopped).toBeNull();
    const keys = await keysOf(sink);
    expect(keys).toHaveLength(60);
    expect(new Set(keys).size).toBe(60);
    expect(second.n).toBe(30 * CALLS_PER_TOY_TRIAL);
    // The dead process's batch is closed, and its partial call counts once, at its reservation.
    const dead = store.rows.find((r) => r.kind === 'open' && r.pid === 101)!;
    expect(store.rows.filter((r) => r.kind === 'close' && r.batch_id === dead.batch_id)).toHaveLength(1);
    expect(store.rows.filter((r) => r.call_id === partial[0]!.call_id)).toHaveLength(1);
    expect(totals(store.rows).reserved).toBeCloseTo(partial[0]!.cost_usd, 9);
    expect(totals(store.rows).open).toEqual([]);
  });

  it('a projection that would cross PROJECTED_CAP_USD refuses the batch with 0 calls', async () => {
    const store = new MemoryStore();
    const sink = memorySink();
    const calls = newCalls();
    expect(CROSSING * PER_TRIAL + JUDGE_ALLOWANCE_USD).toBeGreaterThan(PROJECTED_CAP_USD);
    await expect(runBatch(spec({ trials: CROSSING }), deps(store, sink, calls))).rejects.toThrow(SpendRefused);
    expect(calls.n).toBe(0);
    expect(store.rows).toEqual([]);
    expect(await sink.settled()).toEqual([]);
  });

  it('mocked actual spend reaching ACTUAL_CAP_USD aborts the batch', async () => {
    const store = new MemoryStore();
    // Settled already: as much as leaves room under the projected cap for 2 trials.
    const seed = PROJECTED_CAP_USD - 2 * PER_TRIAL - JUDGE_ALLOWANCE_USD - 1;
    store.rows.push(
      { ts: 't', call_id: 'seed', kind: 'reserve', source: 'node', run_id: null, batch_id: null, trial: null, usage: null, cost_usd: seed },
      { ts: 't', call_id: 'seed', kind: 'settle', source: 'node', run_id: null, batch_id: null, trial: null, usage: null, cost_usd: seed },
    );
    const sink = memorySink();
    const calls = newCalls();
    // Every answer bills enough output tokens to take settled spend to the actual cap.
    const outputTokens = Math.ceil(((ACTUAL_CAP_USD - seed) / PRICE_USD_PER_MTOK.output) * 1e6);
    const expensive = (): Transport => async (request) => {
      await request.text();
      const events = turnEvents({ tools: [{ id: 'toolu_x', name: 'get_context', input: {} }] }, 1).map((e) =>
        (e as { type: string }).type === 'message_delta' ? { ...e, usage: { output_tokens: outputTokens } } : e,
      );
      return new Response(sse(events), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
    const result = await runBatch(spec({ trials: 2, concurrency: 1 }), deps(store, sink, calls, { transport: expensive }));
    expect(result.stopped?.code).toBe('actual_cap');
    expect(calls.n).toBe(1);
    expect(totals(store.rows).settled).toBeGreaterThanOrEqual(ACTUAL_CAP_USD);
    expect(store.rows.filter((r) => r.kind === 'close' && r.batch_id === result.batch_id)).toHaveLength(1);
    expect(unsettled(store.rows)).toEqual([]);
  });
});
