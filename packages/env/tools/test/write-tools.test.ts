// Contract tests for the write tools (plan phase P6, design section 2 "Write validation" and
// section 3): the resource each tool builds, one Provenance per committed write, ids and stamps
// from the write sequence, and a rejection at each of the five validation steps that names the
// field and leaves the store, the hash and the write sequence unchanged.
import { readFileSync } from 'node:fs';
import type {
  AllergyIntolerance, Bundle, Communication, DocumentReference, MedicationRequest, Provenance, Resource, ServiceRequest, Task,
} from '@medplum/fhirtypes';
import { beforeAll, describe, expect, it } from 'vitest';
import { clock } from '../../clock.ts';
import { parseNdjson } from '../../fixture-source.ts';
import { stateHash } from '../../hash.ts';
import { Store } from '../../store.ts';
import { indexDefinitions } from '../../validate.ts';
import { INBOX_QUEUE_SYSTEM, READ_TOOLS, type CatalogEntry, type Policy } from '../read/index.ts';
import { callTool, definitions, type PropertySchema, type ToolResult } from '../registry.ts';
import { commit, newSession, TOOLS, WRITE_TOOLS, type WriteContext as Context } from '../write/index.ts';

// The trial's store is a whole Store; the tools see only get, search and put.
type WriteContext = Context & { world: Store };

const root = new URL('../../../../', import.meta.url);
const base = await parseNdjson(readFileSync(new URL('fixtures/world.ndjson.gz', root)));
beforeAll(() => indexDefinitions(JSON.parse(readFileSync(new URL('fixtures/definitions-pruned.json', root), 'utf8')) as Bundle));

const RXNORM = 'http://www.nlm.nih.gov/research/umls/rxnorm';
const CATALOG: CatalogEntry[] = [
  { kind: 'medication', code: '860975', system: RXNORM, display: 'metformin hydrochloride 500 MG Oral Tablet', strengths: ['500 mg'] },
  { kind: 'medication', code: '723', system: RXNORM, display: 'amoxicillin' },
  { kind: 'lab', code: '2160-0', system: 'http://loinc.org', display: 'Creatinine [Mass/volume] in Serum or Plasma' },
  { kind: 'imaging', code: 'IMG-CT-CHEST-WO', system: 'urn:riverbend:orders', display: 'CT chest without contrast' },
  { kind: 'referral', code: 'REF-GI', system: 'urn:riverbend:orders', display: 'Referral to gastroenterology' },
];
const POLICIES: Policy[] = [{ id: 'RBC-TEST-01', title: 'Test', version: '1', effective: '2026-01-01', source: 'environment-local', text: 'Text.' }];

// Inbox items in the queue convention list_inbox reads (read/context.ts).
const inboxTask = (id: string, queue: string, patient: string, status: Task['status'] = 'requested'): Task => ({
  resourceType: 'Task',
  id,
  status,
  intent: 'order',
  code: { coding: [{ system: INBOX_QUEUE_SYSTEM, code: queue }] },
  focus: { reference: 'DiagnosticReport/dr-00001' },
  for: { reference: `Patient/${patient}` },
  authoredOn: '2026-10-22T09:00:00-04:00',
  requester: { reference: 'Organization/org-st-brigid' },
  owner: { reference: 'Practitioner/pr-okafor' },
  description: `item ${id}`,
});
const INBOX = [inboxTask('task-w-1', 'results', 'pt-0001'), inboxTask('task-w-2', 'messages', 'pt-0001'), inboxTask('task-w-3', 'results', 'pt-0001', 'completed')];
// A test-only on-hold request and an entered-in-error allergy, so every transition has a subject.
const ON_HOLD: MedicationRequest = { ...(base.find((r) => r.id === 'mr-00005') as MedicationRequest), id: 'mr-w-hold', status: 'on-hold' };
const { clinicalStatus: _active, ...ALG_1 } = base.find((r) => r.id === 'alg-00001') as AllergyIntolerance;
const EIE_ALLERGY: AllergyIntolerance = {
  ...ALG_1,
  id: 'alg-w-eie',
  verificationStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-verification', code: 'entered-in-error' }] },
};

const fresh = (): WriteContext => ({
  world: new Store([...base, ...INBOX, ON_HOLD, EIE_ALLERGY]),
  clock,
  policies: POLICIES,
  catalog: CATALOG,
  session: newSession(),
});

const ok = (r: ToolResult): Record<string, unknown> => {
  if (r.is_error) throw new Error(`expected success, got ${JSON.stringify(r.content)}`);
  return r.content as Record<string, unknown>;
};
const stamp = (n: number) => clock.stamp(n);

