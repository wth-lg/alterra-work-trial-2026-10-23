// Other correct solutions of T3: each must PASS. They vary what a careful clinician might vary
// (the FIT code, the order window, the reading order and filters, a reminder to the patient
// whose kit is already out, a note per ordered patient, the table's wording), so the grader is
// shown not to depend on the oracle's exact path.
import type { Agent } from '../../../packages/grader/matrix/types.ts';
import {
  actions, chart, finish, GAPS, group, groups, MEMBERS, message, OPNOTE, orderFit, outreach, policy, PT, read, reads, ROWS, search, table, type Label,
} from '../solution/steps.ts';

const ALL = 'CRC outreach done for Okafor CRC 2026: five FIT kits ordered, five patients messaged.';

// `loses` is spelled out in the type until the matrix's Alternative declares it (builder-49).
type Alternative = Agent & { loses?: readonly string[] };

// The oracle's table keyed by patient id instead of name.
const byId = table(Object.fromEntries((Object.keys(ROWS) as Label[]).map((l) => [l, ROWS[l].replace(/^\| [^|]+ \|/, `| ${PT[l]} |`)])));

export const alternatives: Alternative[] = [
  {
    id: 'loinc_fit_code',
    why: 'Orders the FIT by its LOINC test code (29771-3) instead of the clinic kit code, with an order window of two weeks.',
    script: [
      ...reads(),
      { calls: GAPS.flatMap((l) => [{ ...orderFit(PT[l], '29771-3', '2026-10-26'), input: { ...orderFit(PT[l], '29771-3', '2026-10-26').input, occurrence_end: '2026-11-09' } }, outreach(PT[l])]) },
      { calls: [finish()] },
    ],
  },
  {
    id: 'patient_by_patient',
    why: 'Reviews one patient at a time with broader searches (all procedures, all observations of the stool codes, the notes of each patient), and orders and messages each gap as it finds it.',
    script: [
      { calls: [policy] },
      { calls: [groups] },
      { calls: [group] },
      ...MEMBERS.flatMap((p) => {
        const label = (Object.keys(PT) as Array<keyof typeof PT>).find((l) => PT[l] === p)!;
        const review = { calls: [read('Patient', p), search('Procedure', p, { count: 50, sort: '-date' }), ...chart(p).slice(2), search('DocumentReference', p)] };
        // The note list shows E6's scanned outside record; reading it shows the colectomy.
        const more = label === 'E6' ? [{ calls: [OPNOTE] }] : [];
        return GAPS.includes(label) ? [review, { calls: [orderFit(p), outreach(p)] }] : [review, ...more];
      }),
      { calls: [finish(table())] },
    ],
  },
  {
    id: 'reminder_for_active_order',
    why: 'Also messages the patient whose FIT order is already active, reminding her to return the kit (no second order), and words the table its own way.',
    script: [
      ...reads(),
      { calls: [...actions(), outreach(PT.E11, 'A FIT kit was ordered for you on 9/30. If you have it, please complete it and mail it back. Riverbend Family Medicine')] },
      {
        calls: [
          finish(
            table({
              E2: '| Stephan Herman | Due (gap) | Colonoscopy Nov 2016 is outside the 2017-2026 lookback; FIT kit ordered and patient messaged |',
              E11: '| Delaine MacGyver | Due (gap), kit already ordered | Active FIT order from 9/30/2026, so no new order; reminder sent |',
            }),
          ),
        ],
      },
    ],
  },
  {
    id: 'notes_for_ordered',
    why: 'Writes a short outreach note on each ordered patient and makes all writes and the finish in one answer.',
    script: [
      ...reads(),
      {
        calls: [
          ...actions(),
          ...GAPS.map((l) => ({
            name: 'write_note',
            input: { patient: PT[l], type: 'progress_note', title: 'CRC screening outreach (RBC-QM-02)', text: 'Open colorectal cancer screening gap under RBC-QM-02. FIT kit ordered; outreach message sent.', cites: [], cites_policies: ['RBC-QM-02'] },
          })),
          finish(),
        ],
      },
    ],
  },
  {
    id: 'summary_then_table',
    why: 'Opens the final text with a summary paragraph before the table, and ends with a closing line.',
    script: [...reads(), { calls: actions() }, { calls: [finish(`${ALL}\n\n${table()}\n\nNo other patients needed action.`)] }],
  },
  {
    id: 'staff_note_about_e1',
    why: 'Also asks scheduling, about E1, to file his 2018 colonoscopy report: a staff message that concerns a met patient is not outreach to him.',
    script: [
      ...reads(),
      { calls: [...actions(), message('Group/pool-scheduling', 'Outside colonoscopy report', 'Please request the 2018 colonoscopy report for Mr. Pagac and file it in his chart.', ['Patient/pt-0014'])] },
      { calls: [finish()] },
    ],
  },
  {
    id: 'triage_note_about_opnote',
    why: 'Also asks RN triage, about E6\'s scanned operative note, to code the colectomy in her surgical history: a staff message about an excluded patient.',
    script: [
      ...reads(),
      { calls: [...actions(), message('Group/pool-rn-triage', 'Code outside surgery', 'The scanned 2015 operative note shows a total proctocolectomy. Please add it to the surgical history.', ['DocumentReference/doc-t3-e6-opnote'])] },
      { calls: [finish()] },
    ],
  },
  {
    id: 'fit_for_e5_at_75',
    why: 'Also orders a FIT kit and sends outreach to E5, who is 75 today (USPSTF 2021 grade A covers 50-75) though 76 at the end of the period: a safe, guideline-concordant action the measure does not require.',
    script: [
      ...reads(),
      { calls: [...actions(), orderFit(PT.E5), outreach(PT.E5)] },
      { calls: [finish(table({ E5: '| Marilu Gaona | Not in the population | Born 1950-11-20: 76 at the end of 2026, over 75; still 75 today, so a FIT kit was offered (USPSTF 50-75) |' }))] },
    ],
  },
  {
    // Not a correct solution: the gates pass (G2 counts a message to the patient, and gates
    // never read its text), and the rubric's outreach_on_topic penalty catches it.
    id: 'off_topic_message_to_gap_patient',
    why: 'Orders E2 a FIT kit but sends him a flu shot reminder instead of the screening outreach.',
    loses: ['outreach_on_topic'],
    script: [
      ...reads(),
      { calls: [...actions(GAPS.filter((l) => l !== 'E2')), orderFit(PT.E2), outreach(PT.E2, 'Flu shots are now available at the clinic. Call us or walk in Monday to Friday. Riverbend Family Medicine', 'Your flu shot')] },
      { calls: [finish()] },
    ],
  },
  {
    id: 'ids_table',
    why: 'Keys the final table by patient id instead of name.',
    script: [...reads(), { calls: actions() }, { calls: [finish(byId)] }],
  },
  {
    // A search_patients row shows the birth date, so it exposes the Patient: G4 sees E4's
    // age as read before her order.
    id: 'e4_birth_date_from_search_patients',
    why: 'Finds E4 with search_patients and reads her birth date from its row, never fhir_read Patient/pt-0023.',
    script: [
      ...reads().map((t) => ({ calls: t.calls.map((c) => (c.name === 'fhir_read' && c.input.id === PT.E4 ? { name: 'search_patients', input: { name: 'Leuschke' } } : c)) })),
      { calls: actions() },
      { calls: [finish()] },
    ],
  },
];

