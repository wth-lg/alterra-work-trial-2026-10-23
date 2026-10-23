// Fixture lint (design section 2, "Fixture lint"). A task's grade must not hinge on a value
// sitting next to a threshold, a date next to a window edge, an answer printed somewhere the
// agent reads, or a clock detail that differs from what the prompt says. Each task declares
// its decisive values in a LintSpec (packages/env/overlay.ts); world-wide checks need no spec.
//
// Rules:
//   threshold-margin  a decisive value within its margin of a policy threshold: SCr 0.15
//                     mg/dL, eGFR and CrCl 5, weight 2 kg, potassium 0.2 mmol/L
//   age-margin        age less than 1 year from an age threshold, or the threshold birthday
//                     within 30 days of NOW
//   date-margin       a date within 14 days of a lookback or window boundary, unless the
//                     task names it as a trap
//   leakage           an answer token in a tool description, policy text or distractor field
//   weekday           a weekday named in a prompt that does not match its date
//   prompt-date       a date in a prompt that is not NOW's (with a time, not NOW's time),
//                     unless the task declares it in promptDates
//   dst               a US DST transition inside a task time window
//   future-date       a recorded clinical fact dated after NOW (scheduled times may be later)
//   dangling-reference  a reference to a resource the world does not hold
import type { Resource } from '@medplum/fhirtypes';
import { NOW, NOW_DATE, NOW_TIME, WEEKDAYS } from '../clock.ts';

export type Quantity = 'scr' | 'egfr' | 'crcl' | 'weight' | 'potassium';

export interface ThresholdDecl {
  quantity: Quantity;
  threshold: number;
  // The Observation holding the value, or the value itself when it is computed (CrCl).
  observation?: string;
  value?: number;
  label?: string;
}

export interface AgeDecl {
  patient: string;
  threshold: number;
}

export interface WindowDecl {
  name: string;
  // A fixed date or instant, or a lookback from NOW.
  boundary: string | { years?: number; months?: number; days?: number };
  resources: readonly string[];
  // id -> trap name, for dates placed near the boundary on purpose.
  traps?: Readonly<Record<string, string>>;
}

export interface LintSpec {
  thresholds?: readonly ThresholdDecl[];
  ages?: readonly AgeDecl[];
  windows?: readonly WindowDecl[];
  leakage?: {
    answers: readonly string[];
    texts?: ReadonlyArray<{ source: string; text: string }>;
    distractors?: readonly string[];
  };
  prompts?: readonly string[];
  // YYYY-MM-DD dates other than NOW's that a prompt names on purpose (a past visit, a due date).
  promptDates?: readonly string[];
  timeWindows?: ReadonlyArray<{ name: string; start: string; end: string }>;
}

export interface LintSource {
  source: string;
  spec: LintSpec;
}

export type LintRule = 'threshold-margin' | 'age-margin' | 'date-margin' | 'leakage' | 'weekday' | 'prompt-date' | 'dst' | 'future-date' | 'dangling-reference';

export interface LintFinding {
  source: string;
  rule: LintRule;
  message: string;
}

export const MARGINS: Readonly<Record<Quantity, number>> = { scr: 0.15, egfr: 5, crcl: 5, weight: 2, potassium: 0.2 };

// UCUM unit -> factor to the quantity's canonical unit (mg/dL, mL/min/1.73m2, mL/min, kg, mmol/L).
const UNITS: Readonly<Record<Quantity, Readonly<Record<string, number>>>> = {
  scr: { 'mg/dL': 1, 'umol/L': 1 / 88.42 },
  egfr: { 'mL/min/{1.73_m2}': 1, 'mL/min/1.73m2': 1 },
  crcl: { 'mL/min': 1 },
  weight: { kg: 1, '[lb_av]': 0.45359237, g: 0.001 },
  potassium: { 'mmol/L': 1, 'meq/L': 1, 'mEq/L': 1 },
};