// Runs a call that must be rejected and checks that nothing changed.
async function rejected(c: WriteContext, name: string, input: unknown): Promise<{ code: string; message: string; field?: string }> {
  const before = await stateHash(c.world.resources());
  const size = c.world.size;
  const seq = c.session.writeSeq;
  const r = callTool(TOOLS, name, input, c);
  expect(r.is_error, JSON.stringify(r.content)).toBe(true);
  expect(r.written_ids).toBeUndefined();
  expect(c.world.size).toBe(size);
  expect(c.session.writeSeq).toBe(seq);
  expect(await stateHash(c.world.resources())).toBe(before);
  return (r.content as { error: { code: string; message: string; field?: string } }).error;
}

const get = <T extends Resource>(c: WriteContext, ref: string) => {
  const [type, id] = ref.split('/') as [string, string];
  const r = c.world.get<T>(type, id);
  if (!r) throw new Error(`${ref} not in the store`);
  return r;
};

const WRITE_NAMES = [
  'order_medication', 'change_medication', 'order_service', 'create_task', 'send_message', 'record_allergy', 'write_note', 'update_inbox_item', 'finish',
];

describe('definitions', () => {
  it('lists the nine write tools after the nine read tools, every object schema strict', () => {
    expect(WRITE_TOOLS.map((t) => t.name)).toEqual(WRITE_NAMES);
    expect(TOOLS.map((t) => t.name)).toEqual([...READ_TOOLS.map((t) => t.name), ...WRITE_NAMES]);
    const strict = (s: PropertySchema | WriteContext['session'] | Record<string, unknown>): void => {
      const p = s as PropertySchema;
      if (p.type === 'object') {
        expect(p.additionalProperties).toBe(false);
        for (const r of p.required ?? []) expect(Object.keys(p.properties)).toContain(r);
        for (const v of Object.values(p.properties)) strict(v);
      }
      if (p.type === 'array') strict(p.items);
    };
    for (const d of definitions(WRITE_TOOLS)) {
      expect(d.description.length).toBeGreaterThan(20);
      strict({ ...d.inputSchema, description: d.description } as PropertySchema);
    }
  });
});

