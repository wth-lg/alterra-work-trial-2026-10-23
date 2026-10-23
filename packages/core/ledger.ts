// The canonical spend ledger: reserve, settle, caps and batch grants over an injected
// LedgerStore and Clock. The store owns the file, the cross-process lock and the wall clock
// (cli/adapters/ledger-node.ts in Node); everything here is pure.
//
// Accounting, in integer micro-dollars so cap comparisons are exact:
//   settled  = sum of settle rows (actual cost, or the worst case when usage is unknown)
//   reserved = sum of reserve rows with no settle row for their call_id
//   an open batch (open row, no close row) counts at max(projection, its own settled +
//   reserved), so it adds max(0, projection - own) on top of the two sums
//   exposure = settled + reserved + that open-batch excess
// batchStart refuses when exposure + projection > $450. A reservation is refused when
// settled + reserved + its worst case > $500, and every call is blocked once settled
// reaches $500. A process that dies leaves its reservations and its open batch counting,
// until `pnpm cli spend --close <batch_id>` closes the batch.
import { usageCostUsd, worstCaseUsd, type Usage } from './cost.ts';

export const PROJECTED_CAP_USD = 450;
export const ACTUAL_CAP_USD = 500;

export type RowKind = 'reserve' | 'settle' | 'open' | 'close';
export type Source = 'node' | 'browser';

// One append-only ledger row. open rows also carry pid, host and projection.
export interface LedgerRow {
  ts: string;
  call_id: string;
  kind: RowKind;
  source: Source;
  run_id: string | null;
  batch_id: string | null;
  trial: string | null;
  usage: Usage | null;
  cost_usd: number;
  pid?: number;
  host?: string;
  projection?: number;
}

// fn runs with every row while the store holds its exclusive lock; the store appends the
// returned rows before it releases the lock. When fn throws, nothing is appended.
export interface LedgerStore {
  transact<T>(fn: (rows: readonly LedgerRow[]) => { append: LedgerRow[]; result: T }): Promise<T>;
  read(): Promise<LedgerRow[]>;
}

export interface Clock {
  now(): string; // ISO timestamp
}

export interface LedgerDeps {
  store: LedgerStore;
  clock: Clock;
  newId: () => string;
  source: Source;
  runId: string | null;
  pid: number;
  host: string;
}

export class SpendRefused extends Error {
  override readonly name = 'SpendRefused';
  readonly cap: 'projected' | 'actual';
  constructor(cap: 'projected' | 'actual', message: string) {
    super(message);
    this.cap = cap;
  }
}

const µ = (usd: number): number => Math.round(usd * 1e6);
const usd = (micros: number): number => micros / 1e6;
const fmt = (micros: number): string => `$${usd(micros).toFixed(2)}`;
const PROJECTED_CAP = µ(PROJECTED_CAP_USD);
const ACTUAL_CAP = µ(ACTUAL_CAP_USD);

export interface OpenBatch {
  batch_id: string;
  projection: number;
  own: number; // the batch's settled + reserved
  counted: number; // max(projection, own)
  pid?: number;
  host?: string;
  ts: string;
}

export interface Totals {
  settled: number;
  reserved: number;
  open: OpenBatch[];
  openExcess: number; // what open batches add beyond their own settled + reserved
  exposure: number; // settled + reserved + openExcess
  blocked: boolean; // settled >= $500
}

interface Tally {
  settled: number;
  reserved: number;
  openExcess: number;
  open: OpenBatch[];
  settledIds: Set<string>;
  batches: Map<string, 'open' | 'closed'>;
}

function tally(rows: readonly LedgerRow[]): Tally {
  const reserves = new Map<string, LedgerRow>();
  const settles = new Map<string, LedgerRow>();
  const opens = new Map<string, LedgerRow>();
  const closes = new Set<string>();
  for (const r of rows) {
    if (r.kind === 'reserve' && !reserves.has(r.call_id)) reserves.set(r.call_id, r);
    else if (r.kind === 'settle' && !settles.has(r.call_id)) settles.set(r.call_id, r);
    else if (r.kind === 'open' && r.batch_id !== null && !opens.has(r.batch_id)) opens.set(r.batch_id, r);
    else if (r.kind === 'close' && r.batch_id !== null) closes.add(r.batch_id);
  }
  const own = new Map<string, number>();
  const add = (batch: string | null, micros: number) => {
    if (batch !== null) own.set(batch, (own.get(batch) ?? 0) + micros);
  };
  let settled = 0;
  for (const s of settles.values()) {
    settled += µ(s.cost_usd);
    add(s.batch_id, µ(s.cost_usd));
  }
  let reserved = 0;
  for (const r of reserves.values()) {
    if (settles.has(r.call_id)) continue;
    reserved += µ(r.cost_usd);
    add(r.batch_id, µ(r.cost_usd));
  }
  let openExcess = 0;
  const open: OpenBatch[] = [];
  const batches = new Map<string, 'open' | 'closed'>();
  for (const [id, o] of opens) {
    if (closes.has(id)) {
      batches.set(id, 'closed');
      continue;
    }
    batches.set(id, 'open');
    const projection = µ(o.projection ?? 0);
    const mine = own.get(id) ?? 0;
    openExcess += Math.max(0, projection - mine);
    open.push({
      batch_id: id, projection: usd(projection), own: usd(mine), counted: usd(Math.max(projection, mine)), ts: o.ts,
      ...(o.pid === undefined ? {} : { pid: o.pid }),
      ...(o.host === undefined ? {} : { host: o.host }),
    });
  }
  return { settled, reserved, openExcess, open, settledIds: new Set(settles.keys()), batches };
}

