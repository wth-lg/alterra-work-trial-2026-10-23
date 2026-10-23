// send_message (design section 3): a Communication to a patient, a clinician or a staff pool.
// It is about at most one patient: the recipient if a patient, and every resource in about.
import type { Communication } from '@medplum/fhirtypes';
import { patientRefs } from '../../overlay.ts';
import { key, resolve, samePatient } from './checks.ts';
import { commit } from './commit.ts';
import { USER } from './context.ts';
import { party, priority, refs, text, type PRIORITIES } from './schema.ts';
import { writeTool } from './tool.ts';

type MessageInput = { recipient: string; priority: (typeof PRIORITIES)[number]; subject: string; body: string; about: string[] };

export const sendMessage = writeTool({
  name: 'send_message',
  description:
    'Send a message (a Communication, sent now) to a patient, a clinician (Practitioner) or a staff pool (Group). about lists the resources it concerns, possibly none; ' +
    'they and a patient recipient must all be the same patient. Returns {communication}.',
  inputSchema: {
    type: 'object',
    properties: {
      recipient: party('Recipient: Patient, Practitioner or Group'),
      priority,
      subject: text('Subject line', 200),
      body: text('Message text', 10_000),
      about: refs('What the message is about', 20),
    },
    required: ['recipient', 'priority', 'subject', 'body', 'about'],
    additionalProperties: false,
  },
  run(input: MessageInput, ctx) {
    const recipient = resolve(ctx, 'recipient', input.recipient, ['Patient', 'Practitioner', 'Group']);
    let patient = recipient.resourceType === 'Patient' ? recipient.id : undefined;
    const about = input.about.map((v, i) => {
      const r = resolve(ctx, `about[${i}]`, v);
      patient ??= r.resourceType === 'Patient' ? r.id : [...patientRefs(r)][0];
      if (patient !== undefined) samePatient(`about[${i}]`, r, patient);
      return { reference: key(r) };
    });
    return commit(ctx, 'send_message', (a) => {
      const id = a.id('comm');
      const message: Communication = {
        resourceType: 'Communication',
        id,
        status: 'completed',
        priority: input.priority,
        ...(patient !== undefined ? { subject: { reference: `Patient/${patient}` } } : {}),
        topic: { text: input.subject },
        ...(about.length ? { about } : {}),
        sent: a.stamp,
        recipient: [{ reference: key(recipient) }],
        sender: { reference: USER },
        payload: [{ contentString: input.body }],
      };
      return {
        content: { communication: `Communication/${id}` },
        resources: [{ resource: message, created: true, fields: { subject: ['Communication.topic'], body: ['Communication.payload'] } }],
      };
    });
  },
});
