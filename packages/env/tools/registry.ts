// The tool registry (design section 3). Definitions are MCP-shaped (name, description,
// inputSchema), so the Messages loop and an optional MCP adapter list the same tools. callTool
// is the one way a tool runs: strict input validation, then the tool, then exposure tags
// computed from the payload it returned.
//
// Exposure (design section 3, "Exposure tagging") follows one rule: a result exposes a resource
// when it shows the fields a clinician would act on (a Patient's demographics, birth date
// included; an Observation's value, unit, status and date; a MedicationRequest's medication,
// dose and status; a note's or report's whole text, as fhir_read returns it; a policy's text),
// and only references it when it shows an id, a title, a pointer to read it later or an excerpt.
// The tags are derived from the payload, not declared by each tool, so they cannot drift from
// what the model saw:
//   - exposed_ids: every object in the payload with a string resourceType and id (a full
//     resource, a full policy with resourceType 'Policy', or a row that shows that resource's
//     decisive fields, as search_patients rows do);
//   - referenced_ids: every other string in the payload of the form <Kind>/<id>: references
//     inside those resources and the ids that summary rows name, plus resources returned
//     without their decisive content (below);
//   - shown: for each note, report or policy whose text the payload shows, that text with its
//     whitespace collapsed to single spaces (case kept), the same for every shape: a search_notes
//     row's snippet ({note, snippet}), a note or report read with fhir_read ({resource, text}) or
//     a whole policy ({resourceType: 'Policy', id, text}). Shown text is not exposure: a snippet
//     is an excerpt, so its note stays referenced, and exposed_ids keeps meaning "the decisive
//     content was shown". A task grader asks whether a decisive phrase was shown with
//     grader/exposure.ts shows(), which compares both sides whitespace-collapsed and ignoring
//     case, so a phrase split across lines in the note matches as it does in a snippet.
// Tools follow four conventions for this to hold: a row that shows a resource's decisive
// fields carries its resourceType and id; a row that shows a note's, report's or policy's text
// carries it in one of the three shapes above (no other object's `text` is shown text); a row
// that does neither (an inbox item, a policy title, a search_notes row) names ids only as
// references ('Patient/pt-0001') and never carries a resourceType; and a resource returned with
// content left out holds an object with a `read_with` key naming the tool that returns it (a
// note's text attachment in fhir_search, which shows only its size), which makes the resource
// referenced, not exposed. Each read tool's header says which applies.
//
// A write tool (tools/write/) returns a Committed: its payload plus the ids it put into the
// store. callTool reports those as written_ids, which is how the grader learns what a call
// changed; no other result has the field.
import { RESOURCE_TYPES } from '../world.ts';
import { ToolError, type ErrorBody } from './errors.ts';

export type PropertySchema =
  | { type: 'string'; description: string; enum?: readonly string[]; minLength?: number; maxLength?: number; pattern?: string }
  | { type: 'integer'; description: string; minimum?: number; maximum?: number }
  | { type: 'number'; description: string; exclusiveMinimum?: number; maximum?: number }
  | { type: 'array'; description: string; items: PropertySchema; minItems?: number; maxItems?: number }
  | (ObjectSchema & { description: string });

export interface ObjectSchema {
  type: 'object';
  properties: Readonly<Record<string, PropertySchema>>;
  required?: readonly string[];
  additionalProperties: false;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: ObjectSchema;
}

export type ToolInput = Readonly<Record<string, unknown>>;

export interface Tool<C> extends ToolDefinition {
  // Called only with input that passed inputSchema. Method syntax, so a tool can declare its
  // own input type. Returns the JSON payload; throws ToolError for the model's faults.
  run(input: ToolInput, ctx: C): unknown;
}

export interface ToolResult {
  is_error: boolean;
  content: unknown;
  exposed_ids: string[];
  referenced_ids: string[];
  // Present only when the payload shows a note's, report's or policy's text: that text per
  // reference, whitespace-collapsed (above).
  // The loop does not record it; the grader derives it from the recorded content (shownText).
  shown?: Readonly<Record<string, string>>;
  // Present only on a committed write: every resource the call put into the store, as
  // <Type>/<id>, sorted (the resources it created or changed, and its Provenance). Reads,
  // errors and finish have none.
  written_ids?: string[];
}

// What a write tool returns once its resources are in the store (tools/write/commit.ts).
export class Committed {
  readonly content: unknown;
  readonly written: readonly string[];

  constructor(content: unknown, written: readonly string[]) {
    this.content = content;
    this.written = written;
  }
}

