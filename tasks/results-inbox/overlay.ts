// T2 results-inbox overlay (design section 4, "T2"): Dr. Okafor's results inbox, 8 Tasks in the
// results queue, each focused on the report or result it files, on the T2 slots:
//
//   item  slot     patient                          result
//   1     pt-0013  Linda Marsh, 1958-04-17          CT abdomen/pelvis of 2026-06-04: 5 mm RLL nodule
//   2     pt-0007  Leslie Parisian (Synthea name)   renal ultrasound: Bosniak I cyst, no follow-up
//   3     pt-0006  Raj Patel                        positive FIT; Dr. Lin's GI referral exists
//   4     pt-0008  Walter Brennan                   BMP: K 6.4, specimen hemolyzed
//   5     pt-0010  Denise Holloway, CKD 3b          BMP: K 6.2, not hemolyzed
//   6     pt-0053  Tomás Ruiz, 16                   knee X-ray: lytic lesion, urgent referral and MRI
//   7, 8  pt-0016  Edra Ondricka (Synthea name)     TSH and lipid panel, normal
//   -     pt-0033  Linda Marsh, 1965-09-02          the second Linda Marsh, a never smoker
//
// Traps (design "Inbox"): item 1's smoking history (35 pack-years, quit 2019) is only in her H&P
// (doc-t2-hp-lm58); the structured status says Ex-smoker; the other Linda Marsh has a
// never-smoker note; the 12-month interval runs from 2026-06-04. Item 3's referral
// (sr-t2-gi-1020) already exists. Item 4's hemolysis is only in the potassium result's note.
// Item 6 states no interval.
//
// Chart hygiene: the six renamed patients lose Synthea's notes and history-and-physical reports,
// which name the old patient and contradict the scenario (pt-0013's say she quit at 16). Raj
// Patel's 2021 colonoscopy goes, since a screening FIT four years after one is implausible.
// Denise Holloway's CKD stage 1 and 2 entries become CKD 3b, and her base creatinine and MDRD
// eGFR results, which Synthea left contradicting each other, become a stable CKD 3b series.
// Leslie Parisian's duplicate simvastatin goes, and so does the 1965 Linda Marsh's tubal ligation
// dated 2020, which her new birth date puts at 55.
import type { Resource } from '../../packages/env/store.ts';
import type { Overlay, WorldReader } from '../../packages/env/overlay.ts';

const OKAFOR = { reference: 'Practitioner/pr-okafor' };
const LIN = { reference: 'Practitioner/pr-lin' };
const CLINIC = { reference: 'Organization/org-riverbend' };
const HOSPITAL = { reference: 'Organization/org-st-brigid' };

const LOINC = 'http://loinc.org';
const SNOMED = 'http://snomed.info/sct';
const UCUM = 'http://unitsofmeasure.org';
const RXNORM = 'http://www.nlm.nih.gov/research/umls/rxnorm';
const ORDERS = 'urn:riverbend:orders';
const INBOX = 'urn:riverbend:inbox-queue';
const OBS_CAT = 'http://terminology.hl7.org/CodeSystem/observation-category';
const V2_0074 = 'http://terminology.hl7.org/CodeSystem/v2-0074';
const INTERP = 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation';

type R<T extends string> = Extract<Resource, { resourceType: T }>;
const subject = (pt: string) => ({ reference: `Patient/${pt}` });

// The patients the overlay renames: [slot, given, family, birthDate, gender, MRN].
const RENAME: Array<[string, string[], string, string, 'male' | 'female', string]> = [
  ['pt-0013', ['Linda', 'Anne'], 'Marsh', '1958-04-17', 'female', '2207-41'],
  ['pt-0033', ['Linda', 'Rose'], 'Marsh', '1965-09-02', 'female', '3318-02'],
  ['pt-0006', ['Raj'], 'Patel', '1957-06-21', 'male', '1846-30'],
  ['pt-0008', ['Walter'], 'Brennan', '1959-07-23', 'male', '6025-17'],
  ['pt-0010', ['Denise'], 'Holloway', '1963-08-13', 'female', '4471-86'],
  ['pt-0053', ['Tomás'], 'Ruiz', '2010-02-11', 'male', '7730-58'],
];

