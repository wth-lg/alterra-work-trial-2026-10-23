// search_notes (design section 3): keyword search over the text of notes (DocumentReference)
// and reports (DiagnosticReport presentedForm). BM25 over literal tokens: no stemming, no
// synonyms. Rows carry a snippet, so a note found here is referenced, not exposed; its full
// text is exposed only by fhir_read.
import type { Attachment, DiagnosticReport, DocumentReference, Resource } from '@medplum/fhirtypes';
import { ToolError } from '../errors.ts';
import type { Tool } from '../registry.ts';
import type { ReadContext } from './context.ts';
import { filterQuery } from './fhir.ts';
import { page } from './page.ts';
import { count, date, offset, patient } from './schema.ts';

const NOTE_TYPES = ['DocumentReference', 'DiagnosticReport'] as const;

function attachments(resource: Readonly<Resource>): readonly Attachment[] {
  if (resource.resourceType === 'DocumentReference') return (resource as DocumentReference).content.map((c) => c.attachment);
  if (resource.resourceType === 'DiagnosticReport') return (resource as DiagnosticReport).presentedForm ?? [];
  return [];
}

// Strict: bytes that are not UTF-8 are a fixture defect and surface as INTERNAL.
const utf8 = new TextDecoder('utf-8', { fatal: true });
const decode = (base64: string) => utf8.decode(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));

// The decoded text of a note or report's inline text attachments, or undefined if it has none.
export function noteText(resource: Readonly<Resource>): string | undefined {
  const texts = attachments(resource)
    .filter((a) => a.data !== undefined && (a.contentType ?? '').toLowerCase().startsWith('text/'))
    .map((a) => decode(a.data!));
  return texts.length === 0 ? undefined : texts.join('\n\n');
}

const TOKEN = /[\p{L}\p{N}]+/gu;
const tokens = (text: string) => (text.toLowerCase().match(TOKEN) ?? []) as string[];

interface Indexed {
  text: string;
  tf: Map<string, number>;
  length: number;
}

