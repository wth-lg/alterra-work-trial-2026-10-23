// The batch loop (plan phase P12, design section 6 "Orchestration"): the trials of a run, keyed
// by (task_version, model, effort, index), run through run() over injected stores, so a CLI batch
// (cli/run.ts) and a UI batch (the local runner) run this same code.
//
// planBatch resolves every task and its task_version, reads the run's settled records from the
// ResultSink and returns the keys still to run and their projection: projectBatch, the one
// projection function (trials x latest p90 per task_version from the cost-from runs, the earlier
// version as fallback, else the $6 cap, x 1.15, plus the judge allowance). A key whose record is
// settled is never run again, so a killed batch resumes with exactly its unfinished trials.
//
// runBatch then:
//   1. closes this run's batches that are still open in the ledger (a killed process leaves its
//      open row); the ledger refuses a batch whose process is alive, and so does runBatch. The
//      dead batch's unsettled reservations keep counting, each once, at its worst case;
//   2. gets the grant from ledger.batchStart(projection), which refuses, before any call, when
//      the projection would cross $450; every trial's client is built from that grant;
//   3. runs the remaining keys `concurrency` at a time. A trial ending INFRA_API, INFRA_HARNESS or
//      ENV_ERROR is re-queued at the end of the batch, up to MAX_RERUNS times, and its record kept
//      as a re-queued attempt (summary counts ENV_ERROR raw over them). A failure classifyFailure
//      says stops the batch (a 400, 401, billing, a substituted model, a spend refusal), settled
//      spend reaching $500 (the ledger aborts the grant), or the caller's signal, stops it: the
//      trials in flight are cancelled, each call in flight settles at its worst case, and nothing
//      new starts;
//   4. closes the grant (the batch's close row) and records the batch in the run manifest.
// A cancelled or stopped trial's record is kept as a re-queued attempt, never settled, so a rerun
// runs it again.
import { ANTHROPIC_VERSION, classifyFailure } from './anthropic.ts';
import { projectBatch, type Projection, type TrialObservation } from './cost.ts';
import type { TrialEvent } from './events.ts';
import type { BatchGrant, Ledger, LedgerRow } from './ledger.ts';
import { errorText, type TrialClient } from './loop.ts';
import { isValid } from './outcomes.ts';
import { run, type Effort, type TrialRecord } from './run.ts';
import { taskVersion, type TaskSource } from './tasks.ts';
import type { FixtureSource } from '../env/fixture-source.ts';
import type { Check } from '../grader/check.ts';

export { projectBatch };

export const MAX_RERUNS = 3;
// Outcomes a rerun can cure: re-queued at the end of the batch.
const RERUN = new Set(['INFRA_API', 'INFRA_HARNESS', 'ENV_ERROR']);

export interface TrialKey {
  task_id: string;
  task_version: string;
  model: string;
  effort: Effort;
  index: number;
}

// The idempotence key.
export const trialKey = (k: TrialKey): string => `${k.task_version}/${k.model}/${k.effort}/${k.index}`;
const keyOfRecord = (r: BatchRecord): string => trialKey({ task_id: r.task_id, task_version: r.task_version ?? '', model: r.model_requested, effort: r.effort, index: r.index });

// A trial record as a batch stores it. settled: the key's record; false for a re-queued attempt.
export type BatchRecord = TrialRecord & {
  run_id: string;
  index: number;
  attempt: string;
  mode: string;
  settled: boolean;
  requeue_reason?: string;
  trajectory?: string;
};

export interface BatchEntry {
  batch_id: string;
  started: string;
  ended: string | null;
  projection: number;
  remaining: number;
  settled: number;
  requeued: number;
  stopped: string | null;
  cancelled: boolean;
}

// manifest.json. The caller adds its own fields (cli/run.ts: env_git_sha, env_dirty).
export interface RunManifest {
  run_id: string;
  model: string;
  effort: Effort;
  // live, or mock-<scenario>: a run directory holds one mode, so a live run never counts a mock record.
  mode: string;
  world_hash: string;
  api_version: string;
  trials: number;
  task_versions: Record<string, string>;
  batches: BatchEntry[];
  [k: string]: unknown;
}

