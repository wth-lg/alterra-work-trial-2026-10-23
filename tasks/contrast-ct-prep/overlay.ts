// T5 contrast-ct-prep overlay (design section 4, "T5"): Daniel Ferreira, 64, on slot pt-0015,
// whose Synthea chart keeps its exams, vitals, lipid panels, hypertension and amlodipine. The
// overlay renames him and sets his birth date, adds type 2 diabetes on metformin, the pancreatic
// cyst the CT follows, the three allergies, the two creatinine results, the 2019 and 2023 CTs at
// St. Brigid Regional with their reports, the completed 2023 premedication orders, the booked
// appointment and the two notes that led to it, and the diabetes labs of the 2026-04-20 annual
// exam (an A1c, and a metabolic panel cancelled undrawn, which is why the 2025 creatinine is
// still the latest). It removes what would contradict the scenario:
// Synthea's notes and their report (they name the old patient), the active diphenhydramine
// order from 1975, the "allergic disposition" entry and the two transport findings, which would
// each start a question the task does not ask. Slot pt-0012 is left as it is.
//
// Traps (design "Other traps"): the shellfish and povidone-iodine allergies are not contrast
// risk factors (RBC-RAD-07 §1); the latest creatinine, obs-t5-scr-0814, is from 2025-08-14,
// more than 30 days before the scan; the completed 2023 premedication orders were timed for a
// 14:00 scan, so copying their clock times forward is wrong for a 09:00 one. Their reason says
// only that they were contrast premedication: the scan time is in the 2023 encounter and report,
// not spelled out on the order (review-difficulty-T5-1).
//
// The 2019 reaction is moderate (diffuse urticaria with mild eyelid swelling), not mild: the 2025
// ACR-AAAAI consensus advises against premedication after a mild reaction, so a mild one would
// put RBC-RAD-07 §2 against current guidance (review-clinical-T5-1 S1).
import type { Resource } from '../../packages/env/store.ts';
import type { Overlay, WorldReader } from '../../packages/env/overlay.ts';

const PT = 'pt-0015';
const SUBJECT = { reference: `Patient/${PT}` };
const OKAFOR = { reference: 'Practitioner/pr-okafor' };
const REYES = { reference: 'Practitioner/pr-reyes' };
const RADIOLOGIST = { reference: 'Practitioner/pr-t5-adeyemi' };
const CLINIC = { reference: 'Organization/org-riverbend' };
const HOSPITAL = { reference: 'Organization/org-st-brigid' };

const LOINC = 'http://loinc.org';
const SNOMED = 'http://snomed.info/sct';
const UCUM = 'http://unitsofmeasure.org';
const RXNORM = 'http://www.nlm.nih.gov/research/umls/rxnorm';
const GTS = 'http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation';

// Base resources of pt-0015 that contradict the scenario.
const REMOVE: Array<{ resourceType: string; id: string }> = [
  // diphenhydramine 25 mg, active since 1975
  { resourceType: 'MedicationRequest', id: 'mr-00178' },
  // "allergic disposition"
  { resourceType: 'AllergyIntolerance', id: 'alg-00006' },
  // lack of access to transportation, transport problem
  ...['cond-00368', 'cond-00369'].map((id) => ({ resourceType: 'Condition', id })),
  ...['doc-00085', 'doc-00086', 'doc-00087', 'doc-00088', 'doc-00089', 'doc-00090'].map((id) => ({ resourceType: 'DocumentReference', id })),
  { resourceType: 'DiagnosticReport', id: 'dr-00171' },
];

const RADIOLOGIST_RESOURCE: Resource = { resourceType: 'Practitioner', id: 'pr-t5-adeyemi', active: true, name: [{ use: 'official', given: ['Tunde'], family: 'Adeyemi', suffix: ['MD'] }] };

const encounter = (id: string, type: [string, string], start: string, end: string, provider: { reference: string }, who: { reference: string }): Resource => ({
  resourceType: 'Encounter',
  id,
  status: 'finished',
  class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB' },
  type: [{ coding: [{ system: SNOMED, code: type[0], display: type[1] }], text: type[1] }],
  subject: SUBJECT,
  participant: [{ individual: who }],
  period: { start, end },
  serviceProvider: provider,
});

const condition = (id: string, code: string, display: string, onset: string): Resource => ({
  resourceType: 'Condition',
  id,
  clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }] },
  verificationStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status', code: 'confirmed' }] },
  category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-category', code: 'problem-list-item', display: 'Problem List Item' }] }],
  code: { coding: [{ system: SNOMED, code, display }], text: display },
  subject: SUBJECT,
  onsetDateTime: onset,
  recordedDate: onset,
});

