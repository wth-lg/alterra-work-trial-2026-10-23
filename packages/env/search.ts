// FHIR R4 search over one resource type, by linear scan (design section 2, "Store"). It
// implements exactly the parameters the tools expose: patient, subject, code, category,
// status, date (no prefix, eq, ge, le, gt, lt), _sort=date or -date, _count and _offset.
// Anything else, including a resource type outside the design's 18, is a SearchError, never
// a silently ignored filter.
//
// Matching follows @medplum/fhir-router MemoryRepository 5.2.7, which
// packages/env/test/search-diff.test.ts checks query by query:
//   - each query value is one parameter occurrence; repeated parameters AND, and comma
//     separated values (backslash escapes a comma) OR;
//   - tokens compare case-insensitively: `code`, `system|code`, `|code` (no system) and
//     `system|` (any code in the system);
//   - references compare the reference string; `patient` also takes a bare id;
//   - a date value covers the range its precision implies ('2026-10-01' is that whole UTC
//     day, '...T12:00:00Z' that whole second), and with query range [qlo, qhi]:
//     ge: hi >= qlo, le: lo <= qhi, gt: hi > qhi, lt: lo < qlo.
// Where Medplum departs from FHIR we follow FHIR: _sort orders by instant rather than by
// the date string, a month ends on its last day rather than day 31, token search does not
// match display text, and eq (or no prefix) means the resource range lies within the query
// range (qlo <= lo and hi <= qhi) rather than overlapping it. Resources without a date sort
// last on both date and -date. One extension: a DiagnosticReport without an effective time is
// dated by `issued`, as search_notes dates its rows; R4 reads effective only.
import type { Resource } from '@medplum/fhirtypes';

export class SearchError extends Error {
  override name = 'SearchError';
}

export type SearchQuery = Readonly<Record<string, string | readonly string[]>>;

export interface SearchResult<T extends Resource = Resource> {
  // Matches before _offset and _count.
  total: number;
  resources: Array<Readonly<T>>;
}

type ParamDef =
  | { kind: 'token'; paths: readonly string[] }
  // fallback: read when the paths hold no value.
  | { kind: 'date'; paths: readonly string[]; fallback?: readonly string[] }
  // patientOnly: the R4 expression ends in .where(resolve() is Patient).
  // bareId: the parameter has one target type, so a bare id names it.
  | { kind: 'reference'; paths: readonly string[]; patientOnly: boolean; bareId: boolean };

const token = (...paths: string[]): ParamDef => ({ kind: 'token', paths });
const date = (...paths: string[]): ParamDef => ({ kind: 'date', paths });
const patient = (path: string, patientOnly = true): ParamDef => ({ kind: 'reference', paths: [path], patientOnly, bareId: true });
const subject = (path: string): ParamDef => ({ kind: 'reference', paths: [path], patientOnly: false, bareId: false });

// From the R4 SearchParameter expressions for the design's 18 resource types. Patient,
// Practitioner and Organization have none of these parameters. Read it with Object.hasOwn:
// a plain lookup would find 'constructor' on the prototype.
const PARAMS: Readonly<Record<string, Readonly<Record<string, ParamDef>>>> = {
  Patient: {},
  Practitioner: {},
  Organization: {},
  Group: { code: token('code') },
  Encounter: { date: date('period'), patient: patient('subject'), status: token('status'), subject: subject('subject') },
  EpisodeOfCare: { date: date('period'), patient: patient('patient', false), status: token('status') },
  Appointment: { date: date('start'), patient: patient('participant.actor'), status: token('status') },
  Condition: { code: token('code'), category: token('category'), patient: patient('subject'), subject: subject('subject') },
  Observation: {
    code: token('code'),
    category: token('category'),
    date: date('effectiveDateTime', 'effectivePeriod', 'effectiveInstant'),
    patient: patient('subject'),
    status: token('status'),
    subject: subject('subject'),
  },
  DiagnosticReport: {
    code: token('code'),
    category: token('category'),
    date: { kind: 'date', paths: ['effectiveDateTime', 'effectivePeriod'], fallback: ['issued'] },
    patient: patient('subject'),
    status: token('status'),
    subject: subject('subject'),
  },
  DocumentReference: { category: token('category'), date: date('date'), patient: patient('subject'), status: token('status'), subject: subject('subject') },
  AllergyIntolerance: { category: token('category'), code: token('code', 'reaction.substance'), date: date('recordedDate'), patient: patient('patient', false) },
  Procedure: {
    code: token('code'),
    category: token('category'),
    date: date('performedDateTime', 'performedPeriod'),
    patient: patient('subject'),
    status: token('status'),
    subject: subject('subject'),
  },
  MedicationRequest: {
    code: token('medicationCodeableConcept'),
    category: token('category'),
    date: date('dosageInstruction.timing.event'),
    patient: patient('subject'),
    status: token('status'),
    subject: subject('subject'),
  },
  ServiceRequest: { code: token('code'), category: token('category'), patient: patient('subject'), status: token('status'), subject: subject('subject') },
  Task: { code: token('code'), patient: patient('for'), status: token('status'), subject: subject('for') },
  Communication: { category: token('category'), patient: patient('subject'), status: token('status'), subject: subject('subject') },
  Provenance: { patient: patient('target') },
};

