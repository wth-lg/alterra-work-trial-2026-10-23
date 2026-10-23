import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

// The design CSP, pinned. This exact literal in this file is the one place outside
// packages/core/anthropic.ts that lint lets name the API host (no-direct-anthropic).
const CSP = "default-src 'self'; connect-src 'self' https://api.anthropic.com; script-src 'self'; worker-src 'self'";
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

test('the static data index is served', async ({ request }) => {
  const res = await request.get('./data/index.json');
  expect(res.ok()).toBe(true);
  expect(Array.isArray((await res.json()).files)).toBe(true);
});
