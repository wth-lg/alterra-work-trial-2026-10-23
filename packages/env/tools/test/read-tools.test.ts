// Contract tests for the read tools (design section 3): strict schemas, error codes, stable
// order, the 8k-token page cap with next_offset, and exposure tags that match the payload.
import { readFileSync } from 'node:fs';
import type { DiagnosticReport, DocumentReference, Observation, Patient, Procedure, Resource, Task } from '@medplum/fhirtypes';
import { describe, expect, it } from 'vitest';
import { clock, NOW } from '../../clock.ts';
import { parseNdjson } from '../../fixture-source.ts';
import { Store } from '../../store.ts';
import { INBOX_QUEUE_SYSTEM, READ_TOOLS, type CatalogEntry, type Policy, type ReadContext } from '../read/index.ts';
import { approxTokens, callTool, definitions, RESULT_TOKEN_CAP, type ToolResult } from '../registry.ts';
import { ruleViolations } from './exposure-rule.ts';

const root = new URL('../../../../', import.meta.url);
const base = await parseNdjson(readFileSync(new URL('fixtures/world.ndjson.gz', root)));

// The world holds no inbox Tasks until the task overlays land, so these stand in for them.
const inboxTask = (id: string, queue: string, received: string, status: Task['status'], patient: string): Task => ({
  resourceType: 'Task',
  id,
  status,
  intent: 'order',
  code: { coding: [{ system: INBOX_QUEUE_SYSTEM, code: queue }] },
  focus: { reference: 'DiagnosticReport/dr-00011' },
  for: { reference: `Patient/${patient}` },
  authoredOn: received,
  requester: { reference: 'Organization/org-st-brigid' },
  description: `item ${id}`,
});
const INBOX: Task[] = [
  inboxTask('task-x-3', 'results', '2026-10-22T09:00:00-04:00', 'requested', 'pt-0001'),
  inboxTask('task-x-1', 'results', '2026-10-22T09:00:00-04:00', 'requested', 'pt-0002'),
  inboxTask('task-x-2', 'results', '2026-10-21T17:30:00-04:00', 'completed', 'pt-0003'),
  inboxTask('task-x-4', 'messages', '2026-10-20T08:00:00-04:00', 'requested', 'pt-0004'),
];
const POLICIES: Policy[] = [
  { id: 'RBC-TEST-02', title: 'Second test policy', version: '2', effective: '2026-02-01', source: 'environment-local', text: 'Second.' },
  { id: 'RBC-TEST-01', title: 'First test policy', version: '1', effective: '2026-01-01', source: 'environment-local', text: 'First policy text.' },
];
const CATALOG: CatalogEntry[] = [
  { kind: 'medication', code: '860975', system: 'http://www.nlm.nih.gov/research/umls/rxnorm', display: 'metformin hydrochloride 500 MG Oral Tablet', strengths: ['500 mg'] },
  { kind: 'medication', code: '861007', system: 'http://www.nlm.nih.gov/research/umls/rxnorm', display: 'metformin hydrochloride 1000 MG Oral Tablet', strengths: ['1000 mg'] },
  { kind: 'lab', code: '2160-0', system: 'http://loinc.org', display: 'Creatinine [Mass/volume] in Serum or Plasma' },
  { kind: 'imaging', code: 'IMG-CT-CHEST-WO', system: 'urn:riverbend:orders', display: 'CT chest without contrast' },
];

function context(extra: Resource[] = []): ReadContext {
  return { world: new Store([...base, ...INBOX, ...extra]), clock, policies: POLICIES, catalog: CATALOG };
}
const ctx = context();
const call = (name: string, input: unknown, c: ReadContext = ctx) => callTool(READ_TOOLS, name, input, c);

function ok(result: ToolResult): Record<string, unknown> {
  if (result.is_error) throw new Error(`expected success, got ${JSON.stringify(result.content)}`);
  return result.content as Record<string, unknown>;
}
function err(result: ToolResult): { code: string; message: string; field?: string } {
  expect(result.is_error).toBe(true);
  expect(result.exposed_ids).toEqual([]);
  expect(result.referenced_ids).toEqual([]);
  return (result.content as { error: { code: string; message: string; field?: string } }).error;
}