type Json = Readonly<Record<string, unknown>>;

// The values at a dotted path, with arrays flattened at every step.
function valuesAt(resource: Json, path: string): unknown[] {
  let nodes: unknown[] = [resource];
  for (const key of path.split('.')) {
    const next: unknown[] = [];
    for (const node of nodes) {
      const v = node !== null && typeof node === 'object' ? (node as Json)[key] : undefined;
      if (Array.isArray(v)) next.push(...v);
      else if (v !== undefined) next.push(v);
    }
    nodes = next;
  }
  return nodes;
}

// The values a parameter reads from a resource: its paths, or a date's fallback paths when
// those hold nothing.
function paramValues(resource: Json, def: ParamDef): unknown[] {
  const values = def.paths.flatMap((p) => valuesAt(resource, p));
  return values.length === 0 && def.kind === 'date' && def.fallback ? def.fallback.flatMap((p) => valuesAt(resource, p)) : values;
}

// Splits a parameter value on commas not escaped with a backslash.
function orValues(raw: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (c === '\\' && i + 1 < raw.length) cur += raw[++i];
    else if (c === ',') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

// ---- tokens ----

type Token = { system: string | undefined; code: string | undefined };

function tokensOf(values: unknown[]): Token[] {
  const out: Token[] = [];
  for (const v of values) {
    if (typeof v === 'string') out.push({ system: undefined, code: v });
    else if (v !== null && typeof v === 'object') {
      for (const c of valuesAt(v as Json, 'coding') as Array<{ system?: unknown; code?: unknown }>) {
        const system = typeof c.system === 'string' ? c.system : undefined;
        const code = typeof c.code === 'string' ? c.code : undefined;
        if (system !== undefined || code !== undefined) out.push({ system, code });
      }
    }
  }
  return out;
}

function tokenMatcher(name: string, raw: string): (t: Token) => boolean {
  const bar = raw.indexOf('|');
  if (bar < 0) {
    const code = raw.toLowerCase();
    return (t) => t.code?.toLowerCase() === code;
  }
  const system = raw.slice(0, bar).toLowerCase();
  const code = raw.slice(bar + 1).toLowerCase();
  if (!system && !code) throw new SearchError(`${name}: '|' needs a system or a code`);
  if (!system) return (t) => t.system === undefined && t.code?.toLowerCase() === code;
  return (t) => t.system?.toLowerCase() === system && (!code || t.code?.toLowerCase() === code);
}

// ---- dates ----

// [lo, hi] in epoch milliseconds, both inclusive.
type Range = readonly [number, number];

const DATE_RE = /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:\d{2})?)?)?)?$/;

// Epoch milliseconds of a UTC calendar time. Unlike Date.UTC, years 0-99 stay those years
// rather than becoming 1900-1999. Out-of-range fields carry over (month 13 is next January).
function utc(year: number, month: number, day: number, hour: number, minute: number, second: number, ms: number): number {
  const t = new Date(0);
  t.setUTCFullYear(year, month - 1, day);
  t.setUTCHours(hour, minute, second, ms);
  return t.getTime();
}

