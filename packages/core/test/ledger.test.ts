import { describe, expect, it } from 'vitest';
import {
  assertGrant,
  createLedger,
  SpendRefused,
  totals,
  type BatchGrant,
  type Ledger,
  type LedgerRow,
  type LedgerStore,
} from '../ledger.ts';
import { usageCostUsd, worstCaseUsd, type Usage } from '../cost.ts';

// An in-memory LedgerStore: a promise chain stands in for the file lock, and a throwing
// transaction appends nothing, as in the Node adapter.
class MemoryStore implements LedgerStore {
  rows: LedgerRow[] = [];
  private chain: Promise<unknown> = Promise.resolve();
  transact<T>(fn: (rows: readonly LedgerRow[]) => { append: LedgerRow[]; result: T }): Promise<T> {
    const run = this.chain.then(() => {
      const { append, result } = fn(this.rows);
      this.rows.push(...append);
      return result;
    });
    this.chain = run.catch(() => undefined);
    return run;
  }
  async read(): Promise<LedgerRow[]> {
    return [...this.rows];
  }
}

function ledgerOn(store: MemoryStore, pid = 1): Ledger {
  let n = 0;
  return createLedger({
    store,
    clock: { now: () => '2026-10-23T00:00:00.000Z' },
    newId: () => `id-${pid}-${++n}`,
    source: 'node',
    runId: 'run-test',
    pid,
    host: 'test-host',
  });
}

function seedSettled(store: MemoryStore, usd: number, call_id = `seed-${store.rows.length}`): void {
  store.rows.push({
    ts: '2026-10-22T00:00:00.000Z', call_id, kind: 'settle', source: 'node', run_id: 'seed',
    batch_id: null, trial: null, usage: null, cost_usd: usd,
  });
}

// A stand-in Messages client: like the P2 client it can only be built from a grant, and it
// counts the calls that reach the transport.
function fakeClient(grant: unknown, respond: (signal: AbortSignal) => Promise<Usage>) {
  assertGrant(grant);
  const client = {
    calls: 0,
    send: (maxTokens = 1000) =>
      grant.metered({ bodyBytes: 1000, maxTokens, trial: 't1' }, async (signal) => {
        client.calls++;
        return { usage: await respond(signal) };
      }),
  };
  return client;
}

const SMALL: Usage = { input_tokens: 100, output_tokens: 10 };
const usdOutput = (usd: number): Usage => ({ input_tokens: 0, output_tokens: Math.round((usd / 20) * 1e6) });

describe('cost model', () => {
  it('prices usage per MTok: $4 in, $5 5-minute write, $8 1-hour write, $0.20 read, $20 out (case 15)', () => {
    expect(usageCostUsd({ input_tokens: 1e6, output_tokens: 0 })).toBeCloseTo(4, 9);
    expect(usageCostUsd({ input_tokens: 0, output_tokens: 1e6 })).toBeCloseTo(20, 9);
    expect(usageCostUsd({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1e6 })).toBeCloseTo(0.2, 9);
    // Without the breakdown every cache write is a 5-minute write: the P2 client sends no other.
    expect(usageCostUsd({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1e6 })).toBeCloseTo(5, 9);
    expect(
      usageCostUsd({
        input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 2e6,
        cache_creation: { ephemeral_5m_input_tokens: 1e6, ephemeral_1h_input_tokens: 1e6 },
      }),
    ).toBeCloseTo(13, 9);
  });

  it('reserves body bytes as tokens at the $5 write price plus max_tokens at $20/MTok', () => {
    expect(worstCaseUsd({ bodyBytes: 1e6, maxTokens: 1e6 })).toBeCloseTo(25, 9);
    expect(worstCaseUsd({ bodyBytes: 200_000, maxTokens: 32_000 })).toBeCloseTo(1 + 0.64, 9);
  });
});

