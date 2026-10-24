// order_medication and change_medication (design section 3): MedicationRequests built from
// typed arguments, written the way a US EHR shows them. Doses are UCUM quantities displayed as
// US units (mcg, units, mEq), routes SNOMED CT, frequencies a fixed enum coded in HL7 v3
// GTSAbbreviation where it has a code, PRN orders carry their indication, and every new order
// has a category and a dispense derived from the sig. Nothing here judges whether a dose is
// clinically right (design section 2: business rules never encode clinical correctness); the one
// product rule is that a dose must be made of whole tablets or capsules of the product ordered
// (or half tablets of an immediate-release tablet), so the chart never reads "Apixaban 2.5 MG
// Oral Tablet, 3 mg" or a split extended-release tablet.
import type { CodeableConcept, Dosage, MedicationRequest, MedicationRequestDispenseRequest, Provenance, TimingRepeat } from '@medplum/fhirtypes';
import { ToolError } from '../errors.ts';
import type { PropertySchema } from '../registry.ts';
import type { CatalogEntry } from '../read/context.ts';
import { patient as patientSchema } from '../read/schema.ts';
import { catalogEntry, key, resolve, samePatient, when } from './checks.ts';
import { commit } from './commit.ts';
import { USER, type WriteContext } from './context.ts';
import { dateTime, idOf, text } from './schema.ts';
import { writeTool } from './tool.ts';

const UCUM = 'http://unitsofmeasure.org';
const SNOMED = 'http://snomed.info/sct';
const GTS = 'http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation';
const FREQUENCY_SYSTEM = 'urn:riverbend:frequency';
const CATEGORY_SYSTEM = 'http://terminology.hl7.org/CodeSystem/medicationrequest-category';
const CATEGORIES: Record<string, string> = { community: 'Community', discharge: 'Discharge' };

// UCUM codes, and the label US EHRs show for each: Quantity.unit, and the sig word for one and
// for several (ISMP lists "ug" as error-prone; "[iU]" reads "units").
export const DOSE_UNITS = ['mg', 'g', 'ug', 'mL', '[iU]', 'meq', '{tablet}', '{capsule}', '{puff}', '{drop}', '{patch}', '{spray}', '{application}'] as const;
const UNITS: Record<string, [label: string, one: string, many: string]> = {
  mg: ['mg', 'mg', 'mg'],
  g: ['g', 'g', 'g'],
  ug: ['mcg', 'mcg', 'mcg'],
  mL: ['mL', 'mL', 'mL'],
  '[iU]': ['units', 'unit', 'units'],
  meq: ['mEq', 'mEq', 'mEq'],
  '{tablet}': ['tablet', 'tablet', 'tablets'],
  '{capsule}': ['capsule', 'capsule', 'capsules'],
  '{puff}': ['puff', 'puff', 'puffs'],
  '{drop}': ['drop', 'drop', 'drops'],
  '{patch}': ['patch', 'patch', 'patches'],
  '{spray}': ['spray', 'spray', 'sprays'],
  '{application}': ['application', 'application', 'applications'],
  '{package}': ['package', 'package', 'packages'],
};
const amount = (value: number, unit: string) => `${value} ${UNITS[unit]![value > 1 ? 2 : 1]}`;
const quantity = (value: number, unit: string) => ({ value, unit: UNITS[unit]![0], system: UCUM, code: unit });

// Route enum -> SNOMED CT code, display, and the words a sig uses.
const ROUTES: Record<string, [code: string, display: string, sig: string]> = {
  oral: ['26643006', 'Oral route', 'by mouth'],
  intravenous: ['47625008', 'Intravenous route', 'IV'],
  intramuscular: ['78421000', 'Intramuscular route', 'IM'],
  subcutaneous: ['34206005', 'Subcutaneous route', 'subcutaneously'],
  sublingual: ['37839007', 'Sublingual route', 'sublingually'],
  topical: ['6064005', 'Topical route', 'topically'],
  transdermal: ['45890007', 'Transdermal route', 'transdermally'],
  inhaled: ['447694001', 'Respiratory tract route', 'by inhalation'],
  nasal: ['46713006', 'Nasal route', 'nasally'],
  ophthalmic: ['54485002', 'Ophthalmic route', 'in the eye'],
  rectal: ['37161004', 'Rectal route', 'rectally'],
};

