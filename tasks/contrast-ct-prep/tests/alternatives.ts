// Other correct solutions of T5: each must PASS. They vary what a careful clinician might vary
// (one request per dose, the tablets that make up a dose, the creatinine order and its window,
// how the CT order states its time, extra reads, holding metformin around the scan, how the
// message writes the times), so the grader is shown not to depend on the oracle's exact path. An
// alternative that gives up a rubric point declares it in loses; these all score 1.0.
import type { Agent } from '../../../packages/grader/matrix/types.ts';
import {
  ALLERGY, APPT, AT, CODE, ct, creatinineOrder, diphenhydramine, DONE, finish, medication, message, note, oldOrders, ORACLE_MESSAGE, PT, prednisone, read, READS, REACTION_NOTE, RX,
} from '../solution/steps.ts';

// `loses` is checked by the matrix (pnpm cli matrix): each alternative loses exactly what it declares.
export const alternatives: Array<Agent & { loses: readonly string[] }> = [
  {
    id: 'one_request_per_dose',
    why: 'Orders each prednisone dose as its own single-event request, gives diphenhydramine as two 25 mg capsules, draws a basic metabolic panel Saturday morning and books the CT for the 09:00-09:30 slot.',
    loses: [],
    script: [
      ...READS,
      { calls: [ct([APPT, ALLERGY, REACTION_NOTE], '2026-10-26T09:00:00-04:00', '2026-10-26T09:30:00-04:00'), creatinineOrder('2026-10-24T09:00:00-04:00', null, CODE.bmp)] },
      { calls: [medication(RX.prednisone50, 50, [AT.p13]), medication(RX.prednisone50, 50, [AT.p7]), medication(RX.prednisone50, 50, [AT.p1]), medication(RX.diphenhydramine25, 50, [AT.p1])] },
      { calls: [message()] },
      { calls: [note({ kidney: 'Kidney function (§4): age 64 with type 2 diabetes. Last creatinine 0.98 mg/dL on 08/14/2025, more than 30 days before the scan: basic metabolic panel ordered for Saturday 10/24 at 09:00.' })] },
      { calls: [finish(DONE)] },
    ],
  },
  {
    id: 'tablet_counts_and_more_reads',
    why: 'Also reads the 2023 report, the old premedication orders and both telephone notes; writes prednisone as five 10 mg tablets per dose; orders a comprehensive metabolic panel for today; gives the CT order the scan date only; and writes the times in the message on a 24-hour clock.',
    loses: [],
    script: [
      ...READS,
      { calls: [read('DocumentReference', 'doc-t5-ct-2023'), oldOrders, read('DocumentReference', 'doc-t5-tel-0922'), read('DocumentReference', 'doc-t5-tel-1009')] },
      { calls: [ct([APPT, ALLERGY, REACTION_NOTE], '2026-10-26'), creatinineOrder('2026-10-23', null, CODE.cmp)] },
      { calls: [medication(RX.prednisone10, 5, [AT.p13, AT.p7, AT.p1], '{tablet}'), diphenhydramine] },
      {
        calls: [
          message(
            'CT abdomen and pelvis with IV contrast: Monday 10/26, 09:00, St. Brigid Imaging.\n' +
              'Prednisone 50 mg (5 tablets of 10 mg) by mouth at 20:00 Sunday 10/25, at 02:00 Monday 10/26 and at 08:00 Monday 10/26.\n' +
              'Diphenhydramine (Benadryl) 50 mg by mouth at 08:00 Monday 10/26.\n' +
              'You must not drive after the diphenhydramine; bring someone to drive you.\n' +
              'Blood test for kidney function (creatinine) at our lab today, before the scan.',
          ),
        ],
      },
      { calls: [note({ premedication: 'Premedication (§2): prednisone 50 mg (five 10 mg tablets) by mouth at 20:00 on 10/25, 02:00 and 08:00 on 10/26, and diphenhydramine 50 mg by mouth at 08:00 on 10/26. Not the 2023 times, which were for a 14:00 scan. Driver needed.' })] },
      { calls: [finish(DONE)] },
    ],
  },
  {
    id: 'holds_metformin',
    why: 'Does everything the oracle does and also holds metformin from the scan until the new creatinine is back: more than the ACR Manual asks at an eGFR of 30 or more, and harmless.',
    loses: [],
    script: [
      ...READS,
      { calls: [ct(), creatinineOrder()] },
      { calls: [prednisone, diphenhydramine, { name: 'change_medication', input: { medication_request: 'mr-t5-metformin', action: 'hold', reason: 'Hold on the day of the contrast CT until the creatinine is reviewed' } }] },
      { calls: [message(`${ORACLE_MESSAGE}\n\nDo not take your metformin on Monday 10/26; we will tell you when to restart it.`)] },
      { calls: [note()] },
      { calls: [finish(DONE)] },
    ],
  },
  {
    id: 'adds_prn_antihistamine',
    why: 'Adds diphenhydramine 25 mg every 6 hours as needed for itching after the scan, beside the timed premedication: an extra as-needed order, not a change to the schedule.',
    loses: [],
    script: [
      ...READS,
      { calls: [ct(), creatinineOrder()] },
      {
        calls: [
          prednisone,
          diphenhydramine,
          { name: 'order_medication', input: { patient: PT, rxnorm_code: RX.diphenhydramine25, dose_value: 25, dose_unit: 'mg', route: 'oral', frequency: 'Q6H_PRN', as_needed_reason: 'itching or hives after the scan', supply_days: 2, reason: 'As needed after the contrast CT' } },
        ],
      },
      { calls: [message()] },
      { calls: [note()] },
      { calls: [finish(DONE)] },
    ],
  },
  {
    id: 'one_answer_orders',
    why: 'Makes all orders, the message, the note and finish in one answer after the reads, with the creatinine window running to Sunday afternoon.',
    loses: [],
    script: [...READS, { calls: [prednisone, diphenhydramine, ct(), creatinineOrder('2026-10-23T09:00:00-04:00', '2026-10-25T17:00:00-04:00'), message(), note(), finish(DONE)] }],
  },
  {
    id: 'times_in_words',
    why: "Writes the dose times in the message in words ('eight o'clock Sunday evening'), which the pattern cannot read: the judge confirms the four doses.",
    loses: [],
    script: [
      ...READS,
      { calls: [ct(), creatinineOrder()] },
      { calls: [prednisone, diphenhydramine] },
      {
        calls: [
          message(
            'Your CT with contrast is Monday 10/26 at nine in the morning at St. Brigid Imaging. Because of your 2019 reaction to contrast dye, take:\n' +
              "- prednisone 50 mg at eight o'clock Sunday evening (10/25),\n" +
              '- prednisone 50 mg at two in the morning on Monday (10/26), and\n' +
              '- prednisone 50 mg together with diphenhydramine 50 mg at eight in the morning on Monday (10/26).\n' +
              'The diphenhydramine will make you sleepy, so someone else needs to drive you that day. Please get your creatinine blood test today or tomorrow.',
          ),
        ],
      },
      { calls: [note()] },
      { calls: [finish(DONE)] },
    ],
  },
  {
    id: 'split_doses',
    why: 'Makes each prednisone dose from two products ordered as separate requests at the same times (40 mg as two 20 mg tablets plus one 10 mg tablet), and diphenhydramine from two 25 mg requests at 08:00: the doses due at one time add up to 50 mg.',
    loses: [],
    script: [
      ...READS,
      { calls: [ct(), creatinineOrder()] },
      { calls: [medication(RX.prednisone20, 40, [AT.p13, AT.p7, AT.p1]), medication(RX.prednisone10, 10, [AT.p13, AT.p7, AT.p1]), medication(RX.diphenhydramine25, 25, [AT.p1]), medication(RX.diphenhydramine25, 25, [AT.p1])] },
      { calls: [message()] },
      { calls: [note({ premedication: 'Premedication (§2): prednisone 50 mg by mouth (two 20 mg tablets and one 10 mg tablet) at 8:00 PM on 10/25, 2:00 AM and 8:00 AM on 10/26, and diphenhydramine 50 mg (two 25 mg capsules) at 8:00 AM on 10/26. Not the 2023 times, which were for a 2:00 PM scan. Driver needed.' })] },
      { calls: [finish(DONE)] },
    ],
  },
];

