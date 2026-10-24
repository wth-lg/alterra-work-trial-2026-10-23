// T3 crc-care-gap overlay (design section 4, "T3"): the panel group 'Okafor CRC 2026' over the
// twelve slots, each keeping its Synthea chart. The overlay adds the group, each case's
// screening history and exclusion facts, and moves four birth dates so the ages fit the design
// (E4 45 and E5 75 today, E7 72, E8 69 at the end of 2026). It removes what would change a
// patient's answer or contradict the story: every Synthea colonoscopy on the slots (they would
// make the gap patients met), Synthea's notes and note reports (they name the old ages and
// histories), the 'MD' suffix on E5's name, and two conditions dated before the moved birth
// dates allow (pt-0023's 'received higher education' at 12, pt-0019's adolescent scoliosis at
// 27).
//
// Traps (design panel table): proc-t3-e2-colonoscopy (2016) and obs-t3-e3-sdna (2023) fall just
// before their calendar-year windows; obs-t3-e10-fit is a 2025 FIT; pt-0023 and pt-0011 sit
// either side of the age range at the end of 2026 but not today; doc-t3-e6-opnote is the only
// record of E6's total colectomy; mr-t3-e7-donepezil with cond-t3-e7-frailty excludes E7, while
// cond-t3-e8-frailty alone does not exclude E8; sr-t3-e11-fit is the FIT order already active.
import type { Resource } from '../../packages/env/store.ts';
import type { Overlay, WorldReader } from '../../packages/env/overlay.ts';

const SLOTS = ['pt-0009', 'pt-0011', 'pt-0014', 'pt-0017', 'pt-0018', 'pt-0019', 'pt-0020', 'pt-0021', 'pt-0022', 'pt-0023', 'pt-0024', 'pt-0025'];
const E = { E1: 'pt-0014', E2: 'pt-0017', E3: 'pt-0018', E4: 'pt-0023', E5: 'pt-0011', E6: 'pt-0021', E7: 'pt-0009', E8: 'pt-0019', E9: 'pt-0020', E10: 'pt-0022', E11: 'pt-0024', E12: 'pt-0025' } as const;
const OKAFOR = { reference: 'Practitioner/pr-okafor' };
const CLINIC = { reference: 'Organization/org-riverbend' };
const HOSPITAL = { reference: 'Organization/org-st-brigid' };
const subject = (pt: string) => ({ reference: `Patient/${pt}` });

const LOINC = 'http://loinc.org';
const SNOMED = 'http://snomed.info/sct';
const RXNORM = 'http://www.nlm.nih.gov/research/umls/rxnorm';
const UCUM = 'http://unitsofmeasure.org';
const COLONOSCOPY = '73761001';

// Birth dates the design's ages need (age today and at the end of 2026).
const BIRTH: Record<string, string> = { [E.E4]: '1980-12-15', [E.E5]: '1950-11-20', [E.E7]: '1954-05-10', [E.E8]: '1957-10-28' };
// Conditions dated before the moved birth date allows.
const REMOVE_CONDITIONS = ['cond-00518', 'cond-00437'];

const SURGEON: Resource = { resourceType: 'Practitioner', id: 'pr-t3-adeyemi', active: true, name: [{ use: 'official', given: ['Tolu'], family: 'Adeyemi', suffix: ['MD'] }] };

const group: Resource = {
  resourceType: 'Group',
  id: 'grp-t3-okafor-crc',
  active: true,
  type: 'person',
  actual: true,
  code: { text: 'Quality worklist: colorectal cancer screening, 2026' },
  name: 'Okafor CRC 2026',
  managingEntity: OKAFOR,
  quantity: SLOTS.length,
  member: SLOTS.map((pt) => ({ entity: subject(pt), period: { start: '2026-01-02' } })),
};

const procedure = (id: string, pt: string, code: [string, string], at: string): Resource => ({
  resourceType: 'Procedure',
  id,
  status: 'completed',
  code: { coding: [{ system: SNOMED, code: code[0], display: code[1] }], text: code[1] },
  subject: subject(pt),
  performedDateTime: at,
  performer: [{ actor: HOSPITAL }],
});

const NEGATIVE = { coding: [{ system: SNOMED, code: '260385009', display: 'Negative' }], text: 'Negative' };
const stoolTest = (id: string, pt: string, code: [string, string], at: string, issued: string): Resource => ({
  resourceType: 'Observation',
  id,
  status: 'final',
  category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'laboratory', display: 'Laboratory' }] }],
  code: { coding: [{ system: LOINC, code: code[0], display: code[1] }], text: code[1] },
  subject: subject(pt),
  effectiveDateTime: at,
  issued,
  performer: [CLINIC],
  valueCodeableConcept: NEGATIVE,
});

