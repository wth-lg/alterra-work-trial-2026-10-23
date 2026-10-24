import { expect, test, type CDPSession } from '@playwright/test';
import { MessagesClient, type CallResult } from '../../../../packages/core/anthropic.ts';
import { money } from '../../../../packages/core/cost.ts';
import { redactHeaders, redactText } from '../../../../packages/core/redact.ts';
import { openNodeLedger } from '../../../../cli/adapters/ledger-node.ts';
import { PROBE_PARAMS, PROBE_TOOL, probeHistory, probeProjection, probeReserveRequest } from '../../src/probe/request.ts';
import { relayFetch, type PageReply } from '../../src/probe/transport.ts';

// Can Chromium, on a page served by `vite preview` under the production CSP meta, POST to the
// Messages API and parse a tool_use? The call goes through MessagesClient in this Node process,
// with the probe page as its fetch: batchStart before it, a worst-case reservation before the
// browser sends, a settle after (at its usage on a 200, $0 on an HTTP error status, the worst
// case when the outcome is unknown), so a crash leaves a worst-case reservation, never an
// unrecorded charge. One attempt, no retry: the check measures a single browser POST.
// LIVE_DRY_RUN=1 prints the projection and makes no call. On a failure the spec prints the
// request, any preflight, the response headers and the console, every header set redacted.
const KEY = process.env.ANTHROPIC_API_KEY ?? '';
const DRY_RUN = process.env.LIVE_DRY_RUN === '1';
const TRIAL = 'p2:browser-post';

// Every live spec starts with this skip: without a key the live project lists the spec and
// reports it skipped instead of failing. A dry run needs no key.
test.skip(!KEY && !DRY_RUN, 'ANTHROPIC_API_KEY is not set');

const redact = (h: Record<string, string>) => redactHeaders(h, [KEY]);

// Network events for the API request the client sent (`sent.url`), preflight included, from
// Playwright and from CDP (which also sees the preflight and the CORS error). Headers are
// redacted as they are recorded.
function recordNetwork(page: import('@playwright/test').Page, cdp: CDPSession, sent: { url?: string }) {
  const log: unknown[] = [];
  const api = (url: string) => sent.url !== undefined && url === sent.url;
  page.on('request', async (r) => {
    if (api(r.url())) log.push({ source: 'playwright', event: 'request', method: r.method(), url: r.url(), headers: redact(await r.allHeaders()) });
  });
  page.on('response', async (r) => {
    if (api(r.url())) log.push({ source: 'playwright', event: 'response', status: r.status(), url: r.url(), headers: redact(await r.allHeaders()) });
  });
  page.on('requestfailed', (r) => {
    if (api(r.url())) log.push({ source: 'playwright', event: 'requestfailed', url: r.url(), failure: r.failure()?.errorText ?? null });
  });
  const ids = new Set<string>();
  cdp.on('Network.requestWillBeSent', (e) => {
    if (!api(e.request.url)) return;
    ids.add(e.requestId);
    log.push({ source: 'cdp', event: 'requestWillBeSent', type: e.type ?? null, method: e.request.method, url: e.request.url, headers: redact(e.request.headers) });
  });
  cdp.on('Network.requestWillBeSentExtraInfo', (e) => {
    if (ids.has(e.requestId)) log.push({ source: 'cdp', event: 'requestExtraInfo', headers: redact(e.headers) });
  });
  cdp.on('Network.responseReceivedExtraInfo', (e) => {
    if (ids.has(e.requestId)) log.push({ source: 'cdp', event: 'responseExtraInfo', status: e.statusCode, headers: redact(e.headers) });
  });
  cdp.on('Network.loadingFailed', (e) => {
    if (ids.has(e.requestId)) log.push({ source: 'cdp', event: 'loadingFailed', errorText: e.errorText, blockedReason: e.blockedReason ?? null, corsErrorStatus: e.corsErrorStatus ?? null });
  });
  return log;
}

test('browser POST to the Messages API returns 200 with a parsed tool_use', async ({ page }) => {
  const req = probeReserveRequest(TRIAL);
  const projection = probeProjection();
  if (DRY_RUN) {
    console.log(`browser-post dry run: 1 call, worst case for ${req.bodyBytes} body bytes and max_tokens ${req.maxTokens}`);
    console.log(`projection ${money(projection)}`);
    console.log(`LIVE_PROJECTION_USD=${projection.toFixed(6)}`);
    return;
  }

  const console_: string[] = [];
  page.on('console', (m) => console_.push(`${m.type()}: ${redactText(m.text(), [KEY])}`));
  page.on('pageerror', (e) => console_.push(`pageerror: ${redactText(e.message, [KEY])}`));
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  const sent: { url?: string; browserError?: string } = {};
  const network = recordNetwork(page, cdp, sent);

  await page.goto('./probe.html');
  await expect(page.locator('body[data-page="probe"]')).toBeAttached();
  const viaPage = relayFetch(async (url, r) => {
    sent.url = url;
    const reply = await page.evaluate(([u, x]) => (window.clinenvFetch as (u: string, x: unknown) => Promise<PageReply>)(u, x), [url, r] as const);
    if ('error' in reply) sent.browserError = redactText(`${reply.error.name}: ${reply.error.message}`, [KEY]);
    return reply;
  });

  const { ledger, mode } = openNodeLedger({ transport: 'live' });
  console.log(`ledger mode ${mode}`);
  const grant = await ledger.batchStart(projection);
  let result: CallResult | null = null;
  let failure: Error | null = null;
  try {
    const client = new MessagesClient({ grant, ledger, apiKey: KEY, fetch: viaPage, trial: TRIAL, maxAttempts: 1, log: (l) => console.log(l) });
    result = await client.send(probeHistory(), PROBE_PARAMS);
  } catch (e) {
    // MessagesClient redacts the key from its errors; anything else is redacted here.
    failure = e as Error;
    failure.message = redactText(failure.message, [KEY]);
    if (failure.stack) failure.stack = redactText(failure.stack, [KEY]);
  } finally {
    await grant.close();
  }

  const tool = result?.message.content.find((b) => b.type === 'tool_use' && b.name === PROBE_TOOL);
  if (result?.status === 200 && tool) {
    console.log(`browser POST 200 tool_use parsed: ${PROBE_TOOL} ${JSON.stringify(tool.input)} (model ${result.message.model})`);
    return;
  }
  const status = failure && 'status' in failure ? String(failure.status) : String(result?.status ?? 'none');
  console.log(`browser POST failed: status ${status}, ${sent.browserError ?? (failure ? `${failure.name}: ${failure.message}` : `stop_reason ${result?.message.stop_reason}`)}`);
  console.log(`evidence ${JSON.stringify({ network, console: console_ }, null, 2)}`);
  expect(Boolean(tool), 'browser POST 200 with a parsed tool_use').toBe(true);
});