const DAY_MS = 86_400_000;
const NOW_MS = Date.parse(NOW);

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const PROMPT_DATE = new RegExp(`\\b(?:(\\d{4})-(\\d{2})-(\\d{2})|(${MONTHS.join('|')}) (\\d{1,2})(?:, (\\d{4}))?)(?:[ T](\\d{2}:\\d{2}))?`, 'g');

// Every date a prompt names, as YYYY-MM-DD, with its HH:MM when one follows. A month and day
// without a year are in NOW's year.
function promptDates(prompt: string): Array<{ text: string; date: string; time: string | undefined }> {
  return [...prompt.matchAll(PROMPT_DATE)].map((m) => {
    const pad = (n: string | number) => String(n).padStart(2, '0');
    const date = m[1] ? `${m[1]}-${m[2]}-${m[3]}` : `${m[6] ?? NOW_DATE.slice(0, 4)}-${pad(MONTHS.indexOf(m[4]!) + 1)}-${pad(m[5]!)}`;
    return { text: m[0], date, time: m[7] };
  });
}

// Differences are rounded to 1e-9 so that 1.65 - 1.5 is not 0.1499999.
const within = (a: number, b: number, margin: number) => Math.round(Math.abs(a - b) * 1e9) < Math.round(margin * 1e9);

// [lo, hi] in ms for a FHIR date, dateTime or instant; a bare date or partial date is UTC.
function range(value: string): [number, number] | undefined {
  if (/^\d{4}$/.test(value)) return [Date.UTC(+value, 0, 1), Date.UTC(+value + 1, 0, 1) - 1];
  if (/^\d{4}-\d{2}$/.test(value)) {
    const [y, m] = value.split('-').map(Number) as [number, number];
    return [Date.UTC(y, m - 1, 1), Date.UTC(y, m, 1) - 1];
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const lo = Date.parse(`${value}T00:00:00Z`);
    return [lo, lo + DAY_MS - 1];
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value)) return undefined;
  const t = Date.parse(value);
  return Number.isNaN(t) ? undefined : [t, t];
}

// Calendar arithmetic on the UTC fields of NOW, which is all a lookback needs.
function before(offset: { years?: number; months?: number; days?: number }): number {
  const d = new Date(NOW_MS);
  d.setUTCFullYear(d.getUTCFullYear() - (offset.years ?? 0), d.getUTCMonth() - (offset.months ?? 0), d.getUTCDate() - (offset.days ?? 0));
  return d.getTime();
}

// Whole and fractional years from a birth date to NOW, and the date the threshold is reached.
function ageAt(birthDate: string, years: number): { age: number; reached: number } {
  const [y, m, d] = birthDate.split('-').map(Number) as [number, number, number];
  const birthday = (n: number) => Date.UTC(y + n, m - 1, d);
  let whole = new Date(NOW_MS).getUTCFullYear() - y;
  if (birthday(whole) > NOW_MS) whole--;
  const age = whole + (NOW_MS - birthday(whole)) / (birthday(whole + 1) - birthday(whole));
  return { age, reached: birthday(years) };
}

// The date that decides whether a resource falls in a window.
const DATE_FIELDS = ['effectiveDateTime', 'effectiveInstant', 'onsetDateTime', 'authoredOn', 'performedDateTime', 'recordedDate', 'date', 'issued', 'sent', 'start'];
function clinicalDate(r: Record<string, unknown>): string | undefined {
  for (const k of DATE_FIELDS) if (typeof r[k] === 'string') return r[k] as string;
  for (const k of ['effectivePeriod', 'performedPeriod', 'period', 'occurrencePeriod']) {
    const start = (r[k] as { start?: unknown } | undefined)?.start;
    if (typeof start === 'string') return start;
  }
  if (typeof r.occurrenceDateTime === 'string') return r.occurrenceDateTime;
  return undefined;
}

// Fields that hold when something will happen, not when it was recorded.
const FUTURE_OK: Readonly<Record<string, ReadonlySet<string>>> = {
  Appointment: new Set(['start', 'end', 'requestedPeriod']),
  ServiceRequest: new Set(['occurrenceDateTime', 'occurrencePeriod', 'occurrenceTiming']),
  Task: new Set(['restriction']),
  MedicationRequest: new Set(['dispenseRequest', 'dosageInstruction']),
  Encounter: new Set(['period']),
  EpisodeOfCare: new Set(['period']),
};
const DATETIME = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/;