// gts: the v3 GTSAbbreviation code (FHIR R4 timing-abbreviation) where one exists; the other
// schedules are coded in the environment's own system.
type Frequency = { display: string; repeat: TimingRepeat; gts?: string; prn?: true };
const FREQUENCIES: Record<string, Frequency> = {
  ONCE: { display: 'once', repeat: { count: 1 } },
  QD: { display: 'once daily', repeat: { frequency: 1, period: 1, periodUnit: 'd' }, gts: 'QD' },
  BID: { display: 'twice daily', repeat: { frequency: 2, period: 1, periodUnit: 'd' }, gts: 'BID' },
  TID: { display: 'three times daily', repeat: { frequency: 3, period: 1, periodUnit: 'd' }, gts: 'TID' },
  QID: { display: 'four times daily', repeat: { frequency: 4, period: 1, periodUnit: 'd' }, gts: 'QID' },
  QAM: { display: 'every morning', repeat: { frequency: 1, period: 1, periodUnit: 'd', when: ['MORN'] }, gts: 'AM' },
  QHS: { display: 'at bedtime', repeat: { frequency: 1, period: 1, periodUnit: 'd', when: ['HS'] }, gts: 'BED' },
  Q4H: { display: 'every 4 hours', repeat: { frequency: 1, period: 4, periodUnit: 'h' }, gts: 'Q4H' },
  Q6H: { display: 'every 6 hours', repeat: { frequency: 1, period: 6, periodUnit: 'h' }, gts: 'Q6H' },
  Q8H: { display: 'every 8 hours', repeat: { frequency: 1, period: 8, periodUnit: 'h' }, gts: 'Q8H' },
  Q12H: { display: 'every 12 hours', repeat: { frequency: 1, period: 12, periodUnit: 'h' } },
  Q48H: { display: 'every 48 hours', repeat: { frequency: 1, period: 48, periodUnit: 'h' } },
  Q72H: { display: 'every 72 hours', repeat: { frequency: 1, period: 72, periodUnit: 'h' } },
  QWK: { display: 'once weekly', repeat: { frequency: 1, period: 1, periodUnit: 'wk' }, gts: 'WK' },
  QD_PRN: { display: 'once daily', repeat: { frequency: 1, period: 1, periodUnit: 'd' }, gts: 'QD', prn: true },
  BID_PRN: { display: 'twice daily', repeat: { frequency: 2, period: 1, periodUnit: 'd' }, gts: 'BID', prn: true },
  TID_PRN: { display: 'three times daily', repeat: { frequency: 3, period: 1, periodUnit: 'd' }, gts: 'TID', prn: true },
  QHS_PRN: { display: 'at bedtime', repeat: { frequency: 1, period: 1, periodUnit: 'd', when: ['HS'] }, gts: 'BED', prn: true },
  Q4H_PRN: { display: 'every 4 hours', repeat: { frequency: 1, period: 4, periodUnit: 'h' }, gts: 'Q4H', prn: true },
  Q6H_PRN: { display: 'every 6 hours', repeat: { frequency: 1, period: 6, periodUnit: 'h' }, gts: 'Q6H', prn: true },
  Q8H_PRN: { display: 'every 8 hours', repeat: { frequency: 1, period: 8, periodUnit: 'h' }, gts: 'Q8H', prn: true },
};
const PERIOD_DAYS: Record<string, number> = { h: 1 / 24, d: 1, wk: 7 };

