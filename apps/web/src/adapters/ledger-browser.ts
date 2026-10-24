// The tab's ledger: a LedgerStore kept in this tab's sessionStorage (no file; spend is not a
// secret, and the rows hold no key and no prompt, only ids, token counts and dollars) over the
// core ledger, admitted so its grants can build a MessagesClient. A reload keeps the spend: rows
// are read back on load, and a call or batch an earlier page left open is closed as spent at its
// worst case, since that page can no longer settle it and the API may still bill it.
// Browser-direct calls meter through it; its caps are the core's PROJECTED_CAP_USD and ACTUAL_CAP_USD, and the tighter
// session cap is checked in spend/ before each batchStart. P15 extends this adapter for trials
// in a Worker.
import { admitStore, createLedger, parseRow, type Ledger, type LedgerRow, type LedgerStore } from '../../../../packages/core/ledger.ts';

export const LEDGER_KEY = 'clinenv.ledger';

const session = (): Storage | null => {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
};

function load(storage: Storage | null): LedgerRow[] {
  try {
    const rows = JSON.parse(storage?.getItem(LEDGER_KEY) ?? '[]') as unknown;
    return Array.isArray(rows) ? rows.map(parseRow) : [];
  } catch {
    return [];
  }
}

// Settle rows at the reserved worst case for calls no settle followed, and close rows for
// batches no close followed: every one of them belongs to a page that is gone.
export function closeOrphans(rows: readonly LedgerRow[], now: string): LedgerRow[] {
  const settled = new Set(rows.filter((r) => r.kind === 'settle').map((r) => r.call_id));
  const closed = new Set(rows.filter((r) => r.kind === 'close').map((r) => r.batch_id));
  const reason = 'left open by an earlier page in this tab: counted at its worst case';
  const base = { ts: now, source: 'browser' as const, run_id: null, usage: null };
  const append: LedgerRow[] = [];
  for (const r of rows) {
    if (r.kind === 'reserve' && !settled.has(r.call_id)) {
      settled.add(r.call_id);
      append.push({ ...base, call_id: r.call_id, kind: 'settle', batch_id: r.batch_id, trial: r.trial, cost_usd: r.cost_usd, reason });
    } else if (r.kind === 'open' && !closed.has(r.batch_id)) {
      closed.add(r.batch_id);
      append.push({ ...base, call_id: `close:${r.batch_id}`, kind: 'close', batch_id: r.batch_id, trial: null, cost_usd: 0, reason });
    }
  }
  return append;
}

// fn runs synchronously inside transact, so in one JavaScript thread no other transaction can
// interleave with it: that is the lock. Each transaction writes the rows through to storage.
class TabStore implements LedgerStore {
  readonly #rows: LedgerRow[];
  readonly #storage: Storage | null;
  constructor(storage: Storage | null, now: string) {
    this.#storage = storage;
    this.#rows = load(storage);
    this.#append(closeOrphans(this.#rows, now));
  }
  #append(rows: LedgerRow[]): void {
    if (rows.length === 0) return;
    this.#rows.push(...rows);
    try {
      this.#storage?.setItem(LEDGER_KEY, JSON.stringify(this.#rows));
    } catch {
      // storage full or blocked: the rows still meter this page
    }
  }
  async transact<T>(fn: (rows: readonly LedgerRow[]) => { append: LedgerRow[]; result: T }): Promise<T> {
    const { append, result } = fn(this.#rows);
    this.#append(append);
    return result;
  }
  async read(): Promise<LedgerRow[]> {
    return [...this.#rows];
  }
}

let tab: Ledger | undefined;

export function tabLedger(): Ledger {
  if (tab === undefined) {
    const now = () => new Date().toISOString();
    const store = new TabStore(session(), now());
    admitStore(store);
    tab = createLedger({
      store,
      clock: { now },
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
