// The canonical spend ledger: reserve, settle, caps and batch grants over an injected
// LedgerStore and Clock. The store owns the file, the cross-process lock and the wall clock
// (cli/adapters/ledger-node.ts in Node); everything here is pure.
//
// Accounting, in integer micro-dollars so cap comparisons are exact:
//   settled  = per call_id, the highest of its settle rows (actual cost, or the worst case
//              when usage is unknown), so no later or earlier settle can lower it
//   reserved = sum of reserve rows with no settle row for their call_id
//   an open batch (open row, no close row) counts at max(projection, its own settled +
//   reserved), so it adds max(0, projection - own) on top of the two sums
//   exposure = settled + reserved + that open-batch excess
// batchStart refuses when exposure + projection > PROJECTED_CAP_USD. A reservation is refused
// when settled + reserved + its worst case > ACTUAL_CAP_USD, and every call is blocked once
// settled reaches ACTUAL_CAP_USD. A batch may also carry its caller's SpendCeiling (the local
// runner's session cap): batchStart refuses when the in-scope exposure plus the projection would
// cross it, and each of the grant's reservations is refused when it would take the in-scope
// exposure past it (one within the batch's projection adds nothing, so it always passes). The
// refusal is SpendRefused('ceiling'), which stops the batch (classifyFailure). The CLI passes
// none: it has no session, and its operator's `spend --check` and the two caps bound it. A process that dies leaves its reservations and its open
// batch counting, until `pnpm cli spend --close <batch_id>` closes the batch. Every row is
// validated when it is read and before it is appended, so a NaN or negative amount never
// reaches a cap check.
import { usageCostUsd, worstCaseUsd, type Usage } from './cost.ts';

export const PROJECTED_CAP_USD = 950;
export const ACTUAL_CAP_USD = 1000;

export type RowKind = 'reserve' | 'settle' | 'open' | 'close';
export type Source = 'node' | 'browser';

// One append-only ledger row. open rows also carry pid, host and projection; a forced close
// row carries the operator's reason.
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
  reason?: string;
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
  // Whether a pid on this host is running; `spend --close` refuses a live batch.
  isAlive: (pid: number) => boolean;
}

