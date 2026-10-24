// Other correct solutions of T3: each must PASS. They vary what a careful clinician might vary
// (the FIT code, the order window, the reading order and filters, a reminder to the patient
// whose kit is already out, a note per ordered patient, the table's wording), so the grader is
// shown not to depend on the oracle's exact path.
import type { Agent } from '../../../packages/grader/matrix/types.ts';
import {
  actions, chart, finish, GAPS, group, groups, MEMBERS, notes, orderFit, outreach, policy, PT, read, reads, search, table,
} from '../solution/steps.ts';

const ALL = 'CRC outreach done for Okafor CRC 2026: five FIT kits ordered, five patients messaged.';

export const alternatives: Agent[] = [
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
        const review = { calls: [read('Patient', p), search('Procedure', p, { count: 50, sort: '-date' }), ...chart(p).slice(2), notes('colectomy', p)] };
        return GAPS.includes(label) ? [review, { calls: [orderFit(p), outreach(p)] }] : [review];
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
];
