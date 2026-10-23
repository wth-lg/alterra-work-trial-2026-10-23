// lookup_catalog (design section 3): the formulary and the order catalog. Entries are codes,
// not resources, so results carry no exposure.
import { ToolError } from '../errors.ts';
import type { Tool } from '../registry.ts';
import { CATALOG_KINDS, type CatalogEntry, type ReadContext } from './context.ts';
import { page } from './page.ts';
import { count, offset } from './schema.ts';

const words = (s: string) => (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) as string[];
const haystack = (e: CatalogEntry) => [e.display, e.code, ...(e.strengths ?? [])].join(' ').toLowerCase();

export const lookupCatalog: Tool<ReadContext> = {
  name: 'lookup_catalog',
  description:
    'Look up orderable codes: medication (RxNorm formulary), lab, imaging or referral. Every query word must appear in the entry ' +
    '(name, code or strength). Returns {code, system, display, strengths?} ordered by display.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Words or a code', minLength: 1, maxLength: 100 },
      kind: { type: 'string', description: 'Catalog to search', enum: CATALOG_KINDS },
      count: count(50, 20),
      offset,
    },
    required: ['query', 'kind'],
    additionalProperties: false,
  },
  run(input: { query: string; kind: string; count?: number; offset?: number }, { catalog }) {
    const want = words(input.query);
    if (want.length === 0) throw new ToolError('INVALID_INPUT', "'query' must contain at least one letter or digit", 'query');
    const rows = catalog
      .filter((e) => e.kind === input.kind && want.every((w) => haystack(e).includes(w)))
      .map((e) => ({ key: e.display.toLowerCase(), e }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.e.code < b.e.code ? -1 : a.e.code > b.e.code ? 1 : 0))
      .map(({ e }) => ({ code: e.code, system: e.system, display: e.display, ...(e.strengths ? { strengths: [...e.strengths] } : {}) }));
    return page(rows, input.offset ?? 0, input.count ?? 20);
  },
};
