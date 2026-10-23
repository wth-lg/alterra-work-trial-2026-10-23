// Validation step 2, semantics (design section 2, "Write validation"): the patient exists,
// references resolve, have an allowed type and belong to the same patient, codes are in the
// catalog, and times are real ISO 8601 instants that are not in the past. Every failure is a
// ToolError naming the input field.
import type { Resource } from '@medplum/fhirtypes';
import { NOW, NOW_DATE, NOW_MS } from '../../clock.ts';
import { patientRefs } from '../../overlay.ts';
import { RESOURCE_TYPES } from '../../world.ts';
import { ToolError } from '../errors.ts';
import type { CatalogEntry } from '../read/context.ts';
import type { WriteContext } from './context.ts';

const LONE_SURROGATE = /\p{Cs}/u;

// Every string in the input, at any depth: none may be blank, and none may hold an unpaired
// surrogate (it has no exact JSON form, so the store could not hash it).
export function checkStrings(value: unknown, field: string): void {
  if (typeof value === 'string') {
    if (value.trim() === '') throw new ToolError('INVALID_INPUT', `'${field}' must not be blank`, field);
    if (LONE_SURROGATE.test(value)) throw new ToolError('INVALID_INPUT', `'${field}' contains an unpaired UTF-16 surrogate`, field);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => checkStrings(v, `${field}[${i}]`));
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) checkStrings(v, field === '' ? k : `${field}.${k}`);
  }
}

const list = (types: readonly string[]) => (types.length === 1 ? types[0]! : `${types.slice(0, -1).join(', ')} or ${types.at(-1)}`);

// The resource a Type/id or bare id names, among `types`.
export function resolve(ctx: WriteContext, field: string, value: string, types: readonly string[] = RESOURCE_TYPES): Readonly<Resource> {
  const slash = value.indexOf('/');
  if (slash >= 0) {
    const type = value.slice(0, slash);
    if (!types.includes(type)) throw new ToolError('INVALID_INPUT', `'${field}' must reference a ${list(types)}, not ${type}`, field);
    const found = ctx.world.get(type, value.slice(slash + 1));
    if (!found) throw new ToolError('NOT_FOUND', `'${field}': no ${value}`, field);
    return found;
  }
  for (const type of types) {
    const found = ctx.world.get(type, value);
    if (found) return found;
  }
  throw new ToolError('NOT_FOUND', `'${field}': no ${list(types)} with id '${value}'`, field);
}

export const key = (r: Readonly<Resource>) => `${r.resourceType}/${r.id}`;

// Throws unless the resource is about `patient` only (or about no patient).
export function samePatient(field: string, resource: Readonly<Resource>, patient: string): void {
  const patients = resource.resourceType === 'Patient' ? new Set([resource.id!]) : patientRefs(resource);
  for (const p of patients) {
    if (p !== patient) throw new ToolError('INVALID_INPUT', `'${field}' (${key(resource)}) belongs to Patient/${p}, not Patient/${patient}`, field);
  }
}

// The catalog entry for `code` among `kinds`.
export function catalogEntry(ctx: WriteContext, field: string, code: string, kinds: readonly CatalogEntry['kind'][]): CatalogEntry {
  const entry = ctx.catalog.find((e) => e.code === code && kinds.includes(e.kind));
  if (!entry) throw new ToolError('INVALID_INPUT', `'${field}': '${code}' is not a ${list(kinds)} code in the catalog; find one with lookup_catalog`, field);
  return entry;
}

const WHEN = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-](\d{2}):(\d{2})))?$/;

export interface When {
  // The value in FHIR form: a date, or a dateTime with seconds.
  fhir: string;
  dateOnly: boolean;
  // The instant, for a dateTime; the date, for a date.
  ms: number;
}

// A date or dateTime that exists on the calendar and is not before NOW (a date: not before
// NOW's date). The schema has already checked the shape.
export function when(field: string, value: string, opts: { dateTime?: boolean } = {}): When {
  const m = WHEN.exec(value);
  const bad = (why: string) => new ToolError('INVALID_INPUT', `'${field}' ${why}`, field);
  if (!m) throw bad('is not an ISO 8601 date or dateTime');
  const [, y, mo, d, hh, mi, ss, zone, oh, om] = m;
  const days = new Date(Date.UTC(Number(y), Number(mo), 0)).getUTCDate();
  if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > days) throw bad(`is not a calendar date (${value.slice(0, 10)})`);
  if (hh === undefined) {
    if (opts.dateTime) throw bad('must be a date and time with an offset');
    if (value < NOW_DATE) throw bad(`is in the past (today is ${NOW_DATE})`);
    return { fhir: value, dateOnly: true, ms: Date.UTC(Number(y), Number(mo) - 1, Number(d)) };
  }
  if (Number(hh) > 23 || Number(mi) > 59 || Number(ss ?? 0) > 59 || (zone !== 'Z' && (Number(oh) > 14 || Number(om) > 59))) throw bad(`is not a valid time (${value})`);
  const fhir = `${value.slice(0, 16)}:${ss ?? '00'}${zone}`;
  const ms = Date.parse(fhir);
  if (ms < NOW_MS) throw bad(`is in the past (now is ${NOW})`);
  return { fhir, dateOnly: false, ms };
}