export function totals(rows: readonly LedgerRow[]): Totals {
  const t = tally(rows);
  return {
    settled: usd(t.settled),
    reserved: usd(t.reserved),
    open: t.open,
    openExcess: usd(t.openExcess),
    exposure: usd(t.settled + t.reserved + t.openExcess),
    blocked: t.settled >= ACTUAL_CAP,
  };
}

// The `spend --check` sum: exposure + the projection being checked + the remaining
// final-run reserve when asked. The total is rounded up to the cent, and over is decided
// on that printed total.
export function checkProjected(t: Totals, projected: number, finalReserve = 0): { total: number; over: boolean } {
  const cents = Math.ceil((µ(t.exposure) + µ(projected) + µ(finalReserve)) / 10_000);
  return { total: cents / 100, over: cents * 10_000 > PROJECTED_CAP };
}

const KINDS = new Set<string>(['reserve', 'settle', 'open', 'close']);
const SOURCES = new Set<string>(['node', 'browser']);

// Checks that a parsed JSON value is a ledger row, for rows read from a file or ingested.
export function parseRow(x: unknown): LedgerRow {
  const r = x as Partial<LedgerRow> | null;
  const nullableString = (v: unknown) => v === null || typeof v === 'string';
  if (
    typeof r !== 'object' || r === null ||
    typeof r.ts !== 'string' || typeof r.call_id !== 'string' || r.call_id === '' ||
    !KINDS.has(r.kind as string) || !SOURCES.has(r.source as string) ||
    !nullableString(r.run_id) || !nullableString(r.batch_id) || !nullableString(r.trial) ||
    (r.usage !== null && typeof r.usage !== 'object') ||
    typeof r.cost_usd !== 'number' || !Number.isFinite(r.cost_usd) || r.cost_usd < 0
  ) {
    throw new Error(`not a ledger row: ${JSON.stringify(x)}`);
  }
  return r as LedgerRow;
}

export interface ReserveRequest {
  bodyBytes: number; // request body size; each byte is counted as one input token
  maxTokens: number;
  trial?: string;
}

export interface Reservation {
  readonly call_id: string;
  readonly batch_id: string | null;
  readonly trial: string | null;
  readonly worst_usd: number;
}

