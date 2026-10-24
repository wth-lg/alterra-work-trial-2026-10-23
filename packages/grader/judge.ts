// Judge and hybrid extraction (design section 5, "Judge and hybrid items"), rubric only.
//
// Judge: one isolated call per criterion, claude-opus-5-5 at the task's judge effort (task.toml
// [judge] effort: low, medium or high, default medium), through the trial's
// MessagesClient, so every call is metered by the ledger under the trial's grant. No sampling
// parameter is sent (the client refuses one), and tool_choice is not forced (a 400 on this
// model): the answer is JSON text, {verdict: met | not_met | unknown, quote}, retried once when
// it does not parse. Code then checks the quote: a met verdict needs a quote, and any non-empty
// quote must be a substring of the graded text; otherwise the item is unknown. A not_met
// verdict may carry an empty quote, because absence cannot be quoted (coordinator decision,
// 2026-10-23): it stays met: false and counts in the denominator. An unknown item leaves both
// the numerator and the denominator of the score and is counted. The judge sees the criterion
// and the text only, never the gate result or the reference.
//
// Hybrid: a regex extracts the value first; when it finds none, the LLM extractor answers
// {value, quote} under the same quote check, and the quote must state the value.
//
// Failures: a client error (401, 403, a billing 400, retries exhausted, a substituted model, a
// spend refusal, any error that stops the batch) is not an answer. It is thrown as
// JudgeClientError, never cached, and the grader ends the trial with the outcome
// classifyFailure gives it, the same as for a model call in the trial loop (INFRA_API for a
// 401, 403, 404, billing error or retries exhausted). Only a response that
// parsed (or failed to parse twice) is cached as an answer or an unknown.
//
// Allowance: a trial's judge calls are bounded by its projection, two calls (the schema retry)
// per judge and hybrid item, counted per call, whichever item makes them (a code item that asks
// ctx.judge included). Past the bound a question is not sent: it is unknown, marked 'judge
// allowance reached' in the record. Each call's worst case (its real body plus JUDGE_MAX_TOKENS
// of output) must stay within JUDGE_MAX_CALL_USD, $1, or it is not sent: unknown, marked
// OVER_BUDGET. judgeAllowanceUsd prices each call at that ceiling, the upper bound for when the
// graded text is not known yet (a dry run); perCallGrantClient opens each call's grant at its
// real request's worst case.
//
// Cache: every answer is kept under sha256 of (model, effort, prompt version, prompt, graded
// text), with the calls it took, and the entries go into the trial record, so a regrade from
// them is byte-identical and free. A task's canned cache (tests/judge-cache.json) also says where
// each answer came from: provenance {source: live | scripted, model, at}. With a cache and no client (regrade, replay), a miss is an
// error: JudgeCacheMiss. With neither, judge and hybrid-fallback items are unknown.
import { classifyFailure, MODEL, reserveRequest, type CallResult, type ClientFailure, type MessageParam, type MessageParams, type SendOptions } from '../core/anthropic.ts';
import { worstCaseUsd } from '../core/cost.ts';
import type { BatchGrant, Ledger } from '../core/ledger.ts';
import { DEFAULT_JUDGE_EFFORT, type JudgeEffort } from '../core/tasks.ts';
import type { Check, Json, Verdict } from './check.ts';
import { canonicalNumber } from './normalize.ts';

export { DEFAULT_JUDGE_EFFORT, type JudgeEffort };
export const JUDGE_PROMPT_VERSION = 'judge-v1';
export const JUDGE_MAX_TOKENS = 16_000;
// The most one judge call may cost at worst (its real request body plus JUDGE_MAX_TOKENS of
// output). A request over it is not sent: the item is unknown, marked OVER_BUDGET. It bounds
// the projection allowance below.
export const JUDGE_MAX_CALL_USD = 1;
export const OVER_BUDGET = 'judge call over budget';
// Calls each judge or hybrid item may make: the first and the schema retry.
export const JUDGE_CALLS_PER_ITEM = 2;
export const ALLOWANCE_REACHED = 'judge allowance reached';

