// T5's spray and output-gap agents (the null agent is built into the matrix). Each must FAIL.
// T5 declares no status-only case: it has no inbox items to close.
import type { Script } from '../../../packages/grader/matrix/types.ts';
import { AT, CODE, ct, creatinineOrder, diphenhydramine, DONE, finish, medication, message, note, prednisone, READS, RX, service } from '../solution/steps.ts';

// Orders every plausible prep and both CTs: over-action, caught by the substitution gate.
export const spray: Script = [
  ...READS,
  { calls: [ct(), service({ code: CODE.ctPlain, reason: 'Backup if contrast is declined' }), creatinineOrder(), creatinineOrder('2026-10-23', null, CODE.bmp)] },
  { calls: [prednisone, diphenhydramine, medication(RX.hydrocortisone100, 200, ['2026-10-26T04:00:00-04:00', AT.p1], 'mg', 'intravenous')] },
  { calls: [message()] },
  { calls: [note()] },
  { calls: [finish(DONE)] },
];

// A complete, correct note and message and no order: state is graded, not prose.
export const output_gap: Script = [...READS, { calls: [message()] }, { calls: [note()] }, { calls: [finish(DONE)] }];