describe('projected cap at batch start', () => {
  it('starts a batch at 449.99 and refuses 450.01 with 0 calls made (case 4)', async () => {
    const ok = await ledgerOn(new MemoryStore()).batchStart(449.99);
    assertGrant(ok);

    const store = new MemoryStore();
    let calls = 0;
    await expect(
      ledgerOn(store)
        .batchStart(450.01)
        .then((g) => fakeClient(g, async () => (calls++, SMALL)).send()),
    ).rejects.toThrow(SpendRefused);
    expect(calls).toBe(0);
    expect(store.rows).toEqual([]);
  });

  it('throws and returns no grant when ledger + projection = 450.01 (case 11)', async () => {
    const store = new MemoryStore();
    seedSettled(store, 100);
    let grant: BatchGrant | undefined;
    await expect(
      ledgerOn(store)
        .batchStart(350.01)
        .then((g) => (grant = g)),
    ).rejects.toThrow(/projected/);
    expect(grant).toBeUndefined();
    expect(store.rows.filter((r) => r.kind === 'open')).toEqual([]);
    // The same batch one cent smaller fits.
    assertGrant(await ledgerOn(store).batchStart(350));
  });

  it('counts other open batches at max(projection, own settled + reserved) until closed', async () => {
    const store = new MemoryStore();
    const a = await ledgerOn(store, 1).batchStart(200);
    await expect(ledgerOn(store, 2).batchStart(250.01)).rejects.toThrow(SpendRefused);
    // a overruns its projection: it counts at its own spend, 210.
    await a.settle(await a.reserve({ bodyBytes: 0, maxTokens: 0 }), usdOutput(210));
    expect(totals(store.rows).exposure).toBeCloseTo(210, 6);
    await expect(ledgerOn(store, 2).batchStart(240.01)).rejects.toThrow(SpendRefused);
    await a.close();
    // Closed: only its settled 210 counts.
    assertGrant(await ledgerOn(store, 2).batchStart(240));
  });
});

describe('actual cap', () => {
  it('aborts in-flight calls and refuses the next call at 500.00 actual (case 5)', async () => {
    const store = new MemoryStore();
    seedSettled(store, 300);
    const grant = await ledgerOn(store).batchStart(100);
    const hang = fakeClient(grant, (signal) => new Promise<Usage>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))));
    const inFlight = hang.send();
    // Another call settles at $200.00 actual, so settled reaches exactly $500.00.
    const big = fakeClient(grant, async () => usdOutput(200));
    await big.send();
    expect(totals(store.rows).settled).toBeCloseTo(500, 6);
    expect(grant.signal.aborted).toBe(true);
    await expect(inFlight).rejects.toThrow();
    const next = fakeClient(grant, async () => SMALL);
    await expect(next.send()).rejects.toThrow(/actual/);
    expect(next.calls).toBe(0);
    // A fresh batch is refused too.
    await expect(ledgerOn(store, 2).batchStart(0)).rejects.toThrow(SpendRefused);
  });

  it('aborts every grant of this process when another process takes settled to $500', async () => {
    const store = new MemoryStore();
    seedSettled(store, 400);
    const ledger = ledgerOn(store);
    const a = await ledger.batchStart(10);
    const b = await ledger.batchStart(10);
    seedSettled(store, 100); // settled by another process
    await expect(a.reserve({ bodyBytes: 1, maxTokens: 1 })).rejects.toThrow(/actual/);
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(true);
  });

  it('refuses a reservation that would take settled + reserved past $500', async () => {
    const store = new MemoryStore();
    seedSettled(store, 400);
    const grant = await ledgerOn(store).batchStart(50);
    seedSettled(store, 99); // spend from another source after batch start
    await grant.reserve({ bodyBytes: 0, maxTokens: 50_000 }); // $1.00, settled + reserved = 500.00
    await expect(grant.reserve({ bodyBytes: 0, maxTokens: 1 })).rejects.toThrow(/actual/);
    const t = totals(store.rows);
    expect(t.settled + t.reserved).toBeCloseTo(500, 6);
  });

  it('records a settle above its reservation at actual and blocks the next call (case 15)', async () => {
    const store = new MemoryStore();
    seedSettled(store, 440);
    const grant = await ledgerOn(store).batchStart(5);
    const res = await grant.reserve({ bodyBytes: 100, maxTokens: 100 });
    expect(res.worst_usd).toBeLessThan(0.01);
    // 1-hour cache writes at $8/MTok: 7.5M tokens is $60, far above the reservation.
    await grant.settle(res, { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 7.5e6, cache_creation: { ephemeral_1h_input_tokens: 7.5e6 } });
    const settle = store.rows.find((r) => r.kind === 'settle' && r.call_id === res.call_id);
    expect(settle?.cost_usd).toBeCloseTo(60, 6);
    expect(totals(store.rows).settled).toBeCloseTo(500, 6);
    expect(grant.signal.aborted).toBe(true);
    await expect(grant.reserve({ bodyBytes: 1, maxTokens: 1 })).rejects.toThrow(/actual/);
  });
});

