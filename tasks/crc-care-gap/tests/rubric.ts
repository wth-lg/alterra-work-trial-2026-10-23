// T3's rubric (design section 4, "T3" rubric table): the final table's status and reason for
// each panel member (+1 each, 12 in all), and -3 for each member contacted who needs no contact.
// The table items are hybrid: code finds the member's name or id in the final text (neither, not
// met, no judge call), and the judge confirms that the text gives that member the status and
// reason computed in expected.ts, in any wording. Positive points total 12. outreach_on_topic
// (-3) applies when a patient who needs outreach was messaged, but never about screening.
import { rubric as item, type Check, type RubricCtx } from '../../../packages/grader/check.ts';
import type { GateOf } from '../../../packages/grader/gate-view.ts';
import { expected, type Member, type Status } from '../expected.ts';

const STATUS: Record<Status, string> = {
  met: 'screening up to date (no gap, nothing to do)',
  gap: 'an open screening gap',
  excluded: 'excluded from the measure',
  not_in_population: 'not in the measure population',
};

const REASON: Record<string, string> = {
  colonoscopy: 'a colonoscopy in 2018, within the measurement period or the 9 years before it',
  colonoscopy_expired: 'the last colonoscopy, in November 2016, is older than the measurement period and the 9 years before it, so it no longer counts',
  sdna_fit_expired: 'the sDNA-FIT of November 2023 is older than the measurement period and the 2 years before it, so it no longer counts',
  no_screening: 'no qualifying screening on record',
  age_over_75: 'the patient is 76 at the end of the 2026 measurement period, older than 75',
  total_colectomy: 'a total colectomy (total proctocolectomy) recorded in an outside operative note',
  frailty_dementia_medication: 'frailty together with a dementia medication (donepezil), which counts as advanced illness, at age 66 or older',
  hospice: 'hospice care during the measurement period',
  fobt_expired: 'the FIT of December 2025 was before the measurement period, and a FIT counts only in the measurement period',
  active_fit_order: 'a FIT order is already active, so no new FIT order is placed',
  ct_colonography: 'a CT colonography in 2022, within the measurement period or the 4 years before it',
};

// Extra conditions the reason must meet for two members whose status alone hides the trap.
const ALSO: Record<string, string> = {
  'Patient/pt-0023': ' The text must treat the patient as in the population because of age at the end of the measurement period (46), not exclude her for being 45.',
  "Patient/pt-0019": ' The text must not exclude the patient: frailty alone does not exclude.',
};

export const criterion = (x: Member): string =>
  `The text gives ${x.name} the status: ${STATUS[x.status]}, and the reason: ${REASON[x.reason]}. Equivalent wording counts; the exact dates need not be repeated.${ALSO[x.patient] ?? ''}`;

// The family name or the patient id names a member. Case, accents and apostrophes do not
// matter: 'OKEEFE', 'O’Keefe' and 'Angela' all match; 'pt-0017' matches as a whole word.
const squash = (s: string) => s.normalize('NFD').replace(/[̀-ͯ'‘’ʼ`]/g, '').toLowerCase();
export const named = (x: Member, text: string): boolean =>
  squash(text).includes(squash(x.family)) || new RegExp(`(?<![\\w-])${x.patient.slice(8)}(?![\\w-])`, 'i').test(text);

// The patients a Communication is sent to: a Patient recipient, and the Patient members of a
// Group recipient (a message to the panel group reaches every member). A message to a clinician
// or a staff pool that merely concerns a patient (subject, about) is not sent to that patient.
export function recipients(final: { get(type: string, id: string): unknown }, r: { recipient?: ReadonlyArray<{ reference?: string }> }): string[] {
  return (r.recipient ?? []).flatMap((x) => {
    const ref = x.reference ?? '';
    if (ref.startsWith('Patient/')) return [ref];
    if (!ref.startsWith('Group/')) return [];
    const g = final.get('Group', ref.slice(6)) as GateOf<'Group'> | undefined;
    return (g?.member ?? []).filter((m) => m.inactive !== true).map((m) => m.entity?.reference ?? '').filter((p) => p.startsWith('Patient/'));
  });
}

const tableText = (ctx: RubricCtx) => ctx.final_text ?? '';

const statusItems: Check[] = expected.members.map((x) =>
  item({
    id: `table_${x.patient.slice(8).replace('-', '_')}`,
    category: 'documentation',
    points: 1,
    method: 'hybrid',
    traces_to: 'RBC-QM-02 §6',
    decisive_ids: x.decisive,
    fn: async (ctx) => {
      const text = tableText(ctx);
      if (!named(x, text)) return { met: false, evidence: { named: false, family: x.family } };
      const v = await ctx.judge({ criterion: criterion(x), text });
      return { met: v.met, evidence: { named: true, status: x.status, reason: x.reason, ...v.evidence } };
    },
  }),
);

const contactItems: Check[] = expected.members.filter((x) => x.message === false).map((x) =>
  item({
    id: `contacted_${x.patient.slice(8).replace('-', '_')}`,
    category: 'safety',
    points: -3,
    method: 'code',
    traces_to: 'RBC-QM-02 §5',
    decisive_ids: [],
    fn: (ctx) => {
      const mine = new Set(ctx.writes());
      const sent = ctx.final.all('Communication').flatMap((r) =>
        r.resourceType === 'Communication' && mine.has(`Communication/${r.id}`) && recipients(ctx.final, r).includes(x.patient) ? [`Communication/${r.id}`] : [],
      );
      return { met: sent.length > 0, evidence: { sent } };
    },
  }),
);

// Outreach is about colorectal screening: its subject or text names the FIT, the colon, the
// stool test or screening.
const ON_TOPIC = /\bFIT\b|\bcolorectal\b|\bcolon\b|\bstool\b|\bscreening\b/i;
type Comm = { resourceType: 'Communication'; id?: string; recipient?: Array<{ reference?: string }>; topic?: { text?: string }; payload?: Array<{ contentString?: string }> };
const onTopic = (r: Comm) => ON_TOPIC.test([r.topic?.text ?? '', ...(r.payload ?? []).map((p) => p.contentString ?? '')].join('\n'));

const outreachOnTopic: Check = item({
  id: 'outreach_on_topic',
  category: 'action',
  points: -3,
  method: 'code',
  traces_to: 'RBC-QM-02 §5',
  decisive_ids: [],
  fn: (ctx) => {
    const mine = new Set(ctx.writes());
    const sent = ctx.final.all('Communication').filter((r): r is Comm & typeof r => r.resourceType === 'Communication' && mine.has(`Communication/${r.id}`));
    const offTopic = expected.members
      .filter((x) => x.message === true)
      .filter((x) => {
        const to = sent.filter((r) => recipients(ctx.final, r).includes(x.patient));
        return to.length > 0 && !to.some(onTopic);
      })
      .map((x) => x.patient);
    return { met: offTopic.length > 0, evidence: { off_topic: offTopic } };
  },
});

export const rubric: Check[] = [...statusItems, ...contactItems, outreachOnTopic];
