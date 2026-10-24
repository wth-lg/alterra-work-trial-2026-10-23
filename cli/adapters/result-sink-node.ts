// The Node ResultSink (plan phase P12): a run directory on disk, read back by replay, regrade,
// summary and audit-check.
//   manifest.json
//   trials/<task>/<index>.json                  the key's settled record
//   trajectories/<task>/<index>.jsonl           its trajectory, appended event by event
//   requeued/<task>/<index>.<attempt>.json      a re-queued attempt's record, and its .jsonl
//   .lock                                       {pid, host, at} of the batch running the run
// Records and the manifest are written to a temp file and renamed into place, so a kill leaves
// the old file or the new one, never half of one; a record that exists is a settled key. A kill
// mid-trial leaves only a partial trajectory, which the next attempt's begin() truncates.
// Directories are created on the first write, so a dry run creates nothing. The lock file is
// created exclusively; one whose pid is dead on this host is taken over by renaming it aside, so
// of two processes taking it over at once only one gets it.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { BatchRefused, type BatchRecord, type ResultSink, type RunManifest, type TrialKey } from '../../packages/core/batch.ts';
import { toJsonLine } from '../../packages/core/trajectory.ts';

export const recordPath = (dir: string, task: string, index: number): string => join(dir, 'trials', task, `${index}.json`);
const trajectoryRel = (task: string, index: number) => `trajectories/${task}/${index}.jsonl`;

export function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, file);
}

function jsonFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => join(e.parentPath, e.name))
    .sort();
}

export interface StoredRecord {
  file: string;
  record: BatchRecord;
}

function read(file: string): StoredRecord {
  try {
    return { file, record: JSON.parse(readFileSync(file, 'utf8')) as BatchRecord };
  } catch (e) {
    throw new Error(`${file}: ${(e as Error).message}`, { cause: e });
  }
}

export const settledRecords = (dir: string): StoredRecord[] => jsonFiles(join(dir, 'trials')).map(read);
export const requeuedRecords = (dir: string): StoredRecord[] => jsonFiles(join(dir, 'requeued')).map(read);

export function readManifest(dir: string): RunManifest | null {
  const file = join(dir, 'manifest.json');
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as RunManifest) : null;
}

// Where a trial's trajectory is, relative to the run directory, as its record says.
export const trajectoryOf = (dir: string, r: Pick<BatchRecord, 'task_id' | 'index' | 'trajectory'>): string => join(dir, r.trajectory ?? trajectoryRel(r.task_id, r.index));

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

const readText = (file: string): string | null => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

// Takes <dir>/.lock; see the header.
async function lockRun(dir: string, log: (line: string) => void): Promise<() => Promise<void>> {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, '.lock');
  const mine = JSON.stringify({ pid: process.pid, host: hostname(), at: new Date().toISOString() });
  for (let tries = 0; tries < 3; tries++) {
    try {
      writeFileSync(file, mine, { flag: 'wx' });
      return async () => {
        if (readText(file) === mine) rmSync(file, { force: true });
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    const text = readText(file);
    if (text === null) continue;
    let held: { pid?: unknown; host?: unknown; at?: unknown } = {};
    try {
      held = JSON.parse(text) as typeof held;
    } catch {
      // An unreadable lock is held by no one we can name; it is never taken over.
    }
    const pid = Number.isSafeInteger(held.pid) ? (held.pid as number) : null;
    if (pid === null || held.host !== hostname() || alive(pid)) {
      throw new BatchRefused(`the run directory ${dir} is locked by pid ${pid ?? '?'} on ${String(held.host ?? '?')} since ${String(held.at ?? '?')}: another batch of this run is running; wait for it, or stop it`);
    }
    const aside = `${file}.stale-${process.pid}`;
    try {
      renameSync(file, aside);
    } catch {
      continue;
    }
    // Another process replaced the stale lock first: put its lock back and look again.
    if (readText(aside) !== text) renameSync(aside, file);
    else {
      rmSync(aside, { force: true });
      log(`took over the stale lock of pid ${pid} on ${dir}: that process is gone`);
    }
  }
  throw new BatchRefused(`the run directory ${dir} is locked: its lock file changed under three attempts to take it`);
}

export function nodeResultSink(dir: string): ResultSink & { dir: string } {
  const live = (k: TrialKey) => join(dir, trajectoryRel(k.task_id, k.index));
  return {
    dir,
    manifest: async () => readManifest(dir),
    writeManifest: async (m) => writeJson(join(dir, 'manifest.json'), m),
    settled: async () => settledRecords(dir).map((s) => s.record),
    requeued: async () => requeuedRecords(dir).map((s) => s.record),
    begin: async (k) => {
      mkdirSync(dirname(live(k)), { recursive: true });
      writeFileSync(live(k), '');
    },
    event: (k, _attempt, e) => appendFileSync(live(k), toJsonLine(e)),
    finish: async (k, record) => {
      if (record.settled) {
        writeJson(recordPath(dir, k.task_id, k.index), { ...record, trajectory: trajectoryRel(k.task_id, k.index) });
        return;
      }
      const base = join(dir, 'requeued', k.task_id, `${k.index}.${record.attempt}`);
      mkdirSync(dirname(base), { recursive: true });
      if (existsSync(live(k))) renameSync(live(k), `${base}.jsonl`);
      writeJson(`${base}.json`, { ...record, trajectory: relative(dir, `${base}.jsonl`).split(sep).join('/') });
    },
    lock: (log) => lockRun(dir, log),
  };
}
