// The toy's expected end state, computed from the initial world by the instruction's rules
// (design section 4, "Double derivation"): the patient is the one step 2 names, the signed-in
// user is the one get_context reports, each named as get_context and the chart display them,
// and step 3 adds one note on the patient that cites it. It never imports expected.ts or overlay
// constants (lint: no-policy-expected-import).
import { STAFF } from '../../packages/env/world.ts';
import { displayName } from '../../packages/env/tools/read/get-context.ts';
import type { Json } from '../../packages/grader/check.ts';
import type { WorldView } from '../../packages/grader/matrix/types.ts';

type Name = NonNullable<Parameters<typeof displayName>[0]>;

const officialName = (r: unknown): string => {
  const names = (r as { name?: Name[] } | undefined)?.name ?? [];
  return displayName(names.find((n) => n.use === 'official') ?? names[0]);
};

export function derive(world: WorldView): Json {
  const patient = world.get('Patient', 'pt-0001');
  const user = world.get('Practitioner', STAFF[0]);
  if (!patient || !user) throw new Error('the toy world has no Patient/pt-0001 or signed-in Practitioner');
  const ref = `Patient/${patient.id}`;
  return {
    patient: ref,
    patient_name: officialName(patient),
    user: `Practitioner/${user.id}`,
    user_name: officialName(user),
    notes: [{ patient: ref, cites: [ref] }],
  };
}
