// The probe request: one tool, one instruction to call it. The browser probe page and
// `pnpm live:node` send it byte for byte, so a CORS verdict can compare the same request from
// both runtimes, and both reserve the same worst case.
import { requestBody, type MessageParam, type MessageParams } from '../../../../packages/core/anthropic.ts';
import { worstCaseUsd } from '../../../../packages/core/cost.ts';

export const PROBE_TOOL = 'record_ping';

export function probeHistory(): MessageParam[] {
  return [{ role: 'user', content: `Call the ${PROBE_TOOL} tool with value 42. Do not reply with text.` }];
}

// Effort low keeps the probe to a few hundred tokens; it is a transport check, not a trial.
export const PROBE_PARAMS: MessageParams = {
  max_tokens: 2048,
  output_config: { effort: 'low' },
  tools: [
    {
      name: PROBE_TOOL,
      description: 'Records a ping value.',
      strict: true,
      input_schema: { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'], additionalProperties: false },
    },
  ],
  tool_choice: { type: 'auto' },
};

export function probeReserveRequest(trial: string) {
  const bodyBytes = new TextEncoder().encode(requestBody(probeHistory(), PROBE_PARAMS)).length;
  return { bodyBytes, maxTokens: PROBE_PARAMS.max_tokens, trial };
}

// The worst case of one probe call, as the ledger reserves it.
export function probeProjection(): number {
  return worstCaseUsd(probeReserveRequest(''));
}
