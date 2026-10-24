// record_allergy (design section 3): create an AllergyIntolerance, or update one in place
// (update_id). An update changes only the fields the call gives and keeps the rest (code,
// category, type, criticality, reactions, recordedDate), so marking a coded "no known drug
// allergy" entry inactive or entered-in-error leaves it what it is. A substance is an RxNorm
// code (ingredient or product) or a SNOMED CT substance code, from the catalog or already used
// in the world's allergies and medication requests; reactions are SNOMED-coded manifestations
// (preferred) or text.
import type { AllergyIntolerance, AllergyIntoleranceReaction, CodeableConcept } from '@medplum/fhirtypes';
import { ToolError } from '../errors.ts';
import { patient as patientSchema } from '../read/schema.ts';
import { key, resolve, samePatient } from './checks.ts';
import { commit } from './commit.ts';
import { USER, type WriteContext } from './context.ts';
import { idOf, ref, text } from './schema.ts';
import { writeTool } from './tool.ts';

const CLINICAL = 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical';
const VERIFICATION = 'http://terminology.hl7.org/CodeSystem/allergyintolerance-verification';
const RXNORM = 'http://www.nlm.nih.gov/research/umls/rxnorm';
const SNOMED = 'http://snomed.info/sct';
const SEVERITIES = ['mild', 'moderate', 'severe'] as const;
const CATEGORIES = ['food', 'medication', 'environment', 'biologic'] as const;
type Category = (typeof CATEGORIES)[number];

// SNOMED CT clinical findings for reaction manifestations: common drug and food reactions, and
// every manifestation the world's allergies use.
const MANIFESTATIONS: Record<string, string> = {
  '126485001': 'Urticaria',
  '41291007': 'Angioedema',
  '402387002': 'Allergic angioedema',
  '39579001': 'Anaphylaxis',
  '271807003': 'Eruption of skin',
  '247472004': 'Wheal',
  '418290006': 'Itching',
  '21626009': 'Cutaneous hypersensitivity',
  '70819003': 'Erythema',
  '40275004': 'Contact dermatitis',
  '56018004': 'Wheezing',
  '267036007': 'Dyspnea',
  '49727002': 'Cough',
  '76067001': 'Sneezing',
  '878820003': 'Rhinoconjunctivitis',
  '45007003': 'Low blood pressure',
  '422587007': 'Nausea',
  '422400008': 'Vomiting',
  '300359004': 'Finding of vomiting',
  '62315008': 'Diarrhea',
  '21522001': 'Abdominal pain',
  '68962001': 'Muscle pain',
  '25064002': 'Headache',
  '404640003': 'Dizziness',
  '73442001': 'Stevens-Johnson syndrome',
  '702809001': 'Drug reaction with eosinophilia and systemic symptoms',
};

type ReactionInput = { manifestation_code?: string; manifestation?: string; severity?: (typeof SEVERITIES)[number] };
type AllergyInput = {
  patient: string;
  update_id?: string;
  substance_code?: string;
  type?: 'allergy' | 'intolerance';
  category?: Category;
  criticality?: 'low' | 'high' | 'unable-to-assess';
  verification?: 'unconfirmed' | 'confirmed' | 'refuted' | 'entered-in-error';
  clinical_status?: 'active' | 'inactive' | 'resolved';
  reactions?: ReactionInput[];
  source?: string;
};

// The substance a code names, and the category an allergy to it has had in this world: the
// catalog first, then the world's allergies (RxNorm or SNOMED), then its medication requests.
function substance(ctx: WriteContext, code: string): { concept: CodeableConcept; system: string; category?: Category } {
  const entry = ctx.catalog.find((e) => e.kind === 'medication' && e.code === code);
  const allergies = ctx.world.search<AllergyIntolerance>('AllergyIntolerance', { code }).resources;
  const category = allergies.flatMap((a) => a.category ?? [])[0];
  if (entry) return { concept: { coding: [{ system: entry.system, code, display: entry.display }], text: entry.display }, system: entry.system, ...(category ? { category } : {}) };
  const coded = [...allergies.map((a) => a.code), ...ctx.world.search('MedicationRequest', { code }).resources.map((m) => (m as { medicationCodeableConcept?: CodeableConcept }).medicationCodeableConcept)]
    .flatMap((c) => c?.coding ?? [])
    .find((c) => c.code === code && (c.system === RXNORM || c.system === SNOMED));
  if (!coded) {
    throw new ToolError('INVALID_INPUT', `'substance_code': '${code}' is not a medication in the catalog or an allergen code in use; find a drug with lookup_catalog (kind medication)`, 'substance_code');
  }
  return { concept: { coding: [{ system: coded.system!, code, display: coded.display! }], text: coded.display! }, system: coded.system!, ...(category ? { category } : {}) };
}

