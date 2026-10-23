// The state hash is the same in Node and in the browser: one generated world, gzipped once
// in Node, is hashed by Node through parseNdjson and by the harness page's Worker through
// its fetch FixtureSource, and the two hashes must match.
import { gzipSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import { parseNdjson } from '../../../packages/env/fixture-source.ts';
import { stateHash } from '../../../packages/env/hash.ts';
import { generateWorld, toNdjson } from '../src/harness/generate.ts';

const WORLD_SIZE = 600;
const FIXTURE_PATH = 'harness-fixture/world.ndjson.gz';

test('the browser Worker hashes a generated store as Node does', async ({ page, context }) => {
  const world = generateWorld(20261023, WORLD_SIZE);
  const gz = gzipSync(toNdjson(world));
  const nodeHash = await stateHash(await parseNdjson(gz));

  // The context route also answers requests the Worker makes.
  await context.route(`**/${FIXTURE_PATH}`, (route) => route.fulfill({ body: gz, contentType: 'application/gzip' }));
  await page.goto('./harness.html');
  await expect(page.locator('body[data-ready="true"]')).toBeAttached();
  const browser = await page.evaluate(
    (path) => window.harness.call({ op: 'hash', url: new URL(path, location.href).href }),
    FIXTURE_PATH,
  );

  console.log(`state hash: node ${nodeHash}, chromium ${browser.hash}, ${browser.resources} resources (${gz.length} gzipped bytes)`);
  expect(browser.resources).toBe(WORLD_SIZE);
  expect(browser.hash).toBe(nodeHash);
});
