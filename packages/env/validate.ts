// Write validation step 4 (design section 2, "Write validation"): Medplum's validateResource
// against the pruned R4 definitions in fixtures/definitions-pruned.json, the same validator and
// bundle the fixture check runs over the world (packages/env/test/validate-fixtures.test.ts).
// The store does not validate on write, so the write tools call validate() before committing.
//
// The caller reads the bundle (cli/ with fs, apps/web with fetch) and indexes it once with
// indexDefinitions; validate() throws until it has, so a runtime that forgot cannot commit
// unvalidated writes.
import { OperationOutcomeError, indexStructureDefinitionBundle, validateResource } from '@medplum/core';
import type { Bundle, Resource } from '@medplum/fhirtypes';

let indexed = false;

export function indexDefinitions(bundle: Bundle): void {
  indexStructureDefinitionBundle(bundle);
  indexed = true;
}

// The first problem Medplum reports: the FHIRPath of the element (e.g.
// 'MedicationRequest.reasonCode[0].text', or the resource type for a resource-level
// constraint) and the message.
export interface Invalid {
  path: string;
  message: string;
}

export function validate(resource: Resource): Invalid | undefined {
  if (!indexed) throw new Error('validate: indexDefinitions has not been called');
  try {
    validateResource(resource);
    return undefined;
  } catch (e) {
    if (!(e instanceof OperationOutcomeError)) throw e;
    const issue = e.outcome.issue?.[0];
    return { path: issue?.expression?.[0] ?? resource.resourceType, message: issue?.details?.text ?? e.message };
  }
}
