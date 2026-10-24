// What the write tools put in the chart, read the way a US clinician reads it (gate round 17 of
// plan phase P6): a clinically correct call commits, and the resource it writes says what the
// clinician meant. One describe per finding: allergy updates that keep what they leave out,
// modify with a product and strength, messages about a panel Group, US display units and sigs,
// HL7 frequencies and PRN reasons, fractional seconds, per-target Provenance activity, finish,
// the status machines, category and dispense on new orders, required bindings, policy cites.
import { readFileSync } from 'node:fs';
import type {
  AllergyIntolerance, Bundle, Communication, DocumentReference, Group, MedicationRequest, Provenance, Resource, ServiceRequest, Task,
} from '@medplum/fhirtypes';
import { beforeAll, describe, expect, it } from 'vitest';
import { clock } from '../../clock.ts';
import { parseNdjson } from '../../fixture-source.ts';
import { stateHash } from '../../hash.ts';
import { Store } from '../../store.ts';
import { indexDefinitions, validate } from '../../validate.ts';
import { INBOX_QUEUE_SYSTEM, type CatalogEntry, type Policy } from '../read/index.ts';
import { callTool, type ToolResult } from '../registry.ts';
import { newSession, TOOLS, type WriteContext as Context } from '../write/index.ts';

type WriteContext = Context & { world: Store };

const root = new URL('../../../../', import.meta.url);
const base = await parseNdjson(readFileSync(new URL('fixtures/world.ndjson.gz', root)));
beforeAll(() => indexDefinitions(JSON.parse(readFileSync(new URL('fixtures/definitions-pruned.json', root), 'utf8')) as Bundle));

const RXNORM = 'http://www.nlm.nih.gov/research/umls/rxnorm';
const SNOMED = 'http://snomed.info/sct';
const UCUM = 'http://unitsofmeasure.org';
const GTS = 'http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation';
const DATA_OPERATION = 'http://terminology.hl7.org/CodeSystem/v3-DataOperation';
const CLINICAL = 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical';
const VERIFICATION = 'http://terminology.hl7.org/CodeSystem/allergyintolerance-verification';

const med = (code: string, display: string): CatalogEntry => ({ kind: 'medication', code, system: RXNORM, display });
const CATALOG: CatalogEntry[] = [
  med('1364435', 'apixaban 2.5 MG Oral Tablet'),
  med('1364445', 'apixaban 5 MG Oral Tablet'),
  med('198211', 'simvastatin 40 MG Oral Tablet'),
  med('866436', '24 HR metoprolol succinate 50 MG Extended Release Oral Tablet'),
  med('310431', 'gabapentin 300 MG Oral Capsule'),
  med('860975', 'metformin hydrochloride 500 MG Oral Tablet'),
  med('83367', 'atorvastatin'),
  med('892246', 'levothyroxine sodium 0.088 MG Oral Tablet'),
  med('847230', 'insulin glargine 100 UNT/ML Pen Injector'),
  med('628958', 'potassium chloride 20 MEQ Extended Release Oral Tablet'),
  med('197696', 'nicotine 21 MG/24HR Transdermal System'),
  med('4603', 'furosemide 10 MG/ML Oral Solution'),
  med('312615', 'predniSONE 50 MG Oral Tablet'),
  med('104894', 'ondansetron 4 MG Oral Tablet'),
  { kind: 'lab', code: '2160-0', system: 'http://loinc.org', display: 'Creatinine [Mass/volume] in Serum or Plasma' },
];
const POLICIES: Policy[] = [{ id: 'RBC-PHARM-07', title: 'Renal and age dose review', version: '3', effective: '2026-01-01', source: 'apixaban label', text: 'Text.' }];

// Test-only additions in the shapes the task overlays will add.
const allergy = (fields: Partial<AllergyIntolerance> & Pick<AllergyIntolerance, 'id' | 'patient' | 'code'>): AllergyIntolerance => ({
  resourceType: 'AllergyIntolerance',
  clinicalStatus: { coding: [{ system: CLINICAL, code: 'active' }] },
  verificationStatus: { coding: [{ system: VERIFICATION, code: 'confirmed' }] },
  recordedDate: '2019-05-01T10:00:00-04:00',
  ...fields,
});
// T6 M4: Lena Park's coded NKDA from 2019.
const NKDA = allergy({
  id: 'alg-w-nkda',
  type: 'allergy',
  category: ['medication'],
  code: { coding: [{ system: SNOMED, code: '409137002', display: 'No known drug allergy (situation)' }], text: 'No known drug allergy' },
  patient: { reference: 'Patient/pt-0004' },
});
// T1: Harold Vance's apixaban 2.5 mg BID, Synthea-shaped (no route), with a dispense.
const APIXABAN: MedicationRequest = {
  resourceType: 'MedicationRequest',
  id: 'mr-w-apix',
  status: 'active',
  intent: 'order',
  category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/medicationrequest-category', code: 'community', display: 'Community' }], text: 'Community' }],
  medicationCodeableConcept: { coding: [{ system: RXNORM, code: '1364435', display: 'apixaban 2.5 MG Oral Tablet' }], text: 'apixaban 2.5 MG Oral Tablet' },
  subject: { reference: 'Patient/pt-0001' },
  authoredOn: '2026-02-14T10:00:00-05:00',
  requester: { reference: 'Practitioner/pr-okafor' },
  dosageInstruction: [{ text: '2.5 mg twice daily', timing: { repeat: { frequency: 2, period: 1, periodUnit: 'd' } }, doseAndRate: [{ doseQuantity: { value: 2.5, unit: 'mg', system: UCUM, code: 'mg' } }] }],
  dispenseRequest: { numberOfRepeatsAllowed: 5, expectedSupplyDuration: { value: 90, unit: 'days', system: UCUM, code: 'd' } },
};
const DRAFT: MedicationRequest = { ...APIXABAN, id: 'mr-w-draft', status: 'draft' };
const STOPPED_WITH_REASON: MedicationRequest = { ...APIXABAN, id: 'mr-w-held', status: 'on-hold', statusReason: { text: 'AKI' } };
// T3: a panel of patients (design: "Okafor CRC 2026").
const PANEL: Group = {
  resourceType: 'Group',
  id: 'grp-w-crc',
  type: 'person',
  actual: true,
  name: 'Okafor CRC 2026',
  member: [{ entity: { reference: 'Patient/pt-0002' } }, { entity: { reference: 'Patient/pt-0003' } }],
};
const inboxTask = (id: string, status: Task['status']): Task => ({
  resourceType: 'Task',
  id,
  status,
  intent: 'order',
  code: { coding: [{ system: INBOX_QUEUE_SYSTEM, code: 'results' }] },
  focus: { reference: 'DiagnosticReport/dr-00001' },
  for: { reference: 'Patient/pt-0001' },
  authoredOn: '2026-10-22T09:00:00-04:00',
  owner: { reference: 'Practitioner/pr-okafor' },
  description: `item ${id}`,
});
const INBOX = (['draft', 'requested', 'received', 'accepted', 'ready', 'in-progress', 'on-hold'] as const).map((s) => inboxTask(`task-c-${s}`, s));