const doseValue: PropertySchema = { type: 'number', description: 'Dose amount, e.g. 500', exclusiveMinimum: 0, maximum: 100_000 };
const doseUnit: PropertySchema = {
  type: 'string',
  description: 'Dose unit (UCUM): mg, g, ug (micrograms, shown as mcg), mL, [iU] (units), meq (mEq), or a count: {tablet}, {capsule}, {puff}, {drop}, {patch}, {spray}, {application}',
  enum: DOSE_UNITS,
};
const frequency: PropertySchema = { type: 'string', description: 'Frequency code; the _PRN codes are as needed and need as_needed_reason', enum: Object.keys(FREQUENCIES) };
const asNeeded = text("The indication of a PRN order, e.g. 'pain' or 'nausea'; required with a _PRN frequency, not allowed otherwise", 200);
const route: PropertySchema = { type: 'string', description: 'Route of administration', enum: Object.keys(ROUTES) };
const reason = text('Reason for the order or change', 500);
const mrId = idOf('MedicationRequest', 'mr-00001', 'Medication request');

// ---- the product rule ----

// A single-ingredient tablet or capsule read from its RxNorm name, e.g. "apixaban 2.5 MG Oral
// Tablet" or "24 HR metoprolol succinate 50 MG Extended Release Oral Tablet". Anything else
// (an ingredient, a solution, a combination, an inhaler) has no unit strength to check.
interface Product {
  display: string;
  strength: number;
  unit: 'mg' | 'meq';
  form: 'tablet' | 'capsule';
  modified: boolean;
}
const MASS_MG: Record<string, number> = { g: 1000, mg: 1, ug: 0.001 };
const STRENGTH_MG: Record<string, number> = { G: 1000, MG: 1, MCG: 0.001, MEQ: 1 };
const MODIFIED_RELEASE = /\b(\d+ HR|Extended Release|Delayed Release|Sustained Release|Controlled Release|Disintegrating|ER|XR|SR|DR|CR|XL)\b/i;

function productOf(display: string | undefined): Product | undefined {
  if (display === undefined || /[/{}]|\b(Pack|Kit)\b/i.test(display)) return undefined;
  const strengths = [...display.matchAll(/\b(\d+(?:\.\d+)?) (MG|MCG|MEQ|G)\b/gi)];
  const form = /\b(Tablet|Capsule)\b/i.exec(display);
  if (strengths.length !== 1 || !form) return undefined;
  const [, n, u] = strengths[0]!;
  const unit = u!.toUpperCase();
  return { display, strength: Number(n) * STRENGTH_MG[unit]!, unit: unit === 'MEQ' ? 'meq' : 'mg', form: form[1]!.toLowerCase() as Product['form'], modified: MODIFIED_RELEASE.test(display) };
}

// How many tablets or capsules of `p` make one dose of value/unit. Throws, naming `field` (the
// product parameter), when the dose cannot be made of them.
function unitsPerDose(p: Product, value: number, unit: string, field: string): number {
  const label = UNITS[unit]![0];
  const strength = `${p.strength} ${p.unit === 'meq' ? 'mEq' : 'mg'}`;
  let k: number | undefined;
  if (unit === `{${p.form}}`) k = value;
  else if (p.unit === 'mg' && unit in MASS_MG) k = (value * MASS_MG[unit]!) / p.strength;
  else if (p.unit === 'meq' && unit === 'meq') k = value / p.strength;
  if (k === undefined) throw new ToolError('INVALID_INPUT', `dose unit ${label} does not fit ${p.display}; give ${field} for the product, or the dose in ${p.unit === 'meq' ? 'mEq' : 'mg'} or ${p.form}s`, field);
  const splittable = p.form === 'tablet' && !p.modified;
  const step = splittable ? 0.5 : 1;
  const n = Math.round(k / step) * step;
  if (n >= step && Math.abs(k - n) <= 1e-6 * Math.max(1, k)) return n;
  const why = p.form === 'capsule' ? ' (a capsule cannot be split)' : p.modified && k % 1 !== 0 ? ' (an extended-release or delayed-release tablet must not be split)' : '';
  const multiple = splittable ? `a multiple of half a tablet (${p.strength / 2} ${p.unit === 'meq' ? 'mEq' : 'mg'})` : `a whole multiple of ${strength}`;
  throw new ToolError('INVALID_INPUT', `dose ${value} ${label} does not match ${p.display}${why}; give ${field} for the new strength, or a dose that is ${multiple}`, field);
}

