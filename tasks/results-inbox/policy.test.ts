// Double derivation for T2 (design section 4, "Double derivation"): policy.ts applied to the
// committed world must give expected.ts, and the decisive dates must be the ones the design
// works out by hand. The matrix checks the same equality; this test shows it on its own.
import { describe, expect, it } from 'vitest';
import { nodeTaskSource } from '../../cli/adapters/tasks-node.ts';
import { matrixEnv } from '../../cli/matrix.ts';
import { loadStore } from '../../packages/env/fixture-source.ts';
import { lintWorld } from '../../packages/env/lint/index.ts';
import type { WorldView } from '../../packages/grader/matrix/types.ts';
import { expected } from './expected.ts';
import { derive } from './policy.ts';

const store = await loadStore(matrixEnv().world);
const all = [...store.resources()];
const world: WorldView = { get: (type, id) => store.get(type, id), all: (type) => (type === undefined ? all : all.filter((r) => r.resourceType === type)) };

describe('results-inbox', () => {
  it('policy.ts applied to the world equals expected.ts', () => {
    expect(derive(world)).toEqual(expected);
  });

  it('counts the nodule window from the index study, not from today', () => {
    const d = derive(world) as typeof expected;
    // 2026-06-04 + 12 months = 2027-06-04, plus or minus 1 month. From NOW (2026-10-23) the
    // follow-up would fall on 2027-10-23, outside the window.
    expect(d.items.nodule.window).toEqual({ start: '2027-05-04', end: '2027-07-04' });
    expect(d.items.nodule.risk).toBe('high');
    expect('2027-10-23' > d.items.nodule.window.end).toBe(true);
  });

  it('sends the hemolyzed potassium to a repeat by Monday and the true one to on-call today', () => {
    const d = derive(world) as typeof expected;
    // NOW is Friday 2026-10-23: the next business day is Monday 2026-10-26.
    expect(d.items.hemolyzed_k).toMatchObject({ hemolyzed: true, by: '2026-10-26' });
    expect(d.items.critical_k).toMatchObject({ hemolyzed: false, by: '2026-10-23' });
    expect(d.items.bone.by).toBe('2026-11-05');
  });

  // The overlay cannot read instruction.md or the policy files, so their prompt-date, weekday and
  // leakage checks run here, over the committed world.
  it('states no date the clock gives and no answer in the prompt or policy text', async () => {
    const task = await nodeTaskSource({ testMode: false }).get('results-inbox');
    const texts = [task.instruction, ...task.policies.map((p) => p.text)];
    const answers = ['2027-05-04', '2027-07-04', '2027-06-04', '2026-11-05', '2026-10-26', '35 pack-years'];
    const findings = lintWorld(all, [{ source: 'results-inbox', spec: { prompts: texts, leakage: { answers, texts: texts.map((text, i) => ({ source: i === 0 ? 'instruction.md' : task.policies[i - 1]!.id, text })) } } }]);
    expect(findings).toEqual([]);
  });
});
