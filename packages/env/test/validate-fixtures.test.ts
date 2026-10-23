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
import { RESOURCE_TYPES } from '../world.ts';

const root = new URL('../../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root));

// The smallest valid instance of each type the tools write or validate. The world holds only
// some of these types today, but every write a tool makes is validated against the same bundle.
const t = 'Patient/pt-0001';
const MINIMAL: Record<string, Record<string, unknown>> = {
  Patient: {},
  Practitioner: {},
  Organization: {},
  Group: { type: 'practitioner', actual: true },
  Encounter: { status: 'finished', class: { code: 'AMB' } },
  EpisodeOfCare: { status: 'active', patient: { reference: t } },
  Appointment: { status: 'booked', start: '2026-10-26T09:00:00-04:00', end: '2026-10-26T09:20:00-04:00', participant: [{ actor: { reference: t }, status: 'accepted' }] },
  Condition: { subject: { reference: t } },
  Observation: { status: 'final', code: { text: 'x' } },
  DiagnosticReport: { status: 'final', code: { text: 'x' } },
  DocumentReference: { status: 'current', content: [{ attachment: { contentType: 'text/plain' } }] },
  AllergyIntolerance: { clinicalStatus: { coding: [{ code: 'active' }] }, patient: { reference: t } },
  Procedure: { status: 'completed', subject: { reference: t } },
  MedicationRequest: { status: 'active', intent: 'order', medicationCodeableConcept: { text: 'x' }, subject: { reference: t } },
  ServiceRequest: { status: 'active', intent: 'order', subject: { reference: t } },
  Task: { status: 'requested', intent: 'order' },
  Communication: { status: 'completed' },
  Provenance: { target: [{ reference: t }], recorded: '2026-10-23T08:00:01-04:00', agent: [{ who: { reference: 'Practitioner/pr-okafor' } }] },
};

it('the pruned definitions validate every resource type the tools write or validate', () => {
  indexStructureDefinitionBundle(JSON.parse(read('fixtures/definitions-pruned.json').toString('utf8')) as Bundle);
  expect(Object.keys(MINIMAL).sort()).toEqual([...RESOURCE_TYPES].sort());
  const invalid: string[] = [];
  for (const [resourceType, fields] of Object.entries(MINIMAL)) {
    try {
      validateResource({ resourceType, id: 'x-1', ...fields } as never);
    } catch (e) {
      invalid.push(`${resourceType}: ${normalizeErrorString(e)}`);
    }
  }
  expect(invalid).toEqual([]);
});

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
