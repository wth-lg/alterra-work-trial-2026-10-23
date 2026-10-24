// Trial events (design section 6, "Trajectory format"): the only way run() reports progress.
// A trial's trajectory JSONL is exactly its event sequence, one JSON.stringify(event) per line,
// so the CLI file, the Worker's postMessage stream and the local runner's SSE stream carry the
// same records. Request events hold the request body's delta, never headers.
//
// Every event carries the schema version v, its 0-based position seq and ts, the injected wall
// clock as an ISO instant; ts is the only field that differs between two runs of the same
// mocked trial. turn is the request the event belongs to (0 before the first request). The
// event that ends a trial, limit, error or cancelled, comes after the final hashes, and graded,
// which carries the trial's record with its grade, comes last for every outcome (plan phase
// P8). Version 2 added graded; a version 1 trajectory (P7, no graded line) still parses and
// reads as ungraded.
import type { ContentBlock, MessageParam, MessageParams } from './anthropic.ts';
import type { Usage } from './cost.ts';
import type { TrialRecord } from './run.ts';

export const EVENT_SCHEMA_VERSION = 2;
export const EVENT_SCHEMA_VERSIONS = [1, EVENT_SCHEMA_VERSION] as const;

export const TRIAL_STATUSES = ['COMPLETED', 'REFUSAL', 'LIMIT', 'CANCELLED', 'ENV_ERROR', 'INFRA_API', 'INFRA_HARNESS', 'INVALID'] as const;
export type TrialStatus = (typeof TRIAL_STATUSES)[number];
export const ERROR_STATUSES = ['ENV_ERROR', 'INFRA_API', 'INFRA_HARNESS', 'INVALID'] as const;
export type ErrorStatus = (typeof ERROR_STATUSES)[number];
export const LIMITS = ['turns', 'cost', 'wall_clock', 'max_tokens'] as const;
export type Limit = (typeof LIMITS)[number];
export const HASH_POINTS = ['initial', 'write', 'final', 'replay_final'] as const;

interface Base {
  v: (typeof EVENT_SCHEMA_VERSIONS)[number];
  seq: number;
  ts: string;
  turn: number;
}

// The messages appended since the last request, from index messages_from; params on the first
// request only, since they do not change within a trial.
export interface RequestEvent extends Base {
  type: 'request';
  messages_from: number;
  messages: MessageParam[];
  params?: MessageParams;
}
export interface ResponseEvent extends Base {
  type: 'response';
  id: string;
  model: string;
  stop_reason: string | null;
  stop_details: Record<string, unknown> | null;
  content: ContentBlock[];
  usage: Usage;
  attempts: number;
  // null when the usage cannot be priced.
  cost_usd: number | null;
}
// Totals so far, after each response.
export interface UsageEvent extends Base {
  type: 'usage';
  total: { input: number; cache_write: number; cache_read: number; output: number };
  cost_usd: number;
}
export interface ToolCallEvent extends Base {
  type: 'tool_call';
  tool_use_id: string;
  name: string;
  input: unknown;
}
// executed false: the call came after finish in the same turn and did not run.
export interface ToolResultEvent extends Base {
  type: 'tool_result';
  tool_use_id: string;
  name: string;
  executed: boolean;
  is_error: boolean;
  error_code: string | null;
  content: unknown;
  exposed_ids: string[];
  referenced_ids: string[];
  written_ids?: string[];
}
export interface StateHashEvent extends Base {
  type: 'state_hash';
  at: (typeof HASH_POINTS)[number];
  hash: string;
  tool_use_id?: string;
}
export interface LimitEvent extends Base {
  type: 'limit';
  limit: Limit;
  cap: number;
  value: number;
}
export interface ErrorEvent extends Base {
  type: 'error';
  status: ErrorStatus;
  code: string;
  message: string;
}
export interface CancelledEvent extends Base {
  type: 'cancelled';
  reason: string;
}
// The trial's record, grade included, exactly as run() returns it.
export interface GradedEvent extends Base {
  type: 'graded';
  record: TrialRecord;
}

export type TrialEvent =
  | RequestEvent | ResponseEvent | UsageEvent | ToolCallEvent | ToolResultEvent | StateHashEvent | LimitEvent | ErrorEvent | CancelledEvent | GradedEvent;

// The event that ended the trial's episode: the last one before graded (the last event of an
// ungraded trajectory); undefined for an empty one.
export const terminalEvent = (events: readonly TrialEvent[]): TrialEvent | undefined => events.findLast((e) => e.type !== 'graded');