const fresh = (): WriteContext => ({
  world: new Store([...base, NKDA, APIXABAN, DRAFT, STOPPED_WITH_REASON, PANEL, ...INBOX]),
  clock,
  policies: POLICIES,
  catalog: CATALOG,
  session: newSession(),
});

const ok = (r: ToolResult): Record<string, unknown> => {
  if (r.is_error) throw new Error(`expected success, got ${JSON.stringify(r.content)}`);
  return r.content as Record<string, unknown>;
};
const call = (c: WriteContext, name: string, input: unknown) => ok(callTool(TOOLS, name, input, c));

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
const dosage = (mr: MedicationRequest) => mr.dosageInstruction![0]!;
const ISO_INSTANT = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

describe('1. record_allergy: an update keeps what the call leaves out', () => {
  it("T6 step 5: 'update NKDA, inactive' keeps the SNOMED code, category, type and recordedDate", () => {
    const c = fresh();
    const r = callTool(TOOLS, 'record_allergy', { patient: 'pt-0004', update_id: 'alg-w-nkda', clinical_status: 'inactive' }, c);
    expect(ok(r)).toEqual({ allergy_intolerance: 'AllergyIntolerance/alg-w-nkda' });
    const a = get<AllergyIntolerance>(c, 'AllergyIntolerance/alg-w-nkda');
    expect(a.code).toEqual(NKDA.code);
    expect(a).toMatchObject({ type: 'allergy', category: ['medication'], recordedDate: NKDA.recordedDate, verificationStatus: NKDA.verificationStatus });
    expect(a.clinicalStatus).toEqual({ coding: [{ system: CLINICAL, code: 'inactive' }] });
  });

  it('an NKDA entry with no category or type stays without them when marked inactive', () => {
    const c = fresh();
    const { category: _c, type: _t, ...bare } = NKDA;
    c.world.put({ ...bare, id: 'alg-w-nkda2' });
    call(c, 'record_allergy', { patient: 'pt-0004', update_id: 'alg-w-nkda2', clinical_status: 'inactive' });
    const a = get<AllergyIntolerance>(c, 'AllergyIntolerance/alg-w-nkda2');
    expect(a.category).toBeUndefined();
    expect(a.type).toBeUndefined();
    expect(a.criticality).toBeUndefined();
    expect(a.code).toEqual(NKDA.code);
  });

  it('marks the NKDA entered-in-error without touching its code, and drops clinicalStatus', () => {
    const c = fresh();
    call(c, 'record_allergy', { patient: 'pt-0004', update_id: 'alg-w-nkda', verification: 'entered-in-error' });
    const a = get<AllergyIntolerance>(c, 'AllergyIntolerance/alg-w-nkda');
    expect(a.code).toEqual(NKDA.code);
    expect(a.verificationStatus).toEqual({ coding: [{ system: VERIFICATION, code: 'entered-in-error' }] });
    expect(a.clinicalStatus).toBeUndefined();
  });

  it('updates a world SNOMED food allergy to resolved and keeps its code, category and coded reactions', () => {
    const c = fresh();
    const peanut = get<AllergyIntolerance>(c, 'AllergyIntolerance/alg-00018');
    call(c, 'record_allergy', { patient: 'pt-0022', update_id: 'alg-00018', clinical_status: 'resolved' });
    const a = get<AllergyIntolerance>(c, 'AllergyIntolerance/alg-00018');
    expect(a).toMatchObject({ code: peanut.code, category: ['food'], type: peanut.type, reaction: peanut.reaction, recordedDate: peanut.recordedDate, criticality: peanut.criticality });
    expect(a.clinicalStatus?.coding?.[0]?.code).toBe('resolved');
  });

  it('records a statin intolerance with an RxNorm ingredient and a SNOMED-coded reaction', () => {
    const c = fresh();
    const r = call(c, 'record_allergy', {
      patient: 'pt-0005', substance_code: '83367', type: 'intolerance', criticality: 'low', verification: 'confirmed',
      reactions: [{ manifestation_code: '68962001', manifestation: 'myalgias on atorvastatin 40 mg', severity: 'moderate' }],
    });
    const a = get<AllergyIntolerance>(c, r.allergy_intolerance as string);
    expect(a).toMatchObject({
      type: 'intolerance',
      category: ['medication'],
      criticality: 'low',
      code: { coding: [{ system: RXNORM, code: '83367', display: 'atorvastatin' }] },
      reaction: [{ manifestation: [{ coding: [{ system: SNOMED, code: '68962001', display: 'Muscle pain' }], text: 'myalgias on atorvastatin 40 mg' }], severity: 'moderate' }],
    });
  });

  it('records a new allergy to a SNOMED substance already in the world, with its category', () => {
    const c = fresh();
    const r = call(c, 'record_allergy', { patient: 'pt-0001', substance_code: '762952008', criticality: 'high', verification: 'confirmed', reactions: [{ manifestation_code: '39579001' }] });
    expect(get<AllergyIntolerance>(c, r.allergy_intolerance as string)).toMatchObject({
      type: 'allergy',
      category: ['food'],
      code: { coding: [{ system: SNOMED, code: '762952008', display: 'Peanut (substance)' }] },
      reaction: [{ manifestation: [{ coding: [{ system: SNOMED, code: '39579001' }] }] }],
    });
  });

  it('accepts a text-only reaction and an explicit category', () => {
    const c = fresh();
    const r = call(c, 'record_allergy', { patient: 'pt-0001', substance_code: '1191', category: 'medication', criticality: 'low', verification: 'unconfirmed', reactions: [{ manifestation: 'stomach upset' }] });
    expect(get<AllergyIntolerance>(c, r.allergy_intolerance as string).reaction).toEqual([{ manifestation: [{ text: 'stomach upset' }] }]);
  });

  it('rejects a new allergy without a substance or criticality, an unknown code and an empty reaction', async () => {
    const c = fresh();
    const create = { patient: 'pt-0001', substance_code: '83367', criticality: 'low', verification: 'confirmed' };
    expect(await rejected(c, 'record_allergy', { ...create, substance_code: undefined })).toMatchObject({ code: 'INVALID_INPUT', field: 'substance_code' });
    expect(await rejected(c, 'record_allergy', { ...create, criticality: undefined })).toMatchObject({ code: 'INVALID_INPUT', field: 'criticality' });
    expect(await rejected(c, 'record_allergy', { ...create, verification: undefined })).toMatchObject({ code: 'INVALID_INPUT', field: 'verification' });
    expect(await rejected(c, 'record_allergy', { ...create, substance_code: '999999999' })).toMatchObject({ code: 'INVALID_INPUT', field: 'substance_code' });
    expect(await rejected(c, 'record_allergy', { ...create, reactions: [{ severity: 'mild' }] })).toMatchObject({ code: 'INVALID_INPUT', field: 'reactions[0]' });
    expect(await rejected(c, 'record_allergy', { ...create, reactions: [{ manifestation_code: '12345' }] })).toMatchObject({ code: 'INVALID_INPUT', field: 'reactions[0].manifestation_code' });
    expect(await rejected(c, 'record_allergy', { ...create, type: 'sensitivity' })).toMatchObject({ code: 'INVALID_INPUT', field: 'type' });
    expect(await rejected(c, 'record_allergy', { ...create, category: 'drug' })).toMatchObject({ code: 'INVALID_INPUT', field: 'category' });
  });
});

