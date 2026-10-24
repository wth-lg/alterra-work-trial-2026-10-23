import { describe, expect, it } from 'vitest';
import {
  ACTUAL_CAP_USD,
  admitStore,
  assertGrant,
  createLedger,
  parseRow,
  PROJECTED_CAP_USD,
  SpendRefused,
  totals,
  type BatchGrant,
  type Ledger,
  type LedgerRow,
  type LedgerStore,
} from '../ledger.ts';
import { INPUT_OVERHEAD_TOKENS, usageCostUsd, worstCaseUsd, type Usage } from '../cost.ts';

// An in-memory LedgerStore: a promise chain stands in for the file lock, and a throwing
// transaction appends nothing, as in the Node adapter. ledgerOn admits it, as an adapter
// admits the stores it opens.
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

// `alive` lists the pids that count as running on test-host; every other pid is dead.
function ledgerOn(store: MemoryStore, pid = 1, alive: readonly number[] = [pid]): Ledger {
  let n = 0;
  admitStore(store);
  return createLedger({
    store,
    clock: { now: () => '2026-10-23T00:00:00.000Z' },
    newId: () => `id-${pid}-${++n}`,
    source: 'node',
    runId: 'run-test',
    pid,
    host: 'test-host',
    isAlive: (p) => alive.includes(p),
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

  it('reserves body bytes plus the overhead allowance as tokens at the $8 1-hour write price, plus max_tokens at $20/MTok', () => {
    expect(worstCaseUsd({ bodyBytes: 1e6, maxTokens: 1e6 })).toBeCloseTo(((1e6 + INPUT_OVERHEAD_TOKENS) * 8) / 1e6 + 20, 9);
    expect(worstCaseUsd({ bodyBytes: 200_000, maxTokens: 32_000 })).toBeCloseTo(((200_000 + INPUT_OVERHEAD_TOKENS) * 8) / 1e6 + 0.64, 9);
  });
});

// The decided caps (2026-10-24): $950 projected, $1,000 actual. Every other test derives its
// thresholds from the constants; this one pins the numbers.
describe('cap values', () => {
  it('starts a batch at 949.99 and refuses 950.01', async () => {
    expect(PROJECTED_CAP_USD).toBe(950);
    assertGrant(await ledgerOn(new MemoryStore()).batchStart(949.99));
    await expect(ledgerOn(new MemoryStore()).batchStart(950.01)).rejects.toThrow(/projected/);
  });

  // The smallest call reserves about $0.03 (the input overhead allowance), so the cheapest call
  // that fits is one whose worst case takes settled + reserved to exactly $1,000.
  it('is not blocked at settled 999.99, admits a call that ends exactly at 1000, and blocks every call at 1000', async () => {
    expect(ACTUAL_CAP_USD).toBe(1000);
    const store = new MemoryStore();
    const grant = await ledgerOn(store).batchStart(0);
    seedSettled(store, 999.99);
    expect(totals(store.rows).blocked).toBe(false);
    await expect(grant.reserve({ bodyBytes: 0, maxTokens: 0 })).rejects.toThrow(/actual cap: .* worst case/);
    store.rows.length = 0;
    const grant2 = await ledgerOn(store).batchStart(0);
    seedSettled(store, 1000 - worstCaseUsd({ bodyBytes: 0, maxTokens: 0 }));
    const res = await grant2.reserve({ bodyBytes: 0, maxTokens: 0 });
    await grant2.settle(res, { input_tokens: 0, output_tokens: 0 });
    seedSettled(store, 1000 - totals(store.rows).settled);
    expect(totals(store.rows).blocked).toBe(true);
    await expect(grant2.reserve({ bodyBytes: 0, maxTokens: 0 })).rejects.toThrow(/actual cap: settled .* has reached/);
  });
});

describe('projected cap at batch start', () => {
  it('starts a batch one cent under the projected cap and refuses one cent over with 0 calls made (case 4)', async () => {
    const ok = await ledgerOn(new MemoryStore()).batchStart(PROJECTED_CAP_USD - 0.01);
    assertGrant(ok);

    const store = new MemoryStore();
    let calls = 0;
    await expect(
      ledgerOn(store)
        .batchStart(PROJECTED_CAP_USD + 0.01)
        .then((g) => fakeClient(g, async () => (calls++, SMALL)).send()),
    ).rejects.toThrow(SpendRefused);
    expect(calls).toBe(0);
    expect(store.rows).toEqual([]);
  });

  it('throws and returns no grant when ledger + projection is one cent over the projected cap (case 11)', async () => {
    const store = new MemoryStore();
    seedSettled(store, 100);
    let grant: BatchGrant | undefined;
    await expect(
      ledgerOn(store)
        .batchStart(PROJECTED_CAP_USD - 100 + 0.01)
        .then((g) => (grant = g)),
    ).rejects.toThrow(/projected/);
    expect(grant).toBeUndefined();
    expect(store.rows.filter((r) => r.kind === 'open')).toEqual([]);
    // The same batch one cent smaller fits.
    assertGrant(await ledgerOn(store).batchStart(PROJECTED_CAP_USD - 100));
  });

  it('counts other open batches at max(projection, own settled + reserved) until closed', async () => {
    const store = new MemoryStore();
    const a = await ledgerOn(store, 1).batchStart(200);
    await expect(ledgerOn(store, 2).batchStart(PROJECTED_CAP_USD - 200 + 0.01)).rejects.toThrow(SpendRefused);
    // a overruns its projection: it counts at its own spend, 210.
    await a.settle(await a.reserve({ bodyBytes: 0, maxTokens: 0 }), usdOutput(210));
    expect(totals(store.rows).exposure).toBeCloseTo(210, 6);
    await expect(ledgerOn(store, 2).batchStart(PROJECTED_CAP_USD - 210 + 0.01)).rejects.toThrow(SpendRefused);
    await a.close();
    // Closed: only its settled 210 counts.
    assertGrant(await ledgerOn(store, 2).batchStart(PROJECTED_CAP_USD - 210));
  });
});

describe('actual cap', () => {
  it('aborts in-flight calls and refuses the next call when settled reaches the actual cap (case 5)', async () => {
    const store = new MemoryStore();
    // The batch opens before the seed, so this setup holds for any PROJECTED_CAP_USD >= 100.
    const grant = await ledgerOn(store).batchStart(100);
    seedSettled(store, ACTUAL_CAP_USD - 200);
    const hang = fakeClient(grant, (signal) => new Promise<Usage>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))));
    const inFlight = hang.send();
    // Another call settles at $200.00 actual, so settled reaches exactly ACTUAL_CAP_USD.
    const big = fakeClient(grant, async () => usdOutput(200));
    await big.send();
    expect(totals(store.rows).settled).toBeCloseTo(ACTUAL_CAP_USD, 6);
    expect(grant.signal.aborted).toBe(true);
    await expect(inFlight).rejects.toThrow();
    const next = fakeClient(grant, async () => SMALL);
    await expect(next.send()).rejects.toThrow(/actual/);
    expect(next.calls).toBe(0);
    // A fresh batch is refused too.
    await expect(ledgerOn(store, 2).batchStart(0)).rejects.toThrow(SpendRefused);
  });

  it('aborts every grant of this process when another process takes settled to the actual cap', async () => {
    const store = new MemoryStore();
    const ledger = ledgerOn(store);
    const a = await ledger.batchStart(10);
    const b = await ledger.batchStart(10);
    seedSettled(store, ACTUAL_CAP_USD); // settled by another process
    await expect(a.reserve({ bodyBytes: 1, maxTokens: 1 })).rejects.toThrow(/actual/);
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(true);
  });

  it('refuses a reservation that would take settled + reserved past the actual cap', async () => {
    const store = new MemoryStore();
    // The batch fills the projected cap exactly.
    const grant = await ledgerOn(store).batchStart(PROJECTED_CAP_USD);
    const w = worstCaseUsd({ bodyBytes: 0, maxTokens: 50_000 }); // about $1.03
    seedSettled(store, ACTUAL_CAP_USD - w); // spend from another source after batch start
    await grant.reserve({ bodyBytes: 0, maxTokens: 50_000 }); // settled + reserved = ACTUAL_CAP_USD
    await expect(grant.reserve({ bodyBytes: 0, maxTokens: 1 })).rejects.toThrow(/actual/);
    const t = totals(store.rows);
    expect(t.settled + t.reserved).toBeCloseTo(ACTUAL_CAP_USD, 6);
  });

  it('refuses a batch at the actual cap, not the projected one, and aborts live grants', async () => {
    const store = new MemoryStore();
    const ledger = ledgerOn(store);
    const a = await ledger.batchStart(0);
    seedSettled(store, ACTUAL_CAP_USD);
    // Settled at ACTUAL_CAP_USD is also past the projected cap; the refusal must name the actual
    // cap, since only that refusal aborts this process's grants.
    const refused = await ledger.batchStart(0).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(SpendRefused);
    expect((refused as SpendRefused).cap).toBe('actual');
    expect((refused as SpendRefused).message).toMatch(/has reached/);
    expect(a.signal.aborted).toBe(true);
  });

  it('records a settle above its reservation at actual and blocks the next call (case 15)', async () => {
    const store = new MemoryStore();
    const grant = await ledgerOn(store).batchStart(5);
    seedSettled(store, ACTUAL_CAP_USD - 60);
    const res = await grant.reserve({ bodyBytes: 100, maxTokens: 100 });
    expect(res.worst_usd).toBeLessThan(0.1);
    // 1-hour cache writes at $8/MTok: 7.5M tokens is $60, far above the reservation.
    await grant.settle(res, { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 7.5e6, cache_creation: { ephemeral_1h_input_tokens: 7.5e6 } });
    const settle = store.rows.find((r) => r.kind === 'settle' && r.call_id === res.call_id);
    expect(settle?.cost_usd).toBeCloseTo(60, 6);
    expect(totals(store.rows).settled).toBeCloseTo(ACTUAL_CAP_USD, 6);
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
    expect(totals(store.rows).settled).toBeCloseTo(usageCostUsd(SMALL) as number, 9);
    expect(totals(store.rows).reserved).toBe(0);
  });
});

