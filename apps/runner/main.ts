// node apps/runner/main.ts [--port N] [--mock]
// The local runner behind the UI (plan phase P12b; server.ts has the contract). `pnpm start`
// builds the UI and runs this. It listens on 127.0.0.1 only, on --port, else CLINENV_PORT, else
// 5180, and on a free port the OS picks when that one is taken, saying so:
//   runner: port <asked> is in use; using port <port>
// then prints the URL it serves:
//   clinenv local runner: http://127.0.0.1:<port>/clinical-agent-env/
// then one line per request (method, path, status, duration). --mock answers every call from the
// toy scenario of `run-one --mock toy`: no network call. SIGINT or SIGTERM cancels every trial,
// waits for every batch to write its close row and exits 0; it exits 1 when a batch has not
// closed within the runner's 8 s wait, or when closing takes over 9 s in all.
//
// Test hooks, honored only when NODE_ENV=test and CLINENV_TEST_HOOKS=1 (NODE_ENV alone is not
// enough: other tools set it): CLINENV_WEB_DIST replaces apps/web/dist;
// CLINENV_RUNNER_TEST_TRANSPORT=toy answers every call from the toy scenario on the live code
// path (the key goes in x-api-key, nothing leaves the process), =stall holds every trial call
// until it is aborted.
import { installEgressGuard } from '../../packages/core/egress.ts';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { okResponse, scenarioTransport } from '../web/src/harness/scenarios.ts';
import type { Transport } from '../../packages/core/anthropic.ts';
import { DEFAULT_PORT, DIST, startRunner } from './server.ts';

const USAGE = 'usage: node apps/runner/main.ts [--port N] [--mock]';
const EXIT_WAIT_MS = 9_000;

function testTransport(kind: string | undefined): ((label: string) => Transport) | undefined {
  if (kind === 'toy') return (label) => (label.includes('validate') ? async () => okResponse({ text: 'OK' }, 1) : scenarioTransport('toy').transport);
  if (kind === 'stall') {
    // Each held call stays here until it aborts: a request's signal follows the client's only
    // weakly, so a call nothing holds could be collected with its abort listener and never end.
    const held = new Set<object>();
    return (label) => (label.includes('validate')
      ? async () => okResponse({ text: 'OK' }, 1)
      : (request) => {
        const entry: { request: Request; response?: Promise<Response> } = { request };
        held.add(entry);
        entry.response = new Promise<Response>((_, reject) => request.signal.addEventListener('abort', () => {
          held.delete(entry);
          reject(request.signal.reason);
        }, { once: true }));
        return entry.response;
      });
  }
  return undefined;
}

export async function main(args: string[], env: Record<string, string | undefined> = process.env): Promise<number> {
  let port: number | undefined;
  let mock = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--mock') mock = true;
    else if (a === '--port' && args[i + 1] !== undefined) port = Number(args[++i]);
    else {
      process.stderr.write(`runner: ${a === '--port' ? '--port needs a value' : `unknown argument ${a}`}\n${USAGE}\n`);
      return 2;
    }
  }
  port ??= env.CLINENV_PORT !== undefined && env.CLINENV_PORT !== '' ? Number(env.CLINENV_PORT) : DEFAULT_PORT;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    process.stderr.write(`runner: the port must be a whole number from 0 to 65535\n${USAGE}\n`);
    return 2;
  }
  const test = env.NODE_ENV === 'test' && env.CLINENV_TEST_HOOKS === '1';
  const dist = test && env.CLINENV_WEB_DIST ? env.CLINENV_WEB_DIST : DIST;
  const transport = test ? testTransport(env.CLINENV_RUNNER_TEST_TRANSPORT) : undefined;
  let runner;
  try {
    runner = await startRunner({ env, mock, port, dist, log: (l) => process.stdout.write(`${l}\n`), ...(transport ? { transport } : {}) });
  } catch (e) {
    process.stderr.write(`runner: ${(e as Error).message}\n`);
    return 1;
  }
  const r = runner;
  // The handlers go in before the URL is printed: whoever reads the URL may signal at once.
  const exited = new Promise<number>((resolveExit) => {
    let stopping = false;
    const stop = (signal: string) => {
      if (stopping) return;
      stopping = true;
      process.stdout.write(`runner: ${signal}: cancelling every trial and closing\n`);
      const late = setTimeout(() => {
        process.stderr.write(`runner: still closing after ${EXIT_WAIT_MS / 1000}s; exiting\n`);
        resolveExit(1);
      }, EXIT_WAIT_MS);
      late.unref();
      r.shutdown().then(
        (closed) => {
          clearTimeout(late);
          if (!closed) process.stderr.write('runner: a batch did not close in time; its ledger may show it still open\n');
          resolveExit(closed ? 0 : 1);
        },
        (e: unknown) => {
          clearTimeout(late);
          process.stderr.write(`runner: shutdown failed: ${(e as Error).message}\n`);
          resolveExit(1);
        },
      );
    };
    process.once('SIGINT', () => stop('SIGINT'));
    process.once('SIGTERM', () => stop('SIGTERM'));
  });
  if (!existsSync(join(dist, 'index.html'))) process.stderr.write(`runner: ${dist} has no index.html; build the UI first (pnpm build)\n`);
  if (port !== 0 && runner.port !== port) process.stdout.write(`runner: port ${port} is in use; using port ${runner.port}\n`);
  process.stdout.write(`clinenv local runner: ${runner.url}\n`);
  return exited;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  installEgressGuard(globalThis);
  process.exit(await main(process.argv.slice(2)));
}
