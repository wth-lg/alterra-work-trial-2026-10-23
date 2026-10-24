// Double derivation for T1 (design section 4, "Double derivation"): policy.ts applied to the
// committed world must give expected.ts, and the decisive numbers must be the ones the design
// computes by hand. The matrix checks the same equality; this test shows it on its own.
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

describe('renal-dose-review', () => {
  it('policy.ts applied to the world equals expected.ts', () => {
    expect(derive(world)).toEqual(expected);
  });

  it('computes eGFR (CKD-EPI 2021) and CrCl (Cockcroft-Gault, actual weight) from the latest valid inputs', () => {
    // SCr 1.21 mg/dL (obs-t1-scr-1020), male, 82 years: 142 x (1.21 / 0.9)^-1.200 x 0.9938^82.
    const egfr = 142 * (1.21 / 0.9) ** -1.2 * 0.9938 ** 82;
    // 143 lb = 64.86 kg (obs-t1-wt-1020): (140 - 82) x 64.86 / (72 x 1.21).
    const crcl = ((140 - 82) * 143 * 0.45359237) / (72 * 1.21);
    expect(egfr).toBeCloseTo(59.78, 2);
    expect(crcl).toBeCloseTo(43.18, 2);
    const d = derive(world) as typeof expected;
    expect(d.egfr).toBe(Math.round(egfr * 10) / 10);
    expect(d.crcl).toBe(Math.round(crcl * 10) / 10);
  });

  it('takes neither the entered-in-error SCr nor the stale weight', () => {
    const d = derive(world) as typeof expected;
    expect(d.scr.id).toBe('Observation/obs-t1-scr-1020');
    expect(d.weight.id).toBe('Observation/obs-t1-wt-1020');
    expect(d.apixaban.criteria).toEqual({ age: true, weight: false, scr: false });
  });

  // The overlay cannot read instruction.md or the policy file, so their prompt-date, weekday and
  // leakage checks run here, over the committed world.
  it('states no date the clock gives and no answer in the prompt or policy text', async () => {
    const task = await nodeTaskSource({ testMode: false }).get('renal-dose-review');
    const texts = [task.instruction, ...task.policies.map((p) => p.text)];
    const answers = [String(expected.egfr), String(expected.crcl), '43.18', '59.78'];
    const findings = lintWorld(all, [{ source: 'renal-dose-review', spec: { prompts: texts, leakage: { answers, texts: texts.map((text, i) => ({ source: i === 0 ? 'instruction.md' : 'RBC-PHARM-07', text })) } } }]);
    expect(findings).toEqual([]);
  });
});
