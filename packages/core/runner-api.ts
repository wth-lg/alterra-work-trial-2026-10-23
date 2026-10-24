// The local runner's HTTP contract, shared by the runner (P12b extends it) and the web app:
// types, validators and the samples the UI specs route-mock with. Both sides are same-origin:
// the UI resolves these paths against its own base URL, so they reach the runner wherever it
// serves the UI (served at its root, api/health is /api/health), and the runner routes api/*
// before its static files.
//   GET    api/health   200 Health, the body plan.md P12b names. The UI calls it at load: a 200
//                       whose body passes parseHealth means the local runner; on a page without
//                       the runner's token meta anything else means browser-direct, and on the
//                       runner's own page it means the runner is not responding (never
//                       browser-direct). The static build ships its own api/health
//                       (STATIC_HEALTH), so the hosted page gets a 200 that is not clinenv-runner
//                       instead of a 404.
//   POST   api/key      KeyRequest in the body, the X-Clinenv-Token header from the token meta
//                       the runner injects into index.html. 200 KeyState { key_set: true } once
//                       the runner's one validation call succeeded; 409 RunnerError session_cap
//                       (or spend_refused_ceiling, from the ledger) with no call when its worst
//                       case would take the session past the cap of the last batch posted, the
//                       held key unchanged; else RunnerError with the API's status and message.
//   DELETE api/key      the same header. 200 KeyState { key_set: false }.
// P12b adds the trial, run and SSE contracts, each behind the same header:
//   POST   api/trials   TrialsRequest. 202 TrialsAccepted; 409 TrialsRefused, with no call made:
//                       no_key, session_cap, projected_cap, batch_refused (the run is locked),
//                       or spend_refused_<cap> from the ledger's batchStart (projected, actual,
//                       or ceiling: the session cap, which the ledger also holds at every
//                       reserve, so a batch that would cross it later stops with RunView.stopped
//                       spend_refused_ceiling); 400 RunnerError for a body the validator
//                       refuses. ?dry_run=1: 200 DryRun, 0 calls.
//   GET    api/trials/:id         200 TrialView.
//   GET    api/trials/:id/events  text/event-stream: one frame per TrialEvent (`id: <n>`,
//                       `event: <type>`, `data: <TrialEvent JSON>`, n counting from 0 in the
//                       trial's stream); after Last-Event-ID k it replays frames k+1.. then goes
//                       live; `: ping` comments keep it open; it closes after graded, or after
//                       one `event: end` frame (SseEnd, no id) when the trial ends without one.
//   DELETE api/trials/:id         cancels the trial. 200 TrialView.
//   GET    api/runs     200 RunsList: the runs this runner process started, in start order.
// The key travels only in the POST body. No response, error or validator message carries it.
// No Node or DOM imports: this file is checked by the isomorphism lint.
import { reserveRequest, type MessageParam, type MessageParams } from './anthropic.ts';
import { FINAL_TRIALS_PER_TASK, worstCaseUsd } from './cost.ts';
import { PROJECTED_CAP_USD } from './ledger.ts';
import { EFFORTS, type Effort } from './run.ts';

export const RUNNER_APP = 'clinenv-runner';
// Relative to the UI's base: resolve them against document.baseURI.
export const HEALTH_PATH = 'api/health';
export const KEY_PATH = 'api/key';
export const TOKEN_HEADER = 'X-Clinenv-Token';
export const TOKEN_META = 'clinenv-runner-token';
export const TRIALS_PATH = 'api/trials';
export const RUNS_PATH = 'api/runs';
// A key longer than this is not an API key; the runner refuses it before any call.
export const MAX_KEY_LENGTH = 512;
// Per task: the final run's N, so the UI can reproduce one task's final run in one batch.
export const MAX_TRIALS_PER_TASK = FINAL_TRIALS_PER_TASK;
export const MAX_CONCURRENCY = 4;
export const MAX_TASKS = 16;
// The frame that ends a trial's stream when no graded event will come.
export const SSE_END = 'end';

