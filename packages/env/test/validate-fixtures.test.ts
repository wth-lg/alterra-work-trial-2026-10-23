/* eslint-disable local/isomorphic-imports -- Node-only test: it reads the committed fixtures
   with node:fs. */
// Medplum validateResource over every resource in the committed world, against the pruned R4
// definitions the tool layer will validate writes with (design section 2, "Store" and "Write
// validation"). Only the pruned bundle is indexed, so a type the world uses but the pruned
// bundle lacks fails here too.
import { readFileSync } from 'node:fs';
import { indexStructureDefinitionBundle, normalizeErrorString, validateResource } from '@medplum/core';
import type { Bundle } from '@medplum/fhirtypes';
import { expect, it } from 'vitest';
import { parseNdjson } from '../fixture-source.ts';

const root = new URL('../../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root));

it('every world resource is valid R4, and the valid count equals the manifest count', async () => {
  const manifest = JSON.parse(read('fixtures/manifest.json').toString('utf8')) as { world: { resources: number } };
  indexStructureDefinitionBundle(JSON.parse(read('fixtures/definitions-pruned.json').toString('utf8')) as Bundle);
  const resources = await parseNdjson(read('fixtures/world.ndjson.gz'));

  let valid = 0;
  const invalid: string[] = [];
  for (const resource of resources) {
    try {
      validateResource(resource);
      valid++;
    } catch (e) {
      invalid.push(`${resource.resourceType}/${resource.id}: ${normalizeErrorString(e)}`);
    }
  }
  console.log(`validateResource: ${valid} valid of ${resources.length}; manifest world.resources ${manifest.world.resources}`);
  expect(invalid.slice(0, 10)).toEqual([]);
  expect(valid).toBe(manifest.world.resources);
});
