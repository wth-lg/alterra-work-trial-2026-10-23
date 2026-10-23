// Every trial can start from the manifest hash (design section 2, "Reset and state hash"):
// writes to one store never reach a store built later from the same world bytes.
// apps/web/e2e/state-hash-worker.spec.ts runs the same check in a Chromium Worker.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Observation, Resource } from '@medplum/fhirtypes';
import { expect, it } from 'vitest';
import { loadStore, type FixtureSource } from '../fixture-source.ts';
import { stateHash } from '../hash.ts';
import type { Store } from '../store.ts';

const root = new URL('../../../', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('fixtures/manifest.json', root), 'utf8')) as {
  world: { state_hash: string; resources: number };
};
const bytes = readFileSync(new URL('fixtures/world.ndjson.gz', root));
const source: FixtureSource = { read: async () => bytes };
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

const WRITES = 10;
const FRESH = 20;

// Half replace existing Observations, half add new resources.
function write(store: Store): void {
  const observations = store.search<Observation>('Observation', { _count: String(WRITES / 2) }).resources;
  expect(observations).toHaveLength(WRITES / 2);
  for (const obs of observations) store.put({ ...obs, status: 'entered-in-error' });
  const [patient] = store.search('Patient', { _count: '1' }).resources;
  expect(patient).toBeDefined();
  for (let i = 1; i <= WRITES / 2; i++) {
    const comm: Resource = {
      resourceType: 'Communication',
      id: `comm-t${String(i).padStart(4, '0')}`,
      status: 'completed',
      subject: { reference: `Patient/${patient!.id}` },
      payload: [{ contentString: `write ${i}` }],
    };
    store.put(comm);
  }
}

it(`after ${WRITES} writes to store A, ${FRESH} fresh stores all hash to the manifest`, async () => {
  const before = sha256(bytes);
  const a = await loadStore(source);
  expect(await stateHash(a.resources())).toBe(manifest.world.state_hash);

  write(a);
  const afterWrites = await stateHash(a.resources());
  expect(afterWrites).not.toBe(manifest.world.state_hash);
  expect(a.size).toBe(manifest.world.resources + WRITES / 2);

  const hashes: string[] = [];
  for (let i = 0; i < FRESH; i++) {
    const fresh = await loadStore(source);
    expect(fresh.size).toBe(manifest.world.resources);
    hashes.push(await stateHash(fresh.resources()));
  }
  console.log(`store A after ${WRITES} writes ${afterWrites}; ${FRESH} fresh stores ${[...new Set(hashes)].join(', ')}; manifest ${manifest.world.state_hash}`);
  expect(hashes).toEqual(Array(FRESH).fill(manifest.world.state_hash));
  expect(sha256(bytes)).toBe(before);
});
