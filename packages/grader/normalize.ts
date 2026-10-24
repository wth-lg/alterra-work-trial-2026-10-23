// Normalisation (design section 5): done once, here, so number formatting, unit spelling, code
// display text or the way a dose is written never changes a grade. Checks compare through
// these functions, never through strings:
//   - canonical numbers: '25' = '25.0' = '25.' = 25, and trailing punctuation ('42,') is not
//     part of the number;
//   - units: case-insensitive UCUM and the labels US EHRs show (mcg = ug, units = [iU]), mass
//     converted through mg and body weight through kg (lb = [lb_av]);
//   - frequency: BID = Q12H = 2/day, from a code, a phrase or a FHIR Timing.repeat;
//   - total daily dose: dose x doses per day, or the explicit timing events per clinic day;
//   - RxNorm: SCD, SBD and ingredient forms of one drug are the same drug (brand and alias
//     names map to the ingredient), optionally at one strength; a combination product is its
//     whole ingredient set, so amoxicillin alone is not amoxicillin / clavulanate;
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

// The number a value states, or null: '25.0' -> 25, '25.' -> 25, '42,' -> 42, '1,000' -> 1000,
// '25 mg' -> null. One trailing mark of punctuation (a sentence's period, comma, semicolon or
// colon) is not part of the number.
export function canonicalNumber(x: Num): number | null {
  if (typeof x === 'number') return Number.isFinite(x) ? x : null;
  const s = x.trim().replace(/(?<=\d)[.,;:]$/, '');
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
  QD: 1, DAILY: 1, 'ONCE DAILY': 1, 'ONCE A DAY': 1, QAM: 1, QPM: 1, QHS: 1, HS: 1, AM: 1, BED: 1, Q24H: 1,
  BID: 2, 'TWICE DAILY': 2, 'TWICE A DAY': 2, Q12H: 2,
  TID: 3, 'THREE TIMES DAILY': 3, 'THREE TIMES A DAY': 3, Q8H: 3,
  QID: 4, 'FOUR TIMES DAILY': 4, 'FOUR TIMES A DAY': 4, Q6H: 4,
  Q4H: 6, Q3H: 8, Q2H: 12, Q1H: 24, QH: 24,
  QOD: 0.5, 'EVERY OTHER DAY': 0.5, Q48H: 0.5, Q72H: 1 / 3, QWK: 1 / 7, WK: 1 / 7, 'ONCE WEEKLY': 1 / 7, 'ONCE A WEEK': 1 / 7,
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
    else if (d.timing?.repeat) perDay = dosesPerDay(d.timing.repeat);
    else perDay = timingCode(d.timing?.code);
    if (perDay === null) return null;
    total += q.value * perDay;
  }
  return { value: Math.round(total * 1e9) / 1e9, unit: quantity({ value: 1, unit }, unit)!.unit };
}

// Doses per day from a timing code: its first coding code that names a frequency, else its text.
function timingCode(c: CodeableConcept | undefined): number | null {
  for (const x of c?.coding ?? []) {
    const n = x.code === undefined ? null : dosesPerDay(x.code);
    if (n !== null) return n;
  }
  return c?.text ? dosesPerDay(c.text) : null;
}

// Brand and alias names -> the ingredient (or ingredients, joined by ' / '), lower case.
const ALIASES: Array<[RegExp, string]> = [
  [/\bmetoprolol (?:xl|er|succinate(?: er| xl)?)\b|\btoprol(?: xl)?\b/, 'metoprolol succinate'],
  [/\bmetoprolol tartrate\b|\blopressor\b/, 'metoprolol tartrate'],
  [/\beliquis\b/, 'apixaban'],
  [/\bxarelto\b/, 'rivaroxaban'],
  [/\bglucophage\b/, 'metformin'],
  [/\bneurontin\b/, 'gabapentin'],
  [/\blipitor\b/, 'atorvastatin'],
  [/\baldactone\b/, 'spironolactone'],
  [/\baugmentin\b|\bamoxicillin[ -]+clavulanate\b/, 'amoxicillin / clavulanate'],
  [/\bzestoretic\b|\bprinzide\b/, 'hydrochlorothiazide / lisinopril'],
  [/\bpercocet\b/, 'acetaminophen / oxycodone'],
  [/\bbactrim\b/, 'sulfamethoxazole / trimethoprim'],
];
// Words in an RxNorm or EHR name that describe the form, not the drug.
const FORM_WORDS = /\b(?:\d+ hr|extended release|delayed release|sustained release|oral|tablet|tablets|capsule|capsules|tab|cap|solution|suspension|injection|xl|er|xr|sr|dr|hcl|hydrochloride)\b/g;
// Salt words after an ingredient name ('clavulanate potassium', 'hydrocodone bitartrate'); the
// first word of a name is never one ('potassium chloride' stays).
const SALT_WORDS = /(?<=\S )(?:potassium|sodium|bitartrate|phosphate|sulfate|maleate|mesylate|besylate)\b/g;
// Separators between the ingredients of a combination name.
const COMBINATION = /\s+\/\s+|\s*\/\s*(?=[a-z])|\s+and\s+|\s*\+\s*/;
const RXNORM = 'http://www.nlm.nih.gov/research/umls/rxnorm';

