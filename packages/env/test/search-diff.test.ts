// Differential test: our search against @medplum/fhir-router MemoryRepository 5.2.7 on
// generated queries over a generated world. Every query must return the same ids in the same
// order, and the same total.
//
// Queries are built from the data (a resource's own patient, code, status or date bounds), so
// most of them return something, and date values land exactly on range bounds, so an
// off-by-one in a comparison changes a result. Where Medplum's in-memory matcher departs from
// FHIR we keep FHIR and keep the generator out of the gap (see apps/web/src/harness/generate.ts):
//   - _sort compares JSON strings, not instants;
//   - a month value is filled to day 31;
//   - token search also matches display and text.
// packages/env/test/store.test.ts covers our side of each gap.
import { indexSearchParameterBundle, indexStructureDefinitionBundle, parseSearchRequest } from '@medplum/core';
import { readJson } from '@medplum/definitions';
import type { Bundle, Resource, SearchParameter } from '@medplum/fhirtypes';
import { MemoryRepository } from '@medplum/fhir-router';
import { beforeAll, describe, expect, it } from 'vitest';
import { generateWorld, rng } from '../../../apps/web/src/harness/generate.ts';
import { Store } from '../store.ts';

const SEED = 20261023;
const WORLD_SIZE = 1500;
const QUERIES = 400;

type Query = Array<[string, string]>;
type Json = Record<string, unknown>;

const PREFIXES = ['ge', 'le', 'gt', 'lt'] as const;
const PARAMS = ['patient', 'subject', 'code', 'category', 'status', 'date', '_sort', '_count', '_offset'] as const;

// Which parameters each type supports, and where the generator puts the values (mirrors
// R4's SearchParameter expressions for these types).
const SUPPORTED: Record<string, Partial<Record<'patient' | 'subject' | 'code' | 'category' | 'status' | 'date', string[]>>> = {
  Observation: { patient: ['subject'], subject: ['subject'], code: ['code'], category: ['category'], status: ['status'], date: ['effectiveDateTime', 'effectiveInstant'] },
  Condition: { patient: ['subject'], subject: ['subject'], code: ['code'], category: ['category'] },
  MedicationRequest: { patient: ['subject'], subject: ['subject'], code: ['medicationCodeableConcept'], category: ['category'], status: ['status'], date: ['dosageInstruction.timing.event'] },
  Encounter: { patient: ['subject'], subject: ['subject'], status: ['status'], date: ['period'] },
  DiagnosticReport: { patient: ['subject'], subject: ['subject'], code: ['code'], category: ['category'], status: ['status'], date: ['effectiveDateTime'] },
  DocumentReference: { patient: ['subject'], subject: ['subject'], category: ['category'], status: ['status'], date: ['date'] },
  AllergyIntolerance: { patient: ['patient'], code: ['code', 'reaction.substance'], category: ['category'], date: ['recordedDate'] },
  Procedure: { patient: ['subject'], subject: ['subject'], code: ['code'], category: ['category'], status: ['status'], date: ['performedDateTime'] },
  ServiceRequest: { patient: ['subject'], subject: ['subject'], code: ['code'], category: ['category'], status: ['status'] },
  Task: { patient: ['for'], subject: ['for'], code: ['code'], status: ['status'] },
  Communication: { patient: ['subject'], subject: ['subject'], category: ['category'], status: ['status'] },
  Appointment: { patient: ['participant.actor'], status: ['status'], date: ['start'] },
  EpisodeOfCare: { patient: ['patient'], status: ['status'], date: ['period'] },
  Provenance: { patient: ['target'] },
  Group: { code: ['code'] },
};

function at(value: unknown, path: string): unknown[] {
  let nodes: unknown[] = [value];
  for (const key of path.split('.')) {
    nodes = nodes.flatMap((n) => (n && typeof n === 'object' ? [(n as Json)[key]] : [])).flatMap((n) => (Array.isArray(n) ? n : n === undefined ? [] : [n]));
  }
  return nodes;
}