export class SpendRefused extends Error {
  override readonly name = 'SpendRefused';
  readonly cap: 'projected' | 'actual' | 'ceiling';
  constructor(cap: 'projected' | 'actual' | 'ceiling', message: string) {
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
  blocked: boolean; // settled >= ACTUAL_CAP_USD
}

interface Tally {
  settled: number;
  reserved: number;
  openExcess: number;
  open: OpenBatch[];
  reserves: Map<string, LedgerRow>; // the first reserve row of each call_id
  settledMax: Map<string, number>; // the highest settle of each call_id
  opens: Map<string, LedgerRow>;
  batches: Map<string, 'open' | 'closed'>;
}

function tally(rows: readonly LedgerRow[]): Tally {
  const reserves = new Map<string, LedgerRow>();
  const settledMax = new Map<string, number>();
  const settleBatch = new Map<string, string | null>();
  const opens = new Map<string, LedgerRow>();
  const closes = new Set<string>();
  for (const r of rows) {
    parseRow(r);
    if (r.kind === 'reserve' && !reserves.has(r.call_id)) reserves.set(r.call_id, r);
    else if (r.kind === 'settle') {
      settledMax.set(r.call_id, Math.max(settledMax.get(r.call_id) ?? 0, µ(r.cost_usd)));
      if (!settleBatch.has(r.call_id)) settleBatch.set(r.call_id, r.batch_id);
    } else if (r.kind === 'open' && r.batch_id !== null && !opens.has(r.batch_id)) opens.set(r.batch_id, r);
    else if (r.kind === 'close' && r.batch_id !== null) closes.add(r.batch_id);
  }
  const own = new Map<string, number>();
  const add = (batch: string | null | undefined, micros: number) => {
    if (batch !== null && batch !== undefined) own.set(batch, (own.get(batch) ?? 0) + micros);
  };
  let settled = 0;
  for (const [id, micros] of settledMax) {
    settled += micros;
    add(reserves.has(id) ? reserves.get(id)?.batch_id : settleBatch.get(id), micros);
  }
  let reserved = 0;
  for (const r of reserves.values()) {
    if (settledMax.has(r.call_id)) continue;
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
    const projection = µ(o.projection as number);
    const mine = own.get(id) ?? 0;
    openExcess += Math.max(0, projection - mine);
    open.push({
      batch_id: id, projection: usd(projection), own: usd(mine), counted: usd(Math.max(projection, mine)), ts: o.ts,
      ...(o.pid === undefined ? {} : { pid: o.pid }),
      ...(o.host === undefined ? {} : { host: o.host }),
    });
  }
  return { settled, reserved, openExcess, open, reserves, settledMax, opens, batches };
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
  for (const v of [t.exposure, projected, finalReserve]) {
    if (!Number.isFinite(v) || v < 0) throw new TypeError(`spend check terms must be finite numbers >= 0, got ${v}`);
  }
  const cents = Math.ceil((µ(t.exposure) + µ(projected) + µ(finalReserve)) / 10_000);
  return { total: cents / 100, over: cents * 10_000 > PROJECTED_CAP };
}

const KINDS = new Set<string>(['reserve', 'settle', 'open', 'close']);
const SOURCES = new Set<string>(['node', 'browser']);

const isAmount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

// Checks that a value is a ledger row: rows read from a file, ingested, or about to be
// appended. Amounts must be finite and >= 0; an open row needs its batch_id and projection.
export function parseRow(x: unknown): LedgerRow {
  const r = x as Partial<LedgerRow> | null;
  const nullableString = (v: unknown) => v === null || typeof v === 'string';
  const optional = (v: unknown, ok: (v: unknown) => boolean) => v === undefined || ok(v);
  if (
    typeof r !== 'object' || r === null ||
    typeof r.ts !== 'string' || typeof r.call_id !== 'string' || r.call_id === '' ||
    !KINDS.has(r.kind as string) || !SOURCES.has(r.source as string) ||
    !nullableString(r.run_id) || !nullableString(r.batch_id) || !nullableString(r.trial) ||
    (r.usage !== null && (typeof r.usage !== 'object' || Array.isArray(r.usage))) ||
    !isAmount(r.cost_usd) ||
    !optional(r.pid, (v) => Number.isSafeInteger(v)) || !optional(r.host, (v) => typeof v === 'string') ||
    !optional(r.projection, isAmount) || !optional(r.reason, (v) => typeof v === 'string') ||
    ((r.kind === 'open' || r.kind === 'close') && typeof r.batch_id !== 'string') ||
    (r.kind === 'open' && !isAmount(r.projection))
  ) {
    throw new Error(`not a ledger row: ${JSON.stringify(x)}`);
  }
  return r as LedgerRow;
}

export interface ReserveRequest {
  bodyBytes: number; // request body size; each byte is counted as one input token
  maxTokens: number;
  fast?: boolean; // the request sets speed "fast"
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
  // Aborted when this process sees settled spend reach ACTUAL_CAP_USD.
  readonly signal: AbortSignal;
  reserve(req: ReserveRequest): Promise<Reservation>;
  // usage null means unknown (dropped stream, error after a partial stream): worst case.
  settle(res: Reservation, usage: Usage | null): Promise<void>;
  // Reserves, sends and settles one call; a send that throws settles at the worst case.
  metered<T extends { usage?: Usage | null }>(req: ReserveRequest, send: (signal: AbortSignal) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

// A caller's own cap on a batch, checked inside the ledger's lock. scope picks the run ids whose
// rows count against it (the runner's session prefix) and must take the ledger's own run id;
// what names it in the refusal ("session cap").
export interface SpendCeiling {
  usd: number;
  scope: (runId: string | null) => boolean;
  what: string;
}

export interface Ledger {
  batchStart(projection: number, ceiling?: SpendCeiling): Promise<BatchGrant>;
  reserve(req: ReserveRequest, batch_id?: string | null): Promise<Reservation>;
  // Settles a reserved call. The worst case comes from the ledger's reserve row, and the
  // call counts at its highest settle.
  settle(res: Reservation, usage: Usage | null): Promise<void>;
  // Writes the close row; false when the batch was already closed. Refuses a batch whose
  // process may still run (alive on this host, or opened on another host) unless `force`
  // gives the reason, which the close row records.
  close(batch_id: string, opts?: { force?: string }): Promise<boolean>;
  totals(): Promise<Totals>;
  // Appends browser reserve rows not in the ledger yet and browser settles above the
  // call's highest settle; returns how many. Throws, appending nothing, on any other row or
  // on a settle for a call the browser did not reserve.
  ingest(rows: readonly LedgerRow[]): Promise<number>;
}

// Only batchStart puts an object in `grants`, so membership is the capability: a Messages
// client constructor calls assertClientGrant, and no copy or forgery passes it. Each grant is
// bound to the ledger and store that minted it. A grant passes only when an environment
// adapter admitted its store (the Node adapter admits each store openNodeLedger opens), so a
// ledger built over an ad-hoc store meters nothing, and restrictGrants policies (the Node
// adapter adds one when an open resolves own-run mode) narrow which admitted stores pass.
// Every check runs each time a grant is used, so an admission or policy added later applies
// to grants minted before it.
const grants = new WeakMap<object, { ledger: Ledger; store: LedgerStore }>();
const closedGrants = new WeakSet<object>();
const admittedStores = new WeakSet<LedgerStore>();
const grantPolicies: Array<(store: LedgerStore) => boolean> = [];

// Called by the adapter that opened `store`, which owns the env that chose it.
export function admitStore(store: LedgerStore): void {
  admittedStores.add(store);
}

// Adds a policy every grant's store must pass. Policies can only be added, so a later call
// narrows what passes and never widens it.
export function restrictGrants(policy: (store: LedgerStore) => boolean): void {
  grantPolicies.push(policy);
}

// Throws unless g is a live grant from batchStart over an admitted store that passes every
// policy, and, when `ledger` is given, one that this ledger minted.
export function assertGrant(g: unknown, ledger?: Ledger): asserts g is BatchGrant {
  const owner = typeof g === 'object' && g !== null ? grants.get(g) : undefined;
  if (owner === undefined) {
    throw new TypeError('not a batch grant: a Messages client needs the grant that batchStart(projection) returns');
  }
  if (ledger !== undefined && owner.ledger !== ledger) throw new TypeError('batch grant from another ledger');
  if (!admittedStores.has(owner.store)) throw new TypeError('batch grant from a ledger no adapter opened');
  if (!grantPolicies.every((p) => p(owner.store))) throw new TypeError('batch grant from a ledger other than the canonical one');
  if (closedGrants.has(g as object)) throw new TypeError(`batch grant ${(g as BatchGrant).batch_id} is closed`);
}

// The Messages client contract: the client constructor calls this with the grant it was given
// and the ledger it meters through, and builds nothing when it throws. The grant's reserve
// runs assertGrant again before every call, so a client that skips this still sends nothing
// on a grant that fails it.
export function assertClientGrant(g: unknown, ledger: Ledger): asserts g is BatchGrant {
  assertGrant(g, ledger);
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

  // Every transaction validates the rows it appends, so a bad row is refused, not written.
  const transact = <T>(fn: (rows: readonly LedgerRow[]) => { append: LedgerRow[]; result: T }): Promise<T> =>
    deps.store.transact((rows) => {
      const out = fn(rows);
      for (const r of out.append) parseRow(r);
      return out;
    });

  // Runs a transaction that may refuse at the actual cap. Such a refusal can come from spend
  // another process settled, so it re-reads the ledger and aborts this process's calls too.
  const guarded = async <T>(fn: (rows: readonly LedgerRow[]) => { append: LedgerRow[]; result: T }): Promise<T> => {
    try {
      return await transact(fn);
    } catch (e) {
      if (e instanceof SpendRefused && e.cap === 'actual') enforce(await deps.store.read());
      throw e;
    }
  };

  // The exposure of the rows in the ceiling's scope, as tally counts it.
  const scoped = (rows: readonly LedgerRow[], c: SpendCeiling): number => {
    const t = tally(rows.filter((r) => c.scope(r.run_id)));
    return t.settled + t.reserved + t.openExcess;
  };
  // Throws when appending `next` would take the in-scope exposure past the ceiling and raise it.
  const checkCeiling = (rows: readonly LedgerRow[], next: LedgerRow, c: SpendCeiling | undefined, what: string) => {
    if (c === undefined) return;
    const before = scoped(rows, c);
    const after = scoped([...rows, next], c);
    if (after > µ(c.usd) && after > before) {
      throw new SpendRefused('ceiling', `${c.what}: ${fmt(before)} already committed + ${what} = ${fmt(after)} > ${fmt(µ(c.usd))}`);
    }
  };

  // ledger.reserve, and a grant's reserve with the grant's ceiling.
  async function reserveIn(req: ReserveRequest, batch_id: string | null, ceiling: SpendCeiling | undefined): Promise<Reservation> {
    const worst = worstCaseUsd(req);
    const call_id = deps.newId();
    const trial = req.trial ?? null;
    await guarded((rows) => {
      const t = tally(rows);
      if (batch_id !== null && t.batches.get(batch_id) === 'closed') throw new TypeError(`batch grant ${batch_id} is closed`);
      if (t.settled >= ACTUAL_CAP) throw blockedError(t);
      const total = t.settled + t.reserved + µ(worst);
      if (total > ACTUAL_CAP) {
        throw new SpendRefused('actual', `actual cap: settled ${fmt(t.settled)} + reserved ${fmt(t.reserved)} + this call's worst case ${fmt(µ(worst))} = ${fmt(total)} > $${ACTUAL_CAP_USD}`);
      }
      const reserve = row('reserve', { call_id, batch_id, trial, cost_usd: worst });
      checkCeiling(rows, reserve, ceiling, `this call's worst case ${fmt(µ(worst))}`);
      return { append: [reserve], result: undefined };
    });
    return { call_id, batch_id, trial, worst_usd: worst };
  }

  const ledger: Ledger = {
    async batchStart(projection, ceiling) {
      if (!Number.isFinite(projection) || projection < 0) throw new TypeError(`batch projection must be a finite number >= 0, got ${projection}`);
      if (ceiling !== undefined && (!Number.isFinite(ceiling.usd) || ceiling.usd < 0 || !ceiling.scope(deps.runId))) {
        throw new TypeError(`a spend ceiling needs a finite amount >= 0 and a scope that takes this ledger's run ${deps.runId}`);
      }
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
        const open = row('open', { call_id: `open:${batch_id}`, batch_id, pid: deps.pid, host: deps.host, projection });
        checkCeiling(rows, open, ceiling, `this batch's projection ${fmt(µ(projection))}`);
        return { append: [open], result: undefined };
      });
      return makeGrant(batch_id, projection, ceiling);
    },

    reserve: (req, batch_id = null) => reserveIn(req, batch_id, undefined),

    async settle(res, usage) {
      const priced = usage === null ? null : usageCostUsd(usage);
      const rows = await transact((rows) => {
        const t = tally(rows);
        const reserve = t.reserves.get(res.call_id);
        if (reserve === undefined) throw new Error(`no reservation for call ${res.call_id}: only a reserved call can be settled`);
        const cost_usd = priced ?? reserve.cost_usd;
        const prior = t.settledMax.get(res.call_id);
        if (prior !== undefined && µ(cost_usd) <= prior) return { append: [], result: rows };
        // A call that costs more than twice its worst case means the cost model missed something
        // the request can bill (the client rejects server tools for this reason). It is still
        // recorded at actual; the reason makes it findable in `pnpm cli spend`.
        const over = µ(cost_usd) > 2 * µ(reserve.cost_usd);
        const settle = row('settle', {
          call_id: res.call_id, batch_id: reserve.batch_id, trial: reserve.trial, usage: priced === null ? null : usage, cost_usd,
          ...(over ? { reason: `settled $${cost_usd.toFixed(6)} exceeds 2x its reservation $${reserve.cost_usd.toFixed(6)}` } : {}),
        });
        return { append: [settle], result: [...rows, settle] };
      });
      enforce(rows);
    },

    close: (batch_id, opts = {}) => closeBatch(batch_id, { owner: false, ...opts }),

    async totals() {
      return totals(await deps.store.read());
    },

    async ingest(input) {
      input.forEach((r, i) => {
        try {
          parseRow(r);
        } catch (e) {
          throw new Error(`ingest row ${i + 1}: ${(e as Error).message}`, { cause: e });
        }
      });
      const { rows, added } = await transact((rows) => {
        const t = tally(rows);
        const reserves = new Map(t.reserves);
        const settled = new Map(t.settledMax);
        const append: LedgerRow[] = [];
        input.forEach((r, i) => {
          const where = `ingest row ${i + 1} (call ${r.call_id})`;
          if (r.source !== 'browser') throw new Error(`${where}: only browser rows are ingested, got source ${r.source}`);
          if (r.kind === 'reserve') {
            if (reserves.has(r.call_id)) return;
            reserves.set(r.call_id, r);
          } else if (r.kind === 'settle') {
            if (reserves.get(r.call_id)?.source !== 'browser') throw new Error(`${where}: a settle for a call the browser did not reserve`);
            const prior = settled.get(r.call_id);
            if (prior !== undefined && µ(r.cost_usd) <= prior) return;
            settled.set(r.call_id, µ(r.cost_usd));
          } else {
            throw new Error(`${where}: only reserve and settle rows are ingested, got ${r.kind}`);
          }
          append.push(r);
        });
        return { append, result: { rows: [...rows, ...append], added: append.length } };
      });
      enforce(rows);
      return added;
    },
  };

