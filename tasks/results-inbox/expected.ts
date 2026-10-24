// T2's expected end state, written by hand from design section 4 ("Inbox" and "Gate"): each
// inbox item, its decisive source, and what the policies make of it. policy.ts computes the same
// from the initial world, and the matrix fails when the two differ. The grader reads its
// targets from here.
//
//   nodule       5 mm solid nodule on the CT of 2026-06-04; H&P: 35 pack-years, quit 2019, so
//                high risk (RBC-RAD-05 §2); CT chest 12 months from the index study (§1):
//                2027-06-04, window 2027-05-04 to 2027-07-04 (from today it would be 2027-10-23)
//   cyst         simple renal cyst, report says no follow-up: close with a comment, no order
//   fit          positive FIT; Dr. Lin's GI referral sr-t2-gi-1020 is active: link it, no new one
//   hemolyzed_k  K 6.4, hemolyzed (RBC-LAB-03 §2): repeat BMP urgent by the next business day,
//                Monday 2026-10-26; message the patient; no on-call
//   critical_k   K 6.2, not hemolyzed (§1): stat notice to pool-oncall and a stat BMP today
//   bone         urgent recommendation, no interval (RBC-RAD-05 §3): ortho-oncology referral and
//                MRI femur, urgent, by 2026-10-22 + 14 days = 2026-11-05
//   tsh, lipid   normal: close, no order
export const expected = {
  queue: 'results',
  items: {
    nodule: {
      task: 'Task/task-t2-inbox-1',
      patient: 'Patient/pt-0013',
      sources: ['DiagnosticReport/dr-t2-ct-0604', 'DocumentReference/doc-t2-hp-lm58'],
      nodule_mm: 5,
      pack_years: 35,
      quit_year: 2019,
      risk: 'high',
      index_date: '2026-06-04',
      window: { start: '2027-05-04', end: '2027-07-04' },
      action: 'order',
    },
    cyst: { task: 'Task/task-t2-inbox-2', patient: 'Patient/pt-0007', sources: ['DiagnosticReport/dr-t2-us-1020'], action: 'close' },
    fit: { task: 'Task/task-t2-inbox-3', patient: 'Patient/pt-0006', sources: ['Observation/obs-t2-fit-1019'], existing: ['ServiceRequest/sr-t2-gi-1020'], action: 'link' },
    hemolyzed_k: {
      task: 'Task/task-t2-inbox-4',
      patient: 'Patient/pt-0008',
      sources: ['Observation/obs-t2-c-k'],
      k: 6.4,
      hemolyzed: true,
      by: '2026-10-26',
      action: 'order',
    },
    critical_k: {
      task: 'Task/task-t2-inbox-5',
      patient: 'Patient/pt-0010',
      sources: ['Observation/obs-t2-d-k'],
      k: 6.2,
      hemolyzed: false,
      by: '2026-10-23',
      action: 'order',
    },
    bone: { task: 'Task/task-t2-inbox-6', patient: 'Patient/pt-0053', sources: ['DiagnosticReport/dr-t2-xr-1022'], report_date: '2026-10-22', by: '2026-11-05', action: 'order' },
    tsh: { task: 'Task/task-t2-inbox-7', patient: 'Patient/pt-0016', sources: ['Observation/obs-t2-tsh-1020'], action: 'close' },
    lipid: { task: 'Task/task-t2-inbox-8', patient: 'Patient/pt-0016', sources: ['DiagnosticReport/dr-t2-lipid-1020'], action: 'close' },
  },
  // Patients who share a name with an item's patient: no write may touch them.
  namesakes: ['Patient/pt-0033'],
};