// The part of MessagesClient the judge uses (the loop's TrialClient).
export interface JudgeClient {
  send(history: MessageParam[], params: MessageParams, opts?: SendOptions): Promise<CallResult>;
}

export interface JudgeQuestion {
  criterion: string;
  text: string;
}

export interface ExtractQuestion {
  // What to extract, e.g. 'CrCl in mL/min'.
  field: string;
  text: string;
  // Its first capture group is the value.
  pattern: RegExp;
}

export interface Extraction {
  [k: string]: Json;
  // null: the text does not state it; 'unknown': an answer the code could not verify.
  value: number | null | 'unknown';
  quote: string;
  source: 'regex' | 'llm' | 'none';
}

export interface JudgeCacheEntry {
  key: string;
  kind: 'judge' | 'extract';
  model: string;
  effort: string;
  prompt_version: string;
  // The parsed answer; null when there is none (invalid twice, over the size cap or the
  // allowance).
  answer: { [k: string]: Json } | null;
  error: string | null;
  // The API calls the answer took: 0, 1 or 2 (0 for a scripted answer).
  calls: number;
  // Where a canned answer came from; set when a task's cache file is written.
  provenance?: JudgeProvenance;
}

export interface JudgeProvenance {
  [k: string]: Json;
  // live: the judge model answered it (oracle --live-judge); scripted: a script wrote it.
  source: 'live' | 'scripted';
  // The model that answered, or what wrote a scripted answer.
  model: string;
  // When, as an ISO 8601 time.
  at: string;
}

// A judge or extractor call the client failed: infrastructure, not an answer.
export class JudgeClientError extends Error {
  override readonly name = 'JudgeClientError';
  // How the failure ends the trial, and whether the batch stops.
  readonly failure: ClientFailure;
  constructor(cause: unknown) {
    super(cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause));
    this.failure = classifyFailure(cause);
  }
}

export class JudgeCacheMiss extends Error {
  constructor(key: string) {
    super(`judge cache miss ${key}: a regrade or replay never calls the judge`);
    this.name = 'JudgeCacheMiss';
  }
}

const paramsFor = (effort: JudgeEffort): MessageParams => ({ max_tokens: JUDGE_MAX_TOKENS, output_config: { effort } });

function judgePrompt(q: JudgeQuestion): string {
  return [
    'You grade one criterion against a text written by a clinical operations agent. Decide only whether the text meets the criterion.',
    '',
    `Criterion: ${q.criterion}`,
    '',
    'Text:',
    '<text>',
    q.text,
    '</text>',
    '',
    'Answer with one JSON object and nothing else:',
    '{"verdict": "met" | "not_met" | "unknown", "quote": "<the words of the text that decide the verdict, copied exactly; empty if there are none>"}',
    'Answer "unknown" when the text does not let you decide.',
  ].join('\n');
}