const condition = (id: string, pt: string, code: [string, string], onset: string, category: 'problem-list-item' | 'encounter-diagnosis' = 'problem-list-item'): Resource => ({
  resourceType: 'Condition',
  id,
  clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }] },
  verificationStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status', code: 'confirmed' }] },
  category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-category', code: category }] }],
  code: { coding: [{ system: SNOMED, code: code[0], display: code[1] }], text: code[1] },
  subject: subject(pt),
  onsetDateTime: onset,
  recordedDate: onset,
  recorder: OKAFOR,
});

function base64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

// E6's outside operative note, scanned into the chart: its text is what the scan's OCR gives.
const OPERATIVE_NOTE = `[Scanned outside record - received 2015-07-14 - text from scan]

St. Brigid Regional - Operative Report
Patient: Angela A. Vigil   DOB 09/24/1974
Date of surgery: 06/03/2015
Surgeon: Tolu Adeyemi, MD   Service: Colorectal Surgery

Preoperative diagnosis: ulcerative pancolitis, refractory to medical therapy.
Postoperative diagnosis: same.
Procedure: total proctocolectomy with end ileostomy (laparoscopic-assisted).

Findings: diffuse colitis from cecum to rectum. Entire colon and rectum removed.
Specimen: colon and rectum, to pathology; no dysplasia on frozen section.
Estimated blood loss 150 mL. No complications.

Disposition: to recovery in stable condition.
Tolu Adeyemi, MD`;

const opNote: Resource = {
  resourceType: 'DocumentReference',
  id: 'doc-t3-e6-opnote',
  meta: { tag: [{ system: 'urn:riverbend:provenance', code: 'synthetic', display: 'Hand-written synthetic note' }] },
  status: 'current',
  docStatus: 'final',
  type: { coding: [{ system: LOINC, code: '11504-8', display: 'Surgical operation note' }], text: 'Surgical operation note' },
  category: [{ coding: [{ system: 'http://hl7.org/fhir/us/core/CodeSystem/us-core-documentreference-category', code: 'clinical-note', display: 'Clinical Note' }] }],
  subject: subject(E.E6),
  date: '2015-06-03T16:20:00-04:00',
  author: [{ reference: 'Practitioner/pr-t3-adeyemi' }],
  custodian: HOSPITAL,
  description: 'Scanned outside record',
  content: [{ attachment: { contentType: 'text/plain; charset=utf-8', data: base64(OPERATIVE_NOTE), title: 'Outside operative report (scanned)' } }],
};