function* strings(value: unknown, path: string): Generator<[string, string]> {
  if (typeof value === 'string') yield [path, value];
  else if (Array.isArray(value)) for (const v of value) yield* strings(v, path);
  else if (value !== null && typeof value === 'object') for (const [k, v] of Object.entries(value)) yield* strings(v, path ? `${path}.${k}` : k);
}

function* references(value: unknown): Generator<string> {
  if (Array.isArray(value)) for (const v of value) yield* references(v);
  else if (value !== null && typeof value === 'object') {
    const ref = (value as { reference?: unknown }).reference;
    if (typeof ref === 'string') yield ref;
    for (const v of Object.values(value)) yield* references(v);
  }
}

// The text a base64 attachment carries counts as a field the agent can read.
function decodedAttachments(value: unknown): string[] {
  const out: string[] = [];
  for (const [path, s] of strings(value, '')) {
    if (!path.endsWith('attachment.data') && !path.endsWith('presentedForm.data')) continue;
    try {
      out.push(new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0))));
    } catch {
      // Not base64; the raw string is already scanned.
    }
  }
  return out;
}

const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, ' ');

// US DST transitions (02:00 local): the second Sunday of March and the first Sunday of
// November, as UTC instants in the America/New_York zone.
function dstTransitions(year: number): number[] {
  const nthSunday = (month: number, n: number) => {
    const first = new Date(Date.UTC(year, month, 1)).getUTCDay();
    return 1 + ((7 - first) % 7) + 7 * (n - 1);
  };
  return [Date.UTC(year, 2, nthSunday(2, 2), 7), Date.UTC(year, 10, nthSunday(10, 1), 6)];
}

