// The one raw Messages client, for the browser and Node: fetch, SSE streaming, retries,
// refusal and model checks. It is the only file that names the API host (lint:
// no-direct-anthropic). A client is built only from a live BatchGrant (assertClientGrant), and
// every attempt reserves its worst case under the ledger lock before fetch and settles after:
//   HTTP error status        settled at $0: the API bills no error response
//   complete stream          settled at its usage
//   dropped or errored stream, network error after send
//                            settled at the worst case: usage is unknown, and the partial
//                            answer is discarded, never appended to the conversation
// Retried: 429, 5xx (529 included), an error event mid-stream, a dropped stream, a network
// error; up to MAX_ATTEMPTS, waiting retry-after or an exponential backoff. A 400 or any
// other 4xx closes the grant, which stops every client of the batch. Headers are never
// logged, and the key is redacted from every log line and error message.
import type { Usage } from './cost.ts';
import { assertClientGrant, type BatchGrant, type Ledger } from './ledger.ts';
import { redactText } from './redact.ts';

export const API_ORIGIN = 'https://api.anthropic.com';
export const MESSAGES_URL = `${API_ORIGIN}/v1/messages`;
export const ANTHROPIC_VERSION = '2026-10-21';
export const MODEL = 'claude-opus-5-5';
export const MAX_ATTEMPTS = 4;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
const RETRY_AFTER_MAX_MS = 60_000;

export interface ContentBlock {
  type: string;
  [k: string]: unknown;
}
export interface MessageParam {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}
export interface MessageParams {
  max_tokens: number;
  system?: string | ContentBlock[];
  tools?: Array<Record<string, unknown>>;
  tool_choice?: { type: 'auto' | 'none'; disable_parallel_tool_use?: boolean };
  cache_control?: { type: 'ephemeral'; ttl?: '5m' };
  output_config?: Record<string, unknown>;
  thinking?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  stop_sequences?: string[];
}
export interface Message {
  id: string;
  model: string;
  role: 'assistant';
  content: ContentBlock[];
  stop_reason: string | null;
  stop_details?: { type?: string; category?: string | null; explanation?: string | null } | null;
  usage: Usage;
}

export interface ApiErrorInfo {
  status: number | null;
  type: string | null;
  retryable: boolean;
  stopsBatch: boolean;
  // The response had started streaming, or the request may have reached the API: usage unknown.
  partial?: boolean;
  // The retry-after header of an HTTP error, in seconds.
  retryAfter?: number | null;
}

export class ApiError extends Error {
  override readonly name = 'ApiError';
  readonly status: number | null;
  readonly errorType: string | null;
  readonly retryable: boolean;
  readonly stopsBatch: boolean;
  readonly partial: boolean;
  readonly retryAfter: number | null;
  constructor(message: string, info: ApiErrorInfo) {
    super(message);
    this.status = info.status;
    this.errorType = info.type;
    this.retryable = info.retryable;
    this.stopsBatch = info.stopsBatch;
    this.partial = info.partial ?? false;
    this.retryAfter = info.retryAfter ?? null;
  }
}

// Request rules, checked before any reserve or fetch. Sampling params, server fallbacks,
// forced tool_choice and prefill are 400s on this model and API version or banned by the
// plan; only 5-minute cache_control is allowed, since the cost model reserves for it.
const ALLOWED = new Set(['max_tokens', 'system', 'tools', 'tool_choice', 'cache_control', 'output_config', 'thinking', 'metadata', 'stop_sequences']);
const BANNED: Record<string, string> = {
  temperature: 'temperature is a 400 on API version 2026-10-21',
  top_p: 'top_p is a 400 on API version 2026-10-21',
  top_k: 'top_k is a 400 on API version 2026-10-21',
  fallbacks: 'server-side fallbacks are not used: a refusal is recorded, never rerouted',
  model: `the client pins model ${MODEL}`,
  messages: 'pass the conversation as the history argument',
  stream: 'the client always streams',
};