// Written apart from the registry's walker: a JSON.parse reviver visits every value once.
const KINDS = [
  'Patient', 'Practitioner', 'Organization', 'Group', 'Encounter', 'EpisodeOfCare', 'Appointment', 'Condition', 'Observation',
  'DiagnosticReport', 'DocumentReference', 'AllergyIntolerance', 'Procedure', 'MedicationRequest', 'ServiceRequest', 'Task',
  'Communication', 'Provenance', 'Policy',
];
const REF = new RegExp(`^(${KINDS.join('|')})/[A-Za-z0-9.-]{1,64}$`);
function payloadIds(content: unknown): { exposed: string[]; referenced: string[] } {
  const exposed = new Set<string>();
  const refs = new Set<string>();
  JSON.parse(JSON.stringify(content), (_k, v: unknown) => {
    if (typeof v === 'string' && REF.test(v)) refs.add(v);
    else if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const { resourceType, id } = v as { resourceType?: unknown; id?: unknown };
      // A resource whose note text was left out (an attachment naming read_with) is referenced.
      if (typeof resourceType === 'string' && typeof id === 'string') (JSON.stringify(v).includes('"read_with":') ? refs : exposed).add(`${resourceType}/${id}`);
      // A search_notes row shows its note's text as a snippet, which exposes the note.
      const { note, snippet } = v as { note?: unknown; snippet?: unknown };
      if (typeof snippet === 'string' && typeof note === 'string' && REF.test(note)) exposed.add(note);
    }
    return v;
  });
  return { exposed: [...exposed].sort(), referenced: [...refs].filter((r) => !exposed.has(r)).sort() };
}
function expectTagsMatch(result: ToolResult): void {
  const { exposed, referenced } = payloadIds(result.content);
  expect(result.exposed_ids).toEqual(exposed);
  expect(result.referenced_ids).toEqual(referenced);
}

const NAMES = ['get_context', 'search_patients', 'fhir_search', 'fhir_read', 'search_notes', 'read_policy', 'lookup_catalog', 'list_inbox', 'calculate'];

describe('definitions', () => {
  it('are MCP-shaped with strict object schemas', () => {
    const defs = definitions(READ_TOOLS);
    expect(defs.map((d) => d.name)).toEqual(NAMES);
    for (const d of defs) {
      expect(Object.keys(d).sort()).toEqual(['description', 'inputSchema', 'name']);
      expect(d.description.length).toBeGreaterThan(20);
      expect(d.inputSchema.type).toBe('object');
      expect(d.inputSchema.additionalProperties).toBe(false);
      for (const p of Object.values(d.inputSchema.properties)) expect(['string', 'integer']).toContain(p.type);
      for (const r of d.inputSchema.required ?? []) expect(Object.keys(d.inputSchema.properties)).toContain(r);
    }
  });
});

describe('input validation', () => {
  it('rejects an unknown property, naming it', () => {
    const e = err(call('fhir_read', { resource_type: 'Patient', id: 'pt-0001', extra: 1 }));
    expect(e.code).toBe('INVALID_INPUT');
    expect(e.field).toBe('extra');
  });
  it('rejects a missing required property', () => {
    expect(err(call('fhir_read', { resource_type: 'Patient' }))).toMatchObject({ code: 'INVALID_INPUT', field: 'id' });
  });
  it('rejects a wrong type, an out-of-range integer and a value outside the enum', () => {
    expect(err(call('fhir_read', { resource_type: 'Patient', id: 7 }))).toMatchObject({ code: 'INVALID_INPUT', field: 'id' });
    expect(err(call('fhir_search', { resource_type: 'Observation', count: 51 }))).toMatchObject({ code: 'INVALID_INPUT', field: 'count' });
    expect(err(call('fhir_search', { resource_type: 'Observation', count: 2.5 }))).toMatchObject({ code: 'INVALID_INPUT', field: 'count' });
    expect(err(call('fhir_search', { resource_type: 'Medication' }))).toMatchObject({ code: 'INVALID_INPUT', field: 'resource_type' });
  });
  it.each([null, [], 'x', 3])('rejects input %j that is not an object', (input) => {
    expect(err(call('get_context', input)).code).toBe('INVALID_INPUT');
  });
  it('answers an unknown tool with NOT_SUPPORTED listing the tools', () => {
    const e = err(call('fhir_delete', {}));
    expect(e.code).toBe('NOT_SUPPORTED');
    expect(e.message).toContain('fhir_search');
  });
});