// The instant range a date value covers, as ISO strings with milliseconds.
function bounds(value: unknown): [string, string] | undefined {
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return [`${value}T00:00:00.000Z`, `${value}T23:59:59.999Z`];
    const iso = new Date(value).toISOString();
    return [iso, iso.replace(/\.000Z$/, '.999Z')];
  }
  const p = value as { start?: string; end?: string };
  const lo = p.start ? bounds(p.start)![0] : undefined;
  const hi = p.end ? bounds(p.end)![1] : undefined;
  return lo && hi ? [lo, hi] : lo ? [lo, lo] : undefined;
}

function makeQueries(world: Resource[]): Query[] {
  const r = rng(SEED + 1);
  const byType = new Map<string, Resource[]>();
  for (const res of world) if (SUPPORTED[res.resourceType]) byType.set(res.resourceType, [...(byType.get(res.resourceType) ?? []), res]);
  const types = [...byType.keys()];
  const patients = world.filter((x) => x.resourceType === 'Patient').map((x) => x.id!);
  const shiftDays = (iso: string, days: number) => new Date(Date.parse(iso) + days * 86_400_000).toISOString();
  const caseFlip = (s: string) => (r.chance(0.2) ? s.toUpperCase() : s);

  const value: Record<string, (anchor: Json, paths: string[]) => string | undefined> = {
    patient(anchor, paths) {
      const ref = paths.flatMap((p) => at(anchor, `${p}.reference`)).find((x) => String(x).startsWith('Patient/')) as string | undefined;
      if (!ref || r.chance(0.1)) return `Patient/${r.pick(patients)}`;
      return r.chance(0.5) ? ref : ref.slice('Patient/'.length);
    },
    subject(anchor, paths) {
      const ref = paths.flatMap((p) => at(anchor, `${p}.reference`))[0] as string | undefined;
      return ref ?? `Patient/${r.pick(patients)}`;
    },
    code(anchor, paths) {
      const codings = paths.flatMap((p) => at(anchor, `${p}.coding`)) as Array<{ system?: string; code?: string }>;
      const c = codings.length ? r.pick(codings) : undefined;
      if (!c?.code) return undefined;
      const forms = [caseFlip(c.code), c.system ? `${caseFlip(c.system)}|${c.code}` : `|${c.code}`, c.system ? `${c.system}|` : `|${c.code}`];
      const v = r.pick(forms);
      // Sometimes OR in a code the anchor lacks.
      return r.chance(0.2) ? `${v},${r.pick(['2823-3', '314076', 'zz-none'])}` : v;
    },
    category(anchor, paths) {
      const raw = paths.flatMap((p) => at(anchor, p));
      const codes = raw.flatMap((x) => (typeof x === 'string' ? [{ code: x }] : (at(x, 'coding') as Array<{ system?: string; code?: string }>)));
      const c = codes.length ? r.pick(codes) : undefined;
      if (!c?.code) return undefined;
      return c.system && r.chance(0.4) ? `${c.system}|${caseFlip(c.code)}` : caseFlip(c.code);
    },
    status(anchor) {
      const s = anchor.status as string;
      return r.chance(0.25) ? `${s},${r.pick(['cancelled', 'entered-in-error', 'final', 'active'])}` : caseFlip(s);
    },
    date(anchor, paths) {
      const v = paths.flatMap((p) => at(anchor, p))[0];
      const b = v === undefined ? undefined : bounds(v);
      const prefix = r.pick(PREFIXES);
      if (!b) return `${prefix}${r.pick(['2023-01-15', '2025-06-30T12:00:00Z'])}`;
      // Land on a bound (the equality case, 40% of the time, so an off-by-one in a comparison
      // changes several results), a bare day, a shifted instant or another offset.
      const [lo, hi] = b;
      const form = r.chance(0.4) ? 0 : 1 + r.int(4);
      const t =
        form === 0 ? (prefix === 'ge' || prefix === 'gt' ? hi : lo)
        : form === 1 ? (prefix === 'ge' || prefix === 'gt' ? lo : hi)
        : form === 2 ? lo.slice(0, 10)
        : form === 3 ? shiftDays(lo, r.int(61) - 30).replace('.000Z', 'Z')
        : shiftDays(lo, 0).slice(0, 19) + '-04:00';
      return `${prefix}${t}`;
    },
  };

  const queries: Query[] = [];
  while (queries.length < QUERIES) {
    const type = r.pick(types);
    const anchor = r.pick(byType.get(type)!) as unknown as Json;
    const supported = SUPPORTED[type]!;
    const names = Object.keys(supported) as Array<keyof typeof supported>;
    const q: Query = [];
    const n = 1 + r.int(Math.min(3, names.length));
    for (const name of [...names].sort(() => r.next() - 0.5).slice(0, n)) {
      const v = value[name]!(anchor, supported[name]!);
      if (v !== undefined) q.push([name, v]);
      // A second date bound makes a window.
      if (name === 'date' && v !== undefined && r.chance(0.3)) q.push(['date', value.date!(anchor, supported.date!)!]);
    }
    if (supported.date && r.chance(0.35)) q.push(['_sort', r.chance(0.5) ? 'date' : '-date']);
    if (r.chance(0.2)) q.push(['_offset', String(r.int(4))]);
    if (r.chance(0.25)) q.push(['_count', String(1 + r.int(10))]);
    queries.push([['_type', type], ...q]);
  }
  return queries;
}

