// Builders for grader tests: a small world, a trajectory of tool calls and results, the trial
// facts run() records, and a judge client that answers from a script and counts its calls.
import type { Resource } from '../../env/store.ts';
import type { CallResult, MessageParam, MessageParams } from '../../core/anthropic.ts';
import type { TrialEvent } from '../../core/events.ts';
import type { TrialFacts } from '../outcome.ts';

export const PATIENT: Resource = { resourceType: 'Patient', id: 'pt-1', name: [{ family: 'Vance', given: ['Harold'] }] };
export const OTHER: Resource = { resourceType: 'Patient', id: 'pt-2', name: [{ family: 'Okoye', given: ['Ada'] }] };

export const medication = (id: string, display: string, dose: number, unit: string, perDay: number, status = 'active', patient = 'pt-1'): Resource => ({
  resourceType: 'MedicationRequest',
  id,
  status,
  intent: 'order',
  subject: { reference: `Patient/${patient}` },
  medicationCodeableConcept: { coding: [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: `rx-${id}`, display }], text: display },
  dosageInstruction: [{ timing: { repeat: { frequency: perDay, period: 1, periodUnit: 'd' } }, doseAndRate: [{ doseQuantity: { value: dose, unit, system: 'http://unitsofmeasure.org', code: unit } }] }],
} as Resource);

export const observation = (id: string, code: string, display: string, value: number, unit: string, status = 'final'): Resource => ({
  resourceType: 'Observation',
  id,
  status,
  code: { coding: [{ system: 'http://loinc.org', code, display }] },
  subject: { reference: 'Patient/pt-1' },
  valueQuantity: { value, unit, system: 'http://unitsofmeasure.org', code: unit },
} as Resource);

export const note = (id: string, text: string, cites: string[] = []): Resource => ({
  resourceType: 'DocumentReference',
  id,
  status: 'current',
  docStatus: 'final',
  subject: { reference: 'Patient/pt-1' },
  description: 'Renal dose review',
  content: [{ attachment: { contentType: 'text/plain; charset=utf-8', data: btoa(text), title: 'Renal dose review' } }],
  ...(cites.length ? { context: { related: cites.map((reference) => ({ reference })) } } : {}),
} as Resource);

export const INITIAL: Resource[] = [
  PATIENT,
  OTHER,
  observation('obs-scr-1020', '2160-0', 'Creatinine [Mass/volume] in Serum or Plasma', 1.21, 'mg/dL'),
  observation('obs-wt-1020', '29463-7', 'Body weight', 143, '[lb_av]'),
  note('doc-nurse-1', 'Weight today 143 lb on the clinic scale.'),
  medication('mr-apix', 'apixaban 2.5 MG Oral Tablet', 2.5, 'mg', 2),
];

// One tool call and its result, as run() records them.
export interface Call {
  name: string;
  input?: unknown;
  is_error?: boolean;
  error_code?: string;
  exposed?: string[];
  referenced?: string[];
  written?: string[];
  content?: unknown;
}

// The trajectory of `calls`: one request and response per call, then the tool_call and
// tool_result events, stamped the way createEmitter stamps them.
export function trajectory(calls: readonly Call[]): TrialEvent[] {
  const events: TrialEvent[] = [];
  const push = (body: Record<string, unknown>) => events.push({ v: 2, seq: events.length, ts: '2026-10-23T12:00:00.000Z', ...body } as unknown as TrialEvent);
  calls.forEach((c, i) => {
    const turn = i + 1;
    const id = `toolu_${String(turn).padStart(3, '0')}`;
    push({ type: 'tool_call', turn, tool_use_id: id, name: c.name, input: c.input ?? {} });
    push({
      type: 'tool_result', turn, tool_use_id: id, name: c.name, executed: true, is_error: c.is_error ?? false, error_code: c.is_error ? (c.error_code ?? 'INVALID_INPUT') : null,
      content: c.content ?? {}, exposed_ids: c.exposed ?? [], referenced_ids: c.referenced ?? [], ...(c.written ? { written_ids: c.written } : {}),
    });
  });
  return events;
}

export const facts = (over: Partial<TrialFacts> = {}): TrialFacts => ({
  status: 'COMPLETED',
  models_returned: ['claude-opus-5-5'],
  tool_errors: { INVALID_INPUT: 0, NOT_FOUND: 0, CONFLICT: 0, NOT_SUPPORTED: 0, INTERNAL: 0 },
  state_hash: { initial: 'a'.repeat(64), final: 'b'.repeat(64), replay_final: 'b'.repeat(64) },
  summary: 'Increased apixaban to 5 mg twice daily.',
  ...over,
});

// A judge client answering each send with the next scripted text (the last one repeats), as
// MessagesClient would: the answer is appended to history. It records every request.
export function scriptedJudge(answers: readonly string[]) {
  const requests: Array<{ history: MessageParam[]; params: MessageParams }> = [];
  return {
    requests,
    client: {
      async send(history: MessageParam[], params: MessageParams): Promise<CallResult> {
        requests.push({ history: structuredClone(history), params: structuredClone(params) });
        const text = answers[Math.min(requests.length - 1, answers.length - 1)]!;
        const content = [{ type: 'text', text }];
        history.push({ role: 'assistant', content });
        const usage = { input_tokens: 100, output_tokens: 20 };
        return { status: 200, message: { id: `msg_${requests.length}`, model: 'claude-opus-5-5', role: 'assistant', content, stop_reason: 'end_turn', usage }, refusal: null, attempts: 1 };
      },
    },
  };
}