const LAB = [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'laboratory', display: 'Laboratory' }] }];

const creatinine = (id: string, at: string, issued: string, value: number, enc: string): Resource => ({
  resourceType: 'Observation',
  id,
  status: 'final',
  category: LAB,
  code: { coding: [{ system: LOINC, code: '2160-0', display: 'Creatinine [Mass/volume] in Serum or Plasma' }], text: 'Creatinine [Mass/volume] in Serum or Plasma' },
  subject: SUBJECT,
  encounter: { reference: `Encounter/${enc}` },
  effectiveDateTime: at,
  issued,
  valueQuantity: { value, unit: 'mg/dL', system: UCUM, code: 'mg/dL' },
  referenceRange: [{ low: { value: 0.74, unit: 'mg/dL', system: UCUM, code: 'mg/dL' }, high: { value: 1.35, unit: 'mg/dL', system: UCUM, code: 'mg/dL' } }],
});

const CLINICAL = 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical';
const VERIFICATION = 'http://terminology.hl7.org/CodeSystem/allergyintolerance-verification';

const allergy = (
  id: string,
  category: 'medication' | 'food',
  substance: [system: string, code: string, display: string],
  verification: 'confirmed' | 'unconfirmed',
  onset: string,
  recorded: string,
  manifestation: [code: string, display: string],
  severity: 'mild' | 'moderate',
): Resource => ({
  resourceType: 'AllergyIntolerance',
  id,
  clinicalStatus: { coding: [{ system: CLINICAL, code: 'active', display: 'Active' }] },
  verificationStatus: { coding: [{ system: VERIFICATION, code: verification, display: verification === 'confirmed' ? 'Confirmed' : 'Unconfirmed' }] },
  type: 'allergy',
  category: [category],
  criticality: 'low',
  code: { coding: [{ system: substance[0], code: substance[1], display: substance[2] }], text: substance[2] },
  patient: SUBJECT,
  onsetDateTime: onset,
  recordedDate: recorded,
  reaction: [{ manifestation: [{ coding: [{ system: SNOMED, code: manifestation[0], display: manifestation[1] }], text: manifestation[1] }], severity }],
});

// The 2023 premedication, timed for a 14:00 scan: prednisone 50 mg at 01:00, 07:00 and 13:00,
// diphenhydramine 50 mg at 13:00. Both completed.
const premed2023 = (id: string, rx: [code: string, display: string], form: 'tablet' | 'capsule', strength: number, events: string[], reason: string): Resource => ({
  resourceType: 'MedicationRequest',
  id,
  status: 'completed',
  intent: 'order',
  category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/medicationrequest-category', code: 'community', display: 'Community' }], text: 'Community' }],
  medicationCodeableConcept: { coding: [{ system: RXNORM, code: rx[0], display: rx[1] }], text: rx[1] },
  subject: SUBJECT,
  authoredOn: '2023-06-15T11:20:00-04:00',
  requester: { reference: 'Practitioner/pr-lin' },
  reasonCode: [{ text: reason }],
  dosageInstruction: [
    {
      text: `50 mg by mouth at ${events.map((e) => `${Number(e.slice(11, 13)) % 12 || 12}:00 ${Number(e.slice(11, 13)) < 12 ? 'AM' : 'PM'} on 06/20/2023`).join(', ')}`,
      timing: { event: events },
      route: { coding: [{ system: SNOMED, code: '26643006', display: 'Oral route' }], text: 'oral' },
      doseAndRate: [{ doseQuantity: { value: 50, unit: 'mg', system: UCUM, code: 'mg' } }],
    },
  ],
  dispenseRequest: {
    quantity: { value: (events.length * 50) / strength, unit: form, system: UCUM, code: `{${form}}` },
    numberOfRepeatsAllowed: 0,
    expectedSupplyDuration: { value: 1, unit: 'days', system: UCUM, code: 'd' },
  },
});

function base64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

