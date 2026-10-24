// What a gate check can read of a resource (design section 5: "Gate checks never compare free
// text"): an allowlist of structured fields per resource type (codes, references, status,
// quantities, dates and ids), typed by the narrow Gate* interfaces below, never by the FHIR
// Resource type. A string the agent wrote (a Task description, a message subject or body, a
// note title or text, any CodeableConcept.text, a reason, a status reason, an as-needed reason,
// a sig) is not on the object a gate gets, and a gate that reads one does not type-check. A
// field missing here is dropped; a resource type missing here keeps only its type and id.
//
// Coding.display is kept: the write tools copy it from the catalog or the world, never from
// the model's input, and the RxNorm normaliser reads it. Reference.display is dropped.
import type { Resource } from '../env/store.ts';

export interface GateCoding { system?: string; code?: string; display?: string }
export interface GateConcept { coding?: GateCoding[] }
export interface GateIdentifier { system?: string; value?: string }
export interface GateRef { reference?: string; identifier?: GateIdentifier }
export interface GateQuantity { value?: number; unit?: string; system?: string; code?: string; comparator?: string }
export interface GatePeriod { start?: string; end?: string }
export interface GateTimingRepeat {
  count?: number; frequency?: number; period?: number; periodUnit?: string; when?: string[]; dayOfWeek?: string[]; timeOfDay?: string[]; boundsPeriod?: GatePeriod;
}
export interface GateTiming { event?: string[]; repeat?: GateTimingRepeat; code?: GateConcept }
export interface GateDosage {
  sequence?: number; timing?: GateTiming; asNeededBoolean?: boolean; asNeededCodeableConcept?: GateConcept; route?: GateConcept;
  doseAndRate?: Array<{ doseQuantity?: GateQuantity }>;
}

