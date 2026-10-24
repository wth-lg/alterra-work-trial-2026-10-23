// A gate check that reads the subject line the agent wrote on a message (send_message), by the
// typed accessor and by narrowing the union. The gate view of a Communication has no topic, so
// each read must fail to type-check with TS2339.
import { gate } from '../../../check.ts';

export const g1 = gate({
  id: 'G1',
  category: 'action',
  traces_to: 'prompt L1',
  decisive_ids: [],
  fn: (ctx) => ({
    met:
      ctx.final.all('Communication').some((c) => (c.topic?.text ?? '').includes('urgent')) ||
      ctx.final.all().some((r) => r.resourceType === 'Communication' && (r.topic?.text ?? '').includes('urgent')),
    evidence: {},
  }),
});
