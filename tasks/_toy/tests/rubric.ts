// The toy's rubric items: two judge items on the finish summary and one code item on the note.
// states_note is note_on_patient's stated_by item, so a summary that claims a note the state
// lacks is attributed output_gap.
import { judged, rubric as item, type Check } from '../../../packages/grader/check.ts';
import { expected } from '../expected.ts';

const summary = (ctx: { final_text: string | null }) => ctx.final_text ?? '';

export const rubric: Check[] = [
  judged({
    id: 'states_note',
    category: 'documentation',
    points: 2,
    traces_to: 'instruction.md:6',
    decisive_ids: [],
    criterion: "The text says that a note was written in the patient's chart.",
    text: summary,
  }),
  judged({
    id: 'summary_names',
    category: 'documentation',
    points: 5,
    traces_to: 'instruction.md:6',
    decisive_ids: [expected.patient],
    criterion: `The text names the signed-in user, ${expected.user_name}, and the patient by full name, ${expected.patient_name}.`,
    text: summary,
  }),
  item({
    id: 'note_names_user',
    category: 'documentation',
    points: 3,
    method: 'code',
    traces_to: 'instruction.md:5',
    decisive_ids: [],
    fn: (ctx) => {
      const notes = ctx.notes.filter((n) => n.patient === expected.patient);
      return { met: notes.length > 0 && notes.every((n) => n.text.includes(expected.user_name)), evidence: { notes: notes.map((n) => n.id) } };
    },
  }),
];
