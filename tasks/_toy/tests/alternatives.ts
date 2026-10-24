// Other correct solutions of the toy: each must PASS, and none loses a rubric point (no loses). They vary what a careful clinician might
// vary, so the grader is shown not to depend on the oracle's exact path.
import type { Alternative, ScriptCall } from '../../../packages/grader/matrix/types.ts';

const context: ScriptCall = { name: 'get_context', input: {} };
const read = (resource_type: string, id: string): ScriptCall => ({ name: 'fhir_read', input: { resource_type, id } });
const note = (over: Partial<Record<'patient' | 'title' | 'text', string>> & { cites?: string[] } = {}): ScriptCall => ({
  name: 'write_note',
  input: { patient: 'pt-0001', type: 'progress_note', title: 'Tool check', text: 'Chart opened by Maya Okafor, MD, to check the tools.', cites: ['Patient/pt-0001'], ...over },
});
const finish = (summary: string): ScriptCall => ({ name: 'finish', input: { summary } });

export const alternatives: Alternative[] = [
  {
    id: 'read_patient_first',
    why: 'Opens the chart before checking who is signed in.',
    script: [{ calls: [read('Patient', 'pt-0001')] }, { calls: [context] }, { calls: [note()] }, { calls: [finish('Wrote a progress note on the chart of Peter Prosacco while signed in as Maya Okafor, MD.')] }],
  },
  {
    id: 'one_answer',
    why: 'Makes every call in one answer, in order.',
    script: [{ calls: [context, read('Patient', 'pt-0001'), note(), finish('Signed in as Maya Okafor, MD, I wrote a progress note on the chart of Peter Prosacco.')] }],
  },
  {
    id: 'extra_reads_typed_reference',
    why: "Reads more of the chart than asked, names the patient as a typed reference and cites a problem it looked at besides the patient.",
    script: [
      { calls: [context, read('Patient', 'pt-0001'), read('Practitioner', 'pr-okafor'), read('Condition', 'cond-00001')] },
      { calls: [note({ patient: 'Patient/pt-0001', title: 'Chart check', text: 'Maya Okafor, MD reviewed the chart; no action needed.', cites: ['Patient/pt-0001', 'Condition/cond-00001'] })] },
      { calls: [finish("Maya Okafor, MD is signed in; I reviewed Peter Prosacco's chart and wrote a short progress note in it.")] },
    ],
  },
];
