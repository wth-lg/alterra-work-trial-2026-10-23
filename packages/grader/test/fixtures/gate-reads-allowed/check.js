// The control for gate-reads-text: the same gate check reading an allowed GateCtx field (the
// final state) type-checks.
import { gate } from '../../../check.ts';

export const g1 = gate({
  id: 'G1',
  category: 'reasoning',
  traces_to: 'prompt L1',
  decisive_ids: [],
  fn: (ctx) => ({ met: ctx.final.all('MedicationRequest').length === 1, evidence: {} }),
});
