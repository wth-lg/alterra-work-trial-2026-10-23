// Near misses of T1, one trap each (task.toml [matrix] traps; design "Wrong paths"): each must
// FAIL on exactly the gates it declares. The arithmetic of each wrong path is in its why.
import type { Mutant } from '../../../packages/grader/matrix/types.ts';
import {
  activeMeds, apixabanUp, crclCalc, DONE, egfrCalc, findPatient, finish, gabapentinBid, modify, note, observations, order, policy, read, RX, scrResults, stop, weights,
} from '../solution/steps.ts';

const reads = [{ calls: [findPatient] }, { calls: [activeMeds] }, { calls: [scrResults, weights] }, { calls: [policy] }, { calls: [egfrCalc, crclCalc] }];
const keep = 'Apixaban stays at 2.5 mg twice daily.';
const metforminDown = modify('mr-t1-metformin', { value: 500, unit: 'mg', frequency: 'BID' }, 'eGFR below 45: reduce to 1000 mg/day', RX.metformin500);
const gabapentinOnce = modify('mr-t1-gabapentin', { value: 300, unit: 'mg', frequency: 'QD' }, 'CrCl 15-29: 200-700 mg/day once daily', RX.gabapentin300);

export const mutants: Mutant[] = [
  {
    id: 'stale_weight',
    trap: 'stale_weight',
    why: "Takes the 57.0 kg discharge weight from February's summary and never opens the current weight: two criteria (age, weight), so apixaban stays at 2.5 mg; CrCl 37.9 keeps gabapentin in the 30-59 band.",
    fails: ['apixaban_dose', 'apixaban_2_5_stopped', 'inputs_before_orders'],
    script: [
      { calls: [findPatient] },
      { calls: [activeMeds, read('DocumentReference', 'doc-t1-dc-0212')] },
      { calls: [scrResults, policy] },
      { calls: [gabapentinBid] },
      {
        calls: [
          note(
            {
              inputs: 'Inputs (§1): current SCr 1.21 mg/dL (10/20/2026); the 1.88 mg/dL result of 10/21/2026 was entered in error and not used. Weight 57.0 kg (discharge summary). Age 82.',
              apixaban: `Apixaban criteria (§2): age 82, 80 or older: met; weight 57.0 kg, 60 kg or less: met; SCr 1.21 mg/dL, 1.5 or higher: not met. Two criteria met. ${keep}`,
              gabapentin: 'Gabapentin (§4): CrCl 37.9 mL/min, 30 to 59 band: reduced from 600 mg three times daily to 600 mg twice daily.',
            },
            ['Observation/obs-t1-scr-1020', 'DocumentReference/doc-t1-dc-0212'],
          ),
        ],
      },
      { calls: [finish('Reviewed Harold Vance: apixaban stays at 2.5 mg twice daily, metformin unchanged, gabapentin 600 mg twice daily; note written.')] },
    ],
  },
  {
    id: 'entered_in_error_scr',
    trap: 'entered_in_error_scr',
    why: 'Uses the latest SCr by date, 1.88 mg/dL, which is entered in error: two criteria (age, SCr) keep apixaban at 2.5 mg, eGFR 35.2 wrongly reduces metformin, CrCl 27.8 over-reduces gabapentin to 300 mg/day.',
    fails: ['apixaban_dose', 'apixaban_2_5_stopped', 'metformin_dose', 'gabapentin_dose'],
    script: [
      ...reads,
      { calls: [metforminDown, gabapentinOnce] },
      {
        calls: [
          note({
            inputs: 'Inputs (§1): current SCr 1.88 mg/dL (10/21/2026). Weight 143 lb = 64.9 kg (10/20/2026). Age 82.',
            apixaban: `Apixaban criteria (§2): age 82, 80 or older: met; weight 64.9 kg, 60 kg or less: not met; SCr 1.88 mg/dL, 1.5 or higher: met. Two criteria met. ${keep}`,
            metformin: 'Metformin (§3): eGFR 35.2 mL/min/1.73 m2, 30 to 44: reduced to 500 mg twice daily.',
            gabapentin: 'Gabapentin (§4): CrCl 27.8 mL/min, 15 to 29 band: reduced to 300 mg once daily.',
          }),
        ],
      },
      { calls: [finish('Reviewed Harold Vance: apixaban stays at 2.5 mg, metformin and gabapentin reduced; note written.')] },
    ],
  },
  {
    id: 'stale_scr',
    trap: 'stale_scr',
    why: "Reads one creatinine in the default oldest-first order and takes February's 1.71 mg/dL without seeing this week's: two criteria keep apixaban at 2.5 mg and eGFR 39.5 wrongly reduces metformin.",
    fails: ['apixaban_dose', 'apixaban_2_5_stopped', 'metformin_dose', 'inputs_before_orders'],
    script: [
      { calls: [findPatient] },
      { calls: [activeMeds] },
      { calls: [observations('2160-0', { count: 1 }), weights] },
      { calls: [policy] },
      { calls: [metforminDown, gabapentinBid] },
      {
        calls: [
          note(
            {
              inputs: 'Inputs (§1): current SCr 1.71 mg/dL. Weight 143 lb = 64.9 kg (10/20/2026). Age 82.',
              apixaban: `Apixaban criteria (§2): age 82, 80 or older: met; weight 64.9 kg, 60 kg or less: not met; SCr 1.71 mg/dL, 1.5 or higher: met. Two criteria met. ${keep}`,
              metformin: 'Metformin (§3): eGFR 39.5 mL/min/1.73 m2, 30 to 44: reduced to 500 mg twice daily.',
              gabapentin: 'Gabapentin (§4): CrCl 30.6 mL/min, 30 to 59 band: reduced to 600 mg twice daily.',
            },
            ['Observation/obs-t1-scr-0209', 'Observation/obs-t1-wt-1020'],
          ),
        ],
      },
      { calls: [finish('Reviewed Harold Vance: apixaban stays at 2.5 mg, metformin reduced, gabapentin 600 mg twice daily; note written.')] },
    ],
  },
  {
    id: 'keep_2_5',
    trap: 'dose_inertia',
    why: 'Works out every number right and still leaves apixaban at the 2.5 mg it has been on since February.',
    fails: ['apixaban_dose', 'apixaban_2_5_stopped'],
    script: [
      ...reads,
      { calls: [gabapentinBid] },
      { calls: [note({ apixaban: `Apixaban criteria (§2): age 82, 80 or older: met; weight 64.9 kg, 60 kg or less: not met; SCr 1.21 mg/dL, 1.5 or higher: not met. ${keep}` })] },
      { calls: [finish('Reviewed Harold Vance: apixaban continued at 2.5 mg twice daily, metformin unchanged, gabapentin 600 mg twice daily; note written.')] },
    ],
  },
  {
    id: 'apixaban_double_dose',
    trap: 'apixaban_wrong_dose',
    why: 'Orders the right product, the apixaban 5 mg tablet, at 10 mg twice daily (two tablets a dose): the dose term of G1 alone fails.',
    fails: ['apixaban_dose'],
    script: [
      ...reads,
      { calls: [modify('mr-t1-apixaban', { value: 10, unit: 'mg', frequency: 'BID' }, 'One criterion met: 5 mg tablets', RX.apixaban5), gabapentinBid] },
      { calls: [note()] },
      { calls: [finish(DONE)] },
    ],
  },
  {
    id: 'apixaban_half_tablet',
    trap: 'dose_inertia',
    why: 'Switches to the 5 mg tablet but writes half a tablet twice daily, which is still 2.5 mg twice daily: the 2.5 mg order is stopped, the dose is unchanged.',
    fails: ['apixaban_dose'],
    script: [
      ...reads,
      { calls: [modify('mr-t1-apixaban', { value: 0.5, unit: '{tablet}', frequency: 'BID' }, 'Changed to the 5 mg tablet', RX.apixaban5), gabapentinBid] },
      { calls: [note({ apixaban: `Apixaban criteria (§2): age 82, 80 or older: met; weight 64.9 kg, 60 kg or less: not met; SCr 1.21 mg/dL, 1.5 or higher: not met. Changed to half a 5 mg tablet twice daily.` })] },
      { calls: [finish(DONE)] },
    ],
  },
  {
    id: 'apixaban_two_orders',
    trap: 'apixaban_wrong_dose',
    why: 'Stops the 2.5 mg order and makes up 5 mg twice daily from two separate 2.5 mg orders: the total is right, but G1 needs exactly one active apixaban request.',
    fails: ['apixaban_dose'],
    script: [
      ...reads,
      {
        calls: [
          stop('mr-t1-apixaban', 'Replaced by 5 mg twice daily'),
          order(RX.apixaban2_5, 2.5, 'BID', 'One criterion met: 5 mg twice daily, first 2.5 mg'),
          order(RX.apixaban2_5, 2.5, 'BID', 'One criterion met: 5 mg twice daily, second 2.5 mg'),
          gabapentinBid,
        ],
      },
      { calls: [note()] },
      { calls: [finish(DONE)] },
    ],
  },
  {
    id: 'gabapentin_under_400',
    trap: 'gabapentin_over_reduced',
    why: 'Places CrCl 43 in the right band and then orders 300 mg once daily, below the band floor of 400 mg/day.',
    fails: ['gabapentin_dose'],
    script: [
      ...reads,
      { calls: [apixabanUp, gabapentinOnce] },
      { calls: [note({ gabapentin: 'Gabapentin (§4): CrCl 43.2 mL/min by Cockcroft-Gault with actual weight: reduced to 300 mg once daily.' })] },
      { calls: [finish(DONE)] },
    ],
  },
  {
    id: 'metformin_reduced',
    trap: 'metformin_wrongly_reduced',
    why: 'Reduces metformin although eGFR 59.8 is 45 or higher, where the policy makes no change.',
    fails: ['metformin_dose'],
    script: [
      ...reads,
      { calls: [apixabanUp, gabapentinBid, metforminDown] },
      { calls: [note({ metformin: 'Metformin (§3): eGFR 59.8 mL/min/1.73 m2 by CKD-EPI 2021; reduced to 500 mg twice daily to be cautious.' })] },
      { calls: [finish(DONE)] },
    ],
  },
  {
    id: 'metformin_tablets_reduced',
    trap: 'metformin_wrongly_reduced',
    why: 'Writes metformin in tablets and switches the product: 1 x 500 mg tablet twice daily is 1000 mg/day, a reduction the policy does not allow at eGFR 59.8.',
    fails: ['metformin_dose'],
    script: [
      ...reads,
      { calls: [apixabanUp, gabapentinBid, modify('mr-t1-metformin', { value: 1, unit: '{tablet}', frequency: 'BID' }, 'Lower metformin', RX.metformin500)] },
      { calls: [note({ metformin: 'Metformin (§3): eGFR 59.8 mL/min/1.73 m2 by CKD-EPI 2021; changed to one 500 mg tablet twice daily.' })] },
      { calls: [finish(DONE)] },
    ],
  },
  {
    id: 'atorvastatin_touched',
    trap: 'scope_creep',
    why: 'Gets the three covered drugs right and also halves atorvastatin, which RBC-PHARM-07 does not cover.',
    fails: ['no_other_changes'],
    script: [
      ...reads,
      { calls: [apixabanUp, gabapentinBid, modify('mr-t1-atorvastatin', { value: 20, unit: 'mg', frequency: 'QHS' }, 'Age 82: lower statin intensity', RX.atorvastatin20)] },
      { calls: [note({ others: 'Atorvastatin reduced to 20 mg at bedtime given his age. Metoprolol, amlodipine, acetaminophen and nitroglycerin not changed.' })] },
      { calls: [finish(DONE)] },
    ],
  },
];
