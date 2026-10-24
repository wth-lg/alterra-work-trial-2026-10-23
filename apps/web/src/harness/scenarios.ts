// Mocked Messages API scenarios for the run() loop: scripted SSE answers, one per request. The
// Node tests (packages/core/test/loop*.test.ts, cancel.test.ts), `pnpm cli run-one --mock` and
// the Worker parity spec (apps/web/e2e/worker-parity.spec.ts) replay the same scripts, so a
// trajectory from Node and one from a Chromium Worker can be compared byte for byte. Pure: no
// DOM and no Node APIs, only Request, Response and ReadableStream, which both runtimes have.
import type { Transport } from '../../../../packages/core/anthropic.ts';

export interface MockTool {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface MockTurn {
  thinking?: string;
  text?: string;
  tools?: readonly MockTool[];
  stop?: 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal';
  model?: string;
}

const MODEL = 'claude-opus-5-5';
const USAGE = { input_tokens: 1200, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

// The SSE events of one answer, in the order the API streams them.
export function turnEvents(turn: MockTurn, n: number): object[] {
  const blocks: Array<{ start: object; deltas: object[] }> = [];
  if (turn.thinking !== undefined) {
    blocks.push({
      start: { type: 'thinking', thinking: '', signature: '' },
      deltas: [
        { type: 'thinking_delta', thinking: turn.thinking },
        { type: 'signature_delta', signature: `sig-${n}-${turn.thinking.length}` },
      ],
    });
  }
  if (turn.text !== undefined) blocks.push({ start: { type: 'text', text: '' }, deltas: [{ type: 'text_delta', text: turn.text }] });
  for (const t of turn.tools ?? []) {
    blocks.push({ start: { type: 'tool_use', id: t.id, name: t.name, input: {} }, deltas: [{ type: 'input_json_delta', partial_json: JSON.stringify(t.input) }] });
  }
  const stop = turn.stop ?? ((turn.tools?.length ?? 0) > 0 ? 'tool_use' : 'end_turn');
  return [
    { type: 'message_start', message: { id: `msg_mock_${n}`, type: 'message', role: 'assistant', model: turn.model ?? MODEL, content: [], stop_reason: null, usage: USAGE } },
    ...blocks.flatMap((b, index) => [
      { type: 'content_block_start', index, content_block: b.start },
      ...b.deltas.map((delta) => ({ type: 'content_block_delta', index, delta })),
      { type: 'content_block_stop', index },
    ]),
    { type: 'message_delta', delta: { stop_reason: stop, stop_details: null }, usage: { output_tokens: 300 + 10 * n } },
    { type: 'message_stop' },
  ];
}

export const sse = (events: readonly object[]): string =>
  events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join('');

const streamOf = (text: string) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(text));
      c.close();
    },
  });

export const okResponse = (turn: MockTurn, n: number): Response =>
  new Response(streamOf(sse(turnEvents(turn, n))), { status: 200, headers: { 'content-type': 'text/event-stream' } });

const getContext = (id: string): MockTool => ({ id, name: 'get_context', input: {} });
const readPatient = (id: string, patient: string): MockTool => ({ id, name: 'fhir_read', input: { resource_type: 'Patient', id: patient } });

// A scenario answers the n-th request (1-based); a fixed script ends after its last turn.
export type Script = readonly MockTurn[] | ((n: number) => MockTurn);