// Where a batch keeps its results: cli/adapters/result-sink-node.ts on disk, memorySink() here.
export interface ResultSink {
  manifest(): Promise<RunManifest | null>;
  writeManifest(m: RunManifest): Promise<void>;
  settled(): Promise<BatchRecord[]>;
  requeued(): Promise<BatchRecord[]>;
  // Starts an attempt's trajectory, dropping what an earlier, killed attempt left.
  begin(key: TrialKey, attempt: string): Promise<void>;
  // One trajectory event, as it happens; a throw ends the trial as ENV_ERROR (run.ts).
  event(key: TrialKey, attempt: string, e: TrialEvent): void;
  finish(key: TrialKey, record: BatchRecord): Promise<void>;
}

export interface BatchSpec {
  runId: string;
  taskIds: readonly string[];
  trials: number; // per task
  model: string;
  effort: Effort;
  mode: string;
  concurrency: number;
  // Trial costs from the --cost-from runs.
  observations?: readonly TrialObservation[];
  maxReruns?: number;
  // Extra manifest fields.
  manifest?: Record<string, unknown>;
  signal?: AbortSignal;
  log?: (line: string) => void;
}

export interface BatchDeps {
  ledger: Ledger;
  // The ledger's rows, to find this run's batches a killed process left open.
  rows: () => Promise<readonly LedgerRow[]>;
  sink: ResultSink;
  tasks: TaskSource;
  // The Messages client of one trial attempt, built from the batch's grant; trial labels its
  // ledger rows.
  client: (grant: BatchGrant, trial: string) => TrialClient;
  // A task's checks (its tests/grader.ts); none by default.
  checks?: (taskId: string) => Promise<readonly Check[]>;
  world: FixtureSource;
  worldHash: string;
  definitions?: Parameters<typeof run>[2]['definitions'];
  now: () => number;
  run?: typeof run;
}

export interface BatchPlan {
  versions: Record<string, string>;
  keys: TrialKey[];
  remaining: TrialKey[];
  projection: Projection;
}

export interface BatchResult {
  batch_id: string | null;
  plan: BatchPlan;
  settled: number;
  requeued: number;
  stopped: { code: string; message: string } | null;
  cancelled: boolean;
}

// A batch that cannot start as asked: nothing was called.
export class BatchRefused extends Error {
  override readonly name = 'BatchRefused';
}

const iso = (ms: number) => new Date(ms).toISOString();

export async function planBatch(spec: BatchSpec, deps: Pick<BatchDeps, 'tasks' | 'sink' | 'worldHash'>): Promise<BatchPlan> {
  if (!Number.isSafeInteger(spec.trials) || spec.trials < 1) throw new BatchRefused(`trials must be a whole number >= 1, got ${spec.trials}`);
  if (!Number.isSafeInteger(spec.concurrency) || spec.concurrency < 1) throw new BatchRefused(`concurrency must be a whole number >= 1, got ${spec.concurrency}`);
  if (spec.taskIds.length === 0 || new Set(spec.taskIds).size !== spec.taskIds.length) throw new BatchRefused('tasks must be a non-empty list without repeats');
  const versions: Record<string, string> = {};
  for (const id of spec.taskIds) versions[id] = await taskVersion(await deps.tasks.get(id), deps.worldHash);
  const manifest = await deps.sink.manifest();
  if (manifest !== null) {
    for (const f of ['model', 'effort', 'mode'] as const) {
      if (manifest[f] !== spec[f]) throw new BatchRefused(`the run directory holds ${f} ${manifest[f]}, and this batch asks for ${spec[f]}; use a new run directory`);
    }
  }
  const settled = await deps.sink.settled();
  for (const r of settled) {
    const v = versions[r.task_id];
    if (v !== undefined && r.task_version !== v) {
      throw new BatchRefused(`the run directory holds ${r.task_id} at task_version ${r.task_version}, and the task is now ${v}; use a new run directory`);
    }
  }
  const done = new Set(settled.map(keyOfRecord));
  const keys = spec.taskIds.flatMap((task_id) =>
    Array.from({ length: spec.trials }, (_, index): TrialKey => ({ task_id, task_version: versions[task_id] as string, model: spec.model, effort: spec.effort, index })),
  );
  const remaining = keys.filter((k) => !done.has(trialKey(k)));
  const projection = projectBatch(
    spec.taskIds.map((task_id) => ({ task_id, task_version: versions[task_id] as string, trials: remaining.filter((k) => k.task_id === task_id).length })).filter((t) => t.trials > 0),
    spec.observations ?? [],
  );
  return { versions, keys, remaining, projection };
}