describe('order_medication', () => {
  const metformin = { patient: 'pt-0001', rxnorm_code: '860975', dose_value: 500, dose_unit: 'mg', route: 'oral', frequency: 'BID', supply_days: 30, refills: 0, reason: 'type 2 diabetes' };

  it('creates mr-t0001 stamped NOW + 1 s with one Provenance, then mr-t0002 at NOW + 2 s', async () => {
    const c = fresh();
    const before = await stateHash(c.world.resources());
    const r = callTool(TOOLS, 'order_medication', metformin, c);
    expect(ok(r)).toEqual({ medication_request: 'MedicationRequest/mr-t0001', status: 'active' });
    expect(r.written_ids).toEqual(['MedicationRequest/mr-t0001', 'Provenance/prov-t0001']);
    const mr = get<MedicationRequest>(c, 'MedicationRequest/mr-t0001');
    expect(mr).toMatchObject({
      status: 'active',
      intent: 'order',
      subject: { reference: 'Patient/pt-0001' },
      requester: { reference: 'Practitioner/pr-okafor' },
      authoredOn: stamp(1),
      medicationCodeableConcept: { coding: [{ system: RXNORM, code: '860975', display: 'metformin hydrochloride 500 MG Oral Tablet' }] },
      reasonCode: [{ text: 'type 2 diabetes' }],
      dispenseRequest: { numberOfRepeatsAllowed: 0, expectedSupplyDuration: { value: 30, unit: 'days', system: 'http://unitsofmeasure.org', code: 'd' } },
    });
    expect(mr.dosageInstruction?.[0]?.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 500, unit: 'mg', system: 'http://unitsofmeasure.org', code: 'mg' });
    expect(mr.dosageInstruction?.[0]?.timing?.repeat).toMatchObject({ frequency: 2, period: 1, periodUnit: 'd' });
    const prov = get<Provenance>(c, 'Provenance/prov-t0001');
    expect(prov).toMatchObject({ target: [{ reference: 'MedicationRequest/mr-t0001' }], recorded: stamp(1), agent: [{ who: { reference: 'Practitioner/pr-okafor' } }] });
    expect(c.session.writeSeq).toBe(1);
    expect(await stateHash(c.world.resources())).not.toBe(before);

    const r2 = callTool(TOOLS, 'order_medication', { ...metformin, frequency: undefined, timing_events: ['2026-10-24T09:00:00-04:00', '2026-10-25T09:00-04:00'] }, c);
    expect(ok(r2).medication_request).toBe('MedicationRequest/mr-t0002');
    const mr2 = get<MedicationRequest>(c, 'MedicationRequest/mr-t0002');
    expect(mr2.authoredOn).toBe(stamp(2));
    // A time without seconds is completed to FHIR's dateTime form.
    expect(mr2.dosageInstruction?.[0]?.timing?.event).toEqual(['2026-10-24T09:00:00-04:00', '2026-10-25T09:00:00-04:00']);
  });

  it('rejects at the schema, semantic and state steps, naming the field', async () => {
    const c = fresh();
    expect(await rejected(c, 'order_medication', { ...metformin, dose_value: '500' })).toMatchObject({ code: 'INVALID_INPUT', field: 'dose_value' });
    expect(await rejected(c, 'order_medication', { ...metformin, dose_value: 0 })).toMatchObject({ code: 'INVALID_INPUT', field: 'dose_value' });
    expect(await rejected(c, 'order_medication', { ...metformin, dose_unit: 'mcg' })).toMatchObject({ code: 'INVALID_INPUT', field: 'dose_unit' });
    expect(await rejected(c, 'order_medication', { ...metformin, patient: 'pt-9999' })).toMatchObject({ code: 'NOT_FOUND', field: 'patient' });
    expect(await rejected(c, 'order_medication', { ...metformin, rxnorm_code: '2160-0' })).toMatchObject({ code: 'INVALID_INPUT', field: 'rxnorm_code' });
    expect(await rejected(c, 'order_medication', { ...metformin, frequency: undefined })).toMatchObject({ code: 'INVALID_INPUT', field: 'frequency' });
    expect(await rejected(c, 'order_medication', { ...metformin, timing_events: ['2026-10-24T09:00:00-04:00'] })).toMatchObject({ code: 'INVALID_INPUT', field: 'timing_events' });
    expect(await rejected(c, 'order_medication', { ...metformin, frequency: undefined, timing_events: ['2026-10-24T09:00:00-04:00', '2026-10-22T09:00:00-04:00'] }))
      .toMatchObject({ code: 'INVALID_INPUT', field: 'timing_events[1]' });
    expect(await rejected(c, 'order_medication', { ...metformin, frequency: undefined, timing_events: ['2026-02-30T09:00:00-04:00'] }))
      .toMatchObject({ code: 'INVALID_INPUT', field: 'timing_events[0]' });
    expect(await rejected(c, 'order_medication', { ...metformin, reason: '   ' })).toMatchObject({ code: 'INVALID_INPUT', field: 'reason' });
    expect(await rejected(c, 'order_medication', { ...metformin, reason: 'bad \ud800 surrogate' })).toMatchObject({ code: 'INVALID_INPUT', field: 'reason' });
    // Step 4: Medplum rejects the control character in the reason text, mapped back to the input.
    expect(await rejected(c, 'order_medication', { ...metformin, reason: 'bad \u0001 char' })).toMatchObject({ code: 'INVALID_INPUT', field: 'reason' });
    // replaces: another patient's request, then a completed one.
    expect(await rejected(c, 'order_medication', { ...metformin, replaces: 'mr-00005', patient: 'pt-0002' })).toMatchObject({ code: 'INVALID_INPUT', field: 'replaces' });
    const completed = base.find((r) => r.resourceType === 'MedicationRequest' && (r as MedicationRequest).status === 'completed') as MedicationRequest;
    expect(await rejected(c, 'order_medication', { ...metformin, patient: completed.subject!.reference, replaces: completed.id }))
      .toMatchObject({ code: 'CONFLICT', field: 'replaces' });
  });

  it('replaces: stops the old request and links the new one, one Provenance for both', () => {
    const c = fresh();
    const r = callTool(TOOLS, 'order_medication', { ...metformin, replaces: 'MedicationRequest/mr-00005' }, c);
    expect(r.written_ids).toEqual(['MedicationRequest/mr-00005', 'MedicationRequest/mr-t0001', 'Provenance/prov-t0001']);
    expect(get<MedicationRequest>(c, 'MedicationRequest/mr-00005').status).toBe('stopped');
    expect(get<MedicationRequest>(c, 'MedicationRequest/mr-t0001').priorPrescription).toEqual({ reference: 'MedicationRequest/mr-00005' });
    const targets = get<Provenance>(c, 'Provenance/prov-t0001').target.map((t) => [t.reference, t.extension?.[0]?.valueCodeableConcept?.coding?.[0]?.code]);
    expect(targets).toEqual([['MedicationRequest/mr-00005', 'UPDATE'], ['MedicationRequest/mr-t0001', 'CREATE']]);
  });
});

