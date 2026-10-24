// T1's expected end state, written by hand from design section 4 ("Ground truth"): the inputs
// RBC-PHARM-07 §1 picks, the two estimates, each drug's result, and the requests the review
// must leave alone. policy.ts computes the same from the initial world, and the matrix fails
// when the two differ. The grader reads its targets from here.
//
//   age        2026-10-23 - 1944-03-11 = 82 years
//   SCr        obs-t1-scr-1020, 1.21 mg/dL (obs-t1-scr-1021, 1.88, is entered in error)
//   weight     obs-t1-wt-1020, 143 lb = 64.86 kg (obs-t1-wt-0210, 57.0 kg, is stale)
//   apixaban   age met, weight not met, SCr not met: one criterion, 5 mg twice daily
//   eGFR       142 x (1.21/0.9)^-1.200 x 0.9938^82 = 59.8: >= 45, metformin unchanged
//   CrCl       (140 - 82) x 64.86 / (72 x 1.21) = 43.2: 30-59, gabapentin 400-1400 mg/day BID
export const expected = {
  patient: 'Patient/pt-0002',
  patient_name: 'Harold Vance',
  age: 82,
  scr: { id: 'Observation/obs-t1-scr-1020', mg_dl: 1.21 },
  weight: { id: 'Observation/obs-t1-wt-1020', kg: 64.86 },
  disregarded: ['Observation/obs-t1-scr-1021'],
  egfr: 59.8,
  crcl: 43.2,
  apixaban: {
    request: 'MedicationRequest/mr-t1-apixaban',
    criteria: { age: true, weight: false, scr: false },
    dose_mg: 5,
    per_day: 2,
  },
  metformin: { request: 'MedicationRequest/mr-t1-metformin', action: 'unchanged', daily_mg: { min: 2000, max: 2000 } },
  gabapentin: { request: 'MedicationRequest/mr-t1-gabapentin', action: 'reduce', daily_mg: { min: 400, max: 1400 }, per_day: 2 },
  // Active requests the policy does not cover: no write may touch them.
  untouched: ['MedicationRequest/mr-00009', 'MedicationRequest/mr-00010', 'MedicationRequest/mr-00022', 'MedicationRequest/mr-00023', 'MedicationRequest/mr-t1-atorvastatin'],
  cites: ['Observation/obs-t1-scr-1020', 'Observation/obs-t1-wt-1020'],
};