const note = (id: string, date: string, type: [string, string], enc: string | null, author: { reference: string }, custodian: { reference: string }, text: string): Resource => ({
  resourceType: 'DocumentReference',
  id,
  meta: { tag: [{ system: 'urn:riverbend:provenance', code: 'synthetic', display: 'Hand-written synthetic note' }] },
  status: 'current',
  docStatus: 'final',
  type: { coding: [{ system: LOINC, code: type[0], display: type[1] }], text: type[1] },
  category: [{ coding: [{ system: 'http://hl7.org/fhir/us/core/CodeSystem/us-core-documentreference-category', code: 'clinical-note', display: 'Clinical Note' }] }],
  subject: SUBJECT,
  date,
  author: [author],
  custodian,
  content: [{ attachment: { contentType: 'text/plain; charset=utf-8', data: base64(text) } }],
  ...(enc ? { context: { encounter: [{ reference: `Encounter/${enc}` }] } } : {}),
});

const CT_2019 = `St. Brigid Regional - Radiology Report
Patient: Daniel Ferreira   DOB 1962-03-30
Exam: CT abdomen and pelvis with IV contrast   Date: 2019-05-14

Indication: right lower quadrant pain for 3 days.
Technique: axial CT of the abdomen and pelvis after 100 mL iohexol (Omnipaque 350) IV.

Findings: normal appendix. Sigmoid diverticulosis without inflammation. Liver, pancreas, spleen, adrenal glands and kidneys are unremarkable. No free fluid.
Impression: no acute abnormality. Uncomplicated sigmoid diverticulosis.

Contrast reaction: about 5 minutes after the injection the patient reported itching and developed diffuse hives over the trunk and all four limbs, with mild swelling of both eyelids. No throat tightness, no hoarseness, no dyspnea, no wheeze. BP 132/84, HR 92, SpO2 98% on room air. Diphenhydramine 50 mg given IV. The hives and eyelid swelling faded over 90 minutes; observed for 2 hours and discharged.
Classification: moderate allergic-like reaction to iohexol. Added to the allergy list.

Radiologist: Tunde Adeyemi, MD`;

const CT_2023 = `St. Brigid Regional - Radiology Report
Patient: Daniel Ferreira   DOB 1962-03-30
Exam: CT abdomen and pelvis with IV contrast   Date: 2023-06-20

Indication: left lower quadrant pain; history of sigmoid diverticulosis.
Technique: axial CT of the abdomen and pelvis after 100 mL iohexol (Omnipaque 350) IV. The patient was premedicated for a prior contrast reaction; no reaction today.

Findings: mild sigmoid diverticulosis without diverticulitis. A 1.3 cm well-circumscribed cystic lesion in the pancreatic body, without a solid component, wall thickening or main duct dilatation. Liver, spleen and kidneys are unremarkable.
Impression:
1. No diverticulitis.
2. 1.3 cm cystic lesion of the pancreatic body, likely a side-branch IPMN. Recommend surveillance imaging; GI referral.

Radiologist: Tunde Adeyemi, MD`;

const PHONE_0922 = `Telephone note - Riverbend Family Medicine
Letter from GI (St. Brigid Regional) received: the 1.3 cm pancreatic body cyst seen on CT in June 2023 is overdue for surveillance imaging. GI had asked for repeat imaging in 2024; the referral was not completed. GI recommends CT abdomen and pelvis with IV contrast, pancreatic protocol.
Called the patient. We discussed MRI as an alternative; he is claustrophobic and prefers CT, which GI accepts. Sent to scheduling to book at St. Brigid Imaging.
Type 2 diabetes: continues metformin 1000 mg twice daily; no new symptoms.

Maya Okafor, MD`;

const PHONE_1009 = `Telephone note - Riverbend Family Medicine
CT abdomen and pelvis with IV contrast booked at St. Brigid Imaging for Monday 10/26 at 9:00 AM (arrive 8:45). Called the patient to confirm the time.
He asked whether he needs to do anything before the scan. Told him Dr. Okafor will place the order and send him instructions.

Jordan Reyes, NP`;

