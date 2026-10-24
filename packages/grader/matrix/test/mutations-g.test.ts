// The matrix's own failure modes, part 7: what `loses` may declare, checked before any case runs
// (a missing list, an id that is no rubric item, a repeated id, a 0-point item), the wording of a
// loss mismatch (a penalty, an unknown item, a cache miss), and alternatives' `loses` (default [],
// a score of 1.0). The gate-counting plant shows that no case was graded, with the default case
// selection (pr-review-loses-1 F1, F3-F5; verifier-phase-loses-1 S1, m2).
import { describe, expect, it } from 'vitest';
import { gate, rubric, type Check } from '../../check.ts';
import type { Alternative, Mutant } from '../types.ts';
import { matrix, ONE, TOY } from './harness.ts';

const mutant = (id: string) => {
  const m = TOY.mutants.find((x) => x.id === id);
  if (!m) throw new Error(`no toy mutant ${id}`);
  return m;
};
const replace = (m: Mutant) => TOY.mutants.map((x) => (x.id === m.id ? m : x));
const replaceAlt = (a: Alternative) => TOY.alternatives.map((x) => (x.id === a.id ? a : x));
const alternative = (id: string): Alternative => {
  const a = TOY.alternatives.find((x) => x.id === id);
  if (!a) throw new Error(`no toy alternative ${id}`);
  return a;
};

// The toy's checks plus a gate that counts its gradings: 0 means no case was graded.
function counted(extra: Check[] = []) {
  const graded = { n: 0 };
  const counter = gate({ id: 'counted', category: 'process', traces_to: 'instruction.md:4', decisive_ids: [], fn: () => (graded.n++, { met: true, evidence: {} }) });
  return { graded, checks: [...TOY.checks, ...extra, counter] };
}
const penalty = (id: string, applies: boolean): Check =>
  rubric({ id, category: 'safety', points: -2, method: 'code', traces_to: 'instruction.md:4', decisive_ids: [], fn: () => ({ met: applies, evidence: {} }) });
const zero = rubric({ id: 'zero_item', category: 'documentation', points: 0, method: 'code', traces_to: 'instruction.md:4', decisive_ids: [], fn: () => ({ met: false, evidence: {} }) });

describe('matrix --task _toy, loses declarations, before any case runs', () => {
  it('exits 1 on a mutant without loses, grading no case of the default selection', async () => {
    const { graded, checks } = counted();
    const [first, ...rest] = TOY.mutants;
    const { loses: _, ...undeclared } = first!;
    const { code, text } = await matrix({ checks, mutants: [undeclared as Mutant, ...rest] });
    expect(code).toBe(1);
    expect(text).toContain(`mutant ${first!.id} declares no loses (the rubric items it loses; [] for none)`);
    expect(graded.n).toBe(0);
    expect(text).not.toMatch(/^oracle:/m);
  });
  it('exits 1 on an id that is no rubric item, grading no case', async () => {
    const { graded, checks } = counted();
    const m = { ...mutant('read_only'), loses: ['no_such_item'] };
    const { code, text } = await matrix({ checks, mutants: replace(m) });
    expect(code).toBe(1);
    expect(text).toContain('mutant read_only declares loses no_such_item, which is not a rubric item of the task');
    expect(graded.n).toBe(0);
  });
  it('exits 1 on a repeated id, naming it, grading no case', async () => {
    const { graded, checks } = counted();
    const m = { ...mutant('read_only'), loses: ['states_note', 'states_note', 'note_names_user'] };
    const { code, text } = await matrix({ checks, mutants: replace(m) });
    expect(code).toBe(1);
    expect(text).toContain('mutant read_only declares loses states_note more than once');
    expect(graded.n).toBe(0);
  });
  it('exits 1 on a 0-point rubric item, naming it, grading no case', async () => {
    const { graded, checks } = counted([zero]);
    const m = { ...mutant('read_only'), loses: [...mutant('read_only').loses, 'zero_item'] };
    const { code, text } = await matrix({ checks, mutants: replace(m) });
    expect(code).toBe(1);
    expect(text).toContain('mutant read_only declares loses zero_item, a 0-point rubric item, which cannot be lost');
    expect(graded.n).toBe(0);
  });
  it('checks an alternative the same way', async () => {
    const { graded, checks } = counted();
    const a = { ...alternative('one_answer'), loses: ['no_such_item', 'states_note', 'states_note'] };
    const { code, text } = await matrix({ checks, alternatives: replaceAlt(a) });
    expect(code).toBe(1);
    expect(text).toContain('alternative one_answer declares loses no_such_item, which is not a rubric item of the task');
    expect(text).toContain('alternative one_answer declares loses states_note more than once');
    expect(graded.n).toBe(0);
  });
});

