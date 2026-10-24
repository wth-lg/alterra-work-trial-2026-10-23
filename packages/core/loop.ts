// The agent loop (design section 6): request, then the answer's tool calls one at a time in
// emitted order, until the episode ends. It keeps the conversation append-only: MessagesClient
// appends each complete answer exactly as streamed, thinking blocks and signatures included,
// and the loop only appends the user turn of tool results after it. It never edits or drops an
// earlier message.
//
// The episode ends on:
//   finish                 the calls before it in the same answer run; each call after it is
//                          recorded as a tool_result with executed false and "episode finished"
//   an answer without tool use (end_turn)
//   a refusal              REFUSAL
//   a cap                  LIMIT: turns (requests sent), cost (priced usage so far) and wall
//                          clock (the injected clock), checked before each request; and a
//                          second max_tokens stop in a row (the first is asked to continue)
//   opts.signal aborted    CANCELLED, checked before each request and passed to the client
//   an exception from a tool other than ToolError
//                          ENV_ERROR, code INTERNAL: the environment's fault, not the model's
//   a client error         INFRA_API, INFRA_HARNESS or INVALID (a response from another model)
// It reads no clock and draws no randomness (eslint-rules/determinism.js): time comes from the
// injected `now`, used only for the wall-clock cap.
import { ApiError, type CallResult, type MessageParam, type MessageParams, type SendOptions } from './anthropic.ts';
import { usageCostUsd, type Usage } from './cost.ts';
import type { ErrorStatus, EventBody, Limit, TrialStatus } from './events.ts';
import { SpendRefused } from './ledger.ts';
import { ERROR_CODES, internalError, type ErrorCode } from '../env/tools/errors.ts';
import { callTool, type Tool, type ToolResult } from '../env/tools/registry.ts';
import type { WriteContext } from '../env/tools/write/index.ts';

// The part of MessagesClient the loop uses: send appends a complete, non-refusal answer to history.
export interface TrialClient {
  send(history: MessageParam[], params: MessageParams, opts?: SendOptions): Promise<CallResult>;
}

export interface Caps {
  maxTurns: number;
  maxCostUsd: number;
  maxWallMs: number;
}

export interface LoopInput {
  client: TrialClient;
  params: MessageParams;
  // Starts as the instruction turn; the loop appends to it.
  history: MessageParam[];
  tools: readonly Tool<WriteContext>[];
  ctx: WriteContext;
  caps: Caps;
  now: () => number;
  signal?: AbortSignal;
  emit: (body: EventBody) => void;
  stateHash: () => Promise<string>;
}

export type Terminal =
  | { type: 'limit'; limit: Limit; cap: number; value: number }
  | { type: 'error'; status: ErrorStatus; code: string; message: string }
  | { type: 'cancelled'; reason: string };

export interface LoopOutcome {
  status: TrialStatus;
  // How a COMPLETED episode ended.
  stop: 'finish' | 'end_turn' | null;
  // The event that ends a trial in any other status; run() emits it last.
  terminal: Terminal | null;
  turns: number;
  tool_calls: number;
  tool_errors: Record<ErrorCode, number>;
  usage: { input: number; cache_write: number; cache_read: number; output: number };
  cost_usd: number;
  models_returned: string[];
  api_retries: number;
  stop_reason: string | null;
  refusal_category: string | null;
}

const CONTINUE = 'Your previous answer reached the output token limit. Continue from where it stopped.';
const FINISHED = { error: { code: 'CONFLICT', message: 'episode finished' } } as const;

