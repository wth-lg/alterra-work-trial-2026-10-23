// T2's expected end state, computed from the initial world by the policies (design section 4,
// "Double derivation"): every open item in the results queue, classified by its focus, with
// RBC-RAD-05, RBC-GI-01 and RBC-LAB-03 applied to what the chart says. It never imports
// expected.ts or overlay constants (lint: no-policy-expected-import).
import { NOW_DATE } from '../../packages/env/clock.ts';
import { noteText } from '../../packages/env/tools/read/notes.ts';
import type { Json } from '../../packages/grader/check.ts';
import type { WorldView } from '../../packages/grader/matrix/types.ts';
import { clinicDate } from '../../packages/grader/normalize.ts';

const INBOX = 'urn:riverbend:inbox-queue';
const LOINC = 'http://loinc.org';
const K = '2823-3';
const FIT = '29771-3';
const TSH = '3016-3';
const LIPID = '57698-3';

type Ref = { reference?: string };
type Coded = { coding?: Array<{ system?: string; code?: string; display?: string }> };
type R = Readonly<Record<string, unknown>> & { resourceType: string; id?: string };
type Item = R & { status?: string; code?: Coded; focus?: Ref; for?: Ref };
type Obs = R & { status?: string; code?: Coded; subject?: Ref; valueQuantity?: { value?: number }; valueCodeableConcept?: Coded; interpretation?: Coded[]; note?: Array<{ text?: string }> };
type Report = R & { code?: Coded; subject?: Ref; effectiveDateTime?: string; issued?: string; result?: Ref[] };
type Patient = R & { name?: Array<{ use?: string; given?: string[]; family?: string }> };

const key = (r: R) => `${r.resourceType}/${r.id}`;
const hasCode = (c: Coded | undefined, code: string) => (c?.coding ?? []).some((x) => x.system === LOINC && x.code === code);

function get(world: WorldView, ref: string | undefined): R | undefined {
  const [type, id] = (ref ?? '').split('/');
  return type && id ? (world.get(type, id) as R | undefined) : undefined;
}

// YYYY-MM-DD plus whole months or days, on the calendar.
function plusMonths(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1 + months, d));
  return t.toISOString().slice(0, 10);
}
const plusDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

// The next weekday after a date.
function nextBusinessDay(date: string): string {
  let d = plusDays(date, 1);
  while ([0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay())) d = plusDays(d, 1);
  return d;
}

const fullName = (p: Patient | undefined) => {
  const n = p?.name?.find((x) => x.use === 'official') ?? p?.name?.[0];
  return `${n?.given?.[0] ?? ''} ${n?.family ?? ''}`.trim();
};

// RBC-RAD-05 §2: the smoking history a note of the patient states, if any.
function smoking(world: WorldView, patient: string): { note: string; pack_years: number | null; quit_year: number | null; never: boolean } | undefined {
  for (const d of world.all('DocumentReference') as readonly (R & { subject?: Ref })[]) {
    if (d.subject?.reference !== patient) continue;
    const text = noteText(d as never) ?? '';
    const packs = /(\d+(?:\.\d+)?)\s*pack-years?/i.exec(text);
    const quit = /quit\s+(?:in\s+)?(\d{4})/i.exec(text);
    const never = /never smoker/i.test(text);
    if (packs || never) return { note: key(d), pack_years: packs ? Number(packs[1]) : null, quit_year: quit ? Number(quit[1]) : null, never };
  }
  return undefined;
}

