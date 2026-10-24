// run(task, model, opts) (design section 6, "Entry point"): one trial, the same module in a
// browser Worker and in Node. Everything outside the loop comes in through opts: the task
// source, the Messages client (built by the caller from a BatchGrant), the world bytes and the
// manifest hash they must have, and the wall clock. Progress is reported only as TrialEvents
// through opts.onEvent; the trajectory JSONL is that sequence serialized.
//
// Steps: resolve the task; build the store and hash it, and end as ENV_ERROR before any call
// when the hash is not the manifest's; run the loop; hash the final state; re-execute the
// trajectory's tool log against a fresh store with the tools the loop offered (replay_final),
// and end as ENV_ERROR if it differs. An exception from the environment at any step (the world
// read, loading the store, a hash, a tool) ends the trial as ENV_ERROR INTERNAL with a record;
// only a bad argument or an unknown task throws. The event that ends a trial (limit, error,
// cancelled) is emitted after the final hashes. Then the trial is graded (plan phase P8,
// packages/grader) with the task's checks, judge items through the trial's own client, and the
// record, grade included, is emitted as the graded event, last for every outcome, and
// returned. An invalid trial (INVALID, INFRA, CANCELLED, ENV_ERROR) runs no check and no judge
// call. Grading does not throw: a check that throws grades the trial GRADER_ERROR and a judge
// call the client failed grades it as classifyFailure says (INFRA_API for a 401 or retries
// exhausted), both invalid, both graded last with the cost, turns, tool calls, models and
// hashes the trial really had.
//
// The onEvent sink: run() catches its errors at the emit boundary and never calls it again
// after one, and the record still comes back, with sink_error. A sink that fails while the
// trial runs (before the terminal event) ends it as ENV_ERROR INTERNAL, keeping what was spent:
// its trajectory is incomplete. A failure on the terminal or graded event leaves the outcome as
// it was. Every event stays in the returned events either way.
import { ANTHROPIC_VERSION, MODEL, type MessageParam, type MessageParams } from './anthropic.ts';
import { PER_TRIAL_CAP_USD } from './cost.ts';
import { createEmitter, type TrialEvent, type TrialStatus } from './events.ts';
import { errorText, newOutcome, runLoop, type LoopOutcome, type TrialClient } from './loop.ts';
import { taskVersion, type Task, type TaskSource } from './tasks.ts';
import { toolLog } from './trajectory.ts';
import type { Check } from '../grader/check.ts';
import { grade, gradeWith, judgeFor, ungraded, type Grade } from '../grader/grade.ts';
import { isValid, trialOutcome, type TrialFacts } from '../grader/outcome.ts';
import { clock, NOW_PROMPT } from '../env/clock.ts';
import { loadStore, type FixtureSource } from '../env/fixture-source.ts';
import { stateHash } from '../env/hash.ts';
import type { Resource, Store } from '../env/store.ts';
import { callTool, definitions, type Tool } from '../env/tools/registry.ts';
import { newSession, TOOLS, type WriteContext } from '../env/tools/write/index.ts';
import { indexDefinitions } from '../env/validate.ts';

type Bundle = Parameters<typeof indexDefinitions>[0];

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];
export const DEFAULT_EFFORT: Effort = 'high';
export const MAX_TOKENS = 32_000;
export const MAX_WALL_MS = 30 * 60_000;

// The system prompt every task shares (design section 4, "Shared rules").
export const SYSTEM_PROMPT = [
  'You are a clinical operations agent at Riverbend Family Medicine (fictional), working in the EHR through tools.',
  NOW_PROMPT,
  'You act under the standing delegation of Dr. Maya Okafor, with order-entry rights. Your orders and notes are attributed to her.',
  'Clinic policies in the policy library govern. Where they differ from your general knowledge, follow them.',
  'No one is available to answer questions. Complete the work, then call finish with a short summary.',
].join('\n');

export interface RunOptions {
  tasks: TaskSource;
  client: TrialClient;
  world: FixtureSource;
  // The manifest's state hash: the world the trial starts from must hash to it.
  worldHash: string;
  // Wall clock, epoch ms: event timestamps, started and ended, and the wall-clock cap.
  now: () => number;
  // A signal that aborts after ms of wall-clock time: the wall-clock cap on a request in
  // flight. Default AbortSignal.timeout.
  timeout?: (ms: number) => AbortSignal;
  // The pruned R4 definitions bundle the write tools validate against; indexed once when given.
  definitions?: Bundle;
  effort?: Effort;
  maxTurns?: number;
  // Clamped to PER_TRIAL_CAP_USD, whoever asks for more (a Worker start message included).
  maxCostUsd?: number;
  maxWallMs?: number;
  signal?: AbortSignal;
  onEvent?: (e: TrialEvent) => void;
  trialId?: string;
  // The task's checks (its tests/grader.ts); none by default.
  checks?: readonly Check[];
  // The client judge and extractor calls go through; default `client`, so they are metered
  // under the trial's grant. null: judge items are unknown.
  judge?: TrialClient | null;
}

