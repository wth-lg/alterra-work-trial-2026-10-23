// The write tools (plan phase P6), in the order the model sees them, and the full tool list:
// the read tools first. Every write goes through the five validation steps (design section 2,
// "Write validation"): the schema in callTool, then semantics and state transitions in the
// tool, then Medplum validation and the invariants in commit.ts.
import { READ_TOOLS } from '../read/index.ts';
import type { Tool } from '../registry.ts';
import { recordAllergy } from './allergy.ts';
import type { WriteContext } from './context.ts';
import { finish } from './finish.ts';
import { changeMedication, orderMedication } from './medication.ts';
import { sendMessage } from './message.ts';
import { writeNote } from './note.ts';
import { orderService } from './service.ts';
import { createTask, updateInboxItem } from './task.ts';

export { commit, type Allocation, type Draft, type Written } from './commit.ts';
export { newSession, USER, type WriteContext, type WriteSession } from './context.ts';

export const WRITE_TOOLS: readonly Tool<WriteContext>[] = [
  orderMedication,
  changeMedication,
  orderService,
  createTask,
  sendMessage,
  recordAllergy,
  writeNote,
  updateInboxItem,
  finish,
];

export const TOOLS: readonly Tool<WriteContext>[] = [...READ_TOOLS, ...WRITE_TOOLS];