export interface GatePatient {
  resourceType: 'Patient'; id: string; birthDate?: string; gender?: string; deceasedBoolean?: boolean; deceasedDateTime?: string;
  identifier?: GateIdentifier[]; generalPractitioner?: GateRef[]; managingOrganization?: GateRef;
}
export interface GatePractitioner { resourceType: 'Practitioner'; id: string; active?: boolean; identifier?: GateIdentifier[] }
export interface GateOrganization { resourceType: 'Organization'; id: string; active?: boolean; identifier?: GateIdentifier[] }
export interface GateGroup { resourceType: 'Group'; id: string; type?: string; actual?: boolean; active?: boolean; member?: Array<{ entity?: GateRef; inactive?: boolean }> }
export interface GateEncounter {
  resourceType: 'Encounter'; id: string; status?: string; class?: GateCoding; type?: GateConcept[]; subject?: GateRef;
  participant?: Array<{ individual?: GateRef; type?: GateConcept[] }>; period?: GatePeriod; serviceProvider?: GateRef; reasonCode?: GateConcept[]; reasonReference?: GateRef[];
}
export interface GateCondition {
  resourceType: 'Condition'; id: string; clinicalStatus?: GateConcept; verificationStatus?: GateConcept; category?: GateConcept[]; code?: GateConcept;
  subject?: GateRef; encounter?: GateRef; onsetDateTime?: string; abatementDateTime?: string; recordedDate?: string;
}
export interface GateObservation {
  resourceType: 'Observation'; id: string; status?: string; category?: GateConcept[]; code?: GateConcept; subject?: GateRef; encounter?: GateRef;
  effectiveDateTime?: string; effectivePeriod?: GatePeriod; issued?: string; valueQuantity?: GateQuantity; valueCodeableConcept?: GateConcept;
  valueBoolean?: boolean; valueInteger?: number; interpretation?: GateConcept[]; hasMember?: GateRef[]; derivedFrom?: GateRef[];
  component?: Array<{ code?: GateConcept; valueQuantity?: GateQuantity; valueCodeableConcept?: GateConcept }>;
}
export interface GateDiagnosticReport {
  resourceType: 'DiagnosticReport'; id: string; status?: string; category?: GateConcept[]; code?: GateConcept; subject?: GateRef; encounter?: GateRef;
  effectiveDateTime?: string; issued?: string; performer?: GateRef[]; result?: GateRef[]; basedOn?: GateRef[];
}
export interface GateProcedure {
  resourceType: 'Procedure'; id: string; status?: string; code?: GateConcept; subject?: GateRef; encounter?: GateRef;
  performedDateTime?: string; performedPeriod?: GatePeriod; reasonCode?: GateConcept[]; reasonReference?: GateRef[];
}
export interface GateAllergyIntolerance {
  resourceType: 'AllergyIntolerance'; id: string; clinicalStatus?: GateConcept; verificationStatus?: GateConcept; type?: string; category?: string[];
  criticality?: string; code?: GateConcept; patient?: GateRef; onsetDateTime?: string; recordedDate?: string;
  reaction?: Array<{ substance?: GateConcept; manifestation?: GateConcept[]; severity?: string }>;
}
export interface GateMedicationRequest {
  resourceType: 'MedicationRequest'; id: string; status?: string; statusReason?: GateConcept; intent?: string; category?: GateConcept[]; priority?: string;
  doNotPerform?: boolean; medicationCodeableConcept?: GateConcept; medicationReference?: GateRef; subject?: GateRef; encounter?: GateRef;
  authoredOn?: string; requester?: GateRef; reasonCode?: GateConcept[]; reasonReference?: GateRef[]; basedOn?: GateRef[]; priorPrescription?: GateRef;
  dosageInstruction?: GateDosage[];
  dispenseRequest?: { quantity?: GateQuantity; numberOfRepeatsAllowed?: number; validityPeriod?: GatePeriod };
}
export interface GateServiceRequest {
  resourceType: 'ServiceRequest'; id: string; status?: string; intent?: string; category?: GateConcept[]; priority?: string; doNotPerform?: boolean;
  code?: GateConcept; subject?: GateRef; encounter?: GateRef; occurrenceDateTime?: string; occurrencePeriod?: GatePeriod; authoredOn?: string;
  requester?: GateRef; performer?: GateRef[]; reasonCode?: GateConcept[]; reasonReference?: GateRef[]; supportingInfo?: GateRef[]; basedOn?: GateRef[];
}
export interface GateTask {
  resourceType: 'Task'; id: string; status?: string; statusReason?: GateConcept; businessStatus?: GateConcept; intent?: string; priority?: string;
  code?: GateConcept; focus?: GateRef; for?: GateRef; encounter?: GateRef; authoredOn?: string; lastModified?: string; requester?: GateRef;
  owner?: GateRef; basedOn?: GateRef[]; partOf?: GateRef[]; executionPeriod?: GatePeriod;
  restriction?: { period?: GatePeriod; recipient?: GateRef[] };
  output?: Array<{ type?: GateConcept; valueReference?: GateRef }>;
}
export interface GateCommunication {
  resourceType: 'Communication'; id: string; status?: string; category?: GateConcept[]; priority?: string; medium?: GateConcept[]; subject?: GateRef;
  about?: GateRef[]; basedOn?: GateRef[]; partOf?: GateRef[]; inResponseTo?: GateRef[]; encounter?: GateRef; sent?: string; received?: string;
  recipient?: GateRef[]; sender?: GateRef; reasonReference?: GateRef[];
}
export interface GateDocumentReference {
  resourceType: 'DocumentReference'; id: string; status?: string; docStatus?: string; type?: GateConcept; category?: GateConcept[]; subject?: GateRef;
  date?: string; author?: GateRef[]; authenticator?: GateRef; custodian?: GateRef;
  relatesTo?: Array<{ code?: string; target?: GateRef }>;
  content?: Array<{ attachment?: { contentType?: string; language?: string; creation?: string }; format?: GateCoding }>;
  context?: { encounter?: GateRef[]; period?: GatePeriod; related?: GateRef[] };
}
export interface GateProvenance {
  resourceType: 'Provenance'; id: string; target?: GateRef[]; recorded?: string; occurredDateTime?: string; activity?: GateConcept;
  agent?: Array<{ type?: GateConcept; who?: GateRef; onBehalfOf?: GateRef }>;
  entity?: Array<{ role?: string; what?: GateRef }>;
}
export interface GateAppointment {
  resourceType: 'Appointment'; id: string; status?: string; serviceType?: GateConcept[]; appointmentType?: GateConcept; start?: string; end?: string;
  created?: string; basedOn?: GateRef[]; reasonReference?: GateRef[]; supportingInformation?: GateRef[];
  participant?: Array<{ actor?: GateRef; status?: string; type?: GateConcept[] }>;
}
// Any other resource type: its type and id only.
export interface GateOther { resourceType: string; id: string }

