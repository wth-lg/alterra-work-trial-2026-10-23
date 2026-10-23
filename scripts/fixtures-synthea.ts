// Prunes one Synthea FHIR R4 export to the base cohort (design section 2, "One shared
// world"). Run by fixtures/synthea/generate.sh, not by hand:
//
//   node scripts/fixtures-synthea.ts <synthea fhir dir> <out dir> --synthea <version> --jar-sha256 <hex> -- <synthea args...>
//
// Writes <out dir>/base.ndjson.gz and <out dir>/base.json (Synthea version, jar SHA-256, args,
// NDJSON SHA-256 and counts) and prints the NDJSON SHA-256. The output depends only on the
// export's content, never on file order, the wall clock or the machine.
//
// Pruning, in order:
//   1. Living patients only; deceased ones are not on a clinic's active panel.
//   2. Our resource types only (Synthea's Claim, EOB, Immunization, CarePlan and the like go),
//      and Observations in the laboratory, vital-signs and social-history categories.
//   3. Nothing dated after NOW. Active conditions, active medication requests and allergies
//      are kept whatever their date; everything else must fall in the 6 years before NOW.
//   4. Per patient, the latest CAP entries per code (Encounter and DocumentReference: the
//      latest CAP per patient). Synthea writes about 37,000 resources in the 6-year window
//      for this cohort; the caps bring it near the design's 5,000 while keeping every code
//      a patient has.
// Synthea closes a stay still open at the reference date at the wall-clock time of the run,
// so a period end after NOW is removed and such an Encounter is in progress at NOW.
// Then ids become short stable forms (pt-0001, obs-00001) in (patient, date, code) order,
// references are rewritten to them, and references to anything pruned are removed.
// Practitioner references map to the clinic staff, Organization references to the clinic,
// Location references are dropped. meta, text, and Synthea's uuid identifiers are dropped.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Resource } from '../packages/env/store.ts';
import { NOW_MS } from '../packages/env/clock.ts';
import { CLINIC, STAFF } from '../packages/env/world.ts';
import { gzip, sha256, toNdjson } from './fixtures-lib.ts';

type Json = Record<string, unknown>;

const CUTOFF_MS = Date.UTC(2020, 9, 23, 12); // NOW minus 6 years
const OBS_CATEGORIES = new Set(['laboratory', 'vital-signs', 'social-history']);
const CAP: Record<string, number> = { Observation: 2, DiagnosticReport: 1, Procedure: 1, MedicationRequest: 2, Condition: 1, Encounter: 6, DocumentReference: 6 };
const PER_PATIENT = new Set(['Encounter', 'DocumentReference']);
const PREFIX: Record<string, string> = {
  Patient: 'pt',
  Encounter: 'enc',
  Condition: 'cond',
  Observation: 'obs',
  DiagnosticReport: 'dr',
  DocumentReference: 'doc',
  AllergyIntolerance: 'alg',
  Procedure: 'proc',
  MedicationRequest: 'mr',
};
// Synthea's life-year estimates are simulation artefacts, not chart data.
const DROP_EXTENSIONS = new Set([
  'http://synthetichealth.github.io/synthea/disability-adjusted-life-years',
  'http://synthetichealth.github.io/synthea/quality-adjusted-life-years',
]);

const codeOf = (r: Json): string => {
  for (const k of ['code', 'medicationCodeableConcept', 'type']) {
    const v = r[k];
    const cc = (Array.isArray(v) ? v[0] : v) as { coding?: Array<{ code?: string }> } | undefined;
    if (cc?.coding?.[0]?.code) return cc.coding[0].code;
  }
  return '';
};

function dateOf(r: Json): string | undefined {
  for (const k of ['effectiveDateTime', 'onsetDateTime', 'authoredOn', 'performedDateTime', 'recordedDate', 'date']) {
    if (typeof r[k] === 'string') return r[k] as string;
  }
  for (const k of ['period', 'performedPeriod', 'effectivePeriod']) {
    const start = (r[k] as { start?: string } | undefined)?.start;
    if (start) return start;
  }
  return undefined;
}

const ms = (d: string | undefined): number => (d ? Date.parse(d.length === 10 ? `${d}T00:00:00Z` : d) : NaN);
const status = (r: Json, k: string): string | undefined => ((r[k] as { coding?: Array<{ code?: string }> } | undefined)?.coding?.[0]?.code);

