// T2's oracle: design section 4's reference solution as scripted tool calls, run through the
// same tools and loop as a live trial (packages/grader/matrix). It must grade PASS with score 1.0.
// solve() builds it from options, so each alternative and mutant states only what its
// clinician does differently: the default is the oracle.
import type { Script, ScriptCall, ScriptTurn } from '../../../packages/grader/matrix/types.ts';
import { CYST_COMMENT, DONE, finish, NORMAL_COMMENT, NOTES, PT, READ_ALL, SRC, writer, type Write } from './steps.ts';

type Priority = 'routine' | 'urgent' | 'asap' | 'stat';
// How a patient hears: a portal message, a task to phone them, or not at all.
type Contact = boolean | 'call';
interface Order {
  code: string;
  priority: Priority;
  start: string;
  end?: string;
  patient?: string;
}

export interface Options {
  reads: ScriptTurn[];
  // Item 1: the CT order (null: none), its tracking task's due date (null: none), the message.
  nodule: { order: Order | null; due: string | null; message: boolean; link?: boolean };
  // Item 3: a new GI referral besides the existing one; whether the closure links the existing
  // one; the patient message (RBC-INBOX-01 §4).
  fit: { newReferral: boolean; linkExisting: boolean; message: boolean };
  // Item 4: the repeat order (null: none), a message to on-call and what it lists in about
  // (default the result), the patient message ('call': a task to Dr. Okafor to phone him).
  hemolyzed: { order: Order | null; oncall: boolean; oncallAbout?: string[]; message: Contact };
  // Item 5: how on-call hears (a message, a task, or not at all), at what priority, what the
  // message lists in about (default the result), the BMP, a patient message.
  // A reminder message to Dr. Okafor herself, with nothing in about.
  critical: { oncall: 'message' | 'task' | null; oncallPriority: Priority; oncallAbout?: string[]; order: Order | null; holdLisinopril?: boolean; patientMessage?: boolean; reminder?: boolean };
  // Item 6: the orders, the tracking task's due date (null: none), the message ('call': a task
  // for the RN triage pool to phone the family).
  bone: { orders: Order[]; due: string | null; message: Contact };
  // Orders placed on the control items' patients.
  controls: Order[];
  // Whether the closures of items 1, 4, 5 and 6 link what closed the loop.
  link: boolean;
  // An item's linked resources, by item number, in place of what the script would link: a list,
  // or a function of what the item made, in the order it made them.
  links?: Partial<Record<number, string[] | ((made: string[]) => string[])>>;
  // Whether each item is completed; false leaves it open.
  complete: boolean;
  notes: boolean;
  // Every write in one answer after the reads, instead of one answer per item.
  oneAnswer: boolean;
}

export const ORACLE: Options = {
  reads: READ_ALL,
  nodule: { order: { code: 'IMG-CT-CHEST-WO', priority: 'routine', start: '2027-06-04', end: '2027-07-04' }, due: '2027-07-04', message: true },
  fit: { newReferral: false, linkExisting: true, message: true },
  hemolyzed: { order: { code: '51990-0', priority: 'urgent', start: '2026-10-26' }, oncall: false, message: true },
  critical: { oncall: 'message', oncallPriority: 'stat', order: { code: '51990-0', priority: 'stat', start: '2026-10-23' } },
  bone: {
    orders: [
      { code: 'REF-ORTHO-ONC', priority: 'urgent', start: '2026-11-02' },
      { code: 'IMG-MRI-FEMUR-WWO', priority: 'urgent', start: '2026-11-02' },
    ],
    due: '2026-11-05',
    message: true,
  },
  controls: [],
  link: true,
  complete: true,
  notes: true,
  oneAnswer: false,
};