export interface GateMap {
  Patient: GatePatient; Practitioner: GatePractitioner; Organization: GateOrganization; Group: GateGroup; Encounter: GateEncounter;
  Condition: GateCondition; Observation: GateObservation; DiagnosticReport: GateDiagnosticReport; Procedure: GateProcedure;
  AllergyIntolerance: GateAllergyIntolerance; MedicationRequest: GateMedicationRequest; ServiceRequest: GateServiceRequest; Task: GateTask;
  Communication: GateCommunication; DocumentReference: GateDocumentReference; Provenance: GateProvenance; Appointment: GateAppointment;
}
export type GateType = keyof GateMap;
export type GateResource = GateMap[GateType] | GateOther;
export type GateOf<T extends string> = T extends GateType ? GateMap[T] : GateOther;

// A projector maps a value to its allowed part, or undefined to drop it.
type P = (v: unknown) => unknown;
// Every key of T, each with its projector: a field added to a Gate* type must be added here.
type Spec<T> = { [K in keyof T]-?: P };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str: P = (v) => (typeof v === 'string' ? v : undefined);
const num: P = (v) => (typeof v === 'number' ? v : undefined);
const bool: P = (v) => (typeof v === 'boolean' ? v : undefined);
const list = (p: P): P => (v) => (Array.isArray(v) ? v.map(p).filter((x) => x !== undefined) : undefined);
function obj<T>(spec: Spec<T>): P {
  return (v) => {
    if (!isObj(v)) return undefined;
    const out: Record<string, unknown> = {};
    for (const [k, p] of Object.entries(spec) as Array<[string, P]>) {
      const x = p(v[k]);
      if (x !== undefined) out[k] = x;
    }
    return out;
  };
}

const coding = obj<GateCoding>({ system: str, code: str, display: str });
const concept = obj<GateConcept>({ coding: list(coding) });
const concepts = list(concept);
const identifier = obj<GateIdentifier>({ system: str, value: str });
const ref = obj<GateRef>({ reference: str, identifier });
const refs = list(ref);
const quantity = obj<GateQuantity>({ value: num, unit: str, system: str, code: str, comparator: str });
const period = obj<GatePeriod>({ start: str, end: str });
const strs = list(str);
const timing = obj<GateTiming>({
  event: strs,
  repeat: obj<GateTimingRepeat>({ count: num, frequency: num, period: num, periodUnit: str, when: strs, dayOfWeek: strs, timeOfDay: strs, boundsPeriod: period }),
  code: concept,
});
const dosage = obj<GateDosage>({
  sequence: num, timing, asNeededBoolean: bool, asNeededCodeableConcept: concept, route: concept,
  doseAndRate: list(obj<{ doseQuantity?: GateQuantity }>({ doseQuantity: quantity })),
});

