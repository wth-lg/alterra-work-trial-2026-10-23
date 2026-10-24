// The local runner (plan phase P12b): a node:http server on 127.0.0.1 that serves the built UI
// (apps/web/dist) under the Vite base and runs live trials posted from it through
// packages/core/batch.ts, so through run.ts, the same path as `pnpm cli run`. The HTTP contract
// is packages/core/runner-api.ts; main.ts is the command.
//
// Static: apps/web/dist under BASE. / (and BASE without its slash) redirects to BASE keeping the
// query, so the UI contract's `/?view=...` routes land on the same screen; a path with no
// extension falls back to index.html (an app route); probe.html, harness.html in any letter case
// and any path that resolves outside dist (`..`, encoded dots or slashes, a symlink out of dist)
// get 404.
// index.html is served with its built CSP meta unchanged plus a token meta holding this
// process's 256-bit random token. The API answers at /api/* and at BASE + api/* (the UI
// resolves api paths against its base), ahead of the static files.
//
// Every request passes, in order: Host must be 127.0.0.1:<port> or localhost:<port> (DNS
// rebinding); an Origin, when present, must be http://<that Host>; Sec-Fetch-Site, when present,
// must be same-origin (the page itself may also be opened from the address bar, `none`); OPTIONS
// gets 403 and no response carries an Access-Control-* header; a query parameter whose name
// looks like a key, or a query whose raw text, fully percent-decoded (fullyDecoded), holds
// sk-ant-shaped text, gets 400, and an /api query may hold only dry_run. Every /api route but
// GET /api/health needs X-Clinenv-Token equal to the token, which only a page this process
// served can read; a POST body must be application/json.
//
// The key: it arrives only in a POST body (api/key, or api/trials for one batch). POST api/key
// makes one Validate call (effort low, max_tokens 16) through batchStart and the ledger, then
// holds the key in this closure for the process's lifetime; DELETE api/key forgets it. The key
// leaves the process only in the x-api-key header MessagesClient sends (packages/core/anthropic.ts);
// it is never written to a record, ledger row, log line or response, and every error text passes
// through redactText. No response or log line echoes request input: a contract error counts
// unknown fields instead of naming them and an unknown task id is not named (security review
// P12b-4 G1). Upstream text never enters the process: typeOnly wraps every transport so an
// error answer or stream error event keeps its status and error type and loses its message, and
// a failed connection or stream throws a fixed error. So a log line, trial record or response
// carries an upstream error as its status and type only, and a failed Validate answers a fixed
// message for its class: unauthorized, forbidden, rate limited or upstream error (G2). The
// runner reads only ENV_KEYS from its environment, never
// ANTHROPIC_API_KEY. The request log is method, route template (routeOf: /api/trials/:id,
// BASE*, or `unmatched`), status and duration; never a path, body, header or query, so no
// encoding of a key typed into a URL can reach it. No response echoes the path either: an /api
// 404 or 405 names only the matched route template. Every log line and API error message also
// has any sk-ant-shaped string replaced, held or not, as defence in depth.
//
// The server drops a client that takes over HEADERS_TIMEOUT_MS to send its headers or
// REQUEST_TIMEOUT_MS to send its whole request (checked every CONNECTIONS_CHECK_MS), and holds
// at most MAX_CONNECTIONS sockets.
//
// Batches: POST api/trials plans the batch (planBatch), refuses it with 409 and no call when no
// key is held, when its projection with what this session has committed would cross the
// session cap, or when the ledger's exposure plus the projection would cross PROJECTED_CAP_USD,
// and otherwise runs it with runBatch, which gets its grant from batchStart, and answers 202 once
// the grant is held. The grant carries the session cap as its ceiling (ledger.ts SpendCeiling,
// scope: this session's run ids), so the cap also holds after admission: a reserve that would
// take the session past it, a re-queued attempt's included, is refused, the batch stops
// (stopped: spend_refused_ceiling), the trial in flight ends CANCELLED (stopped from outside,
// kept as a re-queued attempt, so a later batch runs it again) and every reservation settles.
// Caps are per batch (runner-api.ts TrialsRequest.session_cap_usd): a batch keeps the cap of its
// own POST as its ceiling, and a later POST with a lower cap is refused without reining it in.
// POST api/key checks its Validate worst case against the cap of the last batch accepted (202),
// in this runner and in the ledger, and gets 409 session_cap with no call when it would cross it;
// a refused POST or a dry run never changes that cap (security review P12b-4 G3). Before any
// batch there is no cap yet, and the first batch counts what Validate spent. A batch
// runBatch refuses before its grant (its run is locked, batchStart refuses it) gets 409 with the
// reason and leaves no run or trial. The run id (<session>-<n>) is taken before any await, so
// two requests at once never share one.
// What a session has committed is its ledger rows' settled and reserved spend plus, for each of
// this runner's batches not yet done, the part of its projection its rows do not hold yet: a
// batch counts in full from the moment it is accepted, so two batches posted back to back cannot
// both pass. A batch's term is dropped when it is done (closed, cancelled, failed or refused).
// Records go to CLINENV_RUNS_DIR, else ~/.clinenv/runs, under <run_id>/ (cli/adapters/
// result-sink-node.ts), and the ledger is the CLI's (cli/adapters/ledger-node.ts: the own-run
// marker, else SPEND_LEDGER, else ~/.clinenv/spend.jsonl). --mock answers every call from the
// toy scenario of `run-one --mock toy` and makes no network call. The projection's cost source
// is results/official.json's `cost_from` runs, else the $6 per-trial cap.
//
// Cancel: DELETE api/trials/:id aborts that trial's signal. The call in flight stops, settles at
// its worst case and is not retried; the trial ends CANCELLED, a re-queued attempt the batch keeps,
// and the batch goes on with its other trials. shutdown() (SIGINT, SIGTERM) cancels every batch,
// waits up to SHUTDOWN_WAIT_MS for each to write its close row, closes the server, and resolves
// whether every batch closed in that time.
//
// The forced-fail smoke trial (docs/requirements/ui-contract.md, P25c): with CLINENV_FORCED_FAIL=1
// a POST api/trials with smoke: true runs each trial through run() with a scripted client that
// answers as claude-opus-5-5 and finishes at once, so the task's gates fail; run id smoke-<n>,
// records with mock: true under CLINENV_RUNS_DIR only, no key, no ledger row.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { basename, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { okResponse, scenarioTransport } from '../web/src/harness/scenarios.ts';
import { ApiError, EgressRefusal, MessagesClient, MODEL, type Transport } from '../../packages/core/anthropic.ts';
import { BatchRefused, planBatch, runBatch, trialKey, type BatchRecord, type BatchSpec, type ResultSink, type TrialKey } from '../../packages/core/batch.ts';
import type { Projection, TrialObservation } from '../../packages/core/cost.ts';
import type { TrialEvent } from '../../packages/core/events.ts';
import { checkProjected, PROJECTED_CAP_USD, SpendRefused, totals, type Ledger, type LedgerRow, type SpendCeiling } from '../../packages/core/ledger.ts';
import type { TrialClient } from '../../packages/core/loop.ts';
import { REDACTED, redactText } from '../../packages/core/redact.ts';
import { run, type RunOptions } from '../../packages/core/run.ts';
import { taskVersions, type TaskSource } from '../../packages/core/tasks.ts';
import {
  ContractError, parseKeyRequest, parseTrialsRequest, RUNNER_APP, sseFrame, SSE_END, TOKEN_HEADER, TOKEN_META, VALIDATE_REQUEST, validateWorstCaseUsd,
  type Health, type ProjectionTerms, type RunView, type SseEnd, type TrialsRequest, type TrialState, type TrialView,
} from '../../packages/core/runner-api.ts';
import { nodeNow } from '../../cli/adapters/clock-node.ts';
import { loadTrialObservations, openNodeLedger, readRows, resolveLedgerPath } from '../../cli/adapters/ledger-node.ts';
import { nodeResultSink } from '../../cli/adapters/result-sink-node.ts';
import { nodeTaskSource } from '../../cli/adapters/tasks-node.ts';
import { gitState, repoWorld, taskChecks } from '../../cli/run.ts';