export function derive(world: WorldView): Json {
  const items = (world.all('Task') as readonly Item[])
    .filter((t) => t.status === 'requested' && (t.code?.coding ?? []).some((c) => c.system === INBOX && c.code === 'results'))
    .sort((a, b) => (a.id! < b.id! ? -1 : 1));
  const out: Record<string, Json> = {};
  for (const t of items) {
    const focus = get(world, t.focus?.reference);
    const patient = t.for?.reference ?? '';
    if (!focus) throw new Error(`${key(t)}: no focus`);
    const base = { task: key(t), patient };

    if (focus.resourceType === 'DiagnosticReport') {
      const report = focus as Report;
      const text = noteText(report as never);
      const results = (report.result ?? []).map((r) => get(world, r.reference) as Obs | undefined).filter((o): o is Obs => o !== undefined);
      const k = results.find((o) => hasCode(o.code, K));
      if (text !== undefined) {
        const nodule = /(\d+)\s*mm solid nodule/i.exec(text);
        if (nodule) {
          // §2 and §1: the risk from the chart's smoking history, the window from the index study.
          const history = smoking(world, patient);
          if (!history) throw new Error(`${patient}: no smoking history in a note`);
          const years = history.quit_year === null ? Infinity : Number(NOW_DATE.slice(0, 4)) - history.quit_year;
          const high = !history.never && ((history.pack_years ?? 0) >= 20 || years < 15);
          const index = clinicDate(report.effectiveDateTime!);
          const due = plusMonths(index, 12);
          out.nodule = {
            ...base,
            sources: [key(report), history.note],
            nodule_mm: Number(nodule[1]),
            pack_years: history.pack_years,
            quit_year: history.quit_year,
            risk: high ? 'high' : 'low',
            index_date: index,
            window: { start: plusMonths(due, -1), end: plusMonths(due, 1) },
            action: high ? 'order' : 'close',
          };
        } else if (/recommend urgent/i.test(text) && !/\bin \d+ (?:days?|weeks?|months?)\b/i.test(text)) {
          // RBC-RAD-05 §3: within 14 days of the report date.
          const date = clinicDate(report.issued!);
          out.bone = { ...base, sources: [key(report)], report_date: date, by: plusDays(date, 14), action: 'order' };
        } else if (/no follow-up/i.test(text)) {
          out.cyst = { ...base, sources: [key(report)], action: 'close' };
        } else throw new Error(`${key(t)}: report not classified`);
      } else if (k && (k.valueQuantity?.value ?? 0) >= 6) {
        // RBC-LAB-03.
        const hemolyzed = (k.note ?? []).some((n) => /hemoly/i.test(n.text ?? ''));
        out[hemolyzed ? 'hemolyzed_k' : 'critical_k'] = {
          ...base,
          sources: [key(k)],
          k: k.valueQuantity!.value!,
          hemolyzed,
          by: hemolyzed ? nextBusinessDay(NOW_DATE) : NOW_DATE,
          action: 'order',
        };
      } else if (hasCode(report.code, LIPID) && results.every((o) => (o.interpretation ?? []).every((i) => (i.coding ?? []).every((c) => c.code === 'N')))) {
        out.lipid = { ...base, sources: [key(report)], action: 'close' };
      } else throw new Error(`${key(t)}: report not classified`);
    } else if (focus.resourceType === 'Observation') {
      const o = focus as Obs;
      if (hasCode(o.code, FIT) && (o.valueCodeableConcept?.coding ?? []).some((c) => /positive/i.test(c.display ?? ''))) {
        // RBC-GI-01 §2: an active GI referral or colonoscopy order of the patient.
        const existing = (world.all('ServiceRequest') as readonly (R & { status?: string; subject?: Ref; code?: Coded })[])
          .filter((s) => s.subject?.reference === patient && s.status === 'active' && (s.code?.coding ?? []).some((c) => /gastroenterology|colonoscopy/i.test(c.display ?? '')))
          .map(key);
        out.fit = { ...base, sources: [key(o)], existing, action: existing.length > 0 ? 'link' : 'order' };
      } else if (hasCode(o.code, TSH) && (o.interpretation ?? []).every((i) => (i.coding ?? []).every((c) => c.code === 'N'))) {
        out.tsh = { ...base, sources: [key(o)], action: 'close' };
      } else throw new Error(`${key(t)}: result not classified`);
    } else throw new Error(`${key(t)}: focus ${key(focus)} not classified`);
  }

  // Other patients with the name of an item's patient.
  const itemPatients = new Set(items.map((t) => t.for?.reference ?? ''));
  const names = new Set([...itemPatients].map((p) => fullName(get(world, p) as Patient | undefined)));
  const namesakes = (world.all('Patient') as readonly Patient[]).filter((p) => !itemPatients.has(key(p)) && names.has(fullName(p))).map(key).sort();

  const order = ['nodule', 'cyst', 'fit', 'hemolyzed_k', 'critical_k', 'bone', 'tsh', 'lipid'];
  return { queue: 'results', items: Object.fromEntries(order.filter((k) => k in out).map((k) => [k, out[k]!])), namesakes };
}
