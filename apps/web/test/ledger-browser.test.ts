// The tab ledger: an admitted store whose grants build a MessagesClient, records browser rows
// (in sessionStorage when the tab has it; Node has none), enforces the core caps, and on load
// closes what an earlier page left open at its worst case.
import { describe, expect, it } from 'vitest';
import { MessagesClient } from '../../../packages/core/anthropic.ts';
import { assertGrant, PROJECTED_CAP_USD, SpendRefused, totals, type LedgerRow } from '../../../packages/core/ledger.ts';
import { closeOrphans, tabLedger } from '../src/adapters/ledger-browser.ts';

describe('tabLedger', () => {
  it('is one ledger per tab whose grants pass assertGrant and build a MessagesClient', async () => {
    const ledger = tabLedger();
    expect(tabLedger()).toBe(ledger);
    const grant = await ledger.batchStart(0.05);
    expect(() => assertGrant(grant, ledger)).not.toThrow();
    expect(() => new MessagesClient({ grant, ledger, apiKey: 'test-key', fetch: async () => new Response(null, { status: 500 }) })).not.toThrow();
    await grant.close();
  });

  it('records browser rows in memory and settles a call', async () => {
    const ledger = tabLedger();
    const before = (await ledger.totals()).settled;
    const grant = await ledger.batchStart(0.05);
    const res = await grant.reserve({ bodyBytes: 100, maxTokens: 16 });
    await grant.settle(res, { input_tokens: 1000, output_tokens: 10 });
    await grant.close();
    const t = await ledger.totals();
    expect(t.settled - before).toBeCloseTo(0.0042, 6);
    expect(t.reserved).toBe(0);
    expect(t.open).toEqual([]);
  });

  it('refuses a batch past the core projected cap', async () => {
    await expect(tabLedger().batchStart(PROJECTED_CAP_USD + 1)).rejects.toBeInstanceOf(SpendRefused);
  });
});

describe('closeOrphans', () => {
  const row = (r: Partial<LedgerRow> & Pick<LedgerRow, 'kind' | 'call_id'>): LedgerRow => ({
    ts: 't0', source: 'browser', run_id: null, batch_id: 'b1', trial: 'validate', usage: null, cost_usd: 0, ...r,
  });

  it('settles a reservation an earlier page left open at its worst case, and closes its batch', () => {
    const rows = [row({ kind: 'open', call_id: 'open:b1', projection: 0.04 }), row({ kind: 'reserve', call_id: 'c1', cost_usd: 0.034 })];
    const added = closeOrphans(rows, 't1');
    expect(added.map((r) => [r.kind, r.call_id, r.cost_usd])).toEqual([['close', 'close:b1', 0], ['settle', 'c1', 0.034]]);
    const t = totals([...rows, ...added]);
    expect([t.settled, t.reserved, t.open]).toEqual([0.034, 0, []]);
    expect(closeOrphans([...rows, ...added], 't2')).toEqual([]);
  });

  it('adds nothing for settled calls and closed batches', () => {
    const rows = [
      row({ kind: 'open', call_id: 'open:b1', projection: 0.04 }), row({ kind: 'reserve', call_id: 'c1', cost_usd: 0.034 }),
      row({ kind: 'settle', call_id: 'c1', cost_usd: 0.02 }), row({ kind: 'close', call_id: 'close:b1' }),
    ];
    expect(closeOrphans(rows, 't1')).toEqual([]);
  });
});
