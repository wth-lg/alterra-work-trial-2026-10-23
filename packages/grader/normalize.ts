// Normalisation (design section 5): done once, here, so number formatting, unit spelling, code
// display text or the way a dose is written never changes a grade. Checks compare through
// these functions, never through strings:
//   - canonical numbers: '25' = '25.0' = 25;
//   - units: case-insensitive UCUM and the labels US EHRs show (mcg = ug, units = [iU]), mass
//     converted through mg and body weight through kg (lb = [lb_av]);
//   - frequency: BID = Q12H = 2/day, from a code, a phrase or a FHIR Timing.repeat;
//   - total daily dose: dose x doses per day, or the explicit timing events per clinic day;
//   - RxNorm: SCD, SBD and ingredient forms of one drug are the same drug (brand and alias
//     names map to the ingredient), optionally at one strength;
//   - LOINC and other coded concepts: the code decides; display text only when there is no code,
//     compared without case, punctuation or spacing;
//   - status sets: only 'active' is active;
//   - dates: instants compared as calendar dates in the clinic's time zone.
// Action equivalence (modify = stop + new order) needs no function: checks read the final state,
// where both leave the same active requests.
import { eastern } from '../env/clock.ts';

// The FHIR R4 shapes the normalisers read, structurally (a MedicationRequest, its Dosage and
// Timing, a CodeableConcept), so the grader needs no FHIR type package.
export interface Coding {
  system?: string;
  code?: string;
  display?: string;
}
export interface CodeableConcept {
  coding?: Coding[];
  text?: string;
}
export interface TimingRepeat {
  count?: number;
  frequency?: number;
  period?: number;
  periodUnit?: string;
  when?: string[];
}
export interface Dosage {
  timing?: { event?: string[]; repeat?: TimingRepeat; code?: CodeableConcept };
  doseAndRate?: Array<{ doseQuantity?: { value?: number; unit?: string; code?: string } }>;
}
export interface MedicationRequest {
  resourceType: 'MedicationRequest';
  id?: string;
  status?: string;
  subject?: { reference?: string };
  medicationCodeableConcept?: CodeableConcept;
  dosageInstruction?: Dosage[];
}

export type Num = number | string;