describe('get_context', () => {
  it('states the pinned clock, the user and the clinic', () => {
    const r = call('get_context', {});
    expect(ok(r)).toEqual({
      now: NOW,
      timezone: 'America/New_York',
      user: { practitioner: 'Practitioner/pr-okafor', name: 'Maya Okafor, MD', role: 'physician' },
      clinic: { organization: 'Organization/org-riverbend', name: 'Riverbend Family Medicine' },
    });
    expect(r.exposed_ids).toEqual([]);
    expect(r.referenced_ids).toEqual(['Organization/org-riverbend', 'Practitioner/pr-okafor']);
  });
});

describe('search_patients', () => {
  it('finds by MRN, by name words in any case and by birth date', () => {
    const byMrn = ok(call('search_patients', { mrn: '100001' }));
    expect(byMrn.entries).toEqual([
      { resourceType: 'Patient', id: 'pt-0001', patient: 'Patient/pt-0001', name: 'Peter Prosacco', birthDate: '1921-06-10', gender: 'male', mrn: '100001', pcp: null },
    ]);
    const byName = ok(call('search_patients', { name: 'prosacco PETER' }));
    expect((byName.entries as Array<{ patient: string }>).map((e) => e.patient)).toEqual(['Patient/pt-0001']);
    const byBirth = ok(call('search_patients', { birthdate: '1921-06-10' }));
    expect((byBirth.entries as Array<{ patient: string }>).map((e) => e.patient)).toContain('Patient/pt-0001');
  });
  it('exposes the patients its rows show demographics for (name, birth date, gender, MRN)', () => {
    const r = call('search_patients', { mrn: '100001' });
    expect(r.exposed_ids).toEqual(['Patient/pt-0001']);
    expect(r.referenced_ids).toEqual([]);
    expectTagsMatch(r);
  });
  it('lists every patient in id order across pages', () => {
    const ids: string[] = [];
    let offset: number | undefined = 0;
    while (offset !== undefined) {
      const page = ok(call('search_patients', { offset, count: 25 }));
      ids.push(...(page.entries as Array<{ patient: string }>).map((e) => e.patient));
      offset = page.next_offset as number | undefined;
    }
    const all = [...ctx.world.search('Patient', {}).resources].map((p) => `Patient/${p.id}`);
    expect(ids).toEqual([...all].sort());
  });
});

// The design's order: date (instant), then id; undated last.
function dateKey(o: Observation): number | undefined {
  const v = o.effectiveDateTime ?? o.effectivePeriod?.start ?? o.effectiveInstant;
  return v === undefined ? undefined : Date.parse(v);
}
function expectedObservationOrder(patient: string, descending = false): string[] {
  const obs = [...ctx.world.search<Observation>('Observation', { patient }).resources];
  return obs
    .sort((a, b) => {
      const ka = dateKey(a);
      const kb = dateKey(b);
      if (ka === undefined || kb === undefined) return ka === kb ? (a.id! < b.id! ? -1 : 1) : ka === undefined ? 1 : -1;
      return (descending ? kb - ka : ka - kb) || (a.id! < b.id! ? -1 : 1);
    })
    .map((o) => `Observation/${o.id}`);
}

