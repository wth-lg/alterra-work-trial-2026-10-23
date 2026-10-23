// The tab ledger: an admitted in-memory store whose grants build a MessagesClient, records
// browser rows only in memory, and enforces the core caps.
import { describe, expect, it } from 'vitest';
import { MessagesClient } from '../../../packages/core/anthropic.ts';
import { assertGrant, PROJECTED_CAP_USD, SpendRefused } from '../../../packages/core/ledger.ts';
import { tabLedger } from '../src/adapters/ledger-browser.ts';

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
