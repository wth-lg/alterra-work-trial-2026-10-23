// T2's spray, output-gap and status-only agents (the null agent is built into the matrix). Each
// must FAIL. T2 declares the status-only case (task.toml [matrix] status_only): closing every
// item without acting is the failure this task exists to catch.
import type { Script } from '../../../packages/grader/matrix/types.ts';
import { ORACLE, solve } from '../solution/solve.ts';
import { DONE, finish, NOTES, PT, READ_ALL, SRC } from '../solution/steps.ts';

// Orders and pages everything plausible: a second GI referral, on-call for both potassiums, and
// a repeat study for every control. Caught by the GI, hemolysis and control gates.
export const spray: Script = solve({
  fit: { ...ORACLE.fit, newReferral: true },
  hemolyzed: { order: { code: '51990-0', priority: 'stat', start: '2026-10-23' }, oncall: true, message: true },
  controls: [
    { patient: PT.parisian, code: 'IMG-US-KIDNEY', priority: 'routine', start: '2027-04-20' },
    { patient: PT.ondricka, code: '3016-3', priority: 'routine', start: '2027-04-20' },
    { patient: PT.ondricka, code: '57698-3', priority: 'routine', start: '2027-04-20' },
  ],
});

// Five correct notes and a correct summary, and no order, task, message or closure.
const note = (patient: string, text: string, cites: string[]) => ({ name: 'write_note', input: { patient, type: 'progress_note', title: 'Result follow-up', text, cites } });
export const output_gap: Script = [
  ...READ_ALL,
  {
    calls: [
      note(PT.marsh, NOTES.nodule, [SRC.ct, SRC.hp]),
      note(PT.patel, NOTES.fit, [SRC.fit]),
      note(PT.brennan, NOTES.hemolyzed, [SRC.kC]),
      note(PT.holloway, NOTES.critical, [SRC.kD]),
      note(PT.ruiz, NOTES.bone, [SRC.xr]),
    ],
  },
  { calls: [finish(DONE)] },
];

// Reads everything, then completes all 8 items with comments and orders nothing. It links the
// existing GI referral, the one item where linking is the whole action.
export const status_only: Script = solve({
  fit: { ...ORACLE.fit, message: false },
  nodule: { order: null, due: null, message: false },
  hemolyzed: { order: null, oncall: false, message: false },
  critical: { oncall: null, oncallPriority: 'stat', order: null },
  bone: { orders: [], due: null, message: false },
  notes: false,
});
