// pnpm cli runner-check [--mock | --live] [--dry-run] [--json]
// Checks the local runner (apps/runner, plan phase P12b) end to end as the UI uses it. It builds
// nothing: it fails with exit 1 if apps/web/dist is missing (run `pnpm build` first). It spawns
// `node apps/runner/main.ts --port 0` on a free port without ANTHROPIC_API_KEY in its environment,
// then checks: GET /api/health (the runner's contract body, no key loaded); the served
// index.html (200, its CSP meta equal to the one in apps/web/index.html, a token meta); that a
// foreign Origin and a foreign Host are refused; then posts one _toy trial to POST /api/trials
// and reads its SSE stream to the graded event.
//   --mock     (default) the runner runs with --mock, and the check also runs
//              `run-one --task _toy --mock toy` and compares the streamed events with its
//              trajectory, timestamps stripped. Both children get an environment with no
//              CLINENV_CANONICAL_LEDGER and HOME, SPEND_LEDGER and CLINENV_RUNS_DIR inside one
//              fresh temp dir, deleted afterwards, so a mocked check writes no row to the
//              canonical ledger and nothing under the caller's ~/.clinenv.
//   --live     ANTHROPIC_API_KEY stands in for a key typed into the UI: it is sent only in the
//              POST /api/key body. The runner meters through the caller's ledger (the live-run
//              form's own-run marker); its runs dir is a temp dir kept for keyscan and printed.
//              The graded trial must report models_returned [claude-opus-5-5] and replay_final
//              equal to final.
//   --dry-run  stops after POST /api/trials?dry_run=1 and prints what a live check can spend, the
//              trial's projection plus the Validate call's worst case, as LIVE_PROJECTION_USD=<x>,
//              for `pnpm cli spend --check --projected <x>`. It makes no call: under --live the
//              key is not sent.
//   --json     prints one JSON report instead of lines.
// Exit 0 when every check holds; 1 otherwise; 2 on a usage error. The key is never printed.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MODEL } from '../packages/core/anthropic.ts';
import { installEgressGuard } from '../packages/core/egress.ts';
import type { TrialEvent } from '../packages/core/events.ts';
import { PROJECTED_CAP_USD } from '../packages/core/ledger.ts';
import { redactText } from '../packages/core/redact.ts';
import { parseDryRun, parseHealth, parseSse, parseTrialsAccepted, TOKEN_HEADER, TOKEN_META, validateWorstCaseUsd, type SseFrame } from '../packages/core/runner-api.ts';
import { stripTimestamps } from '../packages/core/trajectory.ts';

const REPO = fileURLToPath(new URL('../', import.meta.url));
const BASE = '/clinical-agent-env/';
const USAGE = 'usage: pnpm cli runner-check [--mock | --live] [--dry-run] [--json]';
const START_MS = 30_000;
const MOCK_TRIAL_MS = 120_000;
const LIVE_TRIAL_MS = 35 * 60_000;
// What the report shows of each child's environment.
const SHOWN = ['HOME', 'SPEND_LEDGER', 'CLINENV_RUNS_DIR', 'CLINENV_CANONICAL_LEDGER', 'ANTHROPIC_API_KEY'] as const;

type Env = Record<string, string | undefined>;
type Mode = 'mock' | 'live';

// The environment of the runner and of run-one: never the key; under --mock, no canonical
// ledger and HOME, SPEND_LEDGER and CLINENV_RUNS_DIR inside tmp.
export function childEnv(parent: Env, tmp: string, mode: Mode): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(parent)) if (v !== undefined && k !== 'ANTHROPIC_API_KEY') env[k] = v;
  if (mode === 'mock') {
    delete env.CLINENV_CANONICAL_LEDGER;
    env.HOME = join(tmp, 'home');
    env.SPEND_LEDGER = join(tmp, 'spend.jsonl');
  }
  env.CLINENV_RUNS_DIR = join(tmp, 'runs');
  return env;
}

const shown = (env: Record<string, string>) =>
  Object.fromEntries(SHOWN.map((k) => [k, env[k] === undefined ? null : k === 'ANTHROPIC_API_KEY' ? '[set]' : env[k]]));