describe('settle on failure', () => {
  it('writes a worst-case settle row for a dropped stream and for a 529 after a partial stream (case 7)', async () => {
    const store = new MemoryStore();
    const grant = await ledgerOn(store).batchStart(10);
    const worst = worstCaseUsd({ bodyBytes: 1000, maxTokens: 1000 });

    const dropped = fakeClient(grant, async () => {
      throw new Error('stream dropped after message_start');
    });
    await expect(dropped.send()).rejects.toThrow(/dropped/);

    const overloaded = fakeClient(grant, async () => {
      throw Object.assign(new Error('overloaded_error after partial stream'), { status: 529 });
    });
    await expect(overloaded.send()).rejects.toThrow(/overloaded/);

    const settles = store.rows.filter((r) => r.kind === 'settle');
    expect(settles).toHaveLength(2);
    for (const s of settles) {
      expect(s.usage).toBeNull();
      expect(s.cost_usd).toBeCloseTo(worst, 9);
      expect(store.rows.some((r) => r.kind === 'reserve' && r.call_id === s.call_id)).toBe(true);
    }
    expect(totals(store.rows).reserved).toBe(0);
  });

  it('settles a completed call at its actual cost', async () => {
    const store = new MemoryStore();
    const grant = await ledgerOn(store).batchStart(10);
    await fakeClient(grant, async () => SMALL).send();
    expect(totals(store.rows).settled).toBeCloseTo(usageCostUsd(SMALL), 9);
    expect(totals(store.rows).reserved).toBe(0);
  });
});

describe('restart', () => {
  it('re-reads settled, unsettled reservations and open projections from the store (case 10)', async () => {
    const store = new MemoryStore();
    seedSettled(store, 12.5);
    const grant = await ledgerOn(store, 1).batchStart(30);
    const res = await grant.reserve({ bodyBytes: 0, maxTokens: 100_000 }); // $2, never settled
    expect(res.worst_usd).toBeCloseTo(2, 9);
    // The first process is gone; a new one reads the same store.
    const t = await ledgerOn(store, 2).totals();
    expect(t.settled).toBeCloseTo(12.5, 9);
    expect(t.reserved).toBeCloseTo(2, 9);
    expect(t.open).toEqual([expect.objectContaining({ batch_id: grant.batch_id, projection: 30, pid: 1, host: 'test-host' })]);
    expect(t.exposure).toBeCloseTo(12.5 + 30, 9);
  });

  it('keeps a closed batch’s settled rows and unsettled reservations', async () => {
    const store = new MemoryStore();
    const grant = await ledgerOn(store, 1).batchStart(30);
    await grant.reserve({ bodyBytes: 0, maxTokens: 100_000 });
    await ledgerOn(store, 2).close(grant.batch_id);
    const t = totals(store.rows);
    expect(t.open).toEqual([]);
    expect(t.exposure).toBeCloseTo(2, 9);
    // Closing twice is a no-op.
    await ledgerOn(store, 2).close(grant.batch_id);
    expect(store.rows.filter((r) => r.kind === 'close')).toHaveLength(1);
  });
});

describe('grant capability', () => {
  it('throws on {}, on a structural copy of a real grant and on a closed grant (case 13)', async () => {
    const grant = await ledgerOn(new MemoryStore()).batchStart(1);
    expect(() => assertGrant(grant)).not.toThrow();
    expect(() => assertGrant({})).toThrow(/grant/);
    expect(() => assertGrant(null)).toThrow(/grant/);
    expect(() => assertGrant({ ...grant })).toThrow(/grant/);
    expect(() => assertGrant(Object.assign(Object.create(Object.getPrototypeOf(grant) as object), grant))).toThrow(/grant/);
    await grant.close();
    expect(() => assertGrant(grant)).toThrow(/closed/);
    await expect(grant.reserve({ bodyBytes: 1, maxTokens: 1 })).rejects.toThrow(/closed/);
  });
});

describe('ingest', () => {
  it('appends rows by (call_id, kind) once', async () => {
    const store = new MemoryStore();
    const rows: LedgerRow[] = [
      { ts: 't', call_id: 'b1', kind: 'reserve', source: 'browser', run_id: 'r', batch_id: null, trial: null, usage: null, cost_usd: 1 },
      { ts: 't', call_id: 'b1', kind: 'settle', source: 'browser', run_id: 'r', batch_id: null, trial: null, usage: SMALL, cost_usd: 0.5 },
    ];
    expect(await ledgerOn(store).ingest(rows)).toBe(2);
    expect(await ledgerOn(store).ingest(rows)).toBe(0);
    expect(totals(store.rows).settled).toBeCloseTo(0.5, 9);
  });
});
