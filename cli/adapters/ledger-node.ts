// The Node LedgerStore: the ledger file, its cross-process lockfile, env and the wall clock.
// Two modes, and no machine-specific path in the code:
//   own-run  CHARTR_CANONICAL_LEDGER is set. The path comes only from it. Opening refuses,
//            before any call can be made, when the value is empty or not absolute, its
//            directory is missing, or SPEND_LEDGER names another file. It never creates a
//            directory. Only a grant minted over the canonical file passes assertGrant.
//   default  SPEND_LEDGER, else ~/.chartr/spend.jsonl, created on first live open.
// The caps are the same in both modes; packages/core/ledger.ts enforces them.
import { randomUUID } from 'node:crypto';
import {
  closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync,
  linkSync, renameSync, statSync, truncateSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { TrialObservation, Usage } from '../../packages/core/cost.ts';
import {
  assertGrant, createLedger, parseRow, restrictGrants,
  type BatchGrant, type Ledger, type LedgerRow, type LedgerStore, type ReserveRequest, type Reservation,
} from '../../packages/core/ledger.ts';

export type LedgerMode = 'own-run' | 'default';
type Env = Record<string, string | undefined>;

const LOCK_TIMEOUT_MS = 30_000;
// A lock whose content cannot be read is treated as abandoned after this long.
const UNREADABLE_LOCK_MS = 10_000;

export function resolveLedgerPath(env: Env = process.env): { mode: LedgerMode; path: string; problems: string[] } {
  const marker = env.CHARTR_CANONICAL_LEDGER;
  if (marker !== undefined) {
    const problems: string[] = [];
    if (marker === '') problems.push('CHARTR_CANONICAL_LEDGER is set but empty');
    else if (!isAbsolute(marker)) problems.push(`CHARTR_CANONICAL_LEDGER=${marker} is not an absolute path`);
    else if (!existsSync(dirname(marker))) problems.push(`the directory of CHARTR_CANONICAL_LEDGER=${marker} does not exist`);
    if (env.SPEND_LEDGER && resolve(env.SPEND_LEDGER) !== resolve(marker)) {
      problems.push(`SPEND_LEDGER=${env.SPEND_LEDGER} names another file than CHARTR_CANONICAL_LEDGER=${marker}`);
    }
    return { mode: 'own-run', path: marker, problems };
  }
  const path = env.SPEND_LEDGER ? resolve(env.SPEND_LEDGER) : join(env.HOME || homedir(), '.chartr', 'spend.jsonl');
  return { mode: 'default', path, problems: [] };
}

// Own-run mode for this process: once CHARTR_CANONICAL_LEDGER is set (even to ''), only a
// grant minted over a store openNodeLedger opened on that exact file passes assertGrant, so
// a ledger on SPEND_LEDGER, another opts.env or an in-memory store cannot meter live calls.
const canonicalStores = new WeakSet<LedgerStore>();
const CANONICAL_PATH = process.env.CHARTR_CANONICAL_LEDGER;
if (CANONICAL_PATH !== undefined) restrictGrants((store) => canonicalStores.has(store));

interface ParsedLedger {
  rows: LedgerRow[];
  // A last line with no newline that does not parse: an append torn by a crash.
  torn: string | null;
  // The file ends without a newline after a complete row.
  unterminated: boolean;
}

function parseLedger(path: string, text: string): ParsedLedger {
  const lines = text.split('\n');
  const tail = lines.pop() as string; // '' when the file ends with a newline
  const parse = (line: string, i: number) => {
    try {
      return parseRow(JSON.parse(line));
    } catch (e) {
      throw new Error(`${path}:${i + 1}: ${(e as Error).message}`, { cause: e });
    }
  };
  const rows = lines.flatMap((line, i) => (line.trim() === '' ? [] : [parse(line, i)]));
  if (tail.trim() === '') return { rows, torn: null, unterminated: false };
  try {
    JSON.parse(tail);
  } catch {
    return { rows, torn: tail, unterminated: false };
  }
  return { rows: [...rows, parse(tail, lines.length)], torn: null, unterminated: true };
}

function warnTorn(path: string, torn: string, action: string): void {
  process.stderr.write(`spend ledger: ${path} ends in a torn line (${Buffer.byteLength(torn)} bytes, an append cut short by a crash); ${action}\n`);
}

// Every row in the ledger. A torn last line is ignored with a warning, never counted; any
// other malformed line throws.
export function readRows(path: string): LedgerRow[] {
  if (!existsSync(path)) return [];
  const parsed = parseLedger(path, readFileSync(path, 'utf8'));
  if (parsed.torn !== null) warnTorn(path, parsed.torn, 'ignoring it; the next write moves it aside');
  return parsed.rows;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// Removes the lock when its holder is a dead process on this host. The lock is renamed
// aside first and removed only if it is still the dead holder's, so a lock another process
// took in between is put back rather than deleted.
function breakStaleLock(lock: string): void {
  let content: string;
  let mtimeMs: number;
  try {
    content = readFileSync(lock, 'utf8');
    mtimeMs = statSync(lock).mtimeMs;
  } catch {
    return; // released meanwhile
  }
  let holder: { pid?: unknown; host?: unknown } | undefined;
  try {
    holder = JSON.parse(content) as typeof holder;
  } catch {
    holder = undefined;
  }
  const stale =
    holder === undefined
      ? Date.now() - mtimeMs > UNREADABLE_LOCK_MS
      : holder.host === hostname() && typeof holder.pid === 'number' && !isAlive(holder.pid);
  if (!stale) return;
  const aside = `${lock}.stale-${process.pid}-${randomUUID()}`;
  try {
    renameSync(lock, aside);
  } catch {
    return;
  }
  if (readFileSync(aside, 'utf8') !== content) {
    try {
      linkSync(aside, lock);
    } catch {
      // Someone else holds a fresh lock now; the renamed one is lost either way.
    }
  }
  unlinkSync(aside);
}

async function withLock<T>(lock: string, fn: () => T): Promise<T> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const fd = openSync(lock, 'wx');
      writeSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), ts: new Date().toISOString() }));
      closeSync(fd);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    breakStaleLock(lock);
    if (Date.now() > deadline) {
      throw new Error(`spend ledger lock ${lock} has been held for over ${LOCK_TIMEOUT_MS / 1000}s; if its holder is gone, delete the file`);
    }
    await new Promise((r) => setTimeout(r, 2 + Math.random() * 10));
  }
  try {
    return fn();
  } finally {
    unlinkSync(lock);
  }
}

