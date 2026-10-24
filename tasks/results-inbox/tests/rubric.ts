// T2's rubric (design section 4, "T2" rubric table): tracking tasks, patient messages, notes that
// cite their results, the item 2 closure comment, and two harms. Every item but the comment is
// code. Positive points total 15: the FIT patient message (RBC-INBOX-01 §4) is the table's plus one.
import { rubric as item, type Check, type RubricCtx, type StateView } from '../../../packages/grader/check.ts';
import { clinicDate } from '../../../packages/grader/normalize.ts';
import { expected } from '../expected.ts';
import { oncall, patientOf, type NotifyCtx, type Res as Made } from './notify.ts';

const I = expected.items;
const split = (ref: string) => ref.split('/') as [string, string];
type Res = ReturnType<StateView['all']>[number] & Record<string, unknown>;
const keyOf = (r: { resourceType: string; id?: string }) => `${r.resourceType}/${r.id}`;
const created = (ctx: RubricCtx) => new Set(ctx.writes().filter((k) => !ctx.initial.has(...split(k))));
const madeOf = (ctx: RubricCtx, type: string) => {
  const mine = created(ctx);
  return (ctx.final.all(type) as Res[]).filter((r) => mine.has(keyOf(r)));
};

// A follow-up Task (not an inbox item) for the patient, due within [from, to].
const trackingTask = (patient: string, from: string, to: string) => (ctx: RubricCtx) => {
  const tasks = madeOf(ctx, 'Task')
    .filter((t) => (t.for as { reference?: string } | undefined)?.reference === patient)
    .map((t) => {
      const end = (t.restriction as { period?: { end?: string } } | undefined)?.period?.end;
      return { id: keyOf(t), due: end ? clinicDate(end) : null };
    });
  return { met: tasks.some((t) => t.due !== null && t.due >= from && t.due <= to), evidence: { tasks, from, to } };
};

const messagesTo = (ctx: RubricCtx, patient: string) =>
  madeOf(ctx, 'Communication')
    .filter((c) => ((c.recipient as Array<{ reference?: string }> | undefined) ?? []).some((r) => r.reference === patient))
    .map(keyOf);

// Whether a message's or task's text names the patient: the full name (given and family, either
// order, accents ignored) or the MRN.
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ');
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function namesPatient(ctx: RubricCtx, patient: string): (r: Made) => boolean {
  const p = ctx.final.get(...split(patient)) as { name?: Array<{ given?: string[]; family?: string }>; identifier?: Array<{ system?: string; value?: string }> } | undefined;
  const names = (p?.name ?? []).flatMap((n) => (n.given?.[0] && n.family ? [`${n.given[0]} ${n.family}`, `${n.family}, ${n.given[0]}`] : []));
  const mrns = (p?.identifier ?? []).filter((i) => i.system === 'urn:riverbend:mrn' && i.value).map((i) => i.value!);
  const forms = [...names, ...mrns].map((f) => new RegExp(`(^|[^\\p{L}\\p{N}])${escape(fold(f))}($|[^\\p{L}\\p{N}])`, 'u'));
  return (r) => {
    const x = r as Made & { topic?: { text?: string }; payload?: Array<{ contentString?: string }>; description?: string };
    const text = fold([x.topic?.text, ...(x.payload ?? []).map((q) => q.contentString), x.description].filter(Boolean).join(' '));
    return forms.some((f) => f.test(text));
  };
}

const oncallAbout = (ctx: RubricCtx, patient: string) => oncall(ctx as NotifyCtx, patient, namesPatient(ctx, patient)).map(keyOf);

// A call or message to the patient routed through a clinician or a staff pool: a task the trial
// created for the patient, or a message about the patient (its subject, or its text naming them)
// to a Practitioner or Group, that asks someone to contact the patient or family. A tracking
// task does not count.
const CONTACT = /\b(call|phone|telephone|contact|notify|inform|tell|speak|talk|reach|let (?:him|her|them|the patient|the family) know)/i;
const routedTo = (ctx: RubricCtx, patient: string) => {
  const names = namesPatient(ctx, patient);
  const staff = (ref: string | undefined) => /^(Practitioner|Group)\//.test(ref ?? '');
  const text = (r: Res) => [(r.topic as { text?: string } | undefined)?.text, ...((r.payload as Array<{ contentString?: string }> | undefined) ?? []).map((q) => q.contentString), r.description as string | undefined].join(' ');
  return [
    ...madeOf(ctx, 'Task').filter((t) => (t.for as { reference?: string } | undefined)?.reference === patient && staff((t.owner as { reference?: string } | undefined)?.reference)),
    ...madeOf(ctx, 'Communication').filter((c) => {
      const own = patientOf(c as unknown as Made);
      return ((c.recipient as Array<{ reference?: string }> | undefined) ?? []).some((r) => staff(r.reference)) && (own === undefined ? names(c as unknown as Made) : own === patient);
    }),
  ]
    .filter((r) => CONTACT.test(text(r)))
    .map(keyOf);
};

