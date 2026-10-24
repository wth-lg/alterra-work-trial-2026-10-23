// create_task and update_inbox_item (design section 3). Inbox items are Tasks whose code is
// INBOX_QUEUE_SYSTEM|<queue>, the convention list_inbox reads (read/context.ts); create_task
// makes follow-up Tasks without that code, so they never appear in a queue.
import type { Task } from '@medplum/fhirtypes';
import { ToolError } from '../errors.ts';
import { INBOX_QUEUE_SYSTEM } from '../read/context.ts';
import { patient as patientSchema } from '../read/schema.ts';
import { key, resolve, samePatient, when } from './checks.ts';
import { commit } from './commit.ts';
import { USER } from './context.ts';
import { idOf, party, priority, ref, refs, text, when as whenSchema, type PRIORITIES } from './schema.ts';
import { writeTool } from './tool.ts';

// Who can own work: a clinician or a staff pool (pools are Groups in this world).
const OWNERS = ['Practitioner', 'Group'];

type CreateInput = { patient: string; owner: string; due: string; priority: (typeof PRIORITIES)[number]; description: string; focus?: string };

export const createTask = writeTool({
  name: 'create_task',
  description:
    'Create a follow-up, tracking or routing Task (status requested) for a patient, owned by a clinician (Practitioner, e.g. pr-lin) or a staff pool (Group, e.g. pool-rn-triage). ' +
    'due is a date or dateTime, not in the past. focus optionally names the resource of the same patient the task is about. Returns {task}.',
  inputSchema: {
    type: 'object',
    properties: {
      patient: patientSchema,
      owner: party('Owner (Practitioner or Group)'),
      due: whenSchema('Due by'),
      priority,
      description: text('What needs to be done', 2000),
      focus: ref('What the task is about'),
    },
    required: ['patient', 'owner', 'due', 'priority', 'description'],
    additionalProperties: false,
  },
  run(input: CreateInput, ctx) {
    const patient = resolve(ctx, 'patient', input.patient, ['Patient']).id!;
    const owner = resolve(ctx, 'owner', input.owner, OWNERS);
    const due = when('due', input.due);
    let focus: string | undefined;
    if (input.focus !== undefined) {
      const r = resolve(ctx, 'focus', input.focus);
      samePatient('focus', r, patient);
      focus = key(r);
    }
    return commit(ctx, 'create_task', (a) => {
      const id = a.id('task');
      const task: Task = {
        resourceType: 'Task',
        id,
        status: 'requested',
        intent: 'order',
        priority: input.priority,
        description: input.description,
        ...(focus ? { focus: { reference: focus } } : {}),
        for: { reference: `Patient/${patient}` },
        authoredOn: a.stamp,
        lastModified: a.stamp,
        requester: { reference: USER },
        owner: { reference: key(owner) },
        restriction: { period: { end: due.fhir } },
      };
      return { content: { task: `Task/${id}` }, resources: [{ resource: task, created: true, fields: { description: ['Task.description'] } }] };
    });
  },
});

const OPEN = ['draft', 'requested', 'received', 'accepted', 'ready', 'in-progress', 'on-hold'];
type InboxAction = 'complete' | 'reassign' | 'cancel' | 'reject';
// The open statuses each action applies to and the status it leaves (the informative FHIR R4 Task
// state machine): a draft is not yet requested and an on-hold item must be resumed before it is
// completed; only an item not yet under way can be rejected.
const INBOX_TRANSITIONS: Record<InboxAction, { from: readonly string[]; to?: Task['status'] }> = {
  complete: { from: ['requested', 'received', 'accepted', 'ready', 'in-progress'], to: 'completed' },
  reassign: { from: OPEN },
  cancel: { from: OPEN, to: 'cancelled' },
  reject: { from: ['requested', 'received', 'ready'], to: 'rejected' },
};

type UpdateInput = { task_id: string; action: InboxAction; linked?: string[]; new_owner?: string; reason?: string; comment?: string };