export class FileLedgerStore implements LedgerStore {
  readonly path: string;
  private readonly lock: string;
  private readonly createDir: boolean;

  constructor(path: string, opts: { createDir: boolean }) {
    this.path = path;
    this.lock = `${path}.lock`;
    this.createDir = opts.createDir;
  }

  private ensureDir(): void {
    if (this.createDir) mkdirSync(dirname(this.path), { recursive: true });
  }

  transact<T>(fn: (rows: readonly LedgerRow[]) => { append: LedgerRow[]; result: T }): Promise<T> {
    this.ensureDir();
    return withLock(this.lock, () => {
      const parsed = existsSync(this.path) ? parseLedger(this.path, readFileSync(this.path, 'utf8')) : { rows: [], torn: null, unterminated: false };
      if (parsed.torn !== null) this.quarantine(parsed.torn);
      const { append, result } = fn(parsed.rows);
      if (append.length > 0) {
        const fd = openSync(this.path, 'a');
        try {
          writeSync(fd, (parsed.unterminated ? '\n' : '') + append.map((r) => JSON.stringify(r) + '\n').join(''));
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      }
      return result;
    });
  }

  async read(): Promise<LedgerRow[]> {
    return readRows(this.path);
  }

  // Under the lock: copies a torn last line to <ledger>.torn-<ts>-<nonce> and cuts it off.
  private quarantine(torn: string): void {
    const aside = `${this.path}.torn-${Date.now()}-${randomUUID()}`;
    writeFileSync(aside, torn, { flag: 'wx' });
    truncateSync(this.path, readFileSync(this.path).length - Buffer.byteLength(torn));
    warnTorn(this.path, torn, `moved it to ${aside}`);
  }

  // A byte-equal copy, taken under the lock so no append lands mid-copy.
  exportTo(dest: string): Promise<void> {
    this.ensureDir();
    return withLock(this.lock, () => {
      mkdirSync(dirname(resolve(dest)), { recursive: true });
      if (existsSync(this.path)) copyFileSync(this.path, dest);
      else closeSync(openSync(dest, 'w'));
    });
  }
}

// Opens the ledger for this process. A live open (any code path that can call the API)
// also creates the ledger file on first use. Throws, with no row written, on an own-run
// setup problem.
export function openNodeLedger(opts: { transport: 'live' | 'offline'; env?: Env; runId?: string | null }): {
  ledger: Ledger;
  store: FileLedgerStore;
  mode: LedgerMode;
  path: string;
} {
  const { mode, path, problems } = resolveLedgerPath(opts.env ?? process.env);
  if (problems.length > 0) throw new Error(`own-run spend ledger refused: ${problems.join('; ')}`);
  const store = new FileLedgerStore(path, { createDir: mode === 'default' });
  if (mode === 'own-run' && path === CANONICAL_PATH) canonicalStores.add(store);
  if (opts.transport === 'live' && !existsSync(path)) {
    if (mode === 'default') mkdirSync(dirname(path), { recursive: true });
    closeSync(openSync(path, 'a'));
  }
  const ledger = createLedger({
    store,
    clock: { now: () => new Date().toISOString() },
    newId: randomUUID,
    source: 'node',
    runId: opts.runId ?? null,
    pid: process.pid,
    host: hostname(),
    isAlive,
  });
  return { ledger, store, mode, path };
}

// For the Node side of our live Playwright specs, which meter calls the browser makes.
export async function reserveSpend(grant: BatchGrant, req: ReserveRequest): Promise<Reservation> {
  assertGrant(grant);
  return grant.reserve(req);
}

export async function settleSpend(grant: BatchGrant, res: Reservation, usage: Usage | null): Promise<void> {
  return grant.settle(res, usage);
}

function trialFiles(runDir: string): string[] {
  const dir = join(runDir, 'trials');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => join(e.parentPath, e.name))
    .sort();
}

