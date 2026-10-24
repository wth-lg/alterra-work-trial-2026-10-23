// The exposure rule (registry.ts), checked against the stored resources rather than the
// payload's shape, so it is independent of the registry's walker: a read result exposes a
// resource exactly when it shows the fields a clinician acts on, and only references it when it
// shows an id, a title, a pointer to read it later or an excerpt. A note's decisive content is
// its whole text; an excerpt (a search_notes snippet) is shown text but not exposure, and its
// title or size is neither. An inbox row is a pointer, so its summary must not carry the value
// of the resource it points at.
import type { Attachment, DiagnosticReport, DocumentReference, Observation, Resource } from '@medplum/fhirtypes';
import type { ToolResult } from '../registry.ts';

// The fields a clinician acts on, per type, as the stored resource names them. A note's decisive
// content is its whole text (below). Types not listed are returned whole or not at all.
const DECISIVE: Record<string, (key: string) => boolean> = {
  Patient: (k) => k === 'birthDate' || k === 'gender',
  Observation: (k) => k === 'status' || k.startsWith('value') || k.startsWith('effective'),
  MedicationRequest: (k) => k === 'status' || k.startsWith('medication') || k === 'dosageInstruction',
};
const NOTES = new Set(['DocumentReference', 'DiagnosticReport']);

const decode = (a: Attachment) => new TextDecoder().decode(Uint8Array.from(atob(a.data!), (c) => c.charCodeAt(0)));
function texts(r: Resource): string[] {
  const all = r.resourceType === 'DocumentReference' ? (r as DocumentReference).content.map((c) => c.attachment) : ((r as DiagnosticReport).presentedForm ?? []);
  return all.filter((a) => a.data !== undefined && (a.contentType ?? '').startsWith('text/')).map(decode);
}

function objects(value: unknown, out: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
  if (value !== null && typeof value === 'object') {
    if (!Array.isArray(value)) out.push(value as Record<string, unknown>);
    for (const v of Object.values(value)) objects(v, out);
  }
  return out;
}
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (value !== null && typeof value === 'object') for (const v of Object.values(value)) strings(v, out);
  return out;
}

// An object names a resource when it is that resource (resourceType and id) or a row that holds
// its reference as one of its own values.
const names = (o: Record<string, unknown>, key: string) =>
  `${String(o.resourceType)}/${String(o.id)}` === key || Object.values(o).some((v) => v === key);

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();
const CUT = /^…|…$/;

// Whether `s` is the note's whole text, as stored or whitespace-collapsed.
const wholeNote = (s: string, stored: Resource): boolean => texts(stored).some((t) => t === s || collapse(t) === collapse(s));

// Whether `s` is text from the note: its whole text, or an excerpt marked with an ellipsis at a
// cut end. A string without one must be the whole text, so a title or a status is not text.
function fromNote(s: string, stored: Resource): boolean {
  if (wholeNote(s, stored)) return true;
  const excerpt = collapse(s.replace(/^…|…$/g, ''));
  return CUT.test(s) && excerpt.length > 0 && texts(stored).some((t) => collapse(t).includes(excerpt));
}

// Whether the payload shows `stored`'s decisive content: a note's whole text in an object naming it,
// or every decisive field of the stored resource, with its stored value, in an object naming it.
function shows(payload: unknown, stored: Resource): boolean | undefined {
  const key = `${stored.resourceType}/${stored.id}`;
  if (NOTES.has(stored.resourceType)) {
    if (texts(stored).length === 0) return undefined;
    return objects(payload).some((o) => (names(o, key) || names((o.resource ?? {}) as Record<string, unknown>, key)) && strings(Object.values(o).filter((v) => typeof v === 'string')).some((s) => wholeNote(s, stored)));
  }
  const decisive = DECISIVE[stored.resourceType];
  if (!decisive) return undefined;
  const fields = Object.entries(stored).filter(([k]) => decisive(k));
  if (fields.length === 0) return undefined;
  return objects(payload).some((o) => names(o, key) && fields.every(([k, v]) => JSON.stringify(o[k]) === JSON.stringify(v)));
}

// The values an inbox summary must not show for its focus: an Observation's value and its
// components' values, and a report's conclusion.
function clinicalValues(r: Resource): string[] {
  const of = (o: Pick<Observation, 'valueQuantity' | 'valueString' | 'valueInteger' | 'valueCodeableConcept'>) =>
    [o.valueQuantity?.value, o.valueInteger, o.valueString, o.valueCodeableConcept?.text].filter((v) => v !== undefined).map(String);
  if (r.resourceType === 'Observation') return [...of(r as Observation), ...((r as Observation).component ?? []).flatMap(of)];
  if (r.resourceType === 'DiagnosticReport') return (r as DiagnosticReport).conclusion === undefined ? [] : [(r as DiagnosticReport).conclusion!];
  return [];
}
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A number matches as a whole number ('2.4' is not in '12.4' or '2.45'); text ignoring case.
const carries = (summary: string, value: string) =>
  /^-?\d+(\.\d+)?$/.test(value) ? new RegExp(`(?<![\\d.])${escape(value)}(?![\\d]|\\.\\d)`).test(summary) : value.length >= 3 && summary.toLowerCase().includes(value.toLowerCase());

// The ways a result's tags break the rule: a resource whose decisive content is shown but which
// is not exposed (under-tagging), one exposed without it (over-tagging), shown text that is not
// the resource's or names a resource the result neither exposes nor references, and an inbox
// row ({task, focus, summary}) whose summary carries its focus's value, which would make the
// referenced focus seen.
export function ruleViolations(result: ToolResult, stored: (key: string) => Resource | undefined): string[] {
  if (result.is_error) return [];
  const out: string[] = [];
  for (const [key, text] of Object.entries(result.shown ?? {})) {
    const r = stored(key);
    if (r && NOTES.has(r.resourceType) && !fromNote(text, r) && !text.split('\n').every((t) => fromNote(t, r))) out.push(`${key} shown text is not from the note`);
    if (!result.exposed_ids.includes(key) && !result.referenced_ids.includes(key)) out.push(`${key} has shown text but is neither exposed nor referenced`);
  }
  for (const o of objects(result.content)) {
    if (typeof o.task !== 'string' || typeof o.focus !== 'string' || typeof o.summary !== 'string') continue;
    const focus = stored(o.focus);
    if (focus && clinicalValues(focus).some((v) => carries(o.summary as string, v))) out.push(`${o.task} summary shows the value of ${o.focus}`);
  }
  const candidates = new Set([...result.exposed_ids, ...result.referenced_ids, ...strings(result.content)]);
  for (const key of candidates) {
    const r = stored(key);
    if (!r) continue;
    const shown = shows(result.content, r);
    if (shown === undefined) continue;
    const exposed = result.exposed_ids.includes(key);
    if (shown && !exposed) out.push(`${key} shows its decisive fields but is not exposed`);
    if (!shown && exposed) out.push(`${key} is exposed without its decisive fields`);
  }
  return out;
}