export const updateInboxItem = writeTool({
  name: 'update_inbox_item',
  description:
    'Complete, reassign, cancel or reject an open inbox item (a Task from list_inbox). complete closes it (from requested, received, accepted, ready or in-progress); ' +
    'linked names the resources of the same patient that close the loop (the order, task, message or existing result). ' +
    'reassign hands it to new_owner (a Practitioner or Group) and leaves it open. cancel withdraws it (e.g. a duplicate); reject declines it (requested, received or ready); ' +
    'both need reason. comment is added as a note. A closed item, or an action its status does not allow, returns CONFLICT. Returns {task, status}.',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: idOf('Task', 'task-00001', 'Inbox item'),
      action: { type: 'string', description: 'complete, reassign, cancel or reject', enum: Object.keys(INBOX_TRANSITIONS) },
      linked: refs('Resources that close the loop (complete only)', 20),
      new_owner: party('New owner (reassign only): Practitioner or Group'),
      reason: text('Why the item is cancelled or rejected (cancel and reject only)', 500),
      comment: text('A note on the item', 2000),
    },
    required: ['task_id', 'action'],
    additionalProperties: false,
  },
  run(input: UpdateInput, ctx) {
    const item = resolve(ctx, 'task_id', input.task_id, ['Task']) as Readonly<Task>;
    if (!item.code?.coding?.some((c) => c.system === INBOX_QUEUE_SYSTEM)) {
      throw new ToolError('INVALID_INPUT', `'task_id': ${key(item)} is not an inbox item (list_inbox lists them)`, 'task_id');
    }
    if (input.action === 'reassign' && input.new_owner === undefined) throw new ToolError('INVALID_INPUT', "'new_owner' is required for reassign", 'new_owner');
    if (input.action !== 'reassign' && input.new_owner !== undefined) throw new ToolError('INVALID_INPUT', "'new_owner' is only for reassign", 'new_owner');
    if (input.action !== 'complete' && input.linked !== undefined) throw new ToolError('INVALID_INPUT', "'linked' is only for complete", 'linked');
    const needsReason = input.action === 'cancel' || input.action === 'reject';
    if (needsReason && input.reason === undefined) throw new ToolError('INVALID_INPUT', `'reason' is required for ${input.action}`, 'reason');
    if (!needsReason && input.reason !== undefined) throw new ToolError('INVALID_INPUT', "'reason' is only for cancel and reject", 'reason');
    const owner = input.new_owner === undefined ? undefined : resolve(ctx, 'new_owner', input.new_owner, OWNERS);
    const patient = item.for?.reference?.startsWith('Patient/') ? item.for.reference.slice(8) : undefined;
    const linked = (input.linked ?? []).map((v, i) => {
      const r = resolve(ctx, `linked[${i}]`, v);
      if (patient !== undefined) samePatient(`linked[${i}]`, r, patient);
      return key(r);
    });
    if (!OPEN.includes(item.status)) throw new ToolError('CONFLICT', `'task_id': ${key(item)} is already ${item.status}`, 'task_id');
    const { from, to } = INBOX_TRANSITIONS[input.action];
    if (!from.includes(item.status)) throw new ToolError('CONFLICT', `cannot ${input.action} ${key(item)}: it is ${item.status} (${input.action} applies to ${from.join(', ')})`, 'action');
    return commit(ctx, 'update_inbox_item', (a) => {
      const notes = item.note ?? [];
      const updated: Task = {
        ...item,
        ...(to ? { status: to } : {}),
        ...(owner ? { owner: { reference: key(owner) } } : {}),
        ...(input.reason !== undefined ? { statusReason: { text: input.reason } } : {}),
        lastModified: a.stamp,
        ...(linked.length ? { output: [...(item.output ?? []), ...linked.map((reference) => ({ type: { text: 'linked' }, valueReference: { reference } }))] } : {}),
        ...(input.comment !== undefined ? { note: [...notes, { text: input.comment, time: a.stamp, authorReference: { reference: USER } }] } : {}),
      };
      return {
        content: { task: key(item), status: updated.status },
        resources: [{ resource: updated, created: false, fields: { comment: [`Task.note[${notes.length}]`], reason: ['Task.statusReason'] } }],
      };
    });
  },
});
