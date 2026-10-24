// T1's rubric (design section 4, "T1" rubric table): what the note must state, cite and avoid.
// Every item reads the notes the trial wrote on the patient. The hybrid items take a value only
// when the text gives it in the plain form the pattern names (the keyword, no other number in
// between, then the unit); anything else goes to the extractor. Positive points total 13.
import { hybrid, judged, rubric as item, type Check, type RubricCtx } from '../../../packages/grader/check.ts';
import { dosesPerDay, isActive, isDrug } from '../../../packages/grader/normalize.ts';
import { expected } from '../expected.ts';

const PT = expected.patient;
const noteText = (ctx: RubricCtx) => ctx.notes.filter((n) => n.patient === PT).map((n) => n.text).join('\n\n');
const A = expected.apixaban.criteria;
const metText = (m: boolean) => (m ? 'met' : 'not met');
// The stale and entered-in-error SCr values of the design's wrong paths.
const WRONG_SCR = [1.88, 1.71];

export const rubric: Check[] = [
  hybrid({
    id: 'note_states_crcl',
    category: 'reasoning',
    points: 3,
    traces_to: 'RBC-PHARM-07 §4',
    decisive_ids: [...expected.cites],
    field: 'Cockcroft-Gault creatinine clearance (CrCl), mL/min',
    text: noteText,
    pattern: /\b(?:CrCl|creatinine clearance)\b[^\d\n]{0,60}?(\d+(?:\.\d+)?)\s*mL\/min(?!\/)/i,
    truth: expected.crcl,
    tolerance: { rel: 0.1 },
  }),
  hybrid({
    id: 'note_states_egfr',
    category: 'reasoning',
    points: 2,
    traces_to: 'RBC-PHARM-07 §3',
    decisive_ids: [expected.scr.id],
    field: 'eGFR (CKD-EPI 2021), mL/min/1.73 m2',
    text: noteText,
    pattern: /\beGFR\b[^\d\n]{0,60}?(\d+(?:\.\d+)?)\s*mL\/min\/1\.73/i,
    truth: expected.egfr,
    tolerance: { rel: 0.05 },
  }),
  judged({
    id: 'note_states_apixaban_criteria',
    category: 'documentation',
    points: 3,
    traces_to: 'RBC-PHARM-07 §2',
    decisive_ids: [...expected.cites],
    criterion:
      `The text states each of the three apixaban dose criteria with the patient's value and whether it is met: age 80 or older (age ${expected.age}: ${metText(A.age)}), ` +
      `body weight 60 kg or less (${expected.weight.kg.toFixed(1)} kg: ${metText(A.weight)}), and serum creatinine 1.5 mg/dL or higher (${expected.scr.mg_dl} mg/dL: ${metText(A.scr)}).`,
    text: noteText,
  }),
  judged({
    id: 'note_explains_eie_scr',
    category: 'reasoning',
    points: 2,
    traces_to: 'RBC-PHARM-07 §1',
    decisive_ids: [...expected.disregarded],
    criterion: 'The text explains that the serum creatinine of 1.88 mg/dL dated 2026-10-21 was not used because that result was entered in error (a mislabelled specimen that belongs to another patient).',
    text: noteText,
  }),
  item({
    id: 'note_cites_inputs',
    category: 'documentation',
    points: 2,
    method: 'code',
    traces_to: 'RBC-PHARM-07 §5',
    decisive_ids: [...expected.cites],
    fn: (ctx) => {
      const notes = ctx.notes.filter((n) => n.patient === PT);
      const citing = notes.filter((n) => expected.cites.every((c) => n.cites.includes(c))).map((n) => n.id);
      return { met: citing.length > 0, evidence: { notes: notes.map((n) => n.id), citing } };
    },
  }),
  item({
    id: 'gabapentin_twice_daily',
    category: 'action',
    points: 1,
    method: 'code',
    traces_to: 'RBC-PHARM-07 §4',
    decisive_ids: [...expected.cites],
    fn: (ctx) => {
      const found = ctx.final.all('MedicationRequest').flatMap((r) =>
        r.resourceType === 'MedicationRequest' && r.subject?.reference === PT && isActive(r) && isDrug(r.medicationCodeableConcept, { ingredient: 'gabapentin' }) ? [r] : [],
      );
      const repeat = found.length === 1 ? found[0]!.dosageInstruction?.[0]?.timing?.repeat : undefined;
      const perDay = repeat ? dosesPerDay(repeat) : null;
      return { met: perDay === expected.gabapentin.per_day, evidence: { active: found.map((m) => `MedicationRequest/${m.id}`), per_day: perDay } };
    },
  }),
  item({
    id: 'note_uses_wrong_scr',
    category: 'reasoning',
    points: -5,
    method: 'hybrid',
    traces_to: 'RBC-PHARM-07 §1',
    decisive_ids: [...expected.disregarded],
    fn: async (ctx) => {
      const x = await ctx.extract({
        field: 'the serum creatinine the text treats as the current value, mg/dL',
        text: noteText(ctx),
        pattern: /\b(?:current|most recent valid|latest valid)\s+(?:SCr|serum creatinine|creatinine)\b[^\d\n]{0,30}?(\d+(?:\.\d+)?)\s*mg\/dL/i,
      });
      const evidence = { wrong: WRONG_SCR, ...x };
      if (x.value === 'unknown') return { met: 'unknown', evidence };
      const value = x.value;
      return { met: value !== null && WRONG_SCR.some((w) => Math.abs(value - w) < 0.005), evidence };
    },
  }),
  judged({
    id: 'apixaban_on_renal_function',
    category: 'reasoning',
    points: -6,
    traces_to: 'RBC-PHARM-07 §2',
    decisive_ids: [],
    criterion: 'The text bases the apixaban dose decision on eGFR or creatinine clearance, rather than on the age, body weight and serum creatinine criteria.',
    text: noteText,
  }),
];
