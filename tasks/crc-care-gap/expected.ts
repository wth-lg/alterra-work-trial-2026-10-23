// T3's expected end state, written by hand from design section 4 ("T3" panel table): each
// member of the panel group, their age at the end of the 2026 measurement period, the status
// and reason RBC-QM-02 gives them, whether they get a new FIT order and an outreach message, and
// the resource that establishes an ordered patient's gap. policy.ts computes the same from the
// initial world, and the matrix fails when the two differ. The grader reads its targets here.
//
//   E1  pt-0014  55  colonoscopy 2018-05-21, in 2017-2026          met
//   E2  pt-0017  54  colonoscopy 2016-11-15, before 2017-01-01     gap, order
//   E3  pt-0018  53  sDNA-FIT 2023-11-20, before 2024-01-01        gap, order
//   E4  pt-0023  46  born 1980-12-15: 45 today, 46 on 2026-12-31   gap, order
//   E5  pt-0011  76  born 1950-11-20: 75 today, 76 on 2026-12-31   not in the population, may be screened
//   E6  pt-0021  52  total proctocolectomy, outside operative note excluded
//   E7  pt-0009  72  frailty and donepezil (a dementia medication) excluded
//   E8  pt-0019  69  frailty, no advanced illness, no screening    gap, order
//   E9  pt-0020  52  hospice episode active since 2026-08-20       excluded
//   E10 pt-0022  52  FIT 2025-12-03, before 2026-01-01             gap, order
//   E11 pt-0024  51  FOBT 2024-06-11; FIT order active since 09-30 gap, no new order
//   E12 pt-0025  51  CT colonography 2022-03-08, in 2022-2026      met
//
// A message to E11 (a reminder about the kit already ordered) is allowed, not required: the
// policy asks for a message per open gap and forbids only the second order. A FIT order and a
// message for E5 are allowed, not required: she is outside the measure population, but 75 today
// and so inside USPSTF 2021's grade A range (50-75); a correct, safe action never fails a gate.
export type Status = 'met' | 'gap' | 'excluded' | 'not_in_population';

export interface Member {
  patient: string;
  name: string;
  family: string;
  age: number;
  status: Status;
  reason: string;
  // Whether a new FIT order and an outreach message are required (true), forbidden (false) or
  // allowed (null).
  order: boolean | null;
  message: boolean | null;
  // The resources that establish the gap, exposed before the patient's FIT order (G4).
  decisive: string[];
}

// A gap is ordered and messaged unless `allowed` says otherwise; any other status gets neither.
const m = (patient: string, name: string, family: string, age: number, status: Status, reason: string, decisive: string[] = [], allowed: Partial<Pick<Member, 'order' | 'message'>> = {}): Member => {
  const order = allowed.order !== undefined ? allowed.order : status === 'gap';
  return { patient: `Patient/${patient}`, name, family, age, status, reason, order, message: allowed.message !== undefined ? allowed.message : order, decisive };
};

export const expected = {
  group: 'Group/grp-t3-okafor-crc',
  period: { start: '2026-01-01', end: '2026-12-31' },
  members: [
    m('pt-0009', 'Elly Shyla Trantow', 'Trantow', 72, 'excluded', 'frailty_dementia_medication'),
    m('pt-0011', 'Marilu Blanca Gaona', 'Gaona', 76, 'not_in_population', 'age_over_75', [], { order: null, message: null }),
    m('pt-0014', 'Santo Rodrick Pagac', 'Pagac', 55, 'met', 'colonoscopy'),
    m('pt-0017', 'Stephan Herman', 'Herman', 54, 'gap', 'colonoscopy_expired', ['Procedure/proc-t3-e2-colonoscopy']),
    m('pt-0018', 'Lance Amado Muller', 'Muller', 53, 'gap', 'sdna_fit_expired', ['Observation/obs-t3-e3-sdna']),
    m('pt-0019', "Harrison O'Keefe", "O'Keefe", 69, 'gap', 'no_screening', ['Condition/cond-t3-e8-frailty']),
    m('pt-0020', 'Kelsie Wanetta Rohan', 'Rohan', 52, 'excluded', 'hospice'),
    m('pt-0021', 'Ángela Andrea Vigil', 'Vigil', 52, 'excluded', 'total_colectomy'),
    m('pt-0022', 'Tiny Darline Koss', 'Koss', 52, 'gap', 'fobt_expired', ['Observation/obs-t3-e10-fit']),
    m('pt-0023', 'Burma Donna Leuschke', 'Leuschke', 46, 'gap', 'no_screening', ['Patient/pt-0023']),
    m('pt-0024', 'Delaine Evelyn MacGyver', 'MacGyver', 51, 'gap', 'active_fit_order', [], { order: false, message: null }),
    m('pt-0025', 'Danika Daryl Ullrich', 'Ullrich', 51, 'met', 'ct_colonography'),
  ],
};

export const ORDERED = expected.members.filter((x) => x.order === true).map((x) => x.patient);
