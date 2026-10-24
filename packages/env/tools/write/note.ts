// write_note (design section 3): a signed note (DocumentReference, final) whose text is stored
// as a UTF-8 text/plain attachment, the form fhir_read and search_notes decode. cites lists the
// resources the note relies on, and cites_policies the clinic policies it applies (read_policy
// ids; a policy is not a FHIR resource, so it is cited by identifier): both go to
// DocumentReference.context.related and the Provenance sources, so "every output links to its
// source" (design section 3) holds for policies too.
import type { DocumentReference, Reference } from '@medplum/fhirtypes';
import { ToolError } from '../errors.ts';
import { CLINIC } from '../../world.ts';
import { patient as patientSchema } from '../read/schema.ts';
import { key, resolve, samePatient } from './checks.ts';
import { commit } from './commit.ts';
import { USER } from './context.ts';
import { refs, text } from './schema.ts';
import { writeTool } from './tool.ts';

const LOINC = 'http://loinc.org';
export const POLICY_SYSTEM = 'urn:riverbend:policy';
const NOTE_TYPES: Record<string, [code: string, display: string]> = {
  progress_note: ['11506-3', 'Progress note'],
  telephone_note: ['34748-4', 'Telephone encounter Note'],
  consult_note: ['11488-4', 'Consult note'],
  letter: ['51852-2', 'Letter'],
};

function base64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

type NoteInput = { patient: string; type: string; title: string; text: string; cites: string[]; cites_policies?: string[] };

export const writeNote = writeTool({
  name: 'write_note',
  description:
    "Write and sign a note in the patient's chart (a DocumentReference, final). cites lists the resources of the same patient the note relies on, possibly none; " +
    'cites_policies lists the clinic policies the note applies, by read_policy id (e.g. RBC-PHARM-07). ' +
    'Returns {note}.',
  inputSchema: {
    type: 'object',
    properties: {
      patient: patientSchema,
      type: { type: 'string', description: 'Note type', enum: Object.keys(NOTE_TYPES) },
      title: text('Title', 200),
      text: text('Note text (plain text)', 20_000),
      cites: refs('Sources the note relies on', 50),
      cites_policies: { type: 'array', description: 'Policies the note applies, by id', items: { type: 'string', description: 'Policy id, e.g. RBC-PHARM-07', pattern: '^[A-Za-z0-9-]{1,40}$' }, maxItems: 20 },
    },
    required: ['patient', 'type', 'title', 'text', 'cites'],
    additionalProperties: false,
  },
  run(input: NoteInput, ctx) {
    const patient = resolve(ctx, 'patient', input.patient, ['Patient']).id!;
    const cites = input.cites.map((v, i) => {
      if (v.startsWith('Policy/')) {
        throw new ToolError('INVALID_INPUT', `'cites[${i}]': a policy is not a chart resource; cite it by id in cites_policies (e.g. '${v.slice(7)}')`, `cites[${i}]`);
      }
      const r = resolve(ctx, `cites[${i}]`, v);
      samePatient(`cites[${i}]`, r, patient);
      return key(r);
    });
    const policies = (input.cites_policies ?? []).map((v, i): Reference => {
      const p = ctx.policies.find((x) => x.id.toUpperCase() === v.toUpperCase());
      if (!p) throw new ToolError('NOT_FOUND', `'cites_policies[${i}]': no policy '${v}'; read_policy lists them`, `cites_policies[${i}]`);
      return { identifier: { system: POLICY_SYSTEM, value: p.id }, display: `${p.title} (version ${p.version})` };
    });
    const related: Reference[] = [...cites.map((reference) => ({ reference })), ...policies];
    return commit(ctx, 'write_note', (a) => {
      const id = a.id('doc');
      const [code, display] = NOTE_TYPES[input.type]!;
      const note: DocumentReference = {
        resourceType: 'DocumentReference',
        id,
        status: 'current',
        docStatus: 'final',
        type: { coding: [{ system: LOINC, code, display }], text: display },
        category: [{ coding: [{ system: 'http://hl7.org/fhir/us/core/CodeSystem/us-core-documentreference-category', code: 'clinical-note', display: 'Clinical Note' }] }],
        subject: { reference: `Patient/${patient}` },
        date: a.stamp,
        author: [{ reference: USER }],
        authenticator: { reference: USER },
        custodian: { reference: `Organization/${CLINIC}` },
        description: input.title,
        content: [{ attachment: { contentType: 'text/plain; charset=utf-8', data: base64(input.text), title: input.title, creation: a.stamp } }],
        ...(related.length ? { context: { related } } : {}),
      };
      return {
        content: { note: `DocumentReference/${id}` },
        resources: [
          {
            resource: note,
            created: true,
            fields: { title: ['DocumentReference.description', 'DocumentReference.content[0].attachment.title'], text: ['DocumentReference.content[0].attachment.data'] },
          },
        ],
        sources: [...cites, ...policies],
      };
    });
  },
});
