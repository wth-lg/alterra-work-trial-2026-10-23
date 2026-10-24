// The batch loop (plan phase P12, design section 6 "Orchestration"): the trials of a run, keyed
// by (env_version, model, effort, index), run through run() over injected stores, so a CLI batch
// (cli/run.ts) and a UI batch (the local runner) run this same code. The key is the task's
// env_version, not its task_version (packages/core/tasks.ts): a grader fix (tests/** or
// GRADER_VERSION) leaves the settled trials in place, and the GRADER_ERROR policy regrades them
// offline (cli/regrade.ts); a change to what the agent sees is a new run directory.
//
// planBatch resolves every task and its versions, reads the run's settled records from the
// ResultSink and returns the keys still to run and their projection: projectBatch, the one
// projection function (trials x latest p90 per task_version from the cost-from runs, the earlier
// version as fallback, else the $6 cap, x 1.15, plus the judge allowance). A key whose record is
// settled is never run again, so a killed batch resumes with exactly its unfinished trials.
//
// runBatch holds the run's lock (ResultSink.lock) from the plan to the final manifest, so two
// batches never run one run's keys at once; a second is refused, with no call. It then:
//   1. closes this run's batches that are still open in the ledger (a killed process leaves its
//      open row); the ledger refuses a batch whose process is alive, and so does runBatch. The
//      dead batch's unsettled reservations keep counting, each once, at its worst case;
//   2. gets the grant from ledger.batchStart(projection), which refuses, before any call, when
//      the projection would cross PROJECTED_CAP_USD, or spec.ceiling (the local runner's session
//      cap; ledger.ts); every trial's client is built from that grant, so a re-queued attempt
//      reserves against the same ceiling, and a reserve that would cross it stops the batch
//      (spend_refused_ceiling) like any spend refusal;
//   3. runs the remaining keys `concurrency` at a time. A trial ending INFRA_API, INFRA_HARNESS or
//      ENV_ERROR is re-queued at the end of the batch, up to MAX_RERUNS times, and its record kept
//      as a re-queued attempt (summary counts ENV_ERROR raw over them). A failure classifyFailure
//      says stops the batch (a 400, 401, billing, a substituted model, a spend refusal), settled
//      spend reaching ACTUAL_CAP_USD (the ledger aborts the grant), or the caller's signal, stops it: the
//      trials in flight are cancelled, each call in flight settles at its worst case, and nothing
//      new starts;
//   4. closes the grant (the batch's close row) and records the batch in the run manifest.
// A cancelled or stopped trial's record is kept as a re-queued attempt, never settled, so a rerun
// runs it again. GRADER_ERROR is settled, never re-queued: a rerun would pay for a model trial to
// work around a grader bug; regrade grades it again from its trajectory. A ResultSink write that
// throws stops the batch like a harness failure: the trials in flight are cancelled and settle,
// then the grant closes, the manifest is written and runBatch rethrows the write's error.
// result.cancelled is true only when the caller's signal left keys unsettled.
import { ANTHROPIC_VERSION, classifyFailure } from './anthropic.ts';
import { projectBatch, type Projection, type TrialObservation } from './cost.ts';
import type { TrialEvent } from './events.ts';
import type { BatchGrant, Ledger, LedgerRow, SpendCeiling } from './ledger.ts';
import { errorText, type TrialClient } from './loop.ts';
import { isValid } from './outcomes.ts';
import { run, type Effort, type TrialRecord } from './run.ts';
import { taskVersions, type TaskSource, type TaskVersions } from './tasks.ts';
import type { FixtureSource } from '../env/fixture-source.ts';
import type { Check } from '../grader/check.ts';

export { projectBatch };

export const MAX_RERUNS = 3;
// Outcomes a rerun can cure: re-queued at the end of the batch.
const RERUN = new Set(['INFRA_API', 'INFRA_HARNESS', 'ENV_ERROR']);

export interface TrialKey {
  task_id: string;
  env_version: string;
  model: string;
  effort: Effort;
  index: number;
}

// The idempotence key.
export const trialKey = (k: TrialKey): string => `${k.env_version}/${k.model}/${k.effort}/${k.index}`;
export const recordKey = (r: Pick<BatchRecord, 'task_id' | 'env_version' | 'model_requested' | 'effort' | 'index'>): string => trialKey({ task_id: r.task_id, env_version: r.env_version ?? '', model: r.model_requested, effort: r.effort, index: r.index });

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
  // Each task's versions at the latest batch (packages/core/tasks.ts); env_versions and
  // grader_task_versions are absent from a manifest written before the split.
  task_versions: Record<string, string>;
  env_versions?: Record<string, string>;
  grader_task_versions?: Record<string, string>;
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
  // Takes the run's lock and returns its release; throws BatchRefused while another batch holds
  // it. A lock its holder left by dying is taken over, with a line to log.
  lock(log: (line: string) => void): Promise<() => Promise<void>>;
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
  // The caller's cap on what this batch may take, reruns included; none for the CLI.
  ceiling?: SpendCeiling;
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
  versions: Record<string, TaskVersions>;
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
  const versions: Record<string, TaskVersions> = {};
  for (const id of spec.taskIds) versions[id] = await taskVersions(await deps.tasks.get(id), deps.worldHash);
  const manifest = await deps.sink.manifest();
  if (manifest !== null) {
    for (const f of ['model', 'effort', 'mode'] as const) {
      if (manifest[f] !== spec[f]) throw new BatchRefused(`the run directory holds ${f} ${manifest[f]}, and this batch asks for ${spec[f]}; use a new run directory`);
    }
  }
  const settled = await deps.sink.settled();
  for (const r of settled) {
    const v = versions[r.task_id]?.env_version;
    if (v !== undefined && r.env_version !== v) {
      const at = r.env_version ? `env_version ${r.env_version}` : `task_version ${r.task_version}, recorded before env_version`;
      throw new BatchRefused(`the run directory holds ${r.task_id} at ${at}, and the task's env_version is now ${v}; use a new run directory`);
    }
  }
  const done = new Set(settled.map(recordKey));
  const keys = spec.taskIds.flatMap((task_id) =>
    Array.from({ length: spec.trials }, (_, index): TrialKey => ({ task_id, env_version: versions[task_id]!.env_version, model: spec.model, effort: spec.effort, index })),
  );
  const remaining = keys.filter((k) => !done.has(trialKey(k)));
  const projection = projectBatch(
    spec.taskIds.map((task_id) => ({ task_id, task_version: versions[task_id]!.task_version, trials: remaining.filter((k) => k.task_id === task_id).length })).filter((t) => t.trials > 0),
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
  const unlock = await deps.sink.lock(log);
  try {
    return await lockedBatch(spec, deps, log);
  } finally {
    await unlock();
  }
}