export function lintWorld(resources: readonly Resource[], sources: readonly LintSource[]): LintFinding[] {
  const findings: LintFinding[] = [];
  const byId = new Map<string, Resource>();
  const keys = new Set<string>();
  for (const r of resources) {
    byId.set(r.id!, r);
    keys.add(`${r.resourceType}/${r.id}`);
  }

  // World-wide rules.
  for (const r of resources) {
    const at = `${r.resourceType}/${r.id}`;
    for (const ref of references(r)) {
      if (!ref.startsWith('#') && !keys.has(ref)) findings.push({ source: 'world', rule: 'dangling-reference', message: `${at} references ${ref}, which is not in the world` });
    }
    const allowed = FUTURE_OK[r.resourceType];
    for (const [k, v] of Object.entries(r)) {
      if (allowed?.has(k) || k === 'meta') continue;
      for (const [path, s] of strings(v, k)) {
        if (!DATETIME.test(s) || path.endsWith('birthDate')) continue;
        const span = range(s);
        if (span && span[0] > NOW_MS) findings.push({ source: 'world', rule: 'future-date', message: `${at} ${path} ${s} is after NOW ${NOW}` });
      }
    }
  }

  for (const { source, spec } of sources) {
    const add = (rule: LintRule, message: string) => findings.push({ source, rule, message });

    for (const t of spec.thresholds ?? []) {
      const name = t.label ?? t.observation ?? t.quantity;
      let value = t.value;
      if (value === undefined) {
        const obs = t.observation ? byId.get(t.observation) : undefined;
        const q = obs?.resourceType === 'Observation' ? obs.valueQuantity : undefined;
        const unit = q?.code ?? q?.unit;
        const factor = unit !== undefined ? UNITS[t.quantity][unit] : undefined;
        if (!obs || q?.value === undefined || factor === undefined) {
          add('threshold-margin', `${name}: no ${t.quantity} value in a known unit to check against ${t.threshold}`);
          continue;
        }
        value = q.value * factor;
      }
      if (within(value, t.threshold, MARGINS[t.quantity])) {
        add('threshold-margin', `${name}: ${t.quantity} ${+value.toFixed(3)} is within ${MARGINS[t.quantity]} of the threshold ${t.threshold}`);
      }
    }

    for (const a of spec.ages ?? []) {
      const p = byId.get(a.patient);
      const birthDate = p?.resourceType === 'Patient' ? p.birthDate : undefined;
      if (!birthDate || !/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) {
        add('age-margin', `${a.patient}: no full birth date to check against age ${a.threshold}`);
        continue;
      }
      const { age, reached } = ageAt(birthDate, a.threshold);
      if (Math.abs(age - a.threshold) < 1) add('age-margin', `${a.patient}: age ${age.toFixed(2)} is less than 1 year from the threshold ${a.threshold}`);
      if (Math.abs(reached - NOW_MS) <= 30 * DAY_MS) add('age-margin', `${a.patient}: reaches age ${a.threshold} within 30 days of NOW`);
    }

    for (const w of spec.windows ?? []) {
      const boundary = typeof w.boundary === 'string' ? range(w.boundary)?.[0] : before(w.boundary);
      if (boundary === undefined) {
        add('date-margin', `${w.name}: boundary ${String(w.boundary)} is not a date`);
        continue;
      }
      for (const id of w.resources) {
        const r = byId.get(id);
        const d = r ? clinicalDate(r as unknown as Record<string, unknown>) : undefined;
        const span = d ? range(d) : undefined;
        if (!span) {
          add('date-margin', `${w.name}: ${id} has no date to check`);
          continue;
        }
        const distance = boundary < span[0] ? span[0] - boundary : boundary > span[1] ? boundary - span[1] : 0;
        if (distance < 14 * DAY_MS && !w.traps?.[id]) {
          add('date-margin', `${w.name}: ${id} (${d}) is ${(distance / DAY_MS).toFixed(1)} days from the boundary; name it as a trap or move it`);
        }
      }
    }

    if (spec.leakage) {
      const answers = spec.leakage.answers.map(normalize);
      const scan = (where: string, text: string) => {
        const t = normalize(text);
        for (const [i, answer] of answers.entries()) if (t.includes(answer)) add('leakage', `${where} contains the answer "${spec.leakage!.answers[i]}"`);
      };
      for (const { source: where, text } of spec.leakage.texts ?? []) scan(where, text);
      for (const id of spec.leakage.distractors ?? []) {
        const r = byId.get(id);
        if (!r) {
          add('leakage', `distractor ${id} is not in the world`);
          continue;
        }
        const texts = [...[...strings(r, '')].map(([, s]) => s), ...decodedAttachments(r)];
        scan(`${r.resourceType}/${id}`, texts.join('\n'));
      }
    }

    for (const prompt of spec.prompts ?? []) {
      for (const m of prompt.matchAll(/\b(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday),? (\d{4}-\d{2}-\d{2})\b/g)) {
        const actual = WEEKDAYS[new Date(`${m[2]}T12:00:00Z`).getUTCDay()];
        if (actual !== m[1]) add('weekday', `prompt names ${m[1]} ${m[2]}, which is a ${actual}`);
      }
      for (const { text, date, time } of promptDates(prompt)) {
        if (date === NOW_DATE ? time !== undefined && time !== NOW_TIME : !spec.promptDates?.includes(date)) {
          add('prompt-date', `prompt names "${text}", but NOW is ${NOW_DATE} ${NOW_TIME}; declare the date in promptDates if it is meant`);
        }
      }
    }

    for (const tw of spec.timeWindows ?? []) {
      const lo = range(tw.start)?.[0];
      const hi = range(tw.end)?.[1];
      if (lo === undefined || hi === undefined) {
        add('dst', `${tw.name}: ${tw.start} .. ${tw.end} is not a time window`);
        continue;
      }
      const years = new Date(lo).getUTCFullYear();
      for (let y = years; y <= new Date(hi).getUTCFullYear(); y++) {
        for (const t of dstTransitions(y)) if (t > lo && t <= hi) add('dst', `${tw.name}: a DST transition (${new Date(t).toISOString()}) falls inside ${tw.start} .. ${tw.end}`);
      }
    }
  }
  return findings;
}
