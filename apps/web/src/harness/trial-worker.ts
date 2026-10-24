// Harness trial Worker: one mocked trial through packages/core/worker-host.ts, the way a live
// trial Worker will run one. The Messages client is metered by the tab ledger and answers from
// a scripted scenario (scenarios.ts), so nothing leaves the page; the egress guard is installed
// first anyway, as in every entry point that holds a client. The grant is closed when the trial
// ends or setup fails. Tasks are tasks/ plus the harness write task (write-task.ts), and the
// definitions bundle the write tools validate against comes as a same-origin asset.
import { installEgressGuard } from '../../../../packages/core/egress.ts';
import { MessagesClient } from '../../../../packages/core/anthropic.ts';
import { PER_TRIAL_CAP_USD } from '../../../../packages/core/cost.ts';
import type { RunOptions } from '../../../../packages/core/run.ts';
import { taskSource } from '../../../../packages/core/tasks.ts';
import { hostTrial, type HostScope, type HostStart } from '../../../../packages/core/worker-host.ts';
import { browserNow } from '../adapters/clock-browser.ts';
import { tabLedger } from '../adapters/ledger-browser.ts';
import { browserTaskDirs } from '../adapters/tasks-browser.ts';
import { scenarioTransport, type ScenarioName } from './scenarios.ts';
import { WRITE_TASK } from './write-task.ts';
import definitionsUrl from '../../../../fixtures/definitions-pruned.json?url';

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

const json = async <T>(url: string): Promise<T> => JSON.parse(new TextDecoder().decode(await fetchBytes(url))) as T;

hostTrial<HarnessStart>(globalThis as unknown as HostScope, async (start, defer) => {
  const ledger = tabLedger();
  const grant = await ledger.batchStart(PER_TRIAL_CAP_USD);
  defer(() => grant.close());
  const manifest = await json<{ world: { state_hash: string } }>(start.manifestUrl);
  const world = await fetchBytes(start.worldUrl);
  return {
    tasks: taskSource(async () => [...browserTaskDirs(), WRITE_TASK], { testMode: false }),
    client: new MessagesClient({ grant, ledger, apiKey: 'mock-key-not-sent', fetch: scenarioTransport(start.scenario).transport, trial: `mock:harness:${start.task}` }),
    world: { read: async () => world },
    worldHash: manifest.world.state_hash,
    definitions: await json<NonNullable<RunOptions['definitions']>>(new URL(definitionsUrl, import.meta.url).href),
    now: browserNow,
  };
});
