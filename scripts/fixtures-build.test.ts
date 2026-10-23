// The world build's manifest (scripts/fixtures-build.ts): what it pins and how it labels the
// definitions.
import { readFileSync } from 'node:fs';
import { findPackageJSON } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RESOURCE_TYPES } from '../packages/env/world.ts';
import { definitionsLabel } from './fixtures-build.ts';

const repo = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(readFileSync(join(repo, 'fixtures/manifest.json'), 'utf8')) as {
  inputs: Record<string, string>;
  definitions: { from: string; types: string[] };
};

describe('manifest', () => {
  it('pins the Synthea generator and prune, so editing either without a rebuild fails fixtures:verify', () => {
    expect(Object.keys(manifest.inputs)).toEqual(expect.arrayContaining(['fixtures/synthea/generate.sh', 'scripts/fixtures-synthea.ts']));
  });

  it('labels the definitions with the installed @medplum/definitions version', () => {
    const file = findPackageJSON('@medplum/definitions', pathToFileURL(join(repo, 'packages/env/package.json')));
    const { version } = JSON.parse(readFileSync(file!, 'utf8')) as { version: string };
    expect(definitionsLabel()).toBe(`@medplum/definitions ${version}`);
    expect(manifest.definitions.from).toBe(definitionsLabel());
  });

  it('prunes definitions for every resource type the tools write or validate, not only those in the world', () => {
    expect(RESOURCE_TYPES).toHaveLength(18);
    expect(RESOURCE_TYPES).toEqual(expect.arrayContaining(['Provenance', 'Task', 'Communication', 'ServiceRequest', 'MedicationRequest', 'DocumentReference']));
    expect(manifest.definitions.types).toEqual([...RESOURCE_TYPES].sort());
  });
});
