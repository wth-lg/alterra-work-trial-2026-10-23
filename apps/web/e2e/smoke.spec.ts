import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

// The design CSP, as apps/web/*.html carry it. Only those metas and packages/core/anthropic.ts
// name the API host (lint: no-direct-anthropic), so it is read from index.html, and every page
// must carry the same one.
const metaCsp = (html: string) => /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)?.[1];
const CSP = metaCsp(readFileSync(new URL('../index.html', import.meta.url), 'utf8'));

test('every page carries the same CSP meta, which allows only self and one https origin to connect', () => {
  for (const page of ['harness.html', 'probe.html']) expect(metaCsp(readFileSync(new URL(`../${page}`, import.meta.url), 'utf8'))).toBe(CSP);
  expect(CSP).toMatch(/(^|; )connect-src 'self' https:\/\/[a-z.]+;/);
});

test('the shell loads with the design CSP meta', async ({ page }) => {
  await page.goto('./');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  expect(csp).toBe(CSP);
});

test('the static data index is served', async ({ request }) => {
  const res = await request.get('./data/index.json');
  expect(res.ok()).toBe(true);
  expect(Array.isArray((await res.json()).files)).toBe(true);
});
