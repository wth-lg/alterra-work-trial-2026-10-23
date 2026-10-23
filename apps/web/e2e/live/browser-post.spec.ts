import { expect, test, type CDPSession } from '@playwright/test';
import { API_ORIGIN, type ProbeResult } from '../../../../packages/core/anthropic.ts';
import { money } from '../../../../packages/core/cost.ts';
import { redactHeaders, redactText } from '../../../../packages/core/redact.ts';
import { openNodeLedger, reserveSpend, settleSpend } from '../../../../cli/adapters/ledger-node.ts';
import { PROBE_TOOL, probeProjection, probeReserveRequest } from '../../src/probe/request.ts';

// Can Chromium, on a page served by `vite preview` under the production CSP meta, POST to the
// Messages API and parse a tool_use? The Node side meters the browser's call: batchStart and
// a worst-case reservation before it, a settle with the call's usage after, so a crash
// leaves a worst-case reservation, never an unrecorded charge.
// LIVE_DRY_RUN=1 prints the projection and makes no call. On a TypeError the spec prints the
// request, any preflight, the response headers and the console, every header set redacted.
const KEY = process.env.ANTHROPIC_API_KEY ?? '';
const DRY_RUN = process.env.LIVE_DRY_RUN === '1';
const TRIAL = 'p2:browser-post';

// Every live spec starts with this skip: without a key the live project lists the spec and
// reports it skipped instead of failing. A dry run needs no key.
test.skip(!KEY && !DRY_RUN, 'ANTHROPIC_API_KEY is not set');

const redact = (h: Record<string, string>) => redactHeaders(h, [KEY]);

// Network events for API requests, preflights included, from Playwright and from CDP (which
// also sees the preflight and the CORS error). Headers are redacted as they are recorded.
function recordNetwork(page: import('@playwright/test').Page, cdp: CDPSession) {
  const log: unknown[] = [];
  const api = (url: string) => url.startsWith(API_ORIGIN);
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
  const network = recordNetwork(page, cdp);

  await page.goto('./probe.html');
  await expect(page.locator('body[data-page="probe"]')).toBeAttached();

  const { ledger, mode } = openNodeLedger({ transport: 'live' });
  console.log(`ledger mode ${mode}`);
  const grant = await ledger.batchStart(projection);
  let result: ProbeResult;
  try {
    const reservation = await reserveSpend(grant, req);
    try {
      result = await page.evaluate((key) => (window.chartrProbe as (k: string) => Promise<ProbeResult>)(key), KEY);
    } catch (e) {
      await settleSpend(grant, reservation, null);
      // Redacted in place: a wrapping error's cause would carry the original text.
      const err = e as Error;
      err.message = redactText(err.message, [KEY]);
      if (err.stack) err.stack = redactText(err.stack, [KEY]);
      throw err;
    }
    // An unknown outcome settles at the worst case.
    await settleSpend(grant, reservation, result.status === 200 ? result.usage : null);
  } finally {
    await grant.close();
  }

  const parsed = result.status === 200 && result.tool_use?.name === PROBE_TOOL;
  if (parsed) {
    console.log(`browser POST 200 tool_use parsed: ${PROBE_TOOL} ${JSON.stringify(result.tool_use?.input)} (model ${result.model})`);
    return;
  }
  console.log(`browser POST failed: status ${result.status ?? 'none'}, ${result.error ? `${result.error.name}: ${result.error.message}` : `stop_reason ${result.stop_reason}`}`);
  console.log(`evidence ${JSON.stringify({ network, console: console_ }, null, 2)}`);
  expect(parsed, 'browser POST 200 with a parsed tool_use').toBe(true);
});