describe('fhir_search', () => {
  it('pages a result over the 8k cap: each page under the cap, pages concatenate to the full ordered result', () => {
    const expected = expectedObservationOrder('pt-0001');
    let offset: number | undefined = 0;
    const got: string[] = [];
    let pages = 0;
    let truncated = 0;
    while (offset !== undefined) {
      const r = call('fhir_search', { resource_type: 'Observation', patient: 'pt-0001', count: 50, offset });
      const page = ok(r);
      expect(page.total).toBe(expected.length);
      const entries = page.entries as Resource[];
      expect(entries.length).toBeGreaterThan(0);
      expect(approxTokens(JSON.stringify(page))).toBeLessThanOrEqual(RESULT_TOKEN_CAP);
      expectTagsMatch(r);
      expect(r.exposed_ids).toEqual(entries.map((e) => `Observation/${e.id}`).sort());
      if (page.truncated) truncated++;
      got.push(...entries.map((e) => `Observation/${e.id}`));
      offset = page.next_offset as number | undefined;
      pages++;
    }
    process.stdout.write(`fhir_search Observation patient=pt-0001: total ${expected.length}, ${pages} pages, ${truncated} cut by the 8k cap\n`);
    expect(truncated).toBeGreaterThan(0);
    expect(got).toEqual(expected);
  });
  it('sorts by -date with ties broken by id', () => {
    const expected = expectedObservationOrder('pt-0002', true).slice(0, 10);
    const page = ok(call('fhir_search', { resource_type: 'Observation', patient: 'pt-0002', sort: '-date', count: 10 }));
    expect((page.entries as Resource[]).map((e) => `Observation/${e.id}`)).toEqual(expected);
  });
  it('filters by code, status and date range', () => {
    const page = ok(call('fhir_search', { resource_type: 'Observation', code: 'http://loinc.org|32207-3', status: 'final', date_ge: '2024-01-01', date_le: '2024-12-31' }));
    const entries = page.entries as Observation[];
    expect(entries.length).toBeGreaterThan(0);
    for (const o of entries) {
      expect(o.code?.coding?.some((c) => c.code === '32207-3')).toBe(true);
      expect(o.effectiveDateTime! >= '2024-01-01').toBe(true);
    }
  });
  it('answers a parameter the type does not support with NOT_SUPPORTED listing what it supports', () => {
    const e = err(call('fhir_search', { resource_type: 'Condition', date_ge: '2024-01-01' }));
    expect(e.code).toBe('NOT_SUPPORTED');
    expect(e.field).toBe('date_ge');
    expect(e.message).toContain('patient, code, category');
    expect(err(call('fhir_search', { resource_type: 'Patient', sort: 'date' }))).toMatchObject({ code: 'NOT_SUPPORTED', field: 'sort' });
  });
  it('rejects a date that is not on the calendar', () => {
    expect(err(call('fhir_search', { resource_type: 'Observation', date_ge: '2026-02-31' }))).toMatchObject({ code: 'INVALID_INPUT', field: 'date_ge' });
  });
  it('returns an empty page, not an error, for a patient with no matches', () => {
    expect(ok(call('fhir_search', { resource_type: 'Observation', patient: 'pt-9999' }))).toEqual({ total: 0, entries: [] });
  });
  it('breaks a date tie by id in both directions, whatever the period ends', () => {
    const proc = (id: string, end: string): Procedure => ({
      resourceType: 'Procedure',
      id,
      status: 'completed',
      subject: { reference: 'Patient/pt-0060' },
      performedPeriod: { start: '2019-06-01T22:00:00-04:00', end },
    });
    const c = context([proc('proc-z-1', '2019-06-01T23:10:00-04:00'), proc('proc-z-2', '2019-06-01T22:43:00-04:00')]);
    const ids = (sort: string) =>
      (ok(call('fhir_search', { resource_type: 'Procedure', patient: 'pt-0060', date_ge: '2019-06-01', date_le: '2019-06-02', sort }, c)).entries as Resource[]).map((e) => e.id);
    expect(ids('date')).toEqual(['proc-z-1', 'proc-z-2']);
    expect(ids('-date')).toEqual(['proc-z-1', 'proc-z-2']);
  });
  it('dates a report without an effective time by its issued time, as search_notes rows do', () => {
    const report: DiagnosticReport = {
      resourceType: 'DiagnosticReport',
      id: 'dr-z-issued',
      status: 'final',
      code: { coding: [{ system: 'http://loinc.org', code: '18748-4', display: 'Diagnostic imaging study' }] },
      subject: { reference: 'Patient/pt-0060' },
      issued: '2019-03-04T10:00:00-05:00',
      presentedForm: [{ contentType: 'text/plain; charset=utf-8', data: btoa('gadolinium given without reaction') }],
    };
    const c = context([report]);
    const day = { date_ge: '2019-03-04', date_le: '2019-03-04' };
    const found = ok(call('fhir_search', { resource_type: 'DiagnosticReport', patient: 'pt-0060', ...day }, c)).entries as Resource[];
    expect(found.map((e) => e.id)).toEqual(['dr-z-issued']);
    const rows = ok(call('search_notes', { query: 'gadolinium', patient: 'pt-0060', ...day }, c)).entries as Array<{ note: string; date: string }>;
    expect(rows).toMatchObject([{ note: 'DiagnosticReport/dr-z-issued', date: '2019-03-04T10:00:00-05:00' }]);
  });
});