  // The grant's own close skips the liveness check: its process is the one running it.
  async function closeBatch(batch_id: string, opts: { owner: boolean; force?: string }): Promise<boolean> {
    if (opts.force !== undefined && opts.force.trim() === '') throw new TypeError('a forced close needs a reason');
    return transact((rows) => {
      const t = tally(rows);
      const state = t.batches.get(batch_id);
      if (state === undefined) throw new Error(`no open row for batch ${batch_id}`);
      if (state === 'closed') return { append: [], result: false };
      const open = t.opens.get(batch_id) as LedgerRow;
      if (!opts.owner && opts.force === undefined) {
        const who = `batch ${batch_id} was opened by pid ${open.pid ?? '?'} on ${open.host ?? '?'}`;
        if (open.host !== deps.host || open.pid === undefined) {
          throw new Error(`${who}; this host (${deps.host}) cannot tell whether it still runs. Once it is gone, close it with --force <reason>`);
        }
        if (deps.isAlive(open.pid)) throw new Error(`${who}, which is alive; stop it first, or close it with --force <reason>`);
      }
      const reason = opts.force === undefined ? {} : { reason: opts.force };
      return { append: [row('close', { call_id: `close:${batch_id}`, batch_id, ...reason })], result: true };
    });
  }

  function makeGrant(batch_id: string, projection: number, ceiling: SpendCeiling | undefined): BatchGrant {
    const controller = new AbortController();
    live.add(controller);
    const grant: BatchGrant = {
      batch_id,
      projection,
      signal: controller.signal,
      // A refusal for this call's own worst case, or at the grant's ceiling, throws for this call
      // only; once settled spend reaches ACTUAL_CAP_USD, `guarded` aborts every live grant, this
      // one included.
      async reserve(req) {
        assertGrant(grant);
        if (controller.signal.aborted) throw controller.signal.reason;
        return reserveIn(req, batch_id, ceiling);
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
        await closeBatch(batch_id, { owner: true });
        closedGrants.add(grant);
        live.delete(controller);
      },
    };
    grants.set(grant, { ledger, store: deps.store });
    return grant;
  }

  return ledger;
}
