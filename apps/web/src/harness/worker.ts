// Harness Worker: runs the environment off the main thread, as a trial Worker will
// (design section 1). The browser FixtureSource is a same-origin fetch.
import { loadStore, type FixtureSource } from '../../../../packages/env/fixture-source.ts';
import { stateHash } from '../../../../packages/env/hash.ts';
import type { Resource, Store } from '../../../../packages/env/store.ts';
import type { HarnessReply, HarnessRequest, HarnessResult, LatencyResult, LatencySearch } from './protocol.ts';

type Observation = Extract<Resource, { resourceType: 'Observation' }>;

// Fetched once per request; every store is built from these same bytes.
async function fetchSource(url: string): Promise<FixtureSource> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fixture ${url}: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { read: async () => bytes };
}

// Half replace existing Observations, half add Communications, as
// packages/env/test/state-hash.test.ts does in Node.
function write(store: Store, writes: number): void {
  const half = Math.ceil(writes / 2);
  const observations = store.search<Observation>('Observation', { _count: String(half) }).resources;
  const [patient] = store.search('Patient', { _count: '1' }).resources;
  if (observations.length < half || !patient) throw new Error('world has too few Observations or no Patient');
  for (const obs of observations) store.put({ ...obs, status: 'entered-in-error' });
  for (let i = 1; i <= writes - half; i++) {
    const comm: Resource = {
      resourceType: 'Communication',
      id: `comm-t${String(i).padStart(4, '0')}`,
      status: 'completed',
      subject: { reference: `Patient/${patient.id}` },
      payload: [{ contentString: `write ${i}` }],
    };
    store.put(comm);
  }
}

const MIN_BATCH_MS = 20;

function time(store: Store, s: LatencySearch, rounds: number): LatencyResult {
  const run = () => store.search(s.resourceType, s.query);
  const first = run();
  for (let i = 0; i < 5; i++) run();
  let batch = 1;
  for (;;) {
    const t0 = performance.now();
    for (let i = 0; i < batch; i++) run();
    if (performance.now() - t0 >= MIN_BATCH_MS) break;
    batch *= 2;
  }
  const samplesMs: number[] = [];
  for (let r = 0; r < rounds; r++) {
    const t0 = performance.now();
    for (let i = 0; i < batch; i++) run();
    samplesMs.push((performance.now() - t0) / batch);
  }
  return { name: s.name, total: first.total, returned: first.resources.length, batch, samplesMs };
}

async function handle(req: HarnessRequest): Promise<HarnessResult> {
  switch (req.op) {
    case 'hash': {
      const store = await loadStore(await fetchSource(req.url));
      return { op: 'hash', hash: await stateHash(store.resources()), resources: store.size };
    }
    case 'stateHashRounds': {
      const source = await fetchSource(req.url);
      const a = await loadStore(source);
      const resources = a.size;
      const initial = await stateHash(a.resources());
      write(a, req.writes);
      const afterWrites = await stateHash(a.resources());
      const fresh: string[] = [];
      for (let i = 0; i < req.fresh; i++) fresh.push(await stateHash((await loadStore(source)).resources()));
      return { op: 'stateHashRounds', resources, initial, afterWrites, fresh };
    }
    case 'latency': {
      const source = await fetchSource(req.url);
      const buildMs: number[] = [];
      let store: Store | undefined;
      for (let i = 0; i < 5; i++) {
        const t0 = performance.now();
        store = await loadStore(source);
        buildMs.push(performance.now() - t0);
      }
      return { op: 'latency', resources: store!.size, buildMs, results: req.searches.map((s) => time(store!, s, req.rounds)) };
    }
  }
}

addEventListener('message', (event: MessageEvent<{ id: number; req: HarnessRequest }>) => {
  const { id, req } = event.data;
  handle(req).then(
    (result) => postMessage({ id, ok: true, result } satisfies HarnessReply),
    (err: unknown) => postMessage({ id, ok: false, error: String(err) } satisfies HarnessReply),
  );
});