describe('change_medication', () => {
  it('runs stop, hold and resume transitions and refuses illegal ones with CONFLICT', async () => {
    const c = fresh();
    expect(ok(callTool(TOOLS, 'change_medication', { medication_request: 'mr-00005', action: 'hold', reason: 'procedure' }, c))).toEqual({ medication_request: 'MedicationRequest/mr-00005', status: 'on-hold' });
    expect(await rejected(c, 'change_medication', { medication_request: 'mr-00005', action: 'hold', reason: 'again' })).toMatchObject({ code: 'CONFLICT', field: 'action' });
    expect(ok(callTool(TOOLS, 'change_medication', { medication_request: 'mr-00005', action: 'resume', reason: 'done' }, c)).status).toBe('active');
    expect(ok(callTool(TOOLS, 'change_medication', { medication_request: 'mr-00005', action: 'stop', reason: 'no longer needed' }, c)).status).toBe('stopped');
    expect(get<MedicationRequest>(c, 'MedicationRequest/mr-00005').statusReason).toEqual({ text: 'no longer needed' });
    expect(await rejected(c, 'change_medication', { medication_request: 'mr-00005', action: 'resume', reason: 'x' })).toMatchObject({ code: 'CONFLICT', field: 'action' });
    expect(await rejected(c, 'change_medication', { medication_request: 'mr-nope', action: 'stop', reason: 'x' })).toMatchObject({ code: 'NOT_FOUND', field: 'medication_request' });
    expect(await rejected(c, 'change_medication', { medication_request: 'mr-w-hold', action: 'modify', reason: 'x' })).toMatchObject({ code: 'INVALID_INPUT', field: 'new_dose' });
    expect(await rejected(c, 'change_medication', { medication_request: 'mr-w-hold', action: 'stop', reason: 'x', new_dose: { value: 1, unit: 'mg', frequency: 'QD' } }))
      .toMatchObject({ code: 'INVALID_INPUT', field: 'new_dose' });
    expect(await rejected(c, 'change_medication', { medication_request: 'mr-w-hold', action: 'modify', reason: 'x', new_dose: { value: 1, unit: 'mg', frequency: 'QD', extra: 1 } }))
      .toMatchObject({ code: 'INVALID_INPUT', field: 'new_dose.extra' });
    expect(await rejected(c, 'change_medication', { medication_request: 'mr-w-hold', action: 'modify', reason: 'x', new_dose: { value: -1, unit: 'mg', frequency: 'QD' } }))
      .toMatchObject({ code: 'INVALID_INPUT', field: 'new_dose.value' });
    expect(c.session.writeSeq).toBe(3);
  });

  it('modify stops the old request and creates the new one linked by priorPrescription', () => {
    const c = fresh();
    const r = callTool(TOOLS, 'change_medication', { medication_request: 'mr-w-hold', action: 'modify', reason: 'renal dosing', new_dose: { value: 200, unit: 'mg', frequency: 'QD' } }, c);
    expect(ok(r)).toEqual({ medication_request: 'MedicationRequest/mr-w-hold', status: 'stopped', new_medication_request: 'MedicationRequest/mr-t0001' });
    expect(r.written_ids).toEqual(['MedicationRequest/mr-t0001', 'MedicationRequest/mr-w-hold', 'Provenance/prov-t0001']);
    const next = get<MedicationRequest>(c, 'MedicationRequest/mr-t0001');
    expect(next).toMatchObject({ status: 'active', priorPrescription: { reference: 'MedicationRequest/mr-w-hold' }, medicationCodeableConcept: ON_HOLD.medicationCodeableConcept, subject: ON_HOLD.subject });
    expect(next.dosageInstruction?.[0]?.doseAndRate?.[0]?.doseQuantity?.value).toBe(200);
  });
});

