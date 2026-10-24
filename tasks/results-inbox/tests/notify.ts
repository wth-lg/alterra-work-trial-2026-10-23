// Who the trial's messages and tasks are about, for the gates (grader.ts) and the rubric
// (rubric.ts). send_message sets a Communication's subject only from a patient recipient or
// from about, which may be empty, so a page to on-call can carry no patient. Such a message is
// about a patient when one of the patient's inbox items links it: structure a gate can read
// (gate-view.ts keeps free text from gates). The rubric also takes a message or task whose text
// names the patient by full name or MRN (rubric.ts namesPatient).
import { expected } from '../expected.ts';

type Ref = { reference?: string };
export interface Res {
  resourceType: string;
  id: string;
  priority?: string;
  subject?: Ref;
  for?: Ref;
  owner?: Ref;
  recipient?: Ref[];
  code?: unknown;
  output?: Array<{ valueReference?: Ref }>;
}
export interface NotifyCtx {
  readonly initial: { has(type: string, id: string): boolean };
  readonly final: { get(type: string, id: string): unknown; all(type: string): readonly unknown[] };
  writes(): readonly string[];
}

export const ONCALL = 'Group/pool-oncall';
export const keyOf = (r: { resourceType: string; id?: string }) => `${r.resourceType}/${r.id}`;
const split = (ref: string) => ref.split('/') as [string, string];

// What the trial created, as <Type>/<id>.
export const created = (ctx: NotifyCtx) => new Set(ctx.writes().filter((k) => !ctx.initial.has(...split(k))));
export const madeOf = (ctx: NotifyCtx, type: string) => {
  const mine = created(ctx);
  return (ctx.final.all(type) as Res[]).filter((r) => mine.has(keyOf(r)));
};

// The patient a resource is for (Communication.subject, Task.for, an order's subject), if any.
export const patientOf = (r: Res) => r.subject?.reference ?? r.for?.reference;

// Every resource the patient's inbox items link in their closures.
export function linkedFor(ctx: NotifyCtx, patient: string): Set<string> {
  const items = Object.values(expected.items).filter((x) => x.patient === patient);
  return new Set(items.flatMap((x) => ((ctx.final.get(...split(x.task)) as Res | undefined)?.output ?? []).map((o) => o.valueReference?.reference ?? '')));
}

// Whether a resource the trial made is about the patient: its patient is the patient, or it has
// none and the patient's inbox item links it, or (rubric) its text names the patient.
export function about(ctx: NotifyCtx, patient: string, names?: (r: Res) => boolean): (r: Res) => boolean {
  const linked = linkedFor(ctx, patient);
  return (r) => {
    const own = patientOf(r);
    if (own !== undefined) return own === patient;
    return linked.has(keyOf(r)) || (names?.(r) ?? false);
  };
}

// The on-call notices the trial made about a patient: a message to pool-oncall, or a task
// pool-oncall owns (design section 5, "action equivalence").
export function oncall(ctx: NotifyCtx, patient: string, names?: (r: Res) => boolean): Res[] {
  const isAbout = about(ctx, patient, names);
  return [
    ...madeOf(ctx, 'Communication').filter((c) => (c.recipient ?? []).some((r) => r.reference === ONCALL) && isAbout(c)),
    ...madeOf(ctx, 'Task').filter((t) => t.owner?.reference === ONCALL && isAbout(t)),
  ];
}