describe('2. change_medication modify: product, strength and route', () => {
  const t1 = { medication_request: 'mr-w-apix', action: 'modify', reason: 'RBC-PHARM-07: 1 of 3 criteria (age); 5 mg BID' };

  it('T1 with medication_code: apixaban 5 MG tablet, 5 mg by mouth BID, category and dispense kept', () => {
    const c = fresh();
    const r = call(c, 'change_medication', { ...t1, medication_code: '1364445', route: 'oral', new_dose: { value: 5, unit: 'mg', frequency: 'BID' } });
    const next = get<MedicationRequest>(c, r.new_medication_request as string);
    expect(next.medicationCodeableConcept?.coding?.[0]).toEqual({ system: RXNORM, code: '1364445', display: 'apixaban 5 MG Oral Tablet' });
    expect(dosage(next).doseAndRate?.[0]?.doseQuantity).toEqual({ value: 5, unit: 'mg', system: UCUM, code: 'mg' });
    expect(dosage(next).route?.coding?.[0]).toMatchObject({ system: SNOMED, code: '26643006' });
    expect(dosage(next).text).toBe('5 mg by mouth twice daily');
    expect(next.category).toEqual(APIXABAN.category);
    expect(next.dispenseRequest).toMatchObject({ numberOfRepeatsAllowed: 5, expectedSupplyDuration: { value: 90, code: 'd' }, quantity: { value: 180, unit: 'tablet', code: '{tablet}' } });
  });

  it('T1 without medication_code: 5 mg is 2 x 2.5 mg tablets; 3 mg is rejected naming medication_code', async () => {
    const c = fresh();
    const e = await rejected(c, 'change_medication', { ...t1, new_dose: { value: 3, unit: 'mg', frequency: 'BID' } });
    expect(e).toMatchObject({ code: 'INVALID_INPUT', field: 'medication_code' });
    expect(e.message).toContain('dose 3 mg does not match apixaban 2.5 MG Oral Tablet');
    expect(e.message).toContain('give medication_code for the new strength');
    const r = call(c, 'change_medication', { ...t1, new_dose: { value: 5, unit: 'mg', frequency: 'BID' } });
    const next = get<MedicationRequest>(c, r.new_medication_request as string);
    expect(next.medicationCodeableConcept?.coding?.[0]?.code).toBe('1364435');
    expect(dosage(next).doseAndRate?.[0]?.doseQuantity).toEqual({ value: 5, unit: 'mg', system: UCUM, code: 'mg' });
    expect(dosage(next).text).toBe('5 mg (2 tablets) twice daily');
    expect(next.dispenseRequest?.quantity).toMatchObject({ value: 360, code: '{tablet}' });
  });

  it('simvastatin 20 -> 40 mg at bedtime: 2 tablets without a product, the 40 MG tablet with one', () => {
    const c = fresh();
    const two = get<MedicationRequest>(c, call(c, 'change_medication', { medication_request: 'mr-00008', action: 'modify', reason: 'LDL above goal', new_dose: { value: 40, unit: 'mg', frequency: 'QHS' } }).new_medication_request as string);
    expect(two.medicationCodeableConcept?.coding?.[0]?.display).toBe('Simvastatin 20 MG Oral Tablet');
    expect(dosage(two).text).toBe('40 mg (2 tablets) at bedtime');
    const c2 = fresh();
    const one = get<MedicationRequest>(c2, call(c2, 'change_medication', { medication_request: 'mr-00008', action: 'modify', reason: 'LDL above goal', medication_code: '198211', route: 'oral', new_dose: { value: 40, unit: 'mg', frequency: 'QHS' } }).new_medication_request as string);
    expect(one.medicationCodeableConcept?.coding?.[0]?.display).toBe('simvastatin 40 MG Oral Tablet');
    expect(dosage(one).text).toBe('40 mg by mouth at bedtime');
    expect(one.category?.[0]?.coding?.[0]?.code).toBe('community');
  });

  it('never splits an extended-release tablet or a capsule; half of an immediate-release tablet is fine', async () => {
    const c = fresh();
    const e = await rejected(c, 'change_medication', { medication_request: 'mr-00010', action: 'modify', reason: 'HR 52', new_dose: { value: 50, unit: 'mg', frequency: 'QD' } });
    expect(e).toMatchObject({ code: 'INVALID_INPUT', field: 'medication_code' });
    expect(e.message).toMatch(/extended-release/);
    const er = call(c, 'change_medication', { medication_request: 'mr-00010', action: 'modify', reason: 'HR 52', medication_code: '866436', new_dose: { value: 50, unit: 'mg', frequency: 'QD' } });
    expect(get<MedicationRequest>(c, er.new_medication_request as string).medicationCodeableConcept?.coding?.[0]?.code).toBe('866436');
    const hctz = call(c, 'change_medication', { medication_request: 'mr-00046', action: 'modify', reason: 'hyponatremia', new_dose: { value: 12.5, unit: 'mg', frequency: 'QAM' } });
    expect(dosage(get<MedicationRequest>(c, hctz.new_medication_request as string)).text).toBe('12.5 mg (0.5 tablet) every morning');
    const gaba = call(c, 'order_medication', { patient: 'pt-0011', rxnorm_code: '310431', dose_value: 300, dose_unit: 'mg', route: 'oral', frequency: 'TID', reason: 'postherpetic neuralgia' });
    const cap = await rejected(c, 'change_medication', { medication_request: gaba.medication_request, action: 'modify', reason: 'renal', new_dose: { value: 150, unit: 'mg', frequency: 'TID' } });
    expect(cap).toMatchObject({ code: 'INVALID_INPUT', field: 'medication_code' });
    expect(cap.message).toMatch(/capsule/);
  });

  it('keeps an existing route, and rejects a product outside the catalog or on a non-modify action', async () => {
    const c = fresh();
    const first = call(c, 'change_medication', { ...t1, medication_code: '1364445', route: 'oral', new_dose: { value: 5, unit: 'mg', frequency: 'BID' } });
    const again = call(c, 'change_medication', { medication_request: first.new_medication_request, action: 'modify', reason: 'weight 58 kg', medication_code: '1364435', new_dose: { value: 2.5, unit: 'mg', frequency: 'BID' } });
    expect(dosage(get<MedicationRequest>(c, again.new_medication_request as string)).route?.coding?.[0]?.code).toBe('26643006');
    expect(await rejected(c, 'change_medication', { ...t1, medication_request: again.new_medication_request, medication_code: '2160-0', new_dose: { value: 5, unit: 'mg', frequency: 'BID' } })).toMatchObject({ code: 'INVALID_INPUT', field: 'medication_code' });
    expect(await rejected(c, 'change_medication', { medication_request: again.new_medication_request, action: 'stop', reason: 'x', medication_code: '1364445' })).toMatchObject({ code: 'INVALID_INPUT', field: 'medication_code' });
    expect(await rejected(c, 'change_medication', { medication_request: again.new_medication_request, action: 'hold', reason: 'x', route: 'oral' })).toMatchObject({ code: 'INVALID_INPUT', field: 'route' });
  });

  it('order_medication applies the same strength rule to its rxnorm_code', async () => {
    const c = fresh();
    const order = { patient: 'pt-0001', rxnorm_code: '1364435', dose_unit: 'mg', route: 'oral', frequency: 'BID', reason: 'AF' };
    expect(await rejected(c, 'order_medication', { ...order, dose_value: 3 })).toMatchObject({ code: 'INVALID_INPUT', field: 'rxnorm_code' });
    expect(dosage(get<MedicationRequest>(c, call(c, 'order_medication', { ...order, dose_value: 2.5 }).medication_request as string)).text).toBe('2.5 mg by mouth twice daily');
  });
});

