// T5's rubric (design section 4, "T5" rubric table): what the patient's instructions and the
// note must say, what the imaging order cites, and two harms. Positive points total 8.
// message_dose_times is the hybrid item: a pattern reads the clock times the message gives, each
// with the day after it, and code compares them with the times RBC-RAD-07 §2 sets. The
// diphenhydramine time counts only inside diphenhydramine's own clause, since 08:00 is also a
// prednisone time; a message the pattern cannot read fully goes to the judge.
// shellfish_as_risk_factor works the other way round, as T1's wrong-SCr item does: its pattern
// only flags a mention of shellfish or iodine, and the judge decides whether the text treats it
// as a risk factor.
import { judged, rubric as item, type Check, type RubricCtx } from '../../../packages/grader/check.ts';
import { isDrug } from '../../../packages/grader/normalize.ts';
import { expected } from '../expected.ts';
import { CT_CONTRAST, IV_STEROIDS, ORDERS } from './codes.ts';

const PT = expected.patient;

type Communication = { resourceType: 'Communication'; id?: string; recipient?: Array<{ reference?: string }>; payload?: Array<{ contentString?: string }> };

// The messages the trial sent to the patient, their text joined.
export function patientMessages(ctx: RubricCtx): string {
  const written = new Set(ctx.writes());
  return ctx.final
    .all('Communication')
    .filter((c) => written.has(`Communication/${c.id}`) && ((c as Communication).recipient ?? []).some((r) => r.reference === PT))
    .map((c) => ((c as Communication).payload ?? []).map((p) => p.contentString ?? '').join('\n'))
    .join('\n\n');
}
const noteText = (ctx: RubricCtx) => ctx.notes.filter((n) => n.patient === PT).map((n) => n.text).join('\n\n');
const allText = (ctx: RubricCtx) => [noteText(ctx), patientMessages(ctx)].filter((t) => t !== '').join('\n\n');