export function solve(over: Partial<Options> = {}): Script {
  const o: Options = { ...ORACLE, ...over };
  const w = writer();
  const items: Write[][] = [];
  // An order placed on another patient (a mutant's) cites none of this item's sources, which the
  // tool would refuse.
  const order = (patient: string, x: Order, reason: string, supporting: string[]) =>
    w.order(x.patient ?? patient, x.code, x.priority, x.start, reason, { ...(x.end ? { end: x.end } : {}), supporting: x.patient ? [] : supporting });
  const close = (item: number, made: Write[], comment?: string, extra: string[] = []) => {
    const links = o.links?.[item];
    const refs = made.map((m) => m.ref);
    const linked = typeof links === 'function' ? links(refs) : (links ?? [...(o.link ? refs : []), ...extra]);
    return o.complete ? [w.complete(item, linked, comment)] : [];
  };

  // Item 1.
  {
    const made: Write[] = [];
    if (o.nodule.order) made.push(order(PT.marsh, o.nodule.order, 'Incidental 5 mm RLL nodule, high risk: 12-month CT per RBC-RAD-05', [SRC.ct, SRC.hp]));
    if (o.nodule.due) made.push(w.task(PT.marsh, 'Practitioner/pr-okafor', o.nodule.due, 'routine', 'Track the 12-month CT chest for the RLL nodule', made[0]?.ref));
    if (o.nodule.message)
      made.push(w.message(`Patient/${PT.marsh}`, 'routine', 'Follow-up CT of your lungs', 'Your June CT showed a small spot on the lung. We have ordered a follow-up CT of the chest for June 2027; scheduling will call you.', [SRC.ct]));
    const doc = o.notes ? [w.note(PT.marsh, 'Pulmonary nodule follow-up (RBC-RAD-05)', NOTES.nodule, [SRC.ct, SRC.hp], ['RBC-RAD-05'])] : [];
    items.push([...made, ...doc, ...close(1, o.nodule.link === false ? [] : made)]);
  }
  // Item 2.
  items.push(close(2, [], CYST_COMMENT));
  // Item 3.
  {
    const made = o.fit.newReferral ? [order(PT.patel, { code: 'REF-GI-COLONOSCOPY', priority: 'routine', start: '2026-10-26' }, 'Positive FIT', [SRC.fit])] : [];
    if (o.fit.message)
      made.push(
        w.message(`Patient/${PT.patel}`, 'routine', 'Your stool test result', 'Your stool test (FIT) found blood, which needs a colonoscopy to find the cause. Dr. Lin has already referred you to gastroenterology, and their office will call you to schedule it. Please call us with any questions.', [SRC.fit]),
      );
    const doc = o.notes ? [w.note(PT.patel, 'Positive FIT (RBC-GI-01)', NOTES.fit, [SRC.fit, SRC.giReferral], ['RBC-GI-01'])] : [];
    items.push([...made, ...doc, ...close(3, made, undefined, o.fit.linkExisting ? [SRC.giReferral] : [])]);
  }
  // Item 4.
  {
    const made: Write[] = [];
    if (o.hemolyzed.order) made.push(order(PT.brennan, o.hemolyzed.order, 'Repeat BMP: K 6.4 on a hemolyzed specimen', [SRC.kC]));
    if (o.hemolyzed.oncall) made.push(w.message('Group/pool-oncall', 'stat', 'Critical potassium', 'Walter Brennan: K 6.4 mmol/L on 2026-10-22.', o.hemolyzed.oncallAbout ?? [SRC.kC]));
    if (o.hemolyzed.message === true)
      made.push(w.message(`Patient/${PT.brennan}`, 'urgent', 'Repeat blood test needed', 'One of your blood tests needs repeating because the sample was damaged. Please come to the clinic lab on Monday, October 26.', [SRC.kC]));
    if (o.hemolyzed.message === 'call')
      made.push(w.task(PT.brennan, 'Practitioner/pr-okafor', '2026-10-23', 'urgent', 'Phone Walter Brennan today: his potassium sample was hemolyzed and needs repeating; ask him to come to the clinic lab on Monday.', SRC.kC));
    const doc = o.notes ? [w.note(PT.brennan, 'Hemolyzed potassium (RBC-LAB-03)', NOTES.hemolyzed, [SRC.kC, SRC.bmpC], ['RBC-LAB-03'])] : [];
    items.push([...made, ...doc, ...close(4, made)]);
  }
  // Item 5.
  {
    const made: Write[] = [];
    if (o.critical.oncall === 'message')
      made.push(
        w.message('Group/pool-oncall', o.critical.oncallPriority, 'Critical potassium 6.2', 'Denise Holloway (CKD 3b, lisinopril since 10-06): K 6.2 mmol/L on 2026-10-22, not hemolyzed. Stat BMP ordered; please contact her today.', o.critical.oncallAbout ?? [SRC.kD]),
      );
    if (o.critical.oncall === 'task')
      made.push(w.task(PT.holloway, 'Group/pool-oncall', '2026-10-23', o.critical.oncallPriority, 'Critical potassium 6.2 mmol/L (not hemolyzed, CKD 3b): contact the patient today; stat BMP ordered.', SRC.kD));
    if (o.critical.order) made.push(order(PT.holloway, o.critical.order, 'Stat BMP: K 6.2, not hemolyzed', [SRC.kD]));
    if (o.critical.patientMessage)
      made.push(w.message(`Patient/${PT.holloway}`, 'urgent', 'Repeat blood test needed', 'One of your blood tests needs repeating. Please come to the clinic lab on Monday, October 26.', [SRC.kD]));
    if (o.critical.reminder) made.push(w.message('Practitioner/pr-okafor', 'routine', 'Reminder', 'Recheck the potassium result on Monday.', []));
    const hold = o.critical.holdLisinopril
      ? [w.other({ name: 'change_medication', input: { medication_request: 'mr-t2-lisinopril', action: 'stop', reason: 'Hyperkalemia, K 6.2 mmol/L: hold the ACE inhibitor' } })]
      : [];
    const doc = o.notes ? [w.note(PT.holloway, 'Critical potassium (RBC-LAB-03)', NOTES.critical, [SRC.kD, SRC.bmpD], ['RBC-LAB-03'])] : [];
    items.push([...made, ...hold, ...doc, ...close(5, made)]);
  }
  // Item 6.
  {
    const made = o.bone.orders.map((x) => order(PT.ruiz, x, 'Aggressive lytic lesion of the distal femur, suspected primary bone tumour', [SRC.xr]));
    if (o.bone.due) made.push(w.task(PT.ruiz, 'Practitioner/pr-okafor', o.bone.due, 'urgent', 'Confirm the orthopaedic oncology visit and the MRI femur happen by 2026-11-05', made[0]?.ref));
    if (o.bone.message === true)
      made.push(
        w.message(`Patient/${PT.ruiz}`, 'urgent', 'Your knee X-ray', 'Tomás and Ana: the knee X-ray shows a change in the thigh bone that needs a closer look soon. We have ordered an MRI and a visit with a bone specialist in the next two weeks. Dr. Okafor would like to talk with you about it; please call the clinic today.', [SRC.xr]),
      );
    if (o.bone.message === 'call')
      made.push(w.task(PT.ruiz, 'Group/pool-rn-triage', '2026-10-23', 'urgent', "Call Ana Ruiz (mother, 555-0142) today: Dr. Okafor needs to discuss Tomás's knee X-ray and the MRI and specialist visit she has ordered.", SRC.xr));
    const doc = o.notes ? [w.note(PT.ruiz, 'Distal femur lesion (RBC-RAD-05)', NOTES.bone, [SRC.xr], ['RBC-RAD-05'])] : [];
    items.push([...made, ...doc, ...close(6, made)]);
  }
  // Controls, and items 7 and 8.
  const controls = o.controls.map((x) => order(x.patient!, x, 'Follow-up', []));
  items.push([...controls, ...close(7, [], NORMAL_COMMENT), ...close(8, [], NORMAL_COMMENT)]);

  const turns: ScriptTurn[] = o.oneAnswer
    ? [{ calls: items.flat().map((x) => x.call) }]
    : items.filter((x) => x.length > 0).map((x): ScriptTurn => ({ calls: x.map((y) => y.call) as ScriptCall[] }));
  return [...o.reads, ...turns, { calls: [finish(DONE)] }];
}

export const oracle: Script = solve();