describe('3. send_message about a panel Group', () => {
  it('a message to a clinician about a Group of patients has no patient context and commits', () => {
    const c = fresh();
    const r = call(c, 'send_message', { recipient: 'pr-okafor', priority: 'routine', subject: 'CRC outreach done', body: 'FIT kits mailed to the panel.', about: ['Group/grp-w-crc'] });
    const m = get<Communication>(c, r.communication as string);
    expect(m.subject).toBeUndefined();
    expect(m.about).toEqual([{ reference: 'Group/grp-w-crc' }]);
  });
});

describe('4. US display units and sig text', () => {
  const order = { patient: 'pt-0001', route: 'oral', frequency: 'QD', reason: 'r' };
  it('shows mcg, units, mEq and mL while doseQuantity.code stays UCUM', () => {
    const c = fresh();
    const cases: Array<[string, number, string, string, string]> = [
      ['892246', 88, 'ug', 'mcg', '88 mcg by mouth once daily'],
      ['847230', 10, '[iU]', 'units', '10 units subcutaneously at bedtime'],
      ['628958', 20, 'meq', 'mEq', '20 mEq by mouth once daily'],
      ['4603', 4, 'mL', 'mL', '4 mL by mouth once daily'],
    ];
    for (const [code, value, unit, display, text] of cases) {
      const route = unit === '[iU]' ? 'subcutaneous' : 'oral';
      const frequency = unit === '[iU]' ? 'QHS' : 'QD';
      const mr = get<MedicationRequest>(c, call(c, 'order_medication', { ...order, rxnorm_code: code, dose_value: value, dose_unit: unit, route, frequency }).medication_request as string);
      expect(dosage(mr).doseAndRate?.[0]?.doseQuantity).toEqual({ value, unit: display, system: UCUM, code: unit });
      expect(dosage(mr).text).toBe(text);
    }
  });
  it('prints timing events as clinic wall-clock times, never raw ISO instants', () => {
    const c = fresh();
    const r = call(c, 'order_medication', {
      patient: 'pt-0003', rxnorm_code: '312615', dose_value: 50, dose_unit: 'mg', route: 'oral', reason: 'contrast premedication',
      timing_events: ['2026-10-25T20:00-04:00', '2026-10-26T06:00Z', '2026-11-02T08:00:00-05:00'],
    });
    const text = dosage(get<MedicationRequest>(c, r.medication_request as string)).text!;
    expect(text).not.toMatch(ISO_INSTANT);
    expect(text).toBe('50 mg by mouth at 8:00 PM on 10/25/2026, 2:00 AM on 10/26/2026, 8:00 AM on 11/02/2026');
  });
});

