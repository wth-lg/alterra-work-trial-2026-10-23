// The tool calls T5's scripts are made of: the oracle (solve.ts) and the matrix's alternatives,
// mutants and agents (tests/). Each case varies only what its clinician would vary, so they
// share these calls and the wording of the note and the patient's message.
import type { ScriptCall } from '../../../packages/grader/matrix/types.ts';

export const PT = 'pt-0015';
export const APPT = 'Appointment/appt-t5-1026';
export const ALLERGY = 'AllergyIntolerance/alg-t5-iohexol';
export const REACTION_NOTE = 'DocumentReference/doc-t5-ct-2019';
export const SCAN = '2026-10-26T09:00:00-04:00';
export const RX = {
  prednisone50: '198148',
  prednisone20: '312615',
  prednisone10: '198145',
  diphenhydramine25: '1049909',
  diphenhydramine50: '1020477',
  hydrocortisone100: '238755',
} as const;
export const CODE = { ctContrast: 'IMG-CT-AP-WC', ctPlain: 'IMG-CT-AP-WO', creatinine: '2160-0', bmp: '24321-2', cmp: '24323-8' } as const;
// RBC-RAD-07 §2, counted back from 09:00 Monday.
export const AT = { p13: '2026-10-25T20:00:00-04:00', p7: '2026-10-26T02:00:00-04:00', p1: '2026-10-26T08:00:00-04:00' } as const;

export const findPatient: ScriptCall = { name: 'search_patients', input: { name: 'Daniel Ferreira' } };
export const appointments: ScriptCall = { name: 'fhir_search', input: { resource_type: 'Appointment', patient: PT } };
export const allergies: ScriptCall = { name: 'fhir_search', input: { resource_type: 'AllergyIntolerance', patient: PT } };
export const searchReaction: ScriptCall = { name: 'search_notes', input: { query: 'iohexol', patient: PT } };
export const read = (resource_type: string, id: string): ScriptCall => ({ name: 'fhir_read', input: { resource_type, id } });
export const readReaction = read('DocumentReference', 'doc-t5-ct-2019');
export const creatinines: ScriptCall = { name: 'fhir_search', input: { resource_type: 'Observation', patient: PT, code: '2160-0', sort: '-date' } };
export const policy: ScriptCall = { name: 'read_policy', input: { policy_id: 'RBC-RAD-07' } };
export const calc = (expression: string): ScriptCall => ({ name: 'calculate', input: { expression } });
export const timesCalc = calc('9 + 24 - 13');
export const oldOrders: ScriptCall = { name: 'fhir_search', input: { resource_type: 'MedicationRequest', patient: PT } };

// The orders' reads and the evidence the gates ask for, in the reference solution's order.
export const READS = [
  { calls: [findPatient] },
  { calls: [appointments, allergies, searchReaction] },
  { calls: [readReaction] },
  { calls: [creatinines, policy] },
  { calls: [timesCalc] },
];

const REASON = 'RBC-RAD-07 §2: premedication for a prior moderate allergic-like reaction to iohexol (2019)';

type ServiceInput = { code?: string; start?: string; end?: string; supporting?: string[]; reason?: string; priority?: string };
export const service = (s: ServiceInput): ScriptCall => ({
  name: 'order_service',
  input: {
    patient: PT,
    code: s.code ?? CODE.ctContrast,
    priority: s.priority ?? 'routine',
    occurrence_start: s.start ?? SCAN,
    ...(s.end ? { occurrence_end: s.end } : {}),
    reason: s.reason ?? 'Surveillance of the 1.3 cm pancreatic body cyst (CT 06/2023); appointment Monday 10/26 at 09:00',
    ...(s.supporting ? { supporting: s.supporting } : {}),
  },
});
export const ct = (supporting: string[] = [APPT, ALLERGY, REACTION_NOTE], start: string = SCAN, end?: string): ScriptCall => service({ supporting, start, ...(end ? { end } : {}) });
// end null: a single date or time, no window.
export const creatinineOrder = (start = '2026-10-23', end: string | null = '2026-10-24', code: string = CODE.creatinine): ScriptCall =>
  service({ code, start, ...(end !== null ? { end } : {}), reason: 'RBC-RAD-07 §4: age 64 with type 2 diabetes; last creatinine 08/14/2025. Draw before the contrast CT on 10/26.' });

