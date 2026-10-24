// T3's spray and output-gap agents (the null agent is built into the matrix). Each must FAIL.
// T3 declares no status-only case: it has no inbox items to close.
import type { Script } from '../../../packages/grader/matrix/types.ts';
import { finish, MEMBERS, orderFit, outreach, reads } from '../solution/steps.ts';

// Orders a FIT kit and messages every panel member: over-action, caught by G1 and G3.
export const spray: Script = [...reads(), { calls: MEMBERS.flatMap((p) => [orderFit(p), outreach(p)]) }, { calls: [finish()] }];

// A complete, correct table and no order or message: state is graded, not prose.
export const output_gap: Script = [...reads(), { calls: [finish()] }];