describe('5. frequencies, PRN reasons, units and priorities', () => {
  const order = { patient: 'pt-0001', rxnorm_code: '860975', dose_value: 500, dose_unit: 'mg', route: 'oral', reason: 'r' };
  const timing = (c: WriteContext, input: Record<string, unknown>) => dosage(get<MedicationRequest>(c, call(c, 'order_medication', { ...order, ...input }).medication_request as string));
  it('codes frequencies in v3-GTSAbbreviation where a code exists, with timing.repeat set', () => {
    const c = fresh();
    expect(timing(c, { frequency: 'BID' }).timing).toMatchObject({ code: { coding: [{ system: GTS, code: 'BID' }] }, repeat: { frequency: 2, period: 1, periodUnit: 'd' } });
    expect(timing(c, { frequency: 'QHS' }).timing).toMatchObject({ code: { coding: [{ system: GTS, code: 'BED' }] }, repeat: { when: ['HS'] } });
    expect(timing(c, { frequency: 'QWK' }).timing).toMatchObject({ code: { coding: [{ system: GTS, code: 'WK' }] }, repeat: { frequency: 1, period: 1, periodUnit: 'wk' } });
    expect(timing(c, { frequency: 'Q8H' }).timing?.code?.coding?.[0]).toEqual({ system: GTS, code: 'Q8H' });
    expect(timing(c, { frequency: 'Q48H' }).timing?.repeat).toEqual({ frequency: 1, period: 48, periodUnit: 'h' });
    expect(timing(c, { frequency: 'Q72H' }).timing?.repeat).toEqual({ frequency: 1, period: 72, periodUnit: 'h' });
  });
  it('a PRN order needs an as-needed reason, written as asNeededCodeableConcept', async () => {
    const c = fresh();
    for (const f of ['QD_PRN', 'BID_PRN', 'TID_PRN', 'QHS_PRN', 'Q4H_PRN', 'Q6H_PRN', 'Q8H_PRN']) {
      const d = timing(c, { rxnorm_code: '104894', dose_value: 4, frequency: f, as_needed_reason: 'nausea' });
      expect(d.asNeededCodeableConcept).toEqual({ text: 'nausea' });
      expect(d.asNeededBoolean).toBeUndefined();
      expect(d.text).toMatch(/ as needed for nausea$/);
    }
    const e = await rejected(c, 'order_medication', { ...order, frequency: 'Q8H_PRN' });
    expect(e).toMatchObject({ code: 'INVALID_INPUT', field: 'as_needed_reason' });
    expect(e.message).toMatch(/indication/);
    expect(await rejected(c, 'order_medication', { ...order, frequency: 'BID', as_needed_reason: 'pain' })).toMatchObject({ code: 'INVALID_INPUT', field: 'as_needed_reason' });
    expect(await rejected(c, 'change_medication', { medication_request: 'mr-00005', action: 'modify', reason: 'r', new_dose: { value: 200, unit: 'mg', frequency: 'Q6H_PRN' } }))
      .toMatchObject({ code: 'INVALID_INPUT', field: 'new_dose.as_needed_reason' });
    call(c, 'change_medication', { medication_request: 'mr-00005', action: 'modify', reason: 'r', new_dose: { value: 200, unit: 'mg', frequency: 'Q6H_PRN', as_needed_reason: 'knee pain' } });
  });
  it('accepts {patch}, {spray} and {application}, and R4 priority asap', () => {
    const c = fresh();
    expect(timing(c, { rxnorm_code: '197696', dose_value: 1, dose_unit: '{patch}', route: 'transdermal', frequency: 'QD' }).text).toBe('1 patch transdermally once daily');
    expect(timing(c, { rxnorm_code: '197696', dose_value: 2, dose_unit: '{spray}', route: 'nasal', frequency: 'BID' }).text).toBe('2 sprays nasally twice daily');
    expect(timing(c, { rxnorm_code: '197696', dose_value: 1, dose_unit: '{application}', route: 'topical', frequency: 'BID' }).doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1, unit: 'application', system: UCUM, code: '{application}' });
    const sr = call(c, 'order_service', { patient: 'pt-0001', code: '2160-0', priority: 'asap', occurrence_start: '2026-10-23', reason: 'pre-contrast' });
    expect(get<ServiceRequest>(c, sr.service_request as string).priority).toBe('asap');
    expect(get<Task>(c, call(c, 'create_task', { patient: 'pt-0001', owner: 'pr-lin', due: '2026-10-23', priority: 'asap', description: 'x' }).task as string).priority).toBe('asap');
    expect(get<Communication>(c, call(c, 'send_message', { recipient: 'pr-lin', priority: 'asap', subject: 's', body: 'b', about: [] }).communication as string).priority).toBe('asap');
  });
});