// ---- the sig ----

const pad = (n: number) => String(n).padStart(2, '0');

// US Eastern wall-clock time of an instant, as a sig prints it ("8:00 PM on 10/25/2026"): EDT
// from the second Sunday of March 02:00 to the first Sunday of November 02:00, else EST.
function wallClock(fhir: string): string {
  const ms = Date.parse(fhir);
  const y = new Date(ms).getUTCFullYear();
  const sunday = (month: number, nth: number) => 1 + ((7 - new Date(Date.UTC(y, month, 1)).getUTCDay()) % 7) + 7 * (nth - 1);
  const edt = ms >= Date.UTC(y, 2, sunday(2, 2), 7) && ms < Date.UTC(y, 10, sunday(10, 1), 6);
  const t = new Date(ms + (edt ? -4 : -5) * 3_600_000);
  const h = t.getUTCHours();
  return `${h % 12 || 12}:${pad(t.getUTCMinutes())} ${h < 12 ? 'AM' : 'PM'} on ${pad(t.getUTCMonth() + 1)}/${pad(t.getUTCDate())}/${t.getUTCFullYear()}`;
}

const routeConcept = (r: string): CodeableConcept => {
  const [code, display] = ROUTES[r]!;
  return { coding: [{ system: SNOMED, code, display }], text: r };
};
const routeWords = (r: CodeableConcept) => ROUTES[r.text ?? '']?.[2] ?? r.text ?? r.coding?.[0]?.display?.replace(/ route$/i, '').toLowerCase();

type Schedule = { frequency: string; asNeeded?: string } | { events: string[] };
interface Dose {
  value: number;
  unit: string;
  route?: CodeableConcept;
  schedule: Schedule;
  // The product's tablets or capsules per dose, when the product has a unit strength.
  units?: { n: number; form: Product['form'] };
}

function dosage(d: Dose): Dosage {
  const freq = 'frequency' in d.schedule ? FREQUENCIES[d.schedule.frequency]! : undefined;
  const asNeeded = 'frequency' in d.schedule ? d.schedule.asNeeded : undefined;
  const count = d.units && !d.unit.startsWith('{') && d.units.n !== 1 ? ` (${amount(d.units.n, `{${d.units.form}}`)})` : '';
  const when = freq ? freq.display : `at ${(d.schedule as { events: string[] }).events.map(wallClock).join(', ')}`;
  return {
    text: [`${amount(d.value, d.unit)}${count}`, d.route && routeWords(d.route), when, asNeeded !== undefined ? `as needed for ${asNeeded}` : undefined].filter((x) => x).join(' '),
    timing: freq
      ? {
          code: {
            coding: [freq.gts ? { system: GTS, code: freq.gts } : { system: FREQUENCY_SYSTEM, code: (d.schedule as { frequency: string }).frequency }],
            text: freq.prn ? `${freq.display} as needed` : freq.display,
          },
          repeat: structuredClone(freq.repeat),
        }
      : { event: (d.schedule as { events: string[] }).events },
    ...(asNeeded !== undefined ? { asNeededCodeableConcept: { text: asNeeded } } : {}),
    ...(d.route ? { route: d.route } : {}),
    doseAndRate: [{ doseQuantity: quantity(d.value, d.unit) }],
  };
}

// A PRN frequency needs its indication, and only a PRN frequency takes one.
function checkAsNeeded(frequencyCode: string | undefined, reasonText: string | undefined, field: string): void {
  const prn = frequencyCode !== undefined && FREQUENCIES[frequencyCode]!.prn === true;
  if (prn && reasonText === undefined) {
    throw new ToolError('INVALID_INPUT', `'${field}' is required with ${frequencyCode}: a PRN order must state its indication (e.g. 'pain', 'nausea')`, field);
  }
  if (!prn && reasonText !== undefined) throw new ToolError('INVALID_INPUT', `'${field}' is only for a _PRN frequency`, field);
}

