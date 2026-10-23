// The tool registry (design section 3). Definitions are MCP-shaped (name, description,
// inputSchema), so the Messages loop and an optional MCP adapter list the same tools. callTool
// is the one way a tool runs: strict input validation, then the tool, then exposure tags
// computed from the payload it returned.
//
// Exposure (design section 3, "Exposure tagging") is derived from the payload, not declared by
// each tool, so it cannot drift from what the model saw:
//   - exposed_ids: every object in the payload with a string resourceType and id, i.e. a full
//     resource (or a full policy, resourceType 'Policy') returned with its content;
//   - referenced_ids: every other string in the payload of the form <Kind>/<id>: references
//     inside those resources and the ids that summary rows and snippets name.
// Tools follow one convention for this to hold: a summary row names ids as references
// ('Patient/pt-0001') and never carries a resourceType.
import { RESOURCE_TYPES } from '../world.ts';
import { ToolError, type ErrorBody } from './errors.ts';

export type PropertySchema =
  | { type: 'string'; description: string; enum?: readonly string[]; minLength?: number; maxLength?: number; pattern?: string }
  | { type: 'integer'; description: string; minimum?: number; maximum?: number };

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
}

// Results are capped at 8k tokens (design section 3). The count is estimated, not tokenized:
// one token per 3 UTF-16 code units of the JSON. Claude's tokenizer averages more characters
// per token than that on JSON and English, so the estimate errs high and the real size stays
// under the cap.
export const RESULT_TOKEN_CAP = 8000;
export const approxTokens = (json: string): number => Math.ceil(json.length / 3);
export const withinCap = (jsonLength: number): boolean => Math.ceil(jsonLength / 3) <= RESULT_TOKEN_CAP;

export function definitions(tools: readonly ToolDefinition[]): ToolDefinition[] {
  return tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

const patterns = new Map<string, RegExp>();
const regex = (p: string) => patterns.get(p) ?? patterns.set(p, new RegExp(p, 'u')).get(p)!;

function checkProperty(name: string, schema: PropertySchema, value: unknown): ToolError | undefined {
  const bad = (expected: string) => new ToolError('INVALID_INPUT', `'${name}' must be ${expected}`, name);
  if (schema.type === 'integer') {
    if (typeof value !== 'number' || !Number.isInteger(value)) return bad('an integer');
    if (schema.minimum !== undefined && value < schema.minimum) return bad(`at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) return bad(`at most ${schema.maximum}`);
    return undefined;
  }
  if (typeof value !== 'string') return bad('a string');
  if (schema.enum && !schema.enum.includes(value)) return bad(`one of: ${schema.enum.join(', ')}`);
  if (schema.minLength !== undefined && value.length < schema.minLength) return bad(`at least ${schema.minLength} characters`);
  if (schema.maxLength !== undefined && value.length > schema.maxLength) return bad(`at most ${schema.maxLength} characters`);
  if (schema.pattern !== undefined && !regex(schema.pattern).test(value)) return bad(`in the form ${schema.description}`);
  return undefined;
}

// The ToolError for input that does not satisfy the schema, or undefined if it does.
export function validateInput(schema: ObjectSchema, input: unknown): ToolError | undefined {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return new ToolError('INVALID_INPUT', 'input must be a JSON object');
  const names = Object.keys(schema.properties);
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(schema.properties, key)) {
      const takes = names.length === 0 ? 'this tool takes no parameters' : `parameters: ${names.join(', ')}`;
      return new ToolError('INVALID_INPUT', `'${key}' is not a parameter (${takes})`, key);
    }
  }
  for (const key of schema.required ?? []) {
    if ((input as ToolInput)[key] === undefined) return new ToolError('INVALID_INPUT', `'${key}' is required`, key);
  }
  for (const key of names) {
    const value = (input as ToolInput)[key];
    if (value === undefined) continue;
    const invalid = checkProperty(key, schema.properties[key]!, value);
    if (invalid) return invalid;
  }
  return undefined;
}

const REF = new RegExp(`^(${[...RESOURCE_TYPES, 'Policy'].join('|')})/[A-Za-z0-9.-]{1,64}$`);

function walk(value: unknown, exposed: Set<string>, refs: Set<string>): void {
  if (typeof value === 'string') {
    if (REF.test(value)) refs.add(value);
  } else if (Array.isArray(value)) {
    for (const v of value) walk(v, exposed, refs);
  } else if (value !== null && typeof value === 'object') {
    const { resourceType, id } = value as { resourceType?: unknown; id?: unknown };
    if (typeof resourceType === 'string' && typeof id === 'string') exposed.add(`${resourceType}/${id}`);
    for (const v of Object.values(value)) walk(v, exposed, refs);
  }
}

export function exposure(payload: unknown): Pick<ToolResult, 'exposed_ids' | 'referenced_ids'> {
  const exposed = new Set<string>();
  const refs = new Set<string>();
  walk(payload, exposed, refs);
  return { exposed_ids: [...exposed].sort(), referenced_ids: [...refs].filter((r) => !exposed.has(r)).sort() };
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
  return { is_error: false, content: payload, ...exposure(payload) };
}
