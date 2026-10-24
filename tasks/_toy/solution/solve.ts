// The toy's oracle: the reference solution as scripted tool calls, run through the same tools
// and loop as a live trial (packages/grader/matrix). It must grade PASS with score 1.0.
import type { Script } from '../../../packages/grader/matrix/types.ts';

export const oracle: Script = [
  { calls: [{ name: 'get_context', input: {} }, { name: 'fhir_read', input: { resource_type: 'Patient', id: 'pt-0001' } }] },
  { calls: [{ name: 'write_note', input: { patient: 'pt-0001', type: 'progress_note', title: 'Tool check', text: 'Chart opened by Maya Okafor, MD, to check the tools.', cites: ['Patient/pt-0001'] } }] },
  { calls: [{ name: 'finish', input: { summary: 'Signed in as Maya Okafor, MD, I wrote a progress note on the chart of Peter Prosacco.' } }] },
];