function readTrial(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

// Trial costs from the --cost-from runs, in list order (a later run is newer). A run with
// no trials/ directory is an error: a mistyped path must not fall back to the cap silently.
export function loadTrialObservations(runDirs: readonly string[]): TrialObservation[] {
  return runDirs.flatMap((run, run_order) => {
    if (!existsSync(join(run, 'trials'))) throw new Error(`--cost-from ${run}: no trials/ directory`);
    return trialFiles(run).flatMap((file) => {
      const t = readTrial(file);
      if (typeof t.task_id !== 'string' || typeof t.task_version !== 'string' || typeof t.cost_usd !== 'number') return [];
      return [{
        run, run_order, task_id: t.task_id, task_version: t.task_version, cost_usd: t.cost_usd,
        ...(typeof t.started === 'string' ? { started: t.started } : {}),
        ...(typeof t.outcome === 'string' ? { outcome: t.outcome } : {}),
      }];
    });
  });
}

// The final run's trials so far; none when the run has not started.
export function loadFinalTrials(runDir: string): Array<{ task_id: string; outcome?: string }> {
  return trialFiles(runDir).flatMap((file) => {
    const t = readTrial(file);
    if (typeof t.task_id !== 'string') return [];
    return [{ task_id: t.task_id, ...(typeof t.outcome === 'string' ? { outcome: t.outcome } : {}) }];
  });
}

// The planned tasks: each tasks/<id>/ directory that holds a task.toml, ids starting with '_'
// excluded. Empty before the first task lands.
export function loadPlannedTasks(repoDir: string): string[] {
  const dir = join(repoDir, 'tasks');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('_') && existsSync(join(dir, e.name, 'task.toml')))
    .map((e) => e.name)
    .sort();
}

export function auditorDone(runDir: string): boolean {
  const dir = join(runDir, 'auditor');
  return existsSync(dir) && readdirSync(dir).length > 0;
}