// Results are capped at 8k tokens (design section 3). The count is estimated, not tokenized:
// one token per 3 UTF-16 code units of the JSON. Claude's tokenizer averages more characters
// per token than that on JSON and English, so the estimate errs high and the real size stays
// under the cap. List results page to stay under it (read/page.ts); callTool turns any result
// still over it, such as one long note, into NOT_SUPPORTED.
export const RESULT_TOKEN_CAP = 8000;
export const approxTokens = (json: string): number => Math.ceil(json.length / 3);
export const withinCap = (jsonLength: number): boolean => Math.ceil(jsonLength / 3) <= RESULT_TOKEN_CAP;

export function definitions(tools: readonly ToolDefinition[]): ToolDefinition[] {
  return tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

const patterns = new Map<string, RegExp>();
const regex = (p: string) => patterns.get(p) ?? patterns.set(p, new RegExp(p, 'u')).get(p)!;

// Strings and object members are checked where they are; `name` is the input path, e.g.
// reactions[0].severity, and is the field an error names.
function checkProperty(name: string, schema: PropertySchema, value: unknown): ToolError | undefined {
  const bad = (expected: string) => new ToolError('INVALID_INPUT', `'${name}' must be ${expected}`, name);
  switch (schema.type) {
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) return bad('an integer');
      if (schema.minimum !== undefined && value < schema.minimum) return bad(`at least ${schema.minimum}`);
      if (schema.maximum !== undefined && value > schema.maximum) return bad(`at most ${schema.maximum}`);
      return undefined;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return bad('a number');
      if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) return bad(`greater than ${schema.exclusiveMinimum}`);
      if (schema.maximum !== undefined && value > schema.maximum) return bad(`at most ${schema.maximum}`);
      return undefined;
    case 'array': {
      if (!Array.isArray(value)) return bad('an array');
      if (schema.minItems !== undefined && value.length < schema.minItems) return bad(`at least ${schema.minItems} items`);
      if (schema.maxItems !== undefined && value.length > schema.maxItems) return bad(`at most ${schema.maxItems} items`);
      for (let i = 0; i < value.length; i++) {
        const invalid = checkProperty(`${name}[${i}]`, schema.items, value[i]);
        if (invalid) return invalid;
      }
      return undefined;
    }
    case 'object':
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return bad('an object');
      return checkMembers(schema, value as ToolInput, `${name}.`);
    case 'string':
      if (typeof value !== 'string') return bad('a string');
      if (schema.enum && !schema.enum.includes(value)) return bad(`one of: ${schema.enum.join(', ')}`);
      if (schema.minLength !== undefined && value.length < schema.minLength) return bad(`at least ${schema.minLength} characters`);
      if (schema.maxLength !== undefined && value.length > schema.maxLength) return bad(`at most ${schema.maxLength} characters`);
      if (schema.pattern !== undefined && !regex(schema.pattern).test(value)) return bad(`in the form ${schema.description}`);
      return undefined;
  }
}

// Unknown members, then missing required ones, then each member in schema order. `at` prefixes
// the names: '' at the top level, 'new_dose.' inside an object property.
function checkMembers(schema: Pick<ObjectSchema, 'properties' | 'required'>, input: ToolInput, at: string): ToolError | undefined {
  const names = Object.keys(schema.properties);
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(schema.properties, key)) {
      const takes = names.length === 0 ? 'this tool takes no parameters' : `${at === '' ? 'parameters' : 'properties'}: ${names.join(', ')}`;
      return new ToolError('INVALID_INPUT', `'${at}${key}' is not a ${at === '' ? 'parameter' : 'property'} (${takes})`, `${at}${key}`);
    }
  }
  for (const key of schema.required ?? []) {
    if (input[key] === undefined) return new ToolError('INVALID_INPUT', `'${at}${key}' is required`, `${at}${key}`);
  }
  for (const key of names) {
    const value = input[key];
    if (value === undefined) continue;
    const invalid = checkProperty(`${at}${key}`, schema.properties[key]!, value);
    if (invalid) return invalid;
  }
  return undefined;
}

// The ToolError for input that does not satisfy the schema, or undefined if it does.
export function validateInput(schema: ObjectSchema, input: unknown): ToolError | undefined {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return new ToolError('INVALID_INPUT', 'input must be a JSON object');
  return checkMembers(schema, input as ToolInput, '');
}

const REF = new RegExp(`^(${[...RESOURCE_TYPES, 'Policy'].join('|')})/[A-Za-z0-9.-]{1,64}$`);

const isId = (v: unknown): v is string => typeof v === 'string';

const TEXT_TYPES = new Set(['DocumentReference', 'DiagnosticReport']);
const typeOf = (ref: string) => ref.slice(0, ref.indexOf('/'));

