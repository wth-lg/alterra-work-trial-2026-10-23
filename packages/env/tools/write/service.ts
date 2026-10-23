// order_service (design section 3): a lab, imaging or referral order (ServiceRequest) for a
// code from the order catalog, with an occurrence window that is not in the past.
import type { ServiceRequest } from '@medplum/fhirtypes';
import { ToolError } from '../errors.ts';
import { patient as patientSchema } from '../read/schema.ts';
import { catalogEntry, key, resolve, samePatient, when } from './checks.ts';
import { commit } from './commit.ts';
import { USER } from './context.ts';
import { priority, refs, text, when as whenSchema, type PRIORITIES } from './schema.ts';
import { writeTool } from './tool.ts';

const SNOMED = 'http://snomed.info/sct';
const CATEGORY: Record<string, [code: string, display: string]> = {
  lab: ['108252007', 'Laboratory procedure'],
  imaging: ['363679005', 'Imaging'],
  referral: ['3457005', 'Patient referral'],
};
// ServiceRequest.basedOn may name these (FHIR R4; CarePlan is not in this world).
const BASED_ON = ['ServiceRequest', 'MedicationRequest'];

type ServiceInput = {
  patient: string;
  code: string;
  priority: (typeof PRIORITIES)[number];
  occurrence_start: string;
  occurrence_end?: string;
  reason: string;
  supporting?: string[];
  based_on?: string[];
};

export const orderService = writeTool({
  name: 'order_service',
  description:
    'Order a lab, imaging study or referral (a ServiceRequest, status active) for a patient. code must come from lookup_catalog (kind lab, imaging or referral). ' +
    'occurrence_start, and occurrence_end for a window, are dates or dateTimes of the same form, not in the past, end not before start. ' +
    'supporting lists resources of the same patient that justify the order (results, notes, an Appointment); based_on lists the ServiceRequests or MedicationRequests it fulfils. ' +
    'Returns {service_request}.',
  inputSchema: {
    type: 'object',
    properties: {
      patient: patientSchema,
      code: { type: 'string', description: 'Order code from lookup_catalog, e.g. IMG-CT-CHEST-WO', minLength: 1, maxLength: 40 },
      priority,
      occurrence_start: whenSchema('When the service should happen, or the window start'),
      occurrence_end: whenSchema('The window end'),
      reason: text('Reason for the order', 500),
      supporting: refs('Supporting information', 20),
      based_on: refs('Requests this order fulfils (ServiceRequest or MedicationRequest)', 10),
    },
    required: ['patient', 'code', 'priority', 'occurrence_start', 'reason'],
    additionalProperties: false,
  },
  run(input: ServiceInput, ctx) {
    const patient = resolve(ctx, 'patient', input.patient, ['Patient']).id!;
    const entry = catalogEntry(ctx, 'code', input.code, ['lab', 'imaging', 'referral']);
    const start = when('occurrence_start', input.occurrence_start);
    const end = input.occurrence_end === undefined ? undefined : when('occurrence_end', input.occurrence_end);
    if (end && end.dateOnly !== start.dateOnly) throw new ToolError('INVALID_INPUT', "'occurrence_end' must have the same form as 'occurrence_start' (both dates or both dateTimes)", 'occurrence_end');
    if (end && end.ms < start.ms) throw new ToolError('INVALID_INPUT', "'occurrence_end' is before 'occurrence_start'", 'occurrence_end');
    const linked = (field: string, values: string[] | undefined, types?: readonly string[]) =>
      (values ?? []).map((v, i) => {
        const r = resolve(ctx, `${field}[${i}]`, v, types);
        samePatient(`${field}[${i}]`, r, patient);
        return { reference: key(r) };
      });
    const supporting = linked('supporting', input.supporting);
    const basedOn = linked('based_on', input.based_on, BASED_ON);
    return commit(ctx, 'order_service', (a) => {
      const id = a.id('sr');
      const [code, display] = CATEGORY[entry.kind]!;
      const order: ServiceRequest = {
        resourceType: 'ServiceRequest',
        id,
        status: 'active',
        intent: 'order',
        category: [{ coding: [{ system: SNOMED, code, display }], text: entry.kind }],
        priority: input.priority,
        code: { coding: [{ system: entry.system, code: entry.code, display: entry.display }], text: entry.display },
        subject: { reference: `Patient/${patient}` },
        ...(end ? { occurrencePeriod: { start: start.fhir, end: end.fhir } } : { occurrenceDateTime: start.fhir }),
        authoredOn: a.stamp,
        requester: { reference: USER },
        reasonCode: [{ text: input.reason }],
        ...(supporting.length ? { supportingInfo: supporting } : {}),
        ...(basedOn.length ? { basedOn } : {}),
      };
      return { content: { service_request: `ServiceRequest/${id}` }, resources: [{ resource: order, created: true, fields: { reason: ['ServiceRequest.reasonCode'] } }] };
    });
  },
});