// Base resources that contradict the scenario, beyond the renamed patients' notes.
const REMOVE: Array<{ resourceType: string; id: string }> = [
  { resourceType: 'Procedure', id: 'proc-00232' }, // Raj Patel's 2021 colonoscopy
  { resourceType: 'MedicationRequest', id: 'mr-00092' }, // Leslie Parisian's second simvastatin
  { resourceType: 'Condition', id: 'cond-00247' }, // Denise Holloway: CKD stage 1
  { resourceType: 'Condition', id: 'cond-00265' }, // Denise Holloway: CKD stage 2
  { resourceType: 'Condition', id: 'cond-00673' }, // the 1965 Linda Marsh: a tubal ligation in 2020, at 55
];

function base64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
const text = (s: string) => [{ contentType: 'text/plain; charset=utf-8', data: base64(s) }];

const encounter = (id: string, pt: string, cls: ['AMB' | 'EMER', string], type: [string, string], start: string, end: string, provider: { reference: string }, who?: { reference: string }): Resource => ({
  resourceType: 'Encounter',
  id,
  status: 'finished',
  class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: cls[0], display: cls[1] },
  type: [{ coding: [{ system: SNOMED, code: type[0], display: type[1] }], text: type[1] }],
  subject: subject(pt),
  ...(who ? { participant: [{ individual: who }] } : {}),
  period: { start, end },
  serviceProvider: provider,
});

const condition = (id: string, pt: string, code: string, display: string, onset: string): Resource => ({
  resourceType: 'Condition',
  id,
  clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }] },
  verificationStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status', code: 'confirmed' }] },
  category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-category', code: 'problem-list-item', display: 'Problem List Item' }] }],
  code: { coding: [{ system: SNOMED, code, display }], text: display },
  subject: subject(pt),
  onsetDateTime: onset,
  recordedDate: onset,
});

type Interp = 'N' | 'H' | 'HH' | 'L';
const INTERP_DISPLAY: Record<Interp, string> = { N: 'Normal', H: 'High', HH: 'Critical high', L: 'Low' };

const lab = (
  id: string,
  pt: string,
  enc: string,
  code: [string, string],
  at: string,
  issued: string,
  value: number | null,
  unit: string,
  range: [number, number] | null,
  interp: Interp,
  extra: Partial<R<'Observation'>> = {},
): Resource => ({
  resourceType: 'Observation',
  id,
  status: 'final',
  category: [{ coding: [{ system: OBS_CAT, code: 'laboratory', display: 'Laboratory' }] }],
  code: { coding: [{ system: LOINC, code: code[0], display: code[1] }], text: code[1] },
  subject: subject(pt),
  encounter: { reference: `Encounter/${enc}` },
  effectiveDateTime: at,
  issued,
  ...(value === null ? {} : { valueQuantity: { value, unit, system: UCUM, code: unit } }),
  interpretation: [{ coding: [{ system: INTERP, code: interp, display: INTERP_DISPLAY[interp] }] }],
  ...(range ? { referenceRange: [{ low: { value: range[0], unit, system: UCUM, code: unit }, high: { value: range[1], unit, system: UCUM, code: unit } }] } : {}),
  ...extra,
});

const report = (
  id: string,
  pt: string,
  enc: string,
  service: ['RAD' | 'LAB', string],
  code: [string, string],
  at: string,
  issued: string,
  performer: { reference: string },
  more: { results?: string[]; text?: string; basedOn?: string } = {},
): Resource => ({
  resourceType: 'DiagnosticReport',
  id,
  status: 'final',
  category: [{ coding: [{ system: V2_0074, code: service[0], display: service[1] }] }],
  code: { coding: [{ system: LOINC, code: code[0], display: code[1] }], text: code[1] },
  subject: subject(pt),
  encounter: { reference: `Encounter/${enc}` },
  effectiveDateTime: at,
  issued,
  performer: [performer],
  ...(more.basedOn ? { basedOn: [{ reference: more.basedOn }] } : {}),
  ...(more.results ? { result: more.results.map((r) => ({ reference: `Observation/${r}` })) } : {}),
  ...(more.text ? { presentedForm: text(more.text) } : {}),
});

const note = (id: string, pt: string, date: string, type: [string, string], enc: string, author: { reference: string }, custodian: { reference: string }, body: string): Resource => ({
  resourceType: 'DocumentReference',
  id,
  meta: { tag: [{ system: 'urn:riverbend:provenance', code: 'synthetic', display: 'Hand-written synthetic note' }] },
  status: 'current',
  docStatus: 'final',
  type: { coding: [{ system: LOINC, code: type[0], display: type[1] }], text: type[1] },
  category: [{ coding: [{ system: 'http://hl7.org/fhir/us/core/CodeSystem/us-core-documentreference-category', code: 'clinical-note', display: 'Clinical Note' }] }],
  subject: subject(pt),
  date,
  author: [author],
  custodian,
  content: [{ attachment: text(body)[0]! }],
  context: { encounter: [{ reference: `Encounter/${enc}` }] },
});

