// The committed fixtures are third-party output and derived definitions; fixtures/README.md
// carries their attribution and says the data is synthetic.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const repo = fileURLToPath(new URL('..', import.meta.url));

it('fixtures/README.md credits Synthea and the FHIR definitions and says the data is synthetic', () => {
  const readme = readFileSync(join(repo, 'fixtures/README.md'), 'utf8');
  for (const s of ['Synthea', 'MITRE', 'Apache-2.0', '@medplum/definitions', 'HL7', 'synthetic']) expect(readme).toContain(s);
});
