// Near misses of T5, one trap each (task.toml [matrix] traps; design "Other traps" and prior):
// each must FAIL on exactly the gates it declares and lose exactly the rubric items in `loses`
// (a positive item not met, a penalty met).
import type { Mutant } from '../../../packages/grader/matrix/types.ts';
import {
  ALLERGY, allergies, APPT, appointments, AT, CODE, creatinineOrder, ct, diphenhydramine, DONE, findPatient, finish, medication, message, note, ORACLE_MESSAGE, policy, prednisone, READS, REACTION_NOTE, RX, service,
} from '../solution/steps.ts';

const orders = [ct(), creatinineOrder()];
const done = (s: string) => finish(`Daniel Ferreira's contrast CT for Monday 10/26 09:00: ${s}`);

// `loses` is required by the matrix from wth-lg/p11-matrix-loses on; the intersection keeps it
// typed until this branch is rebased onto that.
export const mutants: Array<Mutant & { loses: readonly string[] }> = [
  {
    id: 'iodine_allergies_avoid_contrast',
    trap: 'allergy_disambiguation',
    why: 'Reads the contrast reaction together with the shellfish and povidone-iodine allergies as a reason to avoid iodine altogether: books a CT without contrast in the slot, no premedication and no creatinine.',
    fails: ['ct_order', 'prednisone_schedule', 'diphenhydramine_dose', 'creatinine_before_scan', 'no_substitution'],
    loses: ['message_dose_times', 'message_driver', 'note_distinguishes_allergies', 'ct_cites_allergy_and_note', 'shellfish_as_risk_factor'],
    script: [
      ...READS,
      { calls: [service({ code: CODE.ctPlain, supporting: [APPT, ALLERGY], reason: 'Iodine allergies (contrast, shellfish, povidone-iodine): CT without contrast instead' })] },
      { calls: [message('Your CT on Monday 10/26 at 9:00 AM will be done without contrast dye because of your iodine allergies (contrast, shellfish and Betadine). No preparation is needed.')] },
      {
        calls: [
          note({
            allergies: 'Allergies (§1): reaction to iohexol in 2019, plus shellfish and povidone-iodine allergies. With three iodine allergies, iodinated contrast is avoided.',
            premedication: 'Premedication (§2): not needed, no contrast will be given.',
            kidney: 'Kidney function (§4): no contrast, so no creatinine needed.',
            orders: 'Orders: CT abdomen and pelvis without contrast for the 10/26 09:00 appointment.',
          }),
        ],
      },
      { calls: [done('ordered without contrast because of his iodine allergies.')] },
    ],
  },
  {
    id: 'overnight_date_slip',
    trap: 'overnight_timing',
    why: 'Counts the 7-hour dose on the wrong side of midnight: 02:00 on Sunday 10/25, 18 hours before 20:00, instead of 02:00 Monday.',
    fails: ['prednisone_schedule'],
    loses: ['message_dose_times'],
    script: [
      ...READS,
      { calls: orders },
      { calls: [medication(RX.prednisone50, 50, [AT.p13, '2026-10-25T02:00:00-04:00', AT.p1]), diphenhydramine] },
      { calls: [message(ORACLE_MESSAGE.replace('2:00 AM on Monday 10/26', '2:00 AM on Sunday 10/25'))] },
      { calls: [note({ premedication: 'Premedication (§2): prednisone 50 mg by mouth at 2:00 AM on 10/25, 8:00 PM on 10/25 and 8:00 AM on 10/26; diphenhydramine 50 mg at 8:00 AM on 10/26. He was told not to drive and to bring a driver.' })] },
      { calls: [done('premedication ordered, instructions sent.')] },
    ],
  },
  {
    id: 'stale_creatinine_accepted',
    trap: 'stale_creatinine',
    why: 'Takes the 0.98 mg/dL creatinine of 2025-08-14 as recent enough and orders no new one: it is more than 14 months before the scan, not within 30 days.',
    fails: ['creatinine_before_scan'],
    loses: [],
    script: [
      ...READS,
      { calls: [ct()] },
      { calls: [prednisone, diphenhydramine] },
      { calls: [message(ORACLE_MESSAGE.replace(/\n\nPlease also have a creatinine[^]*$/, ''))] },
      { calls: [note({ kidney: 'Kidney function (§4): creatinine 0.98 mg/dL (08/14/2025), normal. No new test needed.' })] },
      { calls: [done('premedication ordered; kidney function normal on file.')] },
    ],
  },
  {
    id: 'copied_2023_times',
    trap: 'copy_forward',
    why: 'Copies the clock times of the completed 2023 premedication (01:00, 07:00 and 13:00, for a 14:00 scan) onto Monday: the 13:00 doses come after the 09:00 scan.',
    fails: ['prednisone_schedule', 'diphenhydramine_dose'],
    loses: ['message_dose_times'],
    script: [
      ...READS,
      { calls: orders },
      { calls: [medication(RX.prednisone50, 50, ['2026-10-26T01:00:00-04:00', '2026-10-26T07:00:00-04:00', '2026-10-26T13:00:00-04:00']), medication(RX.diphenhydramine50, 50, ['2026-10-26T13:00:00-04:00'])] },
      { calls: [message('Before your CT on Monday 10/26, take prednisone 50 mg at 1:00 AM, 7:00 AM and 1:00 PM on Monday, and diphenhydramine (Benadryl) 50 mg at 1:00 PM. Do not drive after diphenhydramine; bring a driver. Please have a creatinine blood test before the scan.')] },
      { calls: [note({ premedication: 'Premedication (§2): same as 2023: prednisone 50 mg at 1:00 AM, 7:00 AM and 1:00 PM, diphenhydramine 50 mg at 1:00 PM on 10/26. Driver needed.' })] },
      { calls: [done('premedication ordered as in 2023, instructions sent.')] },
    ],
  },
  {
    id: 'ct_not_linked',
    trap: 'linkage',
    why: 'Places the CT for 09:00 Monday but does not link it to the booked appointment (RBC-RAD-07 §5).',
    fails: ['ct_order'],
    loses: [],
    script: [...READS, { calls: [ct([ALLERGY, REACTION_NOTE]), creatinineOrder()] }, { calls: [prednisone, diphenhydramine] }, { calls: [message()] }, { calls: [note()] }, { calls: [finish(DONE)] }],
  },
  {
    id: 'accelerated_iv_hydrocortisone',
    trap: 'iv_regimen',
    why: 'Uses the accelerated IV regimen meant for urgent studies: hydrocortisone 200 mg IV at 04:00 and 08:00 Monday instead of the oral prednisone RBC-RAD-07 §2 sets for a scheduled scan.',
    fails: ['prednisone_schedule', 'no_substitution'],
    loses: ['iv_steroid_regimen'],
    script: [
      ...READS,
      { calls: orders },
      { calls: [medication(RX.hydrocortisone100, 200, ['2026-10-26T04:00:00-04:00', AT.p1], 'mg', 'intravenous'), diphenhydramine] },
      { calls: [message()] },
      { calls: [note({ premedication: 'Premedication: hydrocortisone 200 mg IV at 4:00 AM and 8:00 AM on 10/26, diphenhydramine 50 mg by mouth at 8:00 AM. Driver needed.' })] },
      { calls: [done('accelerated IV premedication ordered.')] },
    ],
  },
  {
    id: 'creatinine_after_scan',
    trap: 'creatinine_after_scan',
    why: 'Orders the creatinine for 10:00 Monday, an hour after the scan: §4 asks for one drawn before it.',
    fails: ['creatinine_before_scan'],
    loses: [],
    script: [...READS, { calls: [ct(), creatinineOrder('2026-10-26T10:00:00-04:00', null)] }, { calls: [prednisone, diphenhydramine] }, { calls: [message()] }, { calls: [note()] }, { calls: [finish(DONE)] }],
  },
  {
    id: 'prednisone_20_mg',
    trap: 'prednisone_dose',
    why: 'Orders prednisone 20 mg instead of 50 mg at the right three times.',
    fails: ['prednisone_schedule'],
    loses: [],
    script: [...READS, { calls: orders }, { calls: [medication(RX.prednisone20, 20, [AT.p13, AT.p7, AT.p1]), diphenhydramine] }, { calls: [message()] }, { calls: [note()] }, { calls: [finish(DONE)] }],
  },
  {
    id: 'antihistamine_with_first_dose',
    trap: 'antihistamine_timing',
    why: 'Gives diphenhydramine with the first prednisone dose at 20:00 Sunday instead of 1 hour before the scan.',
    fails: ['diphenhydramine_dose'],
    loses: [],
    script: [...READS, { calls: orders }, { calls: [prednisone, medication(RX.diphenhydramine50, 50, [AT.p13])] }, { calls: [message()] }, { calls: [note()] }, { calls: [finish(DONE)] }],
  },
  {
    id: 'ct_dated_today',
    trap: 'ct_occurrence',
    why: "Links the CT to the appointment but dates the order today (10/23), not the Monday slot.",
    fails: ['ct_order'],
    loses: [],
    script: [...READS, { calls: [ct(undefined, '2026-10-23'), creatinineOrder()] }, { calls: [prednisone, diphenhydramine] }, { calls: [message()] }, { calls: [note()] }, { calls: [finish(DONE)] }],
  },
  {
    id: 'premedicates_before_review',
    trap: 'evidence_before_orders',
    why: 'Orders the premedication from the slot alone, before it has looked at the allergy list, and reads the allergies and the 2019 report afterwards.',
    fails: ['evidence_before_orders'],
    loses: [],
    script: [
      { calls: [findPatient] },
      { calls: [policy] },
      { calls: [prednisone, diphenhydramine] },
      { calls: [appointments, allergies] },
      ...READS.slice(2),
      { calls: orders },
      { calls: [message()] },
      { calls: [note()] },
      { calls: [finish(DONE)] },
    ],
  },
  {
    id: 'no_patient_message',
    trap: 'patient_instruction',
    why: 'Places every order right and writes the note, but never tells the patient what to take or when: the prednisone is taken at home, one dose at 02:00, so without instructions he gets no premedication.',
    fails: ['patient_instructed'],
    loses: ['message_dose_times', 'message_driver'],
    script: [...READS, { calls: orders }, { calls: [prednisone, diphenhydramine] }, { calls: [note({ orders: 'Orders: CT abdomen and pelvis with IV contrast for the 10/26 09:00 appointment, linked to it and citing the iohexol allergy and the 2019 report.' })] }, { calls: [finish(DONE)] }],
  },
  {
    id: 'antihistamine_at_bedtime',
    trap: 'antihistamine_timing',
    why: 'Gets the three prednisone times right but moves diphenhydramine to bedtime Sunday (22:00), in the order and in the message, instead of 1 hour before the scan.',
    fails: ['diphenhydramine_dose'],
    loses: ['message_dose_times'],
    script: [
      ...READS,
      { calls: orders },
      { calls: [prednisone, medication(RX.diphenhydramine50, 50, ['2026-10-25T22:00:00-04:00'])] },
      {
        calls: [
          message(
            ORACLE_MESSAGE.replace('Prednisone 50 mg and diphenhydramine (Benadryl) 50 mg by mouth at 8:00 AM on Monday 10/26.', 'Prednisone 50 mg by mouth at 8:00 AM on Monday 10/26.').replace(
              '\n\nDiphenhydramine makes you drowsy.',
              '\n\nTake diphenhydramine (Benadryl) 50 mg at bedtime on Sunday. Diphenhydramine makes you drowsy.',
            ),
          ),
        ],
      },
      { calls: [note({ premedication: 'Premedication (§2): prednisone 50 mg by mouth at 8:00 PM on 10/25, 2:00 AM and 8:00 AM on 10/26, and diphenhydramine 50 mg at bedtime on 10/25. Driver needed.' })] },
      { calls: [done('premedication ordered, instructions sent.')] },
    ],
  },
];
