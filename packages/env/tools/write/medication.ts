// order_medication and change_medication (design section 3): MedicationRequests built from
// typed arguments. Doses are UCUM quantities, routes SNOMED CT, frequencies a fixed enum;
// nothing here judges whether a dose is clinically right (design section 2: business rules
// never encode clinical correctness).
import type { CodeableConcept, Dosage, MedicationRequest, TimingRepeat } from '@medplum/fhirtypes';
import { ToolError } from '../errors.ts';
import type { PropertySchema } from '../registry.ts';
import { patient as patientSchema } from '../read/schema.ts';
import { catalogEntry, key, resolve, samePatient, when } from './checks.ts';
import { commit } from './commit.ts';
import { USER } from './context.ts';
import { dateTime, idOf, text } from './schema.ts';
import { writeTool } from './tool.ts';

const UCUM = 'http://unitsofmeasure.org';
const SNOMED = 'http://snomed.info/sct';
const FREQUENCY_SYSTEM = 'urn:riverbend:frequency';

// UCUM codes; the display drops the braces of an annotation unit.
export const DOSE_UNITS = ['mg', 'g', 'ug', 'mL', '[iU]', 'meq', '{tablet}', '{capsule}', '{puff}', '{drop}'] as const;
const unitDisplay = (u: string) => u.replace(/[{}]/g, '');

const ROUTES: Record<string, [code: string, display: string]> = {
  oral: ['26643006', 'Oral route'],
  intravenous: ['47625008', 'Intravenous route'],
  intramuscular: ['78421000', 'Intramuscular route'],
  subcutaneous: ['34206005', 'Subcutaneous route'],
  sublingual: ['37839007', 'Sublingual route'],
  topical: ['6064005', 'Topical route'],
  transdermal: ['45890007', 'Transdermal route'],
  inhaled: ['447694001', 'Respiratory tract route'],
  nasal: ['46713006', 'Nasal route'],
  ophthalmic: ['54485002', 'Ophthalmic route'],
  rectal: ['37161004', 'Rectal route'],
};

const FREQUENCIES: Record<string, { display: string; repeat: TimingRepeat; prn?: true }> = {
  ONCE: { display: 'once', repeat: { count: 1 } },
  QD: { display: 'once daily', repeat: { frequency: 1, period: 1, periodUnit: 'd' } },
  BID: { display: 'twice daily', repeat: { frequency: 2, period: 1, periodUnit: 'd' } },
  TID: { display: 'three times daily', repeat: { frequency: 3, period: 1, periodUnit: 'd' } },
  QID: { display: 'four times daily', repeat: { frequency: 4, period: 1, periodUnit: 'd' } },
  QAM: { display: 'every morning', repeat: { frequency: 1, period: 1, periodUnit: 'd', when: ['MORN'] } },
  QHS: { display: 'at bedtime', repeat: { frequency: 1, period: 1, periodUnit: 'd', when: ['HS'] } },
  Q4H: { display: 'every 4 hours', repeat: { frequency: 1, period: 4, periodUnit: 'h' } },
  Q6H: { display: 'every 6 hours', repeat: { frequency: 1, period: 6, periodUnit: 'h' } },
  Q8H: { display: 'every 8 hours', repeat: { frequency: 1, period: 8, periodUnit: 'h' } },
  Q12H: { display: 'every 12 hours', repeat: { frequency: 1, period: 12, periodUnit: 'h' } },
  QWK: { display: 'once weekly', repeat: { frequency: 1, period: 1, periodUnit: 'wk' } },
  QD_PRN: { display: 'once daily as needed', repeat: { frequency: 1, period: 1, periodUnit: 'd' }, prn: true },
  Q4H_PRN: { display: 'every 4 hours as needed', repeat: { frequency: 1, period: 4, periodUnit: 'h' }, prn: true },
  Q6H_PRN: { display: 'every 6 hours as needed', repeat: { frequency: 1, period: 6, periodUnit: 'h' }, prn: true },
};

const doseValue: PropertySchema = { type: 'number', description: 'Dose amount, e.g. 500', exclusiveMinimum: 0, maximum: 100_000 };
const doseUnit: PropertySchema = { type: 'string', description: 'Dose unit (UCUM): mg, g, ug (micrograms), mL, [iU], meq, or a count such as {tablet}', enum: DOSE_UNITS };
const frequency: PropertySchema = { type: 'string', description: 'Frequency code', enum: Object.keys(FREQUENCIES) };
const reason = text('Reason for the order or change', 500);
const mrId = idOf('MedicationRequest', 'mr-00001', 'Medication request');

