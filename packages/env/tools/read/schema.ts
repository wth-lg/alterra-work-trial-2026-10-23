// Property schemas shared by the read tools.
import { RESOURCE_TYPES } from '../../world.ts';
import type { PropertySchema } from '../registry.ts';

export const FHIR_ID = '^[A-Za-z0-9.-]{1,64}$';
// A FHIR date, or a dateTime to the minute or second with an offset.
const DATE = '^\\d{4}-\\d{2}-\\d{2}(T\\d{2}:\\d{2}(:\\d{2})?(Z|[+-]\\d{2}:\\d{2}))?$';

export const resourceType: PropertySchema = { type: 'string', description: 'FHIR resource type', enum: RESOURCE_TYPES };
export const patient: PropertySchema = {
  type: 'string',
  description: "Patient id, e.g. pt-0001 (or 'Patient/pt-0001')",
  pattern: '^(Patient/)?[A-Za-z0-9.-]{1,64}$',
};
export const date = (bound: string): PropertySchema => ({
  type: 'string',
  description: `${bound}, inclusive: YYYY-MM-DD, or YYYY-MM-DDThh:mm[:ss] with an offset`,
  pattern: DATE,
});
export const offset: PropertySchema = { type: 'integer', description: 'Entries to skip; pass next_offset from the previous page', minimum: 0, maximum: 100_000 };
export const count = (max: number, dflt: number): PropertySchema => ({
  type: 'integer',
  description: `Entries per page, 1-${max} (default ${dflt}); a page may hold fewer to stay under the size cap`,
  minimum: 1,
  maximum: max,
});