// What a failed onEvent sink throws into the trial: the trial ends, its trajectory incomplete.
class SinkError extends Error {
  override readonly name = 'SinkError';
}

export interface TrialRun {
  trial_id: string;
  task_id: string;
  task_version: string | null;
  fixture_hash: string;
  // null where an environment exception (ENV_ERROR INTERNAL) came first.
  state_hash: { initial: string | null; final: string | null; replay_final: string | null };
  model_requested: string;
  models_returned: string[];
  effort: Effort;
  api_version: string;
  started: string;
  ended: string;
  turns: number;
  tool_calls: number;
  tool_errors: LoopOutcome['tool_errors'];
  usage: LoopOutcome['usage'];
  cost_usd: number;
  api_retries: number;
  stop_reason: string | null;
  refusal_category: string | null;
  status: TrialStatus;
  stop: LoopOutcome['stop'];
  // The terminal event's code or limit, for any status but COMPLETED and REFUSAL.
  detail: string | null;
  summary: string | null;
  resumed: false;
  // What the judge calls cost (in the ledger like every call); not part of cost_usd, the
  // loop's cost, which the per-trial cap applies to.
  judge_cost_usd: number;
}

// The record run() returns and emits last: the trial and its grade. sink_error: the error of
// an onEvent sink that threw (on the graded event, it is only in the returned record).
export type TrialRecord = TrialRun & Grade & { sink_error?: string };

export interface TrialResult {
  record: TrialRecord;
  events: readonly TrialEvent[];
}

let indexedBundle: Bundle | undefined;

function context(world: Store, task: Task): WriteContext {
  return { world, clock, policies: task.policies, catalog: task.catalog, session: newSession() };
}

// The tools a task offers the model; the loop runs, and replay re-executes, calls against these.
export const taskTools = (task: Task): readonly Tool<WriteContext>[] => (task.tools === null ? TOOLS : TOOLS.filter((t) => task.tools!.includes(t.name)));

// The per-trial cost cap a caller asked for, never above PER_TRIAL_CAP_USD.
export const costCap = (asked: number | undefined): number => (asked !== undefined && !Number.isNaN(asked) ? Math.min(asked, PER_TRIAL_CAP_USD) : PER_TRIAL_CAP_USD);

export function trialParams(task: Task, effort: Effort): MessageParams {
  return {
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    tools: definitions(taskTools(task)).map((d) => ({ name: d.name, description: d.description, input_schema: d.inputSchema })),
    tool_choice: { type: 'auto' },
    thinking: { type: 'adaptive', display: 'summarized' },
    output_config: { effort },
    cache_control: { type: 'ephemeral' },
  };
}

const iso = (ms: number) => new Date(ms).toISOString();