describe('restart', () => {
  it('re-reads settled, unsettled reservations and open projections from the store (case 10)', async () => {
    const store = new MemoryStore();
    seedSettled(store, 12.5);
    const grant = await ledgerOn(store, 1).batchStart(30);
    const res = await grant.reserve({ bodyBytes: 0, maxTokens: 100_000 }); // about $2, never settled
    const w = worstCaseUsd({ bodyBytes: 0, maxTokens: 100_000 });
    expect(res.worst_usd).toBeCloseTo(w, 9);
    // The first process is gone; a new one reads the same store.
    const t = await ledgerOn(store, 2).totals();
    expect(t.settled).toBeCloseTo(12.5, 9);
    expect(t.reserved).toBeCloseTo(w, 9);
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
    expect(t.exposure).toBeCloseTo(worstCaseUsd({ bodyBytes: 0, maxTokens: 100_000 }), 9);
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

describe('numeric inputs at the ledger boundary', () => {
  const bad: Array<[string, { bodyBytes: number; maxTokens: number }]> = [
    ['maxTokens missing', { bodyBytes: 10 } as { bodyBytes: number; maxTokens: number }],
    ['maxTokens NaN', { bodyBytes: 10, maxTokens: Number.NaN }],
    ['maxTokens negative', { bodyBytes: 10, maxTokens: -1_000_000 }],
    ['maxTokens fractional', { bodyBytes: 10, maxTokens: 1.5 }],
    ['bodyBytes NaN', { bodyBytes: Number.NaN, maxTokens: 10 }],
    ['bodyBytes negative', { bodyBytes: -10, maxTokens: 10 }],
    ['bodyBytes infinite', { bodyBytes: Number.POSITIVE_INFINITY, maxTokens: 10 }],
  ];

  it('rejects a non-finite, negative or fractional bodyBytes or maxTokens before any row or call', async () => {
    const store = new MemoryStore();
    const grant = await ledgerOn(store).batchStart(0);
    seedSettled(store, ACTUAL_CAP_USD - 0.01);
    const before = store.rows.length;
    for (const [why, req] of bad) {
      let calls = 0;
      await expect(grant.metered(req, async () => (calls++, { usage: SMALL })), why).rejects.toThrow(TypeError);
      expect(calls, why).toBe(0);
      expect(store.rows.length, why).toBe(before);
    }
    expect(() => totals(store.rows)).not.toThrow();
  });

  it('settles a usage that cannot be priced at the reservation’s worst case, never null', async () => {
    const usages: Array<[string, unknown]> = [
      ['input_tokens missing', { output_tokens: 10 }],
      ['output_tokens NaN', { input_tokens: 10, output_tokens: Number.NaN }],
      ['negative output_tokens', { input_tokens: 10, output_tokens: -5_000_000 }],
      ['negative cache read', { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: -1e9 }],
      ['string tokens', { input_tokens: '10', output_tokens: 10 }],
      ['unknown speed', { input_tokens: 10, output_tokens: 10, speed: 'warp' }],
      ['not an object', 'usage'],
    ];
    for (const [why, usage] of usages) {
      const store = new MemoryStore();
      const grant = await ledgerOn(store).batchStart(10);
      const res = await grant.reserve({ bodyBytes: 1000, maxTokens: 1000 });
      await grant.settle(res, usage as Usage);
      const settle = store.rows.find((r) => r.kind === 'settle');
      expect(settle?.cost_usd, why).toBeCloseTo(worstCaseUsd({ bodyBytes: 1000, maxTokens: 1000 }), 9);
      expect(() => parseRow(JSON.parse(JSON.stringify(settle))), why).not.toThrow();
      expect(totals(store.rows).reserved, why).toBe(0);
    }
  });

  it('rejects an open row whose projection is missing, non-numeric or negative, so batchStart cannot pass on NaN', async () => {
    const open = { ts: 't', call_id: 'open:x', kind: 'open', source: 'node', run_id: null, batch_id: 'x', trial: null, usage: null, cost_usd: 0, pid: 9, host: 'h' };
    for (const projection of [undefined, 'lots', -1, null]) {
      expect(() => parseRow({ ...open, projection }), String(projection)).toThrow(/not a ledger row/);
    }
    expect(parseRow({ ...open, projection: 300 }).projection).toBe(300);
    const store = new MemoryStore();
    store.rows.push({ ...open, projection: 'lots' } as unknown as LedgerRow);
    await expect(ledgerOn(store).batchStart(10_000)).rejects.toThrow(/not a ledger row/);
  });
});

describe('settle is authoritative per call_id', () => {
  it('records the highest settle: a forged cheap settle before the real one cannot lower spend', async () => {
    const store = new MemoryStore();
    const ledger = ledgerOn(store);
    const grant = await ledger.batchStart(200);
    const res = await grant.reserve({ bodyBytes: 0, maxTokens: 100_000 });
    await ledger.settle({ ...res, worst_usd: 0 }, { input_tokens: 0, output_tokens: 0 });
    await grant.settle(res, usdOutput(100));
    expect(totals(store.rows).settled).toBeCloseTo(100, 6);
    // A lower settle afterwards changes nothing and writes nothing.
    const n = store.rows.length;
    await grant.settle(res, { input_tokens: 0, output_tokens: 0 });
    expect(totals(store.rows).settled).toBeCloseTo(100, 6);
    expect(store.rows).toHaveLength(n);
  });

  it('takes the worst case from the ledger’s reserve row, not the caller’s Reservation', async () => {
    const store = new MemoryStore();
    const grant = await ledgerOn(store).batchStart(10);
    const res = await grant.reserve({ bodyBytes: 1000, maxTokens: 1000 });
    await grant.settle({ ...res, worst_usd: 0 }, null);
    expect(totals(store.rows).settled).toBeCloseTo(worstCaseUsd({ bodyBytes: 1000, maxTokens: 1000 }), 9);
  });

  it('refuses to settle a call_id it never reserved', async () => {
    const store = new MemoryStore();
    const ledger = ledgerOn(store);
    await expect(ledger.settle({ call_id: 'never-reserved', batch_id: null, trial: null, worst_usd: 0 }, SMALL)).rejects.toThrow(/reserv/);
    expect(store.rows).toEqual([]);
  });
});

describe('ingest accepts only browser reserve and settle rows', () => {
  const browser = (kind: 'reserve' | 'settle', call_id: string, cost_usd: number): LedgerRow => ({
    ts: 't', call_id, kind, source: 'browser', run_id: 'r', batch_id: null, trial: null, usage: null, cost_usd,
  });

  it('refuses node rows, open and close rows, and a settle for a call the browser did not reserve; appends nothing', async () => {
    const store = new MemoryStore();
    seedSettled(store, 100);
    const grant = await ledgerOn(store).batchStart(300);
    const inflight = await grant.reserve({ bodyBytes: 0, maxTokens: 100_000 });
    const before = store.rows.length;
    const exposure = totals(store.rows).exposure;
    const forged: Array<[string, LedgerRow]> = [
      ['node settle', { ...browser('settle', inflight.call_id, 0), source: 'node' }],
      ['browser settle for a node call', browser('settle', inflight.call_id, 0)],
      ['browser settle with no reservation', browser('settle', 'b-unknown', 0)],
      ['close row', { ...browser('reserve', `close:${grant.batch_id}`, 0), kind: 'close', batch_id: grant.batch_id }],
      ['open row', { ...browser('reserve', 'open:b', 0), kind: 'open', batch_id: 'b', projection: 0 }],
    ];
    for (const [why, row] of forged) {
      await expect(ledgerOn(store, 2).ingest([browser('reserve', `ok-${why}`, 1), row]), why).rejects.toThrow();
      expect(store.rows.length, why).toBe(before);
    }
    expect(totals(store.rows).exposure).toBeCloseTo(exposure, 9);
    // The real settle still counts.
    await grant.settle(inflight, usdOutput(20));
    expect(totals(store.rows).settled).toBeCloseTo(120, 6);
  });

  it('keeps the highest browser settle and dedupes repeats', async () => {
    const store = new MemoryStore();
    const ledger = ledgerOn(store);
    expect(await ledger.ingest([browser('reserve', 'b1', 3), browser('settle', 'b1', 2)])).toBe(2);
    expect(await ledger.ingest([browser('settle', 'b1', 0.5)])).toBe(0);
    expect(await ledger.ingest([browser('reserve', 'b1', 3), browser('settle', 'b1', 2)])).toBe(0);
    expect(totals(store.rows).settled).toBeCloseTo(2, 9);
  });
});

describe('grant binding', () => {
  it('a grant passes assertGrant only for the ledger that minted it', async () => {
    const a = ledgerOn(new MemoryStore());
    const b = ledgerOn(new MemoryStore());
    const grant = await a.batchStart(1);
    expect(() => assertGrant(grant, a)).not.toThrow();
    expect(() => assertGrant(grant, b)).toThrow(/grant/);
  });
});

describe('closing a batch', () => {
  it('refuses to close a batch whose pid is alive on this host unless forced, and records the reason', async () => {
    const store = new MemoryStore();
    seedSettled(store, 100);
    const grant = await ledgerOn(store, 1).batchStart(300);
    const cli = ledgerOn(store, 2, [1, 2]); // pid 1 is still running
    await expect(cli.close(grant.batch_id)).rejects.toThrow(/alive/);
    expect(store.rows.filter((r) => r.kind === 'close')).toEqual([]);
    // The open batch still counts at its 300 projection.
    await expect(ledgerOn(store, 3).batchStart(PROJECTED_CAP_USD - 100 - 300 + 0.01)).rejects.toThrow(SpendRefused);

    expect(await cli.close(grant.batch_id, { force: 'stuck in a retry loop, killed by hand' })).toBe(true);
    expect(store.rows.find((r) => r.kind === 'close')?.reason).toBe('stuck in a retry loop, killed by hand');
    // The closed batch's grant cannot reserve any more.
    await expect(grant.reserve({ bodyBytes: 1, maxTokens: 1 })).rejects.toThrow(/closed/);
  });

  it('refuses to close a batch opened on another host unless forced', async () => {
    const store = new MemoryStore();
    const other = createLedger({
      store, clock: { now: () => 't' }, newId: () => 'b-other', source: 'node', runId: null, pid: 1, host: 'other-host', isAlive: () => false,
    });
    const grant = await other.batchStart(10);
    await expect(ledgerOn(store, 2).close(grant.batch_id)).rejects.toThrow(/other-host/);
    expect(await ledgerOn(store, 2).close(grant.batch_id, { force: 'other host rebooted' })).toBe(true);
  });
});

// Security review P12b-3 F2: a caller's spend ceiling (the local runner's session cap) holds at
// reserve time, so a batch's reruns cannot settle past it.
describe('spend ceiling', () => {
  const inRun = (runId: string | null) => runId === 'run-test';
  const ceiling = (usd: number) => ({ usd, scope: inRun, what: 'session cap' });
  // A reservation whose worst case is `usd`: the input overhead plus output tokens.
  const worth = (usd: number) => ({ bodyBytes: 0, maxTokens: Math.round(((usd - worstCaseUsd({ bodyBytes: 0, maxTokens: 0 })) / 20) * 1e6) });
  const seedRun = (store: MemoryStore, run_id: string, usd: number) =>
    store.rows.push({ ts: 't', call_id: `seed-${run_id}-${store.rows.length}`, kind: 'settle', source: 'node', run_id, batch_id: null, trial: null, usage: null, cost_usd: usd });

  it('refuses a batch whose projection with the in-scope exposure would cross the ceiling; rows out of scope do not count', async () => {
    const store = new MemoryStore();
    seedRun(store, 'run-test', 3);
    seedRun(store, 'elsewhere', 500);
    const err = await ledgerOn(store).batchStart(7.01, ceiling(10)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpendRefused);
    expect((err as SpendRefused).cap).toBe('ceiling');
    expect((err as Error).message).toMatch(/session cap/);
    expect(store.rows.some((r) => r.kind === 'open')).toBe(false);
    assertGrant(await ledgerOn(store).batchStart(7, ceiling(10)));
  });

  it('admits reserves within the projection, refuses the one that would cross the ceiling, and settles what was reserved', async () => {
    const store = new MemoryStore();
    const grant = await ledgerOn(store).batchStart(6, ceiling(8));
    await grant.settle(await grant.reserve(worth(5)), null);
    // 5 + 2.5 = 7.5 is past the projection but within the ceiling.
    const b = await grant.reserve(worth(2.5));
    const before = store.rows.length;
    const err = await grant.reserve(worth(0.6)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpendRefused);
    expect((err as SpendRefused).cap).toBe('ceiling');
    expect(store.rows.length).toBe(before);
    await grant.settle(b, null);
    const t = totals(store.rows);
    expect(t.reserved).toBe(0);
    expect(t.settled).toBeLessThanOrEqual(8);
    // A cheaper call still fits: 7.5 + 0.4 <= 8.
    await grant.settle(await grant.reserve(worth(0.4)), null);
    expect(totals(store.rows).settled).toBeCloseTo(7.9, 3);
  });

  it('counts other in-scope open batches, so a batch admitted first cannot outgrow one admitted after it', async () => {
    const store = new MemoryStore();
    const a = await ledgerOn(store, 1).batchStart(4, ceiling(10));
    const b = await ledgerOn(store, 2).batchStart(4, ceiling(10));
    // a may grow by the 2 left over, not into b's 4.
    await a.settle(await a.reserve(worth(5.99)), null);
    await expect(a.reserve(worth(0.05))).rejects.toThrow(/session cap/);
    // b still has its whole projection.
    await b.settle(await b.reserve(worth(3.99)), null);
    expect(totals(store.rows).settled).toBeLessThanOrEqual(10);
  });

  it('never refuses a reserve within its batch’s projection, even with the session over that batch’s lower ceiling', async () => {
    const store = new MemoryStore();
    const wide = await ledgerOn(store, 1).batchStart(9, ceiling(20));
    const tight = await ledgerOn(store, 2).batchStart(5, ceiling(15));
    // wide overruns its projection within its own ceiling: the session is now at 15.5 > 15.
    await wide.settle(await wide.reserve(worth(10.5)), null);
    // tight's reserve adds nothing to the exposure: its projection was admitted.
    await tight.settle(await tight.reserve(worth(4.99)), null);
    // One past its projection raises the exposure over tight's ceiling.
    await expect(tight.reserve(worth(0.05))).rejects.toThrow(SpendRefused);
  });

  it('refuses a ceiling whose scope leaves out the ledger’s own run', async () => {
    const store = new MemoryStore();
    await expect(ledgerOn(store).batchStart(1, { usd: 10, scope: (r) => r === 'other', what: 'session cap' })).rejects.toThrow(TypeError);
  });
});
