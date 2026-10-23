// The tab's ledger: an in-memory LedgerStore (no file, no storage; a reload clears it) over the
// core ledger, admitted so its grants can build a MessagesClient. Browser-direct calls meter
// through it; its caps are the core's $450 / $500, and the tighter session cap is checked in
// spend/ before each batchStart. P15 extends this adapter for trials in a Worker.
import { admitStore, createLedger, type Ledger, type LedgerRow, type LedgerStore } from '../../../../packages/core/ledger.ts';

// fn runs synchronously inside transact, so in one JavaScript thread no other transaction can
// interleave with it: that is the lock.
class TabStore implements LedgerStore {
  readonly #rows: LedgerRow[] = [];
  async transact<T>(fn: (rows: readonly LedgerRow[]) => { append: LedgerRow[]; result: T }): Promise<T> {
    const { append, result } = fn(this.#rows);
    this.#rows.push(...append);
    return result;
  }
  async read(): Promise<LedgerRow[]> {
    return [...this.#rows];
  }
}

let tab: Ledger | undefined;

export function tabLedger(): Ledger {
  if (tab === undefined) {
    const store = new TabStore();
    admitStore(store);
    tab = createLedger({
      store,
      clock: { now: () => new Date().toISOString() },
      newId: () => crypto.randomUUID(),
      source: 'browser',
      runId: null,
      pid: 0,
      host: 'tab',
      // Only the tab's own grants close its batches.
      isAlive: () => true,
    });
  }
  return tab;
}