const base = { resourceType: str, id: str };
const PROJECT: { [T in GateType]: P } = {
  Patient: obj<GatePatient>({ ...base, birthDate: str, gender: str, deceasedBoolean: bool, deceasedDateTime: str, identifier: list(identifier), generalPractitioner: refs, managingOrganization: ref }),
  Practitioner: obj<GatePractitioner>({ ...base, active: bool, identifier: list(identifier) }),
  Organization: obj<GateOrganization>({ ...base, active: bool, identifier: list(identifier) }),
  Group: obj<GateGroup>({ ...base, type: str, actual: bool, active: bool, member: list(obj<NonNullable<GateGroup['member']>[number]>({ entity: ref, inactive: bool })) }),
  Encounter: obj<GateEncounter>({
    ...base, status: str, class: coding, type: concepts, subject: ref, period, serviceProvider: ref, reasonCode: concepts, reasonReference: refs,
    participant: list(obj<NonNullable<GateEncounter['participant']>[number]>({ individual: ref, type: concepts })),
  }),
  Condition: obj<GateCondition>({
    ...base, clinicalStatus: concept, verificationStatus: concept, category: concepts, code: concept, subject: ref, encounter: ref,
    onsetDateTime: str, abatementDateTime: str, recordedDate: str,
  }),
  Observation: obj<GateObservation>({
    ...base, status: str, category: concepts, code: concept, subject: ref, encounter: ref, effectiveDateTime: str, effectivePeriod: period, issued: str,
    valueQuantity: quantity, valueCodeableConcept: concept, valueBoolean: bool, valueInteger: num, interpretation: concepts, hasMember: refs, derivedFrom: refs,
    component: list(obj<NonNullable<GateObservation['component']>[number]>({ code: concept, valueQuantity: quantity, valueCodeableConcept: concept })),
  }),
  DiagnosticReport: obj<GateDiagnosticReport>({
    ...base, status: str, category: concepts, code: concept, subject: ref, encounter: ref, effectiveDateTime: str, issued: str, performer: refs, result: refs, basedOn: refs,
  }),
  Procedure: obj<GateProcedure>({
    ...base, status: str, code: concept, subject: ref, encounter: ref, performedDateTime: str, performedPeriod: period, reasonCode: concepts, reasonReference: refs,
  }),
  AllergyIntolerance: obj<GateAllergyIntolerance>({
    ...base, clinicalStatus: concept, verificationStatus: concept, type: str, category: strs, criticality: str, code: concept, patient: ref,
    onsetDateTime: str, recordedDate: str,
    reaction: list(obj<NonNullable<GateAllergyIntolerance['reaction']>[number]>({ substance: concept, manifestation: concepts, severity: str })),
  }),
  MedicationRequest: obj<GateMedicationRequest>({
    ...base, status: str, statusReason: concept, intent: str, category: concepts, priority: str, doNotPerform: bool, medicationCodeableConcept: concept,
    medicationReference: ref, subject: ref, encounter: ref, authoredOn: str, requester: ref, reasonCode: concepts, reasonReference: refs, basedOn: refs,
    priorPrescription: ref, dosageInstruction: list(dosage),
    dispenseRequest: obj<NonNullable<GateMedicationRequest['dispenseRequest']>>({ quantity, numberOfRepeatsAllowed: num, validityPeriod: period }),
  }),
  ServiceRequest: obj<GateServiceRequest>({
    ...base, status: str, intent: str, category: concepts, priority: str, doNotPerform: bool, code: concept, subject: ref, encounter: ref,
    occurrenceDateTime: str, occurrencePeriod: period, authoredOn: str, requester: ref, performer: refs, reasonCode: concepts, reasonReference: refs,
    supportingInfo: refs, basedOn: refs,
  }),
  Task: obj<GateTask>({
    ...base, status: str, statusReason: concept, businessStatus: concept, intent: str, priority: str, code: concept, focus: ref, for: ref, encounter: ref,
    authoredOn: str, lastModified: str, requester: ref, owner: ref, basedOn: refs, partOf: refs, executionPeriod: period,
    restriction: obj<NonNullable<GateTask['restriction']>>({ period, recipient: refs }),
    output: list(obj<NonNullable<GateTask['output']>[number]>({ type: concept, valueReference: ref })),
  }),
  Communication: obj<GateCommunication>({
    ...base, status: str, category: concepts, priority: str, medium: concepts, subject: ref, about: refs, basedOn: refs, partOf: refs, inResponseTo: refs,
    encounter: ref, sent: str, received: str, recipient: refs, sender: ref, reasonReference: refs,
  }),
  DocumentReference: obj<GateDocumentReference>({
    ...base, status: str, docStatus: str, type: concept, category: concepts, subject: ref, date: str, author: refs, authenticator: ref, custodian: ref,
    relatesTo: list(obj<NonNullable<GateDocumentReference['relatesTo']>[number]>({ code: str, target: ref })),
    content: list(obj<NonNullable<GateDocumentReference['content']>[number]>({
      attachment: obj<NonNullable<NonNullable<GateDocumentReference['content']>[number]['attachment']>>({ contentType: str, language: str, creation: str }),
      format: coding,
    })),
    context: obj<NonNullable<GateDocumentReference['context']>>({ encounter: refs, period, related: refs }),
  }),
  Provenance: obj<GateProvenance>({
    ...base, target: refs, recorded: str, occurredDateTime: str, activity: concept,
    agent: list(obj<NonNullable<GateProvenance['agent']>[number]>({ type: concept, who: ref, onBehalfOf: ref })),
    entity: list(obj<NonNullable<GateProvenance['entity']>[number]>({ role: str, what: ref })),
  }),
  Appointment: obj<GateAppointment>({
    ...base, status: str, serviceType: concepts, appointmentType: concept, start: str, end: str, created: str, basedOn: refs, reasonReference: refs,
    supportingInformation: refs, participant: list(obj<NonNullable<GateAppointment['participant']>[number]>({ actor: ref, status: str, type: concepts })),
  }),
};
const other = obj<GateOther>(base);

function freeze<T>(v: T): T {
  if (typeof v === 'object' && v !== null) {
    for (const x of Object.values(v)) freeze(x);
    Object.freeze(v);
  }
  return v;
}

// The gate view of a resource: its allowed fields only, frozen.
export function gateResource(r: Readonly<Resource>): GateResource {
  const project = Object.hasOwn(PROJECT, r.resourceType) ? PROJECT[r.resourceType as GateType] : other;
  return freeze(project(r) as GateResource);
}
