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

  // The overlay's own resources carry the screening history; a Synthea leftover that mentions
  // colon screening (a check-up coded 'Screening for malignant neoplasm of colon', a note listing
  // a colonoscopy) would contradict a member's answer.
  const SLOTS = expected.members.map((x) => x.patient);
  const onSlots = all.filter((r) => SLOTS.some((p) => JSON.stringify(r).includes(`"${p}"`)));
  const text = (r: (typeof all)[number]) =>
    JSON.stringify(r) + (r.resourceType === 'DocumentReference' ? r.content.map((c) => (c.attachment.data ? new TextDecoder().decode(Uint8Array.from(atob(c.attachment.data), (ch) => ch.charCodeAt(0))) : '')).join('\n') : '');
  const notesOf = (p: string) => onSlots.filter((r) => r.resourceType === 'DocumentReference' && r.subject?.reference === p && r.id !== 'doc-t3-e6-opnote');

  it('has no slot resource outside the overlay that mentions colon screening', () => {
    const mentions = onSlots.filter((r) => !r.id!.includes('-t3-') && /colon|colorectal|275978004|occult|fecal|sigmoid|\bFIT\b/i.test(text(r))).map((r) => `${r.resourceType}/${r.id}`);
    expect(mentions).toEqual([]);
  });

  it('keeps neutral Synthea notes on every slot, none stating an age', () => {
    for (const p of SLOTS) expect(notesOf(p).length, p).toBeGreaterThan(0);
    const aged = SLOTS.flatMap(notesOf).filter((r) => /\b\d+[ -]years?[ -]old\b/i.test(text(r))).map((r) => r.id);
    expect(aged).toEqual([]);
  });

  it('resolves the Synthea leftovers a clinician would notice', () => {
    const status = (type: string, id: string) => {
      const r = store.get(type, id) as { status?: string; clinicalStatus?: { coding?: Array<{ code?: string }> } } | undefined;
      return r?.clinicalStatus?.coding?.[0]?.code ?? r?.status;
    };
    // Full-time employment on frail E7 and E8, a 1998 anemia on E3, a 2024 alteplase dose on E12.
    expect(['cond-00231', 'cond-00452', 'cond-00425'].map((id) => status('Condition', id))).toEqual(['resolved', 'resolved', 'resolved']);
    expect(status('MedicationRequest', 'mr-00269')).toBe('completed');
  });

  it('dates the scanned operative note by its scan, with the surgery as its period', () => {
    const doc = store.get('DocumentReference', 'doc-t3-e6-opnote') as { date?: string; context?: { period?: { start?: string } } };
    expect(doc.date?.slice(0, 10)).toBe('2015-07-14');
    expect(doc.context?.period?.start?.slice(0, 10)).toBe('2015-06-03');
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