// The dispense for a sig: the supply in days (default 30; one day for ONCE; the days the events
// span), the refills (default 0), and the quantity of tablets, capsules, patches or mL the
// supply takes, when the dose is counted in one of those; `override` replaces the quantity.
function dispense(d: Dose, supplyDays: number | undefined, refills: number | undefined, override: number | undefined): MedicationRequestDispenseRequest {
  const perDose = d.units ? { n: d.units.n, unit: `{${d.units.form}}` } : ['{tablet}', '{capsule}', '{patch}', 'mL'].includes(d.unit) ? { n: d.value, unit: d.unit } : undefined;
  let doses: number;
  let days: number;
  if ('events' in d.schedule) {
    const ms = d.schedule.events.map((e) => Date.parse(e));
    doses = ms.length;
    days = supplyDays ?? Math.floor((Math.max(...ms) - Math.min(...ms)) / 86_400_000) + 1;
  } else if (d.schedule.frequency === 'ONCE') {
    doses = 1;
    days = supplyDays ?? 1;
  } else {
    const { frequency: f, period, periodUnit } = FREQUENCIES[d.schedule.frequency]!.repeat;
    days = supplyDays ?? 30;
    doses = (f! / (period! * PERIOD_DAYS[periodUnit!]!)) * days;
  }
  const unit = perDose?.unit ?? '{package}';
  const value = override ?? (perDose ? Math.ceil(doses * perDose.n - 1e-9) : undefined);
  return {
    ...(value !== undefined ? { quantity: quantity(value, unit) } : {}),
    numberOfRepeatsAllowed: refills ?? 0,
    expectedSupplyDuration: { value: days, unit: 'days', system: UCUM, code: 'd' },
  };
}

const category = (code: string): CodeableConcept[] => [{ coding: [{ system: CATEGORY_SYSTEM, code, display: CATEGORIES[code]! }], text: CATEGORIES[code]! }];
const concept = (e: CatalogEntry): CodeableConcept => ({ coding: [{ system: e.system, code: e.code, display: e.display }], text: e.display });
const nameOf = (mr: Readonly<MedicationRequest>) => mr.medicationCodeableConcept?.coding?.[0]?.display ?? mr.medicationCodeableConcept?.text;

// The tablets or capsules per dose when the product has a unit strength (throws if the dose
// cannot be made of them).
const unitsFor = (display: string | undefined, value: number, unit: string, field: string): Dose['units'] => {
  const p = productOf(display);
  return p ? { n: unitsPerDose(p, value, unit, field), form: p.form } : undefined;
};

type OrderInput = {
  patient: string;
  rxnorm_code: string;
  dose_value: number;
  dose_unit: string;
  route: string;
  frequency?: string;
  timing_events?: string[];
  as_needed_reason?: string;
  supply_days?: number;
  refills?: number;
  dispense_quantity?: number;
  category?: 'community' | 'discharge';
  reason: string;
  replaces?: string;
};