export const BASE = '/clinical-agent-env/';
export const DEFAULT_PORT = 5180;
export const RUNNER_VERSION = '0.1.0';
export const DIST = fileURLToPath(new URL('../web/dist/', import.meta.url));
const REPO = fileURLToPath(new URL('../../', import.meta.url));
// The only variables the runner reads; ANTHROPIC_API_KEY is not one of them.
export const ENV_KEYS = ['HOME', 'SPEND_LEDGER', 'CLINENV_CANONICAL_LEDGER', 'CLINENV_RUNS_DIR', 'CLINENV_FORCED_FAIL'] as const;
const MAX_BODY_BYTES = 64 * 1024;
const PING_MS = 15_000;
const SHUTDOWN_WAIT_MS = 8_000;
const HEADERS_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;
// How often Node checks those two timeouts (its default is 30 s, which lets a slow client stay
// up to 40 s).
const CONNECTIONS_CHECK_MS = 1_000;
// Room for one event stream per trial of the largest batch (MAX_TASKS x MAX_TRIALS_PER_TASK)
// plus the page's other requests.
const MAX_CONNECTIONS = 256;
// Lower case: compared with the lowercased basename, as APFS and NTFS match names in any case.
const TEST_PAGES = new Set(['probe.html', 'harness.html']);
const KEYISH = /key|token|secret|auth|password/i;
// The shape keyscan looks for, held or not.
const KEY_SHAPE = /sk-ant-[A-Za-z0-9_-]*/gi;
const keyShaped = (text: string) => new RegExp(KEY_SHAPE.source, 'i').test(text);
// Text with every %XX escape decoded, one escape at a time (as its byte, so an invalid UTF-8
// sequence cannot stop it) and again until nothing changes: each pass that changes the text
// shortens it, so the loop ends.
const fullyDecoded = (text: string): string => {
  for (;;) {
    const next = text.replace(/%([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    if (next === text) return text;
    text = next;
  }
};
// An upstream error type as the API names them (authentication_error, overloaded_error, ...).
const ERROR_TYPE = /^[a-z_]{1,64}$/;
// An error body, or an SSE error event's data, reduced to its type: { type: 'error', error: { type } }.
const typeOnly = (raw: string): string => {
  let type: unknown;
  try {
    type = (JSON.parse(raw) as { error?: { type?: unknown } }).error?.type;
  } catch {
    type = undefined;
  }
  return JSON.stringify({ type: 'error', error: typeof type === 'string' && ERROR_TYPE.test(type) ? { type } : {} });
};
// A stream with each SSE error event's data reduced by typeOnly; a stream that fails mid-read
// fails with a fixed error.
function sseTypeOnly(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let rest = '';
  const line = (l: string) => {
    if (!l.startsWith('data:') || !l.includes('"error"')) return l;
    try {
      if ((JSON.parse(l.slice(5)) as { type?: unknown }).type !== 'error') return l;
    } catch {
      return l;
    }
    return `data: ${typeOnly(l.slice(5))}`;
  };
  return new ReadableStream<Uint8Array>({
    async pull(c) {
      let r: Awaited<ReturnType<typeof reader.read>>;
      try {
        r = await reader.read();
      } catch {
        c.error(new TypeError('stream failed'));
        return;
      }
      if (r.done) {
        if (rest !== '') c.enqueue(encoder.encode(line(rest)));
        c.close();
        return;
      }
      const lines = (rest + decoder.decode(r.value, { stream: true })).split('\n');
      rest = lines.pop() ?? '';
      if (lines.length > 0) c.enqueue(encoder.encode(`${lines.map(line).join('\n')}\n`));
    },
    cancel: (reason) => reader.cancel(reason),
  });
}
// The transport as the client sees it: upstream text removed (see the header). An abort and the
// egress guard's refusal pass through as they are, since the client tells them apart.
const upstreamTypeOnly = (f: Transport): Transport => async (request) => {
  let res: Response | null = null;
  try {
    res = await f(request);
  } catch (e) {
    if (request.signal.aborted || e instanceof EgressRefusal) throw e;
  }
  // Any other failure: a fixed error, without the cause, which is upstream text.
  if (res === null) throw new TypeError('fetch failed');
  const headers = new Headers(res.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  if (res.status !== 200) {
    const raw = await res.text().catch(() => '');
    headers.set('content-type', 'application/json');
    return new Response(typeOnly(raw), { status: res.status, statusText: '', headers });
  }
  return res.body === null ? res : new Response(sseTypeOnly(res.body), { status: res.status, headers });
};
// A failed Validate's answer, by class: the upstream status picks it, never the upstream text.
const VALIDATE_FAILED = {
  unauthorized: 'The API refused this key (unauthorized). Check the key and press Validate again.',
  forbidden: 'This key may not use the model (forbidden). Check the key\'s workspace and press Validate again.',
  rate_limited: 'The API is rate limiting this key. Wait a minute, then press Validate again.',
  upstream: 'The API call failed (upstream error). Press Validate again in a minute.',
} as const;
const validateFailed = (status: number | null): string =>
  status === 401 ? VALIDATE_FAILED.unauthorized : status === 403 ? VALIDATE_FAILED.forbidden : status === 429 ? VALIDATE_FAILED.rate_limited : VALIDATE_FAILED.upstream;

const API_ROUTES = new Set(['health', 'key', 'runs', 'trials']);
const TRIAL_ROUTE = /^trials\/([^/]+)(\/events)?$/;
// An /api route's template (trials/:id), or null for no route.
const apiTemplate = (route: string): string | null => {
  if (API_ROUTES.has(route)) return route;
  const m = TRIAL_ROUTE.exec(route);
  return m ? `trials/:id${m[2] ?? ''}` : null;
};
// What the request log shows for a path: a route template, never the path itself.
const routeOf = (pathname: string, apiRoute: string | null): string => {
  if (apiRoute !== null) {
    const t = apiTemplate(apiRoute);
    return t === null ? 'unmatched' : `/api/${t}`;
  }
  if (pathname === '/' || pathname === BASE || pathname === BASE.slice(0, -1)) return pathname;
  return pathname.startsWith(BASE) ? `${BASE}*` : 'unmatched';
};
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.gz': 'application/gzip', '.ndjson': 'application/x-ndjson', '.map': 'application/json',
};

type Env = Partial<Record<(typeof ENV_KEYS)[number], string>>;

export interface RunnerOptions {
  // The process environment; only ENV_KEYS are read.
  env: Record<string, string | undefined>;
  mock: boolean;
  // 0 for any free port; a taken port falls back to a free one. Default DEFAULT_PORT.
  port?: number;
  // The built UI; default apps/web/dist.
  dist?: string;
  // The transport of one client, by its trial label; default the global fetch, or the toy
  // scenario under mock.
  transport?: (label: string) => Transport;
  // Request log and batch lines; default nothing.
  log?: (line: string) => void;
  pingMs?: number;
  // How long shutdown() waits for the batches to close; default SHUTDOWN_WAIT_MS.
  shutdownWaitMs?: number;
  // The client's retry wait; default a timer.
  sleep?: (ms: number) => Promise<void>;
  // The task directories; default tasks/.
  tasksDir?: string;
}

export interface Runner {
  server: Server;
  port: number;
  url: string;
  token: string;
  // Cancels every batch, waits for each to close, then closes the server. False when a batch
  // had not closed by the end of the wait.
  shutdown(): Promise<boolean>;
}

interface TrialEntry {
  id: string;
  runId: string;
  key: TrialKey | null;
  taskId: string;
  index: number;
  state: TrialState;
  frames: Array<{ event: string; data: string }>;
  record: Record<string, unknown> | null;
  error: string | null;
  end: SseEnd | null;
  ended: boolean;
  controller: AbortController;
  subscribers: Set<ServerResponse>;
}

interface RunEntry {
  view: RunView;
  controller: AbortController;
  done: Promise<void>;
}

class HttpError extends Error {
  readonly status: number;
  readonly type: string;
  constructor(status: number, type: string, message: string) {
    super(message);
    this.status = status;
    this.type = type;
  }
}

// What a cancel aborts a trial's signal with: an API error that does not stop the batch, so the
// batch's other trials go on (classifyFailure).
const cancelReason = (why: string) => new ApiError(`cancelled: ${why}`, { status: null, type: 'cancelled', retryable: false, stopsBatch: false });

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

function pickEnv(env: Record<string, string | undefined>): Env {
  const out: Env = {};
  for (const k of ENV_KEYS) if (env[k] !== undefined) out[k] = env[k];
  return out;
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolveListen, reject) => {
    const onError = (e: NodeJS.ErrnoException) => {
      server.off('listening', onListening);
      if (e.code === 'EADDRINUSE' && port !== 0) resolveListen(listen(server, 0));
      else reject(e);
    };
    const onListening = () => {
      server.off('error', onError);
      resolveListen((server.address() as { port: number }).port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

// The cost source results/official.json names: { "cost_from": ["results/<run>", ...] }.
function officialObservations(): TrialObservation[] {
  const file = join(REPO, 'results', 'official.json');
  if (!existsSync(file)) return [];
  const from = (JSON.parse(readFileSync(file, 'utf8')) as { cost_from?: unknown }).cost_from;
  const runs = typeof from === 'string' ? [from] : Array.isArray(from) ? from.filter((x): x is string => typeof x === 'string') : [];
  return loadTrialObservations(runs.map((r) => resolve(REPO, r)));
}

// The forced-fail smoke client: one answer as claude-opus-5-5 that finishes without acting.
function forcedFailClient(): TrialClient {
  let n = 0;
  return {
    async send(history) {
      n++;
      const message = {
        id: `msg_smoke_${n}`, model: MODEL, role: 'assistant' as const, stop_reason: 'tool_use', stop_details: null,
        content: [{ type: 'tool_use', id: `toolu_smoke_${n}`, name: 'finish', input: { summary: 'Smoke trial: finished without acting.' } }],
        usage: { input_tokens: 0, output_tokens: 0 },
      };
      history.push({ role: 'assistant', content: message.content });
      return { status: 200, message, refusal: null, attempts: 1 };
    },
  };
}

export async function startRunner(opts: RunnerOptions): Promise<Runner> {
  const env = pickEnv(opts.env);
  const ledgerPlace = resolveLedgerPath(env);
  if (ledgerPlace.problems.length > 0) throw new Error(`own-run spend ledger refused: ${ledgerPlace.problems.join('; ')}`);
  const dist = opts.dist ?? DIST;
  const runsDir = resolve(env.CLINENV_RUNS_DIR ?? join(env.HOME || homedir(), '.clinenv', 'runs'));
  const forcedFail = env.CLINENV_FORCED_FAIL === '1';
  const pingMs = opts.pingMs ?? PING_MS;
  // The token proves a request came from a page this process served; it is not a secret from
  // this machine. Accepted residual (P12b security review S2): any local user or process can GET
  // index.html and read it, then drive the runner with the held key up to the session cap, though
  // it can never read the key back. Local users and processes are outside the threat model; the
  // token stops other web origins, which can neither read the page nor send the header.
  const token = randomBytes(32).toString('hex');
  const session = `ui-${stamp()}-${randomBytes(2).toString('hex')}`;
  const mockToy = (label: string): Transport => (label.includes('validate') ? async () => okResponse({ text: 'OK' }, 1) : scenarioTransport('toy').transport);
  const base = opts.transport ?? (opts.mock ? mockToy : () => (request: Request) => fetch(request));
  const transport = (label: string) => upstreamTypeOnly(base(label));
  // A TaskSource reads the task directories once, so each request builds its own: a task
  // edited between two batches is graded as edited, at its new env_version.
  const taskSourceNow = () => nodeTaskSource({ ...(opts.tasksDir === undefined ? {} : { root: opts.tasksDir }), testMode: false });
  const git = gitState(REPO);
  let world: ReturnType<typeof repoWorld> | undefined;

  // The key typed into the UI, held only here.
  let heldKey: string | null = null;
  // Keys of batches running now: redacted from every line too.
  const batchKeys = new Set<string>();
  const secrets = () => [...(heldKey === null ? [] : [heldKey]), ...batchKeys];
  // Held keys first, then any other key-shaped string.
  const scrub = (text: string) => redactText(text, secrets()).replace(KEY_SHAPE, REDACTED);
  const say = (line: string) => opts.log?.(scrub(line));

  const runs: RunEntry[] = [];
  const trials = new Map<string, TrialEntry>();
  let runCount = 0;
  let stopping = false;

  const ledgerMode = ledgerPlace.mode;
  const ledgerPath = ledgerPlace.path;
  const inSession = (runId: string | null) => runId !== null && runId.startsWith(session);
  const sessionRows = (rows: readonly LedgerRow[]) => rows.filter((r) => inSession(r.run_id));
  // The session cap as a grant's ceiling: the ledger checks it at every reserve.
  const ceilingAt = (usd: number): SpendCeiling => ({ usd, scope: inSession, what: 'session cap' });
  // The cap of the last batch accepted, which POST api/key checks Validate against; null before
  // any. Set only on a 202, never by a refused POST or a dry run (see the header).
  let sessionCap: number | null = null;
  // The projection of each of this runner's batches that is not done, by run id (see the header).
  // Each batch removes only its own entry.
  const pending = new Map<string, { usd: number }>();
  const committed = (rows: readonly LedgerRow[]) => {
    const mine = totals(sessionRows(rows));
    let ahead = 0;
    for (const [runId, projected] of pending) {
      const held = totals(rows.filter((r) => r.run_id === runId));
      ahead += Math.max(0, projected.usd - held.settled - held.reserved);
    }
    return mine.settled + mine.reserved + ahead;
  };

  // ---- trials and their streams ----

  const viewOf = (t: TrialEntry): TrialView => ({
    trial_id: t.id, run_id: t.runId, task_id: t.taskId, index: t.index, state: t.state, events: t.frames.length, record: t.record, error: t.error,
  });

  const writeFrame = (res: ServerResponse, t: TrialEntry, i: number) => {
    const f = t.frames[i] as { event: string; data: string };
    res.write(sseFrame({ id: String(i), event: f.event, data: f.data }));
  };

  const closeStreams = (t: TrialEntry) => {
    for (const res of t.subscribers) {
      if (t.end !== null) res.write(sseFrame({ id: null, event: SSE_END, data: JSON.stringify(t.end) }));
      res.end();
    }
    t.subscribers.clear();
  };

  const pushEvent = (t: TrialEntry, e: TrialEvent) => {
    t.frames.push({ event: e.type, data: JSON.stringify(e) });
    for (const res of t.subscribers) writeFrame(res, t, t.frames.length - 1);
  };

  const endTrial = (t: TrialEntry, state: TrialState, message: string | null) => {
    if (t.ended) return;
    t.ended = true;
    t.state = state;
    if (message !== null) t.error = scrub(message);
    // A stream that carried a graded event ends with it; any other ends with an end frame.
    if (t.frames.at(-1)?.event !== 'graded') t.end = { state, message: t.error };
    closeStreams(t);
  };

  const newTrial = (runId: string, taskId: string, index: number, key: TrialKey | null): TrialEntry => {
    const t: TrialEntry = {
      id: `${runId}.${taskId}.${index}`, runId, key, taskId, index, state: 'queued', frames: [], record: null, error: null, end: null, ended: false,
      controller: new AbortController(), subscribers: new Set(),
    };
    trials.set(t.id, t);
    return t;
  };

  // The run's ResultSink, which also feeds the trials' streams and states.
  function trackingSink(inner: ResultSink, byKey: Map<string, TrialEntry>): ResultSink {
    const of = (k: TrialKey) => byKey.get(trialKey(k)) as TrialEntry;
    return {
      ...inner,
      begin: async (k, attempt) => {
        await inner.begin(k, attempt);
        of(k).state = 'running';
      },
      event: (k, attempt, e) => {
        inner.event(k, attempt, e);
        pushEvent(of(k), e);
      },
      finish: async (k, record) => {
        await inner.finish(k, record);
        const t = of(k);
        t.record = record as unknown as Record<string, unknown>;
        if (record.outcome === 'CANCELLED') endTrial(t, 'cancelled', null);
        else if (record.settled) endTrial(t, 'graded', null);
        else t.state = 'queued'; // re-queued: the batch runs it again at its end
      },
    };
  }

  // ---- batches ----

  // 400 when a task id is not one of this runner's tasks. The message counts them and never
  // names one: the ids are client text (see the header).
  async function knownTasks(tasks: TaskSource, ids: readonly string[]): Promise<void> {
    const found = await Promise.all(ids.map((id) => tasks.get(id).then(() => true, () => false)));
    const unknown = found.filter((ok) => !ok).length;
    if (unknown > 0) throw new HttpError(400, 'invalid_request', `tasks: ${unknown} task ${unknown === 1 ? 'id is not a task' : 'ids are not tasks'} this runner has`);
  }

  function terms(projection: Projection, rows: readonly LedgerRow[], sessionCap: number): ProjectionTerms {
    const t = totals(rows);
    return {
      total_usd: projection.total,
      lines: projection.lines.map((l) => ({ task_id: l.task_id, trials: l.trials, per_trial_usd: l.per_trial.usd, basis: l.per_trial.basis, usd: l.usd })),
      allowance_usd: projection.allowance.usd,
      ledger: { mode: ledgerMode, settled_usd: t.settled, reserved_usd: t.reserved, open_usd: t.openExcess, exposure_usd: t.exposure },
      projected_cap_usd: PROJECTED_CAP_USD,
      session_cap_usd: sessionCap,
      session_spent_usd: committed(rows),
    };
  }

  async function postTrials(body: TrialsRequest, dryRun: boolean): Promise<{ status: number; body: unknown }> {
    if (body.session_cap_usd > PROJECTED_CAP_USD) throw new HttpError(400, 'invalid_request', `the session cap can be at most $${PROJECTED_CAP_USD}`);
    const tasks = taskSourceNow();
    await knownTasks(tasks, body.tasks);
    if (body.smoke) return startSmoke(body, tasks);
    const key = opts.mock ? 'mock-key-not-sent' : (body.key ?? heldKey);
    world ??= repoWorld();
    // Taken before any await, so two requests in flight at once never share a run id.
    const runId = `${session}-${++runCount}`;
    const sink = nodeResultSink(join(runsDir, runId));
    const spec: BatchSpec = {
      runId, taskIds: body.tasks, trials: body.trials, model: MODEL, effort: body.effort, mode: opts.mock ? 'mock-toy' : 'live', concurrency: body.concurrency,
      observations: officialObservations(), manifest: { source: 'local-runner', env_git_sha: git.sha, env_dirty: git.dirty === null ? null : git.dirty.length > 0 },
    };
    let plan;
    try {
      plan = await planBatch(spec, { tasks, sink, worldHash: world.worldHash });
    } catch (e) {
      throw new HttpError(400, 'invalid_request', e instanceof BatchRefused ? e.message : `tasks: ${(e as Error).message}`);
    }
    const rows = readRows(ledgerPath);
    const projection = terms(plan.projection, rows, body.session_cap_usd);
    if (dryRun) return { status: 200, body: { dry_run: true, calls: 0, projection } };
    if (key === null) return { status: 409, body: { error: { type: 'no_key', message: 'No API key yet: paste your Anthropic API key and press Validate, then start the trial again.' }, projection: null } };
    if (projection.session_spent_usd + projection.total_usd > body.session_cap_usd) {
      return {
        status: 409,
        body: { error: { type: 'session_cap', message: `This batch's estimate of $${projection.total_usd.toFixed(2)}, with $${projection.session_spent_usd.toFixed(2)} already spent or running this session, would go over your session cap of $${body.session_cap_usd.toFixed(2)}.` }, projection },
      };
    }
    const check = checkProjected(totals(rows), plan.projection.total);
    if (check.over) {
      return {
        status: 409,
        body: { error: { type: 'projected_cap', message: `This batch's estimate of $${projection.total_usd.toFixed(2)}, with $${projection.ledger.exposure_usd.toFixed(2)} already in the spend ledger, would go over the project's $${PROJECTED_CAP_USD} spending limit.` }, projection },
      };
    }

    const { ledger, store } = openNodeLedger({ transport: opts.mock ? 'offline' : 'live', env, runId });
    // Counted from here, before any await, so a batch posted next sees it.
    const term = { usd: plan.projection.total };
    pending.set(runId, term);
    // runBatch may still refuse the batch (its run lock, the ledger's batchStart): the answer
    // waits for the grant, so a refused batch gets its refusal, not 202.
    let granted = () => {};
    const started = new Promise<void>((r) => (granted = r));
    const gated: Ledger = {
      ...ledger,
      batchStart: async (projected, ceiling) => {
        const grant = await ledger.batchStart(projected, ceiling);
        granted();
        return grant;
      },
    };
    const controller = new AbortController();
    const byKey = new Map<string, TrialEntry>();
    const entries = plan.keys.map((k) => {
      const t = newTrial(runId, k.task_id, k.index, k);
      byKey.set(trialKey(k), t);
      return t;
    });
    const view: RunView = { run_id: runId, started: new Date().toISOString(), mock: opts.mock, smoke: false, tasks: body.tasks, trials: body.trials, trial_ids: entries.map((t) => t.id), done: false, stopped: null };
    const byLabel = (label: string | undefined) => entries.find((t) => label !== undefined && label.endsWith(`:${t.taskId}/${t.index}`));
    if (!opts.mock) batchKeys.add(key);
    const w = world;
    const batch = runBatch(
      { ...spec, ceiling: ceilingAt(body.session_cap_usd), signal: controller.signal, log: (l) => say(`run ${runId}: ${l}`) },
      {
        ledger: gated, rows: () => store.read(), sink: trackingSink(sink, byKey), tasks, checks: taskChecks, world: w.world, worldHash: w.worldHash, definitions: w.definitions, now: nodeNow,
        client: (grant, label) => new MessagesClient({ grant, ledger, apiKey: key, fetch: transport(label), trial: label, log: (l) => say(`${label}: ${l}`), ...(opts.sleep ? { sleep: opts.sleep } : {}) }),
        // Each trial also carries its own signal, which DELETE api/trials/:id aborts.
        run: (taskId, model, o: RunOptions) => {
          const t = byLabel(o.trialId);
          return run(taskId, model, t ? { ...o, signal: o.signal ? AbortSignal.any([o.signal, t.controller.signal]) : t.controller.signal } : o);
        },
      },
    );
    const done = batch.then(
      (result) => {
        view.stopped = result.stopped?.code ?? null;
        const why = result.stopped ? `batch stopped (${result.stopped.code}): ${result.stopped.message}` : controller.signal.aborted ? 'batch cancelled' : 'the batch ended before this trial ran';
        for (const t of entries) endTrial(t, controller.signal.aborted || t.controller.signal.aborted ? 'cancelled' : 'error', why);
      },
      (e: unknown) => {
        view.stopped = e instanceof SpendRefused ? `spend_refused_${e.cap}` : e instanceof BatchRefused ? 'refused' : 'error';
        say(`run ${runId}: ${(e as Error).message}`);
        for (const t of entries) endTrial(t, 'error', `batch ${view.stopped}: ${(e as Error).message}`);
      },
    ).finally(() => {
      view.done = true;
      if (pending.get(runId) === term) pending.delete(runId);
      batchKeys.delete(key);
    });
    const entry: RunEntry = { view, controller, done };
    runs.push(entry);
    const ran = await Promise.race([started.then(() => true), batch.then(() => false, () => false)]);
    if (ran) {
      sessionCap = body.session_cap_usd;
      return { status: 202, body: { run_id: runId, trial_ids: view.trial_ids } };
    }

    // Refused or cancelled before its grant: no call was made. It leaves no run or trial.
    const outcome = await batch.then(() => null, (e: unknown) => e);
    await done;
    runs.splice(runs.indexOf(entry), 1);
    for (const t of entries) if (trials.get(t.id) === t) trials.delete(t.id);
    if (outcome === null) throw new HttpError(503, 'shutting_down', 'the runner is shutting down');
    const message = scrub(outcome instanceof Error ? outcome.message : String(outcome));
    if (outcome instanceof BatchRefused) return { status: 409, body: { error: { type: 'batch_refused', message: `This batch could not start: ${message}` }, projection } };
    if (outcome instanceof SpendRefused) return { status: 409, body: { error: { type: `spend_refused_${outcome.cap}`, message }, projection } };
    return { status: 500, body: { error: { type: 'runner_error', message } } };
  }

  async function startSmoke(body: TrialsRequest, tasks: TaskSource): Promise<{ status: number; body: unknown }> {
    if (!forcedFail) throw new HttpError(400, 'invalid_request', 'Smoke trials are turned off in this runner.');
    world ??= repoWorld();
    const w = world;
    const taken = existsSync(runsDir) ? readdirSync(runsDir).filter((d) => /^smoke-\d+$/.test(d)).map((d) => Number(d.slice(6))) : [];
    const runId = `smoke-${Math.max(0, ...taken, ...runs.map((r) => (/^smoke-(\d+)$/.exec(r.view.run_id)?.[1] ?? 0)).map(Number)) + 1}`;
    const sink = nodeResultSink(join(runsDir, runId));
    const controller = new AbortController();
    const entries = body.tasks.flatMap((taskId) => Array.from({ length: body.trials }, (_, index) => newTrial(runId, taskId, index, null)));
    const view: RunView = { run_id: runId, started: new Date().toISOString(), mock: true, smoke: true, tasks: body.tasks, trials: body.trials, trial_ids: entries.map((t) => t.id), done: false, stopped: null };
    const done = (async () => {
      for (const t of entries) {
        if (controller.signal.aborted) break;
        // Keyed on the task's env_version, as planBatch keys a batch's trials (packages/core/batch.ts).
        const { env_version } = await taskVersions(await tasks.get(t.taskId), w.worldHash);
        const k: TrialKey = { task_id: t.taskId, env_version, model: MODEL, effort: body.effort, index: t.index };
        await sink.begin(k, 'smoke');
        t.state = 'running';
        const { record } = await run(t.taskId, MODEL, {
          tasks, client: forcedFailClient(), judge: null, world: w.world, worldHash: w.worldHash, definitions: w.definitions, now: nodeNow, effort: body.effort,
          trialId: `smoke:${runId}:${t.taskId}/${t.index}`, checks: await taskChecks(t.taskId), signal: AbortSignal.any([controller.signal, t.controller.signal]),
          onEvent: (e) => {
            sink.event(k, 'smoke', e);
            pushEvent(t, e);
          },
        });
        const stored: BatchRecord & { mock: true } = { ...record, run_id: runId, index: t.index, attempt: 'smoke', mode: 'mock-forced-fail', settled: true, mock: true };
        await sink.finish(k, stored);
        t.record = stored as unknown as Record<string, unknown>;
        endTrial(t, record.outcome === 'CANCELLED' ? 'cancelled' : 'graded', null);
      }
    })().then(
      () => {
        for (const t of entries) endTrial(t, 'cancelled', 'smoke run cancelled');
      },
      (e: unknown) => {
        view.stopped = 'error';
        for (const t of entries) endTrial(t, 'error', (e as Error).message);
      },
    ).finally(() => {
      view.done = true;
    });
    runs.push({ view, controller, done });
    return { status: 202, body: { run_id: runId, trial_ids: view.trial_ids } };
  }

  // ---- the key ----

  async function postKey(key: string): Promise<{ status: number; body: unknown }> {
    const projection = validateWorstCaseUsd();
    // Refused before anything changes: the held key stays as it was.
    const cap = sessionCap;
    const spent = cap === null ? 0 : committed(readRows(ledgerPath));
    if (cap !== null && spent + projection > cap) {
      return {
        status: 409,
        body: { error: { type: 'session_cap', message: `Validate can cost up to $${projection.toFixed(2)}, and with $${spent.toFixed(2)} already spent or running this session that would go over your session cap of $${cap.toFixed(2)}. Wait for the running trials to finish, then press Validate again.` } },
      };
    }
    heldKey = null;
    const label = `${opts.mock ? 'mock:' : ''}runner:validate`;
    const { ledger } = openNodeLedger({ transport: opts.mock ? 'offline' : 'live', env, runId: `${session}-key` });
    batchKeys.add(key);
    try {
      const grant = await ledger.batchStart(projection, cap === null ? undefined : ceilingAt(cap));
      try {
        const client = new MessagesClient({ grant, ledger, apiKey: key, fetch: transport(label), trial: label, maxAttempts: 1, log: (l) => say(`${label}: ${l}`), ...(opts.sleep ? { sleep: opts.sleep } : {}) });
        await client.send([...VALIDATE_REQUEST.history], VALIDATE_REQUEST.params);
      } finally {
        await grant.close();
      }
    } catch (e) {
      // The ledger's refusal is the runner's own text; an API error answers its class's fixed
      // message (see the header).
      if (e instanceof SpendRefused) return { status: 409, body: { error: { type: `spend_refused_${e.cap}`, message: redactText(e.message, [key]) } } };
      if (e instanceof ApiError) {
        const status = e.status === 401 || e.status === 403 || e.status === 429 ? e.status : 502;
        return { status, body: { error: { type: e.errorType ?? (e.status === null ? 'network_error' : `http_${e.status}`), message: validateFailed(e.status) } } };
      }
      say(`${label}: ${e instanceof Error ? e.name : 'error'}`);
      return { status: 500, body: { error: { type: 'runner_error', message: 'Validate failed inside the runner. Press Validate again.' } } };
    } finally {
      batchKeys.delete(key);
    }
    heldKey = key;
    return { status: 200, body: { key_set: true } };
  }

  // ---- HTTP ----

  const security = (res: ServerResponse) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
  };

  const json = (res: ServerResponse, status: number, body: unknown) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(text) });
    res.end(text);
  };

  const fail = (res: ServerResponse, status: number, type: string, message: string, api: boolean) => {
    if (api) json(res, status, { error: { type, message: scrub(message) } });
    else {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`${status} ${message}\n`);
    }
  };

  const tokenOk = (req: IncomingMessage) => {
    const got = req.headers[TOKEN_HEADER.toLowerCase()];
    if (typeof got !== 'string') return false;
    const a = Buffer.from(got);
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  async function readJson(req: IncomingMessage): Promise<unknown> {
    const type = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
    if (type !== 'application/json') throw new HttpError(415, 'unsupported_media_type', 'a POST body must be application/json');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > MAX_BODY_BYTES) throw new HttpError(413, 'too_large', `the body is over ${MAX_BODY_BYTES} bytes`);
      chunks.push(c as Buffer);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new HttpError(400, 'invalid_request', 'the body is not JSON');
    }
  }

  function health(): Health {
    return { app: RUNNER_APP, version: RUNNER_VERSION, ledger: { mode: ledgerMode, path: ledgerPath }, key_loaded: heldKey !== null, mock: opts.mock };
  }

  function stream(req: IncomingMessage, res: ServerResponse, t: TrialEntry) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    const last = Number(req.headers['last-event-id']);
    const from = typeof req.headers['last-event-id'] === 'string' && Number.isSafeInteger(last) && last >= 0 ? last + 1 : 0;
    for (let i = from; i < t.frames.length; i++) writeFrame(res, t, i);
    if (t.ended) {
      if (t.end !== null) res.write(sseFrame({ id: null, event: SSE_END, data: JSON.stringify(t.end) }));
      res.end();
      return;
    }
    t.subscribers.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), pingMs);
    res.on('close', () => {
      clearInterval(ping);
      t.subscribers.delete(res);
    });
  }

  async function api(req: IncomingMessage, res: ServerResponse, route: string, query: URLSearchParams): Promise<void> {
    const method = req.method ?? '';
    const template = apiTemplate(route);
    const allowed = (...m: string[]) => {
      if (!m.includes(method)) throw new HttpError(405, 'method_not_allowed', `${method} is not allowed on api/${template}`);
    };
    if ([...query.keys()].some((k) => !(k === 'dry_run' && route === 'trials' && method === 'POST'))) throw new HttpError(400, 'invalid_request', 'unknown query parameter');
    if (route === 'health') {
      allowed('GET', 'HEAD');
      return json(res, 200, health());
    }
    if (!tokenOk(req)) throw new HttpError(403, 'forbidden', `Reload the page: it was not served by this runner, or the runner restarted (missing or wrong ${TOKEN_HEADER}).`);
    if (route === 'key') {
      allowed('POST', 'DELETE');
      if (method === 'DELETE') {
        heldKey = null;
        return json(res, 200, { key_set: false });
      }
      const body = await readJson(req);
      let key: string;
      try {
        key = parseKeyRequest(body).key;
      } catch (e) {
        throw new HttpError(400, 'invalid_request', (e as Error).message);
      }
      const r = await postKey(key);
      return json(res, r.status, r.body);
    }
    if (route === 'runs') {
      allowed('GET');
      return json(res, 200, { runs: runs.map((r) => r.view) });
    }
    if (route === 'trials') {
      allowed('POST');
      const body = await readJson(req);
      let parsed: TrialsRequest;
      try {
        parsed = parseTrialsRequest(body);
      } catch (e) {
        throw new HttpError(400, 'invalid_request', e instanceof ContractError ? e.message : 'bad trials request');
      }
      if (stopping) throw new HttpError(503, 'shutting_down', 'the runner is shutting down');
      const r = await postTrials(parsed, query.get('dry_run') === '1');
      return json(res, r.status, r.body);
    }
    const m = TRIAL_ROUTE.exec(route);
    if (!m) throw new HttpError(404, 'not_found', 'no such route');
    const t = trials.get(m[1] as string);
    if (!t) throw new HttpError(404, 'not_found', `no such trial: api/${template}`);
    if (m[2]) {
      allowed('GET');
      return stream(req, res, t);
    }
    allowed('GET', 'DELETE');
    if (method === 'DELETE' && !t.ended) {
      t.controller.abort(cancelReason(`DELETE api/trials/${t.id}`));
      if (t.state === 'queued' && t.key === null) endTrial(t, 'cancelled', 'cancelled before it started');
    }
    return json(res, 200, viewOf(t));
  }

  // The built page under BASE; see the header.
  function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string, search: string): void {
    const method = req.method ?? '';
    if (method !== 'GET' && method !== 'HEAD') return fail(res, 405, 'method_not_allowed', 'Method Not Allowed', false);
    if (pathname === '/' || pathname === BASE.slice(0, -1)) {
      res.writeHead(302, { Location: `${BASE}${search}`, 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    if (!pathname.startsWith(BASE)) return fail(res, 404, 'not_found', 'Not Found', false);
    let segments: string[];
    try {
      segments = pathname.slice(BASE.length).split('/').map(decodeURIComponent);
    } catch {
      return fail(res, 404, 'not_found', 'Not Found', false);
    }
    if (segments.some((s) => s === '..' || s === '.' || /[/\\\0]/.test(s))) return fail(res, 404, 'not_found', 'Not Found', false);
    const rel = segments.filter((s) => s !== '').join('/');
    const name = basename(rel);
    if (TEST_PAGES.has(name.toLowerCase())) return fail(res, 404, 'not_found', 'Not Found', false);
    if (rel === '' || rel === 'index.html') return serveIndex(res, method);
    let root: string;
    try {
      root = realpathSync(dist);
    } catch {
      return fail(res, 404, 'not_found', 'Not Found: the UI is not built (pnpm build)', false);
    }
    let file: string | null = null;
    try {
      const real = realpathSync(join(root, rel));
      if (real.startsWith(root + sep) && statSync(real).isFile() && !TEST_PAGES.has(basename(real).toLowerCase())) file = real;
    } catch {
      file = null;
    }
    if (file === null) {
      // An app route (no extension) is the page; a missing or escaping file is not found.
      if (extname(name) === '' && !existsSync(join(root, rel))) return serveIndex(res, method);
      return fail(res, 404, 'not_found', 'Not Found', false);
    }
    const body = readFileSync(file);
    res.writeHead(200, { 'Content-Type': CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream', 'Content-Length': body.length, 'Cache-Control': 'no-cache' });
    res.end(method === 'HEAD' ? undefined : body);
  }

  function serveIndex(res: ServerResponse, method: string): void {
    const file = join(dist, 'index.html');
    if (!existsSync(file)) return fail(res, 404, 'not_found', 'Not Found: the UI is not built (pnpm build)', false);
    const html = readFileSync(file, 'utf8');
    const meta = `<meta name="${TOKEN_META}" content="${token}" />`;
    const csp = /<meta http-equiv="Content-Security-Policy"[^>]*>/.exec(html);
    const out = csp ? html.replace(csp[0], `${csp[0]}\n    ${meta}`) : html.replace(/<head>/i, `<head>\n    ${meta}`);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(out), 'Cache-Control': 'no-store' });
    res.end(method === 'HEAD' ? undefined : out);
  }

  let port = 0;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = performance.now();
    const raw = req.url ?? '/';
    const q = raw.indexOf('?');
    const pathname = q < 0 ? raw : raw.slice(0, q);
    const search = q < 0 ? '' : raw.slice(q);
    const apiRoute = pathname.startsWith('/api/') ? pathname.slice(5) : pathname.startsWith(`${BASE}api/`) ? pathname.slice(BASE.length + 4) : null;
    const shown = routeOf(pathname, apiRoute);
    res.on('finish', () => say(`${req.method} ${shown} ${res.statusCode} ${Math.round(performance.now() - started)}ms`));
    security(res);
    const isApi = apiRoute !== null;
    try {
      const host = req.headers.host;
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) throw new HttpError(403, 'forbidden_host', 'Host must be 127.0.0.1 or localhost on this port');
      const origin = req.headers.origin;
      if (origin !== undefined && origin !== `http://${host}`) throw new HttpError(403, 'forbidden_origin', 'cross-origin request refused');
      const site = req.headers['sec-fetch-site'];
      if (site !== undefined && site !== 'same-origin' && !(site === 'none' && !isApi)) throw new HttpError(403, 'forbidden_origin', 'cross-site request refused');
      if (req.method === 'OPTIONS') throw new HttpError(403, 'forbidden', 'no cross-origin access');
      const query = new URLSearchParams(search);
      if ([...query.keys()].some((k) => KEYISH.test(k)) || keyShaped(fullyDecoded(search))) {
        throw new HttpError(400, 'invalid_request', 'a key never goes in a URL; send it in a POST body');
      }
      if (isApi) await api(req, res, apiRoute, query);
      else serveStatic(req, res, pathname, search);
    } catch (e) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (e instanceof HttpError) fail(res, e.status, e.type, e.message, isApi || e.type.startsWith('forbidden'));
      else {
        // An unexpected error's text could hold anything the request carried: its name only.
        say(`${req.method} ${shown}: ${e instanceof Error ? e.name : 'error'}`);
        fail(res, 500, 'runner_error', 'the runner hit an unexpected error', true);
      }
    }
  }

  const server = createServer({ headersTimeout: HEADERS_TIMEOUT_MS, requestTimeout: REQUEST_TIMEOUT_MS, connectionsCheckingInterval: CONNECTIONS_CHECK_MS }, (req, res) => void handle(req, res));
  server.maxConnections = MAX_CONNECTIONS;
  port = await listen(server, opts.port ?? DEFAULT_PORT);

  async function shutdown(): Promise<boolean> {
    stopping = true;
    for (const r of runs) r.controller.abort(cancelReason('the runner is shutting down'));
    for (const t of trials.values()) if (!t.ended) t.controller.abort(cancelReason('the runner is shutting down'));
    const closed = await Promise.race([
      Promise.all(runs.map((r) => r.done)).then(() => true),
      new Promise<false>((r) => setTimeout(() => r(false), opts.shutdownWaitMs ?? SHUTDOWN_WAIT_MS).unref()),
    ]);
    for (const t of trials.values()) closeStreams(t);
    await new Promise<void>((r) => {
      server.close(() => r());
      server.closeAllConnections();
    });
    return closed;
  }

  return { server, port, url: `http://127.0.0.1:${port}${BASE}`, token, shutdown };
}
