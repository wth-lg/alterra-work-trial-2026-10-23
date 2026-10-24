// GateCtx has no free-text field (plan phase P8 gate): a gate check that reads the final text,
// a Task description or a message subject does not type-check (TS2339), nor does a gate
// function declared over RubricCtx; the control reading the final state does.
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

  it('a gate check reading a Task description fails with TS2339 on the gate Task', () => {
    const r = tsc('gate-reads-task-description');
    expect(r.status).not.toBe(0);
    // Both routes, the typed accessor (line 13) and narrowing the union (line 14), fail on the gate type.
    expect(r.out).toMatch(/check\.js\(13,\d+\): error TS2339: Property 'description' does not exist on type 'GateTask'/);
    expect(r.out).toMatch(/check\.js\(14,\d+\): error TS2339: Property 'description' does not exist on type '[^']*GateTask/);
  });

  it('a gate check reading a message subject fails with TS2339 on the gate Communication', () => {
    const r = tsc('gate-reads-comm-topic');
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/check\.js\(13,\d+\): error TS2339: Property 'topic' does not exist on type 'GateCommunication'/);
    expect(r.out).toMatch(/check\.js\(14,\d+\): error TS2339: Property 'topic' does not exist on type '[^']*GateCommunication/);
  });

  it('a gate function declared over RubricCtx does not type-check: fn is checked contravariantly', () => {
    const r = tsc('gate-fn-rubric-ctx');
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/error TS2322/);
    expect(r.out).toMatch(/final_text/);
  });

  it('the control reading the final state type-checks', () => {
    const r = tsc('gate-reads-allowed');
    expect(r.out).toBe('');
    expect(r.status).toBe(0);
  });
});
