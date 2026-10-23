// Store admission changes module state, so it gets its own test file (vitest runs each file
// in its own module graph).
import { describe, expect, it } from 'vitest';
import { admitStore, assertClientGrant, assertGrant, createLedger, type LedgerRow, type LedgerStore } from '../ledger.ts';

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

const ledgerOn = (store: LedgerStore) =>
  createLedger({ store, clock: { now: () => 't' }, newId: () => crypto.randomUUID(), source: 'node', runId: null, pid: 1, host: 'h', isAlive: () => true });

describe('store admission', () => {
  it('a grant over a store no adapter admitted fails assertGrant and the client contract, and meters nothing', async () => {
    const store = new MemoryStore();
    const ledger = ledgerOn(store);
    const grant = await ledger.batchStart(1);
    expect(() => assertGrant(grant)).toThrow(/grant/);
    expect(() => assertClientGrant(grant, ledger)).toThrow(/grant/);
    let sends = 0;
    await expect(grant.metered({ bodyBytes: 1, maxTokens: 1 }, async () => (sends++, { usage: null }))).rejects.toThrow(/grant/);
    expect(sends).toBe(0);
    expect(store.rows.filter((r) => r.kind === 'reserve')).toEqual([]);
  });

  it('once admitted, its grants pass, and the client contract still needs the ledger that minted the grant', async () => {
    const store = new MemoryStore();
    admitStore(store);
    const ledger = ledgerOn(store);
    const other = ledgerOn(store);
    const grant = await ledger.batchStart(1);
    expect(() => assertGrant(grant)).not.toThrow();
    expect(() => assertClientGrant(grant, ledger)).not.toThrow();
    expect(() => assertClientGrant(grant, other)).toThrow(/grant/);
    expect(() => assertClientGrant({ ...grant }, ledger)).toThrow(/grant/);
  });
});