function category(r: Json): string | undefined {
  const cats = r.category as Array<{ coding?: Array<{ code?: string }> }> | undefined;
  return cats?.[0]?.coding?.[0]?.code;
}

// FNV-1a, so a Synthea clinician always maps to the same staff member.
function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

interface Kept {
  resource: Json;
  patient: number;
  date: number;
}

function selectPatient(entries: Json[], patientIndex: number): Kept[] {
  const kept: Kept[] = [];
  const groups = new Map<string, Kept[]>();
  for (const r of entries) {
    const type = r.resourceType as string;
    if (!PREFIX[type]) continue;
    if (type === 'Observation' && !OBS_CATEGORIES.has(category(r) ?? '')) continue;
    const d = ms(dateOf(r));
    if (d > NOW_MS) continue;
    const item = { resource: r, patient: patientIndex, date: Number.isNaN(d) ? -Infinity : d };
    const always =
      type === 'Patient' ||
      type === 'AllergyIntolerance' ||
      (type === 'Condition' && status(r, 'clinicalStatus') === 'active') ||
      (type === 'MedicationRequest' && r.status === 'active');
    if (always) kept.push(item);
    else if (d >= CUTOFF_MS) {
      const key = PER_PATIENT.has(type) ? type : `${type}|${codeOf(r)}`;
      const group = groups.get(key) ?? [];
      group.push(item);
      groups.set(key, group);
    }
  }
  for (const [key, group] of groups) {
    group.sort((a, b) => a.date - b.date || (a.resource.id as string).localeCompare(b.resource.id as string));
    kept.push(...group.slice(-CAP[key.split('|')[0]!]!));
  }
  return kept;
}

const REMOVE = Symbol('remove');

// Rewrites every reference; returns REMOVE for one that points at nothing we keep.
function rewriteRef(ref: string, refs: Map<string, string>): string | typeof REMOVE {
  if (ref.startsWith('urn:uuid:')) return refs.get(ref.slice(9)) ?? REMOVE;
  if (ref.startsWith('Practitioner?')) return `Practitioner/${STAFF[fnv(ref) % STAFF.length]}`;
  if (ref.startsWith('Organization?')) return `Organization/${CLINIC}`;
  return REMOVE; // Location, PractitionerRole and anything else outside our types
}

// Returns the cleaned value, or REMOVE when nothing is left of it.
function rewrite(value: unknown, refs: Map<string, string>): unknown {
  if (Array.isArray(value)) {
    const out = value.map((v) => rewrite(v, refs)).filter((v) => v !== REMOVE);
    return out.length ? out : REMOVE;
  }
  if (value === null || typeof value !== 'object') return value;
  const obj = value as Json;
  if (typeof obj.reference === 'string') {
    const ref = rewriteRef(obj.reference, refs);
    if (ref === REMOVE) return REMOVE;
    // Synthea's display names belong to its own clinicians and facilities.
    return { reference: ref };
  }
  const out: Json = {};
  for (const [k, v] of Object.entries(obj)) {
    const w = rewrite(v, refs);
    if (w !== REMOVE) out[k] = w;
  }
  return Object.keys(out).length ? out : REMOVE;
}

// Removes every period end after NOW; returns whether it removed any.
function openPeriods(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  let changed = false;
  for (const v of Object.values(value)) changed = openPeriods(v) || changed;
  const p = value as { start?: unknown; end?: unknown };
  if (typeof p.start === 'string' && typeof p.end === 'string' && ms(p.end) > NOW_MS) {
    delete p.end;
    changed = true;
  }
  return changed;
}

function transform(r: Json, id: string, refs: Map<string, string>, medications: Map<string, Json>, mrn: string): Json {
  const { meta: _meta, text: _text, identifier: _identifier, ...rest } = r;
  const out: Json = { ...rest, id };
  if (out.resourceType === 'Patient') {
    out.identifier = [
      { type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'MR' }] }, system: 'urn:riverbend:mrn', value: mrn },
    ];
    out.extension = (out.extension as Array<{ url: string }> | undefined)?.filter((e) => !DROP_EXTENSIONS.has(e.url));
    // Some patients have a generalPractitioner; the panel belongs to the clinic.
    out.managingOrganization = { reference: `Organization/${CLINIC}` };
  }
  // A Medication resource is not one of our types, so its code moves into the request.
  const medRef = (out.medicationReference as { reference?: string } | undefined)?.reference;
  if (medRef) {
    const med = medications.get(medRef.replace('urn:uuid:', ''));
    if (!med) throw new Error(`MedicationRequest ${r.id}: no Medication ${medRef}`);
    delete out.medicationReference;
    out.medicationCodeableConcept = med.code;
  }
  if (openPeriods(out) && out.resourceType === 'Encounter') out.status = 'in-progress';
  // An Encounter location needs a Location, which we drop; an empty element is invalid.
  delete out.location;
  return rewrite(out, refs) as Json;
}

