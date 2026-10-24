// list_inbox (design section 3): the work queues, backed by Tasks whose code is
// INBOX_QUEUE_SYSTEM|<queue>. Rows are pointers: a one-line summary and status, with the
// result or message to act on left in the focus, so the Task, its focus and patient are
// referenced, not exposed (the exposure rule, registry.ts).
import type { Task } from '@medplum/fhirtypes';
import type { Tool } from '../registry.ts';
import { INBOX_QUEUE_SYSTEM, INBOX_QUEUES, type ReadContext } from './context.ts';
import { page } from './page.ts';
import { count, offset } from './schema.ts';

// FHIR R4 Task.status.
const TASK_STATUSES = [
  'draft', 'requested', 'received', 'accepted', 'rejected', 'ready', 'cancelled', 'in-progress', 'on-hold', 'failed', 'completed', 'entered-in-error',
] as const;

// Received instant; an item without a parseable one sorts last.
const received = (t: Readonly<Task>) => {
  const ms = t.authoredOn === undefined ? NaN : Date.parse(t.authoredOn);
  return Number.isNaN(ms) ? Infinity : ms;
};

export const listInbox: Tool<ReadContext> = {
  name: 'list_inbox',
  description:
    'List a work queue: results or messages. Returns {task, focus, patient, received, from, summary, status} rows, oldest first, ties by id. ' +
    'status filters by Task status (e.g. requested for open items).',
  inputSchema: {
    type: 'object',
    properties: {
      queue: { type: 'string', description: 'Queue to list', enum: INBOX_QUEUES },
      status: { type: 'string', description: 'Task status', enum: TASK_STATUSES },
      count: count(50, 20),
      offset,
    },
    required: ['queue'],
    additionalProperties: false,
  },
  run(input: { queue: string; status?: string; count?: number; offset?: number }, { world }) {
    const query: Record<string, string> = { code: `${INBOX_QUEUE_SYSTEM}|${input.queue}` };
    if (input.status !== undefined) query.status = input.status;
    const rows = [...world.search<Task>('Task', query).resources]
      .sort((a, b) => received(a) - received(b) || (a.id! < b.id! ? -1 : a.id! > b.id! ? 1 : 0))
      .map((t) => ({
        task: `Task/${t.id}`,
        focus: t.focus?.reference ?? null,
        patient: t.for?.reference ?? null,
        received: t.authoredOn ?? null,
        from: t.requester?.reference ?? null,
        summary: t.description ?? null,
        status: t.status,
      }));
    return page(rows, input.offset ?? 0, input.count ?? 20);
  },
};