// The CSP meta content of apps/web/index.html: the design string.
function designCsp(): string | null {
  return /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(readFileSync(join(REPO, 'apps/web/index.html'), 'utf8'))?.[1] ?? null;
}

interface Reply {
  status: number;
  text: string;
  headers: Record<string, string | string[] | undefined>;
}

function http(port: number, method: string, path: string, opts: { host?: string; origin?: string; token?: string; body?: unknown } = {}): Promise<Reply> {
  const host = opts.host ?? `127.0.0.1:${port}`;
  const headers: Record<string, string> = { host };
  if (opts.origin !== undefined) headers.origin = opts.origin;
  else if (method !== 'GET') headers.origin = `http://${host}`;
  if (opts.token !== undefined) headers[TOKEN_HEADER] = opts.token;
  const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  if (payload !== undefined) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(Buffer.byteLength(payload));
  }
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers, setHost: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text, headers: res.headers }));
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

function readStream(port: number, path: string, token: string, timeoutMs: number): Promise<SseFrame[]> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method: 'GET', path, headers: { host: `127.0.0.1:${port}`, [TOKEN_HEADER]: token, accept: 'text/event-stream' }, setHost: false }, (res) => {
      let text = '';
      const timer = setTimeout(() => {
        req.destroy();
        reject(new Error(`the event stream was still open after ${timeoutMs / 1000}s`));
      }, timeoutMs);
      res.setEncoding('utf8');
      res.on('data', (c: string) => (text += c));
      res.on('end', () => {
        clearTimeout(timer);
        if (res.statusCode !== 200) reject(new Error(`GET ${path}: ${res.statusCode}`));
        else resolve(parseSse(text).frames);
      });
    });
    req.on('error', reject);
    req.end();
  });
}

export interface Deps {
  env: Env;
  out: (line: string) => void;
}

const defaults: Deps = { env: process.env, out: (l) => process.stdout.write(`${l}\n`) };