function checkCacheTtl(v: unknown, path: string): void {
  if (Array.isArray(v)) v.forEach((x, i) => checkCacheTtl(x, `${path}[${i}]`));
  else if (typeof v === 'object' && v !== null) {
    for (const [k, x] of Object.entries(v)) {
      if (k === 'cache_control' && typeof x === 'object' && x !== null && 'ttl' in x && x.ttl !== '5m') {
        throw new TypeError(`${path}.cache_control.ttl ${JSON.stringify(x.ttl)}: only the 5-minute cache is allowed`);
      }
      checkCacheTtl(x, `${path}.${k}`);
    }
  }
}

export function checkRequest(history: readonly MessageParam[], params: MessageParams): void {
  for (const k of Object.keys(params)) {
    if (k in BANNED) throw new TypeError(`request rejected: ${BANNED[k]}`);
    if (!ALLOWED.has(k)) throw new TypeError(`request rejected: unknown parameter ${k}`);
  }
  const choice = params.tool_choice?.type;
  if (choice !== undefined && choice !== 'auto' && choice !== 'none') throw new TypeError(`request rejected: forced tool_choice ${choice} is a 400 on ${MODEL}`);
  if (history.length === 0 || history[0]?.role !== 'user') throw new TypeError('request rejected: the conversation must start with a user turn');
  if (history.at(-1)?.role === 'assistant') throw new TypeError(`request rejected: a prefill (history ending in an assistant turn) is a 400 on ${MODEL}`);
  checkCacheTtl(params, 'params');
  checkCacheTtl(history, 'messages');
}

export function requestBody(history: readonly MessageParam[], params: MessageParams): string {
  return JSON.stringify({ model: MODEL, ...params, messages: history, stream: true });
}

export function requestHeaders(apiKey: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
    'anthropic-dangerous-direct-browser-access': 'true',
  };
}

const retryableStatus = (s: number) => s === 429 || s >= 500;
const broken = (message: string, type: string | null = null, retryable = true) =>
  new ApiError(message, { status: 200, type, retryable, stopsBatch: false, partial: true });
const retryableStreamError = (type: string | null) => type === 'overloaded_error' || type === 'api_error' || type === 'rate_limit_error';

async function errorStatus(res: Response): Promise<ApiError> {
  let type: string | null = null;
  let detail = '';
  try {
    const j = (await res.json()) as { error?: { type?: string; message?: string } };
    type = j.error?.type ?? null;
    detail = j.error?.message ?? '';
  } catch {
    // a body that is not JSON: the status says enough
  }
  const retryable = retryableStatus(res.status);
  const after = Number(res.headers.get('retry-after') ?? NaN);
  return new ApiError(`HTTP ${res.status}${type ? ` ${type}` : ''}${detail ? `: ${detail}` : ''}`, {
    status: res.status, type, retryable, stopsBatch: !retryable, retryAfter: Number.isFinite(after) && after >= 0 ? after : null,
  });
}

