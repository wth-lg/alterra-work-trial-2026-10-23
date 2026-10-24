// A gate check that reads the agent's final text. GateCtx has no such field, so this file
// must fail to type-check with TS2339 naming final_text: a gate never grades free text.
import { gate } from '../../../check.ts';

export const g1 = gate({
  id: 'G1',
  category: 'reasoning',
  traces_to: 'prompt L1',
  decisive_ids: [],
  fn: (ctx) => ({ met: (ctx.final_text ?? '').includes('5 mg'), evidence: {} }),
});
