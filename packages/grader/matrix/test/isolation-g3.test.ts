// The matrix isolation check (plan phase P9, builder-33 item 2) catches cross-trial grader state
// the lint rule cannot see: plant G3_closure_factory of the P9 verifier's G2-G7 (plants.ts). Its gate carries
// state from one grading to the next in one process, so a later in-process grade differs from
// the same case graded in a fresh process, and the matrix exits 1 naming the case and
// 'cross-trial grader state'. One plant per file keeps each file fast.
import { expect, it } from 'vitest';
import { isolationRun } from './harness.ts';
import { plant } from './plants.ts';

it('G3_closure_factory makes the matrix exit 1 with cross-trial grader state', async () => {
  const { code, text } = await isolationRun(plant('G3_closure_factory'));
  expect(code).toBe(1);
  expect(text).toMatch(/^ {2}- (oracle|mutant read_only): cross-trial grader state: in-process grade \d of \d \(after [^)]+\) differs from a fresh process in planted$/m);
  expect(text).toMatch(/^isolation: \d+\/\d+ grades equal a fresh process/m);
});
