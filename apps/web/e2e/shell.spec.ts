import { expect, test, type Page, type Request, type Route } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { MODEL } from '../../../packages/core/anthropic.ts';
import { HEALTH_PATH, KEY_PATH, SAMPLES, TOKEN_HEADER, TOKEN_META } from '../../../packages/core/runner-api.ts';
import { admitTrial, DEFAULT_SESSION_CAP_USD } from '../src/spend/cap.ts';
import { LOCAL_START_COMMAND } from '../src/surface/command.ts';

// The app shell against a mocked API: the runner's /api/health and /api/key are route-mocked
// from the runner-api.ts samples, the Messages API from SSE written here. The API origin is
// read from the page's CSP meta, so this file names no API host (lint: no-direct-anthropic).
const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const CSP = /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(indexHtml)?.[1] ?? '';
const API_ORIGIN = /connect-src 'self' (\S+);/.exec(CSP)?.[1] ?? '';
const ORG_CORS = 'CORS requests are not allowed for this Organization because of its settings.';

// Built at runtime so no key-shaped literal is committed (pnpm keyscan).
const sentinelKey = () => ['sk', 'ant', 'api03', randomUUID().replaceAll('-', ''), 'e2e'].join('-');

const isApi = (url: string) => new URL(url).origin === API_ORIGIN;
// The runner paths are relative to the page base.
const isPath = (url: URL, path: string) => url.pathname.endsWith(`/${path}`);
const json = (route: Route, status: number, body: unknown, headers: Record<string, string> = {}) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body), headers });

// Every request the page makes after `since()` resets the list, but fonts, styles and images
// the newly shown screen pulls from the page's own origin.
const ASSETS = new Set(['font', 'stylesheet', 'image']);
function recordRequests(page: Page) {
  let list: Request[] = [];
  page.on('request', (r) => (ASSETS.has(r.resourceType()) && !isApi(r.url()) ? undefined : list.push(r)));
  return { since: () => (list = []), get: () => list };
}

