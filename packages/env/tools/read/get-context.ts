// get_context (design section 3): who the user is and what time it is, from the pinned clock.
// The user and clinic are named by reference with a display name, nothing clinical, so they are
// referenced, not exposed (the exposure rule, registry.ts).
import type { HumanName, Organization, Practitioner } from '@medplum/fhirtypes';
import { TIME_ZONE } from '../../clock.ts';
import { CLINIC, STAFF } from '../../world.ts';
import type { Tool } from '../registry.ts';
import type { ReadContext } from './context.ts';

const USER = STAFF[0];

export const displayName = (name: HumanName | undefined): string =>
  [...(name?.given ?? []), name?.family ?? ''].join(' ').trim();

export const getContext: Tool<ReadContext> = {
  name: 'get_context',
  description: 'The current time (the clinic clock), the signed-in user and the clinic. Takes no parameters.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  run(_input, { world, clock }) {
    // Both are in every world (packages/env/world.ts); a world without them is a defect.
    const user = world.get<Practitioner>('Practitioner', USER);
    const clinic = world.get<Organization>('Organization', CLINIC);
    if (!user || !clinic) throw new Error(`world is missing Practitioner/${USER} or Organization/${CLINIC}`);
    const name = user.name?.[0];
    return {
      now: clock.now,
      timezone: TIME_ZONE,
      user: { practitioner: `Practitioner/${USER}`, name: [displayName(name), ...(name?.suffix ?? [])].join(', '), role: 'physician' },
      clinic: { organization: `Organization/${CLINIC}`, name: clinic.name },
    };
  },
};
