// Near misses of T2, one trap each (task.toml [matrix] traps; design "Inbox" traps): each must
// FAIL on exactly the gates it declares (fails) and lose exactly the rubric items it declares
// (loses: the items whose result differs from the oracle's).
import type { Mutant } from '../../../packages/grader/matrix/types.ts';
import { ORACLE, solve } from '../solution/solve.ts';
import { PT, READ_ALL, read, searchNotes, SRC } from '../solution/steps.ts';

const hp = read(SRC.hp);
// The reads without Linda Marsh's H&P.
const withoutHp = READ_ALL.map((t) => ({ ...t, calls: t.calls.filter((c) => JSON.stringify(c) !== JSON.stringify(hp)) }));
// The reads without Denise Holloway's potassium result.
const withoutKd = READ_ALL.map((t) => ({ ...t, calls: t.calls.filter((c) => JSON.stringify(c) !== JSON.stringify(read(SRC.kD))) }));

// `satisfies` keeps loses checked against the Mutant type both before and after it gains the field.
export const mutants = [
  {
    id: 'structured_smoking_only',
    trap: 'smoking_history_in_note',
    why: "Never opens the H&P, takes the structured 'Ex-smoker' as a remote, light history, calls the nodule low risk and closes item 1 with no follow-up.",
    fails: ['nodule_ct_window', 'items_closed_with_links'],
    loses: ['nodule_tracking_task', 'nodule_patient_message'],
    script: solve({ reads: withoutHp, nodule: { order: null, due: null, message: false } }),
  },
  {
    id: 'ct_from_today',
    trap: 'interval_from_today',
    why: 'Counts the 12 months from today instead of from the 2026-06-04 CT: the CT chest falls on 2027-10-23, outside the window 2027-05-04 to 2027-07-04.',
    fails: ['nodule_ct_window'],
    loses: ['nodule_tracking_task'],
    script: solve({ nodule: { order: { code: 'IMG-CT-CHEST-WO', priority: 'routine', start: '2027-10-23', end: '2027-11-23' }, due: '2027-11-23', message: true } }),
  },
  {
    id: 'ct_with_contrast',
    trap: 'interval_from_today',
    why: 'Gets the window right but orders the CT chest with contrast, which RBC-RAD-05 §2 does not ask for; a nodule follow-up CT is done without contrast.',
    fails: ['nodule_ct_window'],
    loses: [],
    script: solve({ nodule: { ...ORACLE.nodule, order: { code: 'IMG-CT-CHEST-W', priority: 'routine', start: '2027-06-04', end: '2027-07-04' } } }),
  },
  {
    id: 'namesake_ct',
    trap: 'wrong_patient_same_name',
    why: "Searches the clinic's notes by name, lands on the other Linda Marsh (1965) and orders the CT on her chart; item 1 is closed with nothing of its own patient linked.",
    fails: ['nodule_ct_window', 'namesake_untouched', 'items_closed_with_links'],
    loses: ['nodule_tracking_task', 'nodule_patient_message'],
    script: solve({
      reads: [...withoutHp, { calls: [searchNotes('Linda Marsh smoker'), read('DocumentReference/doc-t2-pn-lm65')] }],
      nodule: { order: { code: 'IMG-CT-CHEST-WO', priority: 'routine', start: '2027-06-04', end: '2027-07-04', patient: PT.otherMarsh }, due: null, message: false, link: false },
    }),
  },
  {
    id: 'duplicate_gi_referral',
    trap: 'duplicate_gi_referral',
    why: "Never looks for Dr. Lin's referral of 10-20 and places a second GI referral for colonoscopy, linking the new one.",
    fails: ['fit_existing_referral'],
    loses: [],
    script: solve({ fit: { newReferral: true, linkExisting: false } }),
  },
  {
    id: 'hemolyzed_k_paged',
    trap: 'hemolyzed_k_oncall',
    why: 'Repeats the hemolyzed potassium correctly but also pages on-call at stat for it, which RBC-LAB-03 §2 says not to do.',
    fails: ['hemolyzed_k_no_oncall'],
    loses: ['hemolyzed_k_oncall_notified'],
    script: solve({ hemolyzed: { ...ORACLE.hemolyzed, oncall: true } }),
  },
  {
    id: 'hemolyzed_k_routine_next_week',
    trap: 'hemolyzed_k_no_repeat',
    why: 'Treats the hemolyzed 6.4 as noise and schedules a routine BMP for next Friday, 2026-10-30, past the next business day.',
    fails: ['hemolyzed_k_repeat'],
    loses: [],
    script: solve({ hemolyzed: { ...ORACLE.hemolyzed, order: { code: '51990-0', priority: 'routine', start: '2026-10-30' } } }),
  },
  {
    id: 'critical_k_patient_only',
    trap: 'critical_k_no_oncall',
    why: 'Orders the stat BMP for the true 6.2 and tells no one: neither on-call nor the patient hears of it.',
    fails: ['critical_k_oncall'],
    loses: ['urgent_item_unnotified'],
    script: solve({ critical: { ...ORACLE.critical, oncall: null } }),
  },
  {
    id: 'critical_k_oncall_urgent',
    trap: 'critical_k_no_oncall',
    why: 'Tells on-call about the true 6.2 at urgent priority, not the stat RBC-LAB-03 §1 requires.',
    fails: ['critical_k_oncall'],
    loses: [],
    script: solve({ critical: { ...ORACLE.critical, oncallPriority: 'urgent' } }),
  },
  {
    id: 'bone_routine_three_months',
    trap: 'urgent_no_interval',
    why: 'Reads no interval as no hurry: orders the referral and the MRI routine for 2027-01-22, three months out, past 2026-11-05.',
    fails: ['bone_lesion_orders'],
    loses: [],
    script: solve({
      bone: { ...ORACLE.bone, orders: [{ code: 'REF-ORTHO-ONC', priority: 'routine', start: '2027-01-22' }, { code: 'IMG-MRI-FEMUR-WWO', priority: 'routine', start: '2027-01-22' }] },
    }),
  },
  {
    id: 'bone_referral_only',
    trap: 'urgent_no_interval',
    why: 'Places the urgent orthopaedic oncology referral and leaves the MRI to the specialist, though the report recommends both.',
    fails: ['bone_lesion_orders'],
    loses: [],
    script: solve({ bone: { ...ORACLE.bone, orders: [{ code: 'REF-ORTHO-ONC', priority: 'urgent', start: '2026-11-02' }] } }),
  },
  {
    id: 'cyst_reimaged',
    trap: 'control_ordered',
    why: 'Orders a repeat renal ultrasound in 6 months for the Bosniak I cyst the report says needs none.',
    fails: ['controls_no_orders'],
    loses: [],
    script: solve({ controls: [{ patient: PT.parisian, code: 'IMG-US-KIDNEY', priority: 'routine', start: '2027-04-20' }] }),
  },
  {
    id: 'closed_without_links',
    trap: 'closed_without_link',
    why: 'Does every action but completes items 1, 4, 5 and 6 without linking what closed their loops.',
    fails: ['items_closed_with_links'],
    loses: [],
    script: solve({ link: false }),
  },
  {
    id: 'stat_bmp_from_summary',
    trap: 'order_before_source',
    why: "Acts on item 5 from the inbox row ('potassium 6.2 mmol/L, critical high') without opening the potassium result, so it never checks for hemolysis.",
    fails: ['sources_before_orders'],
    loses: [],
    script: solve({ reads: withoutKd }),
  },
] satisfies Array<Mutant & { loses: readonly string[] }>;
