import { expect, test } from '@playwright/test';

// Every live spec starts with this skip: without a key the live project lists the spec and
// reports it skipped instead of failing.
test.skip(!process.env.ANTHROPIC_API_KEY, 'ANTHROPIC_API_KEY is not set');

// Placeholder until P2 adds the specs that call the API; it loads the shell only.
test('the shell loads under the live project', async ({ page }) => {
  await page.goto('./');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
});
