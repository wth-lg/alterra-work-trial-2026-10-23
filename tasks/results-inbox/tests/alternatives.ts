// Other correct solutions of T2: each must PASS. They vary what a careful clinician might vary:
// the study code (the low-dose CT is a CT chest without contrast), the panel that rechecks
// potassium, how on-call hears (a task instead of a message), priorities above the policy's,
// a stat repeat today instead of an urgent one on Monday, dateTimes instead of dates, holding the
// ACE inhibitor behind the true hyperkalemia, a different read path and one answer for all writes.
import type { Agent } from '../../../packages/grader/matrix/types.ts';
import { ORACLE, solve } from '../solution/solve.ts';
import { activeServiceRequests, inbox, policies, PT, read, searchNotes, SRC } from '../solution/steps.ts';

export const alternatives: Agent[] = [
  {
    id: 'ldct_task_oncall_cmp',
    why: 'Orders the 12-month study as the low-dose CT chest, tells on-call through a stat task in the pool, rechecks the hemolyzed potassium stat today with a CMP, and orders the MRI femur without contrast at asap priority.',
    script: solve({
      nodule: { ...ORACLE.nodule, order: { code: 'IMG-CT-CHEST-LDCT', priority: 'routine', start: '2027-06-04' } },
      hemolyzed: { ...ORACLE.hemolyzed, order: { code: '24323-8', priority: 'stat', start: '2026-10-23' } },
      critical: { ...ORACLE.critical, oncall: 'task' },
      bone: { ...ORACLE.bone, orders: [{ code: 'REF-ORTHO-ONC', priority: 'urgent', start: '2026-10-26' }, { code: 'IMG-MRI-FEMUR-WO', priority: 'asap', start: '2026-10-28' }] },
    }),
  },
  {
    id: 'window_edges_datetimes',
    why: 'Writes the CT window as the whole policy window, 2027-05-04 to 2027-07-04, the tracking task due at its start, the repeat potassium alone at 09:00 on Monday, and the femur orders as dateTimes on the last allowed day, 2026-11-05.',
    script: solve({
      nodule: { order: { code: 'IMG-CT-CHEST-WO', priority: 'routine', start: '2027-05-04', end: '2027-07-04' }, due: '2027-05-04', message: true },
      hemolyzed: { ...ORACLE.hemolyzed, order: { code: '2823-3', priority: 'urgent', start: '2026-10-26T09:00:00-04:00' } },
      bone: {
        ...ORACLE.bone,
        orders: [
          { code: 'IMG-MRI-FEMUR-WWO', priority: 'stat', start: '2026-11-05T17:00:00-05:00' },
          { code: 'REF-ORTHO-ONC', priority: 'urgent', start: '2026-11-05T09:00:00-05:00' },
        ],
      },
    }),
  },
  {
    id: 'hold_lisinopril',
    why: 'Also stops the lisinopril started on 10-06, the likely cause of the true hyperkalemia in CKD 3b, beside the stat page and the stat BMP.',
    script: solve({ critical: { ...ORACLE.critical, holdLisinopril: true } }),
  },
  {
    id: 'searches_then_reads',
    why: 'Reads the policies first, searches notes for smoking across the clinic (finding both Linda Marshes) and reads only the H&P of the right one, searches potassium results instead of reading each, and writes everything in one answer.',
    script: solve({
      reads: [
        { calls: [...policies, inbox] },
        { calls: [searchNotes('smoker'), searchNotes('pack', PT.marsh)] },
        { calls: [read(SRC.ct), read(SRC.hp), read(SRC.us), read(SRC.fit), activeServiceRequests(PT.patel)] },
        {
          calls: [
            { name: 'fhir_search', input: { resource_type: 'Observation', patient: PT.brennan, code: '2823-3', sort: '-date' } },
            { name: 'fhir_search', input: { resource_type: 'Observation', patient: PT.holloway, code: '2823-3', sort: '-date' } },
            read(SRC.xr),
            read(SRC.tsh),
            read(SRC.lipid),
          ],
        },
      ],
      oneAnswer: true,
    }),
  },
];
