// The same mocked trial in a Chromium Worker and in Node (plan phase P7): the toy scenario
// through packages/core/worker-host.ts in the harness trial Worker, and through run() in this
// Node process, must give the same trajectory JSONL once timestamps are stripped, and the same
// final hash. Both answer from apps/web/src/harness/scenarios.ts and meter through the tab
// ledger (in-memory here, since Node has no sessionStorage); nothing calls the API.
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { MessagesClient } from '../../../packages/core/anthropic.ts';
import { parseEvent } from '../../../packages/core/events.ts';
import { run } from '../../../packages/core/run.ts';
import { stripTimestamps, toJsonl } from '../../../packages/core/trajectory.ts';
import { nodeTaskSource } from '../../../cli/adapters/tasks-node.ts';
import { tabLedger } from '../src/adapters/ledger-browser.ts';
import { scenarioTransport } from '../src/harness/scenarios.ts';

const root = new URL('../../../', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('fixtures/manifest.json', root), 'utf8')) as { world: { state_hash: string } };

async function nodeTrial() {
  const ledger = tabLedger();
  const grant = await ledger.batchStart(6);
  const client = new MessagesClient({ grant, ledger, apiKey: 'mock-key-not-sent', fetch: scenarioTransport('toy').transport, trial: 'mock:parity:_toy' });
  const world = new Uint8Array(readFileSync(new URL('fixtures/world.ndjson.gz', root)));
  return run('_toy', 'claude-opus-5-5', {
    tasks: nodeTaskSource({ testMode: false }),
    client,
    world: { read: async () => world },
    worldHash: manifest.world.state_hash,
    now: () => Date.now(),
  });
}

test('the toy scenario in a Chromium Worker gives the same trajectory and final hash as in Node', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('./harness.html');
  await expect(page.locator('body[data-ready="true"]')).toBeAttached();
  const worker = await page.evaluate(() =>
    window.harness.trial({
      task: '_toy',
      model: 'claude-opus-5-5',
      scenario: 'toy',
      worldUrl: new URL('data/fixtures/world.ndjson.gz', location.href).href,
      manifestUrl: new URL('data/fixtures/manifest.json', location.href).href,
    }),
  );
  const node = await nodeTrial();

  for (const e of worker.events) parseEvent(e);
  const workerJsonl = stripTimestamps(toJsonl(worker.events));
  const nodeJsonl = stripTimestamps(toJsonl(node.events));
  console.log(`worker: ${worker.events.length} events, status ${worker.record.status}, final ${worker.record.state_hash.final}; node: ${node.events.length} events, final ${node.record.state_hash.final}`);
  expect(worker.record.status).toBe('COMPLETED');
  expect(worker.events.map((e) => e.type)).toContain('tool_result');
  expect(workerJsonl).toBe(nodeJsonl);
  expect(worker.record.state_hash.final).toBe(node.record.state_hash.final);
  expect(worker.record.state_hash.replay_final).toBe(worker.record.state_hash.final);
});