interface ToolUse {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

const errorText = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

// How a failed send ends the trial (design section 1, "Failure modes").
function clientFailure(e: unknown, signal: AbortSignal | undefined): Exclude<Terminal, { type: 'limit' }> {
  if (signal?.aborted) return { type: 'cancelled', reason: errorText(signal.reason ?? e) };
  if (e instanceof SpendRefused) return { type: 'error', status: 'INFRA_HARNESS', code: `spend_refused_${e.cap}`, message: e.message };
  if (e instanceof ApiError) {
    if (e.errorType === 'model_mismatch') return { type: 'error', status: 'INVALID', code: 'model_mismatch', message: e.message };
    const harness = e.stopsBatch || e.errorType === 'egress_refused';
    return { type: 'error', status: harness ? 'INFRA_HARNESS' : 'INFRA_API', code: e.errorType ?? (e.status === null ? 'network' : `http_${e.status}`), message: e.message };
  }
  // A request the client refused to build, or a ledger failure: a harness bug.
  return { type: 'error', status: 'INFRA_HARNESS', code: 'client_error', message: errorText(e) };
}

const toolResultBlock = (id: string, r: Pick<ToolResult, 'content' | 'is_error'>) => ({
  type: 'tool_result',
  tool_use_id: id,
  content: JSON.stringify(r.content),
  ...(r.is_error ? { is_error: true } : {}),
});

// The outcome of a trial that has sent nothing yet.
export const newOutcome = (): LoopOutcome => ({
  status: 'COMPLETED', stop: null, terminal: null, turns: 0, tool_calls: 0,
  tool_errors: Object.fromEntries(ERROR_CODES.map((c) => [c, 0])) as Record<ErrorCode, number>,
  usage: { input: 0, cache_write: 0, cache_read: 0, output: 0 }, cost_usd: 0,
  models_returned: [], api_retries: 0, stop_reason: null, refusal_category: null,
});

export async function runLoop(input: LoopInput): Promise<LoopOutcome> {
  const { client, params, history, tools, ctx, caps, now, signal, emit } = input;
  const started = now();
  const out = newOutcome();
  const end = (status: TrialStatus, terminal: Terminal | null, stop: LoopOutcome['stop'] = null): LoopOutcome =>
    Object.assign(out, { status, terminal, stop });
  // Messages already carried by a request or response event.
  let logged = 0;
  let maxTokensInARow = 0;

  for (;;) {
    if (signal?.aborted) return end('CANCELLED', { type: 'cancelled', reason: errorText(signal.reason) });
    if (out.turns >= caps.maxTurns) return end('LIMIT', { type: 'limit', limit: 'turns', cap: caps.maxTurns, value: out.turns });
    if (out.cost_usd >= caps.maxCostUsd) return end('LIMIT', { type: 'limit', limit: 'cost', cap: caps.maxCostUsd, value: out.cost_usd });
    const elapsed = now() - started;
    if (elapsed >= caps.maxWallMs) return end('LIMIT', { type: 'limit', limit: 'wall_clock', cap: caps.maxWallMs, value: elapsed });

    const turn = ++out.turns;
    emit({ type: 'request', turn, messages_from: logged, messages: history.slice(logged), ...(turn === 1 ? { params } : {}) });
    let r: CallResult;
    try {
      r = await client.send(history, params, signal ? { signal } : {});
    } catch (e) {
      const t = clientFailure(e, signal);
      return end(t.type === 'error' ? t.status : 'CANCELLED', t);
    }
    const m = r.message;
    const priced = usageCostUsd(m.usage);
    emit({
      type: 'response', turn, id: m.id, model: m.model, stop_reason: m.stop_reason, stop_details: (m.stop_details ?? null) as Record<string, unknown> | null,
      content: m.content, usage: m.usage, attempts: r.attempts, cost_usd: priced,
    });
    // The answer is in history now and in the response event.
    logged = history.length;
    if (!out.models_returned.includes(m.model)) out.models_returned.push(m.model);
    out.api_retries += r.attempts - 1;
    out.stop_reason = m.stop_reason;
    const u: Usage = m.usage;
    out.usage.input += u.input_tokens;
    out.usage.cache_write += u.cache_creation_input_tokens ?? 0;
    out.usage.cache_read += u.cache_read_input_tokens ?? 0;
    out.usage.output += u.output_tokens;
    // Usage that cannot be priced counts as the whole cost cap, so the trial stops.
    out.cost_usd += priced ?? caps.maxCostUsd;
    emit({ type: 'usage', turn, total: { ...out.usage }, cost_usd: out.cost_usd });

    if (r.refusal) {
      out.refusal_category = r.refusal.category;
      return end('REFUSAL', null);
    }
    const uses = m.content.filter((b): b is ToolUse & typeof b => b.type === 'tool_use');
    const truncated = m.stop_reason === 'max_tokens';
    maxTokensInARow = truncated ? maxTokensInARow + 1 : 0;
    if (maxTokensInARow >= 2) return end('LIMIT', { type: 'limit', limit: 'max_tokens', cap: 1, value: maxTokensInARow - 1 });
    if (uses.length === 0 && !truncated) return end('COMPLETED', null, 'end_turn');

    const blocks: object[] = [];
    let finished = false;
    for (const use of uses) {
      emit({ type: 'tool_call', turn, tool_use_id: use.id, name: use.name, input: use.input });
      if (finished) {
        emit({ type: 'tool_result', turn, tool_use_id: use.id, name: use.name, executed: false, is_error: true, error_code: FINISHED.error.code, content: FINISHED, exposed_ids: [], referenced_ids: [] });
        continue;
      }
      out.tool_calls++;
      let res: ToolResult;
      try {
        res = callTool(tools, use.name, use.input, ctx);
      } catch (e) {
        const body = internalError(e);
        out.tool_errors.INTERNAL++;
        emit({ type: 'tool_result', turn, tool_use_id: use.id, name: use.name, executed: true, is_error: true, error_code: 'INTERNAL', content: body, exposed_ids: [], referenced_ids: [] });
        return end('ENV_ERROR', { type: 'error', status: 'ENV_ERROR', code: 'INTERNAL', message: body.error.message });
      }
      const code = res.is_error ? ((res.content as { error?: { code?: ErrorCode } }).error?.code ?? null) : null;
      if (code !== null) out.tool_errors[code]++;
      emit({
        type: 'tool_result', turn, tool_use_id: use.id, name: use.name, executed: true, is_error: res.is_error, error_code: code, content: res.content,
        exposed_ids: res.exposed_ids, referenced_ids: res.referenced_ids, ...(res.written_ids ? { written_ids: res.written_ids } : {}),
      });
      if (res.written_ids) emit({ type: 'state_hash', turn, at: 'write', hash: await input.stateHash(), tool_use_id: use.id });
      blocks.push(toolResultBlock(use.id, res));
      if (use.name === 'finish' && !res.is_error) finished = true;
    }
    if (finished) return end('COMPLETED', null, 'finish');
    if (truncated) blocks.push({ type: 'text', text: CONTINUE });
    history.push({ role: 'user', content: blocks as MessageParam['content'] });
  }
}