describe('order_service', () => {
  const ct = { patient: 'pt-0001', code: 'IMG-CT-CHEST-WO', priority: 'routine', occurrence_start: '2027-06-04', occurrence_end: '2027-07-04', reason: 'nodule follow-up' };
  it('creates sr-t0001 with the occurrence window, supporting and based_on references', () => {
    const c = fresh();
    const r = callTool(TOOLS, 'order_service', { ...ct, supporting: ['DocumentReference/doc-00001'], based_on: ['MedicationRequest/mr-00005'] }, c);
    expect(ok(r)).toEqual({ service_request: 'ServiceRequest/sr-t0001' });
    expect(get<ServiceRequest>(c, 'ServiceRequest/sr-t0001')).toMatchObject({
      status: 'active',
      intent: 'order',
      priority: 'routine',
      subject: { reference: 'Patient/pt-0001' },
      occurrencePeriod: { start: '2027-06-04', end: '2027-07-04' },
      authoredOn: stamp(1),
      code: { coding: [{ system: 'urn:riverbend:orders', code: 'IMG-CT-CHEST-WO' }] },
      supportingInfo: [{ reference: 'DocumentReference/doc-00001' }],
      basedOn: [{ reference: 'MedicationRequest/mr-00005' }],
    });
  });
  it('rejects bad windows, codes and references, naming the field', async () => {
    const c = fresh();
    expect(await rejected(c, 'order_service', { ...ct, occurrence_start: '2026-10-22' })).toMatchObject({ code: 'INVALID_INPUT', field: 'occurrence_start' });
    expect(await rejected(c, 'order_service', { ...ct, occurrence_start: '2027-02-30', occurrence_end: undefined })).toMatchObject({ code: 'INVALID_INPUT', field: 'occurrence_start' });
    expect(await rejected(c, 'order_service', { ...ct, occurrence_end: '2027-06-01' })).toMatchObject({ code: 'INVALID_INPUT', field: 'occurrence_end' });
    expect(await rejected(c, 'order_service', { ...ct, code: '860975' })).toMatchObject({ code: 'INVALID_INPUT', field: 'code' });
    expect(await rejected(c, 'order_service', { ...ct, supporting: ['Observation/obs-nope'] })).toMatchObject({ code: 'NOT_FOUND', field: 'supporting[0]' });
    const other = base.find((r) => r.resourceType === 'Observation' && (r as { subject?: { reference?: string } }).subject?.reference !== 'Patient/pt-0001')!;
    expect(await rejected(c, 'order_service', { ...ct, supporting: [`Observation/${other.id}`] })).toMatchObject({ code: 'INVALID_INPUT', field: 'supporting[0]' });
    expect(await rejected(c, 'order_service', { ...ct, based_on: ['Encounter/enc-00001'] })).toMatchObject({ code: 'INVALID_INPUT', field: 'based_on[0]' });
    expect(await rejected(c, 'order_service', { ...ct, supporting: 'Observation/obs-00001' })).toMatchObject({ code: 'INVALID_INPUT', field: 'supporting' });
  });
});

describe('create_task', () => {
  const task = { patient: 'pt-0001', owner: 'Group/pool-rn-triage', due: '2026-11-06', priority: 'routine', description: 'Call with results' };
  it('creates a requested Task that is not an inbox item', () => {
    const c = fresh();
    const r = callTool(TOOLS, 'create_task', { ...task, focus: 'DiagnosticReport/dr-00001' }, c);
    expect(ok(r)).toEqual({ task: 'Task/task-t0001' });
    const t = get<Task>(c, 'Task/task-t0001');
    expect(t).toMatchObject({ status: 'requested', intent: 'order', for: { reference: 'Patient/pt-0001' }, owner: { reference: 'Group/pool-rn-triage' }, restriction: { period: { end: '2026-11-06' } }, authoredOn: stamp(1) });
    expect(t.code).toBeUndefined();
    expect(ok(callTool(READ_TOOLS, 'list_inbox', { queue: 'results' }, c)).total).toBe(2);
  });
  it('rejects a bad owner, a past due date and a focus on another patient', async () => {
    const c = fresh();
    expect(await rejected(c, 'create_task', { ...task, owner: 'Patient/pt-0001' })).toMatchObject({ code: 'INVALID_INPUT', field: 'owner' });
    expect(await rejected(c, 'create_task', { ...task, owner: 'pr-nobody' })).toMatchObject({ code: 'NOT_FOUND', field: 'owner' });
    expect(await rejected(c, 'create_task', { ...task, due: '2026-10-23T07:59:59-04:00' })).toMatchObject({ code: 'INVALID_INPUT', field: 'due' });
    expect(await rejected(c, 'create_task', { ...task, focus: 'MedicationRequest/mr-00005', patient: 'pt-0002' })).toMatchObject({ code: 'INVALID_INPUT', field: 'focus' });
  });
});