describe('6. fractional seconds', () => {
  it('accepts a dateTime with fractional seconds wherever a dateTime is accepted', () => {
    const c = fresh();
    const sr = call(c, 'order_service', { patient: 'pt-0001', code: '2160-0', priority: 'routine', occurrence_start: '2026-10-26T09:00:00.000-04:00', occurrence_end: '2026-10-27T09:00:00.350-04:00', reason: 'r' });
    expect(get<ServiceRequest>(c, sr.service_request as string).occurrencePeriod).toEqual({ start: '2026-10-26T09:00:00-04:00', end: '2026-10-27T09:00:00-04:00' });
    const t = call(c, 'create_task', { patient: 'pt-0001', owner: 'pr-lin', due: '2026-10-24T17:00:00.5Z', priority: 'routine', description: 'x' });
    expect(get<Task>(c, t.task as string).restriction?.period?.end).toBe('2026-10-24T17:00:00Z');
    const mr = call(c, 'order_medication', { patient: 'pt-0001', rxnorm_code: '312615', dose_value: 50, dose_unit: 'mg', route: 'oral', reason: 'r', timing_events: ['2026-10-25T20:00:00.000-04:00'] });
    expect(dosage(get<MedicationRequest>(c, mr.medication_request as string)).timing?.event).toEqual(['2026-10-25T20:00:00-04:00']);
  });
});

describe('7. Provenance activity per target', () => {
  const activity = (p: Provenance, ref: string) => p.target.find((t) => t.reference === ref)?.extension?.[0]?.valueCodeableConcept?.coding?.[0]?.code;
  it('modify and replaces record CREATE for the new request and UPDATE for the one they stop, in one Provenance', () => {
    const c = fresh();
    const r = callTool(TOOLS, 'change_medication', { medication_request: 'mr-w-apix', action: 'modify', reason: 'r', medication_code: '1364445', new_dose: { value: 5, unit: 'mg', frequency: 'BID' } }, c);
    expect(r.written_ids?.filter((id) => id.startsWith('Provenance/'))).toEqual(['Provenance/prov-t0001']);
    const p = get<Provenance>(c, 'Provenance/prov-t0001');
    expect(activity(p, 'MedicationRequest/mr-t0001')).toBe('CREATE');
    expect(activity(p, 'MedicationRequest/mr-w-apix')).toBe('UPDATE');
    expect(p.activity?.coding?.[0]).toEqual({ system: DATA_OPERATION, code: 'CREATE' });
    call(c, 'order_medication', { patient: 'pt-0001', rxnorm_code: '1364435', dose_value: 2.5, dose_unit: 'mg', route: 'oral', frequency: 'BID', reason: 'r', replaces: 'mr-t0001' });
    const p2 = get<Provenance>(c, 'Provenance/prov-t0002');
    expect([activity(p2, 'MedicationRequest/mr-t0002'), activity(p2, 'MedicationRequest/mr-t0001')]).toEqual(['CREATE', 'UPDATE']);
    call(c, 'change_medication', { medication_request: 'mr-t0002', action: 'stop', reason: 'r' });
    const p3 = get<Provenance>(c, 'Provenance/prov-t0003');
    expect(p3.activity?.coding?.[0]?.code).toBe('UPDATE');
    expect(activity(p3, 'MedicationRequest/mr-t0002')).toBe('UPDATE');
  });
});