const NUMBER = /^[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?$/;

// The number a value states, or null: '25.0' -> 25, '1,000' -> 1000, '25 mg' -> null.
export function canonicalNumber(x: Num): number | null {
  if (typeof x === 'number') return Number.isFinite(x) ? x : null;
  const s = x.trim();
  if (s === '' || !NUMBER.test(s) || !/\d/.test(s)) return null;
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

// Equal after canonicalisation, to 1e-9 relative: float noise from unit conversion is not a
// difference, a changed digit is.
const close = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

export function sameNumber(a: Num, b: Num): boolean {
  const x = canonicalNumber(a);
  const y = canonicalNumber(b);
  return x !== null && y !== null && close(x, y);
}

export interface Quantity {
  value: number;
  unit: string;
}

// Unit spelling -> [canonical unit, dimension, factor to the dimension's base unit].
type Dimension = 'mass' | 'volume' | 'count' | 'other';
const UNITS: Record<string, [unit: string, dim: Dimension, factor: number]> = {
  ug: ['ug', 'mass', 1e-3], mcg: ['ug', 'mass', 1e-3], 'µg': ['ug', 'mass', 1e-3], microgram: ['ug', 'mass', 1e-3], micrograms: ['ug', 'mass', 1e-3],
  mg: ['mg', 'mass', 1], milligram: ['mg', 'mass', 1], milligrams: ['mg', 'mass', 1],
  g: ['g', 'mass', 1e3], gram: ['g', 'mass', 1e3], grams: ['g', 'mass', 1e3],
  kg: ['kg', 'mass', 1e6], kilogram: ['kg', 'mass', 1e6], kilograms: ['kg', 'mass', 1e6],
  lb: ['[lb_av]', 'mass', 453_592.37], lbs: ['[lb_av]', 'mass', 453_592.37], '[lb_av]': ['[lb_av]', 'mass', 453_592.37], pound: ['[lb_av]', 'mass', 453_592.37], pounds: ['[lb_av]', 'mass', 453_592.37],
  ml: ['mL', 'volume', 1], l: ['L', 'volume', 1e3],
  '[iu]': ['[iU]', 'other', 1], iu: ['[iU]', 'other', 1], unit: ['[iU]', 'other', 1], units: ['[iU]', 'other', 1],
  meq: ['meq', 'other', 1],
  '{tablet}': ['{tablet}', 'count', 1], tablet: ['{tablet}', 'count', 1], tablets: ['{tablet}', 'count', 1], tab: ['{tablet}', 'count', 1],
  '{capsule}': ['{capsule}', 'count', 1], capsule: ['{capsule}', 'count', 1], capsules: ['{capsule}', 'count', 1], cap: ['{capsule}', 'count', 1],
};

function unitOf(unit: string): [unit: string, dim: Dimension, factor: number] {
  const key = unit.trim().toLowerCase();
  return UNITS[key] ?? [key, 'other', 1];
}

// The quantity in `to`, or null when the value is not a number or the units measure different
// things (mg and mL).
export function quantity(q: { value: Num; unit: string }, to: string): Quantity | null {
  const value = canonicalNumber(q.value);
  if (value === null) return null;
  const [from, dim, factor] = unitOf(q.unit);
  const [target, toDim, toFactor] = unitOf(to);
  if (from === target) return { value, unit: target };
  if (dim !== toDim || dim === 'other' || dim === 'count') return null;
  return { value: (value * factor) / toFactor, unit: target };
}

export function sameQuantity(a: { value: Num; unit: string }, b: { value: Num; unit: string }): boolean {
  const y = canonicalNumber(b.value);
  const x = quantity(a, b.unit);
  return x !== null && y !== null && close(x.value, y);
}

// Within tolerance of the truth: rel is a fraction of the truth, abs an amount; either suffices.
export function within(value: number, truth: number, tolerance: { rel?: number; abs?: number }): boolean {
  const d = Math.abs(value - truth);
  return d <= (tolerance.abs ?? 0) + 1e-9 || d <= Math.abs(truth) * (tolerance.rel ?? 0) + 1e-9;
}

// Frequency codes and phrases -> doses per day.
const PER_DAY: Record<string, number> = {
  QD: 1, DAILY: 1, 'ONCE DAILY': 1, QAM: 1, QPM: 1, QHS: 1, HS: 1, AM: 1, BED: 1,
  BID: 2, 'TWICE DAILY': 2, Q12H: 2,
  TID: 3, 'THREE TIMES DAILY': 3, Q8H: 3,
  QID: 4, 'FOUR TIMES DAILY': 4, Q6H: 4,
  Q4H: 6, Q48H: 0.5, Q72H: 1 / 3, QWK: 1 / 7, WK: 1 / 7, 'ONCE WEEKLY': 1 / 7,
};
const PERIOD_DAYS: Record<string, number> = { s: 1 / 86_400, min: 1 / 1440, h: 1 / 24, d: 1, wk: 7, mo: 30, a: 365 };

// Doses per day from a frequency code ('BID', 'Q12H', 'BID_PRN'), a phrase ('2/day') or a
// Timing.repeat; null when the schedule is not periodic (a single dose).
export function dosesPerDay(f: string | TimingRepeat): number | null {
  if (typeof f === 'string') {
    const s = f.trim().toUpperCase().replace(/_PRN$/, '').replace(/\s+/g, ' ');
    const perDay = /^(\d+(?:\.\d+)?) ?(?:X ?)?\/ ?(?:DAY|D)$/.exec(s);
    if (perDay) return Number(perDay[1]);
    return PER_DAY[s] ?? null;
  }
  if (f.frequency === undefined || f.period === undefined || f.periodUnit === undefined) return null;
  const days = PERIOD_DAYS[f.periodUnit];
  if (days === undefined || f.period <= 0) return null;
  return f.frequency / (f.period * days);
}

// The clinic calendar date (America/New_York) of an instant, or a date as given.
export function clinicDate(instant: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(instant)) return instant;
  const ms = Date.parse(instant);
  if (Number.isNaN(ms)) throw new Error(`clinicDate: ${instant} is not an instant`);
  return eastern(ms).slice(0, 10);
}

// Total daily dose of a request in `unit` (default mg): each dosage instruction's dose times
// its doses per day, or times its timing events per clinic day. null when any part is missing
// or not convertible.
export function dailyDose(mr: Pick<MedicationRequest, 'dosageInstruction'>, unit = 'mg'): Quantity | null {
  let total = 0;
  const dosages = mr.dosageInstruction ?? [];
  if (dosages.length === 0) return null;
  for (const d of dosages) {
    const dose = d.doseAndRate?.[0]?.doseQuantity;
    if (dose?.value === undefined) return null;
    const q = quantity({ value: dose.value, unit: dose.code ?? dose.unit ?? '' }, unit);
    if (q === null) return null;
    const events = d.timing?.event;
    let perDay: number | null;
    if (events && events.length > 0) perDay = events.length / new Set(events.map(clinicDate)).size;
    else perDay = d.timing?.repeat ? dosesPerDay(d.timing.repeat) : d.timing?.code?.text ? dosesPerDay(d.timing.code.text) : null;
    if (perDay === null) return null;
    total += q.value * perDay;
  }
  return { value: Math.round(total * 1e9) / 1e9, unit: quantity({ value: 1, unit }, unit)!.unit };
}

// Brand and alias names -> the ingredient, lower case.
const ALIASES: Array<[RegExp, string]> = [
  [/\bmetoprolol (?:xl|er|succinate(?: er| xl)?)\b|\btoprol(?: xl)?\b/, 'metoprolol succinate'],
  [/\bmetoprolol tartrate\b|\blopressor\b/, 'metoprolol tartrate'],
  [/\beliquis\b/, 'apixaban'],
  [/\bxarelto\b/, 'rivaroxaban'],
  [/\bglucophage\b/, 'metformin'],
  [/\bneurontin\b/, 'gabapentin'],
  [/\blipitor\b/, 'atorvastatin'],
  [/\baldactone\b/, 'spironolactone'],
  [/\baugmentin\b|\bamoxicillin[ /-]+clavulanate\b/, 'amoxicillin / clavulanate'],
];
// Words in an RxNorm or EHR name that describe the form, not the drug.
const FORM_WORDS = /\b(?:\d+ hr|extended release|delayed release|sustained release|oral|tablet|tablets|capsule|capsules|tab|cap|solution|suspension|injection|xl|er|xr|sr|dr|hcl|hydrochloride)\b/g;
const RXNORM = 'http://www.nlm.nih.gov/research/umls/rxnorm';

export interface Drug {
  ingredient: string;
  strength_mg: number | null;
}

// The ingredient and unit strength a drug name or concept states: 'Eliquis 5 MG Oral Tablet' ->
// apixaban 5 mg. Reads the RxNorm coding's display, then any other display, then the text.
export function drugOf(c: CodeableConcept | string | undefined): Drug | null {
  const names = typeof c === 'string' ? [c] : [...(c?.coding ?? []).filter((x) => x.system === RXNORM).map((x) => x.display), ...(c?.coding ?? []).map((x) => x.display), c?.text];
  const name = names.find((n): n is string => typeof n === 'string' && n.trim() !== '');
  if (name === undefined) return null;
  let s = name.toLowerCase().replace(/\s+/g, ' ').trim();
  for (const [re, ingredient] of ALIASES) if (re.test(s)) s = s.replace(re, ingredient);
  const strength = /(\d+(?:\.\d+)?) ?(mg|mcg|ug|g)\b/.exec(s);
  const strength_mg = strength ? quantity({ value: strength[1]!, unit: strength[2]! }, 'mg')!.value : null;
  const head = strength ? s.slice(0, strength.index) : s;
  const ingredient = head.replace(FORM_WORDS, ' ').replace(/\s+/g, ' ').trim();
  return ingredient === '' ? null : { ingredient, strength_mg };
}

export interface DrugAccept {
  ingredient: string;
  // RxNorm codes accepted outright (the task's accept set: SCD, SBD and ingredient forms).
  rxcuis?: readonly string[];
  // Only this unit strength, when given.
  strength_mg?: number;
}

export function isDrug(c: CodeableConcept | undefined, accept: DrugAccept): boolean {
  if (accept.rxcuis && (c?.coding ?? []).some((x) => x.system === RXNORM && x.code !== undefined && accept.rxcuis!.includes(x.code))) return true;
  const d = drugOf(c);
  const want = drugOf(accept.ingredient);
  if (d === null || want === null || d.ingredient !== want.ingredient) return false;
  return accept.strength_mg === undefined || (d.strength_mg !== null && close(d.strength_mg, accept.strength_mg));
}

// Display text without case, punctuation or spacing.
export const displayKey = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Whether the concept is system|code: by a coding with that system and code; display text is
// compared only when the concept has no coding in that system.
export function conceptIs(c: CodeableConcept | undefined, want: Pick<Coding, 'system' | 'display'> & { code: string }): boolean {
  const codings = (c?.coding ?? []).filter((x) => x.system === want.system);
  if (codings.length > 0) return codings.some((x) => x.code === want.code);
  if (want.display === undefined) return false;
  const key = displayKey(want.display);
  return [c?.text, ...(c?.coding ?? []).map((x) => x.display)].some((t) => typeof t === 'string' && displayKey(t) === key);
}

// Only 'active' is active: stopped, cancelled, completed, entered-in-error, on-hold and draft
// all count as not active.
export const isActive = (r: object): boolean => (r as { status?: unknown }).status === 'active';
