// Double derivation for T5 (design section 4, "Double derivation"): policy.ts applied to the
// committed world must give expected.ts, and the dose times must be the ones the design
// computes by hand from the Monday 09:00 slot. The matrix checks the same equality; this test
// shows it on its own.
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

describe('contrast-ct-prep', () => {
  it('policy.ts applied to the world equals expected.ts', () => {
    expect(derive(world)).toEqual(expected);
  });

  it('counts 13, 7 and 1 hours back from the 09:00 Monday scan, across midnight', () => {
    const scan = Date.parse('2026-10-26T09:00:00-04:00');
    const back = (h: number) => new Date(scan - h * 3_600_000).toISOString();
    // 13 hours before 09:00 Monday is 20:00 Sunday; 7 hours is 02:00 Monday.
    expect([13, 7, 1].map(back)).toEqual(['2026-10-26T00:00:00.000Z', '2026-10-26T06:00:00.000Z', '2026-10-26T12:00:00.000Z']);
    const d = derive(world) as typeof expected;
    expect(d.prednisone.at).toEqual(['2026-10-25T20:00:00-04:00', '2026-10-26T02:00:00-04:00', '2026-10-26T08:00:00-04:00']);
    expect(d.diphenhydramine.at).toEqual(['2026-10-26T08:00:00-04:00']);
  });

  it('premedicates for the contrast reaction only, and needs a new creatinine', () => {
    const d = derive(world) as typeof expected;
    expect(d.contrast_allergy.id).toBe('AllergyIntolerance/alg-t5-iohexol');
    expect(d.regimen).toBe('premedicate');
    expect(d.other_allergies).toContain('AllergyIntolerance/alg-t5-shellfish');
    expect(d.other_allergies).toContain('AllergyIntolerance/alg-t5-pvp');
    // The last creatinine (2025-08-14) is more than 30 days before the scan.
    expect(d.creatinine).toMatchObject({ latest: 'Observation/obs-t5-scr-0814', required: true, current: false });
  });

  // The overlay cannot read instruction.md or the policy file, so their prompt-date, weekday and
  // leakage checks run here, over the committed world.
  it('states no date the clock gives and no answer in the prompt or policy text', async () => {
    const task = await nodeTaskSource({ testMode: false }).get('contrast-ct-prep');
    const texts = [task.instruction, ...task.policies.map((p) => p.text)];
    const answers = ['8:00 PM', '2:00 AM', '20:00', '02:00', '2026-10-25'];
    const findings = lintWorld(all, [{ source: 'contrast-ct-prep', spec: { prompts: texts, leakage: { answers, texts: texts.map((text, i) => ({ source: i === 0 ? 'instruction.md' : 'RBC-RAD-07', text })) } } }]);
    expect(findings).toEqual([]);
  });
});