// An inbox item: a Task in the results queue, owned by Dr. Okafor (design section 3, list_inbox).
const item = (n: number, pt: string, focus: string, received: string, from: { reference: string }, summary: string, notes: Array<{ time: string; text: string }> = []): Resource => ({
  resourceType: 'Task',
  id: `task-t2-inbox-${n}`,
  status: 'requested',
  intent: 'order',
  priority: 'routine',
  code: { coding: [{ system: INBOX, code: 'results', display: 'Results' }], text: 'Results inbox' },
  description: summary,
  focus: { reference: focus },
  for: subject(pt),
  authoredOn: received,
  lastModified: received,
  requester: from,
  owner: OKAFOR,
  ...(notes.length ? { note: notes } : {}),
});

const K: [string, string] = ['2823-3', 'Potassium [Moles/volume] in Serum or Plasma'];
const BMP: [string, string] = ['51990-0', 'Basic metabolic panel - Blood'];

// A basic metabolic panel's eight results; `k` carries the potassium's value, flag and note.
function bmp(tag: string, pt: string, enc: string, at: string, issued: string, v: { na: number; k: number; cl: number; co2: number; bun: number; cr: number; glu: number; ca: number }, kExtra: Partial<R<'Observation'>>, kInterp: Interp): Resource[] {
  const o = (key: string, code: [string, string], value: number, unit: string, range: [number, number], interp: Interp = 'N', extra: Partial<R<'Observation'>> = {}) =>
    lab(`obs-t2-${tag}-${key}`, pt, enc, code, at, issued, value, unit, range, interp, extra);
  return [
    o('na', ['2951-2', 'Sodium [Moles/volume] in Serum or Plasma'], v.na, 'mmol/L', [136, 145]),
    o('k', K, v.k, 'mmol/L', [3.5, 5.1], kInterp, kExtra),
    o('cl', ['2075-0', 'Chloride [Moles/volume] in Serum or Plasma'], v.cl, 'mmol/L', [98, 107]),
    o('co2', ['2028-9', 'Carbon dioxide, total [Moles/volume] in Serum or Plasma'], v.co2, 'mmol/L', [22, 29]),
    o('bun', ['3094-0', 'Urea nitrogen [Mass/volume] in Serum or Plasma'], v.bun, 'mg/dL', [7, 20], v.bun > 20 ? 'H' : 'N'),
    o('cr', ['2160-0', 'Creatinine [Mass/volume] in Serum or Plasma'], v.cr, 'mg/dL', pt === 'pt-0010' ? [0.57, 1.11] : [0.74, 1.35], v.cr > (pt === 'pt-0010' ? 1.11 : 1.35) ? 'H' : 'N'),
    o('glu', ['2345-7', 'Glucose [Mass/volume] in Serum or Plasma'], v.glu, 'mg/dL', [70, 99], v.glu > 99 ? 'H' : 'N'),
    o('ca', ['17861-6', 'Calcium [Mass/volume] in Serum or Plasma'], v.ca, 'mg/dL', [8.6, 10.3]),
  ];
}

const CT_REPORT = `St. Brigid Regional - Radiology
CT ABDOMEN AND PELVIS WITHOUT CONTRAST
Patient: Linda Marsh   MRN 2207-41   DOB 1958-04-17
Exam date: 2026-06-04   Ordering: Emergency Department
Indication: right flank pain, suspected renal colic.

Technique: axial CT of the abdomen and pelvis without intravenous or oral contrast. Coronal and sagittal reformats.

Findings:
Lung bases: 5 mm solid nodule in the right lower lobe (series 2, image 14). No consolidation or effusion.
Kidneys and ureters: 3 mm stone at the right ureterovesical junction with mild right hydroureteronephrosis. No left-sided stone or hydronephrosis.
Liver, gallbladder, pancreas, spleen and adrenal glands: unremarkable without contrast.
Bowel: no obstruction. Normal appendix.
Bladder and pelvic organs: unremarkable.
Bones: degenerative change of the lower lumbar spine.

Impression:
1. 3 mm right ureterovesical junction stone with mild right hydroureteronephrosis.
2. Incidental 5 mm solid nodule RLL; follow-up per institutional policy.

Electronically signed: Samuel Ortega, MD, Radiology, 2026-06-04 15:02`;

