// Property schemas shared by the write tools.
import type { PropertySchema } from '../registry.ts';

const ID = '[A-Za-z0-9.-]{1,64}';
// A date, or a dateTime to the minute or second with an offset (validation step 1; the
// calendar and the clock are checked in checks.ts).
const WHEN = '^\\d{4}-\\d{2}-\\d{2}(T\\d{2}:\\d{2}(:\\d{2})?(Z|[+-]\\d{2}:\\d{2}))?$';
const DATETIME = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2})?(Z|[+-]\\d{2}:\\d{2})$';

// One resource of a known type: its id, or Type/id.
export const idOf = (type: string, example: string, what: string): PropertySchema => ({
  type: 'string',
  description: `${what}: a ${type} id, e.g. ${example} (or '${type}/${example}')`,
  pattern: `^(${type}/)?${ID}$`,
});

// A party that may be one of several types: Type/id, or a bare id.
export const party = (what: string): PropertySchema => ({ type: 'string', description: `${what}: Type/id or a bare id`, pattern: `^([A-Za-z]+/)?${ID}$` });

// A reference to any resource, as Type/id.
export const ref = (what: string): PropertySchema => ({ type: 'string', description: `${what}: Type/id, e.g. Observation/obs-00001`, pattern: `^[A-Za-z]+/${ID}$` });

export const refs = (what: string, maxItems: number): PropertySchema => ({ type: 'array', description: `${what}, as Type/id references`, items: ref(what), maxItems });

export const when = (what: string): PropertySchema => ({
  type: 'string',
  description: `${what}: YYYY-MM-DD, or YYYY-MM-DDThh:mm[:ss] with an offset; not in the past`,
  pattern: WHEN,
});

export const dateTime = (what: string): PropertySchema => ({
  type: 'string',
  description: `${what}: YYYY-MM-DDThh:mm[:ss] with an offset; not in the past`,
  pattern: DATETIME,
});

export const text = (what: string, maxLength: number): PropertySchema => ({ type: 'string', description: what, minLength: 1, maxLength });

export const PRIORITIES = ['routine', 'urgent', 'stat'] as const;
export const priority: PropertySchema = { type: 'string', description: 'Priority', enum: PRIORITIES };
