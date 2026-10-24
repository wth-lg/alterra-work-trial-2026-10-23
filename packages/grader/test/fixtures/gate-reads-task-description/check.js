// A gate check that reads the description the agent wrote on a Task (create_task), by the typed
// accessor and by narrowing the union. The gate view of a Task has no description, so each read
// must fail to type-check with TS2339.
import { gate } from '../../../check.ts';

export const g1 = gate({
  id: 'G1',
  category: 'action',
  traces_to: 'prompt L1',
  decisive_ids: [],
  fn: (ctx) => ({
    met:
      ctx.final.all('Task').some((t) => (t.description ?? '').includes('5 mg')) ||
      ctx.final.all().some((r) => r.resourceType === 'Task' && (r.description ?? '').includes('5 mg')),
    evidence: {},
  }),
});
