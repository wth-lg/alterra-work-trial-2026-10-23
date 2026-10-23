// packages/env/test/state-hash.test.ts in a Chromium Worker: store A built from the deployed
// world and written to 10 times, then 20 fresh stores from the same bytes, each hashing to
// the committed manifest. The world is the one `pnpm build` copies into dist/data/.
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const manifest = JSON.parse(readFileSync(new URL('../../../fixtures/manifest.json', import.meta.url), 'utf8')) as {
  world: { state_hash: string; resources: number };
};
const WRITES = 10;
const FRESH = 20;

test(`after ${WRITES} writes to store A, ${FRESH} fresh stores in a Worker hash to the manifest`, async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('./harness.html');
  await expect(page.locator('body[data-ready="true"]')).toBeAttached();
  const r = await page.evaluate(
    ([writes, fresh]) => window.harness.call({ op: 'stateHashRounds', url: new URL('data/fixtures/world.ndjson.gz', location.href).href, writes, fresh }),
    [WRITES, FRESH] as const,
  );

  console.log(`chromium worker: initial ${r.initial}, after ${WRITES} writes ${r.afterWrites}, ${FRESH} fresh ${[...new Set(r.fresh)].join(', ')}; manifest ${manifest.world.state_hash}`);
  expect(r.resources).toBe(manifest.world.resources);
  expect(r.initial).toBe(manifest.world.state_hash);
  expect(r.afterWrites).not.toBe(manifest.world.state_hash);
  expect(r.fresh).toEqual(Array(FRESH).fill(manifest.world.state_hash));
});