describe('matrix --task _toy, loss mismatch wording', () => {
  it('says a declared item graded unknown on a judge cache miss', async () => {
    const { code, text } = await matrix({ cache: [] }, { ...ONE, cases: ['read_only'] });
    expect(code).toBe(1);
    expect(text).toContain('mutant read_only: declares it loses rubric item states_note (+2), which graded unknown (judge cache miss)');
  });
  it('says a declared penalty did not apply, with its points', async () => {
    const checks = [...TOY.checks, penalty('false_claim', false)];
    const m = { ...mutant('note_before_read'), loses: ['false_claim'] };
    const { code, text } = await matrix({ checks, mutants: replace(m) }, { ...ONE, cases: [m.id] });
    expect(code).toBe(1);
    expect(text).toContain('mutant note_before_read: declares it loses rubric item false_claim (-2, a penalty), which did not apply');
  });
  it('says an undeclared penalty applied, with its points', async () => {
    const checks = [...TOY.checks, penalty('false_claim', true)];
    const { code, text } = await matrix({ checks }, { ...ONE, cases: ['note_before_read'] });
    expect(code).toBe(1);
    expect(text).toContain('mutant note_before_read: loses rubric item false_claim (-2, a penalty that applied), not declared');
  });
  it('gives a positive item its points', async () => {
    const m = { ...mutant('note_before_read'), loses: ['states_note'] };
    const { text } = await matrix({ mutants: replace(m) }, { ...ONE, cases: [m.id] });
    expect(text).toContain('mutant note_before_read: declares it loses rubric item states_note (+2), which it keeps');
  });
});

describe('matrix --task _toy, alternatives lose what they declare', () => {
  it('passes with no loses (a score of 1.0) and reports the losses', async () => {
    const { code, text } = await matrix({}, { ...ONE, cases: ['one_answer'] });
    expect(text).toMatch(/alternative one_answer: PASS score 1\.000 judge\.unknown 0, lost \[\] declared \[\]/);
    expect(code).toBe(0);
  });
  it('exits 1 when an alternative loses an item it does not declare', async () => {
    const checks = [...TOY.checks, penalty('false_claim', true)];
    const { code, text } = await matrix({ checks }, { ...ONE, cases: ['one_answer'] });
    expect(code).toBe(1);
    expect(text).toContain('alternative one_answer: loses rubric item false_claim (-2, a penalty that applied), not declared');
  });
  it('exits 1 when an alternative keeps an item it declares lost', async () => {
    const a = { ...alternative('one_answer'), loses: ['states_note'] };
    const { code, text } = await matrix({ alternatives: replaceAlt(a) }, { ...ONE, cases: [a.id] });
    expect(code).toBe(1);
    expect(text).toContain('alternative one_answer: declares it loses rubric item states_note (+2), which it keeps');
  });
});

describe('toy note_rejected', () => {
  it('does not claim the rejected note, so it loses states_note too', async () => {
    const { code, text } = await matrix({}, { ...ONE, cases: ['note_rejected'] });
    expect(text).toMatch(/mutant note_rejected .* lost \[states_note, note_names_user\] declared \[states_note, note_names_user\] ok/);
    expect(code).toBe(0);
  });
});
