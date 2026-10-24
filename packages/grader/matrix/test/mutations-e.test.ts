// The matrix's per-case checks on the unplanted toy (plan phase P9): two trials of each case
// give the same trajectory, every grade from the record is the same, and each equals the case
// graded in a fresh process (the isolation check, builder-33 item 2).
import { describe, expect, it } from 'vitest';
import { matrix } from './harness.ts';

describe('matrix --task _toy', () => {
  it('checks replay and regrade, and grades the unplanted toy the same in a fresh process', async () => {
    const { code, text } = await matrix({}, { cases: ['oracle'] });
    expect(text).toMatch(/^regrade idempotence: 1\/1 same grade/m);
    expect(text).toMatch(/^replay determinism: 1\/1 same trajectory and final hash/m);
    expect(text).toMatch(/^isolation: 2\/2 grades equal a fresh process/m);
    expect(code).toBe(0);
  });
});