// Design section 3: a note counts as exposed only when the tool returned its readable text,
// which fhir_read does. fhir_search returns notes and reports with each text attachment's
// base64 replaced by its size and read_with: 'fhir_read', and tags them as referenced.
describe('note text and exposure', () => {
  const decoded = (data: string) => new TextDecoder().decode(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)));
  const withText = <T extends Resource>(type: string, attachments: (r: T) => Array<{ data?: string }> | undefined) =>
    ctx.world.search<T>(type, { patient: 'pt-0001' }).resources.filter((r) => attachments(r)?.some((a) => a.data !== undefined));

  it.each([
    ['DocumentReference', (r: DocumentReference) => r.content.map((c) => c.attachment)],
    ['DiagnosticReport', (r: DiagnosticReport) => r.presentedForm],
  ] as const)('fhir_search returns %s without its text and tags it as referenced', (type, attachments) => {
    const stored = withText(type, attachments as (r: Resource) => Array<{ data?: string }> | undefined);
    expect(stored.length).toBeGreaterThan(0);
    const r = call('fhir_search', { resource_type: type, patient: 'pt-0001', count: 50 });
    const entries = ok(r).entries as Resource[];
    const refs = stored.map((s) => `${type}/${s.id}`);
    for (const s of stored) {
      const entry = entries.find((e) => e.id === s.id)!;
      const original = (attachments as (r: Resource) => Array<{ data?: string }>)(s);
      const shown = (attachments as (r: Resource) => Array<Record<string, unknown>>)(entry);
      shown.forEach((a, i) => {
        expect(a.data).toBeUndefined();
        expect(a).toMatchObject({ read_with: 'fhir_read', size: new TextEncoder().encode(decoded(original[i]!.data!)).length });
      });
    }
    expect(r.exposed_ids).not.toEqual(expect.arrayContaining([refs[0]]));
    expect(r.referenced_ids).toEqual(expect.arrayContaining(refs));
    expect(r.shown).toBeUndefined();
    expectTagsMatch(r);
    // The stored resources keep their data: the tool returned copies.
    expect((attachments as (r: Resource) => Array<{ data?: string }>)(ctx.world.get(type, stored[0]!.id!)!)[0]!.data).toBeDefined();
  });
  it('fhir_read returns the decoded text once, without the base64, and exposes the note', () => {
    const doc = ctx.world.get<DocumentReference>('DocumentReference', 'doc-00001')!;
    const r = call('fhir_read', { resource_type: 'DocumentReference', id: 'doc-00001' });
    const body = ok(r) as { resource: DocumentReference; text: string };
    expect(body.text).toBe(decoded(doc.content[0]!.attachment.data!));
    expect(body.resource.content[0]!.attachment.data).toBeUndefined();
    expect(body.resource.content[0]!.attachment).not.toHaveProperty('read_with');
    expect(body.resource.content[0]!.attachment.size).toBe(new TextEncoder().encode(body.text).length);
    expect(r.exposed_ids).toEqual(['DocumentReference/doc-00001']);
    expect(r.shown).toEqual({ 'DocumentReference/doc-00001': body.text });
    expectTagsMatch(r);
  });
});

describe('fhir_read', () => {
  it('returns the stored resource and exposes it', () => {
    const r = call('fhir_read', { resource_type: 'Observation', id: 'obs-00001' });
    expect(ok(r).resource).toEqual(ctx.world.get('Observation', 'obs-00001'));
    expect(r.exposed_ids).toEqual(['Observation/obs-00001']);
    expect(r.referenced_ids).toEqual(['Patient/pt-0001']);
    expectTagsMatch(r);
  });
  it('answers an unknown id with NOT_FOUND', () => {
    expect(err(call('fhir_read', { resource_type: 'Observation', id: 'obs-99999' }))).toMatchObject({ code: 'NOT_FOUND', field: 'id' });
  });
});