const queryString = (q: Query) => q.filter(([k]) => k !== '_type').map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

describe('search matches Medplum MemoryRepository 5.2.7', () => {
  const world = generateWorld(SEED, WORLD_SIZE);
  const store = new Store(world);
  const repo = new MemoryRepository();
  const queries = makeQueries(world);

  beforeAll(async () => {
    indexStructureDefinitionBundle(readJson('fhir/r4/profiles-types.json') as Bundle);
    indexStructureDefinitionBundle(readJson('fhir/r4/profiles-resources.json') as Bundle);
    indexSearchParameterBundle(readJson('fhir/r4/search-parameters.json') as Bundle<SearchParameter>);
    // Seeding keeps the fixture ids, as our store does.
    await repo.withSeeding(async () => {
      for (const resource of world) await repo.createResource(structuredClone(resource));
    });
  });

  it(`returns identical id lists on ${QUERIES} generated queries`, async () => {
    const mismatches: string[] = [];
    let nonEmpty = 0;
    const perParam = Object.fromEntries([...PARAMS, ...PREFIXES].map((k) => [k, 0])) as Record<string, number>;
    for (const q of queries) {
      const type = q[0]![1];
      const qs = queryString(q);
      const theirs = await repo.search(parseSearchRequest(`${type}?${qs}`));
      const theirIds = (theirs.entry ?? []).map((e) => e.resource!.id);
      const query: Record<string, string[]> = {};
      for (const [k, v] of q.slice(1)) (query[k] ??= []).push(v);
      const ours = store.search(type, query);
      const ourIds = ours.resources.map((x) => x.id);
      if (JSON.stringify(ourIds) !== JSON.stringify(theirIds) || ours.total !== theirs.total)
        mismatches.push(`${type}?${decodeURIComponent(qs)}\n  ours   ${ours.total} ${JSON.stringify(ourIds)}\n  medplum ${theirs.total} ${JSON.stringify(theirIds)}`);
      if (theirIds.length > 0) nonEmpty++;
      for (const [k, v] of q.slice(1)) {
        perParam[k]!++;
        if (k === 'date') perParam[v.slice(0, 2)]!++;
      }
    }
    const pct = ((100 * nonEmpty) / queries.length).toFixed(1);
    console.log(
      `search-diff: ${queries.length} queries over ${world.length} resources; ${nonEmpty} (${pct}%) non-empty; ` +
        `${queries.length - mismatches.length} identical, ${mismatches.length} mismatched\n` +
        `search-diff: uses per parameter and prefix ${JSON.stringify(perParam)}`,
    );
    expect(mismatches.slice(0, 5).join('\n')).toBe('');
    expect(queries.length).toBeGreaterThanOrEqual(200);
    expect(nonEmpty / queries.length).toBeGreaterThanOrEqual(0.7);
    for (const k of [...PARAMS, ...PREFIXES]) expect(perParam[k], k).toBeGreaterThanOrEqual(1);
  });
});
