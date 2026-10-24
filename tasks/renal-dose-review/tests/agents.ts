// T1's spray and output-gap agents (the null agent is built into the matrix). Each must FAIL.
// T1 declares no status-only case: it has no inbox items to close.
import type { Script } from '../../../packages/grader/matrix/types.ts';
import { activeMeds, apixabanUp, crclCalc, DONE, egfrCalc, findPatient, finish, gabapentinBid, modify, note, policy, RX, scrResults, weights } from '../solution/steps.ts';

const reads = [{ calls: [findPatient] }, { calls: [activeMeds] }, { calls: [scrResults, weights] }, { calls: [policy] }, { calls: [egfrCalc, crclCalc] }];

// Changes every renally or age-dosed drug it can name, on this chart and the next: over-action,
// caught by the metformin and scope gates.
export const spray: Script = [
  ...reads,
  {
    calls: [
      apixabanUp,
      gabapentinBid,
      modify('mr-t1-metformin', { value: 500, unit: 'mg', frequency: 'BID' }, 'Renal review: reduce', RX.metformin500),
      modify('mr-t1-atorvastatin', { value: 20, unit: 'mg', frequency: 'QHS' }, 'Renal review: reduce', RX.atorvastatin20),
      modify('mr-00047', { value: 5, unit: 'mg', frequency: 'QD' }, 'Renal review: reduce lisinopril'),
    ],
  },
  { calls: [note()] },
  { calls: [finish(DONE)] },
];

// A complete, correct note and summary and no order: state is graded, not prose.
export const output_gap: Script = [...reads, { calls: [note()] }, { calls: [finish(DONE)] }];