export const orderMedication = writeTool({
  name: 'order_medication',
  description:
    'Order a new medication (a MedicationRequest, status active) for a patient. rxnorm_code must come from lookup_catalog (kind medication). ' +
    'Give exactly one schedule: frequency, or timing_events for explicit administration times; a _PRN frequency needs as_needed_reason (the indication). ' +
    'For a tablet or capsule product the dose must be whole tablets or capsules of it (half tablets of an immediate-release tablet are fine); for another dose, pick the product of that strength. ' +
    'category is community (default) or discharge. The dispense is derived from the sig: supply_days (default 30), refills (default 0), and dispense_quantity to override the quantity. ' +
    'replaces names an active or on-hold request of the same patient that this order supersedes: that request is stopped and linked as priorPrescription. ' +
    'Returns {medication_request, status}.',
  inputSchema: {
    type: 'object',
    properties: {
      patient: patientSchema,
      rxnorm_code: { type: 'string', description: 'RxNorm code from lookup_catalog, e.g. 860975', pattern: '^[0-9]{1,12}$' },
      dose_value: doseValue,
      dose_unit: doseUnit,
      route,
      frequency,
      timing_events: { type: 'array', description: 'Explicit administration times, in place of frequency', items: dateTime('Administration time'), minItems: 1, maxItems: 24 },
      as_needed_reason: asNeeded,
      supply_days: { type: 'integer', description: 'Days of supply to dispense', minimum: 1, maximum: 365 },
      refills: { type: 'integer', description: 'Refills allowed', minimum: 0, maximum: 12 },
      dispense_quantity: { type: 'number', description: 'Quantity to dispense, in tablets, capsules, patches or mL; overrides the quantity derived from the sig', exclusiveMinimum: 0, maximum: 10_000 },
      category: { type: 'string', description: 'Order category', enum: Object.keys(CATEGORIES) },
      reason,
      replaces: idOf('MedicationRequest', 'mr-00001', 'The request this order supersedes'),
    },
    required: ['patient', 'rxnorm_code', 'dose_value', 'dose_unit', 'route', 'reason'],
    additionalProperties: false,
  },
  run(input: OrderInput, ctx) {
    if (input.frequency !== undefined && input.timing_events !== undefined) throw new ToolError('INVALID_INPUT', "give either 'frequency' or 'timing_events', not both", 'timing_events');
    if (input.frequency === undefined && input.timing_events === undefined) throw new ToolError('INVALID_INPUT', "'frequency' is required unless 'timing_events' is given", 'frequency');
    checkAsNeeded(input.frequency, input.as_needed_reason, 'as_needed_reason');
    const patient = resolve(ctx, 'patient', input.patient, ['Patient']).id!;
    const drug = catalogEntry(ctx, 'rxnorm_code', input.rxnorm_code, ['medication']);
    const units = unitsFor(drug.display, input.dose_value, input.dose_unit, 'rxnorm_code');
    const events = input.timing_events?.map((t, i) => when(`timing_events[${i}]`, t, { dateTime: true }).fhir);
    let replaced: Readonly<MedicationRequest> | undefined;
    if (input.replaces !== undefined) {
      replaced = resolve(ctx, 'replaces', input.replaces, ['MedicationRequest']) as Readonly<MedicationRequest>;
      samePatient('replaces', replaced, patient);
      if (replaced.status !== 'active' && replaced.status !== 'on-hold') {
        throw new ToolError('CONFLICT', `'replaces': ${key(replaced)} is ${replaced.status}; only an active or on-hold request can be replaced`, 'replaces');
      }
    }
    const dose: Dose = {
      value: input.dose_value,
      unit: input.dose_unit,
      route: routeConcept(input.route),
      schedule: events ? { events } : { frequency: input.frequency!, ...(input.as_needed_reason !== undefined ? { asNeeded: input.as_needed_reason } : {}) },
      ...(units ? { units } : {}),
    };
    return commit(ctx, 'order_medication', (a) => {
      const id = a.id('mr');
      const order: MedicationRequest = {
        resourceType: 'MedicationRequest',
        id,
        status: 'active',
        intent: 'order',
        category: category(input.category ?? 'community'),
        medicationCodeableConcept: concept(drug),
        subject: { reference: `Patient/${patient}` },
        authoredOn: a.stamp,
        requester: { reference: USER },
        reasonCode: [{ text: input.reason }],
        dosageInstruction: [dosage(dose)],
        dispenseRequest: dispense(dose, input.supply_days, input.refills, input.dispense_quantity),
        ...(replaced ? { priorPrescription: { reference: key(replaced) } } : {}),
      };
      return {
        content: { medication_request: `MedicationRequest/${id}`, status: 'active' },
        resources: [
          { resource: order, created: true, fields: { reason: ['MedicationRequest.reasonCode'], as_needed_reason: ['MedicationRequest.dosageInstruction[0].asNeededCodeableConcept'] } },
          ...(replaced
            ? [{ resource: { ...replaced, status: 'stopped' as const, statusReason: { text: `replaced by MedicationRequest/${id}` } }, created: false }]
            : []),
        ],
      };
    });
  },
});