// Stored resources are frozen and replaced, never edited, so an index entry per object stays
// valid for as long as that object is in the store.
const index = new WeakMap<object, Indexed | null>();
function indexed(resource: Readonly<Resource>): Indexed | null {
  let entry = index.get(resource);
  if (entry === undefined) {
    const text = noteText(resource);
    if (text === undefined) entry = null;
    else {
      const tf = new Map<string, number>();
      const all = tokens(text);
      for (const t of all) tf.set(t, (tf.get(t) ?? 0) + 1);
      entry = { text, tf, length: all.length };
    }
    index.set(resource, entry);
  }
  return entry;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function typeCodings(resource: Readonly<Resource>) {
  const cc = resource.resourceType === 'DocumentReference' ? (resource as DocumentReference).type : (resource as DiagnosticReport).code;
  return cc?.coding ?? [];
}

// The note type as a slug of its first coding's display ('Discharge summary' ->
// 'discharge-summary'); a type filter matches any coding's slug or code.
function noteType(resource: Readonly<Resource>): string {
  const [first] = typeCodings(resource);
  return first ? (first.display ? slug(first.display) : (first.code ?? 'note')) : 'note';
}
const hasType = (resource: Readonly<Resource>, type: string) =>
  typeCodings(resource).some((c) => (c.code ?? '').toLowerCase() === type || (c.display !== undefined && slug(c.display) === type));

function noteDate(resource: Readonly<Resource>): string | null {
  if (resource.resourceType === 'DocumentReference') return (resource as DocumentReference).date ?? null;
  const r = resource as DiagnosticReport;
  return r.effectiveDateTime ?? r.effectivePeriod?.start ?? r.issued ?? null;
}
function noteAuthor(resource: Readonly<Resource>): string | null {
  const refs = resource.resourceType === 'DocumentReference' ? (resource as DocumentReference).author : (resource as DiagnosticReport).performer;
  return refs?.[0]?.reference ?? null;
}

const BEFORE = 80;
const AFTER = 160;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

// About 240 characters around the first query token in the text, whitespace collapsed.
function snippet(text: string, query: ReadonlySet<string>): string {
  let at = 0;
  for (const m of text.matchAll(TOKEN)) {
    if (query.has(m[0].toLowerCase())) {
      at = m.index;
      break;
    }
  }
  let start = Math.max(0, at - BEFORE);
  let end = Math.min(text.length, at + AFTER);
  // Never cut a surrogate pair in half.
  if (start > 0 && isLow(text.charCodeAt(start))) start--;
  if (end < text.length && isLow(text.charCodeAt(end))) end++;
  const body = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`;
}

// BM25 parameters: the usual defaults.
const K1 = 1.2;
const B = 0.75;

type NotesInput = {
  query: string;
  patient?: string;
  date_ge?: string;
  date_le?: string;
  type?: string;
  count?: number;
  offset?: number;
};

export const searchNotes: Tool<ReadContext> = {
  name: 'search_notes',
  description:
    'Keyword search over the text of clinical notes and reports. Ranked by BM25 over literal words: no stemming and no synonyms, ' +
    'so search for the words a note would use. Returns {note, date, type, author, patient, snippet} rows, best match first, ties by id. ' +
    'Read a note in full with fhir_read. type filters by note type as listed in the rows (e.g. history-and-physical-note) or a LOINC code.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Words to search for', minLength: 1, maxLength: 200 },
      patient,
      date_ge: date('Earliest note date'),
      date_le: date('Latest note date'),
      type: { type: 'string', description: 'Note type slug or LOINC code', pattern: '^[A-Za-z0-9.-]{1,100}$' },
      count: count(20, 10),
      offset,
    },
    required: ['query'],
    additionalProperties: false,
  },
  run(input: NotesInput, { world }) {
    const query = new Set(tokens(input.query));
    if (query.size === 0) throw new ToolError('INVALID_INPUT', "'query' must contain at least one letter or digit", 'query');
    const type = input.type?.toLowerCase();

    // Corpus statistics are over every note, so a filter does not change a note's score.
    const corpus = NOTE_TYPES.flatMap((t) => world.search(t, {}).resources).flatMap((r) => {
      const ix = indexed(r);
      return ix ? [{ r, ix }] : [];
    });
    const avgLength = corpus.reduce((s, d) => s + d.ix.length, 0) / Math.max(1, corpus.length);
    const idf = new Map<string, number>();
    for (const t of query) {
      const df = corpus.reduce((n, d) => n + (d.ix.tf.has(t) ? 1 : 0), 0);
      idf.set(t, Math.log(1 + (corpus.length - df + 0.5) / (df + 0.5)));
    }

    const filters = { patient: input.patient, date_ge: input.date_ge, date_le: input.date_le };
    const allowed = new Set(NOTE_TYPES.flatMap((t) => world.search(t, filterQuery(t, filters)).resources));
    const scored: Array<{ ref: string; r: Readonly<Resource>; ix: Indexed; score: number }> = [];
    for (const { r, ix } of corpus) {
      if (!allowed.has(r) || (type !== undefined && !hasType(r, type))) continue;
      let score = 0;
      for (const t of query) {
        const tf = ix.tf.get(t);
        if (tf) score += (idf.get(t)! * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * ix.length) / avgLength));
      }
      if (score > 0) scored.push({ ref: `${r.resourceType}/${r.id}`, r, ix, score });
    }
    scored.sort((a, b) => b.score - a.score || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));

    const rows = scored.map(({ ref, r, ix }) => ({
      note: ref,
      date: noteDate(r),
      type: noteType(r),
      author: noteAuthor(r),
      patient: (r as { subject?: { reference?: string } }).subject?.reference ?? null,
      snippet: snippet(ix.text, query),
    }));
    return page(rows, input.offset ?? 0, input.count ?? 10);
  },
};