// An event before the emitter stamps it.
type Unstamped<E> = E extends TrialEvent ? Omit<E, 'v' | 'seq' | 'ts'> : never;
export type EventBody = Unstamped<TrialEvent>;

// Stamps each body with v, seq and ts from the injected clock, keeps it, and hands it to onEvent.
export function createEmitter(now: () => number, onEvent: (e: TrialEvent) => void = () => {}) {
  const events: TrialEvent[] = [];
  const emit = (body: EventBody): TrialEvent => {
    const e = { v: EVENT_SCHEMA_VERSION, seq: events.length, ts: new Date(now()).toISOString(), ...body } as TrialEvent;
    events.push(e);
    onEvent(e);
    return e;
  };
  return { emit, events: events as readonly TrialEvent[] };
}

// Validation. Each check names the field it refuses.
type Check = (v: unknown) => boolean;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str: Check = (v) => typeof v === 'string';
const nat: Check = (v) => Number.isSafeInteger(v) && (v as number) >= 0;
const num: Check = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const bool: Check = (v) => typeof v === 'boolean';
const any: Check = () => true;
const nullable = (c: Check): Check => (v) => v === null || c(v);
const optional = (c: Check): Check => (v) => v === undefined || c(v);
const oneOf = (xs: readonly string[]): Check => (v) => typeof v === 'string' && xs.includes(v);
const arrayOf = (c: Check): Check => (v) => Array.isArray(v) && v.every(c);
const sha256: Check = (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const block: Check = (v) => isObj(v) && typeof v.type === 'string';
const message: Check = (v) => isObj(v) && (v.role === 'user' || v.role === 'assistant') && (typeof v.content === 'string' || arrayOf(block)(v.content));
const usage: Check = (v) => isObj(v) && nat(v.input_tokens) && nat(v.output_tokens);
const totals: Check = (v) => isObj(v) && ['input', 'cache_write', 'cache_read', 'output'].every((k) => num(v[k])) && Object.keys(v).length === 4;

const BASE: Record<string, Check> = { v: (v) => (EVENT_SCHEMA_VERSIONS as readonly unknown[]).includes(v), seq: nat, ts: str, turn: nat, type: str };
const FIELDS: Record<TrialEvent['type'], Record<string, Check>> = {
  request: { messages_from: nat, messages: arrayOf(message), params: optional(isObj) },
  response: {
    id: str, model: str, stop_reason: nullable(str), stop_details: nullable(isObj), content: arrayOf(block), usage, attempts: (v) => nat(v) && (v as number) >= 1, cost_usd: nullable(num),
  },
  usage: { total: totals, cost_usd: num },
  tool_call: { tool_use_id: str, name: str, input: any },
  tool_result: {
    tool_use_id: str, name: str, executed: bool, is_error: bool, error_code: nullable(str), content: any,
    exposed_ids: arrayOf(str), referenced_ids: arrayOf(str), written_ids: optional(arrayOf(str)),
  },
  state_hash: { at: oneOf(HASH_POINTS), hash: sha256, tool_use_id: optional(str) },
  limit: { limit: oneOf(LIMITS), cap: num, value: num },
  error: { status: oneOf(ERROR_STATUSES), code: str, message: str },
  cancelled: { reason: str },
  // Only in version 2; the record is run()'s, checked for the fields a reader needs first.
  graded: {
    v: (v) => v === EVENT_SCHEMA_VERSION,
    record: (v) => isObj(v) && str(v.trial_id) && str(v.outcome) && bool(v.valid) && Array.isArray(v.checks) && num(v.cost_usd) && nat(v.turns),
  },
};

// Returns x as a TrialEvent, or throws naming the first field that does not fit the schema.
// Unknown fields are refused, so a header or a key can never ride along in an event.
export function parseEvent(x: unknown): TrialEvent {
  if (!isObj(x)) throw new Error('not a trial event: not an object');
  const fields = FIELDS[x.type as TrialEvent['type']];
  if (!Object.hasOwn(FIELDS, x.type as string) || fields === undefined) throw new Error(`not a trial event: unknown type ${JSON.stringify(x.type)}`);
  const schema = { ...BASE, ...fields };
  for (const [k, check] of Object.entries(schema)) {
    if (!check(x[k])) throw new Error(`not a ${x.type} event: bad ${k} ${JSON.stringify(x[k])}`);
  }
  for (const k of Object.keys(x)) if (!Object.hasOwn(schema, k)) throw new Error(`not a ${x.type} event: unknown field ${k}`);
  return x as unknown as TrialEvent;
}