describe('8. finish ends the episode', () => {
  it('a second finish is CONFLICT, and so is any write after finish, with the hash unchanged', async () => {
    const c = fresh();
    call(c, 'finish', { summary: 'first' });
    const e = await rejected(c, 'finish', { summary: 'second' });
    expect(e).toMatchObject({ code: 'CONFLICT', message: 'episode already finished' });
    expect(c.session.summary).toBe('first');
    expect(await rejected(c, 'write_note', { patient: 'pt-0001', type: 'progress_note', title: 't', text: 'x', cites: [] })).toMatchObject({ code: 'CONFLICT' });
    // Reads still answer.
    expect(callTool(TOOLS, 'get_context', {}, c).is_error).toBe(false);
  });
  it('a finish and a write in the same assistant turn: the write after finish is CONFLICT', async () => {
    const c = fresh();
    const turn = [
      ['order_service', { patient: 'pt-0001', code: '2160-0', priority: 'routine', occurrence_start: '2026-10-26', reason: 'r' }],
      ['finish', { summary: 'done' }],
      ['create_task', { patient: 'pt-0001', owner: 'pr-lin', due: '2026-11-01', priority: 'routine', description: 'x' }],
    ] as const;
    expect(callTool(TOOLS, turn[0][0], turn[0][1], c).is_error).toBe(false);
    expect(callTool(TOOLS, turn[1][0], turn[1][1], c).is_error).toBe(false);
    expect(await rejected(c, turn[2][0], turn[2][1])).toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('finish') });
    expect(c.session.writeSeq).toBe(1);
  });
});

describe('9. status machines', () => {
  it('update_inbox_item completes from requested, received, accepted, ready or in-progress; draft and on-hold are CONFLICT', async () => {
    const c = fresh();
    for (const s of ['requested', 'received', 'accepted', 'ready', 'in-progress']) expect(call(c, 'update_inbox_item', { task_id: `task-c-${s}`, action: 'complete' }).status).toBe('completed');
    for (const s of ['draft', 'on-hold']) expect(await rejected(c, 'update_inbox_item', { task_id: `task-c-${s}`, action: 'complete' })).toMatchObject({ code: 'CONFLICT', field: 'action' });
  });
  it('update_inbox_item cancels or rejects with a required reason', async () => {
    const c = fresh();
    expect(await rejected(c, 'update_inbox_item', { task_id: 'task-c-requested', action: 'cancel' })).toMatchObject({ code: 'INVALID_INPUT', field: 'reason' });
    expect(await rejected(c, 'update_inbox_item', { task_id: 'task-c-requested', action: 'complete', reason: 'x' })).toMatchObject({ code: 'INVALID_INPUT', field: 'reason' });
    expect(call(c, 'update_inbox_item', { task_id: 'task-c-requested', action: 'cancel', reason: 'duplicate of task-c-ready' }).status).toBe('cancelled');
    expect(get<Task>(c, 'Task/task-c-requested').statusReason).toEqual({ text: 'duplicate of task-c-ready' });
    expect(call(c, 'update_inbox_item', { task_id: 'task-c-received', action: 'reject', reason: 'not my patient' }).status).toBe('rejected');
    expect(await rejected(c, 'update_inbox_item', { task_id: 'task-c-in-progress', action: 'reject', reason: 'x' })).toMatchObject({ code: 'CONFLICT', field: 'action' });
    expect(call(c, 'update_inbox_item', { task_id: 'task-c-on-hold', action: 'cancel', reason: 'no longer needed' }).status).toBe('cancelled');
  });
  it('change_medication complete, cancel and entered-in-error, each where R4 allows it', async () => {
    const c = fresh();
    expect(call(c, 'change_medication', { medication_request: 'mr-00007', action: 'complete', reason: 'course finished' }).status).toBe('completed');
    expect(await rejected(c, 'change_medication', { medication_request: 'mr-00008', action: 'cancel', reason: 'x' })).toMatchObject({ code: 'CONFLICT', field: 'action' });
    expect(await rejected(c, 'change_medication', { medication_request: 'mr-00008', action: 'entered-in-error', reason: 'x' })).toMatchObject({ code: 'CONFLICT', field: 'action' });
    expect(call(c, 'change_medication', { medication_request: 'mr-w-draft', action: 'cancel', reason: 'not needed' }).status).toBe('cancelled');
    const created = call(c, 'order_medication', { patient: 'pt-0001', rxnorm_code: '860975', dose_value: 500, dose_unit: 'mg', route: 'oral', frequency: 'BID', reason: 'r' }).medication_request as string;
    expect(call(c, 'change_medication', { medication_request: created, action: 'cancel', reason: 'ordered for the wrong patient' }).status).toBe('cancelled');
    expect(get<MedicationRequest>(c, created).statusReason).toEqual({ text: 'ordered for the wrong patient' });
    const second = call(c, 'order_medication', { patient: 'pt-0001', rxnorm_code: '860975', dose_value: 500, dose_unit: 'mg', route: 'oral', frequency: 'QD', reason: 'r' }).medication_request as string;
    expect(call(c, 'change_medication', { medication_request: second, action: 'entered-in-error', reason: 'duplicate entry' }).status).toBe('entered-in-error');
  });
  it('a stopped request gets statusReason and a resumed one clears it', () => {
    const c = fresh();
    call(c, 'change_medication', { medication_request: 'mr-w-held', action: 'resume', reason: 'SCr 1.32 < 1.5' });
    const resumed = get<MedicationRequest>(c, 'MedicationRequest/mr-w-held');
    expect(resumed.status).toBe('active');
    expect(resumed.statusReason).toBeUndefined();
    call(c, 'change_medication', { medication_request: 'mr-w-held', action: 'stop', reason: 'bleeding' });
    expect(get<MedicationRequest>(c, 'MedicationRequest/mr-w-held').statusReason).toEqual({ text: 'bleeding' });
  });
});

