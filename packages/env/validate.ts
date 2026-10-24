// Write validation step 4 (design section 2, "Write validation"): Medplum's validateResource
// against the pruned R4 definitions in fixtures/definitions-pruned.json, the same validator and
// bundle the fixture check runs over the world (packages/env/test/validate-fixtures.test.ts),
// then the required bindings of the coded elements the write tools set (below).
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

// The first problem found: the FHIRPath of the element (e.g.
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
  } catch (e) {
    if (!(e instanceof OperationOutcomeError)) throw e;
    const issue = e.outcome.issue?.[0];
    return { path: issue?.expression?.[0] ?? resource.resourceType, message: issue?.details?.text ?? e.message };
  }
  return unbound(resource);
}

// Medplum's validateResource does not check codes against their value sets, so a write with
// intent 'bogus-intent' would pass it. These are the R4 required bindings (and, for the example-
// bound categories, the code system the tools write) of every coded element a write tool sets.
// A code is checked where it is: `code` elements as strings, CodeableConcepts by their codings in
// `system` (with `required`, one such coding must be present).
type Binding = { path: string; codes: readonly string[]; system?: string; required?: boolean };

const REQUEST_PRIORITY = ['routine', 'urgent', 'asap', 'stat'];
const REQUEST_INTENT = ['proposal', 'plan', 'directive', 'order', 'original-order', 'reflex-order', 'filler-order', 'instance-order', 'option'];
const UNITS_OF_TIME = ['s', 'min', 'h', 'd', 'wk', 'mo', 'a'];
const EVENT_TIMING = [
  'MORN', 'MORN.early', 'MORN.late', 'NOON', 'AFT', 'AFT.early', 'AFT.late', 'EVE', 'EVE.early', 'EVE.late', 'NIGHT', 'PHS',
  'HS', 'WAKE', 'C', 'CM', 'CD', 'CV', 'AC', 'ACM', 'ACD', 'ACV', 'PC', 'PCM', 'PCD', 'PCV',
];
const TIMING = (at: string): Binding[] => [
  { path: `${at}.timing.repeat.periodUnit`, codes: UNITS_OF_TIME },
  { path: `${at}.timing.repeat.durationUnit`, codes: UNITS_OF_TIME },
  { path: `${at}.timing.repeat.when`, codes: EVENT_TIMING },
];

const BINDINGS: Readonly<Record<string, readonly Binding[]>> = {
  MedicationRequest: [
    { path: 'status', codes: ['active', 'on-hold', 'cancelled', 'completed', 'entered-in-error', 'stopped', 'draft', 'unknown'] },
    { path: 'intent', codes: ['proposal', 'plan', 'order', 'original-order', 'reflex-order', 'filler-order', 'instance-order', 'option'] },
    { path: 'priority', codes: REQUEST_PRIORITY },
    { path: 'category', system: 'http://terminology.hl7.org/CodeSystem/medicationrequest-category', codes: ['inpatient', 'outpatient', 'community', 'discharge'] },
    ...TIMING('dosageInstruction'),
  ],
  ServiceRequest: [
    { path: 'status', codes: ['draft', 'active', 'on-hold', 'revoked', 'completed', 'entered-in-error', 'unknown'] },
    { path: 'intent', codes: REQUEST_INTENT },
    { path: 'priority', codes: REQUEST_PRIORITY },
  ],
  Task: [
    { path: 'status', codes: ['draft', 'requested', 'received', 'accepted', 'rejected', 'ready', 'cancelled', 'in-progress', 'on-hold', 'failed', 'completed', 'entered-in-error'] },
    { path: 'intent', codes: ['unknown', 'proposal', 'plan', 'order', 'original-order', 'reflex-order', 'filler-order', 'instance-order', 'option'] },
    { path: 'priority', codes: REQUEST_PRIORITY },
  ],
  Communication: [
    { path: 'status', codes: ['preparation', 'in-progress', 'not-done', 'on-hold', 'stopped', 'completed', 'entered-in-error', 'unknown'] },
    { path: 'priority', codes: REQUEST_PRIORITY },
  ],
  AllergyIntolerance: [
    { path: 'clinicalStatus', system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical', codes: ['active', 'inactive', 'resolved'], required: true },
    { path: 'verificationStatus', system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-verification', codes: ['unconfirmed', 'confirmed', 'refuted', 'entered-in-error'], required: true },
    { path: 'type', codes: ['allergy', 'intolerance'] },
    { path: 'category', codes: ['food', 'medication', 'environment', 'biologic'] },
    { path: 'criticality', codes: ['low', 'high', 'unable-to-assess'] },
    { path: 'reaction.severity', codes: ['mild', 'moderate', 'severe'] },
  ],
  DocumentReference: [
    { path: 'status', codes: ['current', 'superseded', 'entered-in-error'] },
    { path: 'docStatus', codes: ['preliminary', 'final', 'amended', 'entered-in-error'] },
  ],
  Provenance: [{ path: 'entity.role', codes: ['derivation', 'revision', 'quotation', 'source', 'removal'] }],
};

// Every value at a dotted path, with its FHIRPath (array members indexed).
function at(value: unknown, path: readonly string[], where: string, out: Array<[string, unknown]> = []): Array<[string, unknown]> {
  if (value === undefined || value === null) return out;
  if (Array.isArray(value)) {
    value.forEach((v, i) => at(v, path, `${where}[${i}]`, out));
    return out;
  }
  if (path.length === 0) out.push([where, value]);
  else if (typeof value === 'object') at((value as Record<string, unknown>)[path[0]!], path.slice(1), `${where}.${path[0]}`, out);
  return out;
}

function unbound(resource: Resource): Invalid | undefined {
  for (const b of BINDINGS[resource.resourceType] ?? []) {
    for (const [path, value] of at(resource, b.path.split('.'), resource.resourceType)) {
      const allowed = `one of ${b.codes.join(', ')}`;
      if (b.system === undefined) {
        if (typeof value !== 'string' || !b.codes.includes(value)) return { path, message: `Value ${JSON.stringify(value)} is not in the required value set (${allowed})` };
        continue;
      }
      const codings = ((value as { coding?: Array<{ system?: string; code?: string }> }).coding ?? []).filter((c) => c.system === b.system);
      const bad = codings.find((c) => c.code === undefined || !b.codes.includes(c.code));
      if (bad) return { path, message: `Code ${JSON.stringify(bad.code)} of ${b.system} is not ${allowed}` };
      if (b.required && codings.length === 0) return { path, message: `A coding from ${b.system} is required (${allowed})` };
    }
  }
  return undefined;
}
