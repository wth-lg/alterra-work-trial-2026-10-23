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
//                       the runner's one validation call succeeded; else RunnerError with the
//                       API's status and message.
//   DELETE api/key      the same header. 200 KeyState { key_set: false }.
// The key travels only in the POST body. No response, error or validator message carries it.
// No Node or DOM imports: this file is checked by the isomorphism lint.

export const RUNNER_APP = 'clinenv-runner';
// Relative to the UI's base: resolve them against document.baseURI.
export const HEALTH_PATH = 'api/health';
export const KEY_PATH = 'api/key';
export const TOKEN_HEADER = 'X-Clinenv-Token';
export const TOKEN_META = 'clinenv-runner-token';
// A key longer than this is not an API key; the runner refuses it before any call.
export const MAX_KEY_LENGTH = 512;

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
  const extra = Object.keys(o).filter((k) => k !== 'key');
  if (extra.length > 0) throw new ContractError(`key request: unknown field ${extra.join(', ')}`);
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

// What the UI specs route-mock with and the contract test checks; P12b's runner tests reuse them.
// The body of apps/web/public/api/health, which the static build serves at the same path.
export const STATIC_HEALTH = { app: 'static', surface: 'browser-direct' } as const;

export const SAMPLES = {
  staticHealth: STATIC_HEALTH,
  health: { app: RUNNER_APP, version: '0.1.0', ledger: { mode: 'default', path: '/home/user/.clinenv/spend.jsonl' }, key_loaded: false, mock: false },
  healthWithKey: { app: RUNNER_APP, version: '0.1.0', ledger: { mode: 'default', path: '/home/user/.clinenv/spend.jsonl' }, key_loaded: true, mock: false },
  healthOwnRun: { app: RUNNER_APP, version: '0.1.0', ledger: { mode: 'own-run', path: '/tmp/clinenv/spend.jsonl' }, key_loaded: false, mock: true },
  keyRequest: { key: 'sample-not-a-key' },
  keyAccepted: { key_set: true },
  keyCleared: { key_set: false },
  keyError: { error: { type: 'authentication_error', message: 'invalid x-api-key' } },
} as const satisfies {
  staticHealth: unknown;
  health: Health;
  healthWithKey: Health;
  healthOwnRun: Health;
  keyRequest: KeyRequest;
  keyAccepted: KeyState;
  keyCleared: KeyState;
  keyError: RunnerError;
};