// localStorage, sessionStorage and every IndexedDB record, as one string to search for a key.
async function storageDump(page: Page): Promise<{ local: string; session: string; idb: string }> {
  return page.evaluate(async () => {
    const dump = (s: Storage) => JSON.stringify(Object.fromEntries(Object.keys(s).map((k) => [k, s.getItem(k)])));
    const records: unknown[] = [];
    for (const info of await indexedDB.databases()) {
      if (!info.name) continue;
      const db = await new Promise<IDBDatabase>((res, rej) => {
        const r = indexedDB.open(info.name!);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      for (const store of db.objectStoreNames) {
        const all = await new Promise<unknown[]>((res, rej) => {
          const r = db.transaction(store).objectStore(store).getAll();
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });
        records.push(info.name, store, all);
      }
      db.close();
    }
    return { local: dump(localStorage), session: dump(sessionStorage), idb: JSON.stringify(records) };
  });
}

// The local runner: health answers as chartr-runner, index.html carries the runner's token
// meta, and /api/key accepts a POST and a DELETE.
async function mockLocalRunner(page: Page, token: string) {
  const keyCalls: Array<{ method: string; token: string | null; body: string | null; url: string }> = [];
  await page.route((url) => isPath(url, HEALTH_PATH), (route) => json(route, 200, SAMPLES.health));
  await page.route((url) => isPath(url, KEY_PATH), async (route) => {
    const r = route.request();
    keyCalls.push({ method: r.method(), token: (await r.headerValue(TOKEN_HEADER)) ?? null, body: r.postData(), url: r.url() });
    return json(route, 200, r.method() === 'DELETE' ? SAMPLES.keyCleared : SAMPLES.keyAccepted);
  });
  await page.route((url) => url.pathname.endsWith('/alterra-work-trial-2026-10-23/') || url.pathname.endsWith('/index.html'), async (route) => {
    const res = await route.fetch();
    const html = (await res.text()).replace('<head>', `<head>\n    <meta name="${TOKEN_META}" content="${token}" />`);
    return route.fulfill({ response: res, body: html });
  });
  return keyCalls;
}

// A host where api/health is missing.
async function mockBrowserDirect(page: Page) {
  await page.route((url) => isPath(url, HEALTH_PATH), (route) => route.fulfill({ status: 404, body: 'Not Found' }));
}

const CORS_HEADERS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST' };

function sse(): string {
  const events = [
    { type: 'message_start', message: { id: 'msg_e2e', type: 'message', role: 'assistant', model: MODEL, content: [], stop_reason: null, usage: { input_tokens: 12, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ];
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

// The Messages API: a 200 stream, or an HTTP error with the given message.
async function mockApi(page: Page, reply: { status: 200 } | { status: number; type: string; message: string }) {
  const calls: Request[] = [];
  await page.route((url) => url.origin === API_ORIGIN, (route) => {
    const r = route.request();
    if (r.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS_HEADERS });
    calls.push(r);
    if (reply.status === 200) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: sse(), headers: CORS_HEADERS });
    const { status, type, message } = reply as { status: number; type: string; message: string };
    return json(route, status, { type: 'error', error: { type, message } }, CORS_HEADERS);
  });
  return calls;
}

const keyField = (page: Page) => page.getByLabel('API key', { exact: true });
const chip = (page: Page) => page.getByTestId('surface-chip');

test.describe('surface detection', () => {
  test('a chartr-runner health names the local runner', async ({ page }) => {
    await mockLocalRunner(page, 'stub');
    await page.goto('./');
    await expect(chip(page)).toHaveText('Local runner');
  });

  test('the static build answers api/health with a non-runner 200: browser-direct, no console error', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => (msg.type() === 'error' ? errors.push(msg.text()) : undefined));
    const health = page.waitForResponse((r) => isPath(new URL(r.url()), HEALTH_PATH));
    await page.goto('./');
    const res = await health;
    expect(res.status()).toBe(200);
    expect(JSON.parse(await res.text())).toEqual(SAMPLES.staticHealth);
    await expect(chip(page)).toHaveText('Browser-direct');
    expect(errors).toEqual([]);
  });

  test('a 404 health names browser-direct', async ({ page }) => {
    await mockBrowserDirect(page);
    await page.goto('./');
    await expect(chip(page)).toHaveText('Browser-direct');
  });

  test('a 200 health from another app names browser-direct', async ({ page }) => {
    await page.route((url) => isPath(url, HEALTH_PATH), (route) => json(route, 200, { ...SAMPLES.health, app: 'vite' }));
    await page.goto('./');
    await expect(chip(page)).toHaveText('Browser-direct');
  });

  test('a health that does not answer within 1.5 s names browser-direct', async ({ page }) => {
    let release = () => {};
    const held = new Promise<void>((r) => (release = r));
    await page.route((url) => isPath(url, HEALTH_PATH), async (route) => {
      await held;
      await route.abort().catch(() => {});
    });
    const t0 = Date.now();
    await page.goto('./');
    await expect(chip(page)).toHaveText('Browser-direct', { timeout: 4000 });
    expect(Date.now() - t0).toBeLessThan(4000);
    release();
  });

  test('the page carries the design CSP meta', async ({ page }) => {
    await mockBrowserDirect(page);
    await page.goto('./');
    expect(await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content')).toBe(CSP);
    expect(CSP).toContain("connect-src 'self' ");
  });
});

test.describe('key gate on the local runner', () => {
  test('Validate sends one request, to same-origin /api/key with the token, and keeps no copy', async ({ page, baseURL }) => {
    const token = `stub-${randomUUID()}`;
    const keyCalls = await mockLocalRunner(page, token);
    const requests = recordRequests(page);
    const key = sentinelKey();
    await page.goto('./');
    await expect(chip(page)).toHaveText('Local runner');
    await keyField(page).fill(key);
    requests.since();
    await page.getByRole('button', { name: 'Validate' }).click();
    await expect(page.getByTestId('key-chip')).toHaveText('Key held by runner');

    const sent = requests.get();
    expect(sent.map((r) => `${r.method()} ${r.url()}`)).toEqual([`POST ${new URL(KEY_PATH, baseURL).href}`]);
    expect(keyCalls).toHaveLength(1);
    expect(keyCalls[0]!.token).toBe(token);
    expect(JSON.parse(keyCalls[0]!.body ?? '{}')).toEqual({ key });
    expect(sent.filter((r) => isApi(r.url()))).toHaveLength(0);

    const dump = await storageDump(page);
    for (const where of ['local', 'session', 'idb'] as const) expect(dump[where], where).not.toContain(key);
    expect(await page.locator('input').evaluateAll((els, k) => els.some((e) => (e as HTMLInputElement).value === k), key)).toBe(false);
  });

  test('Forget calls DELETE /api/key with the token', async ({ page }) => {
    const token = `stub-${randomUUID()}`;
    const keyCalls = await mockLocalRunner(page, token);
    await page.goto('./');
    await keyField(page).fill(sentinelKey());
    await page.getByRole('button', { name: 'Validate' }).click();
    await page.getByRole('button', { name: 'Forget key' }).click();
    await expect(keyField(page)).toBeVisible();
    expect(keyCalls.map((c) => [c.method, c.token])).toEqual([['POST', token], ['DELETE', token]]);
  });

  test('a runner error shows under the key field', async ({ page }) => {
    await mockLocalRunner(page, 'stub');
    await page.route((url) => isPath(url, KEY_PATH), (route) => json(route, 401, SAMPLES.keyError));
    await page.goto('./');
    await keyField(page).fill(sentinelKey());
    await page.getByRole('button', { name: 'Validate' }).click();
    await expect(page.getByRole('alert')).toContainText(SAMPLES.keyError.error.message);
  });
});

test.describe('key gate on browser-direct', () => {
  test('Validate makes one API call and leaves no key in storage', async ({ page }) => {
    await mockBrowserDirect(page);
    const calls = await mockApi(page, { status: 200 });
    const key = sentinelKey();
    await page.goto('./');
    await expect(chip(page)).toHaveText('Browser-direct');
    await keyField(page).fill(key);
    await page.getByRole('button', { name: 'Validate' }).click();
    await expect(page.getByTestId('key-chip')).toContainText(key.slice(-4));
    expect(calls).toHaveLength(1);
    expect(await calls[0]!.headerValue('x-api-key')).toBe(key);
    const dump = await storageDump(page);
    for (const where of ['local', 'session', 'idb'] as const) expect(dump[where], where).not.toContain(key);
  });

  test('Remember in this tab keeps the key in sessionStorage only', async ({ page }) => {
    await mockBrowserDirect(page);
    await mockApi(page, { status: 200 });
    const key = sentinelKey();
    await page.goto('./');
    await keyField(page).fill(key);
    await page.getByLabel('Remember in this tab').check();
    await page.getByRole('button', { name: 'Validate' }).click();
    await expect(page.getByTestId('key-chip')).toContainText(key.slice(-4));
    const dump = await storageDump(page);
    expect(dump.session).toContain(key);
    expect(dump.local).not.toContain(key);
    expect(dump.idb).not.toContain(key);
    await page.getByRole('button', { name: 'Forget key' }).click();
    expect((await storageDump(page)).session).not.toContain(key);
  });

  test('an org-CORS 401 shows its message, the reason and the local command with a copy button', async ({ page }) => {
    await mockBrowserDirect(page);
    await mockApi(page, { status: 401, type: 'authentication_error', message: ORG_CORS });
    await page.goto('./');
    await keyField(page).fill(sentinelKey());
    await page.getByRole('button', { name: 'Validate' }).click();
    const alert = page.getByRole('alert');
    await expect(alert).toContainText(ORG_CORS);
    await expect(alert).toContainText("This key's organization does not allow browser access.");
    await expect(page.getByTestId('local-command')).toHaveText(LOCAL_START_COMMAND);
    await expect(page.getByRole('button', { name: 'Copy command' })).toBeVisible();
    await page.getByRole('button', { name: 'Browse without a key' }).click();
    await expect(page.getByTestId('key-chip')).toHaveText('No key');
  });

  test('another 401 shows the API error without the command', async ({ page }) => {
    await mockBrowserDirect(page);
    await mockApi(page, { status: 401, type: 'authentication_error', message: 'invalid x-api-key' });
    await page.goto('./');
    await keyField(page).fill(sentinelKey());
    await page.getByRole('button', { name: 'Validate' }).click();
    await expect(page.getByRole('alert')).toContainText('invalid x-api-key');
    await expect(page.getByTestId('local-command')).toHaveCount(0);
    await expect(page.getByText(LOCAL_START_COMMAND)).toHaveCount(0);
  });

  test('the session cap refuses a call whose estimate crosses it, before any request', async ({ page }) => {
    await mockBrowserDirect(page);
    const calls = await mockApi(page, { status: 200 });
    await page.goto('./');
    await keyField(page).fill(sentinelKey());
    await page.getByLabel('Session spend cap (USD)').fill('0.01');
    await page.getByRole('button', { name: 'Validate' }).click();
    await expect(page.getByRole('alert')).toContainText('session cap');
    expect(calls).toHaveLength(0);
  });
});

test.describe('shell', () => {
  test('browsing without a key opens the shell with the rail, the surface and no key', async ({ page }) => {
    await mockBrowserDirect(page);
    await page.goto('./');
    await page.getByRole('button', { name: 'Browse without a key' }).click();
    const rail = page.getByRole('navigation', { name: 'Views' });
    for (const name of ['Overview', 'Tasks', 'Runs', 'Findings', 'Environment']) await expect(rail.getByRole('link', { name })).toBeVisible();
    await expect(page.getByTestId('key-chip')).toHaveText('No key');
    await expect(chip(page)).toHaveText('Browser-direct');
    await rail.getByRole('link', { name: 'Tasks' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Tasks');
    expect(new URL(page.url()).searchParams.get('view')).toBe('tasks');
  });
});

test('admitTrial refuses a trial whose estimate crosses the session cap', () => {
  expect(DEFAULT_SESSION_CAP_USD).toBe(20);
  expect(admitTrial({ cap: 20, spent: 19, estimate: 0.5 }).ok).toBe(true);
  expect(admitTrial({ cap: 20, spent: 19, estimate: 1 }).ok).toBe(true);
  const refused = admitTrial({ cap: 20, spent: 19, estimate: 1.01 });
  expect(refused.ok).toBe(false);
  expect(refused.ok ? '' : refused.reason).toMatch(/session cap \$20\.00/);
});