describe('send_message', () => {
  it('sends to the patient or a clinician, with the subject taken from the references', () => {
    const c = fresh();
    const r = callTool(TOOLS, 'send_message', { recipient: 'Patient/pt-0001', priority: 'routine', subject: 'Your results', body: 'Please call us.', about: ['DiagnosticReport/dr-00001'] }, c);
    expect(ok(r)).toEqual({ communication: 'Communication/comm-t0001' });
    expect(get<Communication>(c, 'Communication/comm-t0001')).toMatchObject({
      status: 'completed',
      sent: stamp(1),
      sender: { reference: 'Practitioner/pr-okafor' },
      recipient: [{ reference: 'Patient/pt-0001' }],
      subject: { reference: 'Patient/pt-0001' },
      topic: { text: 'Your results' },
      payload: [{ contentString: 'Please call us.' }],
      about: [{ reference: 'DiagnosticReport/dr-00001' }],
    });
    const r2 = callTool(TOOLS, 'send_message', { recipient: 'pr-reyes', priority: 'urgent', subject: 'Q', body: 'Question', about: [] }, c);
    expect(get<Communication>(c, ok(r2).communication as string).subject).toBeUndefined();
  });
  it('rejects mixed patients and an unknown or wrong-type recipient', async () => {
    const c = fresh();
    const msg = { recipient: 'Patient/pt-0002', priority: 'routine', subject: 's', body: 'b', about: ['MedicationRequest/mr-00005'] };
    expect(await rejected(c, 'send_message', msg)).toMatchObject({ code: 'INVALID_INPUT', field: 'about[0]' });
    expect(await rejected(c, 'send_message', { ...msg, recipient: 'Organization/org-riverbend', about: [] })).toMatchObject({ code: 'INVALID_INPUT', field: 'recipient' });
    expect(await rejected(c, 'send_message', { ...msg, recipient: 'Practitioner/pr-nobody', about: [] })).toMatchObject({ code: 'NOT_FOUND', field: 'recipient' });
    expect(await rejected(c, 'send_message', { ...msg, about: undefined })).toMatchObject({ code: 'INVALID_INPUT', field: 'about' });
  });
});

describe('record_allergy', () => {
  const allergy = { patient: 'pt-0001', substance_code: '723', criticality: 'high', verification: 'confirmed', reactions: [{ manifestation: 'lip swelling', severity: 'severe' }] };
  it('creates alg-t0001 and records the source in the Provenance', () => {
    const c = fresh();
    const r = callTool(TOOLS, 'record_allergy', { ...allergy, source: 'DocumentReference/doc-00001' }, c);
    expect(ok(r)).toEqual({ allergy_intolerance: 'AllergyIntolerance/alg-t0001' });
    expect(get<AllergyIntolerance>(c, 'AllergyIntolerance/alg-t0001')).toMatchObject({
      patient: { reference: 'Patient/pt-0001' },
      clinicalStatus: { coding: [{ code: 'active' }] },
      verificationStatus: { coding: [{ code: 'confirmed' }] },
      criticality: 'high',
      code: { coding: [{ system: RXNORM, code: '723', display: 'amoxicillin' }] },
      reaction: [{ manifestation: [{ text: 'lip swelling' }], severity: 'severe' }],
      recordedDate: stamp(1),
    });
    expect(get<Provenance>(c, 'Provenance/prov-t0001').entity).toEqual([{ role: 'source', what: { reference: 'DocumentReference/doc-00001' } }]);
  });
  it('updates an existing allergy in place and refuses an entered-in-error one', async () => {
    const c = fresh();
    const r = callTool(TOOLS, 'record_allergy', { ...allergy, patient: 'pt-0009', update_id: 'alg-00001', clinical_status: 'inactive', reactions: [] }, c);
    expect(ok(r)).toEqual({ allergy_intolerance: 'AllergyIntolerance/alg-00001' });
    expect(r.written_ids).toEqual(['AllergyIntolerance/alg-00001', 'Provenance/prov-t0001']);
    const a = get<AllergyIntolerance>(c, 'AllergyIntolerance/alg-00001');
    expect(a.clinicalStatus?.coding?.[0]?.code).toBe('inactive');
    expect(a.reaction).toBeUndefined();
    expect(await rejected(c, 'record_allergy', { ...allergy, update_id: 'alg-00001' })).toMatchObject({ code: 'INVALID_INPUT', field: 'update_id' });
    expect(await rejected(c, 'record_allergy', { ...allergy, patient: 'pt-0009', update_id: 'alg-w-eie' })).toMatchObject({ code: 'CONFLICT', field: 'update_id' });
    expect(await rejected(c, 'record_allergy', { ...allergy, verification: 'entered-in-error', clinical_status: 'active' })).toMatchObject({ code: 'INVALID_INPUT', field: 'clinical_status' });
    expect(await rejected(c, 'record_allergy', { ...allergy, substance_code: 'IMG-CT-CHEST-WO' })).toMatchObject({ code: 'INVALID_INPUT', field: 'substance_code' });
    expect(await rejected(c, 'record_allergy', { ...allergy, reactions: [{ severity: 'mild' }] })).toMatchObject({ code: 'INVALID_INPUT', field: 'reactions[0]' });
    const eie = callTool(TOOLS, 'record_allergy', { ...allergy, verification: 'entered-in-error' }, c);
    expect(get<AllergyIntolerance>(c, ok(eie).allergy_intolerance as string).clinicalStatus).toBeUndefined();
  });
});