const donepezil: Resource = {
  resourceType: 'MedicationRequest',
  id: 'mr-t3-e7-donepezil',
  status: 'active',
  intent: 'order',
  category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/medicationrequest-category', code: 'community', display: 'Community' }], text: 'Community' }],
  medicationCodeableConcept: { coding: [{ system: RXNORM, code: '997223', display: 'donepezil hydrochloride 10 MG Oral Tablet' }], text: 'donepezil hydrochloride 10 MG Oral Tablet' },
  subject: subject(E.E7),
  authoredOn: '2025-06-10T10:00:00-04:00',
  requester: OKAFOR,
  reasonCode: [{ text: 'Cognitive decline' }],
  dosageInstruction: [
    {
      text: '10 mg by mouth at bedtime',
      timing: { code: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation', code: 'BED' }], text: 'at bedtime' }, repeat: { frequency: 1, period: 1, periodUnit: 'd', when: ['HS'] } },
      route: { coding: [{ system: SNOMED, code: '26643006', display: 'Oral route' }], text: 'oral' },
      doseAndRate: [{ doseQuantity: { value: 10, unit: 'mg', system: UCUM, code: 'mg' } }],
    },
  ],
  dispenseRequest: { numberOfRepeatsAllowed: 3, expectedSupplyDuration: { value: 90, unit: 'days', system: UCUM, code: 'd' } },
};

const hospice: Resource = {
  resourceType: 'EpisodeOfCare',
  id: 'eoc-t3-e9-hospice',
  status: 'active',
  type: [{ coding: [{ system: SNOMED, code: '385763009', display: 'Hospice care' }], text: 'Hospice care' }],
  diagnosis: [{ condition: { reference: 'Condition/cond-t3-e9-pancreas' }, rank: 1 }],
  patient: subject(E.E9),
  managingOrganization: HOSPITAL,
  period: { start: '2026-08-20' },
  careManager: OKAFOR,
};

const activeFit: Resource = {
  resourceType: 'ServiceRequest',
  id: 'sr-t3-e11-fit',
  status: 'active',
  intent: 'order',
  category: [{ coding: [{ system: SNOMED, code: '108252007', display: 'Laboratory procedure' }], text: 'lab' }],
  priority: 'routine',
  code: { coding: [{ system: 'urn:riverbend:orders', code: 'LAB-FIT-KIT', display: 'FIT kit, mailed (fecal immunochemical test for colorectal cancer screening)' }], text: 'FIT kit, mailed (fecal immunochemical test for colorectal cancer screening)' },
  subject: subject(E.E11),
  occurrencePeriod: { start: '2026-09-30', end: '2026-11-30' },
  authoredOn: '2026-09-30T10:15:00-04:00',
  requester: OKAFOR,
  reasonCode: [{ text: 'Colorectal cancer screening' }],
};

const overlay: Overlay = {
  task: 'T3',
  build(world: WorldReader) {
    const ofSlots = (type: string) => SLOTS.flatMap((pt) => world.search(type, { patient: pt }).resources);
    const remove = [
      ...ofSlots('DocumentReference'),
      ...ofSlots('DiagnosticReport').filter((r) => r.resourceType === 'DiagnosticReport' && (r.presentedForm ?? []).length > 0),
      ...ofSlots('Procedure').filter((r) => r.resourceType === 'Procedure' && (r.code?.coding ?? []).some((c) => c.system === SNOMED && c.code === COLONOSCOPY)),
      ...REMOVE_CONDITIONS.map((id) => world.get('Condition', id)!),
    ].map((r) => ({ resourceType: r.resourceType, id: r.id! }));

    const patients = Object.entries(BIRTH).map(([pt, birthDate]): Resource => {
      const p = world.get('Patient', pt) as Extract<Resource, { resourceType: 'Patient' }>;
      return { ...p, birthDate, name: (p.name ?? []).map(({ suffix: _suffix, ...n }) => n) };
    });

    const put: Resource[] = [
      ...patients,
      SURGEON,
      group,
      procedure('proc-t3-e1-colonoscopy', E.E1, [COLONOSCOPY, 'Colonoscopy'], '2018-05-21T09:30:00-04:00'),
      procedure('proc-t3-e2-colonoscopy', E.E2, [COLONOSCOPY, 'Colonoscopy'], '2016-11-15T08:45:00-05:00'),
      stoolTest('obs-t3-e3-sdna', E.E3, ['77354-9', 'Noninvasive colorectal cancer DNA and occult blood screening [Presence] in Stool'], '2023-11-20T09:00:00-05:00', '2023-11-29T14:10:00-05:00'),
      opNote,
      condition('cond-t3-e7-frailty', E.E7, ['248279007', 'Frailty'], '2025-09-16T10:00:00-04:00'),
      donepezil,
      condition('cond-t3-e8-frailty', E.E8, ['248279007', 'Frailty'], '2026-03-04T10:00:00-05:00'),
      condition('cond-t3-e9-pancreas', E.E9, ['363418001', 'Malignant neoplasm of pancreas'], '2026-05-12T10:00:00-04:00'),
      hospice,
      stoolTest('obs-t3-e10-fit', E.E10, ['29771-3', 'Hemoglobin [Presence] in Stool from gastrointestinal lower by Immunoassay'], '2025-12-03T08:00:00-05:00', '2025-12-05T11:30:00-05:00'),
      stoolTest('obs-t3-e11-fobt', E.E11, ['2335-8', 'Hemoglobin [Presence] in Stool from gastrointestinal'], '2024-06-11T08:00:00-04:00', '2024-06-13T10:45:00-04:00'),
      activeFit,
      procedure('proc-t3-e12-ctc', E.E12, ['418714002', 'Virtual CT colonoscopy'], '2022-03-08T10:00:00-05:00'),
    ];
    return {
      put,
      remove,
      lint: {
        // Age today against the thresholds, for the members whose age is not the trap. E4 and
        // E5 are the age traps: their thresholds apply at the end of the measurement period,
        // which this rule does not model, so they are not declared.
        ages: [
          ...[E.E1, E.E2, E.E3, E.E6, E.E9, E.E10, E.E11, E.E12].map((patient) => ({ patient, threshold: 46 })),
          ...[E.E7, E.E8].map((patient) => ({ patient, threshold: 66 })),
        ],
        windows: [
          { name: 'colonoscopy 2017-2026', boundary: '2017-01-01', resources: ['proc-t3-e1-colonoscopy', 'proc-t3-e2-colonoscopy'], traps: { 'proc-t3-e2-colonoscopy': 'colonoscopy_ten_years' } },
          { name: 'sDNA-FIT 2024-2026', boundary: '2024-01-01', resources: ['obs-t3-e3-sdna'], traps: { 'obs-t3-e3-sdna': 'sdna_calendar_year' } },
          { name: 'FOBT 2026', boundary: '2026-01-01', resources: ['obs-t3-e10-fit', 'obs-t3-e11-fobt'], traps: { 'obs-t3-e10-fit': 'prior_year_fit' } },
          { name: 'CT colonography 2022-2026', boundary: '2022-01-01', resources: ['proc-t3-e12-ctc'] },
        ],
      },
    };
  },
};

export default overlay;