describe('search_notes', () => {
  const note = (id: string, text: string, date: string): DocumentReference => ({
    resourceType: 'DocumentReference',
    id,
    status: 'current',
    type: { coding: [{ system: 'http://loinc.org', code: '18842-5', display: 'Discharge summary' }] },
    subject: { reference: 'Patient/pt-0060' },
    date,
    author: [{ reference: 'Practitioner/pr-reyes' }],
    content: [{ attachment: { contentType: 'text/plain; charset=utf-8', data: btoa(text) } }],
  });
  const small = context([
    note('doc-z-b', 'iohexol reaction hives. iohexol again.', '2019-05-01T10:00:00-04:00'),
    note('doc-z-a', 'iohexol reaction hives. iohexol again.', '2019-05-02T10:00:00-04:00'),
    note('doc-z-c', 'contrast reaction once, iohexol mentioned in a much longer note about many other unrelated things entirely', '2020-01-01T10:00:00-04:00'),
    note('doc-z-d', 'iodinated contrast allergy', '2021-01-01T10:00:00-04:00'),
  ]);
  it('ranks by BM25 over literal tokens, ties by id, with no synonyms', () => {
    const r = call('search_notes', { query: 'iohexol', patient: 'pt-0060' }, small);
    const page = ok(r);
    const rows = page.entries as Array<{ note: string; type: string; author: string; patient: string; date: string; snippet: string }>;
    expect(rows.map((x) => x.note)).toEqual(['DocumentReference/doc-z-a', 'DocumentReference/doc-z-b', 'DocumentReference/doc-z-c']);
    expect(rows[0]).toMatchObject({ type: 'discharge-summary', author: 'Practitioner/pr-reyes', patient: 'Patient/pt-0060', date: '2019-05-02T10:00:00-04:00' });
    expect(rows[0]!.snippet).toContain('iohexol');
    expectTagsMatch(r);
  });
  it('exposes each note for the snippet it shows and records that exact text', () => {
    const r = call('search_notes', { query: 'iohexol', patient: 'pt-0060' }, small);
    const rows = ok(r).entries as Array<{ note: string; snippet: string }>;
    expect(r.exposed_ids).toEqual(['DocumentReference/doc-z-a', 'DocumentReference/doc-z-b', 'DocumentReference/doc-z-c']);
    expect(r.referenced_ids).toEqual(['Patient/pt-0060', 'Practitioner/pr-reyes']);
    expect(r.shown).toEqual(Object.fromEntries(rows.map((x) => [x.note, x.snippet])));
    expect(r.shown!['DocumentReference/doc-z-a']).toBe('iohexol reaction hives. iohexol again.');
  });
  it('filters by type and date', () => {
    const rows = ok(call('search_notes', { query: 'contrast', type: 'discharge-summary', date_ge: '2021-01-01' }, small)).entries as Array<{ note: string }>;
    expect(rows.map((x) => x.note)).toEqual(['DocumentReference/doc-z-d']);
  });
  it('searches the base world notes and reports', () => {
    const rows = ok(call('search_notes', { query: 'chief complaint', patient: 'pt-0001' })).entries as Array<{ note: string }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((x) => /^(DocumentReference|DiagnosticReport)\//.test(x.note))).toBe(true);
  });
  it('rejects a query with no searchable token', () => {
    expect(err(call('search_notes', { query: '...' }))).toMatchObject({ code: 'INVALID_INPUT', field: 'query' });
  });
});

describe('read_policy', () => {
  it('lists policies by id without their text', () => {
    const r = call('read_policy', {});
    expect(ok(r).entries).toEqual([
      { policy: 'Policy/RBC-TEST-01', title: 'First test policy', version: '1', effective: '2026-01-01', source: 'environment-local' },
      { policy: 'Policy/RBC-TEST-02', title: 'Second test policy', version: '2', effective: '2026-02-01', source: 'environment-local' },
    ]);
    expect(r.exposed_ids).toEqual([]);
    expectTagsMatch(r);
  });
  it('returns one policy with its text and exposes it', () => {
    const r = call('read_policy', { policy_id: 'RBC-TEST-01' });
    expect(ok(r)).toEqual({ resourceType: 'Policy', id: 'RBC-TEST-01', title: 'First test policy', version: '1', effective: '2026-01-01', source: 'environment-local', text: 'First policy text.' });
    expect(r.exposed_ids).toEqual(['Policy/RBC-TEST-01']);
    expect(r.shown).toEqual({ 'Policy/RBC-TEST-01': 'First policy text.' });
  });
  it('answers an unknown id with NOT_FOUND', () => {
    expect(err(call('read_policy', { policy_id: 'RBC-NOPE-01' }))).toMatchObject({ code: 'NOT_FOUND', field: 'policy_id' });
  });
});

describe('results that cannot be paged', () => {
  it('answer a single policy or note over the 8k cap with NOT_SUPPORTED, never an oversized payload', () => {
    const long = 'word '.repeat(6000);
    const big: ReadContext = {
      ...context([
        {
          resourceType: 'DocumentReference',
          id: 'doc-z-long',
          status: 'current',
          subject: { reference: 'Patient/pt-0060' },
          content: [{ attachment: { contentType: 'text/plain', data: btoa(long) } }],
        } satisfies DocumentReference,
      ]),
      policies: [{ id: 'RBC-LONG-01', title: 'Long', version: '1', effective: '2026-01-01', source: 'environment-local', text: long }],
    };
    for (const [name, input] of [
      ['read_policy', { policy_id: 'RBC-LONG-01' }],
      ['fhir_read', { resource_type: 'DocumentReference', id: 'doc-z-long' }],
    ] as const) {
      const e = err(call(name, input, big));
      expect(e.code).toBe('NOT_SUPPORTED');
      expect(e.message).toContain(`${RESULT_TOKEN_CAP}-token cap`);
    }
  });
});

describe('lookup_catalog', () => {
  it('matches every query word within one kind, ordered by display', () => {
    const r = call('lookup_catalog', { query: 'Metformin tablet', kind: 'medication' });
    expect((ok(r).entries as Array<{ code: string }>).map((e) => e.code)).toEqual(['861007', '860975']);
    expect(ok(call('lookup_catalog', { query: 'metformin', kind: 'lab' })).entries).toEqual([]);
    expect(ok(call('lookup_catalog', { query: 'creatinine', kind: 'lab' })).entries).toEqual([
      { code: '2160-0', system: 'http://loinc.org', display: 'Creatinine [Mass/volume] in Serum or Plasma' },
    ]);
    expect(r.exposed_ids).toEqual([]);
    expect(r.referenced_ids).toEqual([]);
  });
});

describe('list_inbox', () => {
  it('lists a queue by received time, then id, and filters by status', () => {
    const r = call('list_inbox', { queue: 'results' });
    const rows = ok(r).entries as Array<Record<string, unknown>>;
    expect(rows.map((x) => x.task)).toEqual(['Task/task-x-2', 'Task/task-x-1', 'Task/task-x-3']);
    expect(rows[1]).toEqual({
      task: 'Task/task-x-1',
      focus: 'DiagnosticReport/dr-00011',
      patient: 'Patient/pt-0002',
      received: '2026-10-22T09:00:00-04:00',
      from: 'Organization/org-st-brigid',
      summary: 'item task-x-1',
      status: 'requested',
    });
    expectTagsMatch(r);
    const open = ok(call('list_inbox', { queue: 'results', status: 'requested' })).entries as Array<{ task: string }>;
    expect(open.map((x) => x.task)).toEqual(['Task/task-x-1', 'Task/task-x-3']);
    expect((ok(call('list_inbox', { queue: 'messages' })).entries as unknown[]).length).toBe(1);
  });
});

// One call per tool, each held to the exposure rule (exposure-rule.ts): exposed exactly when
// the result shows the fields a clinician acts on, referenced when it shows an id, a title or a
// pointer. Before P5's fix search_patients showed a birth date while tagging the Patient
// referenced, which failed T3's birth-date-before-first-write gate on a correct trajectory.
describe('exposure rule', () => {
  const stored = (key: string) => ctx.world.get(key.slice(0, key.indexOf('/')), key.slice(key.indexOf('/') + 1));
  it.each([
    ['get_context', {}, [], []],
    ['search_patients', { name: 'prosacco' }, ['Patient/pt-0001'], ['Patient']],
    ['fhir_search', { resource_type: 'Observation', patient: 'pt-0001', count: 5 }, null, ['Observation']],
    ['fhir_search', { resource_type: 'MedicationRequest', patient: 'pt-0001', count: 5 }, null, ['MedicationRequest']],
    ['fhir_search', { resource_type: 'DocumentReference', patient: 'pt-0001', count: 5 }, [], []],
    ['fhir_read', { resource_type: 'Patient', id: 'pt-0001' }, ['Patient/pt-0001'], ['Patient']],
    ['fhir_read', { resource_type: 'DocumentReference', id: 'doc-00001' }, ['DocumentReference/doc-00001'], ['DocumentReference']],
    ['search_notes', { query: 'patient', patient: 'pt-0001' }, null, ['DiagnosticReport', 'DocumentReference']],
    ['read_policy', {}, [], []],
    ['lookup_catalog', { query: 'metformin', kind: 'medication' }, [], []],
    ['list_inbox', { queue: 'results' }, [], []],
    ['calculate', { expression: '1 + 2' }, [], []],
  ] as const)('%s %j', (name, input, exposed, exposedTypes) => {
    const r = call(name, input);
    expect(r.is_error).toBe(false);
    expect(ruleViolations(r, stored)).toEqual([]);
    if (exposed !== null) expect(r.exposed_ids).toEqual(exposed);
    expect([...new Set(r.exposed_ids.map((k) => k.slice(0, k.indexOf('/'))))].sort()).toEqual([...exposedTypes]);
    expectTagsMatch(r);
  });
  it('catches a row that shows a birth date but only references the patient', () => {
    const p = ctx.world.get<Patient>('Patient', 'pt-0001')!;
    const row: ToolResult = {
      is_error: false,
      content: { entries: [{ patient: 'Patient/pt-0001', birthDate: p.birthDate, gender: p.gender }] },
      exposed_ids: [],
      referenced_ids: ['Patient/pt-0001'],
    };
    expect(ruleViolations(row, stored)).toEqual(['Patient/pt-0001 shows its decisive fields but is not exposed']);
    expect(ruleViolations({ ...row, content: { entries: [{ patient: 'Patient/pt-0001' }] }, exposed_ids: ['Patient/pt-0001'], referenced_ids: [] }, stored)).toEqual([
      'Patient/pt-0001 is exposed without its decisive fields',
    ]);
  });
});

describe('calculate', () => {
  it.each([
    ['1 + 2 * 3', 7],
    ['(1 + 2) * 3', 9],
    ['2 ^ 3 ^ 2', 512],
    ['-2 ^ 2', -4],
    ['10 / 4', 2.5],
    ['0.1 + 0.2', 0.3],
    ['sqrt(16)', 4],
    ['ln(exp(2))', 2],
    ['log(1000)', 3],
    ['min(3, 1, 2)', 1],
    ['max(1, 5)', 5],
    ['abs(-3)', 3],
    ['round(2.345, 2)', 2.35],
    ['round(-2.5)', -3],
    ['round(1.005, 2)', 1.01],
    ['round(10 ^ 300, 12)', 1e300],
    ['round(-(10 ^ 300), 12)', -1e300],
    ['((140 - 80) * 70) / (72 * 1.1)', 53.0303030303],
    ['.5 * 4', 2],
  ])('%s = %d', (expression, result) => {
    const r = call('calculate', { expression });
    expect(ok(r)).toEqual({ result });
    expect(r.exposed_ids).toEqual([]);
  });
  it.each(['1 / 0', 'sqrt(-1)', 'ln(0)', '2 +', '(1', '1)', 'foo(1)', 'round(1, 2, 3)', 'min()', 'process.exit(1)', '1 , 2', '2 3', '1e400', '9^9^9', ''])(
    'rejects %j with INVALID_INPUT',
    (expression) => {
      expect(err(call('calculate', { expression }))).toMatchObject({ code: 'INVALID_INPUT', field: 'expression' });
    },
  );
});