// Shown text as it is recorded and compared: whitespace runs collapsed to one space, trimmed,
// case kept.
export const collapseWhitespace = (text: string): string => text.replace(/\s+/g, ' ').trim();

// The note, report or policy whose text an object shows, and the text, in one of the three
// shapes above. Any other object shows no text, whatever its keys.
function textIn(o: Record<string, unknown>): [string, string] | undefined {
  if (typeof o.snippet === 'string' && isId(o.note) && REF.test(o.note) && TEXT_TYPES.has(typeOf(o.note))) return [o.note, o.snippet];
  if (typeof o.text !== 'string') return undefined;
  const r = (o.resource ?? {}) as { resourceType?: unknown; id?: unknown };
  if (isId(r.resourceType) && TEXT_TYPES.has(r.resourceType) && isId(r.id)) return [`${r.resourceType}/${r.id}`, o.text];
  return o.resourceType === 'Policy' && isId(o.id) ? [`Policy/${o.id}`, o.text] : undefined;
}

interface Tags {
  exposed: Set<string>;
  refs: Set<string>;
  shown: Map<string, string[]>;
}

// Walks one value; returns whether it holds content left out (an object with read_with).
function walk(value: unknown, tags: Tags): boolean {
  if (typeof value === 'string') {
    if (REF.test(value)) tags.refs.add(value);
    return false;
  }
  if (value === null || typeof value !== 'object') return false;
  let partial = !Array.isArray(value) && Object.hasOwn(value, 'read_with');
  for (const v of Object.values(value)) partial = walk(v, tags) || partial;
  if (Array.isArray(value)) return partial;
  const { resourceType, id } = value as { resourceType?: unknown; id?: unknown };
  if (isId(resourceType) && isId(id)) (partial ? tags.refs : tags.exposed).add(`${resourceType}/${id}`);
  const text = textIn(value as Record<string, unknown>);
  if (text) tags.shown.set(text[0], [...(tags.shown.get(text[0]) ?? []), collapseWhitespace(text[1])]);
  return partial;
}

function tagsOf(payload: unknown): Tags {
  const tags: Tags = { exposed: new Set(), refs: new Set(), shown: new Map() };
  walk(payload, tags);
  return tags;
}

const shownOf = (tags: Tags): Record<string, string> =>
  Object.fromEntries([...tags.shown].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, v.join('\n')]));

// The text a payload shows per reference, whitespace-collapsed, in payload order and
// newline-joined when one resource's text appears twice. The grader calls this on a recorded result's content.
export const shownText = (payload: unknown): Record<string, string> => shownOf(tagsOf(payload));

export function exposure(payload: unknown): Pick<ToolResult, 'exposed_ids' | 'referenced_ids' | 'shown'> {
  const tags = tagsOf(payload);
  const { exposed, refs } = tags;
  const shown = shownOf(tags);
  return {
    exposed_ids: [...exposed].sort(),
    referenced_ids: [...refs].filter((r) => !exposed.has(r)).sort(),
    ...(Object.keys(shown).length > 0 ? { shown } : {}),
  };
}

const failure = (e: ToolError): ToolResult => ({ is_error: true, content: e.body() satisfies ErrorBody, exposed_ids: [], referenced_ids: [] });

// Runs one tool call. A ToolError becomes an error result; any other exception propagates for
// the caller to record as INTERNAL (see errors.ts).
export function callTool<C>(tools: readonly Tool<C>[], name: string, input: unknown, ctx: C): ToolResult {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return failure(new ToolError('NOT_SUPPORTED', `unknown tool '${name}'; tools: ${tools.map((t) => t.name).join(', ')}`));
  const invalid = validateInput(tool.inputSchema, input);
  if (invalid) return failure(invalid);
  let payload: unknown;
  try {
    payload = tool.run(input as ToolInput, ctx);
  } catch (e) {
    if (e instanceof ToolError) return failure(e);
    throw e;
  }
  const written = payload instanceof Committed ? [...payload.written].sort() : undefined;
  if (payload instanceof Committed) payload = payload.content;
  const json = JSON.stringify(payload);
  if (!withinCap(json.length)) {
    // The resources are already in the store, so reporting a rejection would be false.
    if (written) throw new Error(`${name}: a committed write's result is over the ${RESULT_TOKEN_CAP}-token cap`);
    const message = `the result is about ${approxTokens(json)} tokens, over the ${RESULT_TOKEN_CAP}-token cap; ask for less (a smaller count, narrower filters, or search_notes for passages of a long note)`;
    return failure(new ToolError('NOT_SUPPORTED', message));
  }
  return { is_error: false, content: payload, ...exposure(payload), ...(written ? { written_ids: written } : {}) };
}
