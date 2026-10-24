// Harness trial Worker: one mocked trial through packages/core/worker-host.ts, the way a live
// trial Worker will run one. The Messages client is metered by the tab ledger and answers from
// a scripted scenario (scenarios.ts), so nothing leaves the page; the egress guard is installed
// first anyway, as in every entry point that holds a client.
import { installEgressGuard } from '../../../../packages/core/egress.ts';
import { MessagesClient } from '../../../../packages/core/anthropic.ts';
import { hostTrial, type HostScope, type HostStart } from '../../../../packages/core/worker-host.ts';
import { browserNow } from '../adapters/clock-browser.ts';
import { tabLedger } from '../adapters/ledger-browser.ts';
import { browserTaskSource } from '../adapters/tasks-browser.ts';
import { scenarioTransport, type ScenarioName } from './scenarios.ts';

installEgressGuard(globalThis);

export interface HarnessStart extends HostStart {
  scenario: ScenarioName;
  // Absolute URLs of the deployed world and its manifest.
  worldUrl: string;
  manifestUrl: string;
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

hostTrial<HarnessStart>(globalThis as unknown as HostScope, async (start) => {
  const ledger = tabLedger();
  const grant = await ledger.batchStart(6);
  const manifest = JSON.parse(new TextDecoder().decode(await fetchBytes(start.manifestUrl))) as { world: { state_hash: string } };
  const world = await fetchBytes(start.worldUrl);
  return {
    tasks: browserTaskSource({ testMode: false }),
    client: new MessagesClient({ grant, ledger, apiKey: 'mock-key-not-sent', fetch: scenarioTransport(start.scenario).transport, trial: `mock:harness:${start.task}` }),
    world: { read: async () => world },
    worldHash: manifest.world.state_hash,
    now: browserNow,
  };
});