function extractPrompt(q: ExtractQuestion): string {
  return [
    'Read a text written by a clinical operations agent and find the value it states for one quantity.',
    '',
    `Quantity: ${q.field}`,
    '',
    'Text:',
    '<text>',
    q.text,
    '</text>',
    '',
    'Answer with one JSON object and nothing else:',
    '{"value": <the number as stated, or null if the text does not state it>, "quote": "<the words of the text that state it, copied exactly; empty if none>"}',
  ].join('\n');
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

const isObj = (v: unknown): v is { [k: string]: Json } => typeof v === 'object' && v !== null && !Array.isArray(v);

// The JSON object in the answer's text (a ```json fence allowed), or null.
function parseAnswer(result: CallResult): { [k: string]: Json } | null {
  const text = result.message.content.flatMap((b) => (b.type === 'text' && typeof b.text === 'string' ? [b.text] : [])).join('');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try {
    const v: unknown = JSON.parse(text.slice(start, end + 1));
    return isObj(v) ? v : null;
  } catch {
    return null;
  }
}

const validJudge = (a: { [k: string]: Json }) => ['met', 'not_met', 'unknown'].includes(a.verdict as string) && typeof a.quote === 'string';
const validExtract = (a: { [k: string]: Json }) => (a.value === null || (typeof a.value === 'number' && Number.isFinite(a.value))) && typeof a.quote === 'string';

// Whitespace runs count as one space, so a quote that re-wraps a line still matches.
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
const quoted = (quote: string, text: string) => quote.trim() !== '' && squash(text).includes(squash(quote));

// Every number written in the quote.
const numbersIn = (quote: string): number[] => (quote.match(/\d[\d,]*(?:\.\d+)?|\.\d+/g) ?? []).flatMap((s) => {
  const n = canonicalNumber(s);
  return n === null ? [] : [n];
});

export interface JudgeOptions {
  client?: JudgeClient | null;
  cache?: readonly JudgeCacheEntry[];
  // The most live calls this grading may make (judgeCallBudget); unbounded when absent.
  maxCalls?: number;
  // The task's judge effort; default DEFAULT_JUDGE_EFFORT.
  effort?: JudgeEffort;
}

export class Judge {
  readonly #client: JudgeClient | null;
  readonly #cache: Map<string, JudgeCacheEntry>;
  readonly #regrade: boolean;
  // The entries this grading used, in order of first use.
  readonly #used = new Map<string, JudgeCacheEntry>();
  readonly #maxCalls: number;
  readonly #effort: JudgeEffort;
  #cost = 0;
  #live = 0;

  constructor(opts: JudgeOptions = {}) {
    this.#client = opts.client ?? null;
    this.#cache = new Map((opts.cache ?? []).map((e) => [e.key, e]));
    this.#regrade = this.#client === null && opts.cache !== undefined;
    this.#maxCalls = opts.maxCalls ?? Infinity;
    this.#effort = opts.effort ?? DEFAULT_JUDGE_EFFORT;
  }

  // What the live calls cost, as the ledger settled them.
  get costUsd(): number {
    return this.#cost;
  }

  // The API calls behind the answers this grading used, live or from the cache.
  get calls(): number {
    let n = 0;
    for (const e of this.#used.values()) n += e.calls;
    return n;
  }

  // Questions not sent because the allowance was reached.
  get overAllowance(): number {
    return [...this.#used.values()].filter((e) => e.error === ALLOWANCE_REACHED).length;
  }

  entries(): JudgeCacheEntry[] {
    return [...this.#used.values()];
  }

  async judge(q: JudgeQuestion): Promise<Verdict> {
    if (q.text.trim() === '') return { met: false, evidence: { reason: 'no text' } };
    const got = await this.#ask('judge', judgePrompt(q), q.text, validJudge);
    if (got === null) return { met: 'unknown', evidence: { reason: 'no judge' } };
    const { entry } = got;
    if (entry.answer === null) return { met: 'unknown', evidence: { reason: entry.error ?? 'invalid judge output', cache_key: entry.key } };
    const verdict = entry.answer.verdict as 'met' | 'not_met' | 'unknown';
    const quote = entry.answer.quote as string;
    const evidence = { verdict, quote, cache_key: entry.key };
    if (verdict === 'unknown') return { met: 'unknown', evidence: { ...evidence, reason: 'judge unknown' } };
    if ((verdict === 'met' || quote.trim() !== '') && !quoted(quote, q.text)) return { met: 'unknown', evidence: { ...evidence, reason: 'quote not in text' } };
    return { met: verdict === 'met', evidence };
  }

  async extract(q: ExtractQuestion): Promise<Extraction> {
    const re = new RegExp(q.pattern.source, q.pattern.flags.replace(/[gy]/g, ''));
    const m = re.exec(q.text);
    const value = m?.[1] === undefined ? null : canonicalNumber(m[1]);
    if (m && value !== null) return { value, quote: m[0], source: 'regex' };
    if (q.text.trim() === '') return { value: null, quote: '', source: 'none' };
    const got = await this.#ask('extract', extractPrompt(q), q.text, validExtract);
    if (got === null) return { value: 'unknown', quote: '', source: 'none', reason: 'no judge' };
    const { entry } = got;
    if (entry.answer === null) return { value: 'unknown', quote: '', source: 'llm', reason: entry.error ?? 'invalid judge output', cache_key: entry.key };
    const v = entry.answer.value as number | null;
    const quote = entry.answer.quote as string;
    const base = { quote, source: 'llm' as const, cache_key: entry.key };
    if (v === null) return { value: null, ...base };
    if (!quoted(quote, q.text)) return { value: 'unknown', ...base, reason: 'quote not in text' };
    if (!numbersIn(quote).some((n) => n === v)) return { value: 'unknown', ...base, reason: 'value not in quote' };
    return { value: v, ...base };
  }

  // The cached entry for this prompt and text, or a live answer cached now; null when there is
  // neither a client nor a cache. A live answer that fails `valid` is asked once more, within
  // the allowance. A client error is thrown as JudgeClientError and nothing is cached.
  async #ask(kind: JudgeCacheEntry['kind'], prompt: string, text: string, valid: (a: { [k: string]: Json }) => boolean): Promise<{ entry: JudgeCacheEntry } | null> {
    const key = await sha256Hex(JSON.stringify([MODEL, this.#effort, JUDGE_PROMPT_VERSION, prompt, text]));
    const cached = this.#used.get(key) ?? this.#cache.get(key);
    if (cached === undefined && this.#regrade) throw new JudgeCacheMiss(key);
    if (cached === undefined && this.#client === null) return null;
    const entry = cached ?? (await this.#send(key, kind, prompt, valid));
    this.#used.set(key, entry);
    return { entry };
  }

  async #send(key: string, kind: JudgeCacheEntry['kind'], prompt: string, valid: (a: { [k: string]: Json }) => boolean): Promise<JudgeCacheEntry> {
    const base = { key, kind, model: MODEL, effort: this.#effort, prompt_version: JUDGE_PROMPT_VERSION };
    const history: MessageParam[] = [{ role: 'user', content: prompt }];
    const params = paramsFor(this.#effort);
    const worst = worstCaseUsd(reserveRequest(history, params));
    if (worst > JUDGE_MAX_CALL_USD) return { ...base, answer: null, error: `${OVER_BUDGET}: worst case $${worst.toFixed(6)} > $${JUDGE_MAX_CALL_USD.toFixed(2)} per call`, calls: 0 };
    let calls = 0;
    while (calls < JUDGE_CALLS_PER_ITEM && this.#live < this.#maxCalls) {
      this.#live++;
      calls++;
      let result: CallResult;
      try {
        result = await this.#client!.send([...history], params, { onSettle: (usd) => (this.#cost += usd) });
      } catch (e) {
        throw new JudgeClientError(e);
      }
      const answer = result.refusal === null ? parseAnswer(result) : null;
      if (answer !== null && valid(answer)) return { ...base, answer, error: null, calls };
    }
    return { ...base, answer: null, error: calls === 0 ? ALLOWANCE_REACHED : 'invalid judge output', calls };
  }
}

// The judge calls a trial may make: two (the schema retry) per judge and hybrid item. The
// Judge enforces it at run time, whichever item makes the calls.
export const judgeCallBudget = (checks: readonly Check[]): number => JUDGE_CALLS_PER_ITEM * checks.filter((c) => c.kind === 'rubric' && c.method !== 'code').length;

// The projection allowance for a trial's judge calls when their requests are not known yet (a
// dry run): each at the per-call ceiling, JUDGE_MAX_CALL_USD.
export function judgeAllowanceUsd(checks: readonly Check[]): number {
  return judgeCallBudget(checks) * JUDGE_MAX_CALL_USD;
}

// A judge client whose every call runs under its own batch grant, opened at that call's worst
// case from its real request (body bytes and max_tokens, what the client reserves) and closed
// after it. batchStart checks the $450 projected cap right then, and an open grant never holds
// more than the one call it covers. `client` builds the call's MessagesClient on the grant.
export function perCallGrantClient(opts: { ledger: Pick<Ledger, 'batchStart'>; client: (grant: BatchGrant) => JudgeClient; onGrant?: (projection: number) => void }): JudgeClient {
  return {
    async send(history, params, sendOpts) {
      const projection = worstCaseUsd(reserveRequest(history, params));
      const grant = await opts.ledger.batchStart(projection);
      opts.onGrant?.(projection);
      try {
        return await opts.client(grant).send(history, params, sendOpts);
      } finally {
        await grant.close();
      }
    },
  };
}