// The range a FHIR date, dateTime or instant covers at its precision. Without an offset the
// value is read as UTC, as Medplum reads it. Undefined if the string is not a date, including
// an offset outside -14:00..+14:00.
function dateRange(value: string): Range | undefined {
  const m = DATE_RE.exec(value);
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s, frac, tz] = m;
  const n = (x: string | undefined, dflt: number) => (x === undefined ? dflt : Number(x));
  const year = Number(y);
  const month = n(mo, 1);
  const dayOfMonth = n(d, 1);
  const hour = n(h, 0);
  const minute = n(mi, 0);
  const second = n(s, 0);
  if (month < 1 || month > 12 || dayOfMonth < 1 || dayOfMonth > new Date(utc(year, month + 1, 0, 0, 0, 0, 0)).getUTCDate()) return undefined;
  if (hour > 23 || minute > 59 || second > 59) return undefined;
  // Fractions past milliseconds are truncated, as a JS Date truncates them.
  const ms = frac === undefined ? 0 : Number(frac.slice(0, 3).padEnd(3, '0'));
  let offset = 0;
  if (tz && tz !== 'Z') {
    const sign = tz[0] === '-' ? -1 : 1;
    const minutes = Number(tz.slice(4, 6));
    const total = Number(tz.slice(1, 3)) * 60 + minutes;
    if (minutes > 59 || total > 14 * 60) return undefined;
    offset = sign * total * 60_000;
  }
  const at = (yy: number, mm: number, dd: number, hh: number, mn: number, ss: number, mss: number) =>
    utc(yy, mm, dd, hh, mn, ss, mss) - offset;
  const lo = at(year, month, dayOfMonth, hour, minute, second, ms);
  // The first instant after the range, one unit of the value's precision later.
  let next: number;
  if (mo === undefined) next = at(year + 1, 1, 1, 0, 0, 0, 0);
  else if (d === undefined) next = at(year, month + 1, 1, 0, 0, 0, 0);
  else if (h === undefined) next = at(year, month, dayOfMonth + 1, 0, 0, 0, 0);
  else if (s === undefined) next = lo + 60_000;
  else if (frac === undefined) next = lo + 1000;
  else next = lo + 10 ** Math.max(0, 3 - frac.length);
  return [lo, next - 1];
}

function rangesOf(values: unknown[]): Range[] {
  const out: Range[] = [];
  for (const v of values) {
    if (typeof v === 'string') {
      const r = dateRange(v);
      if (!r) throw new SearchError(`stored date '${v}' is not a FHIR date`);
      out.push(r);
    } else if (v !== null && typeof v === 'object') {
      // A Period. A missing start or end is open on that side.
      const { start, end } = v as { start?: unknown; end?: unknown };
      const lo = typeof start === 'string' ? rangesOf([start])[0]![0] : -Infinity;
      const hi = typeof end === 'string' ? rangesOf([end])[0]![1] : Infinity;
      out.push([lo, hi]);
    }
  }
  return out;
}

const DATE_TESTS = {
  eq: (r: Range, q: Range) => q[0] <= r[0] && r[1] <= q[1],
  ge: (r: Range, q: Range) => r[1] >= q[0],
  le: (r: Range, q: Range) => r[0] <= q[1],
  gt: (r: Range, q: Range) => r[1] > q[1],
  lt: (r: Range, q: Range) => r[0] < q[0],
} as const;

function dateMatcher(name: string, raw: string): (r: Range) => boolean {
  // A date starts with a digit, so two leading letters are a prefix. No prefix means eq.
  const prefix = /^[a-z]{2}/.test(raw) ? raw.slice(0, 2) : '';
  if (prefix && !Object.hasOwn(DATE_TESTS, prefix)) throw new SearchError(`${name}: prefix '${prefix}' is not supported (use eq, ge, le, gt or lt)`);
  const q = dateRange(raw.slice(prefix.length));
  if (!q) throw new SearchError(`${name}: '${raw.slice(prefix.length)}' is not a FHIR date`);
  const test = DATE_TESTS[(prefix || 'eq') as keyof typeof DATE_TESTS];
  return (r) => test(r, q);
}

// Throws unless every value a date parameter reads from the resource is a FHIR date, so that
// one bad stored value cannot make every date query and _sort on its type throw.
export function checkDates(resource: Resource): void {
  const params = Object.hasOwn(PARAMS, resource.resourceType) ? PARAMS[resource.resourceType]! : {};
  for (const def of Object.values(params)) {
    if (def.kind !== 'date') continue;
    for (const path of [...def.paths, ...(def.fallback ?? [])]) {
      for (const v of valuesAt(resource as unknown as Json, path)) {
        const parts = typeof v === 'string' ? [v] : v !== null && typeof v === 'object' ? [(v as { start?: unknown }).start, (v as { end?: unknown }).end] : [];
        for (const part of parts) {
          if (typeof part === 'string' && !dateRange(part))
            throw new Error(`${resource.resourceType}/${resource.id}: ${path} '${part}' is not a FHIR date`);
        }
      }
    }
  }
}

// ---- references ----

