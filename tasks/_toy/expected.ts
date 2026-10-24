// The toy's expected end state, written by hand (design section 4, "Double derivation"): the one
// note the trial adds and what it and the summary name. policy.ts computes the same from the
// initial world, and the matrix fails when the two differ. The grader reads its targets from here.
export const expected = {
  patient: 'Patient/pt-0001',
  patient_name: 'Peter Prosacco',
  user: 'Practitioner/pr-okafor',
  user_name: 'Maya Okafor',
  notes: [{ patient: 'Patient/pt-0001', cites: ['Patient/pt-0001'] }],
};
