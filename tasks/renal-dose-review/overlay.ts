// T1 renal-dose-review overlay (design section 4, "T1"): Harold Vance, 82, on slot pt-0002,
// whose Synthea chart keeps its encounters, procedures, older labs and cardiac history. The
// overlay renames him, adds the four medications the review covers, the creatinine and weight
// series with their traps, the February admission and two notes, and removes what would
// contradict the scenario: Synthea's notes (they name the old patient and list other drugs), the
// antiplatelets, NSAID and duplicate statin and beta-blocker, the 83.6 kg weights and their BMIs,
// the heights left at those exams, the prediabetes and obesity entries, the drug-abuse entry and
// its rehabilitation visit, the full-time employment at 80 and the 2026-10-18 visit with only a
// dental procedure. The 2019 STEMI becomes a resolved problem (its history entry stays). The two
// base creatinine results are recoded to serum creatinine (2160-0) at values on his recovery
// curve, both older than this week's.
//
// Traps (design "Wrong paths"): obs-t1-scr-1021 is the latest SCr by date but entered in error;
// obs-t1-scr-0209 and obs-t1-scr-0512 are stale; obs-t1-wt-0210 is the stale inpatient weight,
// also stated in the discharge summary. The truth is obs-t1-scr-1020 and obs-t1-wt-1020.
import type { Resource } from '../../packages/env/store.ts';
import type { Overlay, WorldReader } from '../../packages/env/overlay.ts';

const PT = 'pt-0002';
const SUBJECT = { reference: `Patient/${PT}` };
const OKAFOR = { reference: 'Practitioner/pr-okafor' };
const CLINIC = { reference: 'Organization/org-riverbend' };
const HOSPITAL = { reference: 'Organization/org-st-brigid' };

const LOINC = 'http://loinc.org';
const SNOMED = 'http://snomed.info/sct';
const UCUM = 'http://unitsofmeasure.org';
const RXNORM = 'http://www.nlm.nih.gov/research/umls/rxnorm';
const GTS = 'http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation';

// Base resources of pt-0002 that contradict the scenario.
const REMOVE: Array<{ resourceType: string; id: string }> = [
  // clopidogrel, simvastatin, naproxen, aspirin, carvedilol, prasugrel
  ...['mr-00007', 'mr-00008', 'mr-00011', 'mr-00012', 'mr-00013', 'mr-00014'].map((id) => ({ resourceType: 'MedicationRequest', id })),
  // body weight 83.6 kg and BMI, 2026-07-05 and 2026-10-04
  ...['obs-00091', 'obs-00108', 'obs-00094', 'obs-00111'].map((id) => ({ resourceType: 'Observation', id })),
  // body height at the same two exams
  ...['obs-00101', 'obs-00118'].map((id) => ({ resourceType: 'Observation', id })),
  // prediabetes, obesity, dependent drug abuse, full-time employment
  ...['cond-00019', 'cond-00021', 'cond-00026', 'cond-00047'].map((id) => ({ resourceType: 'Condition', id })),
  // rehabilitation therapy for the drug abuse; the 2026-10-18 check-up and its dental surgery
  ...['proc-00024', 'proc-00033'].map((id) => ({ resourceType: 'Procedure', id })),
  { resourceType: 'Encounter', id: 'enc-00012' },
  ...['doc-00007', 'doc-00008', 'doc-00009', 'doc-00010', 'doc-00011', 'doc-00012'].map((id) => ({ resourceType: 'DocumentReference', id })),
  { resourceType: 'DiagnosticReport', id: 'dr-00019' },
];

// The base "Creatinine [Mass/volume] in Blood" (38483-4) results of 2026-07-05 and 2026-10-04,
// recoded to the serum creatinine every other result uses, at values on his recovery curve
// (Synthea had 0.69), each issued four hours after collection.
const BASE_CREATININE: Record<string, [value: number, issued: string]> = {
  'obs-00093': [1.29, '2026-07-05T06:58:14-04:00'],
  'obs-00110': [1.26, '2026-10-04T06:58:14-04:00'],
};
const SCR_CODE = { coding: [{ system: LOINC, code: '2160-0', display: 'Creatinine [Mass/volume] in Serum or Plasma' }], text: 'Creatinine [Mass/volume] in Serum or Plasma' };

// The attending who signed the discharge summary.
const ATTENDING: Resource = { resourceType: 'Practitioner', id: 'pr-t1-raman', active: true, name: [{ use: 'official', given: ['Priya'], family: 'Raman', suffix: ['MD'] }] };