// One dosage instruction: a schedule from the frequency enum or from explicit times.
function dosage(value: number, unit: string, route: CodeableConcept | undefined, schedule: { frequency: string } | { events: string[] }): Dosage {
  const freq = 'frequency' in schedule ? FREQUENCIES[schedule.frequency]! : undefined;
  const schedText = freq ? freq.display : `at ${'events' in schedule ? schedule.events.join(', ') : ''}`;
  return {
    text: [value, unitDisplay(unit), route?.text, schedText].filter((x) => x !== undefined).join(' '),
    timing: freq
      ? { code: { coding: [{ system: FREQUENCY_SYSTEM, code: (schedule as { frequency: string }).frequency }], text: freq.display }, repeat: structuredClone(freq.repeat) }
      : { event: (schedule as { events: string[] }).events },
    ...(freq?.prn ? { asNeededBoolean: true } : {}),
    ...(route ? { route } : {}),
    doseAndRate: [{ doseQuantity: { value, unit: unitDisplay(unit), system: UCUM, code: unit } }],
  };
}

const routeConcept = (route: string): CodeableConcept => {
  const [code, display] = ROUTES[route]!;
  return { coding: [{ system: SNOMED, code, display }], text: route };
};

type OrderInput = {
  patient: string;
  rxnorm_code: string;
  dose_value: number;
  dose_unit: string;
  route: string;
  frequency?: string;
  timing_events?: string[];
  supply_days?: number;
  refills?: number;
  reason: string;
  replaces?: string;
};

export const orderMedication = writeTool({
  name: 'order_medication',
  description:
    'Order a new medication (a MedicationRequest, status active) for a patient. rxnorm_code must come from lookup_catalog (kind medication). ' +
    'Give exactly one schedule: frequency, or timing_events for explicit administration times. ' +
    'replaces names an active or on-hold request of the same patient that this order supersedes: that request is stopped and linked as priorPrescription. ' +
    'Returns {medication_request, status}.',
  inputSchema: {
    type: 'object',
    properties: {
      patient: patientSchema,
      rxnorm_code: { type: 'string', description: 'RxNorm code from lookup_catalog, e.g. 860975', pattern: '^[0-9]{1,12}$' },
      dose_value: doseValue,
      dose_unit: doseUnit,
      route: { type: 'string', description: 'Route of administration', enum: Object.keys(ROUTES) },
      frequency,
      timing_events: { type: 'array', description: 'Explicit administration times, in place of frequency', items: dateTime('Administration time'), minItems: 1, maxItems: 24 },
      supply_days: { type: 'integer', description: 'Days of supply to dispense', minimum: 1, maximum: 365 },
      refills: { type: 'integer', description: 'Refills allowed', minimum: 0, maximum: 12 },
      reason,
      replaces: idOf('MedicationRequest', 'mr-00001', 'The request this order supersedes'),
    },
    required: ['patient', 'rxnorm_code', 'dose_value', 'dose_unit', 'route', 'reason'],
    additionalProperties: false,
  },
  run(input: OrderInput, ctx) {
    if (input.frequency !== undefined && input.timing_events !== undefined) throw new ToolError('INVALID_INPUT', "give either 'frequency' or 'timing_events', not both", 'timing_events');
    if (input.frequency === undefined && input.timing_events === undefined) throw new ToolError('INVALID_INPUT', "'frequency' is required unless 'timing_events' is given", 'frequency');
    const patient = resolve(ctx, 'patient', input.patient, ['Patient']).id!;
    const drug = catalogEntry(ctx, 'rxnorm_code', input.rxnorm_code, ['medication']);
    const events = input.timing_events?.map((t, i) => when(`timing_events[${i}]`, t, { dateTime: true }).fhir);
    let replaced: Readonly<MedicationRequest> | undefined;
    if (input.replaces !== undefined) {
      replaced = resolve(ctx, 'replaces', input.replaces, ['MedicationRequest']) as Readonly<MedicationRequest>;
      samePatient('replaces', replaced, patient);
      if (replaced.status !== 'active' && replaced.status !== 'on-hold') {
        throw new ToolError('CONFLICT', `'replaces': ${key(replaced)} is ${replaced.status}; only an active or on-hold request can be replaced`, 'replaces');
      }
    }
    return commit(ctx, 'order_medication', (a) => {
      const id = a.id('mr');
      const order: MedicationRequest = {
        resourceType: 'MedicationRequest',
        id,
        status: 'active',
        intent: 'order',
        medicationCodeableConcept: { coding: [{ system: drug.system, code: drug.code, display: drug.display }], text: drug.display },
        subject: { reference: `Patient/${patient}` },
        authoredOn: a.stamp,
        requester: { reference: USER },
        reasonCode: [{ text: input.reason }],
        dosageInstruction: [dosage(input.dose_value, input.dose_unit, routeConcept(input.route), events ? { events } : { frequency: input.frequency! })],
        ...(input.supply_days !== undefined || input.refills !== undefined
          ? {
              dispenseRequest: {
                ...(input.refills !== undefined ? { numberOfRepeatsAllowed: input.refills } : {}),
                ...(input.supply_days !== undefined ? { expectedSupplyDuration: { value: input.supply_days, unit: 'days', system: UCUM, code: 'd' } } : {}),
              },
            }
          : {}),
        ...(replaced ? { priorPrescription: { reference: key(replaced) } } : {}),
      };
      return {
        content: { medication_request: `MedicationRequest/${id}`, status: 'active' },
        resources: [
          { resource: order, created: true, fields: { reason: ['MedicationRequest.reasonCode'] } },
          ...(replaced
            ? [{ resource: { ...replaced, status: 'stopped' as const, statusReason: { text: `replaced by MedicationRequest/${id}` } }, created: false }]
            : []),
        ],
      };
    });
  },
});

