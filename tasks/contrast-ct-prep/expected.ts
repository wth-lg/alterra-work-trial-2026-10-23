// T5's expected end state, written by hand from design section 4 ("T5"): the scan, the allergy
// that decides the prep, the dose times RBC-RAD-07 §2 gives counted back from the scan, and the
// creatinine §4 asks for. policy.ts computes the same from the initial world, and the matrix
// fails when the two differ. The grader reads its targets from here.
//
//   scan          appt-t5-1026, Monday 2026-10-26 09:00 -04:00 (EDT; DST ends 2026-11-01)
//   allergy       alg-t5-iohexol: diffuse urticaria and eyelid swelling in 2019, moderate
//                 (doc-t5-ct-2019): premedicate (§2)
//   not factors   shellfish and povidone-iodine (§1); aspirin and mold are unrelated
//   prednisone    50 mg at 09:00 - 13 h = Sunday 20:00, - 7 h = Monday 02:00, - 1 h = Monday 08:00
//   antihistamine diphenhydramine 50 mg at 09:00 - 1 h = Monday 08:00
//   creatinine    age 64 and diabetes; the latest, obs-t5-scr-0814, is 2025-08-14, more than
//                 30 days before the scan: a new one drawn after NOW and before 09:00 Monday
export const expected = {
  patient: 'Patient/pt-0015',
  patient_name: 'Daniel Ferreira',
  age: 64,
  diabetes: true,
  appointment: { id: 'Appointment/appt-t5-1026', start: '2026-10-26T09:00:00-04:00' },
  contrast_allergy: { id: 'AllergyIntolerance/alg-t5-iohexol', substance: 'iohexol', severity: 'moderate' },
  reaction_note: 'DocumentReference/doc-t5-ct-2019',
  other_allergies: ['AllergyIntolerance/alg-00005', 'AllergyIntolerance/alg-00007', 'AllergyIntolerance/alg-t5-pvp', 'AllergyIntolerance/alg-t5-shellfish'],
  regimen: 'premedicate',
  prednisone: { mg: 50, at: ['2026-10-25T20:00:00-04:00', '2026-10-26T02:00:00-04:00', '2026-10-26T08:00:00-04:00'] },
  diphenhydramine: { mg: 50, at: ['2026-10-26T08:00:00-04:00'] },
  creatinine: { latest: 'Observation/obs-t5-scr-0814', date: '2025-08-14', required: true, current: false, before: '2026-10-26T09:00:00-04:00' },
  ct_supporting: ['AllergyIntolerance/alg-t5-iohexol', 'DocumentReference/doc-t5-ct-2019'],
};