async function lockedBatch(spec: BatchSpec, deps: BatchDeps, log: (line: string) => void): Promise<BatchResult> {
  const plan = await planBatch(spec, deps);
  const result: BatchResult = { batch_id: null, plan, settled: 0, requeued: 0, stopped: null, cancelled: false };
  if (plan.remaining.length === 0 || spec.signal?.aborted) return { ...result, cancelled: plan.remaining.length > 0 };
  await closeStale(spec.runId, deps, log);
  const grant = await deps.ledger.batchStart(plan.projection.total, spec.ceiling);
  result.batch_id = grant.batch_id;
  const entry: BatchEntry = {
    batch_id: grant.batch_id, started: iso(deps.now()), ended: null, projection: plan.projection.total, remaining: plan.remaining.length,
    settled: 0, requeued: 0, stopped: null, cancelled: false,
  };
  const prior = await deps.sink.manifest();
  const pick = (k: keyof TaskVersions) => Object.fromEntries(Object.entries(plan.versions).map(([id, v]) => [id, v[k]]));
  const manifest: RunManifest = {
    ...prior, ...spec.manifest, run_id: spec.runId, model: spec.model, effort: spec.effort, mode: spec.mode, world_hash: deps.worldHash,
    api_version: ANTHROPIC_VERSION, trials: Math.max(spec.trials, prior?.trials ?? 0), task_versions: { ...prior?.task_versions, ...pick('task_version') },
    env_versions: { ...prior?.env_versions, ...pick('env_version') }, grader_task_versions: { ...prior?.grader_task_versions, ...pick('grader_task_version') },
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
  const settledKeys = new Set<string>();

  // Runs one attempt; returns the item again when it is re-queued.
  const attempt = async (item: { key: TrialKey; reruns: number }) => {
    const { key } = item;
    const id = `${grant.batch_id.slice(0, 8)}-${++attempts}`;
    const label = `${spec.mode === 'live' ? '' : 'mock:'}run:${spec.runId}:${key.task_id}/${key.index}`;
    const inner = deps.client(grant, label);
    // Every send carries the batch's signal: run() gives the judge this client with no signal of
    // its own, and a judge call in flight must cancel with the batch too.
    const client: TrialClient = {
      async send(history, params, opts) {
        try {
          return await inner.send(history, params, { ...opts, signal: opts?.signal ? AbortSignal.any([opts.signal, signal]) : signal });
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
    // A judge call cancelled with the batch is not a failure that stops it.
    if (record.error?.stops_batch && !signal.aborted) halt(record.outcome, `${label}: ${record.error.message}`);
    const o = record.outcome;
    let settled = true;
    let again = false;
    if (!isValid(o) && o !== 'GRADER_ERROR') {
      if (signal.aborted || !RERUN.has(o)) settled = false;
      else if (item.reruns < (spec.maxReruns ?? MAX_RERUNS)) [settled, again] = [false, true];
    }
    await deps.sink.finish(key, { ...record, run_id: spec.runId, index: key.index, attempt: id, mode: spec.mode, settled, ...(settled ? {} : { requeue_reason: o }) });
    if (settled) {
      entry.settled++;
      settledKeys.add(trialKey(key));
    } else entry.requeued++;
    return again ? { key, reruns: item.reruns + 1 } : null;
  };

  try {
    await deps.sink.writeManifest(manifest);
    let round = plan.remaining.map((key) => ({ key, reruns: 0 }));
    // A worker whose sink write threw: the batch stops, and the error is rethrown once every
    // worker has settled.
    let failed: { error: unknown } | null = null;
    // Re-queued trials run after the round that re-queued them: at the end of the batch.
    while (round.length > 0 && !signal.aborted) {
      const queue = [...round];
      const next: typeof round = [];
      await Promise.all(
        Array.from({ length: Math.min(spec.concurrency, queue.length) }, async () => {
          try {
            for (let item = queue.shift(); item !== undefined && !signal.aborted; item = queue.shift()) {
              const again = await attempt(item);
              if (again) next.push(again);
            }
          } catch (e) {
            failed ??= { error: e };
            halt('harness', `result sink failed: ${errorText(e)}`);
          }
        }),
      );
      round = next;
    }
    if (failed !== null) throw (failed as { error: unknown }).error;
  } finally {
    await grant.close();
    result.cancelled = (spec.signal?.aborted ?? false) && plan.remaining.some((k) => !settledKeys.has(trialKey(k)));
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
  let locked = false;
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
    lock: async () => {
      if (locked) throw new BatchRefused('the run is locked by another batch');
      locked = true;
      return async () => {
        locked = false;
      };
    },
  };
}