function referencesOf(values: unknown[], patientOnly: boolean): string[] {
  const out: string[] = [];
  for (const v of values) {
    const ref = v !== null && typeof v === 'object' ? (v as { reference?: unknown }).reference : undefined;
    if (typeof ref === 'string' && (!patientOnly || ref.startsWith('Patient/'))) out.push(ref);
  }
  return out;
}

function referenceMatcher(def: { bareId: boolean }, raw: string): (ref: string) => boolean {
  if (raw.includes('/')) return (ref) => ref === raw;
  if (!def.bareId) return () => false;
  return (ref) => ref.endsWith(`/${raw}`);
}

// ---- query ----

type Filter = (resource: Json) => boolean;

function filterFor(resourceType: string, name: string, raws: string[], def: ParamDef): Filter {
  if (raws.length === 0 || raws.some((r) => r === '')) throw new SearchError(`${resourceType}?${name}: empty value`);
  const values = (r: Json) => paramValues(r, def);
  switch (def.kind) {
    case 'token': {
      const ms = raws.map((raw) => tokenMatcher(name, raw));
      return (r) => {
        const ts = tokensOf(values(r));
        return ms.some((m) => ts.some(m));
      };
    }
    case 'date': {
      const ms = raws.map((raw) => dateMatcher(name, raw));
      return (r) => {
        const rs = rangesOf(values(r));
        return ms.some((m) => rs.some(m));
      };
    }
    case 'reference': {
      const ms = raws.map((raw) => referenceMatcher(def, raw));
      return (r) => {
        const refs = referencesOf(values(r), def.patientOnly);
        return ms.some((m) => refs.some(m));
      };
    }
  }
}

function count(name: string, raws: readonly string[] | undefined): number | undefined {
  if (raws === undefined) return undefined;
  if (raws.length !== 1 || !/^\d+$/.test(raws[0]!)) throw new SearchError(`${name} takes one non-negative integer`);
  return Number(raws[0]);
}

export function search<T extends Resource>(resources: Iterable<Readonly<T>>, resourceType: string, query: SearchQuery): SearchResult<T> {
  if (!Object.hasOwn(PARAMS, resourceType)) throw new SearchError(`${resourceType}: not a searchable resource type`);
  const params = PARAMS[resourceType]!;
  const filters: Filter[] = [];
  let sort: { def: ParamDef; descending: boolean } | undefined;
  let offset: number | undefined;
  let limit: number | undefined;
  for (const [name, value] of Object.entries(query)) {
    const occurrences: readonly string[] = typeof value === 'string' ? [value] : value;
    if (name === '_count') limit = count(name, occurrences);
    else if (name === '_offset') offset = count(name, occurrences);
    else if (name === '_sort') {
      if (occurrences.length !== 1 || !/^-?date$/.test(occurrences[0]!) || !params.date)
        throw new SearchError(`${resourceType}?_sort: only date or -date is supported here`);
      sort = { def: params.date, descending: occurrences[0]!.startsWith('-') };
    } else {
      const def = Object.hasOwn(params, name) ? params[name] : undefined;
      if (!def) throw new SearchError(`${resourceType}?${name}: unsupported search parameter`);
      // Each occurrence is ANDed with the others; its comma-separated values are ORed.
      for (const occurrence of occurrences) filters.push(filterFor(resourceType, name, orValues(occurrence), def));
    }
  }

  let matches: Array<Readonly<T>> = [];
  for (const r of resources) if (r.resourceType === resourceType && filters.every((f) => f(r as Json))) matches.push(r);

  if (sort) {
    const { def, descending } = sort;
    const keyed = matches.map((r) => ({ r, key: rangesOf(paramValues(r as Json, def))[0] }));
    const sign = descending ? -1 : 1;
    // Resources without a date go last whichever way the dated ones run.
    // Not a subtraction: open period bounds are infinite, and -Infinity - -Infinity is NaN.
    const cmp = (x: number, y: number) => (x < y ? -1 : x > y ? 1 : 0);
    // Array sort is stable, so ties keep insertion order in both directions.
    keyed.sort((a, b) => {
      if (!a.key || !b.key) return a.key ? -1 : b.key ? 1 : 0;
      return sign * (cmp(a.key[0], b.key[0]) || cmp(a.key[1], b.key[1]));
    });
    matches = keyed.map((k) => k.r);
  }
  const total = matches.length;
  const start = offset ?? 0;
  return { total, resources: matches.slice(start, limit === undefined ? undefined : start + limit) };
}