const encounter = (id: string, cls: 'AMB' | 'IMP', type: [string, string], start: string, end: string, provider: { reference: string }): Resource => ({
  resourceType: 'Encounter',
  id,
  status: 'finished',
  class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: cls },
  type: [{ coding: [{ system: SNOMED, code: type[0], display: type[1] }], text: type[1] }],
  subject: SUBJECT,
  ...(cls === 'AMB' ? { participant: [{ individual: OKAFOR }] } : {}),
  period: { start, end },
  serviceProvider: provider,
});

const condition = (id: string, code: string, display: string, onset: string, abated?: string): Resource => ({
  resourceType: 'Condition',
  id,
  clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: abated ? 'resolved' : 'active' }] },
  verificationStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status', code: 'confirmed' }] },
  category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-category', code: 'problem-list-item', display: 'Problem List Item' }] }],
  code: { coding: [{ system: SNOMED, code, display }], text: display },
  subject: SUBJECT,
  onsetDateTime: onset,
  ...(abated ? { abatementDateTime: abated } : {}),
  recordedDate: onset,
});

const category = (code: string, display: string) => [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code, display }] }];

const creatinine = (id: string, at: string, issued: string, value: number, enc: string | null, extra: Partial<Extract<Resource, { resourceType: 'Observation' }>> = {}): Resource => ({
  resourceType: 'Observation',
  id,
  status: 'final',
  category: category('laboratory', 'Laboratory'),
  code: SCR_CODE,
  subject: SUBJECT,
  ...(enc ? { encounter: { reference: `Encounter/${enc}` } } : {}),
  effectiveDateTime: at,
  issued,
  valueQuantity: { value, unit: 'mg/dL', system: UCUM, code: 'mg/dL' },
  referenceRange: [{ low: { value: 0.74, unit: 'mg/dL', system: UCUM, code: 'mg/dL' }, high: { value: 1.35, unit: 'mg/dL', system: UCUM, code: 'mg/dL' } }],
  ...extra,
});

const weight = (id: string, at: string, issued: string, value: number, unit: 'kg' | '[lb_av]', enc: string): Resource => ({
  resourceType: 'Observation',
  id,
  status: 'final',
  category: category('vital-signs', 'Vital signs'),
  code: { coding: [{ system: LOINC, code: '29463-7', display: 'Body weight' }], text: 'Body weight' },
  subject: SUBJECT,
  encounter: { reference: `Encounter/${enc}` },
  effectiveDateTime: at,
  issued,
  valueQuantity: { value, unit: unit === 'kg' ? 'kg' : 'lb', system: UCUM, code: unit },
});

const FREQ = { BID: [2, 'twice daily'], TID: [3, 'three times daily'], QHS: [1, 'at bedtime'] } as const;

const medication = (
  id: string,
  rx: [code: string, display: string],
  dose: number,
  freq: keyof typeof FREQ,
  authored: string,
  reason: string,
  extra: Partial<Extract<Resource, { resourceType: 'MedicationRequest' }>> = {},
): Resource => {
  const [perDay, words] = FREQ[freq];
  return {
    resourceType: 'MedicationRequest',
    id,
    status: 'active',
    intent: 'order',
    category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/medicationrequest-category', code: 'community', display: 'Community' }], text: 'Community' }],
    medicationCodeableConcept: { coding: [{ system: RXNORM, code: rx[0], display: rx[1] }], text: rx[1] },
    subject: SUBJECT,
    authoredOn: authored,
    requester: OKAFOR,
    reasonCode: [{ text: reason }],
    dosageInstruction: [
      {
        text: `${dose} mg by mouth ${words}`,
        timing: {
          code: { coding: [{ system: GTS, code: freq === 'QHS' ? 'BED' : freq }], text: words },
          repeat: { frequency: perDay, period: 1, periodUnit: 'd', ...(freq === 'QHS' ? { when: ['HS' as const] } : {}) },
        },
        route: { coding: [{ system: SNOMED, code: '26643006', display: 'Oral route' }], text: 'oral' },
        doseAndRate: [{ doseQuantity: { value: dose, unit: 'mg', system: UCUM, code: 'mg' } }],
      },
    ],
    dispenseRequest: { numberOfRepeatsAllowed: 3, expectedSupplyDuration: { value: 90, unit: 'days', system: UCUM, code: 'd' } },
    ...extra,
  };
};

function base64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

