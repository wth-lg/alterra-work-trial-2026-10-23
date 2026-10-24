// The same mocked trial in a Chromium Worker and in Node (plan phase P7): each scenario through
// packages/core/worker-host.ts in the harness trial Worker, and through run() in this Node
// process, must give the same trajectory JSONL once timestamps are stripped, and the same final
// hash. The toy scenario runs tasks/_toy, whose note is one committed write_note; the write
// scenario commits one create_task on the harness task _write (write-task.ts), so hash parity
// after a write is checked for both. Both sides
// answer from apps/web/src/harness/scenarios.ts and meter through the tab ledger (in-memory
// here, since Node has no sessionStorage); nothing calls the API.
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { MessagesClient } from '../../../packages/core/anthropic.ts';
import { PER_TRIAL_CAP_USD } from '../../../packages/core/cost.ts';
import { parseEvent } from '../../../packages/core/events.ts';
import { run } from '../../../packages/core/run.ts';
import { taskSource } from '../../../packages/core/tasks.ts';
import { stripTimestamps, toJsonl } from '../../../packages/core/trajectory.ts';
import { nodeTaskDirs } from '../../../cli/adapters/tasks-node.ts';
import { tabLedger } from '../src/adapters/ledger-browser.ts';
import { scenarioTransport, type ScenarioName } from '../src/harness/scenarios.ts';
import { WRITE_TASK } from '../src/harness/write-task.ts';

const root = new URL('../../../', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('fixtures/manifest.json', root), 'utf8')) as { world: { state_hash: string } };

async function nodeTrial(task: string, scenario: ScenarioName) {
  const ledger = tabLedger();
  const grant = await ledger.batchStart(PER_TRIAL_CAP_USD);
  const client = new MessagesClient({ grant, ledger, apiKey: 'mock-key-not-sent', fetch: scenarioTransport(scenario).transport, trial: `mock:parity:${task}` });
  const world = new Uint8Array(readFileSync(new URL('fixtures/world.ndjson.gz', root)));
  try {
    return await run(task, 'claude-opus-5-5', {
      tasks: taskSource(async () => [...nodeTaskDirs(), WRITE_TASK], { testMode: false }),
      client,
      world: { read: async () => world },
      worldHash: manifest.world.state_hash,
      definitions: JSON.parse(readFileSync(new URL('fixtures/definitions-pruned.json', root), 'utf8')),
      now: () => Date.now(),
    });
  } finally {
    await grant.close();
  }
}

for (const [task, scenario, writes] of [['_toy', 'toy', 1], ['_write', 'write', 1]] as const) {
  test(`the ${scenario} scenario in a Chromium Worker gives the same trajectory and final hash as in Node`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('./harness.html');
    await expect(page.locator('body[data-ready="true"]')).toBeAttached();
    const worker = await page.evaluate(
      ([task, scenario]) =>
        window.harness.trial({
          task,
          model: 'claude-opus-5-5',
          scenario,
          worldUrl: new URL('data/fixtures/world.ndjson.gz', location.href).href,
          manifestUrl: new URL('data/fixtures/manifest.json', location.href).href,
        }),
      [task, scenario] as const,
    );
    const node = await nodeTrial(task, scenario);

    for (const e of worker.events) parseEvent(e);
    const workerJsonl = stripTimestamps(toJsonl(worker.events));
    const nodeJsonl = stripTimestamps(toJsonl(node.events));
    console.log(`${scenario} worker: ${worker.events.length} events, status ${worker.record.status}, final ${worker.record.state_hash.final}; node: ${node.events.length} events, final ${node.record.state_hash.final}`);
    expect(worker.record.status).toBe('COMPLETED');
    expect(worker.events.map((e) => e.type)).toContain('tool_result');
    expect(worker.events.filter((e) => e.type === 'state_hash' && e.at === 'write')).toHaveLength(writes);
    if (writes > 0) expect(worker.record.state_hash.final).not.toBe(worker.record.state_hash.initial);
    expect(workerJsonl).toBe(nodeJsonl);
    expect(worker.record.state_hash.final).toBe(node.record.state_hash.final);
    expect(worker.record.state_hash.replay_final).toBe(worker.record.state_hash.final);
  });
}