export async function main(args: string[], deps: Deps = defaults): Promise<number> {
  const flags = new Set<string>();
  for (const a of args) {
    if (!['--mock', '--live', '--dry-run', '--json'].includes(a)) return usage(deps, `unknown argument ${a}`);
    flags.add(a);
  }
  if (flags.has('--mock') && flags.has('--live')) return usage(deps, '--mock and --live are exclusive');
  const mode: Mode = flags.has('--live') ? 'live' : 'mock';
  const json = flags.has('--json');
  const env = deps.env;
  const key = mode === 'live' ? (env.ANTHROPIC_API_KEY ?? '') : '';
  const say = (line: string) => {
    if (!json) deps.out(redactText(line, [key]));
  };
  // The runner's test hook (apps/runner/main.ts), read the same way here.
  const dist = env.NODE_ENV === 'test' && env.CLINENV_TEST_HOOKS === '1' && env.CLINENV_WEB_DIST ? env.CLINENV_WEB_DIST : join(REPO, 'apps/web/dist');
  if (!existsSync(join(dist, 'index.html'))) {
    deps.out(`runner-check: apps/web/dist is missing (${dist} has no index.html); run pnpm build first`);
    return 1;
  }
  if (mode === 'live' && key === '') {
    deps.out('runner-check: --live needs ANTHROPIC_API_KEY, which stands in for the key typed into the UI');
    return 1;
  }

  const tmp = mkdtempSync(join(tmpdir(), 'clinenv-runner-check-'));
  const runnerEnv = childEnv(env, tmp, mode);
  const runOneEnv = childEnv(env, tmp, 'mock');
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
  const check = (name: string, ok: boolean, detail: string) => {
    const d = redactText(detail, [key]);
    checks.push({ name, ok, detail: d });
    say(`${ok ? 'ok' : 'FAIL'} ${name}: ${d}`);
    return ok;
  };
  const runnerLog: string[] = [];
  let eventsEqual: boolean | null = null;
  let projection: number | null = null;
  let liveProjection: number | null = null;

  const child = spawn(process.execPath, [join(REPO, 'apps/runner/main.ts'), '--port', '0', ...(mode === 'mock' ? ['--mock'] : [])], { env: runnerEnv, cwd: REPO });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c: string) => {
    out += c;
    runnerLog.push(...c.split('\n').filter((l) => l !== '').map((l) => redactText(l, [key])));
  });
  child.stderr.on('data', (c: string) => runnerLog.push(...c.split('\n').filter((l) => l !== '').map((l) => `stderr: ${redactText(l, [key])}`)));
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  try {
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`the runner printed no URL in ${START_MS / 1000}s`)), START_MS);
      const look = () => {
        const m = /^clinenv local runner: (http:\/\/127\.0\.0\.1:\d+\/clinical-agent-env\/)$/m.exec(out);
        if (m) {
          clearTimeout(timer);
          resolve(m[1] as string);
        }
      };
      child.stdout.on('data', look);
      void exited.then((code) => reject(new Error(`the runner exited with ${code} before printing its URL: ${runnerLog.join(' | ')}`)));
    });
    const port = Number(new URL(url).port);
    check('started', true, url);

    const h = await http(port, 'GET', '/api/health');
    let healthOk = false;
    let detail = `status ${h.status}`;
    try {
      const health = parseHealth(JSON.parse(h.text));
      healthOk = h.status === 200 && !health.key_loaded && health.mock === (mode === 'mock');
      detail = `ledger ${health.ledger.mode} ${health.ledger.path}, key_loaded ${health.key_loaded}, mock ${health.mock}`;
    } catch (e) {
      detail += `: ${(e as Error).message}`;
    }
    check('health', healthOk, detail);

    const page = await http(port, 'GET', BASE);
    const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(page.text)?.[1] ?? null;
    const token = new RegExp(`<meta name="${TOKEN_META}" content="([0-9a-f]{64})"`).exec(page.text)?.[1] ?? null;
    check('index.html', page.status === 200 && csp !== null && csp === designCsp() && token !== null, `status ${page.status}, CSP meta ${csp === designCsp() ? 'equals' : 'differs from'} apps/web/index.html, token meta ${token === null ? 'missing' : 'present'}`);
    if (token === null) throw new Error('no token meta: the API checks cannot run');

    const foreignOrigin = await http(port, 'POST', '/api/key', { origin: 'http://evil.example', token, body: { key: 'not-a-key-foreign-origin' } });
    check('foreign origin refused', foreignOrigin.status >= 400 && foreignOrigin.status < 500, `Origin http://evil.example: ${foreignOrigin.status}`);
    const foreignHost = await http(port, 'GET', '/api/health', { host: `evil.example:${port}` });
    check('foreign host refused', foreignHost.status >= 400 && foreignHost.status < 500, `Host evil.example:${port}: ${foreignHost.status}`);

    const trial = { tasks: ['_toy'], trials: 1, concurrency: 1, effort: 'high', session_cap_usd: PROJECTED_CAP_USD };
    const dry = await http(port, 'POST', '/api/trials?dry_run=1', { token, body: trial });
    try {
      projection = parseDryRun(JSON.parse(dry.text)).projection.total_usd;
      const validate = validateWorstCaseUsd();
      liveProjection = projection + validate;
      check('dry run', dry.status === 200, `trial projection $${projection.toFixed(6)} + Validate worst case $${validate.toFixed(6)}, 0 calls`);
      say(`LIVE_PROJECTION_USD=${liveProjection.toFixed(6)}`);
    } catch (e) {
      check('dry run', false, `status ${dry.status}: ${(e as Error).message}`);
    }

    // The key goes to the runner only for a trial: a dry run makes no call, not even Validate.
    if (mode === 'live' && !flags.has('--dry-run') && checks.every((c) => c.ok)) {
      const k = await http(port, 'POST', '/api/key', { token, body: { key } });
      check('key validated', k.status === 200, `POST /api/key: ${k.status}${k.status === 200 ? '' : ` ${k.text.slice(0, 300)}`}`);
    }
    if (!flags.has('--dry-run') && projection !== null && checks.every((c) => c.ok)) {
      // The session cap: this trial's projection on top of what the session spent (Validate).
      const again = parseDryRun(JSON.parse((await http(port, 'POST', '/api/trials?dry_run=1', { token, body: trial })).text)).projection;
      const cap = again.total_usd + again.session_spent_usd;
      const posted = await http(port, 'POST', '/api/trials', { token, body: { ...trial, session_cap_usd: cap } });
      if (posted.status !== 202) throw new Error(`POST /api/trials: ${posted.status} ${posted.text.slice(0, 400)}`);
      const accepted = parseTrialsAccepted(JSON.parse(posted.text));
      const id = accepted.trial_ids[0] as string;
      const frames = await readStream(port, `/api/trials/${id}/events`, token, mode === 'mock' ? MOCK_TRIAL_MS : LIVE_TRIAL_MS);
      const last = frames.at(-1);
      const graded = last?.event === 'graded' ? (JSON.parse(last.data) as Extract<TrialEvent, { type: 'graded' }>).record : null;
      check('trial streamed', posted.status === 202 && graded !== null, `${accepted.run_id}: ${frames.length} events, last ${last?.event ?? 'none'}${graded ? `, outcome ${graded.outcome}, status ${graded.status}, cost $${(graded.cost_usd + graded.judge_cost_usd).toFixed(4)}` : ''}`);
      if (graded !== null) {
        check('graded record', graded.models_returned.length === 1 && graded.models_returned[0] === MODEL && graded.state_hash.final !== null && graded.state_hash.replay_final === graded.state_hash.final,
          `models_returned ${JSON.stringify(graded.models_returned)}, final ${graded.state_hash.final}, replay_final ${graded.state_hash.replay_final}`);
      }
      if (mode === 'mock') {
        const outDir = join(tmp, 'run-one');
        const r = spawnSync(process.execPath, [join(REPO, 'cli/index.ts'), 'run-one', '--task', '_toy', '--model', MODEL, '--mock', 'toy', '--out', outDir], { env: runOneEnv, cwd: REPO, encoding: 'utf8' });
        const file = join(outDir, 'trajectories', '_toy', MODEL, 'high', 'mock-toy', '0.jsonl');
        if (r.status !== 0 || !existsSync(file)) check('events equal run-one', false, `run-one exit ${r.status}: ${(r.stdout + r.stderr).slice(-400)}`);
        else {
          const streamed = stripTimestamps(frames.map((f) => `${f.data}\n`).join(''));
          const written = stripTimestamps(readFileSync(file, 'utf8'));
          eventsEqual = streamed === written;
          const a = streamed.split('\n');
          const b = written.split('\n');
          const at = a.findIndex((line, i) => line !== b[i]);
          check('events equal run-one', eventsEqual, eventsEqual ? `${a.length - 1} lines equal, timestamps stripped` : `line ${at + 1} differs (${a.length - 1} streamed, ${b.length - 1} written)`);
        }
      }
    }
  } catch (e) {
    check('runner check', false, (e as Error).message);
  } finally {
    child.kill('SIGINT');
    const deadline = new Promise<'late'>((resolve) => setTimeout(() => resolve('late'), 10_000).unref());
    const code = await Promise.race([exited, deadline]);
    if (code === 'late') child.kill('SIGKILL');
    check('runner exit', code === 0, code === 'late' ? 'still running 10 s after SIGINT' : `exit ${code} after SIGINT`);
    if (mode === 'mock') rmSync(tmp, { recursive: true, force: true });
    else say(`runs dir ${join(tmp, 'runs')} (keyscan it)`);
  }
  for (const line of runnerLog) say(`runner| ${line}`);
  const ok = checks.every((c) => c.ok);
  if (json) {
    deps.out(JSON.stringify({
      ok, mode, checks, events_equal: eventsEqual, projection_usd: projection, live_projection_usd: liveProjection, tmp, runs_dir: join(tmp, 'runs'),
      envs: { runner: shown(runnerEnv), run_one: shown(runOneEnv) }, runner_log: runnerLog,
    }, null, 2));
  } else say(`runner-check: ${checks.filter((c) => c.ok).length}/${checks.length} checks passed`);
  return ok ? 0 : 1;
}

function usage(deps: Deps, problem: string): number {
  deps.out(`runner-check: ${problem}\n${USAGE}`);
  return 2;
}

export default (args: string[]) => main(args);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  installEgressGuard(globalThis);
  process.exitCode = await main(process.argv.slice(2));
}
