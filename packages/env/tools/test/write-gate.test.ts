// The P6 gate over the write tools (plan phase P6):
//   - a schema-driven generator makes >= 100 valid calls per write tool, every one commits, and
//     every resource a call writes passes Medplum's validateResource (checked here directly,
//     apart from packages/env/validate.ts);
//   - each committed write creates exactly one Provenance, whose targets are the call's other
//     written ids;
//   - created ids run <prefix>-t0001..N in commit order and are identical on a second run;
//   - every coded element a call writes is in its R4 required value set, checked here from the
//     R4 value sets in @medplum/definitions and the bindings in the pruned definitions, apart
//     from validate.ts's own table (Medplum's validateResource does not check codes);
//   - every mutated call is rejected with is_error, names the mutated field, and leaves the
//     state hash, the store and the write sequence unchanged;
//   - replaying a recorded mixed tool log on a fresh store reproduces every result and the
//     final hash.
// The generator walks each tool's inputSchema; a provider per property name supplies values
// that exist in the world (patients, codes, references of the same patient), and a rule per
// tool enforces the cross-field constraints a schema cannot state.
import { readFileSync } from 'node:fs';
import { indexStructureDefinitionBundle, normalizeErrorString, validateResource } from '@medplum/core';
import type { AllergyIntolerance, Bundle, CodeSystem, CodeSystemConcept, MedicationRequest, Provenance, Resource, ServiceRequest, StructureDefinition, Task, ValueSet } from '@medplum/fhirtypes';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clock } from '../../clock.ts';
import { parseNdjson } from '../../fixture-source.ts';
import { stateHash } from '../../hash.ts';
import { patientRefs } from '../../overlay.ts';
import { Store } from '../../store.ts';
import { indexDefinitions } from '../../validate.ts';
import { INBOX_QUEUE_SYSTEM, type CatalogEntry, type Policy } from '../read/index.ts';
import { callTool, type ObjectSchema, type PropertySchema, type ToolResult } from '../registry.ts';
import { newSession, TOOLS, WRITE_TOOLS, type WriteContext as Context } from '../write/index.ts';

// The trial's store is a whole Store; the tools see only get, search and put.
type WriteContext = Context & { world: Store };

const root = new URL('../../../../', import.meta.url);
const base = await parseNdjson(readFileSync(new URL('fixtures/world.ndjson.gz', root)));
const definitions = JSON.parse(readFileSync(new URL('fixtures/definitions-pruned.json', root), 'utf8')) as Bundle;
beforeAll(() => {
  indexDefinitions(definitions);
  indexStructureDefinitionBundle(definitions);
});

const RXNORM = 'http://www.nlm.nih.gov/research/umls/rxnorm';
const CATALOG: CatalogEntry[] = [
  ...[
    ['860975', 'metformin hydrochloride 500 MG Oral Tablet'],
    ['197361', 'amlodipine 5 MG Oral Tablet'],
    ['1364435', 'apixaban 2.5 MG Oral Tablet'],
    ['866436', '24 HR metoprolol succinate 50 MG Extended Release Oral Tablet'],
    ['310431', 'gabapentin 300 MG Oral Capsule'],
    ['628958', 'potassium chloride 20 MEQ Extended Release Oral Tablet'],
    ['723', 'amoxicillin'],
    ['7980', 'penicillin G'],
    ['1191', 'aspirin'],
  ].map(
    ([code, display]): CatalogEntry => ({ kind: 'medication', code: code!, system: RXNORM, display: display! }),
  ),
  { kind: 'lab', code: '2160-0', system: 'http://loinc.org', display: 'Creatinine [Mass/volume] in Serum or Plasma' },
  { kind: 'lab', code: '24323-8', system: 'http://loinc.org', display: 'Comprehensive metabolic panel' },
  { kind: 'imaging', code: 'IMG-CT-CHEST-WO', system: 'urn:riverbend:orders', display: 'CT chest without contrast' },
  { kind: 'referral', code: 'REF-GI', system: 'urn:riverbend:orders', display: 'Referral to gastroenterology' },
];
const POLICIES: Policy[] = ['RBC-PHARM-07', 'RBC-MED-04'].map((id) => ({ id, title: id, version: '1', effective: '2026-01-01', source: 'environment-local', text: 'Text.' }));
const PATIENTS = base.filter((r) => r.resourceType === 'Patient').map((r) => r.id!);
// 150 open inbox items across the patients, so >= 100 completions find an open one.
const INBOX: Task[] = Array.from({ length: 150 }, (_, i) => ({
  resourceType: 'Task',
  id: `task-g-${String(i).padStart(3, '0')}`,
  status: 'requested',
  intent: 'order',
  code: { coding: [{ system: INBOX_QUEUE_SYSTEM, code: i % 2 ? 'messages' : 'results' }] },
  for: { reference: `Patient/${PATIENTS[i % PATIENTS.length]}` },
  authoredOn: '2026-10-22T09:00:00-04:00',
  description: `item ${i}`,
}));

const fresh = (): WriteContext => ({ world: new Store([...base, ...INBOX]), clock, policies: POLICIES, catalog: CATALOG, session: newSession() });

