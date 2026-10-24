// A gate check whose function is declared over RubricCtx, to reach final_text. GateCheck.fn is a
// property, so its parameter is checked contravariantly and this file must fail to type-check.
import { gate } from '../../../check.ts';

/** @param {import('../../../check.ts').RubricCtx} ctx */
const readsText = (ctx) => ({ met: (ctx.final_text ?? '').includes('5 mg'), evidence: {} });

export const g1 = gate({ id: 'G1', category: 'action', traces_to: 'prompt L1', decisive_ids: [], fn: readsText });
