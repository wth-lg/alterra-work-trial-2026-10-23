// The exposure rule (registry.ts), checked against the stored resources rather than the
// payload's shape, so it is independent of the registry's walker: a read result exposes a
// resource exactly when it shows the fields a clinician acts on, and only references it when it
// shows an id, a title or a pointer to read it later. A note's decisive content is its text,
// whole or as an excerpt (a search_notes snippet); its title or size is not.
import type { Attachment, DiagnosticReport, DocumentReference, Resource } from '@medplum/fhirtypes';
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

// Whether `s` is text from the note: its whole text, or an excerpt marked with an ellipsis at a
// cut end. A string without one must be the whole text, so a title or a status is not text.
function fromNote(s: string, stored: Resource): boolean {
  const whole = texts(stored);
  if (whole.some((t) => t === s || collapse(t) === collapse(s))) return true;
  const excerpt = collapse(s.replace(/^…|…$/g, ''));
  return CUT.test(s) && excerpt.length > 0 && whole.some((t) => collapse(t).includes(excerpt));
}

// Whether the payload shows `stored`'s decisive content: a note's text in an object naming it,
// or every decisive field of the stored resource, with its stored value, in an object naming it.
function shows(payload: unknown, stored: Resource): boolean | undefined {
  const key = `${stored.resourceType}/${stored.id}`;
  if (NOTES.has(stored.resourceType)) {
    if (texts(stored).length === 0) return undefined;
    return objects(payload).some((o) => (names(o, key) || names((o.resource ?? {}) as Record<string, unknown>, key)) && strings(Object.values(o).filter((v) => typeof v === 'string')).some((s) => fromNote(s, stored)));
  }
  const decisive = DECISIVE[stored.resourceType];
  if (!decisive) return undefined;
  const fields = Object.entries(stored).filter(([k]) => decisive(k));
  if (fields.length === 0) return undefined;
  return objects(payload).some((o) => names(o, key) && fields.every(([k, v]) => JSON.stringify(o[k]) === JSON.stringify(v)));
}

// The ways a result's tags break the rule: a resource whose decisive content is shown but which
// is not exposed (under-tagging), one exposed without it (over-tagging), or shown text that is
// not the resource's.
export function ruleViolations(result: ToolResult, stored: (key: string) => Resource | undefined): string[] {
  if (result.is_error) return [];
  const out: string[] = [];
  for (const [key, text] of Object.entries(result.shown ?? {})) {
    const r = stored(key);
    if (r && NOTES.has(r.resourceType) && !fromNote(text, r) && !text.split('\n').every((t) => fromNote(t, r))) out.push(`${key} shown text is not from the note`);
    if (!result.exposed_ids.includes(key)) out.push(`${key} has shown text but is not exposed`);
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
