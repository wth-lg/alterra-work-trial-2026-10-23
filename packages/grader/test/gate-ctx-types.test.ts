// GateCtx has no free-text field (plan phase P8 gate): a gate check that reads the final text
// does not type-check (TS2339 on GateCtx), and the control reading the final state does.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const tsc = (fixture: string) => {
  const r = spawnSync('pnpm', ['exec', 'tsc', '-p', `packages/grader/test/fixtures/${fixture}`], { cwd: root, encoding: 'utf8' });
  return { status: r.status, out: r.stdout + r.stderr };
};

describe('GateCtx types', () => {
  it('a gate check reading final_text fails with TS2339 on GateCtx', () => {
    const r = tsc('gate-reads-text');
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/error TS2339: Property 'final_text' does not exist on type 'GateCtx'/);
  });

  it('the control reading the final state type-checks', () => {
    const r = tsc('gate-reads-allowed');
    expect(r.out).toBe('');
    expect(r.status).toBe(0);
  });
});