// POST api/key's one Validate call, and its worst case: what the ledger reserves for it and what
// a live check adds to a trial's projection.
export const VALIDATE_REQUEST: { readonly history: readonly MessageParam[]; readonly params: MessageParams } = {
  history: [{ role: 'user', content: 'Reply with OK.' }],
  params: { max_tokens: 16, output_config: { effort: 'low' } },
};

export const validateWorstCaseUsd = (): number => worstCaseUsd(reserveRequest(VALIDATE_REQUEST.history, VALIDATE_REQUEST.params));

export type LedgerMode = 'own-run' | 'default';
const LEDGER_MODES: readonly LedgerMode[] = ['own-run', 'default'];

export interface Health {
  app: typeof RUNNER_APP;
  version: string;
  // Which spend ledger the runner meters through (cli/adapters/ledger-node.ts resolves it).
  ledger: { mode: LedgerMode; path: string };
  // The runner holds a validated key in memory.
  key_loaded: boolean;
  // The runner was started with --mock: no call reaches the API.
  mock: boolean;
}

export interface KeyRequest {
  key: string;
}

export interface KeyState {
  key_set: boolean;
}

export interface RunnerError {
  error: { type: string; message: string };
}

export class ContractError extends TypeError {
  override readonly name = 'ContractError';
}

type Obj = Record<string, unknown>;

function object(x: unknown, what: string): Obj {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) throw new ContractError(`${what}: not a JSON object`);
  return x as Obj;
}

function field<T>(o: Obj, what: string, k: string, ok: (v: unknown) => v is T, expected: string): T {
  if (!Object.hasOwn(o, k)) throw new ContractError(`${what}: missing ${k}`);
  if (!ok(o[k])) throw new ContractError(`${what}: ${k} is not ${expected}`);
  return o[k] as T;
}

const isString = (v: unknown): v is string => typeof v === 'string';
const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean';
const is = <T>(want: T) => (v: unknown): v is T => v === want;
const present = (_v: unknown): _v is unknown => true;
const isMode = (v: unknown): v is LedgerMode => LEDGER_MODES.includes(v as LedgerMode);

export function parseHealth(x: unknown): Health {
  const o = object(x, 'health');
  const ledger = object(field(o, 'health', 'ledger', present, 'an object'), 'health.ledger');
  return {
    app: field(o, 'health', 'app', is(RUNNER_APP), JSON.stringify(RUNNER_APP)),
    version: field(o, 'health', 'version', isString, 'a string'),
    ledger: {
      mode: field(ledger, 'health.ledger', 'mode', isMode, LEDGER_MODES.map((m) => JSON.stringify(m)).join(' or ')),
      path: field(ledger, 'health.ledger', 'path', isString, 'a string'),
    },
    key_loaded: field(o, 'health', 'key_loaded', isBoolean, 'a boolean'),
    mock: field(o, 'health', 'mock', isBoolean, 'a boolean'),
  };
}

// Exactly { key }, the key non-empty, unpadded and at most MAX_KEY_LENGTH characters. Messages
// name the rule broken, never the value.
export function parseKeyRequest(x: unknown): KeyRequest {
  const o = object(x, 'key request');
  only(o, 'key request', ['key']);
  const key = field(o, 'key request', 'key', isString, 'a string');
  if (key === '' || key.trim() !== key || key.length > MAX_KEY_LENGTH || /\s/.test(key)) {
    throw new ContractError(`key request: key must be 1 to ${MAX_KEY_LENGTH} characters with no whitespace`);
  }
  return { key };
}

export function parseKeyState(x: unknown): KeyState {
  return { key_set: field(object(x, 'key state'), 'key state', 'key_set', isBoolean, 'a boolean') };
}