// Closes this run's batches still open in the ledger: a killed process left them. The ledger
// refuses one whose process may still run, and the batch is refused with it.
async function closeStale(runId: string, deps: BatchDeps, log: (l: string) => void): Promise<void> {
  const rows = await deps.rows();
  const closed = new Set(rows.filter((r) => r.kind === 'close').map((r) => r.batch_id));
  for (const r of rows) {
    if (r.kind !== 'open' || r.run_id !== runId || r.batch_id === null || closed.has(r.batch_id)) continue;
    try {
      await deps.ledger.close(r.batch_id);
    } catch (e) {
      throw new BatchRefused(`batch ${r.batch_id} of run ${runId} is still open: ${errorText(e)}`, { cause: e });
    }
    closed.add(r.batch_id);
    log(`closed batch ${r.batch_id}, left open by pid ${r.pid ?? '?'}; its unsettled reservations keep counting`);
  }
}

export async function runBatch(spec: BatchSpec, deps: BatchDeps): Promise<BatchResult> {
  const log = spec.log ?? (() => {});
  const plan = await planBatch(spec, deps);
  const result: BatchResult = { batch_id: null, plan, settled: 0, requeued: 0, stopped: null, cancelled: false };
  if (plan.remaining.length === 0 || spec.signal?.aborted) return { ...result, cancelled: spec.signal?.aborted ?? false };
  await closeStale(spec.runId, deps, log);
  const grant = await deps.ledger.batchStart(plan.projection.total);
  result.batch_id = grant.batch_id;
  const entry: BatchEntry = {
    batch_id: grant.batch_id, started: iso(deps.now()), ended: null, projection: plan.projection.total, remaining: plan.remaining.length,
    settled: 0, requeued: 0, stopped: null, cancelled: false,
  };
  const prior = await deps.sink.manifest();
  const manifest: RunManifest = {
    ...prior, ...spec.manifest, run_id: spec.runId, model: spec.model, effort: spec.effort, mode: spec.mode, world_hash: deps.worldHash,
    api_version: ANTHROPIC_VERSION, trials: Math.max(spec.trials, prior?.trials ?? 0), task_versions: { ...prior?.task_versions, ...plan.versions },
    batches: [...(prior?.batches ?? []), entry],
  };

  const stop = new AbortController();
  const signal = spec.signal ? AbortSignal.any([spec.signal, stop.signal]) : stop.signal;
  const halt = (code: string, message: string) => {
    if (result.stopped !== null) return;
    result.stopped = { code, message };
    log(`batch stopped (${code}): ${message}`);
    stop.abort(new Error(`batch stopped: ${message}`));
  };
  const capReached = () => grant.signal.aborted && halt('actual_cap', errorText(grant.signal.reason));
  const checks = new Map<string, Promise<readonly Check[]>>();
  const checksFor = (id: string) => {
    if (!checks.has(id)) checks.set(id, deps.checks ? deps.checks(id) : Promise.resolve([]));
    return checks.get(id) as Promise<readonly Check[]>;
  };
  let attempts = 0;

  // Runs one attempt; returns the item again when it is re-queued.
  const attempt = async (item: { key: TrialKey; reruns: number }) => {
    const { key } = item;
    const id = `${grant.batch_id.slice(0, 8)}-${++attempts}`;
    const label = `${spec.mode === 'live' ? '' : 'mock:'}run:${spec.runId}:${key.task_id}/${key.index}`;
    const inner = deps.client(grant, label);
    const client: TrialClient = {
      async send(history, params, opts) {
        try {
          return await inner.send(history, params, opts);
        } catch (e) {
          capReached();
          if (!signal.aborted) {
            const f = classifyFailure(e);
            if (f.stopsBatch) halt(f.code, `${label}: ${f.message}`);
          }
          throw e;
        }
      },
    };
    await deps.sink.begin(key, id);
    let record: TrialRecord;
    try {
      ({ record } = await (deps.run ?? run)(key.task_id, spec.model, {
        tasks: deps.tasks, client, world: deps.world, worldHash: deps.worldHash, now: deps.now, effort: spec.effort, signal, trialId: label,
        checks: await checksFor(key.task_id), onEvent: (e) => deps.sink.event(key, id, e),
        ...(deps.definitions !== undefined ? { definitions: deps.definitions } : {}),
      }));
    } catch (e) {
      halt('harness', `${label}: run() threw: ${errorText(e)}`);
      return null;
    }
    capReached();
    if (record.error?.stops_batch) halt(record.outcome, `${label}: ${record.error.message}`);
    const o = record.outcome;
    let settled = true;
    let again = false;
    if (!isValid(o) && o !== 'GRADER_ERROR') {
      if (signal.aborted || !RERUN.has(o)) settled = false;
      else if (item.reruns < (spec.maxReruns ?? MAX_RERUNS)) [settled, again] = [false, true];
    }
    await deps.sink.finish(key, { ...record, run_id: spec.runId, index: key.index, attempt: id, mode: spec.mode, settled, ...(settled ? {} : { requeue_reason: o }) });
    if (settled) entry.settled++;
    else entry.requeued++;
    return again ? { key, reruns: item.reruns + 1 } : null;
  };

  try {
    await deps.sink.writeManifest(manifest);
    let round = plan.remaining.map((key) => ({ key, reruns: 0 }));
    // Re-queued trials run after the round that re-queued them: at the end of the batch.
    while (round.length > 0 && !signal.aborted) {
      const queue = [...round];
      const next: typeof round = [];
      await Promise.all(
        Array.from({ length: Math.min(spec.concurrency, queue.length) }, async () => {
          for (let item = queue.shift(); item !== undefined && !signal.aborted; item = queue.shift()) {
            const again = await attempt(item);
            if (again) next.push(again);
          }
        }),
      );
      round = next;
    }
  } finally {
    await grant.close();
    result.cancelled = spec.signal?.aborted ?? false;
    Object.assign(entry, { ended: iso(deps.now()), stopped: result.stopped?.code ?? null, cancelled: result.cancelled });
    await deps.sink.writeManifest(manifest);
  }
  result.settled = entry.settled;
  result.requeued = entry.requeued;
  return result;
}

// A ResultSink in memory: the batch tests, and any caller that keeps results itself.
export function memorySink(): ResultSink & { events: Map<string, TrialEvent[]> } {
  let manifest: RunManifest | null = null;
  const settled = new Map<string, BatchRecord>();
  const requeued: BatchRecord[] = [];
  const events = new Map<string, TrialEvent[]>();
  const at = (k: TrialKey, attempt: string) => `${k.task_id}/${k.index}#${attempt}`;
  const copy = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
  return {
    events,
    manifest: async () => (manifest === null ? null : copy(manifest)),
    writeManifest: async (m) => {
      manifest = copy(m);
    },
    settled: async () => [...settled.values()],
    requeued: async () => [...requeued],
    begin: async (k, attempt) => {
      events.set(at(k, attempt), []);
    },
    event: (k, attempt, e) => {
      events.get(at(k, attempt))?.push(e);
    },
    finish: async (k, record) => {
      if (record.settled) settled.set(trialKey(k), record);
      else requeued.push(record);
    },
  };
}