export interface BatchGrant {
  readonly batch_id: string;
  readonly projection: number;
  // Aborted when this process sees settled spend reach $500.
  readonly signal: AbortSignal;
  reserve(req: ReserveRequest): Promise<Reservation>;
  // usage null means unknown (dropped stream, error after a partial stream): worst case.
  settle(res: Reservation, usage: Usage | null): Promise<void>;
  // Reserves, sends and settles one call; a send that throws settles at the worst case.
  metered<T extends { usage?: Usage | null }>(req: ReserveRequest, send: (signal: AbortSignal) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface Ledger {
  batchStart(projection: number): Promise<BatchGrant>;
  reserve(req: ReserveRequest, batch_id?: string | null): Promise<Reservation>;
  settle(res: Reservation, usage: Usage | null): Promise<void>;
  // Writes the close row; false when the batch was already closed.
  close(batch_id: string): Promise<boolean>;
  totals(): Promise<Totals>;
  // Appends the rows whose (call_id, kind) is not in the ledger yet; returns how many.
  ingest(rows: readonly LedgerRow[]): Promise<number>;
}

// Only batchStart puts an object in `grants`, so membership is the capability: a Messages
// client constructor calls assertGrant, and no copy or forgery passes it.
const grants = new WeakSet<object>();
const closedGrants = new WeakSet<object>();

export function assertGrant(g: unknown): asserts g is BatchGrant {
  if (typeof g !== 'object' || g === null || !grants.has(g)) {
    throw new TypeError('not a batch grant: a Messages client needs the grant that batchStart(projection) returns');
  }
  if (closedGrants.has(g)) throw new TypeError(`batch grant ${(g as BatchGrant).batch_id} is closed`);
}

export function createLedger(deps: LedgerDeps): Ledger {
  const live = new Set<AbortController>();

  const row = (kind: RowKind, fields: Partial<LedgerRow>): LedgerRow => ({
    ts: deps.clock.now(), call_id: '', kind, source: deps.source, run_id: deps.runId,
    batch_id: null, trial: null, usage: null, cost_usd: 0, ...fields,
  });

  const blockedError = (t: Tally) =>
    new SpendRefused('actual', `actual cap: settled ${fmt(t.settled)} has reached $${ACTUAL_CAP_USD}; every call is blocked`);

  // Aborts this process's in-flight calls once settled spend reaches the actual cap.
  const enforce = (rows: readonly LedgerRow[]) => {
    const t = tally(rows);
    if (t.settled < ACTUAL_CAP) return;
    for (const c of live) c.abort(blockedError(t));
  };

  // Runs a transaction that may refuse at the actual cap. Such a refusal can come from spend
  // another process settled, so it re-reads the ledger and aborts this process's calls too.
  const guarded = async <T>(fn: (rows: readonly LedgerRow[]) => { append: LedgerRow[]; result: T }): Promise<T> => {
    try {
      return await deps.store.transact(fn);
    } catch (e) {
      if (e instanceof SpendRefused && e.cap === 'actual') enforce(await deps.store.read());
      throw e;
    }
  };

  const ledger: Ledger = {
    async batchStart(projection) {
      if (!Number.isFinite(projection) || projection < 0) throw new TypeError(`batch projection must be a finite number >= 0, got ${projection}`);
      const batch_id = deps.newId();
      await guarded((rows) => {
        const t = tally(rows);
        if (t.settled >= ACTUAL_CAP) throw blockedError(t);
        const total = t.settled + t.reserved + t.openExcess + µ(projection);
        if (total > PROJECTED_CAP) {
          throw new SpendRefused(
            'projected',
            `projected cap: settled ${fmt(t.settled)} + reserved ${fmt(t.reserved)} + open batches ${fmt(t.openExcess)} + projection ${fmt(µ(projection))} = ${fmt(total)} > $${PROJECTED_CAP_USD}`,
          );
        }
        return { append: [row('open', { call_id: `open:${batch_id}`, batch_id, pid: deps.pid, host: deps.host, projection })], result: undefined };
      });
      return makeGrant(batch_id, projection);
    },

    async reserve(req, batch_id = null) {
      const worst = worstCaseUsd(req);
      const call_id = deps.newId();
      const trial = req.trial ?? null;
      await guarded((rows) => {
        const t = tally(rows);
        if (t.settled >= ACTUAL_CAP) throw blockedError(t);
        const total = t.settled + t.reserved + µ(worst);
        if (total > ACTUAL_CAP) {
          throw new SpendRefused('actual', `actual cap: settled ${fmt(t.settled)} + reserved ${fmt(t.reserved)} + this call's worst case ${fmt(µ(worst))} = ${fmt(total)} > $${ACTUAL_CAP_USD}`);
        }
        return { append: [row('reserve', { call_id, batch_id, trial, cost_usd: worst })], result: undefined };
      });
      return { call_id, batch_id, trial, worst_usd: worst };
    },

    async settle(res, usage) {
      const cost_usd = usage === null ? res.worst_usd : usageCostUsd(usage);
      const rows = await deps.store.transact((rows) => {
        // Settling twice is a no-op: the first settle row stands.
        if (tally(rows).settledIds.has(res.call_id)) return { append: [], result: rows };
        const settle = row('settle', { call_id: res.call_id, batch_id: res.batch_id, trial: res.trial, usage, cost_usd });
        return { append: [settle], result: [...rows, settle] };
      });
      enforce(rows);
    },

    async close(batch_id) {
      return deps.store.transact((rows) => {
        const state = tally(rows).batches.get(batch_id);
        if (state === undefined) throw new Error(`no open row for batch ${batch_id}`);
        if (state === 'closed') return { append: [], result: false };
        return { append: [row('close', { call_id: `close:${batch_id}`, batch_id })], result: true };
      });
    },

    async totals() {
      return totals(await deps.store.read());
    },

    async ingest(input) {
      const { rows, added } = await deps.store.transact((rows) => {
        const seen = new Set(rows.map((r) => `${r.kind}\0${r.call_id}`));
        const append = input.filter((r) => {
          const key = `${r.kind}\0${r.call_id}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        return { append, result: { rows: [...rows, ...append], added: append.length } };
      });
      enforce(rows);
      return added;
    },
  };

  function makeGrant(batch_id: string, projection: number): BatchGrant {
    const controller = new AbortController();
    live.add(controller);
    const grant: BatchGrant = {
      batch_id,
      projection,
      signal: controller.signal,
      async reserve(req) {
        assertGrant(grant);
        if (controller.signal.aborted) throw controller.signal.reason;
        try {
          return await ledger.reserve(req, batch_id);
        } catch (e) {
          if (e instanceof SpendRefused && e.cap === 'actual') controller.abort(e);
          throw e;
        }
      },
      // A grant settles after close too: a call that was in flight still has to be recorded.
      settle: (res, usage) => ledger.settle(res, usage),
      async metered(req, send) {
        const res = await grant.reserve(req);
        let result;
        try {
          result = await send(controller.signal);
        } catch (e) {
          await ledger.settle(res, null);
          throw e;
        }
        await ledger.settle(res, result.usage ?? null);
        return result;
      },
      async close() {
        if (closedGrants.has(grant)) return;
        await ledger.close(batch_id);
        closedGrants.add(grant);
        live.delete(controller);
      },
    };
    grants.add(grant);
    return grant;
  }

  return ledger;
}
