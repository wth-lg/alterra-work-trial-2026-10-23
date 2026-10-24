// The notification rules of tests/notify.ts and tests/rubric.ts on cases the matrix does not
// commit: a page to on-call with nothing in about that the item's closure does not link. The
// rubric reads its text and finds the patient; a gate cannot (gate-view.ts keeps free text from
// gates), so for item 5 the gate still fails. That residual is the tool's to close: send_message
// should ask for a patient in about when the recipient is staff (review-difficulty F2).
import { describe, expect, it } from 'vitest';
import { loadMatrixTask, main } from '../../cli/matrix.ts';
import type { MatrixOptions } from '../../packages/grader/matrix/matrix.ts';
import type { Agent, MatrixTask } from '../../packages/grader/matrix/types.ts';
import { ORACLE, solve } from './solution/solve.ts';

const task = await loadMatrixTask('results-inbox');
const ONE = { trials: 1, regrades: 1, isolation: false } as const satisfies MatrixOptions;

async function run(alternatives: Agent[]) {
  const lines: string[] = [];
  const over: Partial<MatrixTask> = { alternatives: [...task.alternatives, ...alternatives] };
  await main(['--task', task.id], { env: {}, out: (l) => lines.push(l), load: async () => ({ ...task, ...over }), options: { ...ONE, cases: alternatives.map((a) => a.id) } });
  return lines.join('\n');
}

describe('results-inbox notifications', () => {
  it('counts an unlinked page that names the patient in its text against the hemolyzed item (-3 of 15)', async () => {
    // Item 4 links its repeat order and the patient message, not the page.
    const text = await run([{ id: 'probe_hemolyzed_page_unlinked', why: 'probe', script: solve({ hemolyzed: { ...ORACLE.hemolyzed, oncall: true, oncallAbout: [] }, links: { 4: (m) => [m[0]!, m[2]!] } }) }]);
    expect(text).toMatch(/alternative probe_hemolyzed_page_unlinked: PASS score 0\.800/);
  });

  it('cannot see an unlinked page with no patient from a gate', async () => {
    const text = await run([{ id: 'probe_critical_page_unlinked', why: 'probe', script: solve({ critical: { ...ORACLE.critical, oncallAbout: [] }, links: { 5: (m) => [m[1]!] } }) }]);
    expect(text).toMatch(/alternative probe_critical_page_unlinked: FAIL .*failed: critical_k_oncall\)/);
  });
});
