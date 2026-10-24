// run(task, model, opts) (design section 6, "Entry point"): one trial, the same module in a
// browser Worker and in Node. Everything outside the loop comes in through opts: the task
// source, the Messages client (built by the caller from a BatchGrant), the world bytes and the
// manifest hash they must have, and the wall clock. Progress is reported only as TrialEvents
// through opts.onEvent; the trajectory JSONL is that sequence serialized.
//
// Steps: resolve the task; build the store and hash it, and end as ENV_ERROR before any call
// when the hash is not the manifest's; run the loop; hash the final state; re-execute the
// trajectory's tool log against a fresh store (replay_final), and end as ENV_ERROR if it
// differs. The events that end a trial (limit, error, cancelled) are emitted last, after the
// final hashes. Grading is plan phase P8.
import { ANTHROPIC_VERSION, MODEL, type MessageParam, type MessageParams } from './anthropic.ts';
import { PER_TRIAL_CAP_USD } from './cost.ts';
import { createEmitter, type TrialEvent, type TrialStatus } from './events.ts';
import { newOutcome, runLoop, type LoopOutcome, type TrialClient } from './loop.ts';
import { taskVersion, type Task, type TaskSource } from './tasks.ts';
import { toolLog } from './trajectory.ts';
import { clock, NOW_PROMPT } from '../env/clock.ts';
import { loadStore, type FixtureSource } from '../env/fixture-source.ts';
import { stateHash } from '../env/hash.ts';
import type { Store } from '../env/store.ts';
import { callTool, definitions } from '../env/tools/registry.ts';
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
  // The pruned R4 definitions bundle the write tools validate against; indexed once when given.
  definitions?: Bundle;
  effort?: Effort;
  maxTurns?: number;
  maxCostUsd?: number;
  maxWallMs?: number;
  signal?: AbortSignal;
  onEvent?: (e: TrialEvent) => void;
  trialId?: string;
}

export interface TrialRecord {
  trial_id: string;
  task_id: string;
  task_version: string;
  fixture_hash: string;
  state_hash: { initial: string; final: string | null; replay_final: string | null };
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

export function trialParams(task: Task, effort: Effort): MessageParams {
  const tools = task.tools === null ? TOOLS : TOOLS.filter((t) => task.tools!.includes(t.name));
  return {
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    tools: definitions(tools).map((d) => ({ name: d.name, description: d.description, input_schema: d.inputSchema })),
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
  const bytes = await opts.world.read();
  const source: FixtureSource = { read: async () => bytes };
  const { emit, events } = createEmitter(opts.now, opts.onEvent);
  const store = await loadStore(source);
  const initial = await stateHash(store.resources());
  emit({ type: 'state_hash', turn: 0, at: 'initial', hash: initial });

  const params = trialParams(task, effort);
  const tools = TOOLS.filter((t) => params.tools!.some((d) => d.name === t.name));
  const ctx = context(store, task);
  let outcome: LoopOutcome;
  let final: string | null = null;
  let replayFinal: string | null = null;
  if (initial !== opts.worldHash) {
    outcome = Object.assign(newOutcome(), {
      status: 'ENV_ERROR' as const,
      terminal: { type: 'error' as const, status: 'ENV_ERROR' as const, code: 'initial_hash_mismatch', message: `initial state hash ${initial} is not the manifest's ${opts.worldHash}` },
    });
  } else {
    const history: MessageParam[] = [{ role: 'user', content: task.instruction }];
    outcome = await runLoop({
      client: opts.client, params, history, tools, ctx, now: opts.now, emit,
      caps: { maxTurns: opts.maxTurns ?? task.maxTurns, maxCostUsd: opts.maxCostUsd ?? PER_TRIAL_CAP_USD, maxWallMs: opts.maxWallMs ?? MAX_WALL_MS },
      stateHash: () => stateHash(store.resources()),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    final = await stateHash(store.resources());
    emit({ type: 'state_hash', turn: outcome.turns, at: 'final', hash: final });
    replayFinal = await replay(source, task, events);
    if (replayFinal !== null) emit({ type: 'state_hash', turn: outcome.turns, at: 'replay_final', hash: replayFinal });
    // An INTERNAL error recurs on replay; any other trial must reproduce its final state.
    if (outcome.status !== 'ENV_ERROR' && replayFinal !== final) {
      outcome.status = 'ENV_ERROR';
      outcome.terminal = { type: 'error', status: 'ENV_ERROR', code: 'replay_mismatch', message: `replay_final ${replayFinal} is not final ${final}` };
    }
  }
  if (outcome.terminal) emit({ turn: outcome.turns, ...outcome.terminal });

  const t = outcome.terminal;
  const record: TrialRecord = {
    trial_id: opts.trialId ?? `${task.id}:${started}`,
    task_id: task.id,
    task_version: await taskVersion(task, opts.worldHash),
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
    summary: ctx.session.summary ?? null,
    resumed: false,
  };
  return { record, events };
}

// Re-executes the trajectory's tool log against a fresh store and session; null when a call
// throws (the INTERNAL error that ended the trial).
async function replay(source: FixtureSource, task: Task, events: readonly TrialEvent[]): Promise<string | null> {
  const store = await loadStore(source);
  const ctx = context(store, task);
  try {
    for (const call of toolLog(events)) callTool(TOOLS, call.name, call.input, ctx);
  } catch {
    return null;
  }
  return stateHash(store.resources());
}