describe('10. category and dispenseRequest on new orders', () => {
  it('a new order is community with a dispense derived from the sig; discharge and overrides are honored', () => {
    const c = fresh();
    const metformin = { patient: 'pt-0001', rxnorm_code: '860975', dose_value: 1000, dose_unit: 'mg', route: 'oral', frequency: 'BID', reason: 'T2DM' };
    const a = get<MedicationRequest>(c, call(c, 'order_medication', metformin).medication_request as string);
    expect(a.category).toEqual([{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/medicationrequest-category', code: 'community', display: 'Community' }], text: 'Community' }]);
    expect(a.dispenseRequest).toEqual({
      quantity: { value: 120, unit: 'tablet', system: UCUM, code: '{tablet}' },
      numberOfRepeatsAllowed: 0,
      expectedSupplyDuration: { value: 30, unit: 'days', system: UCUM, code: 'd' },
    });
    const b = get<MedicationRequest>(c, call(c, 'order_medication', { ...metformin, category: 'discharge', supply_days: 90, refills: 3, dispense_quantity: 200 }).medication_request as string);
    expect(b.category?.[0]?.coding?.[0]?.code).toBe('discharge');
    expect(b.dispenseRequest).toMatchObject({ quantity: { value: 200, code: '{tablet}' }, numberOfRepeatsAllowed: 3, expectedSupplyDuration: { value: 90 } });
    const once = get<MedicationRequest>(c, call(c, 'order_medication', { ...metformin, frequency: 'ONCE' }).medication_request as string);
    expect(once.dispenseRequest).toMatchObject({ quantity: { value: 2 }, expectedSupplyDuration: { value: 1 } });
  });
});

describe('11. required bindings in validate()', () => {
  const sr: ServiceRequest = { resourceType: 'ServiceRequest', id: 'sr-x', status: 'active', intent: 'order', subject: { reference: 'Patient/pt-0001' } };
  it('flags a code outside its required value set, naming the element', () => {
    expect(validate(sr)).toBeUndefined();
    expect(validate({ ...sr, intent: 'bogus-intent' } as never)).toMatchObject({ path: 'ServiceRequest.intent' });
    expect(validate({ ...sr, priority: 'whenever' } as never)).toMatchObject({ path: 'ServiceRequest.priority' });
    const task: Task = { resourceType: 'Task', id: 't', status: 'requested', intent: 'order' };
    expect(validate({ ...task, status: 'done' } as never)).toMatchObject({ path: 'Task.status' });
    expect(validate({ ...task, intent: 'command' } as never)).toMatchObject({ path: 'Task.intent' });
    const mr = APIXABAN;
    expect(validate(mr)).toBeUndefined();
    expect(validate({ ...mr, category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/medicationrequest-category', code: 'home' }] }] })).toMatchObject({ path: 'MedicationRequest.category[0]' });
    expect(validate({ ...NKDA, category: ['drug'] } as never)).toMatchObject({ path: 'AllergyIntolerance.category[0]' });
    expect(validate({ ...NKDA, clinicalStatus: { coding: [{ system: CLINICAL, code: 'gone' }] } })).toMatchObject({ path: 'AllergyIntolerance.clinicalStatus' });
  });
});

describe('12. write_note cites policies', () => {
  const note = { patient: 'pt-0001', type: 'progress_note', title: 'Renal dose review', text: 'Per RBC-PHARM-07: apixaban 5 mg BID.', cites: [] };
  it('records cites_policies as identifier references in context.related and the Provenance', () => {
    const c = fresh();
    const r = call(c, 'write_note', { ...note, cites: ['Observation/obs-00001'], cites_policies: ['RBC-PHARM-07'] });
    const doc = get<DocumentReference>(c, r.note as string);
    expect(doc.context?.related).toEqual([
      { reference: 'Observation/obs-00001' },
      { identifier: { system: 'urn:riverbend:policy', value: 'RBC-PHARM-07' }, display: 'Renal and age dose review (version 3)' },
    ]);
    expect(get<Provenance>(c, 'Provenance/prov-t0001').entity).toEqual([
      { role: 'source', what: { reference: 'Observation/obs-00001' } },
      { role: 'source', what: { identifier: { system: 'urn:riverbend:policy', value: 'RBC-PHARM-07' }, display: 'Renal and age dose review (version 3)' } },
    ]);
  });
  it('rejects an unknown policy, and a Policy in cites with a message that says how to cite it', async () => {
    const c = fresh();
    expect(await rejected(c, 'write_note', { ...note, cites_policies: ['RBC-NOPE-01'] })).toMatchObject({ code: 'NOT_FOUND', field: 'cites_policies[0]' });
    const e = await rejected(c, 'write_note', { ...note, cites: ['Policy/RBC-PHARM-07'] });
    expect(e).toMatchObject({ code: 'INVALID_INPUT', field: 'cites[0]' });
    expect(e.message).toContain('cites_policies');
  });
});
