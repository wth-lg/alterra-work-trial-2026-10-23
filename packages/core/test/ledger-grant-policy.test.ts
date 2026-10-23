// restrictGrants changes module state for good, so it gets its own test file (vitest runs
// each file in its own module graph).
import { describe, expect, it } from 'vitest';
import { admitStore, assertGrant, createLedger, restrictGrants, type LedgerRow, type LedgerStore } from '../ledger.ts';

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

const ledgerOn = (store: LedgerStore) => (admitStore(store), createLedger({ store, clock: { now: () => 't' }, newId: () => crypto.randomUUID(), source: 'node', runId: null, pid: 1, host: 'h', isAlive: () => true }));

describe('restrictGrants', () => {
  it('once a policy names the canonical store, a grant minted over any other store fails assertGrant and cannot reserve', async () => {
    const canonical = new MemoryStore();
    const shadow = new MemoryStore();
    const before = await ledgerOn(shadow).batchStart(1);
    restrictGrants((store) => store === canonical);
    const good = await ledgerOn(canonical).batchStart(1);
    const bad = await ledgerOn(shadow).batchStart(1);
    expect(() => assertGrant(good)).not.toThrow();
    expect(() => assertGrant(bad)).toThrow(/grant/);
    expect(() => assertGrant(before)).toThrow(/grant/);
    await expect(bad.reserve({ bodyBytes: 1, maxTokens: 1 })).rejects.toThrow(/grant/);
    expect(shadow.rows.filter((r) => r.kind === 'reserve')).toEqual([]);
    // A later policy can only narrow: it cannot readmit the shadow store.
    restrictGrants(() => true);
    expect(() => assertGrant(bad)).toThrow(/grant/);
  });
});