// mulberry32, seeded so a failing call can be reproduced from its seed and index.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
type Rnd = () => number;
const pick = <T>(rnd: Rnd, xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
const WORDS = ['follow', 'up', 'renal', 'dose', 'review', 'results', 'call', 'patient', 'repeat', 'in', 'weeks', 'µg', 'ok', '—', 'plan', 'BMP'];
const words = (rnd: Rnd, n: number) => Array.from({ length: n }, () => pick(rnd, WORDS)).join(' ');
const pad = (n: number) => String(n).padStart(2, '0');
// A future date or dateTime (with or without seconds, a few offsets), up to about 2 years out.
function future(rnd: Rnd, dateOnly = rnd() < 0.4, minDays = 1): string {
  const days = minDays + Math.floor(rnd() * 700);
  const d = new Date(Date.UTC(2026, 9, 23 + days));
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  if (dateOnly) return date;
  const time = `${pad(Math.floor(rnd() * 24))}:${pad(Math.floor(rnd() * 60))}${rnd() < 0.5 ? `:${pad(Math.floor(rnd() * 60))}` : ''}`;
  return `${date}T${time}${pick(rnd, ['-04:00', '-05:00', 'Z', '+01:00'])}`;
}

// ---- state-aware pools ----

// A single-ingredient tablet or capsule product, read from its RxNorm name the way a pharmacist
// would: the dose must be whole units, or half tablets of an immediate-release tablet.
function solid(display: string | undefined): { strength: number; unit: string; form: string; step: number } | undefined {
  if (display === undefined || /[/{}]|\b(Pack|Kit)\b/i.test(display)) return undefined;
  const s = [...display.matchAll(/\b(\d+(?:\.\d+)?) (MG|MCG|MEQ|G)\b/gi)];
  const f = /\b(Tablet|Capsule)\b/i.exec(display);
  if (s.length !== 1 || !f) return undefined;
  const u = s[0]![2]!.toUpperCase();
  const form = f[1]!.toLowerCase();
  const modified = /\b(\d+ HR|Extended Release|Delayed Release|Sustained Release|Controlled Release|Disintegrating|ER|XR|SR|DR|CR|XL)\b/i.test(display);
  return { strength: Number(s[0]![1]) * ({ G: 1000, MG: 1, MCG: 0.001, MEQ: 1 } as Record<string, number>)[u]!, unit: u === 'MEQ' ? 'meq' : 'mg', form, step: form === 'tablet' && !modified ? 0.5 : 1 };
}
// A dose of `display` the product rule accepts, as {value, unit}; undefined for a product with no
// unit strength (any dose is accepted).
function doseFor(rnd: Rnd, display: string | undefined): { value: number; unit: string } | undefined {
  const p = solid(display);
  if (!p) return undefined;
  const n = p.step * (1 + Math.floor(rnd() * (p.step === 0.5 ? 6 : 3)));
  return rnd() < 0.3 ? { value: n, unit: `{${p.form}}` } : { value: Math.round(n * p.strength * 1e6) / 1e6, unit: p.unit };
}
const PRN = (f: unknown) => typeof f === 'string' && f.endsWith('_PRN');
const AS_NEEDED = ['pain', 'nausea', 'wheeze', 'insomnia', 'anxiety — acute'];

const patientOf = (r: Readonly<Resource>): string | undefined => (r.resourceType === 'Patient' ? r.id : [...patientRefs(r)][0]);
const all = <T extends Resource>(c: WriteContext, type: string) => [...c.world.search<T>(type, {}).resources];
const REF_TYPES = ['Observation', 'Condition', 'DocumentReference', 'DiagnosticReport', 'MedicationRequest', 'Procedure', 'Encounter'];
function refsOf(c: WriteContext, patient: string, types = REF_TYPES): string[] {
  return types.flatMap((t) => c.world.search(t, { patient }).resources.map((r) => `${t}/${r.id}`));
}
const someRefs = (rnd: Rnd, refs: string[], max: number) => Array.from({ length: Math.floor(rnd() * (max + 1)) }, () => pick(rnd, refs)).filter((r, i, a) => r && a.indexOf(r) === i);
const OWNERS = ['pr-okafor', 'Practitioner/pr-lin', 'pr-reyes', 'Group/pool-oncall', 'pool-rn-triage', 'pool-scheduling'];
const asRef = (rnd: Rnd, type: string, id: string) => (rnd() < 0.5 ? `${type}/${id}` : id);

// Per-call scratch the providers share, so references agree on one patient.
interface Scratch {
  patient: string;
}

type Provider = (rnd: Rnd, c: WriteContext, s: Scratch, schema: PropertySchema) => unknown;
const PROVIDERS: Record<string, Provider> = {
  patient: (rnd, _c, s) => asRef(rnd, 'Patient', s.patient),
  rxnorm_code: (rnd, c) => pick(rnd, c.catalog.filter((e) => e.kind === 'medication')).code,
  // A drug from the catalog, or an allergen code (SNOMED or RxNorm) already used in the world.
  substance_code: (rnd, c) => (rnd() < 0.6 ? pick(rnd, c.catalog.filter((e) => e.kind === 'medication')).code : pick(rnd, all<AllergyIntolerance>(c, 'AllergyIntolerance').map((a) => a.code!.coding![0]!.code!))),
  medication_code: () => undefined,
  as_needed_reason: () => undefined,
  cites_policies: (rnd, c) => someRefs(rnd, c.policies.map((p) => p.id), 2),
  code: (rnd, c) => pick(rnd, c.catalog.filter((e) => e.kind !== 'medication')).code,
  dose_value: (rnd) => pick(rnd, [0.5, 1, 2.5, 5, 10, 25, 81, 500, 1000, Math.round(rnd() * 10000) / 100 + 0.01]),
  value: (rnd) => pick(rnd, [0.25, 1, 20, 40, 200]),
  timing_events: (rnd) => Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => future(rnd, false)),
  occurrence_start: (rnd) => future(rnd),
  due: (rnd) => future(rnd),
  replaces: () => undefined,
  update_id: () => undefined,
  supporting: (rnd, c, s) => someRefs(rnd, refsOf(c, s.patient), 3),
  based_on: (rnd, c, s) => someRefs(rnd, refsOf(c, s.patient, ['MedicationRequest', 'ServiceRequest']), 2),
  owner: (rnd) => pick(rnd, OWNERS),
  new_owner: (rnd) => pick(rnd, OWNERS),
  focus: (rnd, c, s) => pick(rnd, [...refsOf(c, s.patient), `Patient/${s.patient}`]),
  about: (rnd, c, s) => someRefs(rnd, refsOf(c, s.patient), 3),
  cites: (rnd, c, s) => someRefs(rnd, refsOf(c, s.patient), 4),
  linked: (rnd, c, s) => someRefs(rnd, refsOf(c, s.patient, [...REF_TYPES, 'ServiceRequest', 'Communication', 'Task']), 3),
  source: (rnd, c, s) => pick(rnd, refsOf(c, s.patient, ['DocumentReference', 'DiagnosticReport'])),
};

