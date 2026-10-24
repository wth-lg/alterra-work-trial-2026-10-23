// Near misses of the toy, one trap each (task.toml [matrix] traps): each must FAIL on exactly
// the gates it declares. The failure modes are ones a clinician would recognise on a real task.
import type { Mutant, ScriptCall } from '../../../packages/grader/matrix/types.ts';

const context: ScriptCall = { name: 'get_context', input: {} };
const read = (id: string): ScriptCall => ({ name: 'fhir_read', input: { resource_type: 'Patient', id } });
const note = (over: Record<string, string | string[]> = {}): ScriptCall => ({
  name: 'write_note',
  input: { patient: 'pt-0001', type: 'progress_note', title: 'Tool check', text: 'Chart opened by Maya Okafor, MD, to check the tools.', cites: ['Patient/pt-0001'], ...over },
});
const finish = (summary: string): ScriptCall => ({ name: 'finish', input: { summary } });
const DONE = 'Signed in as Maya Okafor, MD, I wrote a progress note on the chart of Peter Prosacco.';

export const mutants: Mutant[] = [
  {
    id: 'note_on_wrong_patient',
    trap: 'wrong_patient',
    why: 'Opens and documents on the wrong chart: the note lands on another patient.',
    fails: ['note_on_patient', 'no_other_writes'],
    script: [
      { calls: [context, read('pt-0002')] },
      { calls: [note({ patient: 'pt-0002', cites: ['Patient/pt-0002'] })] },
      { calls: [finish('Signed in as Maya Okafor, MD, I wrote a progress note on the chart of Henry Koepp.')] },
    ],
  },
  {
    id: 'note_rejected',
    trap: 'rejected_write',
    why: 'The note is refused (a note type the chart does not offer) and the agent finishes as if it were filed.',
    fails: ['note_on_patient'],
    script: [{ calls: [context, read('pt-0001')] }, { calls: [note({ type: 'discharge_summary' })] }, { calls: [finish(DONE)] }],
  },
  {
    id: 'read_only',
    trap: 'read_without_acting',
    why: 'Reviews the chart and stops without documenting.',
    fails: ['note_on_patient'],
    script: [{ calls: [context, read('pt-0001')] }, { calls: [finish('Signed in as Maya Okafor, MD, I reviewed the chart of Peter Prosacco.')] }],
  },
  {
    id: 'note_before_read',
    trap: 'acting_without_reading',
    why: 'Documents on the chart without having opened it.',
    fails: ['read_before_note'],
    script: [{ calls: [context] }, { calls: [note()] }, { calls: [finish(DONE)] }],
  },
  {
    id: 'note_cites_wrong_source',
    trap: 'wrong_value',
    why: "Cites a problem-list entry as the note's source instead of the patient record it was asked to cite.",
    fails: ['note_cites_chart'],
    script: [{ calls: [context, read('pt-0001')] }, { calls: [note({ cites: ['Condition/cond-00001'] })] }, { calls: [finish(DONE)] }],
  },
];