export function parseRunnerError(x: unknown): RunnerError {
  const e = object(field(object(x, 'runner error'), 'runner error', 'error', present, 'an object'), 'runner error.error');
  return { error: { type: field(e, 'runner error', 'type', isString, 'a string'), message: field(e, 'runner error', 'message', isString, 'a string') } };
}

// A task id is a directory name: letters, digits, _ and - (cli/run-one.ts).
const TASK_ID = /^[A-Za-z0-9_-]{1,64}$/;
const isWhole = (lo: number, hi: number) => (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= lo && (v as number) <= hi;
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isNullableString = (v: unknown): v is string | null => v === null || typeof v === 'string';
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every(isString);

// Unknown fields are counted, never named: a field name is client text too, and a key in it,
// percent-encoded or without its sk-ant- prefix, would pass redaction (security review P12b-4 G1).
function only(o: Obj, what: string, allowed: readonly string[]): void {
  const extra = Object.keys(o).filter((k) => !allowed.includes(k)).length;
  if (extra > 0) throw new ContractError(`${what}: ${extra} unknown field${extra === 1 ? '' : 's'}`);
}

export interface TrialsRequest {
  tasks: string[];
  // Per task, 1 to MAX_TRIALS_PER_TASK.
  trials: number;
  concurrency: number;
  effort: Effort;
  // The UI session's cap: the runner refuses a batch whose projection, with what this runner's
  // batches have spent, would cross it, and the batch's grant stops it at the cap after that
  // (reruns included). Never above PROJECTED_CAP_USD; the ledger checks that.
  // Caps are per batch (security review P12b-4 G3, option A): each batch keeps the cap of its own
  // accepted POST as its ceiling for its whole run, so a later POST with another cap neither
  // tightens nor loosens a batch already running. POST api/key checks Validate against the cap
  // of the last batch accepted; a refused POST (or a dry run) never changes it.
  session_cap_usd: number;
  // A key for this batch only, held in memory until it ends; else the key POST api/key holds.
  key?: string;
  // The forced-fail smoke trial (docs/requirements/ui-contract.md, P25c): only on a runner
  // started with CLINENV_FORCED_FAIL=1.
  smoke?: boolean;
}

const TRIALS_FIELDS = ['tasks', 'trials', 'concurrency', 'effort', 'session_cap_usd', 'key', 'smoke'] as const;

// Messages name a known field and the rule, never a value or an unknown name: a key could be in
// any of them.
export function parseTrialsRequest(x: unknown): TrialsRequest {
  const what = 'trials request';
  const o = object(x, what);
  only(o, what, TRIALS_FIELDS);
  const tasks = field(o, what, 'tasks', isStrings, 'a list of task ids');
  if (tasks.length === 0 || tasks.length > MAX_TASKS || new Set(tasks).size !== tasks.length || !tasks.every((t) => TASK_ID.test(t))) {
    throw new ContractError(`${what}: tasks must be 1 to ${MAX_TASKS} distinct task ids (letters, digits, _ and -)`);
  }
  const out: TrialsRequest = {
    tasks,
    trials: field(o, what, 'trials', isWhole(1, MAX_TRIALS_PER_TASK), `a whole number from 1 to ${MAX_TRIALS_PER_TASK}`),
    concurrency: field(o, what, 'concurrency', isWhole(1, MAX_CONCURRENCY), `a whole number from 1 to ${MAX_CONCURRENCY}`),
    effort: field(o, what, 'effort', (v): v is Effort => EFFORTS.includes(v as Effort), EFFORTS.join(' or ')),
    session_cap_usd: field(o, what, 'session_cap_usd', (v): v is number => isNumber(v) && v > 0, 'a number above 0'),
  };
  if (Object.hasOwn(o, 'key')) out.key = parseKeyRequest({ key: o.key }).key;
  if (Object.hasOwn(o, 'smoke')) out.smoke = field(o, what, 'smoke', isBoolean, 'a boolean');
  return out;
}

export interface ProjectionLineView {
  task_id: string | null;
  trials: number;
  per_trial_usd: number;
  basis: string;
  usd: number;
}

// The terms a batch is admitted or refused on: its projection (packages/core/cost.ts
// projectBatch), the ledger's exposure and the two caps it is checked against.
export interface ProjectionTerms {
  total_usd: number;
  lines: ProjectionLineView[];
  allowance_usd: number;
  ledger: { mode: LedgerMode; settled_usd: number; reserved_usd: number; open_usd: number; exposure_usd: number };
  projected_cap_usd: number;
  session_cap_usd: number;
  // What this runner session has committed: its ledger rows' settled and reserved spend plus the
  // not-yet-reserved projection of each of its batches still running.
  session_spent_usd: number;
}

export interface DryRun {
  dry_run: true;
  calls: 0;
  projection: ProjectionTerms;
}

export interface TrialsAccepted {
  run_id: string;
  trial_ids: string[];
}

export interface TrialsRefused extends RunnerError {
  projection: ProjectionTerms | null;
}

export const TRIAL_STATES = ['queued', 'running', 'graded', 'cancelled', 'error'] as const;
export type TrialState = (typeof TRIAL_STATES)[number];
const isState = (v: unknown): v is TrialState => TRIAL_STATES.includes(v as TrialState);

export interface TrialView {
  trial_id: string;
  run_id: string;
  task_id: string;
  index: number;
  state: TrialState;
  // Frames in the trial's stream so far.
  events: number;
  // The trial's record as the batch stored it (packages/core/batch.ts BatchRecord), once it ended.
  record: Record<string, unknown> | null;
  error: string | null;
}

export interface RunView {
  run_id: string;
  started: string;
  mock: boolean;
  smoke: boolean;
  tasks: string[];
  trials: number;
  trial_ids: string[];
  done: boolean;
  stopped: string | null;
}

export interface RunsList {
  runs: RunView[];
}

export interface SseEnd {
  state: TrialState;
  message: string | null;
}

function parseProjection(x: unknown): ProjectionTerms {
  const what = 'projection';
  const o = object(x, what);
  const lines = field(o, what, 'lines', Array.isArray, 'a list') as unknown[];
  const ledger = object(field(o, what, 'ledger', present, 'an object'), 'projection.ledger');
  const num = (obj: Obj, w: string, k: string) => field(obj, w, k, isNumber, 'a number >= 0');
  return {
    total_usd: num(o, what, 'total_usd'),
    lines: lines.map((l) => {
      const lo = object(l, 'projection line');
      return {
        task_id: field(lo, 'projection line', 'task_id', isNullableString, 'a string or null'),
        trials: field(lo, 'projection line', 'trials', isWhole(0, Number.MAX_SAFE_INTEGER), 'a whole number'),
        per_trial_usd: num(lo, 'projection line', 'per_trial_usd'),
        basis: field(lo, 'projection line', 'basis', isString, 'a string'),
        usd: num(lo, 'projection line', 'usd'),
      };
    }),
    allowance_usd: num(o, what, 'allowance_usd'),
    ledger: {
      mode: field(ledger, 'projection.ledger', 'mode', isMode, 'a ledger mode'),
      settled_usd: num(ledger, 'projection.ledger', 'settled_usd'),
      reserved_usd: num(ledger, 'projection.ledger', 'reserved_usd'),
      open_usd: num(ledger, 'projection.ledger', 'open_usd'),
      exposure_usd: num(ledger, 'projection.ledger', 'exposure_usd'),
    },
    projected_cap_usd: num(o, what, 'projected_cap_usd'),
    session_cap_usd: num(o, what, 'session_cap_usd'),
    session_spent_usd: num(o, what, 'session_spent_usd'),
  };
}

export function parseDryRun(x: unknown): DryRun {
  const o = object(x, 'dry run');
  field(o, 'dry run', 'dry_run', is(true as const), 'true');
  field(o, 'dry run', 'calls', is(0 as const), '0');
  return { dry_run: true, calls: 0, projection: parseProjection(field(o, 'dry run', 'projection', present, 'an object')) };
}

export function parseTrialsAccepted(x: unknown): TrialsAccepted {
  const o = object(x, 'trials accepted');
  const trial_ids = field(o, 'trials accepted', 'trial_ids', isStrings, 'a list of strings');
  if (trial_ids.length === 0) throw new ContractError('trials accepted: trial_ids is empty');
  return { run_id: field(o, 'trials accepted', 'run_id', isString, 'a string'), trial_ids };
}

export function parseTrialsRefused(x: unknown): TrialsRefused {
  const o = object(x, 'trials refused');
  const p = field(o, 'trials refused', 'projection', present, 'an object or null');
  return { ...parseRunnerError(o), projection: p === null ? null : parseProjection(p) };
}

export function parseTrialView(x: unknown): TrialView {
  const what = 'trial';
  const o = object(x, what);
  const record = field(o, what, 'record', present, 'an object or null');
  return {
    trial_id: field(o, what, 'trial_id', isString, 'a string'),
    run_id: field(o, what, 'run_id', isString, 'a string'),
    task_id: field(o, what, 'task_id', isString, 'a string'),
    index: field(o, what, 'index', isWhole(0, Number.MAX_SAFE_INTEGER), 'a whole number'),
    state: field(o, what, 'state', isState, TRIAL_STATES.join(' or ')),
    events: field(o, what, 'events', isWhole(0, Number.MAX_SAFE_INTEGER), 'a whole number'),
    record: record === null ? null : object(record, 'trial.record'),
    error: field(o, what, 'error', isNullableString, 'a string or null'),
  };
}

export function parseRunsList(x: unknown): RunsList {
  const runs = field(object(x, 'runs'), 'runs', 'runs', Array.isArray, 'a list') as unknown[];
  return {
    runs: runs.map((r) => {
      const what = 'run';
      const o = object(r, what);
      return {
        run_id: field(o, what, 'run_id', isString, 'a string'),
        started: field(o, what, 'started', isString, 'a string'),
        mock: field(o, what, 'mock', isBoolean, 'a boolean'),
        smoke: field(o, what, 'smoke', isBoolean, 'a boolean'),
        tasks: field(o, what, 'tasks', isStrings, 'a list of strings'),
        trials: field(o, what, 'trials', isWhole(1, MAX_TRIALS_PER_TASK), 'a whole number'),
        trial_ids: field(o, what, 'trial_ids', isStrings, 'a list of strings'),
        done: field(o, what, 'done', isBoolean, 'a boolean'),
        stopped: field(o, what, 'stopped', isNullableString, 'a string or null'),
      };
    }),
  };
}

export function parseSseEnd(x: unknown): SseEnd {
  const o = object(x, 'stream end');
  return { state: field(o, 'stream end', 'state', isState, TRIAL_STATES.join(' or ')), message: field(o, 'stream end', 'message', isNullableString, 'a string or null') };
}

export interface SseFrame {
  id: string | null;
  event: string;
  data: string;
}

// One SSE frame: `id` (absent for the end frame), `event` and one `data` line (JSON has no raw
// newline).
export const sseFrame = (f: SseFrame): string => `${f.id === null ? '' : `id: ${f.id}\n`}event: ${f.event}\ndata: ${f.data}\n\n`;

// The frames of an event stream, comments (`: ping`) dropped. A trailing partial frame is kept
// for the caller's next read: { frames, rest }.
export function parseSse(text: string): { frames: SseFrame[]; rest: string } {
  const blocks = text.split('\n\n');
  const rest = blocks.pop() as string;
  const frames = blocks.flatMap((block) => {
    let id: string | null = null;
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line === '' || line.startsWith(':')) continue;
      const at = line.indexOf(':');
      const name = at < 0 ? line : line.slice(0, at);
      const value = at < 0 ? '' : line.slice(at + 1).replace(/^ /, '');
      if (name === 'id') id = value;
      else if (name === 'event') event = value;
      else if (name === 'data') data.push(value);
    }
    return data.length === 0 ? [] : [{ id, event, data: data.join('\n') }];
  });
  return { frames, rest };
}