// Folds SSE events into the final message. Throws ApiError(partial) on an error event or a
// stream that ends before message_stop.
async function readStream(body: ReadableStream<Uint8Array>): Promise<Message> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const st: { message: Message | null } = { message: null };
  const json = new Map<number, string>();
  const apply = (e: Record<string, unknown>): boolean => {
    switch (e.type) {
      case 'message_start':
        st.message = { ...(e.message as Message), content: [] };
        return false;
      case 'content_block_start':
        if (st.message) st.message.content[e.index as number] = { ...(e.content_block as ContentBlock) };
        return false;
      case 'content_block_delta': {
        const block = st.message?.content[e.index as number];
        const d = e.delta as Record<string, string>;
        if (!block) return false;
        if (d.type === 'text_delta') block.text = `${block.text ?? ''}${d.text}`;
        else if (d.type === 'input_json_delta') json.set(e.index as number, `${json.get(e.index as number) ?? ''}${d.partial_json}`);
        else if (d.type === 'thinking_delta') block.thinking = `${block.thinking ?? ''}${d.thinking}`;
        else if (d.type === 'signature_delta') block.signature = d.signature;
        else if (d.type === 'citations_delta') block.citations = [...((block.citations as unknown[]) ?? []), (d as unknown as { citation: unknown }).citation];
        return false;
      }
      case 'content_block_stop': {
        const raw = json.get(e.index as number);
        const block = st.message?.content[e.index as number];
        if (block && raw !== undefined) {
          try {
            block.input = raw === '' ? {} : JSON.parse(raw);
          } catch {
            throw broken('tool_use input is not valid JSON', 'invalid_tool_input', false);
          }
        }
        return false;
      }
      case 'message_delta':
        if (st.message) {
          const m = st.message;
          const d = e.delta as Partial<Message>;
          m.stop_reason = d.stop_reason ?? m.stop_reason;
          if (d.stop_details !== undefined) m.stop_details = d.stop_details;
          m.usage = { ...m.usage, ...(e.usage as Partial<Usage>) };
        }
        return false;
      case 'message_stop':
        return true;
      case 'error': {
        const err = e.error as { type?: string; message?: string } | undefined;
        const type = err?.type ?? null;
        throw broken(`stream error ${type ?? 'unknown'}${err?.message ? `: ${err.message}` : ''}`, type, retryableStreamError(type));
      }
      default:
        return false; // ping and event types this client does not use
    }
  };
  for (;;) {
    let chunk;
    try {
      chunk = await reader.read();
    } catch (e) {
      throw broken(`stream dropped: ${(e as Error).message}`);
    }
    if (chunk.done) break;
    buf += decoder.decode(chunk.value, { stream: true });
    let cut;
    while ((cut = buf.search(/\r?\n\r?\n/)) >= 0) {
      const frame = buf.slice(0, cut);
      buf = buf.slice(cut).replace(/^\r?\n\r?\n/, '');
      const data = frame.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
      if (data === '') continue;
      if (apply(JSON.parse(data) as Record<string, unknown>)) {
        void reader.cancel().catch(() => {});
        if (st.message === null) throw broken('stream ended without message_start');
        return st.message;
      }
    }
  }
  throw broken('stream dropped before message_stop');
}

// One request, no ledger: an ApiError for an HTTP error or a broken stream, the fetch error
// as thrown for a network failure. MessagesClient and probeOnce are its only callers.
async function sendOnce(f: typeof fetch, apiKey: string, body: string, signal?: AbortSignal): Promise<{ status: number; message: Message }> {
  const res = await f(MESSAGES_URL, { method: 'POST', headers: requestHeaders(apiKey), body, ...(signal ? { signal } : {}) });
  if (res.status !== 200) throw await errorStatus(res);
  if (!res.body) throw broken('HTTP 200 without a body');
  return { status: res.status, message: await readStream(res.body) };
}

export interface ProbeResult {
  status: number | null;
  model: string | null;
  stop_reason: string | null;
  tool_use: ContentBlock | null;
  usage: Usage | null;
  error: { name: string; message: string; type: string | null } | null;
}

// One unmetered attempt, for the real-browser probe page only (lint: no-direct-anthropic
// allows its import in apps/web/src/probe/** and tests). Its caller's Node side reserves the
// worst case before and settles after, so the probe never sends without a reservation.
export async function probeOnce(opts: { apiKey: string; history: MessageParam[]; params: MessageParams; fetch?: typeof fetch }): Promise<ProbeResult> {
  checkRequest(opts.history, opts.params);
  const none = { status: null, model: null, stop_reason: null, tool_use: null, usage: null };
  try {
    const { status, message } = await sendOnce(opts.fetch ?? fetch, opts.apiKey, requestBody(opts.history, opts.params));
    const tool_use = message.content.find((b) => b.type === 'tool_use') ?? null;
    return { status, model: message.model, stop_reason: message.stop_reason, tool_use, usage: message.usage, error: null };
  } catch (e) {
    const err = e as Error;
    const status = e instanceof ApiError ? e.status : null;
    const type = e instanceof ApiError ? e.errorType : null;
    return { ...none, status, error: { name: err.name, message: redactText(err.message, [opts.apiKey]), type } };
  }
}