describe('write_note', () => {
  const note = { patient: 'pt-0001', type: 'progress_note', title: 'Results follow-up', text: 'Reviewed CT. Plan: repeat in 12 months.\nSigned.', cites: ['DiagnosticReport/dr-00001'] };
  it('signs a DocumentReference whose text fhir_read returns', () => {
    const c = fresh();
    const r = callTool(TOOLS, 'write_note', note, c);
    expect(ok(r)).toEqual({ note: 'DocumentReference/doc-t0001' });
    const doc = get<DocumentReference>(c, 'DocumentReference/doc-t0001');
    expect(doc).toMatchObject({ status: 'current', docStatus: 'final', subject: { reference: 'Patient/pt-0001' }, date: stamp(1), description: 'Results follow-up', context: { related: [{ reference: 'DiagnosticReport/dr-00001' }] } });
    const read = ok(callTool(READ_TOOLS, 'fhir_read', { resource_type: 'DocumentReference', id: 'doc-t0001' }, c));
    expect(read.text).toBe(note.text);
    const unicode = callTool(TOOLS, 'write_note', { ...note, text: 'Dosis: 5 µg — ok ✓' }, c);
    expect(ok(callTool(READ_TOOLS, 'fhir_read', { resource_type: 'DocumentReference', id: (ok(unicode).note as string).split('/')[1] }, c)).text).toBe('Dosis: 5 µg — ok ✓');
  });
  it('rejects a citation of another patient, a lone surrogate and a control character in the title', async () => {
    const c = fresh();
    expect(await rejected(c, 'write_note', { ...note, patient: 'pt-0002' })).toMatchObject({ code: 'INVALID_INPUT', field: 'cites[0]' });
    expect(await rejected(c, 'write_note', { ...note, text: 'a\udc00b' })).toMatchObject({ code: 'INVALID_INPUT', field: 'text' });
    expect(await rejected(c, 'write_note', { ...note, title: 'a\u0002b' })).toMatchObject({ code: 'INVALID_INPUT', field: 'title' });
    expect(await rejected(c, 'write_note', { ...note, type: 'poem' })).toMatchObject({ code: 'INVALID_INPUT', field: 'type' });
  });
});