const note = (id: string, date: string, type: [string, string], enc: string, author: { reference: string } | null, custodian: { reference: string }, text: string): Resource => ({
  resourceType: 'DocumentReference',
  id,
  meta: { tag: [{ system: 'urn:riverbend:provenance', code: 'synthetic', display: 'Hand-written synthetic note' }] },
  status: 'current',
  docStatus: 'final',
  type: { coding: [{ system: LOINC, code: type[0], display: type[1] }], text: type[1] },
  category: [{ coding: [{ system: 'http://hl7.org/fhir/us/core/CodeSystem/us-core-documentreference-category', code: 'clinical-note', display: 'Clinical Note' }] }],
  subject: SUBJECT,
  date,
  ...(author ? { author: [author] } : {}),
  custodian,
  content: [{ attachment: { contentType: 'text/plain; charset=utf-8', data: base64(text) } }],
  context: { encounter: [{ reference: `Encounter/${enc}` }] },
});

const DISCHARGE = `St. Brigid Regional - Discharge Summary
Patient: Harold Vance   MRN 4410-22   DOB 1944-03-11
Admitted 2026-02-07, discharged 2026-02-12. Service: Hospital Medicine.

Principal diagnosis: acute kidney injury (prerenal), with dehydration after viral gastroenteritis.
Other diagnoses: non-valvular atrial fibrillation; type 2 diabetes mellitus; postherpetic neuralgia; coronary artery disease, remote STEMI.

Hospital course: four days of vomiting and poor oral intake before admission. Creatinine 1.71 mg/dL on 2/9. Treated with IV fluids; renal function improving at discharge. Metformin held during the admission and resumed at discharge. Gabapentin continued at the home dose.

Weight 57.0 kg on 2/10.

Anticoagulation: apixaban reduced from 5 mg twice daily to 2.5 mg twice daily (age 80 or older, weight 60 kg or less, creatinine 1.5 mg/dL or higher).

Follow-up: Riverbend Family Medicine within 1 week; repeat creatinine and weight.

Attending: Priya Raman, MD`;

const FOLLOW_UP = `Progress note - Riverbend Family Medicine
Follow-up after the February admission to St. Brigid Regional for acute kidney injury.

Feels well. Eating normally and regaining weight since discharge. No bleeding.

Creatinine today 1.31 mg/dL (1.71 mg/dL in February).

Atrial fibrillation: rate controlled on metoprolol. Continue apixaban 2.5 mg twice daily. Repeat creatinine and weight in the fall.
Type 2 diabetes: continue metformin 1000 mg twice daily.
Postherpetic neuralgia: pain controlled on gabapentin 600 mg three times daily.
Hyperlipidemia: continue atorvastatin 40 mg at bedtime.

Maya Okafor, MD`;

