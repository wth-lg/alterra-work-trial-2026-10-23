// The Node LedgerStore: the ledger file, its cross-process lockfile, env and the wall clock.
// Two modes, and no machine-specific path in the code:
//   own-run  CHARTR_CANONICAL_LEDGER is set. The path comes only from it. Opening refuses,
//            before any call can be made, when the value is empty or not absolute, its
//            directory is missing, or SPEND_LEDGER names another file. It never creates a
//            directory. Only a grant minted over the canonical file passes assertGrant.
//   default  SPEND_LEDGER, else ~/.chartr/spend.jsonl, created on first live open.
// A ledger is known by its real path, so a symlink or a relative name reaches the same file
// and the same lock. The caps are the same in both modes; packages/core/ledger.ts enforces them.
import { randomUUID } from 'node:crypto';
import {
  closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync,
  realpathSync, renameSync, rmSync, truncateSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { homedir, hostname } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { TrialObservation, Usage } from '../../packages/core/cost.ts';
import {
  assertGrant, createLedger, parseRow, restrictGrants,
  type BatchGrant, type Ledger, type LedgerRow, type LedgerStore, type ReserveRequest, type Reservation,
} from '../../packages/core/ledger.ts';

export type LedgerMode = 'own-run' | 'default';
type Env = Record<string, string | undefined>;

const LOCK_TIMEOUT_MS = 30_000;

// The real path of a ledger file: realpath of the file, or, for a file not created yet, the
// realpath of its nearest existing ancestor joined with the rest.
export function realLedgerPath(path: string): string {
  const rest: string[] = [];
  for (let at = resolve(path); ; at = dirname(at)) {
    try {
      return join(realpathSync(at), ...rest);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw e;
      if (dirname(at) === at) return resolve(path);
      rest.unshift(basename(at));
    }
  }
}

export function resolveLedgerPath(env: Env = process.env): { mode: LedgerMode; path: string; problems: string[] } {
  const marker = env.CHARTR_CANONICAL_LEDGER;
  if (marker !== undefined) {
    const problems: string[] = [];
    if (marker === '') problems.push('CHARTR_CANONICAL_LEDGER is set but empty');
    else if (!isAbsolute(marker)) problems.push(`CHARTR_CANONICAL_LEDGER=${marker} is not an absolute path`);
    else if (!existsSync(dirname(marker))) problems.push(`the directory of CHARTR_CANONICAL_LEDGER=${marker} does not exist`);
    if (env.SPEND_LEDGER && realLedgerPath(env.SPEND_LEDGER) !== realLedgerPath(marker)) {
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

// The lock is a directory, <ledger>.lock, that holds one entry named after its holder's
// nonce, with {pid, host, ts} inside. A contender builds a private candidate directory with
// its entry and renames it onto the lock path: rename(2) replaces only a missing or empty
// directory, so exactly one contender wins, and the lock never exists without its holder.
// Release unlinks the entry; an empty lock directory is free. A holder that is a dead pid on
// this host has its entry unlinked by name. Entry names are never reused, so a breaker that
// stalls after judging a holder dead can only remove that holder's entry, never the entry of
// whoever took the lock since.
const HELD = new Set(['ENOTEMPTY', 'EEXIST', 'ENOTDIR']);

function breakStaleLock(lock: string): void {
  let entries: string[];
  try {
    entries = readdirSync(lock);
  } catch {
    return; // missing, or not a directory: nothing this code can break
  }
  for (const entry of entries) {
    let holder: { pid?: unknown; host?: unknown };
    try {
      holder = JSON.parse(readFileSync(join(lock, entry), 'utf8')) as typeof holder;
    } catch {
      continue; // released meanwhile, or unreadable: left for the timeout message
    }
    if (holder.host !== hostname() || typeof holder.pid !== 'number' || isAlive(holder.pid)) continue;
    try {
      unlinkSync(join(lock, entry));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
}

async function withLock<T>(lock: string, fn: () => T): Promise<T> {
  const nonce = randomUUID();
  const entry = `holder-${nonce}`;
  const candidate = `${lock}.candidate-${nonce}`;
  mkdirSync(candidate);
  try {
    writeFileSync(join(candidate, entry), JSON.stringify({ pid: process.pid, host: hostname(), ts: new Date().toISOString() }));
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        renameSync(candidate, lock);
        break;
      } catch (e) {
        if (!HELD.has((e as NodeJS.ErrnoException).code ?? '')) throw e;
      }
      breakStaleLock(lock);
      if (Date.now() > deadline) {
        throw new Error(`spend ledger lock ${lock} has been held for over ${LOCK_TIMEOUT_MS / 1000}s; if its holder is gone, delete it`);
      }
      await new Promise((r) => setTimeout(r, 2 + Math.random() * 10));
    }
  } catch (e) {
    rmSync(candidate, { recursive: true, force: true });
    throw e;
  }
  try {
    return fn();
  } finally {
    unlinkSync(join(lock, entry));
  }
}

export class FileLedgerStore implements LedgerStore {
  readonly path: string;
  private readonly lock: string;
  private readonly createDir: boolean;

  constructor(path: string, opts: { createDir: boolean }) {
    this.path = realLedgerPath(path);
    this.lock = `${this.path}.lock`;
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
