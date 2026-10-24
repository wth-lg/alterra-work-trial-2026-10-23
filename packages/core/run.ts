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
// only a bad argument or an unknown task throws. The events that end a trial (limit, error,
// cancelled) are emitted last, after the final hashes. Grading is plan phase P8.
import { ANTHROPIC_VERSION, MODEL, type MessageParam, type MessageParams } from './anthropic.ts';
import { PER_TRIAL_CAP_USD } from './cost.ts';
import { createEmitter, type TrialEvent, type TrialStatus } from './events.ts';
import { errorText, newOutcome, runLoop, type LoopOutcome, type TrialClient } from './loop.ts';
import { taskVersion, type Task, type TaskSource } from './tasks.ts';
import { toolLog } from './trajectory.ts';
import { clock, NOW_PROMPT } from '../env/clock.ts';
import { loadStore, type FixtureSource } from '../env/fixture-source.ts';
import { stateHash } from '../env/hash.ts';
import type { Store } from '../env/store.ts';
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
}

export interface TrialRecord {
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
}

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
  const { emit, events } = createEmitter(opts.now, opts.onEvent);
  const params = trialParams(task, effort);
  const tools = taskTools(task);
  let outcome = newOutcome();
  let initial: string | null = null;
  let final: string | null = null;
  let replayFinal: string | null = null;
  let taskVer: string | null = null;
  let ctx: WriteContext | undefined;
  try {
    taskVer = await taskVersion(task, opts.worldHash);
    const bytes = await opts.world.read();
    const source: FixtureSource = { read: async () => bytes };
    const store = await loadStore(source);
    initial = await stateHash(store.resources());
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
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      final = await stateHash(store.resources());
      emit({ type: 'state_hash', turn: outcome.turns, at: 'final', hash: final });
      replayFinal = await replay(source, task, tools, events);
      if (replayFinal !== null) emit({ type: 'state_hash', turn: outcome.turns, at: 'replay_final', hash: replayFinal });
      // An INTERNAL error recurs on replay; any other trial must reproduce its final state.
      if (outcome.status !== 'ENV_ERROR' && replayFinal !== final) {
        outcome.status = 'ENV_ERROR';
        outcome.terminal = { type: 'error', status: 'ENV_ERROR', code: 'replay_mismatch', message: `replay_final ${replayFinal} is not final ${final}` };
      }
    }
  } catch (e) {
    // The environment failed outside a tool: its fault, not the model's. What the loop
    // measured (turns, usage, cost) stays in the record.
    outcome.status = 'ENV_ERROR';
    outcome.stop = null;
    outcome.terminal = { type: 'error', status: 'ENV_ERROR', code: 'INTERNAL', message: errorText(e) };
  }
  if (outcome.terminal) emit({ turn: outcome.turns, ...outcome.terminal });

  const t = outcome.terminal;
  const record: TrialRecord = {
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
    ended: iso(opts.now()),
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
  return { record, events };
}

// Re-executes the trajectory's tool log against a fresh store and session, with the tools the
// loop offered, skipping each call the tool refused live (an error result: nothing reached the
// store); null when a call throws (the INTERNAL error that ended the trial, re-run so it recurs).
async function replay(source: FixtureSource, task: Task, tools: readonly Tool<WriteContext>[], events: readonly TrialEvent[]): Promise<string | null> {
  const store = await loadStore(source);
  const ctx = context(store, task);
  const failed = new Set(events.flatMap((e) => (e.type === 'tool_result' && e.is_error && e.error_code !== 'INTERNAL' ? [e.tool_use_id] : [])));
  try {
    for (const call of toolLog(events)) if (!failed.has(call.tool_use_id)) callTool(tools, call.name, call.input, ctx);
  } catch {
    return null;
  }
  return stateHash(store.resources());
}
