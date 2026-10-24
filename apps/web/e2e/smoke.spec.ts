import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

// The design CSP, pinned. This exact literal in this file is the one place outside
// packages/core/anthropic.ts that lint lets name the API host (no-direct-anthropic).
const CSP = "default-src 'self'; connect-src 'self' https://api.anthropic.com; script-src 'self'; worker-src 'self'";
const API_ORIGIN = /connect-src 'self' (\S+);/.exec(CSP)?.[1] ?? '';
const PAGES = ['index.html', 'harness.html', 'probe.html'];

const metaCsp = (html: string) => /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)?.[1];

test('every page source carries the design CSP meta', () => {
  for (const page of PAGES) expect(metaCsp(readFileSync(new URL(`../${page}`, import.meta.url), 'utf8')), page).toBe(CSP);
});

for (const page of PAGES) {
  test(`built ${page} is served with the design CSP meta`, async ({ page: p }) => {
    await p.goto(page === 'index.html' ? './' : `./${page}`);
    expect(await p.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content')).toBe(CSP);
  });
}

test('the shell loads', async ({ page }) => {
  await page.goto('./');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
});

// The egress guard runs in the browser too: a page fetch to the API host is refused before it
// leaves the page. The probe relay (window.clinenvFetch) is the one path out, for requests the
// Node-side MessagesClient registered and the relay claimed (apps/web/src/probe/transport.ts).
test('the egress guard refuses a page fetch to the API host; the probe relay still sends', async ({ page }) => {
  let reached = 0;
  await page.route((url) => url.origin === API_ORIGIN, (route) => (reached++, route.fulfill({ status: 200, body: 'ok', headers: { 'access-control-allow-origin': '*' } })));
  await page.goto('./probe.html');
  await expect(page.locator('body[data-page="probe"]')).toBeAttached();
  const spelled = API_ORIGIN.replace('.', '%2E');
  const refused = await page.evaluate(async (u) => fetch(`${u}/v1/messages`, { method: 'POST', body: '{}' }).then(() => 'sent', (e: Error) => e.message), spelled);
  expect(refused).toMatch(/egress guard/);
  expect(reached).toBe(0);
  const relayed = await page.evaluate(async (u) => (window.clinenvFetch as (u: string, r: unknown) => Promise<{ status?: number }>)(u, { method: 'POST', headers: {}, body: '{}' }), `${API_ORIGIN}/v1/messages`);
  expect(relayed.status).toBe(200);
  expect(reached).toBe(1);
});

test('the static data index is served', async ({ request }) => {
  const res = await request.get('./data/index.json');
  expect(res.ok()).toBe(true);
  expect(Array.isArray((await res.json()).files)).toBe(true);
});
