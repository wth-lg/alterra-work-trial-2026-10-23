// Other correct solutions of T1: each must PASS. They vary what a careful clinician might vary
// (how the apixaban order is replaced, which product and unit the dose is written in, which
// gabapentin dose in the band, extra reads, a no-op metformin modify, how the note names the
// entered-in-error result), so the grader is shown not to depend on the oracle's exact path. An
// alternative that gives up a rubric point declares it in loses; the rest score 1.0.
import type { Alternative } from '../../../packages/grader/matrix/types.ts';
import {
  activeMeds, apixabanUp, crclCalc, DONE, egfrCalc, findPatient, finish, gabapentinBid, modify, note, order, ORACLE_NOTE, policy, read, RX, scrResults, stop, weights,
} from '../solution/steps.ts';

const reads = [{ calls: [findPatient] }, { calls: [activeMeds] }, { calls: [scrResults, weights] }, { calls: [policy] }, { calls: [egfrCalc, crclCalc] }];
const ONE = 'RBC-PHARM-07 §2: one dose criterion met (age)';

export const alternatives: Alternative[] = [
  {
    id: 'stop_then_order',
    why: 'Replaces apixaban with a stop and a new 5 mg order instead of modify.',
    script: [
      ...reads,
      { calls: [stop('mr-t1-apixaban', `${ONE}; replaced by a 5 mg order`), order(RX.apixaban5, 5, 'BID', ONE), gabapentinBid] },
      { calls: [note()] },
      { calls: [finish(DONE)] },
    ],
  },
  {
    id: 'gabapentin_200_tid',
    why: 'Keeps gabapentin three times daily at 200 mg (600 mg/day, inside the band): a valid dose that misses the twice-daily rubric point.',
    loses: ['gabapentin_twice_daily'],
    script: [
      ...reads,
      { calls: [apixabanUp, modify('mr-t1-gabapentin', { value: 200, unit: 'mg', frequency: 'TID' }, 'CrCl 43 mL/min: 400-1400 mg/day', RX.gabapentin100)] },
      { calls: [note({ gabapentin: 'Gabapentin (§4): CrCl 43.2 mL/min by Cockcroft-Gault with actual weight, 30 to 59 band: 400 to 1400 mg per day. Reduced to 200 mg three times daily (600 mg/day).' })] },
      { calls: [finish('Reviewed Harold Vance under RBC-PHARM-07: apixaban back to 5 mg twice daily, metformin unchanged, gabapentin 200 mg three times daily; note written.')] },
    ],
  },
  {
    id: 'replaces_and_noop_metformin',
    why: 'Reads the discharge summary and the entered-in-error result too, orders apixaban 5 mg with replaces, re-signs metformin at the same dose and picks gabapentin 400 mg twice daily.',
    script: [
      { calls: [findPatient] },
      { calls: [activeMeds, read('DocumentReference', 'doc-t1-dc-0212')] },
      { calls: [scrResults, read('Observation', 'obs-t1-scr-1021'), weights, policy] },
      { calls: [egfrCalc, crclCalc] },
      {
        calls: [
          order(RX.apixaban5, 5, 'BID', ONE, 'mr-t1-apixaban'),
          modify('mr-t1-metformin', { value: 1000, unit: 'mg', frequency: 'BID' }, 'eGFR 60: no change; re-signed'),
          modify('mr-t1-gabapentin', { value: 400, unit: 'mg', frequency: 'BID' }, 'CrCl 43 mL/min: 400-1400 mg/day twice daily', RX.gabapentin400),
        ],
      },
      { calls: [note({ gabapentin: 'Gabapentin (§4): CrCl 43.2 mL/min by Cockcroft-Gault with actual weight, 30 to 59 band: reduced to 400 mg twice daily (800 mg/day).' })] },
      { calls: [finish('Reviewed Harold Vance under RBC-PHARM-07: apixaban back to 5 mg twice daily, metformin unchanged, gabapentin 400 mg twice daily; note written.')] },
    ],
  },
  {
    id: 'apixaban_two_2_5_tablets',
    why: 'Raises apixaban to 5 mg twice daily on the 2.5 mg tablet it already has, two tablets a dose: the same 5 mg by mouth twice daily the policy asks for.',
    script: [
      ...reads,
      { calls: [modify('mr-t1-apixaban', { value: 5, unit: 'mg', frequency: 'BID' }, `${ONE}: 5 mg twice daily`), gabapentinBid] },
      { calls: [note()] },
      { calls: [finish(DONE)] },
    ],
  },
  {
    id: 'apixaban_2_5_tablets_counted',
    why: 'Writes the apixaban dose as a count, 2 tablets of the 2.5 mg product twice daily (5 mg twice daily).',
    script: [
      ...reads,
      { calls: [modify('mr-t1-apixaban', { value: 2, unit: '{tablet}', frequency: 'BID' }, `${ONE}: 5 mg twice daily as two 2.5 mg tablets`), gabapentinBid] },
      { calls: [note({ apixaban: `${ORACLE_NOTE.apixaban} Given as two 2.5 mg tablets twice daily.` })] },
      { calls: [finish(DONE)] },
    ],
  },
  {
    id: 'doses_in_tablets',
    why: 'Writes every dose as a count of the product: apixaban 1 x 5 mg tablet twice daily, gabapentin 2 x 300 mg capsules twice daily (1200 mg/day), and re-signs metformin as 1 x 1000 mg tablet twice daily (no change).',
    script: [
      ...reads,
      {
        calls: [
          modify('mr-t1-apixaban', { value: 1, unit: '{tablet}', frequency: 'BID' }, `${ONE}: 5 mg twice daily`, RX.apixaban5),
          modify('mr-t1-metformin', { value: 1, unit: '{tablet}', frequency: 'BID' }, 'eGFR 60: no change; re-signed'),
          modify('mr-t1-gabapentin', { value: 2, unit: '{capsule}', frequency: 'BID' }, 'CrCl 43 mL/min: 400-1400 mg/day twice daily', RX.gabapentin300),
        ],
      },
      { calls: [note({ gabapentin: 'Gabapentin (§4): CrCl 43.2 mL/min by Cockcroft-Gault with actual weight, in the 30 to 59 band: 400 to 1400 mg per day, twice daily. Reduced from 600 mg three times daily to two 300 mg capsules twice daily (1200 mg/day).' })] },
      { calls: [finish(DONE)] },
    ],
  },
  {
    id: 'eie_value_named',
    why: "Names the entered-in-error value in the note's inputs ('the current SCr of 1.88 mg/dL ... was entered in error') while using 1.21: the wrong-SCr pattern matches, and the judge confirms the note does not treat 1.88 as current.",
    script: [
      ...reads,
      { calls: [apixabanUp, gabapentinBid] },
      {
        calls: [
          note({
            inputs:
              'Inputs (§1): the current SCr of 1.88 mg/dL (10/21/2026) was entered in error (specimen mislabelled, belongs to another patient) and was not used; the review uses the SCr of 1.21 mg/dL (10/20/2026). ' +
              'Weight 143 lb = 64.9 kg (10/20/2026); the 57.0 kg inpatient weight from February is stale. Age 82.',
          }),
        ],
      },
      { calls: [finish(DONE)] },
    ],
  },
  {
    id: 'one_answer_orders',
    why: 'Makes all orders, the note and finish in one answer after the reads.',
    script: [...reads, { calls: [apixabanUp, gabapentinBid, note(), finish(DONE)] }],
  },
];