const ACTIONS = ['stop', 'hold', 'resume', 'modify'] as const;
type Action = (typeof ACTIONS)[number];
// The statuses each action may start from, and the status it leaves the request in.
const TRANSITIONS: Record<Action, { from: readonly string[]; to: MedicationRequest['status'] }> = {
  stop: { from: ['active', 'on-hold'], to: 'stopped' },
  hold: { from: ['active'], to: 'on-hold' },
  resume: { from: ['on-hold'], to: 'active' },
  modify: { from: ['active', 'on-hold'], to: 'stopped' },
};

type ChangeInput = {
  medication_request: string;
  action: Action;
  reason: string;
  new_dose?: { value: number; unit: string; frequency: string };
};

export const changeMedication = writeTool({
  name: 'change_medication',
  description:
    'Stop, hold, resume or modify an existing MedicationRequest. stop and hold apply to an active request (stop also to an on-hold one), resume to an on-hold one. ' +
    'modify takes new_dose: it stops the request and creates a new active one with the same medication and route, linked through priorPrescription. ' +
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
        properties: { value: doseValue, unit: doseUnit, frequency },
        required: ['value', 'unit', 'frequency'],
        additionalProperties: false,
      },
    },
    required: ['medication_request', 'action', 'reason'],
    additionalProperties: false,
  },
  run(input: ChangeInput, ctx) {
    const old = resolve(ctx, 'medication_request', input.medication_request, ['MedicationRequest']) as Readonly<MedicationRequest>;
    if (input.action === 'modify' && input.new_dose === undefined) throw new ToolError('INVALID_INPUT', "'new_dose' is required for modify", 'new_dose');
    if (input.action !== 'modify' && input.new_dose !== undefined) throw new ToolError('INVALID_INPUT', `'new_dose' is only for modify, not ${input.action}`, 'new_dose');
    const { from, to } = TRANSITIONS[input.action];
    if (!from.includes(old.status)) {
      throw new ToolError('CONFLICT', `cannot ${input.action} ${key(old)}: it is ${old.status} (${input.action} applies to ${from.join(' or ')})`, 'action');
    }
    return commit(ctx, 'change_medication', (a) => {
      const changed: MedicationRequest = { ...old, status: to, statusReason: { text: input.reason } };
      const resources = [{ resource: changed, created: false, fields: { reason: ['MedicationRequest.statusReason'] } }];
      if (input.action !== 'modify') return { content: { medication_request: key(old), status: to }, resources };
      const dose = input.new_dose!;
      const id = a.id('mr');
      const next: MedicationRequest = {
        resourceType: 'MedicationRequest',
        id,
        status: 'active',
        intent: 'order',
        ...(old.medicationCodeableConcept ? { medicationCodeableConcept: old.medicationCodeableConcept } : {}),
        ...(old.medicationReference ? { medicationReference: old.medicationReference } : {}),
        subject: old.subject,
        authoredOn: a.stamp,
        requester: { reference: USER },
        reasonCode: [{ text: input.reason }],
        dosageInstruction: [dosage(dose.value, dose.unit, old.dosageInstruction?.[0]?.route, { frequency: dose.frequency })],
        priorPrescription: { reference: key(old) },
      };
      return {
        content: { medication_request: key(old), status: to, new_medication_request: `MedicationRequest/${id}` },
        resources: [...resources, { resource: next, created: true, fields: { reason: ['MedicationRequest.reasonCode'] } }],
      };
    });
  },
});
