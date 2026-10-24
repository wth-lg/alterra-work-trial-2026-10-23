// Other correct solutions of T1: each must PASS. They vary what a careful clinician might vary
// (how the apixaban order is replaced, which gabapentin dose in the band, extra reads, a no-op
// metformin modify), so the grader is shown not to depend on the oracle's exact path.
import type { Agent } from '../../../packages/grader/matrix/types.ts';
import {
  activeMeds, apixabanUp, crclCalc, DONE, egfrCalc, findPatient, finish, gabapentinBid, modify, note, order, policy, read, RX, scrResults, stop, weights,
} from '../solution/steps.ts';

const reads = [{ calls: [findPatient] }, { calls: [activeMeds] }, { calls: [scrResults, weights] }, { calls: [policy] }, { calls: [egfrCalc, crclCalc] }];
const ONE = 'RBC-PHARM-07 §2: one dose criterion met (age)';

export const alternatives: Agent[] = [
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
    id: 'one_answer_orders',
    why: 'Makes all orders, the note and finish in one answer after the reads.',
    script: [...reads, { calls: [apixabanUp, gabapentinBid, note(), finish(DONE)] }],
  },
];