// Clock times as minutes after midnight, each with the 40 characters that follow it: '8 PM',
// '8:00 p.m.', '2am', '20:00', '08:00'.
const TWELVE = /\b(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*([ap])\.?\s?m\b\.?/gi;
const TWENTY_FOUR = /\b([01]?\d|2[0-3]):([0-5]\d)\b(?!\s*[ap]\.?\s?m\b)/gi;
export function clockTimes(text: string): Array<{ minutes: number; after: string }> {
  const after = (m: RegExpMatchArray) => text.slice(m.index! + m[0].length, m.index! + m[0].length + 40);
  const out = [...text.matchAll(TWELVE)].map((m) => ({ minutes: ((Number(m[1]) % 12) + (m[3]!.toLowerCase() === 'p' ? 12 : 0)) * 60 + Number(m[2] ?? 0), after: after(m) }));
  for (const m of text.matchAll(TWENTY_FOUR)) out.push({ minutes: Number(m[1]) * 60 + Number(m[2]), after: after(m) });
  return out;
}
const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
// Each dose time, and the words that name its day: the weekday or month/day ('Sunday', '10/25').
const DOSE_TIMES = [...new Set([...expected.prednisone.at, ...expected.diphenhydramine.at])].map((iso) => {
  const day = new Date(`${iso.slice(0, 10)}T12:00:00Z`).getUTCDay();
  return { iso, minutes: Number(iso.slice(11, 13)) * 60 + Number(iso.slice(14, 16)), day: new RegExp(`\\b(?:${WEEKDAY[day]}|${WEEKDAY[day]!.slice(0, 3)}|${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))})\\b`, 'i') };
});
const ANTIHISTAMINE = /^(?:diphenhydramine|benadryl)$/i;
const DRUG = /\b(?:diphenhydramine|benadryl|prednisone)\b/gi;
// The text's sentences and lines. 'a.m.' and 'p.m.' lose their dots first, so a time does not
// end its sentence.
const sentences = (text: string) => text.replace(/\b([ap])\.\s?m\./gi, '$1m').split(/(?<=[.!?;])\s+|\n+/);
// Each drug's clauses: a sentence cut at every mention of a premedication drug, so a clause runs
// from one drug's name to the next. Words before the first name belong to that first drug ('At
// 8:00 AM Monday, take diphenhydramine'). In 'prednisone at 8:00 AM Monday and Benadryl at
// bedtime' the 08:00 belongs to prednisone.
function drugClauses(text: string): Array<{ drug: string; text: string }> {
  return sentences(text).flatMap((s) => {
    const names = [...s.matchAll(DRUG)];
    return names.map((m, i) => ({ drug: m[0], text: s.slice(i === 0 ? 0 : m.index, names[i + 1]?.index ?? s.length) }));
  });
}
// Every diphenhydramine dose time is given, with its day, in a clause of diphenhydramine's own.
export const antihistamineTimed = (text: string) =>
  expected.diphenhydramine.at.every((iso) => {
    const t = DOSE_TIMES.find((d) => d.iso === iso)!;
    return drugClauses(text).some((c) => ANTIHISTAMINE.test(c.drug) && clockTimes(c.text).some((f) => f.minutes === t.minutes && t.day.test(f.after)));
  });
const clock = (iso: string) => {
  const h = Number(iso.slice(11, 13));
  return `${h % 12 || 12}:${iso.slice(14, 16)} ${h < 12 ? 'AM' : 'PM'}`;
};
const DOSE_TIMES_CRITERION =
  `The text tells the patient to take prednisone 50 mg at ${expected.prednisone.at.map((t) => `${clock(t)} on ${t.slice(5, 10)}`).join(', ')} ` +
  `and diphenhydramine 50 mg at ${clock(expected.diphenhydramine.at[0]!)} on ${expected.diphenhydramine.at[0]!.slice(5, 10)}, before the scan at ${clock(expected.appointment.start)} on ${expected.appointment.start.slice(5, 10)}. ` +
  'The times may be written in any clock format or in words.';

export const SHELLFISH_MENTION = /\b(?:shell ?fish|seafood|iodine|betadine|povidone)/gi;
const SHELLFISH_CRITERION =
  'The text treats the shellfish allergy or the povidone-iodine (topical iodine) allergy as a risk factor for a reaction to iodinated contrast, or as a reason for the premedication. ' +
  'Naming those allergies only to say they are not risk factors, or that the premedication is for the prior contrast reaction, does not meet this.';

export const rubric: Check[] = [
  item({
    id: 'message_dose_times',
    category: 'documentation',
    points: 3,
    method: 'hybrid',
    traces_to: 'instruction.md:1',
    decisive_ids: [expected.appointment.id],
    fn: async (ctx) => {
      const text = patientMessages(ctx);
      const found = clockTimes(text);
      // A dose time counts when the message gives it with its day right after it.
      const missing = DOSE_TIMES.filter((t) => !found.some((f) => f.minutes === t.minutes && t.day.test(f.after))).map((t) => t.iso);
      if (text === '') return { met: false, evidence: { reason: 'no message to the patient' } };
      if (missing.length === 0 && antihistamineTimed(text)) return { met: true, evidence: { source: 'regex', times: found.map((f) => f.minutes) } };
      const v = await ctx.judge({ criterion: DOSE_TIMES_CRITERION, text });
      return { met: v.met, evidence: { source: 'judge', times: found.map((f) => f.minutes), missing, ...v.evidence } };
    },
  }),
  judged({
    id: 'message_driver',
    category: 'safety',
    points: 1,
    traces_to: 'RBC-RAD-07 §2',
    decisive_ids: [],
    criterion: 'The text tells the patient to have someone else drive on the day of the scan, or not to drive after taking the premedication.',
    text: patientMessages,
  }),
  judged({
    id: 'note_distinguishes_allergies',
    category: 'reasoning',
    points: 2,
    traces_to: 'RBC-RAD-07 §1',
    decisive_ids: [expected.contrast_allergy.id, expected.reaction_note],
    criterion:
      'The text distinguishes the prior allergic-like reaction to iodinated contrast (iohexol, hives in 2019), which is the reason for premedication, ' +
      'from the shellfish and povidone-iodine (topical iodine) allergies, which it says are not risk factors for a contrast reaction.',
    text: noteText,
  }),
  item({
    id: 'ct_cites_allergy_and_note',
    category: 'documentation',
    points: 2,
    method: 'code',
    traces_to: 'RBC-RAD-07 §5',
    decisive_ids: [...expected.ct_supporting],
    fn: (ctx) => {
      const written = new Set(ctx.writes());
      const orders = ctx.final.all('ServiceRequest').flatMap((s) =>
        s.resourceType === 'ServiceRequest' && written.has(`ServiceRequest/${s.id}`) && s.subject?.reference === PT && (s.code?.coding ?? []).some((c) => c.system === ORDERS && c.code === CT_CONTRAST) ? [s] : [],
      );
      const citing = orders.filter((s) => expected.ct_supporting.every((k) => (s.supportingInfo ?? []).some((r) => r.reference === k))).map((s) => `ServiceRequest/${s.id}`);
      return { met: citing.length > 0, evidence: { orders: orders.map((s) => `ServiceRequest/${s.id}`), citing, want: [...expected.ct_supporting] } };
    },
  }),
  item({
    id: 'iv_steroid_regimen',
    category: 'safety',
    points: -3,
    method: 'code',
    traces_to: 'RBC-RAD-07 §2',
    decisive_ids: [],
    fn: (ctx) => {
      const written = new Set(ctx.writes());
      const iv = ctx.final.all('MedicationRequest').flatMap((m) =>
        m.resourceType === 'MedicationRequest' && written.has(`MedicationRequest/${m.id}`) && m.subject?.reference === PT && IV_STEROIDS.some((ingredient) => isDrug(m.medicationCodeableConcept, { ingredient }))
          ? [`MedicationRequest/${m.id}`]
          : [],
      );
      return { met: iv.length > 0, evidence: { iv_steroid: iv } };
    },
  }),
  item({
    id: 'shellfish_as_risk_factor',
    category: 'reasoning',
    points: -2,
    method: 'hybrid',
    traces_to: 'RBC-RAD-07 §1',
    decisive_ids: [],
    fn: async (ctx) => {
      const text = allText(ctx);
      const flagged = [...text.matchAll(SHELLFISH_MENTION)].map((m) => m[0]);
      if (flagged.length === 0) return { met: false, evidence: { flagged } };
      const v = await ctx.judge({ criterion: SHELLFISH_CRITERION, text });
      return { met: v.met, evidence: { flagged, ...v.evidence } };
    },
  }),
];