const ACTIONS = ['stop', 'hold', 'resume', 'modify', 'complete', 'cancel', 'entered-in-error'] as const;
type Action = (typeof ACTIONS)[number];
// The statuses each action may start from, and the status it leaves the request in (FHIR R4
// medicationrequest-status). cancel and entered-in-error have a further condition (below).
const TRANSITIONS: Record<Action, { from: readonly string[]; to: MedicationRequest['status'] }> = {
  stop: { from: ['active', 'on-hold'], to: 'stopped' },
  hold: { from: ['active'], to: 'on-hold' },
  resume: { from: ['on-hold'], to: 'active' },
  modify: { from: ['active', 'on-hold'], to: 'stopped' },
  complete: { from: ['active', 'on-hold'], to: 'completed' },
  cancel: { from: ['draft', 'active', 'on-hold'], to: 'cancelled' },
  'entered-in-error': { from: ['draft', 'active', 'on-hold', 'stopped', 'completed', 'cancelled'], to: 'entered-in-error' },
};

// Whether this episode created the request: it has a created id, and the Provenance of the
// same write names it. The world has no dispenses, so such an order has not been dispensed.
function orderedHere(ctx: WriteContext, mr: Readonly<MedicationRequest>): boolean {
  const seq = /^mr-(t\d{4,})$/.exec(mr.id ?? '')?.[1];
  return seq !== undefined && ctx.world.get<Provenance>('Provenance', `prov-${seq}`)?.target.some((t) => t.reference === key(mr)) === true;
}

type ChangeInput = {
  medication_request: string;
  action: Action;
  reason: string;
  new_dose?: { value: number; unit: string; frequency: string; as_needed_reason?: string };
  medication_code?: string;
  route?: string;
};

