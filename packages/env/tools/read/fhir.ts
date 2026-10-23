// fhir_search and fhir_read (design section 3): generic FHIR-shaped reads that return full
// resources, so every entry is exposed.
import type { Resource } from '@medplum/fhirtypes';
import { search, SearchError, type SearchQuery } from '../../search.ts';
import { ToolError } from '../errors.ts';
import type { Tool } from '../registry.ts';
import type { ReadContext } from './context.ts';
import { noteText } from './notes.ts';
import { page } from './page.ts';
import { count, date, FHIR_ID, offset, patient, resourceType } from './schema.ts';

// Runs a search, turning a SearchError (a query the store cannot answer) into the model's
// INVALID_INPUT on `field`.
export function runSearch<T extends Resource>(run: () => { resources: Array<Readonly<T>> }, field: string): Array<Readonly<T>> {
  try {
    return run().resources;
  } catch (e) {
    if (e instanceof SearchError) throw new ToolError('INVALID_INPUT', e.message, field, { cause: e });
    throw e;
  }
}

type Filter = 'patient' | 'code' | 'category' | 'status' | 'date_ge' | 'date_le' | 'sort';
const FILTERS: readonly Filter[] = ['patient', 'code', 'category', 'status', 'date_ge', 'date_le', 'sort'];

// The search parameter behind each input property, with a value it accepts on any type.
const PARAM: Record<Filter, [string, string]> = {
  patient: ['patient', 'x'],
  code: ['code', 'x'],
  category: ['category', 'x'],
  status: ['status', 'x'],
  date_ge: ['date', '2026'],
  date_le: ['date', '2026'],
  sort: ['date', '2026'],
};

const supportCache = new Map<string, readonly Filter[]>();

// The filters a resource type supports, found by asking the search module rather than keeping
// a second copy of its parameter table.
function supported(type: string): readonly Filter[] {
  let list = supportCache.get(type);
  if (!list) {
    list = FILTERS.filter((f) => {
      const [param, probe] = PARAM[f];
      try {
        runSearch(() => search([], type, { [param]: probe }), f);
        return true;
      } catch (e) {
        if (e instanceof ToolError) return false;
        throw e;
      }
    });
    supportCache.set(type, list);
  }
  return list;
}

// The search query for the given filters. Throws NOT_SUPPORTED for a filter the type lacks and
// INVALID_INPUT, naming the property, for a value the search module rejects.
export function filterQuery(type: string, input: Partial<Record<Filter, string | undefined>>): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {};
  const dates: string[] = [];
  for (const f of FILTERS) {
    const value = input[f];
    if (value === undefined || f === 'sort') continue;
    if (!supported(type).includes(f)) {
      const list = supported(type).join(', ') || 'none of these filters';
      throw new ToolError('NOT_SUPPORTED', `${type} cannot be filtered by '${f}'. ${type} supports: ${list}`, f);
    }
    const [param] = PARAM[f];
    const v = f === 'date_ge' ? `ge${value}` : f === 'date_le' ? `le${value}` : value;
    // A search over nothing still parses the query, so a bad value is caught with its property.
    runSearch(() => search([], type, { [param]: v }), f);
    if (param === 'date') dates.push(v);
    else query[param] = v;
  }
  if (dates.length > 0) query.date = dates;
  return query;
}

const byId = (a: Resource, b: Resource) => (a.id! < b.id! ? -1 : a.id! > b.id! ? 1 : 0);

type SearchInput = {
  resource_type: string;
  patient?: string;
  code?: string;
  category?: string;
  status?: string;
  date_ge?: string;
  date_le?: string;
  sort?: 'date' | '-date';
  count?: number;
  offset?: number;
};

export const fhirSearch: Tool<ReadContext> = {
  name: 'fhir_search',
  description:
    'Search one FHIR R4 resource type. Filters combine with AND; a comma inside code, category or status means OR. ' +
    "code and category take 'system|code' or a bare code. Entries are full resources, ordered by date (sort=date, the default, or -date), then id; " +
    'types without a date order by id. Not every type supports every filter; an unsupported one returns NOT_SUPPORTED with the supported list. ' +
    'Pages are capped in size: when next_offset is present, call again with offset=next_offset for the rest.',
  inputSchema: {
    type: 'object',
    properties: {
      resource_type: resourceType,
      patient,
      code: { type: 'string', description: "Token, 'system|code' or a bare code", minLength: 1, maxLength: 200 },
      category: { type: 'string', description: "Token, 'system|code' or a bare code", minLength: 1, maxLength: 200 },
      status: { type: 'string', description: 'Status code, e.g. final or active', minLength: 1, maxLength: 100 },
      date_ge: date('Earliest date'),
      date_le: date('Latest date'),
      sort: { type: 'string', description: 'date (oldest first, the default) or -date (newest first)', enum: ['date', '-date'] },
      count: count(50, 20),
      offset,
    },
    required: ['resource_type'],
    additionalProperties: false,
  },
  run(input: SearchInput, { world }) {
    const type = input.resource_type;
    const query = filterQuery(type, input);
    const dated = supported(type).includes('sort');
    if (input.sort !== undefined && !dated) {
      throw new ToolError('NOT_SUPPORTED', `${type} has no date to sort by. ${type} supports: ${supported(type).join(', ') || 'none of these filters'}`, 'sort');
    }
    // The query is checked above, so a SearchError from here on is the environment's fault
    // and propagates as INTERNAL.
    const matches = [...world.search(type, query).resources].sort(byId);
    // The search module's sort is stable, so equal dates keep the id order given here.
    const ordered = dated ? search(matches, type, { _sort: input.sort ?? 'date' } satisfies SearchQuery).resources : matches;
    return page(ordered, input.offset ?? 0, input.count ?? 20);
  },
};

export const fhirRead: Tool<ReadContext> = {
  name: 'fhir_read',
  description:
    "Read one resource by type and id (for the reference 'DocumentReference/doc-00001', resource_type DocumentReference and id doc-00001). " +
    'Returns {resource}; for a DocumentReference or DiagnosticReport with a text attachment it also returns the decoded note text as {text}.',
  inputSchema: {
    type: 'object',
    properties: {
      resource_type: resourceType,
      id: { type: 'string', description: 'Resource id, e.g. obs-00001', pattern: FHIR_ID },
    },
    required: ['resource_type', 'id'],
    additionalProperties: false,
  },
  run(input: { resource_type: string; id: string }, { world }) {
    const resource = world.get(input.resource_type, input.id);
    if (!resource) throw new ToolError('NOT_FOUND', `no ${input.resource_type} with id '${input.id}'`, 'id');
    const text = noteText(resource);
    return text === undefined ? { resource } : { resource, text };
  },
};
