import { expect, test } from '@playwright/test';

const CSP = "default-src 'self'; connect-src 'self' https://api.anthropic.com; script-src 'self'; worker-src 'self'";

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