const overlay: Overlay = {
  task: 'T1',
  build(world: WorldReader) {
    const patient = world.get('Patient', PT) as Extract<Resource, { resourceType: 'Patient' }>;
    const renamed: Resource = {
      ...patient,
      name: [{ use: 'official', family: 'Vance', given: ['Harold'], prefix: ['Mr.'] }],
      birthDate: '1944-03-11',
      identifier: (patient.identifier ?? []).map((i) => (i.system === 'urn:riverbend:mrn' ? { ...i, value: '4410-22' } : i)),
    };
    const creatinineBlood = Object.entries(BASE_CREATININE).map(([id, [value, issued]]): Resource => {
      const obs = world.get('Observation', id) as Extract<Resource, { resourceType: 'Observation' }>;
      return { ...obs, code: SCR_CODE, issued, valueQuantity: { ...obs.valueQuantity, value } };
    });
    const stemi = world.get('Condition', 'cond-00037') as Extract<Resource, { resourceType: 'Condition' }>;
    const stemiResolved: Resource = {
      ...stemi,
      clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'resolved' }] },
      abatementDateTime: '2019-06-16T10:00:00-04:00',
    };

    const put: Resource[] = [
      renamed,
      ...creatinineBlood,
      stemiResolved,
      ATTENDING,
      encounter('enc-t1-0207', 'IMP', ['32485007', 'Hospital admission (procedure)'], '2026-02-07T14:20:00-05:00', '2026-02-12T11:30:00-05:00', HOSPITAL),
      encounter('enc-t1-0512', 'AMB', ['185347001', 'Encounter for problem (procedure)'], '2026-05-12T09:30:00-04:00', '2026-05-12T10:00:00-04:00', CLINIC),
      encounter('enc-t1-1020', 'AMB', ['185349003', 'Encounter for check up (procedure)'], '2026-10-20T09:00:00-04:00', '2026-10-20T09:20:00-04:00', CLINIC),
      condition('cond-t1-af', '49436004', 'Atrial fibrillation (disorder)', '2021-04-14T10:00:00-04:00'),
      condition('cond-t1-t2dm', '44054006', 'Diabetes mellitus type 2 (disorder)', '2015-09-02T10:00:00-04:00'),
      condition('cond-t1-phn', '2177002', 'Postherpetic neuralgia (disorder)', '2023-03-21T10:00:00-04:00'),
      condition('cond-t1-hld', '55822004', 'Hyperlipidemia (disorder)', '2015-09-02T10:00:00-04:00'),
      condition('cond-t1-aki', '14669001', 'Acute kidney injury (disorder)', '2026-02-07T14:20:00-05:00', '2026-05-12T09:30:00-04:00'),
      creatinine('obs-t1-scr-0209', '2026-02-09T06:10:00-05:00', '2026-02-09T07:45:00-05:00', 1.71, 'enc-t1-0207'),
      creatinine('obs-t1-scr-0512', '2026-05-12T09:40:00-04:00', '2026-05-12T13:20:00-04:00', 1.31, 'enc-t1-0512'),
      creatinine('obs-t1-scr-1020', '2026-10-20T09:15:00-04:00', '2026-10-20T13:05:00-04:00', 1.21, 'enc-t1-1020'),
      creatinine('obs-t1-scr-1021', '2026-10-21T10:05:00-04:00', '2026-10-21T13:30:00-04:00', 1.88, null, {
        status: 'entered-in-error',
        note: [{ time: '2026-10-21T16:40:00-04:00', text: 'Entered in error: specimen mislabelled, belongs to another patient.' }],
      }),
      weight('obs-t1-wt-0210', '2026-02-10T07:00:00-05:00', '2026-02-10T07:02:00-05:00', 57.0, 'kg', 'enc-t1-0207'),
      weight('obs-t1-wt-1020', '2026-10-20T09:05:00-04:00', '2026-10-20T09:07:00-04:00', 143, '[lb_av]', 'enc-t1-1020'),
      medication('mr-t1-apixaban-5', ['1364445', 'apixaban 5 MG Oral Tablet'], 5, 'BID', '2021-04-14T10:30:00-04:00', 'Non-valvular atrial fibrillation', {
        status: 'stopped',
        statusReason: { text: 'Dose reduced to 2.5 mg twice daily on discharge from St. Brigid Regional' },
      }),
      medication('mr-t1-apixaban', ['1364435', 'apixaban 2.5 MG Oral Tablet'], 2.5, 'BID', '2026-02-16T10:00:00-05:00', 'Non-valvular atrial fibrillation; dose reduced during the February admission', {
        priorPrescription: { reference: 'MedicationRequest/mr-t1-apixaban-5' },
      }),
      medication('mr-t1-metformin', ['861004', 'metformin hydrochloride 1000 MG Oral Tablet'], 1000, 'BID', '2025-11-03T10:00:00-05:00', 'Type 2 diabetes mellitus'),
      medication('mr-t1-gabapentin', ['310433', 'gabapentin 600 MG Oral Tablet'], 600, 'TID', '2025-08-19T10:00:00-04:00', 'Postherpetic neuralgia'),
      medication('mr-t1-atorvastatin', ['617311', 'atorvastatin 40 MG Oral Tablet'], 40, 'QHS', '2025-11-03T10:00:00-05:00', 'Hyperlipidemia'),
      note('doc-t1-dc-0212', '2026-02-12T11:30:00-05:00', ['18842-5', 'Discharge summary'], 'enc-t1-0207', { reference: 'Practitioner/pr-t1-raman' }, HOSPITAL, DISCHARGE),
      note('doc-t1-pn-0512', '2026-05-12T10:00:00-04:00', ['11506-3', 'Progress note'], 'enc-t1-0512', OKAFOR, CLINIC, FOLLOW_UP),
    ];
    return {
      put,
      remove: REMOVE,
      lint: {
        thresholds: [
          { quantity: 'scr', threshold: 1.5, observation: 'obs-t1-scr-1020' },
          { quantity: 'weight', threshold: 60, observation: 'obs-t1-wt-1020' },
          { quantity: 'egfr', threshold: 45, value: 59.8, label: 'eGFR from obs-t1-scr-1020' },
          { quantity: 'egfr', threshold: 30, value: 59.8, label: 'eGFR from obs-t1-scr-1020' },
          { quantity: 'crcl', threshold: 60, value: 43.2, label: 'CrCl from obs-t1-scr-1020 and obs-t1-wt-1020' },
          { quantity: 'crcl', threshold: 30, value: 43.2, label: 'CrCl from obs-t1-scr-1020 and obs-t1-wt-1020' },
        ],
        ages: [{ patient: PT, threshold: 80 }],
        leakage: { answers: ['59.8', '43.2', '43.18', '59.78'], distractors: ['doc-t1-dc-0212', 'doc-t1-pn-0512', 'obs-t1-scr-1021', 'mr-t1-apixaban'] },
      },
    };
  },
};

export default overlay;