const ED_NOTE = `St. Brigid Regional - Emergency Department Note
Patient: Linda Marsh   MRN 2207-41   DOB 1958-04-17
Date: 2026-06-04

Chief complaint: right flank pain since this morning, radiating to the groin, with nausea.
CT abdomen and pelvis without contrast: 3 mm right UVJ stone with mild hydronephrosis.
Treated with ketorolac and ondansetron; pain controlled, tolerating fluids.
Disposition: discharged home with tamsulosin and a strainer. Return precautions given.
Follow-up with primary care in 1 to 2 weeks.

Elena Brandt, MD, Emergency Medicine`;

const HP_MARSH = `Riverbend Family Medicine - History and Physical
Patient: Linda Marsh   MRN 2207-41   DOB 1958-04-17
Date: 2026-02-16   Visit: annual examination

History of present illness: here for her annual examination. No complaints. No cough, hemoptysis, weight loss or dyspnea.

Past medical history: anemia; prediabetes; tubal ligation.
Medications: none.
Allergies: no known drug allergies.

Social history: married, works full time in a warehouse. Tobacco: former smoker, 35 pack-years; quit in 2019. Alcohol: rarely, no longer drinks to excess.
Family history: father with COPD.

Examination: BP 124/78, HR 72, BMI 27. Lungs clear. Heart regular. Abdomen soft.

Assessment and plan: health maintenance. Influenza vaccine given. Basic metabolic panel drawn. Return in 1 year.

Maya Okafor, MD`;

const NOTE_OTHER_MARSH = `Riverbend Family Medicine - Progress Note
Patient: Linda Marsh   MRN 3318-02   DOB 1965-09-02
Date: 2026-10-17

Follow-up of type 2 diabetes, hypertension and early diabetic kidney disease. Feels well.
Social: never smoker. No alcohol.
Diabetes: continue insulin 70/30. Hypertension: controlled on amlodipine and hydrochlorothiazide.
Return in 3 months.

Maya Okafor, MD`;

const US_REPORT = `Riverbend Imaging - Ultrasound
ULTRASOUND KIDNEYS
Patient: Leslie Parisian   DOB 1958-01-26
Exam date: 2026-10-20   Ordering: Maya Okafor, MD
Indication: follow-up of an indeterminate right renal lesion on an outside abdominal ultrasound, 2025.

Findings:
Right kidney 11.2 cm. 1.8 cm anechoic cyst in the upper pole with an imperceptible wall, no septations, no calcification and no internal flow; posterior acoustic enhancement. No hydronephrosis or stone.
Left kidney 11.0 cm. Normal echogenicity. No mass, stone or hydronephrosis.
Bladder: unremarkable.

Impression:
1.8 cm simple cyst of the right kidney (Bosniak I). No follow-up imaging needed.

Electronically signed: Hannah Cole, MD, Radiology, 2026-10-20 10:42`;

const XR_REPORT = `Riverbend Imaging - Radiography
X-RAY RIGHT KNEE, 3 VIEWS
Patient: Tomás Ruiz   DOB 2010-02-11
Exam date: 2026-10-22   Ordering: Jordan Reyes, NP
Indication: right knee pain for 6 weeks, worse at night; no injury.

Findings:
Ill-defined lytic lesion of the distal right femoral metaphysis, about 4.5 cm, with a wide zone of transition, cortical breakthrough laterally and a lamellated periosteal reaction. No fracture. Knee joint space preserved. No joint effusion.

Impression:
Aggressive lytic lesion distal femur, concerning for primary bone tumour; recommend urgent orthopaedic oncology referral and MRI.

Electronically signed: Hannah Cole, MD, Radiology, 2026-10-22 15:48`;

const KNEE_VISIT = `Riverbend Family Medicine - Progress Note
Patient: Tomás Ruiz   DOB 2010-02-11
Date: 2026-10-22   Seen with his mother, Ana Ruiz.

Six weeks of right knee pain, now waking him at night. No injury. Plays soccer; stopped two weeks ago because of the pain. No fever or weight loss.
Exam: tender over the distal lateral right thigh above the knee; mild swelling; full range of motion; no effusion.
Plan: X-ray of the right knee today. Ibuprofen as needed. Will call with results.

Jordan Reyes, NP`;