const overlay: Overlay = {
  task: 'T5',
  build(world: WorldReader) {
    const patient = world.get('Patient', PT) as Extract<Resource, { resourceType: 'Patient' }>;
    const renamed: Resource = {
      ...patient,
      name: [{ use: 'official', family: 'Ferreira', given: ['Daniel'], prefix: ['Mr.'] }],
      birthDate: '1962-03-30',
    };

    const put: Resource[] = [
      renamed,
      RADIOLOGIST_RESOURCE,
      encounter('enc-t5-0514', ['77477000', 'Computed tomography (procedure)'], '2019-05-14T10:00:00-04:00', '2019-05-14T12:40:00-04:00', HOSPITAL, RADIOLOGIST),
      encounter('enc-t5-0612', ['185347001', 'Encounter for problem (procedure)'], '2023-06-12T14:00:00-04:00', '2023-06-12T14:30:00-04:00', CLINIC, { reference: 'Practitioner/pr-lin' }),
      encounter('enc-t5-0620', ['77477000', 'Computed tomography (procedure)'], '2023-06-20T14:00:00-04:00', '2023-06-20T14:45:00-04:00', HOSPITAL, RADIOLOGIST),
      encounter('enc-t5-0814', ['185349003', 'Encounter for check up (procedure)'], '2025-08-14T09:00:00-04:00', '2025-08-14T09:30:00-04:00', CLINIC, OKAFOR),
      condition('cond-t5-t2dm', '44054006', 'Diabetes mellitus type 2 (disorder)', '2014-03-11T10:00:00-04:00'),
      condition('cond-t5-pcyst', '31258000', 'Cyst of pancreas (disorder)', '2023-06-20T14:45:00-04:00'),
      allergy('alg-t5-iohexol', 'medication', [RXNORM, '5956', 'iohexol'], 'confirmed', '2019-05-14T10:20:00-04:00', '2019-05-14T12:30:00-04:00', ['126485001', 'Urticaria'], 'moderate'),
      allergy('alg-t5-shellfish', 'food', [SNOMED, '735029006', 'Shellfish (substance)'], 'unconfirmed', '1998', '2014-03-11T10:00:00-04:00', ['271807003', 'Eruption of skin'], 'mild'),
      allergy('alg-t5-pvp', 'medication', [RXNORM, '8611', 'povidone-iodine'], 'confirmed', '2016-09', '2016-09-20T10:00:00-04:00', ['40275004', 'Contact dermatitis'], 'mild'),
      creatinine('obs-t5-scr-0612', '2023-06-12T14:20:00-04:00', '2023-06-12T18:05:00-04:00', 0.94, 'enc-t5-0612'),
      creatinine('obs-t5-scr-0814', '2025-08-14T09:20:00-04:00', '2025-08-14T13:10:00-04:00', 0.98, 'enc-t5-0814'),
      {
        resourceType: 'Observation',
        id: 'obs-t5-a1c-0814',
        status: 'final',
        category: LAB,
        code: { coding: [{ system: LOINC, code: '4548-4', display: 'Hemoglobin A1c/Hemoglobin.total in Blood' }], text: 'Hemoglobin A1c/Hemoglobin.total in Blood' },
        subject: SUBJECT,
        encounter: { reference: 'Encounter/enc-t5-0814' },
        effectiveDateTime: '2025-08-14T09:20:00-04:00',
        issued: '2025-08-14T15:40:00-04:00',
        valueQuantity: { value: 7.1, unit: '%', system: UCUM, code: '%' },
      },
      // The 2026-04-20 annual exam (Synthea's enc-00089): a point-of-care A1c, and a metabolic
      // panel ordered after the blood draw and cancelled.
      {
        resourceType: 'Observation',
        id: 'obs-t5-a1c-0420',
        status: 'final',
        category: LAB,
        code: { coding: [{ system: LOINC, code: '4548-4', display: 'Hemoglobin A1c/Hemoglobin.total in Blood' }], text: 'Hemoglobin A1c/Hemoglobin.total in Blood' },
        subject: SUBJECT,
        encounter: { reference: 'Encounter/enc-00089' },
        effectiveDateTime: '2026-04-20T15:20:00-04:00',
        issued: '2026-04-20T15:30:00-04:00',
        valueQuantity: { value: 6.9, unit: '%', system: UCUM, code: '%' },
        method: { text: 'Point-of-care' },
      },
      {
        resourceType: 'ServiceRequest',
        id: 'sr-t5-cmp-0420',
        status: 'revoked',
        intent: 'order',
        category: [{ coding: [{ system: SNOMED, code: '108252007', display: 'Laboratory procedure' }], text: 'lab' }],
        priority: 'routine',
        code: { coding: [{ system: LOINC, code: '24323-8', display: 'Comprehensive metabolic 2000 panel - Serum or Plasma' }], text: 'Comprehensive metabolic 2000 panel - Serum or Plasma' },
        subject: SUBJECT,
        encounter: { reference: 'Encounter/enc-00089' },
        occurrenceDateTime: '2026-04-20',
        authoredOn: '2026-04-20T15:25:00-04:00',
        requester: OKAFOR,
        reasonCode: [{ text: 'Type 2 diabetes mellitus: annual labs' }],
        note: [{ text: 'Not sent: ordered after the blood draw. Cancelled; to be drawn at the next visit.' }],
      },
      {
        resourceType: 'MedicationRequest',
        id: 'mr-t5-metformin',
        status: 'active',
        intent: 'order',
        category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/medicationrequest-category', code: 'community', display: 'Community' }], text: 'Community' }],
        medicationCodeableConcept: { coding: [{ system: RXNORM, code: '861004', display: 'metformin hydrochloride 1000 MG Oral Tablet' }], text: 'metformin hydrochloride 1000 MG Oral Tablet' },
        subject: SUBJECT,
        authoredOn: '2025-08-14T09:30:00-04:00',
        requester: OKAFOR,
        reasonCode: [{ text: 'Type 2 diabetes mellitus' }],
        dosageInstruction: [
          {
            text: '1000 mg by mouth twice daily',
            timing: { code: { coding: [{ system: GTS, code: 'BID' }], text: 'twice daily' }, repeat: { frequency: 2, period: 1, periodUnit: 'd' } },
            route: { coding: [{ system: SNOMED, code: '26643006', display: 'Oral route' }], text: 'oral' },
            doseAndRate: [{ doseQuantity: { value: 1000, unit: 'mg', system: UCUM, code: 'mg' } }],
          },
        ],
        dispenseRequest: { quantity: { value: 180, unit: 'tablet', system: UCUM, code: '{tablet}' }, numberOfRepeatsAllowed: 3, expectedSupplyDuration: { value: 90, unit: 'days', system: UCUM, code: 'd' } },
      },
      premed2023('mr-t5-pred-2023', ['198148', 'prednisone 50 MG Oral Tablet'], 'tablet', 50, ['2023-06-20T01:00:00-04:00', '2023-06-20T07:00:00-04:00', '2023-06-20T13:00:00-04:00'], 'Contrast premedication for CT'),
      premed2023('mr-t5-dph-2023', ['1020477', 'diphenhydramine hydrochloride 50 MG Oral Capsule'], 'capsule', 50, ['2023-06-20T13:00:00-04:00'], 'Contrast premedication for CT'),
      {
        resourceType: 'Appointment',
        id: 'appt-t5-1026',
        status: 'booked',
        serviceType: [{ coding: [{ system: SNOMED, code: '77477000', display: 'Computed tomography' }], text: 'CT' }],
        reasonReference: [{ reference: 'Condition/cond-t5-pcyst' }],
        description: 'CT abdomen and pelvis with IV contrast (pancreatic cyst surveillance), St. Brigid Imaging',
        start: '2026-10-26T09:00:00-04:00',
        end: '2026-10-26T09:30:00-04:00',
        minutesDuration: 30,
        created: '2026-10-09T10:15:00-04:00',
        participant: [{ actor: SUBJECT, status: 'accepted' }],
      },
      note('doc-t5-ct-2019', '2019-05-14T12:40:00-04:00', ['18748-4', 'Diagnostic imaging study'], 'enc-t5-0514', RADIOLOGIST, HOSPITAL, CT_2019),
      note('doc-t5-ct-2023', '2023-06-20T16:30:00-04:00', ['18748-4', 'Diagnostic imaging study'], 'enc-t5-0620', RADIOLOGIST, HOSPITAL, CT_2023),
      note('doc-t5-tel-0922', '2026-09-22T15:10:00-04:00', ['34748-4', 'Telephone encounter Note'], null, OKAFOR, CLINIC, PHONE_0922),
      note('doc-t5-tel-1009', '2026-10-09T10:20:00-04:00', ['34748-4', 'Telephone encounter Note'], null, REYES, CLINIC, PHONE_1009),
    ];
    return {
      put,
      remove: REMOVE,
      lint: {
        ages: [{ patient: PT, threshold: 60 }],
        // RBC-RAD-07 §4: a creatinine within 30 days before the scan.
        windows: [{ name: 'creatinine within 30 days of the 2026-10-26 scan', boundary: '2026-09-26', resources: ['obs-t5-scr-0612', 'obs-t5-scr-0814'] }],
        timeWindows: [{ name: 'premedication through the scan', start: '2026-10-25T20:00:00-04:00', end: '2026-10-26T09:30:00-04:00' }],
        leakage: {
          answers: ['8:00 PM', '2:00 AM', '2026-10-25T20:00', '2026-10-26T02:00'],
          distractors: ['doc-t5-ct-2019', 'doc-t5-ct-2023', 'doc-t5-tel-0922', 'doc-t5-tel-1009', 'mr-t5-pred-2023', 'mr-t5-dph-2023', 'appt-t5-1026'],
        },
      },
    };
  },
};

export default overlay;