export const SCENARIOS = {
  // The toy task's shape: two reads, then finish. The Worker parity spec runs this one.
  toy: [
    { thinking: 'I should check who I am and read the patient.', tools: [getContext('toolu_01'), readPatient('toolu_02', 'pt-0001')] },
    { thinking: 'I have what I need.', text: 'Done.', tools: [{ id: 'toolu_03', name: 'finish', input: { summary: 'Read get_context and Patient/pt-0001.' } }] },
  ],
  // Thinking blocks in every answer, each echoed in the next request.
  thinking: [
    { thinking: 'First thought, with "quotes", a tab\tand unicode é→✓.', tools: [getContext('toolu_t1')] },
    { thinking: 'Second thought.', tools: [readPatient('toolu_t2', 'pt-0002')] },
    { thinking: 'Final thought.', text: 'All done.' },
  ],
  // Three tool calls in one answer: run in emitted order, one at a time.
  serial: [
    { tools: [readPatient('toolu_s1', 'pt-0003'), getContext('toolu_s2'), readPatient('toolu_s3', 'pt-0001')] },
    { text: 'Read three things.' },
  ],
  // finish in the middle of a turn: the call before it runs, the one after is skipped.
  finishMid: [
    { tools: [getContext('toolu_f1'), { id: 'toolu_f2', name: 'finish', input: { summary: 'Stopping early on purpose.' } }, readPatient('toolu_f3', 'pt-0001')] },
  ],
  // One committed write (create_task) on the harness task _write (write-task.ts), then finish.
  write: [
    { thinking: 'Create the follow-up.', tools: [getContext('toolu_w1'), { id: 'toolu_w2', name: 'create_task', input: { patient: 'pt-0001', owner: 'Group/pool-rn-triage', due: '2026-11-06', priority: 'routine', description: 'Call with results' } }] },
    { tools: [{ id: 'toolu_w3', name: 'finish', input: { summary: 'Created one follow-up Task.' } }] },
  ],
  // Never stops calling tools: for the turn, cost and wall-clock caps.
  forever: (n: number): MockTurn => ({ thinking: `Turn ${n}.`, tools: [getContext(`toolu_l${n}`)] }),
} satisfies Record<string, Script>;

export type ScenarioName = keyof typeof SCENARIOS;

export const isScenario = (name: string): name is ScenarioName => Object.hasOwn(SCENARIOS, name);

export interface ScriptedTransport {
  transport: Transport;
  // Each request's body as sent, parsed.
  bodies: Array<{ messages: Array<{ role: string; content: unknown }>; [k: string]: unknown }>;
  // Each request's body as sent, raw.
  raw: string[];
}

// A transport that answers each request with the script's next turn. Throws on a request past
// the end of a fixed script, so a loop that sends too many requests fails its test.
export function scriptedTransport(script: Script): ScriptedTransport {
  const bodies: ScriptedTransport['bodies'] = [];
  const raw: string[] = [];
  const transport: Transport = async (request) => {
    const text = await request.text();
    raw.push(text);
    bodies.push(JSON.parse(text) as ScriptedTransport['bodies'][number]);
    const n = raw.length;
    const turn = typeof script === 'function' ? script(n) : script[n - 1];
    if (turn === undefined) throw new Error(`mock: request ${n} is past the end of the script`);
    return okResponse(turn, n);
  };
  return { transport, bodies, raw };
}

export const scenarioTransport = (name: ScenarioName): ScriptedTransport => scriptedTransport(SCENARIOS[name]);

// A transport whose answer starts streaming and then stalls until the request's signal aborts,
// when the stream errors as fetch's does. `when` picks where it stalls: before the response
// (fetch itself rejects) or after message_start (the body read rejects). onSend runs once the
// request is in flight.
export function stallingTransport(when: 'before-response' | 'mid-stream', onSend: () => void): ScriptedTransport {
  const out = scriptedTransport([]);
  out.transport = async (request) => {
    out.raw.push(await request.text());
    const signal = request.signal;
    const aborted = () => signal.reason ?? new DOMException('This operation was aborted', 'AbortError');
    if (when === 'before-response') {
      return new Promise<Response>((_, reject) => {
        signal.addEventListener('abort', () => reject(aborted()), { once: true });
        onSend();
      });
    }
    const first = sse(turnEvents({ tools: [getContext('toolu_x')] }, 1).slice(0, 1));
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(first));
        signal.addEventListener('abort', () => c.error(aborted()), { once: true });
        onSend();
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  return out;
}
