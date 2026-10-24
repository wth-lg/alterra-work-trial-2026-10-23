// Near misses of T3, one trap each (task.toml [matrix] traps; design "T3" panel table): each must
// FAIL on exactly the gates it declares and lose exactly the rubric items in `loses`: its trap
// patient's table row, and the -3 item of a patient it contacts who needs no contact. Each why
// says which wrong reading produces it.
import type { Mutant } from '../../../packages/grader/matrix/types.ts';
import { actions, chart, finish, GAPS, group, groups, message, NOTE_SEARCH, OPNOTE, OUTREACH, orderFit, outreach, policy, PT, reads, table, type Label } from '../solution/steps.ts';

const without = (l: Label) => GAPS.filter((x) => x !== l);
const missed = ['fit_orders', 'outreach_messages'];
const extra = ['fit_orders', 'nothing_for_others'];

// `loses` is spelled out in the type until the matrix's Mutant declares it (builder-49).
export const mutants: Array<Mutant & { loses: readonly string[] }> = [
  {
    id: 'colonoscopy_ten_years',
    trap: 'colonoscopy_ten_years',
    why: 'Counts colonoscopy as "within 10 years of today": 2016-11-15 is 9.9 years before 2026-10-23, so E2 looks met; the policy counts calendar years 2017-2026.',
    fails: missed,
    loses: ['table_pt_0017'],
    script: [...reads(), { calls: actions(without('E2')) }, { calls: [finish(table({ E2: '| Stephan Herman | Screening up to date | Colonoscopy 2016-11-15, within 10 years |' }))] }],
  },
  {
    id: 'sdna_three_years',
    trap: 'sdna_calendar_year',
    why: 'Counts sDNA-FIT as "within 3 years of today": 2023-11-20 is 2.9 years back, so E3 looks met; the window is 2024-2026.',
    fails: missed,
    loses: ['table_pt_0018'],
    script: [...reads(), { calls: actions(without('E3')) }, { calls: [finish(table({ E3: '| Lance Muller | Screening up to date | sDNA-FIT 2023-11-20, within 3 years |' }))] }],
  },
  {
    id: 'age_45_today',
    trap: 'age_45_today',
    why: 'Takes age today (45) instead of age at the end of the measurement period (46) and leaves E4 out of the population.',
    fails: missed,
    loses: ['table_pt_0023'],
    script: [...reads(), { calls: actions(without('E4')) }, { calls: [finish(table({ E4: '| Burma Leuschke | Not in the population | Age 45, under 46 |' }))] }],
  },
  {
    id: 'colectomy_note_unread',
    trap: 'notes_only_colectomy',
    why: 'Reads only coded data, never the notes, finds no screening for E6 and orders a FIT kit for a patient with no colon.',
    fails: extra,
    loses: ['table_pt_0021', 'contacted_pt_0021'],
    script: [...reads().slice(0, -2), { calls: [...actions(), orderFit(PT.E6), outreach(PT.E6)] }, { calls: [finish(table({ E6: '| Ángela Vigil | Open gap: FIT kit ordered, outreach sent | No screening on record |' }))] }],
  },
  {
    id: 'dementia_medication_ignored',
    trap: 'dementia_medication',
    why: 'Reads advanced illness as a diagnosis only, misses that donepezil is a dementia medication, and orders for E7.',
    fails: extra,
    loses: ['table_pt_0009', 'contacted_pt_0009'],
    script: [...reads(), { calls: [...actions(), orderFit(PT.E7), outreach(PT.E7)] }, { calls: [finish(table({ E7: '| Elly Trantow | Open gap: FIT kit ordered, outreach sent | Frailty without an advanced illness diagnosis |' }))] }],
  },
  {
    id: 'frailty_excludes',
    trap: 'frailty_alone',
    why: 'Excludes E8 for frailty alone, which at 66-80 needs advanced illness as well.',
    fails: missed,
    loses: ['table_pt_0019'],
    script: [...reads(), { calls: actions(without('E8')) }, { calls: [finish(table({ E8: "| Harrison O'Keefe | Excluded | Frailty |" }))] }],
  },
  {
    id: 'fit_within_a_year',
    trap: 'prior_year_fit',
    why: 'Counts the FIT of 2025-12-03 as "within the last year"; a FIT counts only in the 2026 measurement period.',
    fails: missed,
    loses: ['table_pt_0022'],
    script: [...reads(), { calls: actions(without('E10')) }, { calls: [finish(table({ E10: '| Tiny Koss | Screening up to date | FIT 2025-12-03, within a year |' }))] }],
  },
  {
    id: 'second_fit_order',
    trap: 'duplicate_fit_order',
    why: 'Orders a FIT kit for E11 although a FIT order has been active since 2026-09-30.',
    fails: extra,
    loses: ['table_pt_0024'],
    script: [...reads(), { calls: [...actions(), orderFit(PT.E11), outreach(PT.E11)] }, { calls: [finish(table({ E11: '| Delaine MacGyver | Open gap: FIT kit ordered, outreach sent | FOBT 2024 does not count |' }))] }],
  },
  {
    id: 'two_kits_one_patient',
    trap: 'duplicate_fit_order',
    why: 'Places two FIT orders for E2, one with each code: G1 needs exactly one new FIT order per patient.',
    fails: ['fit_orders'],
    loses: [],
    script: [...reads(), { calls: [...actions(), orderFit(PT.E2, '29771-3')] }, { calls: [finish()] }],
  },
  {
    id: 'messages_without_orders',
    trap: 'outreach_without_order',
    why: 'Messages the five patients with open gaps but places no FIT order.',
    fails: ['fit_orders'],
    loses: [],
    script: [...reads(), { calls: GAPS.map((l) => outreach(PT[l])) }, { calls: [finish()] }],
  },
  {
    id: 'reminder_to_met_patient',
    trap: 'contact_not_needed',
    why: 'Gets every order right and also messages E1, whose screening is up to date, with a screening reminder.',
    fails: ['nothing_for_others'],
    loses: ['contacted_pt_0014'],
    script: [...reads(), { calls: [...actions(), outreach(PT.E1, 'Reminder: colorectal cancer screening is important. Riverbend Family Medicine')] }, { calls: [finish()] }],
  },
  {
    id: 'group_blast',
    trap: 'contact_not_needed',
    why: 'Gets every order and message right, then also sends the screening message to the panel group, which reaches the met, excluded and hospice patients.',
    fails: ['nothing_for_others'],
    loses: ['contacted_pt_0009', 'contacted_pt_0014', 'contacted_pt_0020', 'contacted_pt_0021', 'contacted_pt_0025'],
    script: [...reads(), { calls: [...actions(), message('Group/grp-t3-okafor-crc', 'Colorectal cancer screening', OUTREACH)] }, { calls: [finish()] }],
  },
  {
    id: 'order_before_birth_date',
    trap: 'order_before_review',
    why: 'Orders for E4 on the panel list and screening history alone, before reading her birth date: the right orders, but the gap was not established first.',
    fails: ['gap_seen_before_order'],
    loses: [],
    script: [
      { calls: [policy, groups] },
      { calls: [group] },
      ...[1, 2, 3, 4, 5, 6].map((i) => ({ calls: Object.values(PT).map((p) => chart(p)[i]!) })),
      { calls: [NOTE_SEARCH] },
      { calls: [OPNOTE] },
      { calls: actions() },
      { calls: Object.values(PT).map((p) => chart(p)[0]!) },
      { calls: [finish()] },
    ],
  },
];