function reaction(r: ReactionInput): AllergyIntoleranceReaction {
  const manifestation: CodeableConcept = {
    ...(r.manifestation_code !== undefined ? { coding: [{ system: SNOMED, code: r.manifestation_code, display: MANIFESTATIONS[r.manifestation_code]! }] } : {}),
    text: r.manifestation ?? MANIFESTATIONS[r.manifestation_code!]!,
  };
  return { manifestation: [manifestation], ...(r.severity ? { severity: r.severity } : {}) };
}

export const recordAllergy = writeTool({
  name: 'record_allergy',
  description:
    'Record an allergy or intolerance for a patient, or update an existing one with update_id (same patient). ' +
    'A new record needs substance_code, criticality and verification. substance_code is an RxNorm drug code (ingredient or product) from lookup_catalog, ' +
    'or an RxNorm or SNOMED CT allergen code already used in the chart (e.g. on another AllergyIntolerance). type defaults to allergy; category defaults to medication for a drug. ' +
    'An update changes only the fields given and keeps the rest, e.g. {patient, update_id, clinical_status: inactive} marks a "no known drug allergy" entry inactive. ' +
    'clinical_status defaults to active for a new record; it must be omitted when verification is entered-in-error. ' +
    'Each reaction has manifestation_code (SNOMED CT, preferred) and/or manifestation text, and an optional severity. ' +
    'source optionally names the resource the information comes from (e.g. the note). Returns {allergy_intolerance}.',
  inputSchema: {
    type: 'object',
    properties: {
      patient: patientSchema,
      update_id: idOf('AllergyIntolerance', 'alg-00001', 'The record to update'),
      substance_code: { type: 'string', description: 'RxNorm or SNOMED CT code of the substance, e.g. 723 (amoxicillin)', pattern: '^[0-9]{1,18}$' },
      type: { type: 'string', description: 'allergy (immune-mediated) or intolerance', enum: ['allergy', 'intolerance'] },
      category: { type: 'string', description: 'Category of the substance', enum: CATEGORIES },
      criticality: { type: 'string', description: 'Criticality', enum: ['low', 'high', 'unable-to-assess'] },
      verification: { type: 'string', description: 'Verification status', enum: ['unconfirmed', 'confirmed', 'refuted', 'entered-in-error'] },
      clinical_status: { type: 'string', description: 'Clinical status', enum: ['active', 'inactive', 'resolved'] },
      reactions: {
        type: 'array',
        description: 'Observed reactions; on an update, the full new list (omit to keep the current reactions)',
        items: {
          type: 'object',
          description: 'One reaction: manifestation_code and/or manifestation',
          properties: {
            manifestation_code: {
              type: 'string',
              description: `SNOMED CT manifestation: ${Object.entries(MANIFESTATIONS).map(([c, d]) => `${c} ${d}`).join('; ')}`,
              enum: Object.keys(MANIFESTATIONS),
            },
            manifestation: text('What happened, in words, e.g. hives and lip swelling', 200),
            severity: { type: 'string', description: 'Severity', enum: SEVERITIES },
          },
          additionalProperties: false,
        },
        maxItems: 10,
      },
      source: ref('Where the information comes from'),
    },
    required: ['patient'],
    additionalProperties: false,
  },
  run(input: AllergyInput, ctx) {
    const patient = resolve(ctx, 'patient', input.patient, ['Patient']).id!;
    let existing: Readonly<AllergyIntolerance> | undefined;
    if (input.update_id !== undefined) {
      existing = resolve(ctx, 'update_id', input.update_id, ['AllergyIntolerance']) as Readonly<AllergyIntolerance>;
      samePatient('update_id', existing, patient);
      if (existing.verificationStatus?.coding?.some((c) => c.code === 'entered-in-error')) {
        throw new ToolError('CONFLICT', `'update_id': ${key(existing)} was entered in error and cannot be updated`, 'update_id');
      }
    } else {
      for (const field of ['substance_code', 'criticality', 'verification'] as const) {
        if (input[field] === undefined) throw new ToolError('INVALID_INPUT', `'${field}' is required for a new allergy (give update_id to update one)`, field);
      }
    }
    const sub = input.substance_code === undefined ? undefined : substance(ctx, input.substance_code);
    // A new substance brings its category (the world's, or medication for a drug); otherwise the
    // record keeps its own, which R4 allows to be absent on an existing record.
    const given = input.category ?? (sub ? (sub.category ?? (sub.system === RXNORM ? 'medication' : undefined)) : undefined);
    const category = given ? [given] : existing?.category;
    if (category === undefined && !existing) throw new ToolError('INVALID_INPUT', `'category' is required for ${sub!.concept.text}: food, medication, environment or biologic`, 'category');
    const type = input.type ?? (existing ? existing.type : 'allergy');
    const criticality = input.criticality ?? existing?.criticality;
    (input.reactions ?? []).forEach((r, i) => {
      if (r.manifestation_code === undefined && r.manifestation === undefined) {
        throw new ToolError('INVALID_INPUT', `'reactions[${i}]' needs manifestation_code (SNOMED CT, preferred) or manifestation text`, `reactions[${i}]`);
      }
    });
    const verification = input.verification ?? existing?.verificationStatus?.coding?.find((c) => c.system === VERIFICATION)?.code;
    const erroneous = verification === 'entered-in-error';
    if (erroneous && input.clinical_status !== undefined) throw new ToolError('INVALID_INPUT', "'clinical_status' must be omitted when verification is entered-in-error", 'clinical_status');
    let source: string | undefined;
    if (input.source !== undefined) {
      const r = resolve(ctx, 'source', input.source);
      samePatient('source', r, patient);
      source = key(r);
    }
    return commit(ctx, 'record_allergy', (a) => {
      const status = input.clinical_status ?? existing?.clinicalStatus?.coding?.find((c) => c.system === CLINICAL)?.code ?? 'active';
      const reactions = input.reactions?.map(reaction);
      // An update keeps everything the call does not give (onset, notes, recordedDate, recorder).
      const { clinicalStatus: _c, reaction: _r, ...kept } = existing ?? { resourceType: 'AllergyIntolerance' as const, patient: { reference: `Patient/${patient}` } };
      const record: AllergyIntolerance = {
        ...kept,
        resourceType: 'AllergyIntolerance',
        id: existing?.id ?? a.id('alg'),
        ...(erroneous ? {} : { clinicalStatus: { coding: [{ system: CLINICAL, code: status }] } }),
        verificationStatus: { coding: [{ system: VERIFICATION, code: verification! }] },
        ...(type ? { type } : {}),
        ...(category ? { category } : {}),
        ...(criticality ? { criticality } : {}),
        code: sub?.concept ?? existing!.code!,
        patient: { reference: `Patient/${patient}` },
        ...(existing ? {} : { recordedDate: a.stamp, recorder: { reference: USER } }),
        ...((reactions ?? existing?.reaction)?.length ? { reaction: reactions ?? existing!.reaction! } : {}),
      };
      const fields = Object.fromEntries((input.reactions ?? []).map((_, i) => [`reactions[${i}].manifestation`, [`AllergyIntolerance.reaction[${i}].manifestation`]]));
      return {
        content: { allergy_intolerance: key(record) },
        resources: [{ resource: record, created: existing === undefined, fields }],
        ...(source ? { sources: [source] } : {}),
      };
    });
  },
});