export async function run(taskId: string, model: string, opts: RunOptions): Promise<TrialResult> {
  if (model !== MODEL) throw new TypeError(`run: model ${model} is not ${MODEL}`);
  const effort = opts.effort ?? DEFAULT_EFFORT;
  if (!EFFORTS.includes(effort)) throw new TypeError(`run: effort ${String(effort)} is not one of ${EFFORTS.join(', ')}`);
  const started = opts.now();
  const task = await opts.tasks.get(taskId);
  if (opts.definitions !== undefined && opts.definitions !== indexedBundle) {
    indexDefinitions(opts.definitions);
    indexedBundle = opts.definitions;
  }
  const sink: { error: string | null } = { error: null };
  const onEvent = opts.onEvent;
  const { emit: emitAll, events } = createEmitter(opts.now, onEvent && ((e) => {
    if (sink.error !== null) return;
    try {
      onEvent(e);
    } catch (err) {
      sink.error = errorText(err);
    }
  }));
  // Inside the trial, a sink that has failed ends it.
  const emit: typeof emitAll = (body) => {
    const e = emitAll(body);
    if (sink.error !== null) throw new SinkError(`trajectory sink failed: ${sink.error}`);
    return e;
  };
  const params = trialParams(task, effort);
  const tools = taskTools(task);
  let outcome = newOutcome();
  let initial: string | null = null;
  let final: string | null = null;
  let replayFinal: string | null = null;
  let taskVer: string | null = null;
  let ctx: WriteContext | undefined;
  let initialState: Resource[] = [];
  let finalState: Resource[] | null = null;
  try {
    taskVer = await taskVersion(task, opts.worldHash);
    const bytes = await opts.world.read();
    const source: FixtureSource = { read: async () => bytes };
    const store = await loadStore(source);
    initialState = [...store.resources()];
    initial = await stateHash(initialState);
    emit({ type: 'state_hash', turn: 0, at: 'initial', hash: initial });
    ctx = context(store, task);
    if (initial !== opts.worldHash) {
      outcome = Object.assign(newOutcome(), {
        status: 'ENV_ERROR' as const,
        terminal: { type: 'error' as const, status: 'ENV_ERROR' as const, code: 'initial_hash_mismatch', message: `initial state hash ${initial} is not the manifest's ${opts.worldHash}` },
      });
    } else {
      const history: MessageParam[] = [{ role: 'user', content: task.instruction }];
      outcome = await runLoop({
        client: opts.client, params, history, tools, ctx, now: opts.now, timeout: opts.timeout ?? ((ms) => AbortSignal.timeout(ms)), emit,
        caps: { maxTurns: opts.maxTurns ?? task.maxTurns, maxCostUsd: costCap(opts.maxCostUsd), maxWallMs: opts.maxWallMs ?? MAX_WALL_MS },
        stateHash: () => stateHash(store.resources()),
        out: outcome,
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      finalState = [...store.resources()];
      final = await stateHash(finalState);
      emit({ type: 'state_hash', turn: outcome.turns, at: 'final', hash: final });
      const replayed = await replay(source, task, tools, events);
      replayFinal = replayed && (await stateHash(replayed.resources()));
      if (replayFinal !== null) emit({ type: 'state_hash', turn: outcome.turns, at: 'replay_final', hash: replayFinal });
      // An INTERNAL error recurs on replay; any other trial must reproduce its final state.
      if (outcome.status !== 'ENV_ERROR' && replayFinal !== final) {
        outcome.status = 'ENV_ERROR';
        outcome.terminal = { type: 'error', status: 'ENV_ERROR', code: 'replay_mismatch', message: `replay_final ${replayFinal} is not final ${final}` };
      }
    }
  } catch (e) {
    // The environment failed outside a tool (an onEvent sink that throws mid-loop included):
    // its fault, not the model's. The loop fills `outcome` as it goes, so what it measured up
    // to the throw (turns, tool calls, usage, cost, models) stays in the record.
    outcome.status = 'ENV_ERROR';
    outcome.stop = null;
    outcome.terminal = { type: 'error', status: 'ENV_ERROR', code: 'INTERNAL', message: errorText(e) };
  }
  if (outcome.terminal) emitAll({ turn: outcome.turns, ...outcome.terminal });

  const t = outcome.terminal;
  const facts: Omit<TrialRun, 'ended' | 'judge_cost_usd'> = {
    trial_id: opts.trialId ?? `${task.id}:${started}`,
    task_id: task.id,
    task_version: taskVer,
    fixture_hash: opts.worldHash,
    state_hash: { initial, final, replay_final: replayFinal },
    model_requested: MODEL,
    models_returned: outcome.models_returned,
    effort,
    api_version: ANTHROPIC_VERSION,
    started: iso(started),
    turns: outcome.turns,
    tool_calls: outcome.tool_calls,
    tool_errors: outcome.tool_errors,
    usage: outcome.usage,
    cost_usd: outcome.cost_usd,
    api_retries: outcome.api_retries,
    stop_reason: outcome.stop_reason,
    refusal_category: outcome.refusal_category,
    status: outcome.status,
    stop: outcome.stop,
    detail: t === null ? null : t.type === 'limit' ? t.limit : t.type === 'error' ? t.code : t.reason,
    summary: ctx?.session.summary ?? null,
    resumed: false,
  };
  const checks = opts.checks ?? [];
  const judge = judgeFor(checks, { judge: opts.judge === undefined ? opts.client : opts.judge, effort: task.judgeEffort });
  const graded = await gradeWith({ checks, initial: initialState, final: finalState, events, trial: facts }, judge);
  const emitted: TrialRecord = { ...facts, ended: iso(opts.now()), judge_cost_usd: judge.costUsd, ...graded, ...(sink.error !== null ? { sink_error: sink.error } : {}) };
  emitAll({ type: 'graded', turn: outcome.turns, record: emitted });
  const record = sink.error !== null && emitted.sink_error === undefined ? { ...emitted, sink_error: sink.error } : emitted;
  return { record, events };
}

// The record of a trial run() threw on before it started (the task could not be resolved):
// ENV_ERROR INTERNAL, nothing spent, never a valid trial. Never for a trial that spent: run()
// grades every trial it started, and run-one refuses this record once the ledger shows a call.
export function internalErrorRecord(t: { trialId: string; taskId: string; worldHash: string; effort: Effort; started: number; ended: number }): TrialRecord {
  const o = newOutcome();
  return {
    trial_id: t.trialId, task_id: t.taskId, task_version: null, fixture_hash: t.worldHash,
    state_hash: { initial: null, final: null, replay_final: null },
    model_requested: MODEL, models_returned: [], effort: t.effort, api_version: ANTHROPIC_VERSION,
    started: iso(t.started), ended: iso(t.ended), turns: 0, tool_calls: 0, tool_errors: o.tool_errors, usage: o.usage,
    cost_usd: 0, api_retries: 0, stop_reason: null, refusal_category: null, status: 'ENV_ERROR', stop: null, detail: 'INTERNAL',
    summary: null, resumed: false, judge_cost_usd: 0, ...ungraded('ENV_ERROR'),
  };
}

export interface GradeTrajectoryOptions {
  tasks: TaskSource;
  world: FixtureSource;
  checks: readonly Check[];
  // The trajectory; a graded event in it is ignored.
  events: readonly TrialEvent[];
  // The trial's record: its facts decide the outcome, and its judge cache answers every judge
  // item (a miss is an error: a regrade makes no call).
  record: TrialFacts & { judge?: Pick<Grade['judge'], 'cache'> };
  definitions?: Bundle;
}

// Grades a recorded trial again from its trajectory: the initial state from the world, the
// final state by replaying the tool log on it, judge answers from the record's cache. On the
// trajectory a trial wrote, it returns the grade run() recorded. It never grades a different
// state silently: when the world does not hash to the record's initial hash, or the replay to
// its final hash, the grade is GRADER_ERROR with the reason.
export async function gradeTrajectory(taskId: string, opts: GradeTrajectoryOptions): Promise<Grade> {
  const task = await opts.tasks.get(taskId);
  if (opts.definitions !== undefined && opts.definitions !== indexedBundle) {
    indexDefinitions(opts.definitions);
    indexedBundle = opts.definitions;
  }
  const bytes = await opts.world.read();
  const source: FixtureSource = { read: async () => bytes };
  const initial = [...(await loadStore(source)).resources()];
  const input = { checks: opts.checks, initial, events: opts.events, trial: opts.record };
  const gradeOpts = { cache: opts.record.judge?.cache ?? [], effort: task.judgeEffort };
  const early = trialOutcome(opts.record);
  // An invalid trial is not graded: no state to compare.
  if (early !== null && !isValid(early)) return grade({ ...input, final: null }, gradeOpts);
  const h = opts.record.state_hash;
  const initialHash = await stateHash(initial);
  if (initialHash !== h.initial) return ungraded('GRADER_ERROR', { check: null, message: `regrade: initial state hash ${initialHash} is not the record's ${h.initial}`, stops_batch: false });
  const replayed = await replay(source, task, taskTools(task), opts.events);
  const replayHash = replayed && (await stateHash(replayed.resources()));
  if (replayed === null || replayHash !== h.final) return ungraded('GRADER_ERROR', { check: null, message: `regrade: replayed state hash ${replayHash} is not the record's final ${h.final}`, stops_batch: false });
  return grade({ ...input, final: [...replayed.resources()] }, gradeOpts);
}

// Re-executes the trajectory's tool log against a fresh store and session, with the tools the
// loop offered, skipping each call the tool refused live (an error result: nothing reached the
// store), and returns the store; null when a call throws (the INTERNAL error that ended the
// trial, re-run so it recurs).
async function replay(source: FixtureSource, task: Task, tools: readonly Tool<WriteContext>[], events: readonly TrialEvent[]): Promise<Store | null> {
  const store = await loadStore(source);
  const ctx = context(store, task);
  const failed = new Set(events.flatMap((e) => (e.type === 'tool_result' && e.is_error && e.error_code !== 'INTERNAL' ? [e.tool_use_id] : [])));
  try {
    for (const call of toolLog(events)) if (!failed.has(call.tool_use_id)) callTool(tools, call.name, call.input, ctx);
  } catch {
    return null;
  }
  return store;
}