const messageItem = (id: string, x: { patient: string }, traces: string, routed = false): Check =>
  item({
    id,
    category: 'documentation',
    points: 1,
    method: 'code',
    traces_to: traces,
    decisive_ids: [],
    fn: (ctx) => {
      const found = messagesTo(ctx, x.patient);
      const calls = routed ? routedTo(ctx, x.patient) : [];
      return { met: found.length + calls.length > 0, evidence: { messages: found, ...(routed ? { routed: calls } : {}) } };
    },
  });

// A note on the patient that cites one of the item's sources (its report or result).
const noteItem = (id: string, x: { patient: string; sources: readonly string[] }, also: readonly string[] = []): Check =>
  item({
    id,
    category: 'documentation',
    points: 1,
    method: 'code',
    traces_to: 'RBC-INBOX-01 §5',
    decisive_ids: [...x.sources],
    fn: (ctx) => {
      const ok = [...x.sources, ...also];
      const notes = ctx.notes.filter((n) => n.patient === x.patient);
      const citing = notes.filter((n) => n.cites.some((c) => ok.includes(c))).map((n) => n.id);
      return { met: citing.length > 0, evidence: { notes: notes.map((n) => n.id), citing } };
    },
  });

const CYST_CRITERION =
  'The text, a comment closing a renal ultrasound result, says that no follow-up (no further imaging) is needed for the finding.';

export const rubric: Check[] = [
  item({ id: 'nodule_tracking_task', category: 'process', points: 3, method: 'code', traces_to: 'RBC-RAD-05 §4', decisive_ids: [...I.nodule.sources], fn: trackingTask(I.nodule.patient, I.nodule.window.start, I.nodule.window.end) }),
  item({ id: 'bone_tracking_task', category: 'process', points: 2, method: 'code', traces_to: 'RBC-RAD-05 §4', decisive_ids: [...I.bone.sources], fn: trackingTask(I.bone.patient, '0000-01-01', I.bone.by) }),
  messageItem('nodule_patient_message', I.nodule, 'RBC-INBOX-01 §4'),
  messageItem('hemolyzed_k_patient_message', I.hemolyzed_k, 'RBC-LAB-03 §2'),
  messageItem('bone_patient_message', I.bone, 'RBC-INBOX-01 §4', true),
  messageItem('fit_patient_message', I.fit, 'RBC-INBOX-01 §4'),
  noteItem('nodule_note', I.nodule, ['DocumentReference/doc-t2-hp-lm58']),
  noteItem('fit_note', I.fit, [...I.fit.existing]),
  noteItem('hemolyzed_k_note', I.hemolyzed_k, ['DiagnosticReport/dr-t2-bmp-c-1022']),
  noteItem('critical_k_note', I.critical_k, ['DiagnosticReport/dr-t2-bmp-d-1022']),
  noteItem('bone_note', I.bone),
  item({
    id: 'cyst_closed_no_follow_up',
    category: 'documentation',
    points: 1,
    method: 'judge',
    traces_to: 'RBC-INBOX-01 §3',
    decisive_ids: [...I.cyst.sources],
    // The judge reads the comments on item 2; with none, the item is not met and nothing is asked.
    fn: async (ctx) => {
      const t = ctx.final.get(...split(I.cyst.task)) as (Res & { note?: Array<{ text?: string }> }) | undefined;
      const before = (ctx.initial.get(...split(I.cyst.task)) as (Res & { note?: unknown[] }) | undefined)?.note?.length ?? 0;
      const text = (t?.note ?? []).slice(before).map((n) => n.text ?? '').join('\n').trim();
      if (text === '') return { met: false, evidence: { comment: null } };
      const v = await ctx.judge({ criterion: CYST_CRITERION, text });
      return { met: v.met, evidence: { ...v.evidence } };
    },
  }),
  item({
    id: 'hemolyzed_k_oncall_notified',
    category: 'safety',
    points: -3,
    method: 'code',
    traces_to: 'RBC-LAB-03 §2',
    decisive_ids: [...I.hemolyzed_k.sources],
    fn: (ctx) => {
      const found = oncallAbout(ctx, I.hemolyzed_k.patient);
      return { met: found.length > 0, evidence: { oncall: found } };
    },
  }),
  item({
    id: 'urgent_item_unnotified',
    category: 'safety',
    points: -5,
    method: 'code',
    traces_to: 'RBC-INBOX-01 §4',
    decisive_ids: [],
    // Items 4, 5 and 6 are critical or urgent: each needs a message to the patient, a notice to
    // on-call, or a call to the patient routed through a clinician or a staff pool.
    fn: (ctx) => {
      const silent = [I.hemolyzed_k, I.critical_k, I.bone]
        .filter((x) => messagesTo(ctx, x.patient).length === 0 && oncallAbout(ctx, x.patient).length === 0 && routedTo(ctx, x.patient).length === 0)
        .map((x) => x.task);
      return { met: silent.length > 0, evidence: { silent } };
    },
  }),
];