// What the UI specs route-mock with and the contract test checks; P12b's runner tests reuse them.
// The body of apps/web/public/api/health, which the static build serves at the same path.
export const STATIC_HEALTH = { app: 'static', surface: 'browser-direct' } as const;

const SAMPLE_PROJECTION = {
  total_usd: 7.9,
  lines: [{ task_id: 'renal-dose-review', trials: 1, per_trial_usd: 6, basis: 'cap', usd: 6.9 }],
  allowance_usd: 1,
  ledger: { mode: 'default', settled_usd: 0, reserved_usd: 0, open_usd: 0, exposure_usd: 0 },
  projected_cap_usd: PROJECTED_CAP_USD,
  session_cap_usd: 5,
  session_spent_usd: 0,
} as const satisfies ProjectionTerms;

export const SAMPLES = {
  staticHealth: STATIC_HEALTH,
  health: { app: RUNNER_APP, version: '0.1.0', ledger: { mode: 'default', path: '/home/user/.clinenv/spend.jsonl' }, key_loaded: false, mock: false },
  healthWithKey: { app: RUNNER_APP, version: '0.1.0', ledger: { mode: 'default', path: '/home/user/.clinenv/spend.jsonl' }, key_loaded: true, mock: false },
  healthOwnRun: { app: RUNNER_APP, version: '0.1.0', ledger: { mode: 'own-run', path: '/tmp/clinenv/spend.jsonl' }, key_loaded: false, mock: true },
  keyRequest: { key: 'sample-not-a-key' },
  keyAccepted: { key_set: true },
  keyCleared: { key_set: false },
  keyError: { error: { type: 'authentication_error', message: 'invalid x-api-key' } },
  trialsRequest: { tasks: ['renal-dose-review'], trials: 1, concurrency: 1, effort: 'high', session_cap_usd: 20 },
  trialsAccepted: { run_id: 'ui-20261024T120000Z-a1b2', trial_ids: ['ui-20261024T120000Z-a1b2.renal-dose-review.0'] },
  dryRun: { dry_run: true, calls: 0, projection: SAMPLE_PROJECTION },
  trialsRefused: { error: { type: 'session_cap', message: 'projection $7.90 with $0.00 spent this session would cross the session cap $5.00' }, projection: SAMPLE_PROJECTION },
  trial: {
    trial_id: 'ui-20261024T120000Z-a1b2.renal-dose-review.0', run_id: 'ui-20261024T120000Z-a1b2', task_id: 'renal-dose-review', index: 0,
    state: 'running', events: 3, record: null, error: null,
  },
  runs: {
    runs: [{
      run_id: 'ui-20261024T120000Z-a1b2', started: '2026-10-24T12:00:00.000Z', mock: false, smoke: false, tasks: ['renal-dose-review'], trials: 1,
      trial_ids: ['ui-20261024T120000Z-a1b2.renal-dose-review.0'], done: false, stopped: null,
    }],
  },
  sseEnd: { state: 'error', message: 'batch stopped (actual_cap) before this trial started' },
} as const satisfies {
  staticHealth: unknown;
  health: Health;
  healthWithKey: Health;
  healthOwnRun: Health;
  keyRequest: KeyRequest;
  keyAccepted: KeyState;
  keyCleared: KeyState;
  keyError: RunnerError;
  trialsRequest: TrialsRequest;
  trialsAccepted: TrialsAccepted;
  dryRun: DryRun;
  trialsRefused: TrialsRefused;
  trial: TrialView;
  runs: RunsList;
  sseEnd: SseEnd;
};