function main(): void {
  const argv = process.argv.slice(2);
  const sep = argv.indexOf('--');
  const [fhirDir, outDir] = argv;
  const flag = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 && i < sep ? argv[i + 1] : undefined;
  };
  const version = flag('--synthea');
  const jarSha = flag('--jar-sha256');
  if (!fhirDir || !outDir || sep < 0 || !version || !jarSha) {
    console.error('usage: fixtures-synthea.ts <synthea fhir dir> <out dir> --synthea <version> --jar-sha256 <hex> -- <synthea args...>');
    process.exit(2);
  }

  // Patient bundles are named <Given>_<Family>_<uuid>.json; hospital and practitioner files are not.
  const bundles = readdirSync(fhirDir)
    .filter((f) => f.endsWith('.json') && !/^(hospital|practitioner)Information/.test(f))
    .map((f) => (JSON.parse(readFileSync(join(fhirDir, f), 'utf8')) as { entry: Array<{ resource: Json }> }).entry.map((e) => e.resource));
  const living = bundles
    .filter((entries) => entries[0]?.resourceType === 'Patient' && entries[0].deceasedDateTime === undefined && entries[0].deceasedBoolean !== true)
    .sort((a, b) => ((a[0]!.birthDate as string) + a[0]!.id).localeCompare((b[0]!.birthDate as string) + b[0]!.id));

  const medications = new Map<string, Json>();
  const kept: Kept[] = [];
  living.forEach((entries, i) => {
    for (const r of entries) if (r.resourceType === 'Medication') medications.set(r.id as string, r);
    kept.push(...selectPatient(entries, i));
  });

  // Stable short ids, numbered per type in (patient, date, code, Synthea id) order.
  kept.sort((a, b) => a.patient - b.patient || a.date - b.date || codeOf(a.resource).localeCompare(codeOf(b.resource)) || (a.resource.id as string).localeCompare(b.resource.id as string));
  const seq = new Map<string, number>();
  const ids = new Map<string, string>(); // Synthea id -> short id
  const refs = new Map<string, string>(); // Synthea id -> Type/short id
  for (const { resource } of kept) {
    const type = resource.resourceType as string;
    const n = (seq.get(type) ?? 0) + 1;
    seq.set(type, n);
    const id = `${PREFIX[type]}-${String(n).padStart(type === 'Patient' ? 4 : 5, '0')}`;
    ids.set(resource.id as string, id);
    refs.set(resource.id as string, `${type}/${id}`);
  }
  const fixed = kept.map(({ resource, patient }) => transform(resource, ids.get(resource.id as string)!, refs, medications, String(100001 + patient)));

  const ndjson = toNdjson(fixed.map(order) as unknown as Resource[]);
  const hash = sha256(ndjson);
  const counts: Record<string, number> = {};
  for (const r of fixed) counts[r.resourceType as string] = (counts[r.resourceType as string] ?? 0) + 1;
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'base.ndjson.gz'), gzip(ndjson));
  const meta = {
    synthea: version,
    jar_sha256: jarSha,
    args: argv.slice(sep + 1),
    ndjson_sha256: hash,
    resources: fixed.length,
    patients: living.length,
    by_type: Object.fromEntries(Object.entries(counts).sort()),
  };
  writeFileSync(join(outDir, 'base.json'), `${JSON.stringify(meta, null, 2)}\n`);
  console.log(`base ndjson sha256 ${hash} (${fixed.length} resources, ${living.length} patients)`);
}

// resourceType then id first, the rest in Synthea's order, so lines read naturally.
const order = ({ resourceType, id, ...rest }: Json): Json => ({ resourceType, id, ...rest });

main();
