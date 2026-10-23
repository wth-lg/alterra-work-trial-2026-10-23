# fixtures

All patient data here is fully synthetic. No record describes a real person.

| File | What it is | How it is made |
|---|---|---|
| `synthea/base.ndjson.gz` | The base cohort: 60 living patients and their charts | `fixtures/synthea/generate.sh` runs Synthea, then `scripts/fixtures-synthea.ts` prunes and renumbers the export |
| `synthea/base.json` | Synthea version, jar SHA-256, flags and counts for the base | written by `generate.sh` |
| `world.ndjson.gz` | The shared world: the base cohort plus the clinic setting and every task overlay | `pnpm fixtures:build` |
| `manifest.json` | State hash, counts and the SHA-256 of every input the world depends on | `pnpm fixtures:build`; `pnpm fixtures:verify` rebuilds and compares |
| `definitions-pruned.json` | The FHIR R4 StructureDefinitions used to validate resources | `pnpm fixtures:build`, from `@medplum/definitions` |

## Attribution

- **Synthea.** The base cohort is output of [Synthea](https://github.com/synthetichealth/synthea) v4.0.0, © The MITRE Corporation, licensed under Apache-2.0. Synthea generates synthetic patients. The output here is modified: pruned to our resource types and the 6 years before the clock's NOW, ids renumbered, Synthea's clinicians and facilities replaced by the fictional Riverbend clinic.
- **FHIR definitions.** `definitions-pruned.json` is derived from [`@medplum/definitions`](https://github.com/medplum/medplum) (Apache-2.0), which packages the HL7 FHIR R4 specification's StructureDefinitions. HL7 FHIR is © HL7 International and published under the [HL7 FHIR licence](https://www.hl7.org/fhir/license.html) (Creative Commons CC0 for the specification content). The file is modified: reduced to the resource types we use, with prose fields removed.
