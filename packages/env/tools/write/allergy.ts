// record_allergy (design section 3): create an AllergyIntolerance, or update one in place
// (update_id), e.g. to mark a "no known allergies" entry inactive. substance_code is a
// medication-catalog code (RxNorm), the coding the world's allergies use.
import type { AllergyIntolerance, AllergyIntoleranceReaction } from '@medplum/fhirtypes';
import { ToolError } from '../errors.ts';
import { patient as patientSchema } from '../read/schema.ts';
import { catalogEntry, key, resolve, samePatient } from './checks.ts';
import { commit } from './commit.ts';
import { USER } from './context.ts';
import { idOf, ref, text } from './schema.ts';
import { writeTool } from './tool.ts';

const CLINICAL = 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical';
const VERIFICATION = 'http://terminology.hl7.org/CodeSystem/allergyintolerance-verification';
const SEVERITIES = ['mild', 'moderate', 'severe'] as const;

type AllergyInput = {
  patient: string;
  substance_code: string;
  criticality: 'low' | 'high' | 'unable-to-assess';
  verification: 'unconfirmed' | 'confirmed' | 'refuted' | 'entered-in-error';
  reactions: Array<{ manifestation: string; severity?: (typeof SEVERITIES)[number] }>;
  source?: string;
  update_id?: string;
  clinical_status?: 'active' | 'inactive' | 'resolved';
};

export const recordAllergy = writeTool({
  name: 'record_allergy',
  description:
    'Record a medication allergy or intolerance for a patient, or update an existing one with update_id (same patient). substance_code is a medication code from lookup_catalog. ' +
    'clinical_status defaults to active for a new record and is kept on an update; it must be omitted when verification is entered-in-error. ' +
    'reactions may be empty. source optionally names the resource the information comes from (e.g. the note). Returns {allergy_intolerance}.',
  inputSchema: {
    type: 'object',
    properties: {
      patient: patientSchema,
      substance_code: { type: 'string', description: 'Substance code (RxNorm) from lookup_catalog', minLength: 1, maxLength: 20 },
      criticality: { type: 'string', description: 'Criticality', enum: ['low', 'high', 'unable-to-assess'] },
      verification: { type: 'string', description: 'Verification status', enum: ['unconfirmed', 'confirmed', 'refuted', 'entered-in-error'] },
      reactions: {
        type: 'array',
        description: 'Observed reactions',
        items: {
          type: 'object',
          description: 'One reaction',
          properties: { manifestation: text('What happened, e.g. hives', 200), severity: { type: 'string', description: 'Severity', enum: SEVERITIES } },
          required: ['manifestation'],
          additionalProperties: false,
        },
        maxItems: 10,
      },
      source: ref('Where the information comes from'),
      update_id: idOf('AllergyIntolerance', 'alg-00001', 'The record to update'),
      clinical_status: { type: 'string', description: 'Clinical status', enum: ['active', 'inactive', 'resolved'] },
    },
    required: ['patient', 'substance_code', 'criticality', 'verification', 'reactions'],
    additionalProperties: false,
  },
  run(input: AllergyInput, ctx) {
    const patient = resolve(ctx, 'patient', input.patient, ['Patient']).id!;
    const substance = catalogEntry(ctx, 'substance_code', input.substance_code, ['medication']);
    const erroneous = input.verification === 'entered-in-error';
    if (erroneous && input.clinical_status !== undefined) throw new ToolError('INVALID_INPUT', "'clinical_status' must be omitted when verification is entered-in-error", 'clinical_status');
    let source: string | undefined;
    if (input.source !== undefined) {
      const r = resolve(ctx, 'source', input.source);
      samePatient('source', r, patient);
      source = key(r);
    }
    let existing: Readonly<AllergyIntolerance> | undefined;
    if (input.update_id !== undefined) {
      existing = resolve(ctx, 'update_id', input.update_id, ['AllergyIntolerance']) as Readonly<AllergyIntolerance>;
      samePatient('update_id', existing, patient);
      if (existing.verificationStatus?.coding?.some((c) => c.code === 'entered-in-error')) {
        throw new ToolError('CONFLICT', `'update_id': ${key(existing)} was entered in error and cannot be updated`, 'update_id');
      }
    }
    return commit(ctx, 'record_allergy', (a) => {
      const status = input.clinical_status ?? existing?.clinicalStatus?.coding?.find((c) => c.system === CLINICAL)?.code ?? 'active';
      const reaction: AllergyIntoleranceReaction[] = input.reactions.map((r) => ({ manifestation: [{ text: r.manifestation }], ...(r.severity ? { severity: r.severity } : {}) }));
      // An update keeps what the record holds beyond these fields (onset, notes).
      const { clinicalStatus: _c, reaction: _r, ...kept } = existing ?? { resourceType: 'AllergyIntolerance' as const, patient: { reference: `Patient/${patient}` } };
      const record: AllergyIntolerance = {
        ...kept,
        resourceType: 'AllergyIntolerance',
        id: existing?.id ?? a.id('alg'),
        ...(erroneous ? {} : { clinicalStatus: { coding: [{ system: CLINICAL, code: status }] } }),
        verificationStatus: { coding: [{ system: VERIFICATION, code: input.verification }] },
        type: 'allergy',
        category: ['medication'],
        criticality: input.criticality,
        code: { coding: [{ system: substance.system, code: substance.code, display: substance.display }], text: substance.display },
        patient: { reference: `Patient/${patient}` },
        recordedDate: a.stamp,
        recorder: { reference: USER },
        ...(reaction.length ? { reaction } : {}),
      };
      const fields = Object.fromEntries(input.reactions.map((_, i) => [`reactions[${i}].manifestation`, [`AllergyIntolerance.reaction[${i}].manifestation`]]));
      return {
        content: { allergy_intolerance: key(record) },
        resources: [{ resource: record, created: existing === undefined, fields }],
        ...(source ? { sources: [source] } : {}),
      };
    });
  },
});
