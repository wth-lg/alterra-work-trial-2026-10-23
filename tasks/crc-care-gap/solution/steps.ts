// The tool calls T3's scripts are made of: the oracle (solve.ts) and the matrix's alternatives,
// mutants and agents (tests/). Each case varies only what its clinician would vary, so they
// share these calls and the final table's wording.
import type { ScriptCall, ScriptTurn } from '../../../packages/grader/matrix/types.ts';

// The panel by design label (design section 4, "T3" panel table).
export const PT = {
  E1: 'pt-0014', E2: 'pt-0017', E3: 'pt-0018', E4: 'pt-0023', E5: 'pt-0011', E6: 'pt-0021',
  E7: 'pt-0009', E8: 'pt-0019', E9: 'pt-0020', E10: 'pt-0022', E11: 'pt-0024', E12: 'pt-0025',
} as const;
export type Label = keyof typeof PT;
export const MEMBERS = Object.values(PT);
export const GAPS: Label[] = ['E2', 'E3', 'E4', 'E8', 'E10'];

// The screening procedures and stool tests RBC-QM-02 §3 counts, and total colectomy.
export const PROCEDURE_CODES = '73761001,44441009,418714002,26390003';
export const STOOL_CODES = '2335-8,29771-3,57905-2,58453-2,77354-9,77353-1';

export const policy: ScriptCall = { name: 'read_policy', input: { policy_id: 'RBC-QM-02' } };
export const groups: ScriptCall = { name: 'fhir_search', input: { resource_type: 'Group' } };
export const group: ScriptCall = { name: 'fhir_read', input: { resource_type: 'Group', id: 'grp-t3-okafor-crc' } };
export const read = (resource_type: string, id: string): ScriptCall => ({ name: 'fhir_read', input: { resource_type, id } });
export const search = (resource_type: string, patient: string, more: { [k: string]: string | number } = {}): ScriptCall => ({ name: 'fhir_search', input: { resource_type, patient, ...more } });
export const notes = (query: string, patient?: string): ScriptCall => ({ name: 'search_notes', input: { query, ...(patient ? { patient } : {}) } });

// The notes step: search_notes matches literal words, so a reviewer looking for colon surgery
// searches the words a note would use. The operative note's row ('…Service: Colorectal
// Surgery…') only references it; reading it shows the total proctocolectomy.
export const NOTE_SEARCH = notes('colectomy colon colorectal');
export const OPNOTE = read('DocumentReference', 'doc-t3-e6-opnote');

// One patient's chart review: the Patient and everything §3 and §4 read.
export const chart = (p: string): ScriptCall[] => [
  read('Patient', p),
  search('Procedure', p, { code: PROCEDURE_CODES }),
  search('Observation', p, { code: STOOL_CODES }),
  search('Condition', p, { count: 50 }),
  search('MedicationRequest', p, { status: 'active' }),
  search('EpisodeOfCare', p),
  search('ServiceRequest', p, { status: 'active' }),
];

// The reads, one turn per kind across the panel, as a careful reviewer batches them.
export const reads = (patients: readonly string[] = MEMBERS): ScriptTurn[] => [
  { calls: [policy, groups] },
  { calls: [group] },
  ...[0, 1, 2, 3, 4, 5, 6].map((i) => ({ calls: patients.map((p) => chart(p)[i]!) })),
  { calls: [NOTE_SEARCH] },
  { calls: [OPNOTE] },
];

export const FIT = 'LAB-FIT-KIT';
export const orderFit = (p: string, code: string = FIT, occurrence_start = '2026-10-26'): ScriptCall => ({
  name: 'order_service',
  input: { patient: p, code, priority: 'routine', occurrence_start, reason: 'RBC-QM-02 §5: open colorectal cancer screening gap; FIT kit by mail' },
});
export const OUTREACH =
  'Our records show you are due for colorectal cancer screening. We are mailing you a FIT kit, a simple stool test you do at home. ' +
  'Please complete it and mail it back in the prepaid envelope. Call the clinic with any questions. Riverbend Family Medicine';
export const outreach = (p: string, body: string = OUTREACH, subject = 'Colorectal cancer screening: FIT kit on its way'): ScriptCall => ({
  name: 'send_message',
  input: { recipient: `Patient/${p}`, priority: 'routine', subject, body, about: [] },
});
// A message to a staff pool or the panel group, about the resources in `about`.
export const message = (recipient: string, subject: string, body: string, about: string[] = []): ScriptCall => ({
  name: 'send_message',
  input: { recipient, priority: 'routine', subject, body, about },
});
export const actions = (labels: readonly Label[] = GAPS): ScriptCall[] => labels.flatMap((l) => [orderFit(PT[l]), outreach(PT[l])]);

// The final table's rows; a case overrides the ones its clinician writes differently.
export const ROWS: Record<Label, string> = {
  E1: '| Santo Pagac | Screening up to date | Colonoscopy 2018-05-21, within the measurement period or the 9 years before it (2017-2026) |',
  E2: '| Stephan Herman | Open gap: FIT kit ordered, outreach sent | Last colonoscopy 2016-11-15, before the 2017-2026 window |',
  E3: '| Lance Muller | Open gap: FIT kit ordered, outreach sent | sDNA-FIT 2023-11-20, before the 2024-2026 window |',
  E4: '| Burma Leuschke | Open gap: FIT kit ordered, outreach sent | Born 1980-12-15: 46 at the end of 2026, in the population; no screening on record |',
  E5: '| Marilu Gaona | Not in the population | Born 1950-11-20: 76 at the end of 2026, over 75 |',
  E6: '| Ángela Vigil | Excluded | Total proctocolectomy (outside operative note, 2015) |',
  E7: '| Elly Trantow | Excluded | Age 72 with frailty and a dementia medication (donepezil): advanced illness |',
  E8: "| Harrison O'Keefe | Open gap: FIT kit ordered, outreach sent | Age 69 with frailty but no advanced illness or dementia medication, so not excluded; no screening on record |",
  E9: '| Kelsie Rohan | Excluded | In hospice care since 2026-08-20 |',
  E10: '| Tiny Koss | Open gap: FIT kit ordered, outreach sent | FIT 2025-12-03 was in 2025; a FIT counts only in the measurement period |',
  E11: '| Delaine MacGyver | Open gap, no new order | FIT order already active since 2026-09-30; FOBT 2024-06-11 does not count |',
  E12: '| Danika Ullrich | Screening up to date | CT colonography 2022-03-08, within the measurement period or the 4 years before it (2022-2026) |',
};
export const table = (rows: Partial<Record<Label, string>> = {}): string =>
  ['CRC outreach for Okafor CRC 2026 under RBC-QM-02: 5 FIT kits ordered and 5 outreach messages sent.', '', '| Patient | Status | Reason |', '|---|---|---|',
    ...(Object.keys(ROWS) as Label[]).map((l) => rows[l] ?? ROWS[l])].join('\n');

export const finish = (summary: string = table()): ScriptCall => ({ name: 'finish', input: { summary } });