describe('update_inbox_item', () => {
  it('completes an item with links and a comment, then refuses to complete it again', async () => {
    const c = fresh();
    const r = callTool(TOOLS, 'update_inbox_item', { task_id: 'task-w-1', action: 'complete', linked: ['DiagnosticReport/dr-00001'], comment: 'Ordered CT' }, c);
    expect(ok(r)).toEqual({ task: 'Task/task-w-1', status: 'completed' });
    expect(r.written_ids).toEqual(['Provenance/prov-t0001', 'Task/task-w-1']);
    expect(get<Task>(c, 'Task/task-w-1')).toMatchObject({
      status: 'completed',
      lastModified: stamp(1),
      output: [{ type: { text: 'linked' }, valueReference: { reference: 'DiagnosticReport/dr-00001' } }],
      note: [{ text: 'Ordered CT', time: stamp(1), authorReference: { reference: 'Practitioner/pr-okafor' } }],
    });
    expect(await rejected(c, 'update_inbox_item', { task_id: 'Task/task-w-1', action: 'complete' })).toMatchObject({ code: 'CONFLICT', field: 'task_id' });
    expect(await rejected(c, 'update_inbox_item', { task_id: 'task-w-3', action: 'reassign', new_owner: 'pool-oncall' })).toMatchObject({ code: 'CONFLICT', field: 'task_id' });
    const rows = ok(callTool(READ_TOOLS, 'list_inbox', { queue: 'results', status: 'completed' }, c)).entries as Array<{ task: string }>;
    expect(rows.map((x) => x.task)).toEqual(['Task/task-w-1', 'Task/task-w-3']);
  });
  it('reassigns, and rejects inconsistent arguments and non-inbox Tasks', async () => {
    const c = fresh();
    expect(ok(callTool(TOOLS, 'update_inbox_item', { task_id: 'task-w-2', action: 'reassign', new_owner: 'pool-rn-triage' }, c))).toEqual({ task: 'Task/task-w-2', status: 'requested' });
    expect(get<Task>(c, 'Task/task-w-2').owner).toEqual({ reference: 'Group/pool-rn-triage' });
    expect(await rejected(c, 'update_inbox_item', { task_id: 'task-w-2', action: 'reassign' })).toMatchObject({ code: 'INVALID_INPUT', field: 'new_owner' });
    expect(await rejected(c, 'update_inbox_item', { task_id: 'task-w-2', action: 'complete', new_owner: 'pr-lin' })).toMatchObject({ code: 'INVALID_INPUT', field: 'new_owner' });
    expect(await rejected(c, 'update_inbox_item', { task_id: 'task-w-2', action: 'reassign', new_owner: 'pr-lin', linked: ['DiagnosticReport/dr-00001'] })).toMatchObject({ code: 'INVALID_INPUT', field: 'linked' });
    expect(await rejected(c, 'update_inbox_item', { task_id: 'task-nope', action: 'complete' })).toMatchObject({ code: 'NOT_FOUND', field: 'task_id' });
    const created = ok(callTool(TOOLS, 'create_task', { patient: 'pt-0001', owner: 'pr-lin', due: '2026-11-01', priority: 'routine', description: 'x' }, c)).task as string;
    expect(await rejected(c, 'update_inbox_item', { task_id: created, action: 'complete' })).toMatchObject({ code: 'INVALID_INPUT', field: 'task_id' });
  });
});

describe('finish', () => {
  it('records the summary and writes nothing', async () => {
    const c = fresh();
    const before = await stateHash(c.world.resources());
    const r = callTool(TOOLS, 'finish', { summary: 'Done: 2 orders.' }, c);
    expect(ok(r)).toEqual({ ok: true });
    expect(r.written_ids).toBeUndefined();
    expect(c.session).toMatchObject({ writeSeq: 0, summary: 'Done: 2 orders.' });
    expect(await stateHash(c.world.resources())).toBe(before);
    expect(await rejected(c, 'finish', {})).toMatchObject({ code: 'INVALID_INPUT', field: 'summary' });
  });
});

describe('write sequence', () => {
  it('a rejected write consumes no sequence number, id, stamp or Provenance', async () => {
    const c = fresh();
    await rejected(c, 'create_task', { patient: 'pt-0001', owner: 'pr-lin', due: '2020-01-01', priority: 'routine', description: 'x' });
    const r = callTool(TOOLS, 'create_task', { patient: 'pt-0001', owner: 'pr-lin', due: '2026-11-01', priority: 'routine', description: 'x' }, c);
    expect(r.written_ids).toEqual(['Provenance/prov-t0001', 'Task/task-t0001']);
    expect(get<Task>(c, 'Task/task-t0001').authoredOn).toBe(stamp(1));
  });
  it('reads carry no written_ids', () => {
    expect(callTool(TOOLS, 'get_context', {}, fresh()).written_ids).toBeUndefined();
  });
});

describe('commit invariants (environment faults surface as exceptions, not results)', () => {
  const draft = (resource: Resource) => () => ({ content: {}, resources: [{ resource, created: true }] });
  it('an invalid resource built from constants throws, and nothing is written', async () => {
    const c = fresh();
    const before = await stateHash(c.world.resources());
    expect(() => commit(c, 'test', draft({ resourceType: 'Task', id: 'task-t0001', status: 'requested', intent: 'order', description: '\u0001' } as Task))).toThrow(/Task.description/);
    expect(await stateHash(c.world.resources())).toBe(before);
    expect(c.session.writeSeq).toBe(0);
  });
  it('a dangling reference throws, and nothing is written', async () => {
    const c = fresh();
    const before = await stateHash(c.world.resources());
    expect(() => commit(c, 'test', draft({ resourceType: 'Task', id: 'task-t0001', status: 'requested', intent: 'order', focus: { reference: 'Observation/obs-missing' } }))).toThrow(/dangling/);
    expect(await stateHash(c.world.resources())).toBe(before);
  });
  it('a created id already in the store throws', () => {
    const c = fresh();
    expect(() => commit(c, 'test', draft({ ...INBOX[0]!, id: 'task-w-1' }))).toThrow(/already/);
  });
});
