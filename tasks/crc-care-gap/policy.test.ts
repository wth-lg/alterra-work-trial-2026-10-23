// Double derivation for T3 (design section 4, "Double derivation"): policy.ts applied to the
// committed world must give expected.ts, and the panel must hold the design's twelve cases. The
// matrix checks the same equality; this test shows it on its own.
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

describe('crc-care-gap', () => {
  it('policy.ts applied to the world equals expected.ts', () => {
    expect(derive(world)).toEqual(expected);
  });

  it('orders for exactly the design five: E2, E3, E4, E8 and E10', () => {
    const d = derive(world) as unknown as typeof expected;
    expect(d.members.filter((x) => x.order).map((x) => x.patient)).toEqual(['Patient/pt-0017', 'Patient/pt-0018', 'Patient/pt-0019', 'Patient/pt-0022', 'Patient/pt-0023']);
  });

  it('records the colectomy only in a note, never as a coded Procedure or Condition', () => {
    const coded = all.filter((r) => (r.resourceType === 'Procedure' || r.resourceType === 'Condition') && JSON.stringify(r).includes('Patient/pt-0021') && /colectomy/i.test(JSON.stringify(r)));
    expect(coded).toEqual([]);
  });

  // The overlay cannot read instruction.md or the policy file, so their prompt-date, weekday and
  // leakage checks run here, over the committed world.
  it('states no date the clock gives and no answer in the prompt or policy text', async () => {
    const task = await nodeTaskSource({ testMode: false }).get('crc-care-gap');
    const texts = [task.instruction, ...task.policies.map((p) => p.text)];
    const answers = expected.members.map((x) => x.family);
    const findings = lintWorld(all, [{ source: 'crc-care-gap', spec: { prompts: texts, leakage: { answers, texts: texts.map((text, i) => ({ source: i === 0 ? 'instruction.md' : 'RBC-QM-02', text })) } } }]);
    expect(findings).toEqual([]);
  });
});
