// Judge and hybrid extraction (design section 5, "Judge and hybrid items"), rubric only.
//
// Judge: one isolated call per criterion, claude-opus-5-5 at effort low, through the trial's
// MessagesClient, so every call is metered by the ledger under the trial's grant. No sampling
// parameter is sent (the client refuses one), and tool_choice is not forced (a 400 on this
// model): the answer is JSON text, {verdict: met | not_met | unknown, quote}, retried once when
// it does not parse. Code then checks the quote: a non-empty quote must be a substring of the
// graded text, and met needs one; otherwise the item is unknown. An unknown item leaves both the
// numerator and the denominator of the score and is counted. The judge sees the criterion and
// the text only, never the gate result or the reference.
//
// Hybrid: a regex extracts the value first; when it finds none, the LLM extractor answers
// {value, quote} under the same quote check, and the quote must state the value.
//
// Cache: every answer (or the error in its place) is kept under sha256 of (model, effort, prompt
// version, prompt, graded text), and the entries go into the trial record, so a regrade from
// them is byte-identical and free. With a cache and no client (regrade, replay), a miss is an
// error: JudgeCacheMiss. With neither, judge and hybrid-fallback items are unknown.
import { MODEL, reserveRequest, type CallResult, type MessageParam, type MessageParams, type SendOptions } from '../core/anthropic.ts';
import { worstCaseUsd } from '../core/cost.ts';
import type { Check, Json, Verdict } from './check.ts';
import { canonicalNumber } from './normalize.ts';

export const JUDGE_EFFORT = 'low';
export const JUDGE_PROMPT_VERSION = 'judge-v1';
export const JUDGE_MAX_TOKENS = 1024;
// A request body over this many bytes is not sent: the item is unknown. It bounds the worst
// case a judge call can cost, which the projection allowance below is built from.
export const JUDGE_MAX_BODY_BYTES = 64_000;

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
  // The parsed answer; null when there is none (invalid twice, or an error).
  answer: { [k: string]: Json } | null;
  error: string | null;
}

export class JudgeCacheMiss extends Error {
  constructor(key: string) {
    super(`judge cache miss ${key}: a regrade or replay never calls the judge`);
    this.name = 'JudgeCacheMiss';
  }
}

const PARAMS: MessageParams = { max_tokens: JUDGE_MAX_TOKENS, output_config: { effort: JUDGE_EFFORT } };

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
}

export class Judge {
  readonly #client: JudgeClient | null;
  readonly #cache: Map<string, JudgeCacheEntry>;
  readonly #regrade: boolean;
  // The entries this grading used, in order of first use.
  readonly #used = new Map<string, JudgeCacheEntry>();
  #cost = 0;
  #asked = 0;

  constructor(opts: JudgeOptions = {}) {
    this.#client = opts.client ?? null;
    this.#cache = new Map((opts.cache ?? []).map((e) => [e.key, e]));
    this.#regrade = this.#client === null && opts.cache !== undefined;
  }

  // What the live calls cost, as the ledger settled them.
  get costUsd(): number {
    return this.#cost;
  }

  // Questions answered by the judge or the extractor, live or from the cache.
  get asked(): number {
    return this.#asked;
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
  // neither a client nor a cache. A live answer that fails `valid` is asked once more.
  async #ask(kind: JudgeCacheEntry['kind'], prompt: string, text: string, valid: (a: { [k: string]: Json }) => boolean): Promise<{ entry: JudgeCacheEntry } | null> {
    const key = await sha256Hex(JSON.stringify([MODEL, JUDGE_EFFORT, JUDGE_PROMPT_VERSION, prompt, text]));
    const cached = this.#used.get(key) ?? this.#cache.get(key);
    if (cached === undefined && this.#regrade) throw new JudgeCacheMiss(key);
    if (cached === undefined && this.#client === null) return null;
    this.#asked++;
    let entry = cached;
    if (entry === undefined) {
      const base = { key, kind, model: MODEL, effort: JUDGE_EFFORT, prompt_version: JUDGE_PROMPT_VERSION };
      entry = { ...base, answer: null, error: null };
      const history: MessageParam[] = [{ role: 'user', content: prompt }];
      if (reserveRequest(history, PARAMS).bodyBytes > JUDGE_MAX_BODY_BYTES) entry = { ...base, answer: null, error: `text over the judge's ${JUDGE_MAX_BODY_BYTES}-byte cap` };
      else {
        try {
          for (let attempt = 1; attempt <= 2; attempt++) {
            const result = await this.#client!.send([...history], PARAMS, { onSettle: (usd) => (this.#cost += usd) });
            const answer = result.refusal === null ? parseAnswer(result) : null;
            if (answer !== null && valid(answer)) {
              entry = { ...base, answer, error: null };
              break;
            }
          }
          if (entry.answer === null) entry = { ...base, answer: null, error: 'invalid judge output' };
        } catch (e) {
          entry = { ...base, answer: null, error: `judge error: ${(e as Error).message}` };
        }
      }
    }
    this.#used.set(key, entry);
    return { entry };
  }
}

// The projection allowance for a trial's judge and hybrid items: each may make two calls (the
// schema retry), each at most a JUDGE_MAX_BODY_BYTES request with JUDGE_MAX_TOKENS of output.
export function judgeAllowanceUsd(checks: readonly Check[]): number {
  const items = checks.filter((c) => c.kind === 'rubric' && c.method !== 'code').length;
  return items * 2 * worstCaseUsd({ bodyBytes: JUDGE_MAX_BODY_BYTES, maxTokens: JUDGE_MAX_TOKENS });
}