export interface Ingredient {
  name: string;
  strength_mg: number | null;
}

export interface Drug {
  // The ingredient, or a combination's ingredients sorted and joined by ' / '.
  ingredient: string;
  // The unit strength of a single-ingredient drug; null for a combination (see ingredients).
  strength_mg: number | null;
  // Every ingredient with its strength, sorted by name.
  ingredients: Ingredient[];
}

function ingredientOf(part: string): Ingredient | null {
  const strength = /(\d+(?:\.\d+)?) ?(mg|mcg|ug|g)\b/.exec(part);
  const strength_mg = strength ? quantity({ value: strength[1]!, unit: strength[2]! }, 'mg')!.value : null;
  const head = strength ? part.slice(0, strength.index) : part;
  const name = head.replace(FORM_WORDS, ' ').replace(/\s+/g, ' ').trim().replace(SALT_WORDS, '').replace(/\s+/g, ' ').trim();
  return name === '' ? null : { name, strength_mg };
}

// The ingredients and unit strengths a drug name or concept states: 'Eliquis 5 MG Oral Tablet'
// -> apixaban 5 mg; 'Amoxicillin 875 MG / Clavulanate potassium 125 MG Oral Tablet' ->
// amoxicillin 875 mg + clavulanate 125 mg. Reads the RxNorm coding's display, then any other
// display, then the text. A pack ({...} Pack) is not one drug: null.
export function drugOf(c: CodeableConcept | string | undefined): Drug | null {
  const names = typeof c === 'string' ? [c] : [...(c?.coding ?? []).filter((x) => x.system === RXNORM).map((x) => x.display), ...(c?.coding ?? []).map((x) => x.display), c?.text];
  const name = names.find((n): n is string => typeof n === 'string' && n.trim() !== '');
  if (name === undefined) return null;
  // A branded name repeats its ingredients before the brand in brackets: the brand adds nothing.
  let s = name.toLowerCase().replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
  if (s.startsWith('{')) return null;
  for (const [re, ingredient] of ALIASES) if (re.test(s)) s = s.replace(re, ingredient);
  const parts = s.split(COMBINATION).map(ingredientOf);
  if (parts.length === 0 || parts.some((p) => p === null)) return null;
  const ingredients = (parts as Ingredient[]).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (new Set(ingredients.map((i) => i.name)).size !== ingredients.length) return null;
  return { ingredient: ingredients.map((i) => i.name).join(' / '), strength_mg: ingredients.length === 1 ? ingredients[0]!.strength_mg : null, ingredients };
}

export interface DrugAccept {
  // An ingredient, an ingredient set ('amoxicillin / clavulanate', 'amoxicillin-clavulanate') or
  // a brand; strengths written in it ('amoxicillin 875 MG / clavulanate 125 MG') must match too.
  ingredient: string;
  // RxNorm codes accepted outright (the task's accept set: SCD, SBD and ingredient forms).
  rxcuis?: readonly string[];
  // Only this unit strength of a single-ingredient drug, when given.
  strength_mg?: number;
}

// Whether the concept is the accepted drug: the same ingredient set (a combination matches only
// its whole set), and each strength the accepted name or strength_mg states.
export function isDrug(c: CodeableConcept | undefined, accept: DrugAccept): boolean {
  if (accept.rxcuis && (c?.coding ?? []).some((x) => x.system === RXNORM && x.code !== undefined && accept.rxcuis!.includes(x.code))) return true;
  const d = drugOf(c);
  const want = drugOf(accept.ingredient);
  if (d === null || want === null || d.ingredient !== want.ingredient) return false;
  const strengths = d.ingredients.every((x, i) => {
    const w = want.ingredients[i]!.strength_mg;
    return w === null || (x.strength_mg !== null && close(x.strength_mg, w));
  });
  if (!strengths) return false;
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