// The schema walk: required properties always, optional ones half the time; a provider by
// property name when there is one, otherwise a value of the schema's type and bounds.
function fromSchema(rnd: Rnd, c: WriteContext, s: Scratch, name: string, schema: PropertySchema): unknown {
  const provider = PROVIDERS[name];
  if (provider) return provider(rnd, c, s, schema);
  switch (schema.type) {
    case 'string': {
      if (schema.enum) return pick(rnd, schema.enum);
      const max = Math.min(schema.maxLength ?? 200, 200);
      return words(rnd, 1 + Math.floor(rnd() * 8)).slice(0, max).trim() || 'x';
    }
    case 'integer': {
      const lo = schema.minimum ?? 0;
      const hi = Math.min(schema.maximum ?? 1000, lo + 1000);
      return lo + Math.floor(rnd() * (hi - lo + 1));
    }
    case 'number':
      return 1 + Math.round(rnd() * 1000) / 10;
    case 'array':
      return Array.from({ length: (schema.minItems ?? 0) + Math.floor(rnd() * 3) }, () => fromSchema(rnd, c, s, `${name}[]`, schema.items));
    case 'object':
      return fromObject(rnd, c, s, schema);
  }
}
function fromObject(rnd: Rnd, c: WriteContext, s: Scratch, schema: Pick<ObjectSchema, 'properties' | 'required'>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(schema.properties)) {
    if (!(schema.required ?? []).includes(key) && rnd() < 0.5) continue;
    const v = fromSchema(rnd, c, s, key, prop);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

const OPEN_MR = new Set(['active', 'on-hold']);
const LEGAL: Record<string, readonly string[]> = { active: ['stop', 'hold', 'modify', 'complete'], 'on-hold': ['stop', 'resume', 'modify', 'complete'] };
// Orders this episode placed may also be cancelled or marked entered-in-error.
const PLACED_HERE = /^mr-t\d{4}$/;
const tail = (ref: string) => ref.slice(ref.indexOf('/') + 1);

// Cross-field rules a schema cannot state. Returns undefined when the state offers no valid call.
const RULES: Record<string, (input: Record<string, unknown>, rnd: Rnd, c: WriteContext, s: Scratch) => Record<string, unknown> | undefined> = {
  order_medication(input, rnd, c, s) {
    if (rnd() < 0.3) {
      delete input.frequency;
      input.timing_events = PROVIDERS.timing_events!(rnd, c, s, { type: 'string', description: '' });
    } else {
      delete input.timing_events;
      input.frequency ??= pick(rnd, ['QD', 'BID', 'TID']);
    }
    if (PRN(input.frequency)) input.as_needed_reason = pick(rnd, AS_NEEDED);
    const dose = doseFor(rnd, c.catalog.find((e) => e.code === input.rxnorm_code)?.display);
    if (dose) [input.dose_value, input.dose_unit] = [dose.value, dose.unit];
    const open = all<MedicationRequest>(c, 'MedicationRequest').filter((m) => OPEN_MR.has(m.status) && m.subject?.reference === `Patient/${s.patient}`);
    if (open.length > 0 && rnd() < 0.25) input.replaces = asRef(rnd, 'MedicationRequest', pick(rnd, open).id!);
    return input;
  },
  change_medication(input, rnd, c) {
    const open = all<MedicationRequest>(c, 'MedicationRequest').filter((m) => OPEN_MR.has(m.status));
    if (open.length === 0) return undefined;
    const mr = pick(rnd, open);
    input.medication_request = asRef(rnd, 'MedicationRequest', mr.id!);
    input.action = pick(rnd, [...LEGAL[mr.status]!, ...(PLACED_HERE.test(mr.id!) ? ['cancel', 'entered-in-error'] : [])]);
    if (input.action !== 'modify') {
      for (const k of ['new_dose', 'medication_code', 'route']) delete input[k];
      return input;
    }
    const nd = (input.new_dose ??= fromSchema(rnd, c, { patient: '' }, 'new_dose', WRITE_TOOLS[1]!.inputSchema.properties.new_dose!)) as Record<string, unknown>;
    if (PRN(nd.frequency)) nd.as_needed_reason = pick(rnd, AS_NEEDED);
    else delete nd.as_needed_reason;
    // A third of modifies change the product to another catalog drug.
    const product = rnd() < 0.33 ? pick(rnd, c.catalog.filter((e) => e.kind === 'medication')) : undefined;
    if (product) input.medication_code = product.code;
    else delete input.medication_code;
    const dose = doseFor(rnd, product?.display ?? mr.medicationCodeableConcept?.coding?.[0]?.display);
    if (dose) [nd.value, nd.unit] = [dose.value, dose.unit];
    return input;
  },
  order_service(input, rnd) {
    const start = String(input.occurrence_start);
    if ('occurrence_end' in input) {
      // An end on the same calendar form, after the start.
      const later = new Date(Date.parse(start.length === 10 ? `${start}T00:00:00Z` : start) + (1 + Math.floor(rnd() * 90)) * 86_400_000);
      input.occurrence_end = start.length === 10 ? later.toISOString().slice(0, 10) : later.toISOString().slice(0, 19) + 'Z';
    }
    return input;
  },
  send_message(input, rnd, _c, s) {
    // A patient recipient must be the patient the references are about.
    if (rnd() < 0.4) input.recipient = asRef(rnd, 'Patient', s.patient);
    else input.recipient = pick(rnd, OWNERS);
    return input;
  },
  record_allergy(input, rnd, c, s) {
    if (input.verification === 'entered-in-error') delete input.clinical_status;
    const existing = all<AllergyIntolerance>(c, 'AllergyIntolerance').filter(
      (a) => a.patient.reference === `Patient/${s.patient}` && a.verificationStatus?.coding?.[0]?.code !== 'entered-in-error',
    );
    if (existing.length > 0 && rnd() < 0.3) input.update_id = asRef(rnd, 'AllergyIntolerance', pick(rnd, existing).id!);
    else {
      // A new record needs its substance, criticality and verification.
      const props = WRITE_TOOLS.find((t) => t.name === 'record_allergy')!.inputSchema.properties;
      for (const k of ['substance_code', 'criticality', 'verification']) input[k] ??= fromSchema(rnd, c, s, k, props[k]!);
      if (input.verification === 'entered-in-error') delete input.clinical_status;
    }
    // Each reaction has a coded manifestation, text, or both.
    for (const r of (input.reactions ?? []) as Array<Record<string, unknown>>) {
      if (r.manifestation_code === undefined && r.manifestation === undefined) r.manifestation_code = '126485001';
    }
    return input;
  },
  update_inbox_item(input, rnd, c, s) {
    const open = all<Task>(c, 'Task').filter((t) => t.code?.coding?.[0]?.system === INBOX_QUEUE_SYSTEM && t.status === 'requested');
    if (open.length === 0) return undefined;
    const task = pick(rnd, open);
    s.patient = tail(task.for!.reference!);
    input.task_id = asRef(rnd, 'Task', task.id!);
    if (input.action === 'reassign') input.new_owner = pick(rnd, OWNERS);
    else delete input.new_owner;
    if (input.action === 'cancel' || input.action === 'reject') input.reason = words(rnd, 4);
    else delete input.reason;
    if (input.action === 'complete' && 'linked' in input) input.linked = PROVIDERS.linked!(rnd, c, s, { type: 'string', description: '' });
    else delete input.linked;
    return input;
  },
};

// A valid call for `tool` in the current state, or undefined if the state offers none.
function validCall(tool: string, rnd: Rnd, c: WriteContext): Record<string, unknown> | undefined {
  const t = WRITE_TOOLS.find((x) => x.name === tool)!;
  const s: Scratch = { patient: pick(rnd, PATIENTS) };
  // update_inbox_item picks its patient from the item, so references are drawn after the rule.
  if (tool === 'update_inbox_item') {
    const input = RULES.update_inbox_item!(fromObject(rnd, c, s, { properties: { action: t.inputSchema.properties.action!, comment: t.inputSchema.properties.comment! }, required: ['action'] }), rnd, c, s);
    if (input && input.action === 'complete' && rnd() < 0.6) input.linked = PROVIDERS.linked!(rnd, c, s, { type: 'string', description: '' });
    return input;
  }
  const input = fromObject(rnd, c, s, t.inputSchema);
  return RULES[tool] ? RULES[tool](input, rnd, c, s) : input;
}

// ---- checks ----

// The R4 value sets, and the structure definitions the tools validate against.
const VALUE_SETS = JSON.parse(readFileSync(new URL('../../node_modules/@medplum/definitions/dist/fhir/r4/valuesets.json', import.meta.url), 'utf8')) as Bundle;
const CODE_SYSTEMS = new Map<string, Set<string>>();
const VS = new Map<string, ValueSet>();
for (const e of VALUE_SETS.entry ?? []) {
  const r = e.resource as CodeSystem | ValueSet;
  if (r.resourceType === 'ValueSet') VS.set(r.url!, r);
  else {
    const codes = new Set<string>();
    const walk = (cs: readonly CodeSystemConcept[] | undefined) => cs?.forEach((x) => (codes.add(x.code), walk(x.concept)));
    walk(r.concept);
    CODE_SYSTEMS.set(r.url!, codes);
  }
}
const SDS = new Map((definitions.entry ?? []).map((e) => [(e.resource as StructureDefinition).type, e.resource as StructureDefinition]));
// Required value sets this check cannot enumerate (MIME types, languages): logged, not silent.
const UNENUMERABLE = new Set<string>();

// The codes of a value set, or undefined when it is not enumerable from the bundle.
function expand(url: string): Set<string> | undefined {
  const vs = VS.get(url.split('|')[0]!);
  if (!vs?.compose?.include) return undefined;
  const out = new Set<string>();
  for (const inc of vs.compose.include) {
    if (inc.filter?.length) return undefined;
    for (const v of inc.valueSet ?? []) {
      const sub = expand(v);
      if (!sub) return undefined;
      sub.forEach((c) => out.add(c));
    }
    if (inc.concept) inc.concept.forEach((x) => out.add(x.code));
    else if (inc.system) {
      const cs = CODE_SYSTEMS.get(inc.system);
      if (!cs) return undefined;
      cs.forEach((c) => out.add(c));
    }
  }
  return out;
}

const valuesAt = (value: unknown, path: readonly string[], where: string, out: Array<[string, unknown]> = []): Array<[string, unknown]> => {
  if (value === undefined || value === null) return out;
  if (Array.isArray(value)) value.forEach((v, i) => valuesAt(v, path, `${where}[${i}]`, out));
  else if (path.length === 0) out.push([where, value]);
  else if (typeof value === 'object') valuesAt((value as Record<string, unknown>)[path[0]!], path.slice(1), `${where}.${path[0]}`, out);
  return out;
};

// The codes of a code, Coding or CodeableConcept value.
function codesOf(v: unknown): string[] {
  if (typeof v === 'string') return [v];
  const o = v as { coding?: Array<{ code?: string }>; code?: string };
  return (o.coding ?? [o]).flatMap((c) => (c.code === undefined ? [] : [c.code]));
}

// Every coded value of `value` (of FHIR type `type`) outside its required value set, walking
// the type's elements and recursing into complex datatypes.
function unbound(value: unknown, type: string, where: string, out: string[] = []): string[] {
  for (const el of SDS.get(type)?.snapshot?.element ?? []) {
    const rel = el.path!.split('.').slice(1);
    if (rel.length === 0 || rel.some((p) => p.endsWith('[x]'))) continue;
    for (const [path, v] of valuesAt(value, rel, where)) {
      if (el.binding?.strength === 'required' && el.binding.valueSet) {
        const codes = expand(el.binding.valueSet);
        if (!codes) UNENUMERABLE.add(el.binding.valueSet);
        else {
          const found = codesOf(v);
          if (found.length > 0 && !found.some((c) => codes.has(c))) out.push(`${path}: ${JSON.stringify(found)} not in ${el.binding.valueSet}`);
        }
      }
      for (const t of el.type ?? []) {
        if (/^[A-Z]/.test(t.code!) && SDS.has(t.code!) && !['Element', 'BackboneElement', 'Resource', 'Extension'].includes(t.code!)) unbound(v, t.code!, path, out);
      }
    }
  }
  return out;
}

function medplumValid(r: Readonly<Resource>): string | undefined {
  try {
    validateResource(structuredClone(r) as Resource);
  } catch (e) {
    return `${r.resourceType}/${r.id}: ${normalizeErrorString(e)}`;
  }
  const codes = unbound(r, r.resourceType, r.resourceType);
  return codes.length ? `${r.resourceType}/${r.id}: ${codes.join('; ')}` : undefined;
}

describe('the validity check is live', () => {
  it('flags a code outside its required value set, which validateResource alone lets through', () => {
    const sr: ServiceRequest = { resourceType: 'ServiceRequest', id: 'sr-x', status: 'active', intent: 'order', subject: { reference: 'Patient/pt-0001' } };
    expect(medplumValid(sr)).toBeUndefined();
    expect(() => validateResource(structuredClone({ ...sr, intent: 'bogus-intent' }) as never)).not.toThrow();
    expect(medplumValid({ ...sr, intent: 'bogus-intent' } as never)).toMatch(/ServiceRequest.intent: \["bogus-intent"\]/);
    const t = { resourceType: 'Task', id: 't', status: 'requested', intent: 'order', restriction: { period: { end: '2026-11-01' } } } as Task;
    expect(medplumValid({ ...t, status: 'done' } as never)).toMatch(/Task.status/);
    const mr = base.find((x) => x.resourceType === 'MedicationRequest' && (x as MedicationRequest).dosageInstruction?.[0]?.timing) as MedicationRequest;
    expect(medplumValid(mr)).toBeUndefined();
    const bad = structuredClone(mr);
    bad.dosageInstruction![0]!.timing!.repeat!.periodUnit = 'fortnight' as never;
    expect(medplumValid(bad)).toMatch(/periodUnit/);
  });
});
afterAll(() => process.stdout.write(`write-gate: required value sets not enumerable here (not checked): ${[...UNENUMERABLE].sort().join(', ') || 'none'}\n`));

const PREFIX: Record<string, string> = { MedicationRequest: 'mr', ServiceRequest: 'sr', Task: 'task', Communication: 'comm', AllergyIntolerance: 'alg', DocumentReference: 'doc' };
const seqOf = (ref: string) => Number(/-t(\d+)$/.exec(ref)?.[1]);

interface Run {
  calls: number;
  committed: number;
  created: string[];
  invalid: string[];
  provenanceDefects: string[];
  failures: string[];
  hash: string;
}

// Drives one tool on a fresh store until it has `target` committed valid calls.
async function drive(tool: string, seed: number, target: number): Promise<Run> {
  const c = fresh();
  const initial = new Set([...c.world.resources()].map((r) => `${r.resourceType}/${r.id}`));
  const rnd = rng(seed);
  const run: Run = { calls: 0, committed: 0, created: [], invalid: [], provenanceDefects: [], failures: [], hash: '' };
  while (run.committed < target && run.calls < target * 3) {
    const input = validCall(tool, rnd, c);
    if (!input) break;
    run.calls++;
    // finish ends an episode, so each finish call is the end of a fresh one.
    if (tool === 'finish') c.session = newSession();
    const seq = c.session.writeSeq;
    const r = callTool(TOOLS, tool, input, c);
    if (r.is_error) {
      run.failures.push(`${tool} #${run.calls} ${JSON.stringify(input)} -> ${JSON.stringify(r.content)}`);
      continue;
    }
    run.committed++;
    if (tool === 'finish') continue;
    expect(c.session.writeSeq).toBe(seq + 1);
    const provs = (r.written_ids ?? []).filter((id) => id.startsWith('Provenance/'));
    const others = (r.written_ids ?? []).filter((id) => !id.startsWith('Provenance/'));
    if (provs.length !== 1 || provs[0] !== `Provenance/prov-t${String(seq + 1).padStart(4, '0')}`) run.provenanceDefects.push(`${tool} #${run.calls}: ${provs.join(',')}`);
    const prov = c.world.get<Provenance>('Provenance', tail(provs[0] ?? 'x/x'));
    const targets = (prov?.target ?? []).map((t) => t.reference).sort();
    if (JSON.stringify(targets) !== JSON.stringify(others)) run.provenanceDefects.push(`${tool} #${run.calls}: targets ${targets} != ${others}`);
    for (const id of r.written_ids ?? []) {
      const res = c.world.get(id.split('/')[0]!, tail(id))!;
      const bad = medplumValid(res);
      if (bad) run.invalid.push(bad);
      if (!initial.has(id) && !id.startsWith('Provenance/')) {
        run.created.push(id);
        initial.add(id);
        expect(seqOf(id)).toBe(seq + 1);
        expect(id.startsWith(`${id.split('/')[0]}/${PREFIX[id.split('/')[0]!]}-t`)).toBe(true);
      }
    }
  }
  expect(all(c, 'Provenance')).toHaveLength(tool === 'finish' ? 0 : run.committed);
  run.hash = await stateHash(c.world.resources());
  return run;
}

const TARGET = 120;
const CREATES_EVERY_CALL = new Set(['order_medication', 'order_service', 'create_task', 'send_message', 'write_note']);

describe('schema-driven valid calls', () => {
  for (const [i, tool] of WRITE_TOOLS.map((t) => t.name).entries()) {
    it(`${tool}: >= 100 valid calls commit, every written resource is valid R4, one Provenance each, ids in order and identical on replay`, async () => {
      const run = await drive(tool, 1000 + i, TARGET);
      process.stdout.write(`write-gate: ${tool} calls=${run.calls} committed=${run.committed} created=${run.created.length} invalid=${run.invalid.length} provenance_defects=${run.provenanceDefects.length}\n`);
      expect(run.failures.slice(0, 5)).toEqual([]);
      expect(run.committed).toBeGreaterThanOrEqual(100);
      expect(run.invalid.slice(0, 5)).toEqual([]);
      expect(run.provenanceDefects.slice(0, 5)).toEqual([]);
      if (CREATES_EVERY_CALL.has(tool)) {
        const prefix = run.created[0]!.split('/')[0]!;
        expect(run.created).toEqual(Array.from({ length: run.committed }, (_, k) => `${prefix}/${PREFIX[prefix]}-t${String(k + 1).padStart(4, '0')}`));
      }
      const again = await drive(tool, 1000 + i, TARGET);
      expect(again.created).toEqual(run.created);
      expect(again.hash).toBe(run.hash);
    });
  }
});

// ---- rejections ----

interface Mutation {
  field: string;
  codes: readonly string[];
  apply(input: Record<string, unknown>, c: WriteContext): Record<string, unknown> | undefined;
}
const set = (field: string, value: unknown, codes: readonly string[] = ['INVALID_INPUT']): Mutation => ({ field, codes, apply: (i) => ({ ...i, [field]: value }) });
const drop = (field: string): Mutation => ({ field, codes: ['INVALID_INPUT'], apply: (i) => { const o = { ...i }; delete o[field]; return o; } });
const SCHEMA_MUTATIONS = (tool: string): Mutation[] => {
  const schema = WRITE_TOOLS.find((t) => t.name === tool)!.inputSchema;
  const out: Mutation[] = [set('bogus_param', 1)];
  for (const key of schema.required ?? []) out.push(drop(key));
  for (const [key, p] of Object.entries(schema.properties)) {
    out.push(set(key, p.type === 'string' ? 42 : 'not-a-number'));
    if (p.type === 'string' && p.enum) out.push(set(key, 'not-in-enum'));
    if (p.type === 'string' && !p.enum && !p.pattern) {
      out.push(set(key, '  \t '));
      out.push(set(key, 'lone \ud800 surrogate'));
    }
  }
  return out;
};
const OTHER_PATIENT_DOC = (c: WriteContext, input: Record<string, unknown>) => {
  const p = tail(String(input.patient ?? 'Patient/pt-0001'));
  return `DocumentReference/${all(c, 'DocumentReference').find((d) => patientOf(d) !== p)!.id}`;
};
const SEMANTIC_MUTATIONS: Record<string, Mutation[]> = {
  order_medication: [
    set('patient', 'pt-9999', ['NOT_FOUND']),
    { field: 'as_needed_reason', codes: ['INVALID_INPUT'], apply: (i) => ({ ...i, frequency: 'Q8H_PRN', timing_events: undefined, as_needed_reason: undefined }) },
    { field: 'rxnorm_code', codes: ['INVALID_INPUT'], apply: (i) => ({ ...i, rxnorm_code: '197361', dose_value: 3, dose_unit: 'mg' }) },
    set('rxnorm_code', '2160-0'),
    set('reason', 'ctrl \u0001 char'),
    { field: 'timing_events[0]', codes: ['INVALID_INPUT'], apply: (i) => ({ ...i, frequency: undefined, as_needed_reason: undefined, timing_events: ['2026-10-22T09:00:00-04:00'] }) },
    { field: 'timing_events[0]', codes: ['INVALID_INPUT'], apply: (i) => ({ ...i, frequency: undefined, as_needed_reason: undefined, timing_events: ['2026-13-01T09:00:00-04:00'] }) },
    set('replaces', 'mr-nope', ['NOT_FOUND']),
  ],
  change_medication: [
    set('medication_request', 'mr-nope', ['NOT_FOUND']),
    {
      field: 'action',
      codes: ['CONFLICT'],
      apply: (i, c) => ({ ...i, action: 'stop', new_dose: undefined, medication_code: undefined, route: undefined, medication_request: all<MedicationRequest>(c, 'MedicationRequest').find((m) => m.status === 'completed')!.id }),
    },
    { field: 'new_dose', codes: ['INVALID_INPUT'], apply: (i) => ({ ...i, action: 'modify', new_dose: undefined }) },
    // A world order, not placed in this episode, cannot be cancelled.
    {
      field: 'action',
      codes: ['CONFLICT'],
      apply: (i, c) => ({ ...i, action: 'cancel', new_dose: undefined, medication_code: undefined, route: undefined, medication_request: all<MedicationRequest>(c, 'MedicationRequest').find((m) => m.status === 'active' && !PLACED_HERE.test(m.id!))!.id }),
    },
    // Half an extended-release tablet.
    {
      field: 'medication_code',
      codes: ['INVALID_INPUT'],
      apply: (i, c) => {
        const er = all<MedicationRequest>(c, 'MedicationRequest').find((m) => OPEN_MR.has(m.status) && solid(m.medicationCodeableConcept?.coding?.[0]?.display)?.step === 1 && /Extended Release/.test(m.medicationCodeableConcept!.coding![0]!.display!));
        const p = solid(er?.medicationCodeableConcept?.coding?.[0]?.display);
        return er && p ? { medication_request: er.id, action: 'modify', reason: 'r', new_dose: { value: p.strength / 2, unit: p.unit, frequency: 'QD' } } : undefined;
      },
    },
    { field: 'new_dose.as_needed_reason', codes: ['INVALID_INPUT'], apply: (i) => (i.action === 'modify' ? { ...i, new_dose: { ...(i.new_dose as object), frequency: 'Q8H_PRN', as_needed_reason: undefined } } : undefined) },
  ],
  order_service: [
    set('occurrence_start', '2026-10-01'),
    set('occurrence_start', '2027-02-29'),
    set('code', '723'),
    { field: 'supporting[0]', codes: ['INVALID_INPUT'], apply: (i, c) => ({ ...i, supporting: [OTHER_PATIENT_DOC(c, i)] }) },
    { field: 'based_on[0]', codes: ['INVALID_INPUT'], apply: (i) => ({ ...i, based_on: ['Observation/obs-00001'] }) },
  ],
  create_task: [
    set('owner', 'Patient/pt-0001'),
    set('owner', 'pool-nowhere', ['NOT_FOUND']),
    set('due', '2026-10-23T07:00:00-04:00'),
    { field: 'focus', codes: ['INVALID_INPUT'], apply: (i, c) => ({ ...i, focus: OTHER_PATIENT_DOC(c, i) }) },
  ],
  send_message: [
    set('recipient', 'Organization/org-riverbend'),
    set('recipient', 'Patient/pt-nope', ['NOT_FOUND']),
    { field: 'about[0]', codes: ['INVALID_INPUT'], apply: (i) => ({ ...i, about: ['Policy/RBC-1'] }) },
    set('subject', 'ctrl \u0002'),
  ],
  record_allergy: [
    set('substance_code', 'REF-GI'),
    set('substance_code', '999999999'),
    { field: 'reactions[0]', codes: ['INVALID_INPUT'], apply: (i) => ({ ...i, reactions: [{ severity: 'mild' }] }) },
    { field: 'criticality', codes: ['INVALID_INPUT'], apply: (i) => (i.update_id === undefined ? { ...i, criticality: undefined } : undefined) },
    set('update_id', 'alg-nope', ['NOT_FOUND']),
    { field: 'clinical_status', codes: ['INVALID_INPUT'], apply: (i) => ({ ...i, verification: 'entered-in-error', clinical_status: 'active' }) },
    { field: 'source', codes: ['INVALID_INPUT'], apply: (i, c) => ({ ...i, source: OTHER_PATIENT_DOC(c, i) }) },
    { field: 'reactions[0].severity', codes: ['INVALID_INPUT'], apply: (i) => ({ ...i, reactions: [{ manifestation: 'hives', severity: 'catastrophic' }] }) },
  ],
  write_note: [
    set('patient', 'pt-9999', ['NOT_FOUND']),
    { field: 'cites[0]', codes: ['INVALID_INPUT'], apply: (i, c) => ({ ...i, cites: [OTHER_PATIENT_DOC(c, i)] }) },
    set('title', 'ctrl \u0003'),
    set('text', 'x'.repeat(100_001)),
    { field: 'cites_policies[0]', codes: ['NOT_FOUND'], apply: (i) => ({ ...i, cites_policies: ['RBC-NOPE-01'] }) },
    { field: 'cites_policies', codes: ['INVALID_INPUT'], apply: (i) => ({ ...i, cites_policies: 'RBC-PHARM-07' }) },
    { field: 'cites[0]', codes: ['INVALID_INPUT'], apply: (i) => ({ ...i, cites: ['Policy/RBC-PHARM-07'] }) },
  ],
  update_inbox_item: [
    set('task_id', 'task-nope', ['NOT_FOUND']),
    { field: 'new_owner', codes: ['INVALID_INPUT'], apply: (i) => ({ ...i, action: 'reassign', new_owner: undefined, linked: undefined, reason: undefined }) },
    {
      field: 'linked[0]',
      codes: ['INVALID_INPUT'],
      apply: (i, c) => ({ ...i, action: 'complete', new_owner: undefined, reason: undefined, linked: [OTHER_PATIENT_DOC(c, { patient: (c.world.get<Task>('Task', tail(String(i.task_id)))!.for!.reference) })] }),
    },
    { field: 'reason', codes: ['INVALID_INPUT'], apply: (i) => ({ ...i, action: 'cancel', new_owner: undefined, linked: undefined, reason: undefined }) },
  ],
  finish: [],
};

describe('rejections', () => {
  for (const [i, tool] of WRITE_TOOLS.map((t) => t.name).entries()) {
    it(`${tool}: every mutated call is rejected, names the field, and changes nothing`, async () => {
      const c = fresh();
      const rnd = rng(2000 + i);
      const mutations = [...SCHEMA_MUTATIONS(tool), ...SEMANTIC_MUTATIONS[tool]!];
      const defects: string[] = [];
      let rejected = 0;
      // Interleave valid commits so rejections are checked against a store that has changed.
      for (let round = 0; round < 3; round++) {
        if (tool === 'finish') c.session = newSession();
        const seed = validCall(tool, rnd, c);
        if (!seed) break;
        for (const m of mutations) {
          const input = m.apply(structuredClone(seed), c);
          if (!input) continue;
          const before = await stateHash(c.world.resources());
          const size = c.world.size;
          const seq = c.session.writeSeq;
          const r: ToolResult = callTool(TOOLS, tool, input, c);
          const error = (r.content as { error?: { code: string; field?: string } }).error;
          const where = `${tool} ${m.field}: ${JSON.stringify(r.content).slice(0, 200)}`;
          if (!r.is_error) defects.push(`not rejected: ${where}`);
          else {
            rejected++;
            if (error?.field !== m.field) defects.push(`field ${error?.field} != ${m.field}: ${where}`);
            if (!m.codes.includes(error!.code)) defects.push(`code ${error?.code}: ${where}`);
            if (r.written_ids !== undefined || c.world.size !== size || c.session.writeSeq !== seq || (await stateHash(c.world.resources())) !== before) defects.push(`state changed: ${where}`);
          }
        }
        expect(callTool(TOOLS, tool, seed, c).is_error).toBe(false);
      }
      process.stdout.write(`write-gate: ${tool} rejections=${rejected} defects=${defects.length}\n`);
      expect(defects.slice(0, 8)).toEqual([]);
      expect(rejected).toBeGreaterThanOrEqual(3 * (SCHEMA_MUTATIONS(tool).length + SEMANTIC_MUTATIONS[tool]!.length) - 3);
    });
  }
});

// ---- replay ----

describe('replay', () => {
  it('a recorded mixed tool log replayed on a fresh store reproduces every result and the final hash', async () => {
    const c = fresh();
    const rnd = rng(3000);
    const log: Array<{ name: string; input: unknown; result: ToolResult }> = [];
    const names = WRITE_TOOLS.map((t) => t.name).filter((n) => n !== 'finish');
    for (let k = 0; k < 400; k++) {
      let name: string;
      let input: unknown;
      if (k % 7 === 3) [name, input] = ['fhir_search', { resource_type: pick(rnd, ['MedicationRequest', 'Task', 'Provenance']), patient: pick(rnd, PATIENTS) }];
      else {
        name = pick(rnd, names);
        input = validCall(name, rnd, c);
        if (input === undefined) continue;
        // Every fifth write is broken, so the log holds rejections too.
        if (k % 5 === 0) input = { ...(input as object), patient: 'pt-9999', task_id: 'task-nope', medication_request: 'mr-nope', recipient: 'pr-nope' };
      }
      log.push({ name, input, result: callTool(TOOLS, name, input, c) });
    }
    log.push({ name: 'finish', input: { summary: 'done' }, result: callTool(TOOLS, 'finish', { summary: 'done' }, c) });
    const final = await stateHash(c.world.resources());
    const committed = log.filter((e) => e.result.written_ids !== undefined).length;
    const rejectedWrites = log.filter((e) => e.result.is_error).length;
    process.stdout.write(`write-gate: replay log=${log.length} committed=${committed} rejected=${rejectedWrites} writeSeq=${c.session.writeSeq}\n`);
    expect(committed).toBe(c.session.writeSeq);
    expect(committed).toBeGreaterThan(150);
    expect(rejectedWrites).toBeGreaterThan(30);

    const replay = fresh();
    const results = log.map((e) => callTool(TOOLS, e.name, structuredClone(e.input), replay));
    expect(results).toEqual(log.map((e) => e.result));
    expect(await stateHash(replay.world.resources())).toBe(final);
    expect(replay.session).toEqual(c.session);
  });
});