export interface ClientOptions {
  grant: BatchGrant;
  ledger: Ledger;
  apiKey: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  // One line per attempt and outcome; never headers, never the key.
  log?: (line: string) => void;
  trial?: string;
}

export interface CallResult {
  status: number;
  message: Message;
  refusal: { category: string | null; explanation: string | null } | null;
  attempts: number;
}

export class MessagesClient {
  readonly #grant: BatchGrant;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #log: (line: string) => void;
  readonly #trial: string | undefined;

  constructor(opts: ClientOptions) {
    assertClientGrant(opts.grant, opts.ledger);
    this.#grant = opts.grant;
    this.#apiKey = opts.apiKey;
    this.#fetch = opts.fetch ?? ((input, init) => fetch(input, init));
    this.#sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#log = (line) => opts.log?.(redactText(line, [opts.apiKey]));
    this.#trial = opts.trial;
  }

  // Sends history + params and, on a complete answer that is not a refusal, appends it to
  // history. Anything else leaves history as it was.
  async send(history: MessageParam[], params: MessageParams): Promise<CallResult> {
    checkRequest(history, params);
    const body = requestBody(history, params);
    const req = { bodyBytes: new TextEncoder().encode(body).length, maxTokens: params.max_tokens, ...(this.#trial ? { trial: this.#trial } : {}) };
    for (let attempt = 1; ; attempt++) {
      const res = await this.#grant.reserve(req);
      let out: { status: number; message: Message };
      try {
        out = await sendOnce(this.#fetch, this.#apiKey, body, this.#grant.signal);
      } catch (e) {
        const known = e instanceof ApiError;
        // An HTTP error status is not billed; a broken stream or lost connection may be.
        await this.#grant.settle(res, known && !e.partial ? { input_tokens: 0, output_tokens: 0 } : null);
        const err = known ? e : this.#grant.signal.aborted ? (e as Error) : new ApiError(`network error: ${(e as Error).message}`, { status: null, type: null, retryable: true, stopsBatch: false, partial: true });
        err.message = redactText(err.message, [this.#apiKey]);
        if (err.stack) err.stack = redactText(err.stack, [this.#apiKey]);
        this.#log(`attempt ${attempt}: ${err.message}`);
        if (err instanceof ApiError && err.stopsBatch) {
          await this.#grant.close();
          throw err;
        }
        if (!(err instanceof ApiError) || !err.retryable || attempt >= MAX_ATTEMPTS) throw err;
        await this.#sleep(err.retryAfter !== null ? Math.min(err.retryAfter * 1000, RETRY_AFTER_MAX_MS) : Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_MAX_MS));
        continue;
      }
      await this.#grant.settle(res, out.message.usage);
      const { message } = out;
      if (message.model !== MODEL) {
        this.#log(`attempt ${attempt}: response model ${message.model} is not ${MODEL}`);
        await this.#grant.close();
        throw new ApiError(`response model ${message.model} is not ${MODEL}`, { status: out.status, type: 'model_mismatch', retryable: false, stopsBatch: true });
      }
      if (message.stop_reason === 'refusal') {
        const refusal = { category: message.stop_details?.category ?? null, explanation: message.stop_details?.explanation ?? null };
        this.#log(`attempt ${attempt}: refusal ${refusal.category ?? 'uncategorized'}`);
        return { status: out.status, message, refusal, attempts: attempt };
      }
      this.#log(`attempt ${attempt}: ${out.status} ${message.stop_reason}`);
      history.push({ role: 'assistant', content: message.content });
      return { status: out.status, message, refusal: null, attempts: attempt };
    }
  }
}