export const changeMedication = writeTool({
  name: 'change_medication',
  description:
    'Change an existing MedicationRequest: stop or hold (active; stop also on-hold), resume (on-hold), complete (active or on-hold), ' +
    'cancel (a draft, or an order placed in this episode: nothing has been dispensed), entered-in-error (an order placed in this episode), or modify. ' +
    'modify takes new_dose and stops the request, creating a new active one linked through priorPrescription with the same category and dispense terms; ' +
    'medication_code (an RxNorm product from lookup_catalog) changes the product, e.g. to the tablet of the new strength, and route sets the route (else it is kept). ' +
    'Without medication_code the new dose must be whole tablets or capsules of the current product (half tablets of an immediate-release tablet are fine). ' +
    'An illegal transition returns CONFLICT. Returns {medication_request, status, new_medication_request?}.',
  inputSchema: {
    type: 'object',
    properties: {
      medication_request: mrId,
      action: { type: 'string', description: 'What to do', enum: ACTIONS },
      reason,
      new_dose: {
        type: 'object',
        description: 'The new dose and schedule; required for modify, not allowed otherwise',
        properties: { value: doseValue, unit: doseUnit, frequency, as_needed_reason: asNeeded },
        required: ['value', 'unit', 'frequency'],
        additionalProperties: false,
      },
      medication_code: { type: 'string', description: 'modify only: the RxNorm product from lookup_catalog for the new request, e.g. 1364445', pattern: '^[0-9]{1,12}$' },
      route: { ...route, description: 'modify only: route of the new request (default: the current route)' },
    },
    required: ['medication_request', 'action', 'reason'],
    additionalProperties: false,
  },
  run(input: ChangeInput, ctx) {
    const old = resolve(ctx, 'medication_request', input.medication_request, ['MedicationRequest']) as Readonly<MedicationRequest>;
    const modify = input.action === 'modify';
    if (modify && input.new_dose === undefined) throw new ToolError('INVALID_INPUT', "'new_dose' is required for modify", 'new_dose');
    for (const field of ['new_dose', 'medication_code', 'route'] as const) {
      if (!modify && input[field] !== undefined) throw new ToolError('INVALID_INPUT', `'${field}' is only for modify, not ${input.action}`, field);
    }
    const { from, to } = TRANSITIONS[input.action];
    if (!from.includes(old.status)) {
      throw new ToolError('CONFLICT', `cannot ${input.action} ${key(old)}: it is ${old.status} (${input.action} applies to ${from.join(' or ')})`, 'action');
    }
    if ((input.action === 'cancel' && old.status !== 'draft') || input.action === 'entered-in-error') {
      if (!orderedHere(ctx, old)) {
        const only = input.action === 'cancel' ? 'a draft or an order placed in this episode' : 'an order placed in this episode';
        throw new ToolError('CONFLICT', `cannot ${input.action} ${key(old)}: it was not placed in this episode and may have been dispensed (${input.action} applies to ${only}; stop it instead)`, 'action');
      }
    }
    const product = input.medication_code === undefined ? undefined : catalogEntry(ctx, 'medication_code', input.medication_code, ['medication']);
    let next: Dose | undefined;
    if (input.new_dose) {
      const d = input.new_dose;
      checkAsNeeded(d.frequency, d.as_needed_reason, 'new_dose.as_needed_reason');
      const r = input.route !== undefined ? routeConcept(input.route) : old.dosageInstruction?.[0]?.route;
      const units = unitsFor(product?.display ?? nameOf(old), d.value, d.unit, 'medication_code');
      next = {
        value: d.value,
        unit: d.unit,
        ...(r ? { route: r } : {}),
        schedule: { frequency: d.frequency, ...(d.as_needed_reason !== undefined ? { asNeeded: d.as_needed_reason } : {}) },
        ...(units ? { units } : {}),
      };
    }
    return commit(ctx, 'change_medication', (a) => {
      // stop, hold, cancel, entered-in-error and modify record why in statusReason; resume and
      // complete clear it and keep the reason as a note.
      const { statusReason: _cleared, ...rest } = old;
      const clears = input.action === 'resume' || input.action === 'complete';
      const notes = old.note ?? [];
      const changed: MedicationRequest = clears
        ? { ...rest, status: to, note: [...notes, { text: `${input.action === 'resume' ? 'Resumed' : 'Completed'}: ${input.reason}`, time: a.stamp, authorReference: { reference: USER } }] }
        : { ...old, status: to, statusReason: { text: input.reason } };
      const resources = [{ resource: changed, created: false, fields: { reason: [clears ? `MedicationRequest.note[${notes.length}]` : 'MedicationRequest.statusReason'] } }];
      if (!next) return { content: { medication_request: key(old), status: to }, resources };
      const id = a.id('mr');
      const kept = old.dispenseRequest;
      const supply = kept?.expectedSupplyDuration?.code === 'd' ? kept.expectedSupplyDuration.value : undefined;
      const order: MedicationRequest = {
        resourceType: 'MedicationRequest',
        id,
        status: 'active',
        intent: 'order',
        category: old.category ?? category('community'),
        ...(product ? { medicationCodeableConcept: concept(product) } : {}),
        ...(!product && old.medicationCodeableConcept ? { medicationCodeableConcept: old.medicationCodeableConcept } : {}),
        ...(!product && old.medicationReference ? { medicationReference: old.medicationReference } : {}),
        subject: old.subject,
        authoredOn: a.stamp,
        requester: { reference: USER },
        reasonCode: [{ text: input.reason }],
        dosageInstruction: [dosage(next)],
        dispenseRequest: dispense(next, supply, kept?.numberOfRepeatsAllowed, undefined),
        priorPrescription: { reference: key(old) },
      };
      return {
        content: { medication_request: key(old), status: to, new_medication_request: `MedicationRequest/${id}` },
        resources: [
          ...resources,
          { resource: order, created: true, fields: { reason: ['MedicationRequest.reasonCode'], 'new_dose.as_needed_reason': ['MedicationRequest.dosageInstruction[0].asNeededCodeableConcept'] } },
        ],
      };
    });
  },
});