export const medication = (rxnorm_code: string, dose_value: number, timing_events: string[], dose_unit = 'mg', route = 'oral', reason = REASON): ScriptCall => ({
  name: 'order_medication',
  input: { patient: PT, rxnorm_code, dose_value, dose_unit, route, timing_events, reason },
});
export const prednisone = medication(RX.prednisone50, 50, [AT.p13, AT.p7, AT.p1]);
export const diphenhydramine = medication(RX.diphenhydramine50, 50, [AT.p1]);

export const ORACLE_MESSAGE =
  'Your CT scan of the abdomen and pelvis with IV contrast is on Monday 10/26 at 9:00 AM at St. Brigid Imaging (please arrive at 8:45 AM).\n\n' +
  'Because you had hives after contrast dye in 2019, please take these medicines before the scan to lower the chance of another reaction:\n' +
  '- Prednisone 50 mg by mouth at 8:00 PM on Sunday 10/25.\n' +
  '- Prednisone 50 mg by mouth at 2:00 AM on Monday 10/26 (please set an alarm).\n' +
  '- Prednisone 50 mg and diphenhydramine (Benadryl) 50 mg by mouth at 8:00 AM on Monday 10/26.\n\n' +
  'Diphenhydramine makes you drowsy. Do not drive after taking it: please have someone drive you to the scan and home.\n\n' +
  'Please also have a creatinine blood test (a kidney check) at the lab today or tomorrow, before the scan. No fasting is needed.';
export const message = (body: string = ORACLE_MESSAGE): ScriptCall => ({
  name: 'send_message',
  input: { recipient: `Patient/${PT}`, priority: 'routine', subject: 'Instructions for your CT scan on Monday 10/26', body, about: [APPT] },
});

// The note's paragraphs; a case overrides the ones its clinician writes differently.
export interface NoteFacts {
  allergies: string;
  premedication: string;
  kidney: string;
  orders: string;
}
export const ORACLE_NOTE: NoteFacts = {
  allergies:
    'Allergies (§1): moderate allergic-like reaction to iohexol on 05/14/2019 (diffuse hives over the trunk and limbs with mild eyelid swelling about 5 minutes after the injection, no breathing problems, resolved with diphenhydramine; radiology report of that day). ' +
    'That is the risk factor. The shellfish (rash) and povidone-iodine (contact dermatitis) allergies are not risk factors for a contrast reaction and do not change the plan.',
  premedication:
    'Premedication (§2): prednisone 50 mg by mouth at 8:00 PM on 10/25, 2:00 AM on 10/26 and 8:00 AM on 10/26 (13, 7 and 1 hours before the scan), and diphenhydramine 50 mg by mouth at 8:00 AM on 10/26. ' +
    'The 2023 premedication was timed for a 2:00 PM scan and was not reused. He was told not to drive after diphenhydramine and to bring a driver.',
  kidney: 'Kidney function (§4): age 64 with type 2 diabetes. Last creatinine 0.98 mg/dL on 08/14/2025, more than 30 days before the scan: creatinine ordered for 10/23-10/24, before the scan.',
  orders: 'Orders: CT abdomen and pelvis with IV contrast for the 10/26 09:00 appointment, linked to it and citing the iohexol allergy and the 2019 report. Instructions sent to the patient.',
};
export const noteText = (f: NoteFacts): string =>
  ['Contrast CT preparation under RBC-RAD-07: CT abdomen and pelvis with IV contrast, Monday 10/26/2026 at 09:00, for surveillance of the pancreatic body cyst.', f.allergies, f.premedication, f.kidney, f.orders].join('\n\n');
export const CITES = [ALLERGY, REACTION_NOTE, 'Observation/obs-t5-scr-0814', APPT];
export const note = (f: Partial<NoteFacts> = {}, cites: string[] = CITES): ScriptCall => ({
  name: 'write_note',
  input: { patient: PT, type: 'progress_note', title: 'Contrast CT preparation (RBC-RAD-07)', text: noteText({ ...ORACLE_NOTE, ...f }), cites, cites_policies: ['RBC-RAD-07'] },
});

export const finish = (summary: string): ScriptCall => ({ name: 'finish', input: { summary } });
export const DONE =
  'Placed the CT abdomen and pelvis with IV contrast for Daniel Ferreira on Monday 10/26 at 09:00, linked to the appointment; prednisone 50 mg at 20:00 Sunday, 02:00 and 08:00 Monday and diphenhydramine 50 mg at 08:00 Monday for his 2019 iohexol reaction; creatinine before the scan; instructions sent; note written.';