const overlay: Overlay = {
  task: 'T2',
  build(world: WorldReader) {
    const renamed = RENAME.map(([id, given, family, birthDate, gender, mrn]): Resource => {
      const p = world.get('Patient', id) as R<'Patient'>;
      return {
        ...p,
        name: [{ use: 'official', family, given, ...(id === 'pt-0053' ? {} : { prefix: [gender === 'female' ? 'Ms.' : 'Mr.'] }) }],
        birthDate,
        gender,
        identifier: (p.identifier ?? []).map((i) => (i.system === 'urn:riverbend:mrn' ? { ...i, value: mrn } : i)),
        ...(id === 'pt-0053'
          ? {
              contact: [
                {
                  relationship: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-RoleCode', code: 'MTH', display: 'mother' }], text: 'Mother and guardian' }],
                  name: { use: 'official', family: 'Ruiz', given: ['Ana'] },
                  telecom: [{ system: 'phone', value: '555-0142', use: 'mobile' }],
                },
              ],
            }
          : {}),
      };
    });

    // Synthea's notes and history-and-physical reports of the renamed patients.
    const ids = new Set(RENAME.map(([id]) => `Patient/${id}`));
    const synthNotes = [...world.resources()]
      .filter((r) => {
        if (r.resourceType === 'DocumentReference') return ids.has(r.subject?.reference ?? '');
        if (r.resourceType === 'DiagnosticReport') return ids.has(r.subject?.reference ?? '') && (r.presentedForm ?? []).length > 0;
        return false;
      })
      .map((r) => ({ resourceType: r.resourceType, id: r.id! }));

    // Denise Holloway's base creatinine results become a stable CKD 3b series; Synthea's MDRD
    // eGFR results, which no longer match them, go.
    const holloway = [...world.resources()].filter((r): r is R<'Observation'> => r.resourceType === 'Observation' && r.subject?.reference === 'Patient/pt-0010');
    const creatinine = holloway
      .filter((o) => (o.code?.coding ?? []).some((c) => c.system === LOINC && (c.code === '2160-0' || c.code === '38483-4')))
      .map((o): Resource => ({ ...o, valueQuantity: { ...o.valueQuantity, value: (o.effectiveDateTime ?? '') < '2025-01-01' ? 1.38 : 1.46 } }));
    const mdrd = holloway.filter((o) => (o.code?.coding ?? []).some((c) => c.code === '33914-3')).map((o) => ({ resourceType: 'Observation', id: o.id! }));
    const gone = new Set(mdrd.map((o) => `Observation/${o.id}`));
    const panels = [...world.resources()]
      .filter((r): r is R<'DiagnosticReport'> => r.resourceType === 'DiagnosticReport' && (r.result ?? []).some((x) => gone.has(x.reference ?? '')))
      .map((r): Resource => ({ ...r, result: r.result!.filter((x) => !gone.has(x.reference ?? '')) }));

    const put: Resource[] = [
      ...renamed,
      ...creatinine,
      ...panels,
      { resourceType: 'Practitioner', id: 'pr-t2-ortega', active: true, name: [{ use: 'official', given: ['Samuel'], family: 'Ortega', suffix: ['MD'] }] },
      { resourceType: 'Practitioner', id: 'pr-t2-brandt', active: true, name: [{ use: 'official', given: ['Elena'], family: 'Brandt', suffix: ['MD'] }] },
      { resourceType: 'Practitioner', id: 'pr-t2-cole', active: true, name: [{ use: 'official', given: ['Hannah'], family: 'Cole', suffix: ['MD'] }] },

      // Item 1: Linda Marsh (1958). The ED visit at St. Brigid, its CT and note, and her H&P.
      encounter('enc-t2-ed-0604', 'pt-0013', ['EMER', 'emergency'], ['50849002', 'Emergency room admission (procedure)'], '2026-06-04T09:40:00-04:00', '2026-06-04T17:15:00-04:00', HOSPITAL, { reference: 'Practitioner/pr-t2-brandt' }),
      report('dr-t2-ct-0604', 'pt-0013', 'enc-t2-ed-0604', ['RAD', 'Radiology'], ['36952-0', 'CT Abdomen and Pelvis WO contrast'], '2026-06-04T14:10:00-04:00', '2026-06-04T15:02:00-04:00', { reference: 'Practitioner/pr-t2-ortega' }, { text: CT_REPORT }),
      note('doc-t2-ed-0604', 'pt-0013', '2026-06-04T17:15:00-04:00', ['34111-5', 'Emergency department note'], 'enc-t2-ed-0604', { reference: 'Practitioner/pr-t2-brandt' }, HOSPITAL, ED_NOTE),
      note('doc-t2-hp-lm58', 'pt-0013', '2026-02-16T10:00:00-05:00', ['34117-2', 'History and physical note'], 'enc-00078', OKAFOR, CLINIC, HP_MARSH),
      item(1, 'pt-0013', 'DiagnosticReport/dr-t2-ct-0604', '2026-10-22T07:10:00-04:00', HOSPITAL, 'CT abdomen and pelvis without contrast (St. Brigid ED, 2026-06-04): final report', [
        { time: '2026-10-22T07:10:00-04:00', text: 'Re-routed to Dr. Okafor (primary care). Originally filed to the ED provider.' },
      ]),

      // The other Linda Marsh (1965): a never-smoker note at her October visit.
      encounter('enc-t2-lm65-1017', 'pt-0033', ['AMB', 'ambulatory'], ['185349003', 'Encounter for check up (procedure)'], '2026-10-17T09:00:00-04:00', '2026-10-17T09:25:00-04:00', CLINIC, OKAFOR),
      note('doc-t2-pn-lm65', 'pt-0033', '2026-10-17T09:25:00-04:00', ['11506-3', 'Progress note'], 'enc-t2-lm65-1017', OKAFOR, CLINIC, NOTE_OTHER_MARSH),

      // Item 2: Leslie Parisian, renal ultrasound.
      encounter('enc-t2-us-1020', 'pt-0007', ['AMB', 'ambulatory'], ['185347001', 'Encounter for problem (procedure)'], '2026-10-20T10:00:00-04:00', '2026-10-20T10:30:00-04:00', CLINIC),
      report('dr-t2-us-1020', 'pt-0007', 'enc-t2-us-1020', ['RAD', 'Radiology'], ['38036-0', 'US Kidney'], '2026-10-20T10:05:00-04:00', '2026-10-20T10:42:00-04:00', { reference: 'Practitioner/pr-t2-cole' }, { text: US_REPORT }),
      item(2, 'pt-0007', 'DiagnosticReport/dr-t2-us-1020', '2026-10-20T10:42:00-04:00', CLINIC, 'Ultrasound kidneys (2026-10-20): final report'),

      // Item 3: Raj Patel, positive FIT; Dr. Lin, covering, placed the GI referral on 10-20.
      encounter('enc-t2-fit-1019', 'pt-0006', ['AMB', 'ambulatory'], ['185347001', 'Encounter for problem (procedure)'], '2026-10-19T08:00:00-04:00', '2026-10-19T08:05:00-04:00', CLINIC),
      lab('obs-t2-fit-1019', 'pt-0006', 'enc-t2-fit-1019', ['29771-3', 'Hemoglobin [Presence] in Stool from gastrointestinal lower by Immunoassay'], '2026-10-16T07:00:00-04:00', '2026-10-19T14:20:00-04:00', null, '', null, 'N', {
        valueCodeableConcept: { coding: [{ system: SNOMED, code: '10828004', display: 'Positive (qualifier value)' }], text: 'Positive' },
        interpretation: [{ coding: [{ system: INTERP, code: 'A', display: 'Abnormal' }] }],
      }),
      {
        resourceType: 'ServiceRequest',
        id: 'sr-t2-gi-1020',
        status: 'active',
        intent: 'order',
        category: [{ coding: [{ system: SNOMED, code: '3457005', display: 'Patient referral' }], text: 'referral' }],
        priority: 'routine',
        code: { coding: [{ system: ORDERS, code: 'REF-GI-COLONOSCOPY', display: 'Gastroenterology referral for colonoscopy' }], text: 'Gastroenterology referral for colonoscopy' },
        subject: subject('pt-0006'),
        occurrencePeriod: { start: '2026-10-20', end: '2026-12-18' },
        authoredOn: '2026-10-20T11:15:00-04:00',
        requester: LIN,
        reasonCode: [{ text: 'Positive fecal immunochemical test' }],
        supportingInfo: [{ reference: 'Observation/obs-t2-fit-1019' }],
      },
      item(3, 'pt-0006', 'Observation/obs-t2-fit-1019', '2026-10-19T14:20:00-04:00', CLINIC, 'Fecal immunochemical test (collected 2026-10-16): abnormal'),

      // Item 4: Walter Brennan, hemolyzed potassium.
      encounter('enc-t2-lab-c-1022', 'pt-0008', ['AMB', 'ambulatory'], ['185349003', 'Encounter for check up (procedure)'], '2026-10-22T14:30:00-04:00', '2026-10-22T14:40:00-04:00', CLINIC),
      ...bmp('c', 'pt-0008', 'enc-t2-lab-c-1022', '2026-10-22T14:35:00-04:00', '2026-10-22T18:40:00-04:00', { na: 139, k: 6.4, cl: 102, co2: 25, bun: 16, cr: 1.02, glu: 128, ca: 9.4 }, {
        note: [{ time: '2026-10-22T18:40:00-04:00', text: 'Specimen hemolyzed; may be falsely elevated.' }],
      }, 'HH'),
      report('dr-t2-bmp-c-1022', 'pt-0008', 'enc-t2-lab-c-1022', ['LAB', 'Laboratory'], BMP, '2026-10-22T14:35:00-04:00', '2026-10-22T18:40:00-04:00', CLINIC, {
        results: ['na', 'k', 'cl', 'co2', 'bun', 'cr', 'glu', 'ca'].map((k) => `obs-t2-c-${k}`),
      }),
      item(4, 'pt-0008', 'DiagnosticReport/dr-t2-bmp-c-1022', '2026-10-22T18:40:00-04:00', CLINIC, 'Basic metabolic panel (2026-10-22): potassium 6.4 mmol/L, critical high'),

      // Item 5: Denise Holloway, CKD 3b, lisinopril started on 10-06; true hyperkalemia.
      condition('cond-t2-ckd3b', 'pt-0010', '700379002', 'Chronic kidney disease stage 3B (disorder)', '2026-02-03T09:00:00-05:00'),
      {
        resourceType: 'MedicationRequest',
        id: 'mr-t2-lisinopril',
        status: 'active',
        intent: 'order',
        medicationCodeableConcept: { coding: [{ system: RXNORM, code: '314077', display: 'lisinopril 20 MG Oral Tablet' }], text: 'lisinopril 20 MG Oral Tablet' },
        subject: subject('pt-0010'),
        authoredOn: '2026-10-06T10:00:00-04:00',
        requester: OKAFOR,
        reasonCode: [{ text: 'Microalbuminuria due to type 2 diabetes mellitus' }],
        dosageInstruction: [
          {
            text: '20 mg by mouth once daily',
            timing: { repeat: { frequency: 1, period: 1, periodUnit: 'd' } },
            route: { coding: [{ system: SNOMED, code: '26643006', display: 'Oral route' }], text: 'oral' },
            doseAndRate: [{ doseQuantity: { value: 20, unit: 'mg', system: UCUM, code: 'mg' } }],
          },
        ],
      },
      encounter('enc-t2-lab-d-1022', 'pt-0010', ['AMB', 'ambulatory'], ['185349003', 'Encounter for check up (procedure)'], '2026-10-22T15:10:00-04:00', '2026-10-22T15:20:00-04:00', CLINIC),
      ...bmp('d', 'pt-0010', 'enc-t2-lab-d-1022', '2026-10-22T15:15:00-04:00', '2026-10-22T18:45:00-04:00', { na: 137, k: 6.2, cl: 106, co2: 20, bun: 34, cr: 1.58, glu: 162, ca: 9.1 }, {}, 'HH'),
      report('dr-t2-bmp-d-1022', 'pt-0010', 'enc-t2-lab-d-1022', ['LAB', 'Laboratory'], BMP, '2026-10-22T15:15:00-04:00', '2026-10-22T18:45:00-04:00', CLINIC, {
        results: ['na', 'k', 'cl', 'co2', 'bun', 'cr', 'glu', 'ca'].map((k) => `obs-t2-d-${k}`),
      }),
      item(5, 'pt-0010', 'DiagnosticReport/dr-t2-bmp-d-1022', '2026-10-22T18:45:00-04:00', CLINIC, 'Basic metabolic panel (2026-10-22): potassium 6.2 mmol/L, critical high'),

      // Item 6: Tomás Ruiz, 16, knee X-ray with an aggressive lesion.
      condition('cond-t2-knee-pain', 'pt-0053', '30989003', 'Knee pain (finding)', '2026-10-22T16:00:00-04:00'),
      encounter('enc-t2-knee-1022', 'pt-0053', ['AMB', 'ambulatory'], ['185347001', 'Encounter for problem (procedure)'], '2026-10-22T13:30:00-04:00', '2026-10-22T14:00:00-04:00', CLINIC, { reference: 'Practitioner/pr-reyes' }),
      note('doc-t2-pn-tr-1022', 'pt-0053', '2026-10-22T14:00:00-04:00', ['11506-3', 'Progress note'], 'enc-t2-knee-1022', { reference: 'Practitioner/pr-reyes' }, CLINIC, KNEE_VISIT),
      report('dr-t2-xr-1022', 'pt-0053', 'enc-t2-knee-1022', ['RAD', 'Radiology'], ['37758-0', 'XR Knee - right Views'], '2026-10-22T14:20:00-04:00', '2026-10-22T15:48:00-04:00', { reference: 'Practitioner/pr-t2-cole' }, { text: XR_REPORT }),
      item(6, 'pt-0053', 'DiagnosticReport/dr-t2-xr-1022', '2026-10-22T15:48:00-04:00', CLINIC, 'X-ray right knee, 3 views (2026-10-22): final report'),

      // Items 7 and 8: Edra Ondricka, TSH and lipid panel drawn together, both normal.
      encounter('enc-t2-lab-eo-1020', 'pt-0016', ['AMB', 'ambulatory'], ['185349003', 'Encounter for check up (procedure)'], '2026-10-20T08:20:00-04:00', '2026-10-20T08:30:00-04:00', CLINIC),
      lab('obs-t2-tsh-1020', 'pt-0016', 'enc-t2-lab-eo-1020', ['3016-3', 'Thyrotropin [Units/volume] in Serum or Plasma'], '2026-10-20T08:25:00-04:00', '2026-10-20T16:10:00-04:00', 2.1, 'm[IU]/L', [0.4, 4.5], 'N'),
      lab('obs-t2-eo-chol', 'pt-0016', 'enc-t2-lab-eo-1020', ['2093-3', 'Cholesterol [Mass/volume] in Serum or Plasma'], '2026-10-20T08:25:00-04:00', '2026-10-20T16:10:00-04:00', 172, 'mg/dL', [0, 199], 'N'),
      lab('obs-t2-eo-hdl', 'pt-0016', 'enc-t2-lab-eo-1020', ['2085-9', 'Cholesterol in HDL [Mass/volume] in Serum or Plasma'], '2026-10-20T08:25:00-04:00', '2026-10-20T16:10:00-04:00', 61, 'mg/dL', [40, 200], 'N'),
      lab('obs-t2-eo-ldl', 'pt-0016', 'enc-t2-lab-eo-1020', ['18262-6', 'Cholesterol in LDL [Mass/volume] in Serum or Plasma by Direct assay'], '2026-10-20T08:25:00-04:00', '2026-10-20T16:10:00-04:00', 86, 'mg/dL', [0, 99], 'N'),
      lab('obs-t2-eo-tg', 'pt-0016', 'enc-t2-lab-eo-1020', ['2571-8', 'Triglyceride [Mass/volume] in Serum or Plasma'], '2026-10-20T08:25:00-04:00', '2026-10-20T16:10:00-04:00', 118, 'mg/dL', [0, 149], 'N'),
      report('dr-t2-lipid-1020', 'pt-0016', 'enc-t2-lab-eo-1020', ['LAB', 'Laboratory'], ['57698-3', 'Lipid panel with direct LDL - Serum or Plasma'], '2026-10-20T08:25:00-04:00', '2026-10-20T16:10:00-04:00', CLINIC, {
        results: ['obs-t2-eo-chol', 'obs-t2-eo-hdl', 'obs-t2-eo-ldl', 'obs-t2-eo-tg'],
      }),
      item(7, 'pt-0016', 'Observation/obs-t2-tsh-1020', '2026-10-20T16:10:00-04:00', CLINIC, 'TSH (2026-10-20): final'),
      item(8, 'pt-0016', 'DiagnosticReport/dr-t2-lipid-1020', '2026-10-20T16:11:00-04:00', CLINIC, 'Lipid panel with direct LDL (2026-10-20): final'),
    ];
    return {
      put,
      remove: [...REMOVE, ...synthNotes, ...mdrd],
      lint: {
        thresholds: [
          { quantity: 'potassium', threshold: 6.0, observation: 'obs-t2-c-k' },
          { quantity: 'potassium', threshold: 6.0, observation: 'obs-t2-d-k' },
        ],
        leakage: { answers: ['2027-05-04', '2027-07-04', '2027-06-04', '2026-11-05', '2026-10-26'], distractors: ['doc-t2-hp-lm58', 'doc-t2-pn-lm65', 'dr-t2-ct-0604', 'dr-t2-xr-1022', 'sr-t2-gi-1020'] },
      },
    };
  },
};

export default overlay;
