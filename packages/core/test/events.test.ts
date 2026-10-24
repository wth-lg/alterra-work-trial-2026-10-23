// The trial event schema (packages/core/events.ts): what parseEvent accepts and refuses, and
// that the trajectory JSONL round-trips through it.
import { describe, expect, it } from 'vitest';
import { EVENT_SCHEMA_VERSION, parseEvent, type TrialEvent } from '../events.ts';
import { parseTrajectory, stripTimestamps, toJsonl, toolLog } from '../trajectory.ts';

const base = { v: EVENT_SCHEMA_VERSION, seq: 0, ts: '2026-10-23T12:00:00.000Z', turn: 1 } as const;
const GOOD: TrialEvent[] = [
  { ...base, seq: 0, turn: 0, type: 'state_hash', at: 'initial', hash: 'a'.repeat(64) },
  { ...base, seq: 1, type: 'request', messages_from: 0, messages: [{ role: 'user', content: 'go' }], params: { max_tokens: 10 } },
  {
    ...base, seq: 2, type: 'response', id: 'msg_1', model: 'claude-opus-5-5', stop_reason: 'tool_use', stop_details: null,
    content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_context', input: {} }], usage: { input_tokens: 1, output_tokens: 2 }, attempts: 1, cost_usd: 0.001,
  },
  { ...base, seq: 3, type: 'usage', total: { input: 1, cache_write: 0, cache_read: 0, output: 2 }, cost_usd: 0.001 },
  { ...base, seq: 4, type: 'tool_call', tool_use_id: 'toolu_1', name: 'get_context', input: {} },
  { ...base, seq: 5, type: 'tool_result', tool_use_id: 'toolu_1', name: 'get_context', executed: true, is_error: false, error_code: null, content: { now: 'x' }, exposed_ids: [], referenced_ids: ['Practitioner/pr-okafor'] },
  { ...base, seq: 6, type: 'tool_call', tool_use_id: 'toolu_2', name: 'fhir_read', input: {} },
  { ...base, seq: 7, type: 'tool_result', tool_use_id: 'toolu_2', name: 'fhir_read', executed: false, is_error: true, error_code: 'CONFLICT', content: {}, exposed_ids: [], referenced_ids: [] },
  { ...base, seq: 8, type: 'limit', limit: 'turns', cap: 1, value: 1 },
  { ...base, seq: 9, type: 'error', status: 'ENV_ERROR', code: 'INTERNAL', message: 'boom' },
  { ...base, seq: 10, type: 'cancelled', reason: 'AbortError: aborted' },
];

describe('parseEvent', () => {
  it('accepts one event of each kind, unchanged', () => {
    for (const e of GOOD) expect(parseEvent(JSON.parse(JSON.stringify(e)))).toEqual(e);
  });

  it.each([
    ['an unknown type', { ...GOOD[0], type: 'mystery' }],
    ['another schema version', { ...GOOD[0], v: 99 }],
    ['a negative seq', { ...GOOD[0], seq: -1 }],
    ['no ts', { ...GOOD[0], ts: undefined }],
    ['a request with a header field', { ...GOOD[1], headers: { 'x-api-key': 'k' } }],
    ['a request whose message has no role', { ...GOOD[1], messages: [{ content: 'go' }] }],
    ['a response without usage', { ...GOOD[2], usage: undefined }],
    ['a tool_result without exposed_ids', { ...GOOD[5], exposed_ids: undefined }],
    ['a state_hash that is not a sha256', { ...GOOD[0], hash: 'nope' }],
    ['an unknown limit', { ...GOOD[8], limit: 'tokens' }],
    ['an unknown error status', { ...GOOD[9], status: 'FAIL' }],
    ['an extra field', { ...GOOD[10], extra: 1 }],
  ])('refuses %s', (_, bad) => {
    expect(() => parseEvent(JSON.parse(JSON.stringify(bad)))).toThrow();
  });
});

describe('trajectory JSONL', () => {
  it('is one serialized event per line and parses back to the same events', () => {
    const jsonl = toJsonl(GOOD);
    expect(jsonl.split('\n')).toHaveLength(GOOD.length + 1);
    expect(parseTrajectory(jsonl)).toEqual(GOOD);
    expect(stripTimestamps(jsonl)).not.toContain('"ts"');
  });

  it('the tool log is every executed call, in order', () => {
    expect(toolLog(GOOD).map((c) => c.tool_use_id)).toEqual(['toolu_1']);
  });

  it('names the line of a bad event', () => {
    expect(() => parseTrajectory(`${JSON.stringify(GOOD[0])}\n{"v":1}\n`)).toThrow(/line 2/);
  });
});
