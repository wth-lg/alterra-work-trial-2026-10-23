// The grader end to end on a T1-shaped check set (design section 5): pass and fail, the tau2
// regressions (formatting and extra reads never change a grade), exposure as P5 defines it,
// writes as P6 records them, the judge's unknown path, regrade from cache, the outcome order
// and attribution.
import type { Resource } from '../../env/store.ts';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../core/anthropic.ts';
import { gate, hybrid, judged, rubric, type Check, type GateCtx } from '../check.ts';
import { grade, type GradeInput } from '../grade.ts';
import { JudgeCacheMiss } from '../judge.ts';
import { isValid } from '../outcome.ts';
import { dailyDose, isActive, isDrug, sameQuantity, type MedicationRequest } from '../normalize.ts';
import { facts, INITIAL, medication, note, scriptedJudge, trajectory, type Call } from './helpers.ts';

const DECISIVE = ['obs-scr-1020', 'obs-wt-1020'];
const notesText = (ctx: { notes: readonly { text: string }[] }) => ctx.notes.map((n) => n.text).join('\n\n');

const apixaban = (ctx: GateCtx) => ctx.final.all('MedicationRequest').filter((r) => isActive(r) && (r as MedicationRequest).subject?.reference === 'Patient/pt-1' && isDrug((r as MedicationRequest).medicationCodeableConcept, { ingredient: 'apixaban' }));

const CHECKS: Check[] = [
  gate({
    id: 'G1', category: 'reasoning', traces_to: 'RBC-PHARM-07 §2', decisive_ids: DECISIVE,
    fn: (ctx) => {
      const active = apixaban(ctx);
      const total = active.length === 1 ? dailyDose(active[0] as MedicationRequest) : null;
      // The expected dose is written as text with a trailing zero on purpose: 10.0 = 10.
      const met = total !== null && sameQuantity(total, { value: '10.0', unit: 'MG' });
      return { met, evidence: { expected: 'apixaban 5 mg 2/day', found: total === null ? `${active.length} active` : `${total.value} ${total.unit}/day` }, ids: active.map((r) => `MedicationRequest/${r.id}`) };
    },
  }),
  gate({
    id: 'G5', category: 'safety', traces_to: 'RBC-PHARM-07 §5', decisive_ids: [],
    fn: (ctx) => {
      const other = ctx.writes().filter((w) => w.startsWith('MedicationRequest/') && (ctx.final.get('MedicationRequest', w.slice(18)) as MedicationRequest | undefined)?.subject?.reference !== 'Patient/pt-1');
      return { met: other.length === 0, evidence: { other_writes: other }, ids: other };
    },
  }),
  gate({
    id: 'G6', category: 'process', traces_to: 'RBC-PHARM-07 §1', decisive_ids: DECISIVE,
    fn: (ctx) => {
      const first = ctx.steps.find((s) => s.written_ids.some((w) => w.startsWith('MedicationRequest/')));
      const missing = DECISIVE.filter((id) => { const at = ctx.exposedAt(id); return at === null || (first !== undefined && at > first.n); });
      return { met: missing.length === 0, evidence: { not_exposed_before_write: missing } };
    },
  }),
  hybrid({ id: 'R1', points: 3, category: 'documentation', traces_to: 'RBC-PHARM-07 §4', decisive_ids: DECISIVE, field: 'CrCl in mL/min', text: notesText, pattern: /CrCl\D{0,20}?(\d+(?:\.\d+)?)/i, truth: 43.2, tolerance: { rel: 0.1 } }),
  judged({ id: 'R2', points: 3, category: 'documentation', traces_to: 'RBC-PHARM-07 §2', decisive_ids: [], criterion: 'The note states each apixaban dose criterion with its value and whether it is met.', text: notesText }),
  rubric({
    id: 'R3', points: 2, method: 'code', category: 'documentation', traces_to: 'prompt L3', decisive_ids: DECISIVE,
    fn: (ctx) => {
      const cites = ctx.notes.flatMap((n) => n.cites);
      const missing = DECISIVE.filter((id) => !cites.includes(`Observation/${id}`));
      return { met: missing.length === 0, evidence: { missing } };
    },
  }),
  judged({ id: 'R4', points: -6, category: 'reasoning', traces_to: 'RBC-PHARM-07 §2', decisive_ids: [], criterion: 'The note bases the apixaban dose decision on eGFR or CrCl.', text: notesText }),
];

const NOTE_TEXT = 'Apixaban: age 82 (met), weight 64.9 kg (not met), SCr 1.21 (not met), so 5 mg BID. CrCl 43.2 mL/min.';
const NEW_APIX = medication('mr-t1', 'apixaban 5 MG Oral Tablet', 5.0, 'mg', 2);
const STOPPED = { ...medication('mr-apix', 'apixaban 2.5 MG Oral Tablet', 2.5, 'mg', 2), status: 'stopped' } as Resource;

const READS: Call[] = [
  { name: 'fhir_search', referenced: ['Observation/obs-scr-1020', 'Observation/obs-wt-1020'] },
  { name: 'fhir_read', exposed: ['Observation/obs-scr-1020'] },
  { name: 'fhir_read', exposed: ['Observation/obs-wt-1020'] },
];
const WRITES: Call[] = [
  { name: 'change_medication', written: ['MedicationRequest/mr-apix', 'MedicationRequest/mr-t1', 'Provenance/prov-t1'] },
  { name: 'write_note', written: ['DocumentReference/doc-t2', 'Provenance/prov-t2'] },
  { name: 'finish' },
];

function input(calls: Call[], final: Resource[], over: Partial<GradeInput> = {}): GradeInput {
  return { checks: CHECKS, initial: INITIAL, final, events: trajectory(calls), trial: facts(), ...over };
}
const finalWith = (...rs: Resource[]) => [...INITIAL.filter((r) => !rs.some((x) => x.resourceType === r.resourceType && x.id === r.id)), ...rs];
const GOOD_FINAL = finalWith(STOPPED, NEW_APIX, note('doc-t2', NOTE_TEXT, ['Observation/obs-scr-1020', 'Observation/obs-wt-1020']));
const MET = '{"verdict":"met","quote":"age 82 (met), weight 64.9 kg (not met)"}';
const NOT_MET = '{"verdict":"not_met","quote":""}';

describe('grade', () => {
  it('passes a correct trial and scores the rubric', async () => {
    const j = scriptedJudge([MET, NOT_MET]);
    const g = await grade(input([...READS, ...WRITES], GOOD_FINAL), { judge: j.client });
    expect(g.outcome).toBe('PASS');
    expect(g.valid).toBe(true);
    expect(g.checks.filter((c) => c.kind === 'gate').map((c) => [c.id, c.met])).toEqual([['G1', true], ['G5', true], ['G6', true]]);
    expect(g.checks.find((c) => c.id === 'R1')).toMatchObject({ met: true, evidence: { value: 43.2, source: 'regex', quote: 'CrCl 43.2' } });
    // R1 3 + R2 3 + R3 2 met, R4 (-6) not met, over 8 positive points.
    expect(g.score).toBe(1);
    expect(g.attribution).toBeNull();
    expect(j.requests).toHaveLength(2);
  });

  it('fails on the gate and attributes it: dose formatting is normalised, 2.50 mg stays wrong', async () => {
    const kept = medication('mr-t1', 'apixaban 2.5 MG Oral Tablet', 2.5, 'mg', 2);
    const g = await grade(input([...READS, ...WRITES], finalWith(STOPPED, kept, note('doc-t2', NOTE_TEXT))), { judge: scriptedJudge([MET, NOT_MET]).client });
    expect(g.outcome).toBe('FAIL');
    expect(g.checks.find((c) => c.id === 'G1')).toMatchObject({ met: false, evidence: { found: '5 mg/day' } });
    expect(g.attribution).toMatchObject({ auto: 'reasoning', first_failed: 'G1', decisive_step: 4 });
    expect(g.attribution!.exposure).toEqual([{ id: 'obs-scr-1020', first_exposed_step: 2 }, { id: 'obs-wt-1020', first_exposed_step: 3 }]);
  });

  it('extra reads leave the grade unchanged (tau2)', async () => {
    const noisy: Call[] = [
      { name: 'get_context', exposed: ['Practitioner/pr-1'] },
      ...READS,
      { name: 'fhir_read', exposed: ['Patient/pt-2'] },
      { name: 'search_notes', referenced: ['DocumentReference/doc-nurse-1'] },
      { name: 'fhir_read', exposed: ['Observation/obs-scr-1020'] },
      ...WRITES,
    ];
    const strip = (g: Awaited<ReturnType<typeof grade>>) => ({ outcome: g.outcome, checks: g.checks, score: g.score, judge: g.judge, auto: g.attribution?.auto ?? null });
    for (const final of [GOOD_FINAL, finalWith(STOPPED, medication('mr-t1', 'apixaban 2.5 MG Oral Tablet', 2.5, 'mg', 2), note('doc-t2', NOTE_TEXT))]) {
      const plain = await grade(input([...READS, ...WRITES], final), { judge: scriptedJudge([MET, NOT_MET]).client });
      const extra = await grade(input(noisy, final), { judge: scriptedJudge([MET, NOT_MET]).client });
      expect(strip(extra)).toEqual(strip(plain));
    }
  });

  it('a note found by search but never read was not seen: retrieval, not reasoning (P5 exposure)', async () => {
    const checks: Check[] = [gate({ id: 'G1', category: 'reasoning', traces_to: 'RBC-PHARM-07 §1', decisive_ids: ['doc-nurse-1'], fn: () => ({ met: false, evidence: {} }) })];
    const searched: Call[] = [
      { name: 'fhir_search', referenced: ['DocumentReference/doc-nurse-1'] },
      { name: 'search_notes', referenced: ['DocumentReference/doc-nurse-1'] },
      { name: 'finish' },
    ];
    const notSeen = await grade({ ...input(searched, INITIAL), checks });
    expect(notSeen.attribution).toMatchObject({ auto: 'retrieval', exposure: [{ id: 'doc-nurse-1', first_exposed_step: null }] });
    const read = await grade({ ...input([...searched.slice(0, 2), { name: 'fhir_read', exposed: ['DocumentReference/doc-nurse-1'] }, { name: 'finish' }], INITIAL), checks });
    expect(read.attribution).toMatchObject({ auto: 'reasoning', exposure: [{ id: 'doc-nurse-1', first_exposed_step: 3 }] });
  });

  it('a failed process gate with the state right is process; a failed safety gate is over-action', async () => {
    const process = await grade(input(WRITES, GOOD_FINAL), { judge: scriptedJudge([MET, NOT_MET]).client });
    expect(process).toMatchObject({ outcome: 'FAIL', attribution: { auto: 'process', first_failed: 'G6' } });
    const other = medication('mr-t9', 'apixaban 5 MG Oral Tablet', 5, 'mg', 2, 'active', 'pt-2');
    const spray: Call[] = [...READS, { name: 'order_medication', written: ['MedicationRequest/mr-t9', 'Provenance/prov-t9'] }, ...WRITES];
    const safety = await grade(input(spray, [...GOOD_FINAL, other]), { judge: scriptedJudge([MET, NOT_MET]).client });
    expect(safety).toMatchObject({ outcome: 'FAIL', attribution: { auto: 'over_action', first_failed: 'G5', decisive_step: 4 } });
  });

  it('a rejected write changed nothing and is not a write (P6 written_ids)', async () => {
    const rejected: Call = { name: 'order_medication', input: { patient: 'pt-2', medication: 'apixaban' }, is_error: true, error_code: 'INVALID_INPUT' };
    const g = await grade(input([...READS, rejected, ...WRITES], GOOD_FINAL), { judge: scriptedJudge([MET, NOT_MET]).client });
    expect(g.outcome).toBe('PASS');
  });

  it('the action/output gap: the note states the right action, the state lacks it', async () => {
    const intent = judged({ id: 'R9', points: 1, category: 'action', traces_to: 'prompt L2', decisive_ids: [], criterion: 'The note states that apixaban is increased to 5 mg twice daily.', text: notesText });
    const g1 = gate({ ...(CHECKS[0] as Extract<Check, { kind: 'gate' }>), stated_by: 'R9' });
    const checks = [g1, intent];
    const final = finalWith(note('doc-t2', NOTE_TEXT));
    const g = await grade({ ...input([...READS, { name: 'write_note', written: ['DocumentReference/doc-t2', 'Provenance/prov-t2'] }, { name: 'finish' }], final), checks }, { judge: scriptedJudge(['{"verdict":"met","quote":"so 5 mg BID"}']).client });
    expect(g.attribution).toMatchObject({ auto: 'output_gap', first_failed: 'G1', decisive_step: 5 });
  });
});

describe('judge unknown', () => {
  it('an unknown verdict leaves both the numerator and the denominator, and is flagged', async () => {
    const j = scriptedJudge(['{"verdict":"unknown","quote":""}', NOT_MET]);
    const g = await grade(input([...READS, ...WRITES], GOOD_FINAL), { judge: j.client });
    expect(g.checks.find((c) => c.id === 'R2')).toMatchObject({ met: 'unknown' });
    expect(g.judge.unknown).toBe(1);
    // R1 3 + R3 2 met, R2 out of both sums: 5 / 5, not 5 / 8.
    expect(g.score).toBe(1);
    const wrong = await grade(input([...READS, ...WRITES], finalWith(STOPPED, NEW_APIX, note('doc-t2', NOTE_TEXT))), { judge: scriptedJudge(['{"verdict":"unknown","quote":""}', NOT_MET]).client });
    // R1 3 met, R3 (cites) not met: 3 / 5.
    expect(wrong.score).toBe(0.6);
  });

  it('a quote that is not in the graded text makes the verdict unknown', async () => {
    const j = scriptedJudge(['{"verdict":"met","quote":"apixaban criteria all reviewed"}', NOT_MET]);
    const g = await grade(input([...READS, ...WRITES], GOOD_FINAL), { judge: j.client });
    expect(g.checks.find((c) => c.id === 'R2')).toMatchObject({ met: 'unknown', evidence: { reason: 'quote not in text' } });
    expect(g.judge.unknown).toBe(1);
  });

  it('invalid JSON is retried once, then unknown', async () => {
    const j = scriptedJudge(['not json', 'still not json', NOT_MET]);
    const g = await grade(input([...READS, ...WRITES], GOOD_FINAL), { judge: j.client });
    expect(j.requests).toHaveLength(3);
    expect(g.checks.find((c) => c.id === 'R2')).toMatchObject({ met: 'unknown', evidence: { reason: 'invalid judge output' } });
  });

  it('no judge and no cache: judge items are unknown, gates still decide', async () => {
    const g = await grade(input([...READS, ...WRITES], GOOD_FINAL));
    expect(g.outcome).toBe('PASS');
    expect(g.checks.filter((c) => c.method === 'judge').every((c) => c.met === 'unknown')).toBe(true);
  });
});

describe('regrade from cache', () => {
  it('is byte-identical and makes no call; a cache miss is an error', async () => {
    const j = scriptedJudge(['{"verdict":"met","quote":"SCr 1.21 (not met)"}', NOT_MET]);
    const first = await grade(input([...READS, ...WRITES], GOOD_FINAL), { judge: j.client });
    expect(first.judge.cache_keys).toHaveLength(2);
    expect(first.judge.cache_keys.every((k) => /^[0-9a-f]{64}$/.test(k))).toBe(true);
    const again = await grade(input([...READS, ...WRITES], GOOD_FINAL), { cache: first.judge.cache });
    expect(JSON.stringify(again)).toBe(JSON.stringify(first));
    expect(j.requests).toHaveLength(2);
    const changed = finalWith(STOPPED, NEW_APIX, note('doc-t2', `${NOTE_TEXT} Reviewed.`));
    await expect(grade(input([...READS, ...WRITES], changed), { cache: first.judge.cache })).rejects.toThrow(JudgeCacheMiss);
  });

  it('a hybrid item whose regex misses asks the extractor, cached the same way', async () => {
    const text = 'Creatinine clearance comes to forty-three point two, about 43 mL/min by Cockcroft-Gault.';
    const final = finalWith(STOPPED, NEW_APIX, note('doc-t2', text, ['Observation/obs-scr-1020', 'Observation/obs-wt-1020']));
    const j = scriptedJudge(['{"value":43,"quote":"about 43 mL/min"}', NOT_MET, NOT_MET]);
    const g = await grade(input([...READS, ...WRITES], final), { judge: j.client });
    expect(g.checks.find((c) => c.id === 'R1')).toMatchObject({ met: true, evidence: { value: 43, source: 'llm', quote: 'about 43 mL/min' } });
    const again = await grade(input([...READS, ...WRITES], final), { cache: g.judge.cache });
    expect(JSON.stringify(again)).toBe(JSON.stringify(g));
  });
});

describe('outcomes', () => {
  const run = (over: Parameters<typeof facts>[0]) => grade(input([...READS, ...WRITES], GOOD_FINAL, { trial: facts(over) }), { judge: scriptedJudge([MET, NOT_MET]).client });

  it.each([
    ['INVALID', { status: 'ENV_ERROR', models_returned: ['claude-opus-5-5', 'claude-sonnet-5-5'] }],
    ['INVALID', { status: 'INVALID' }],
    ['INFRA_HARNESS', { status: 'INFRA_HARNESS' }],
    ['INFRA_API', { status: 'INFRA_API' }],
    ['CANCELLED', { status: 'CANCELLED' }],
    ['ENV_ERROR', { status: 'ENV_ERROR' }],
    ['ENV_ERROR', { state_hash: { initial: 'a'.repeat(64), final: 'b'.repeat(64), replay_final: 'c'.repeat(64) } }],
    ['ENV_ERROR', { tool_errors: { INVALID_INPUT: 0, NOT_FOUND: 0, CONFLICT: 0, NOT_SUPPORTED: 0, INTERNAL: 1 } }],
  ] as const)('%s for %j: never a valid trial, never graded, no judge call', async (outcome, over) => {
    const j = scriptedJudge([MET]);
    const g = await grade(input([...READS, ...WRITES], GOOD_FINAL, { trial: facts(over as never) }), { judge: j.client });
    expect(g).toMatchObject({ outcome, valid: false, checks: [], score: null, attribution: null });
    expect(j.requests).toHaveLength(0);
  });

  it('REFUSAL and LIMIT are valid and graded; LIMIT is did_not_finish', async () => {
    expect(await run({ status: 'REFUSAL' })).toMatchObject({ outcome: 'REFUSAL', valid: true, attribution: null });
    const limit = await run({ status: 'LIMIT' });
    expect(limit).toMatchObject({ outcome: 'LIMIT', valid: true, attribution: { auto: 'did_not_finish', decisive_step: 6 } });
    expect(limit.checks.length).toBe(CHECKS.length);
  });

  it('a missing write puts the decisive step at the last step', async () => {
    const g = await grade(input([...READS, { name: 'finish' }], INITIAL), { judge: scriptedJudge([NOT_MET]).client });
    expect(g.attribution).toMatchObject({ first_failed: 'G1', decisive_step: 4 });
  });
});

describe('GateCtx', () => {
  it('carries no free text at run time: no notes, no final text, note bodies stripped', async () => {
    let seen: GateCtx | undefined;
    const probe = gate({ id: 'G0', category: 'process', traces_to: 'prompt L1', decisive_ids: [], fn: (ctx) => ((seen = ctx), { met: true, evidence: {} }) });
    await grade({ ...input([...READS, ...WRITES], GOOD_FINAL), checks: [probe] });
    expect(seen).toBeDefined();
    expect('notes' in seen!).toBe(false);
    expect('final_text' in seen!).toBe(false);
    const doc = seen!.final.get('DocumentReference', 'doc-t2') as unknown as { content: Array<{ attachment: Record<string, unknown> }> };
    expect(doc.content[0]!.attachment).not.toHaveProperty('data');
    expect(seen!.final.get('DocumentReference', 'doc-t2')).toMatchObject({ context: { related: [{ reference: 'Observation/obs-scr-1020' }, { reference: 'Observation/obs-wt-1020' }] } });
  });
});

describe('a check that throws', () => {
  // A gate written with a non-null assertion on a resource the model never created.
  const careless = gate({ id: 'G9', category: 'action', traces_to: 'prompt L2', decisive_ids: [], fn: (ctx) => ({ met: ctx.final.get('MedicationRequest', 'mr-never')!.status === 'active', evidence: {} }) });

  it('is the grader\'s fault: GRADER_ERROR, invalid, fault grader, with the check named', async () => {
    const g = await grade({ ...input([...READS, ...WRITES], GOOD_FINAL), checks: [CHECKS[0]!, careless] }, { judge: scriptedJudge([MET, NOT_MET]).client });
    expect(g).toMatchObject({ outcome: 'GRADER_ERROR', valid: false, fault: 'grader', score: null, attribution: null, error: { check: 'G9', stops_batch: false } });
    expect(g.error!.message).toMatch(/Cannot read properties of undefined/);
    expect(g.checks.map((c) => [c.id, c.met])).toEqual([['G1', true], ['G9', 'unknown']]);
  });

  it('a gate that throws first does not stop the others: every check runs, judge items included, so the judge cache is complete', async () => {
    const j = scriptedJudge([MET, NOT_MET]);
    const g = await grade({ ...input([...READS, ...WRITES], GOOD_FINAL), checks: [careless, ...CHECKS] }, { judge: j.client });
    expect(g).toMatchObject({ outcome: 'GRADER_ERROR', valid: false, fault: 'grader', score: null, attribution: null, error: { check: 'G9', stops_batch: false } });
    expect(g.checks.map((c) => c.id)).toEqual(['G9', ...CHECKS.map((c) => c.id)]);
    expect(g.checks.filter((c) => c.id !== 'G9').every((c) => c.met !== 'unknown' || c.method !== 'code')).toBe(true);
    expect(j.requests).toHaveLength(2);
    expect(g.judge.cache).toHaveLength(2);
    // The same trial graded again from that cache, with no client, has the grade of the fixed grader.
    expect((await grade(input([...READS, ...WRITES], GOOD_FINAL), { cache: g.judge.cache })).outcome).toBe('PASS');
  });

  it('when several checks throw, error names the first and its message lists the others', async () => {
    const bad = rubric({ id: 'R9', points: 1, method: 'code', category: 'documentation', traces_to: 'prompt L1', decisive_ids: [], fn: () => { throw new TypeError('bug in R9'); } });
    const g = await grade({ ...input([...READS, ...WRITES], GOOD_FINAL), checks: [careless, ...CHECKS, bad] }, { judge: scriptedJudge([MET, NOT_MET]).client });
    expect(g.error).toMatchObject({ check: 'G9', message: expect.stringMatching(/Cannot read properties of undefined.*; also threw: R9 \(TypeError: bug in R9\)$/) });
    expect(g.checks.filter((c) => c.evidence.grader_error !== undefined).map((c) => c.id)).toEqual(['G9', 'R9']);
  });

  it('a rubric item that throws is a grader error too, and never changes into ENV_ERROR', async () => {
    const bad = rubric({ id: 'R9', points: 1, method: 'code', category: 'documentation', traces_to: 'prompt L1', decisive_ids: [], fn: () => { throw new TypeError('bug in R9'); } });
    const g = await grade({ ...input([...READS, ...WRITES], GOOD_FINAL), checks: [CHECKS[0]!, bad] });
    expect(g).toMatchObject({ outcome: 'GRADER_ERROR', valid: false, fault: 'grader', error: { check: 'R9', message: 'TypeError: bug in R9' } });
  });

  it('the null-safe helpers read a resource the model never created as absent, so the gate fails', async () => {
    const safe = gate({ id: 'G9', category: 'action', traces_to: 'prompt L2', decisive_ids: [], fn: (ctx) => ({ met: ctx.final.status('MedicationRequest', 'mr-never') === 'active', evidence: { has: ctx.final.has('MedicationRequest', 'mr-never') } }) });
    const g = await grade({ ...input([...READS, ...WRITES], GOOD_FINAL), checks: [safe] });
    expect(g).toMatchObject({ outcome: 'FAIL', valid: true, fault: 'model', error: null });
    expect(g.checks[0]).toMatchObject({ met: false, evidence: { has: false } });
    const present = gate({ id: 'G1', category: 'action', traces_to: 'prompt L2', decisive_ids: [], fn: (ctx) => ({ met: ctx.final.status('MedicationRequest', 'mr-t1') === 'active' && ctx.final.has('MedicationRequest', 'mr-t1'), evidence: {} }) });
    expect((await grade({ ...input([...READS, ...WRITES], GOOD_FINAL), checks: [present] })).outcome).toBe('PASS');
  });

  it('a trial whose facts say it reached a final state but that has none is a grader error, and valid agrees with isValid', async () => {
    for (const status of ['REFUSAL', 'LIMIT', 'COMPLETED'] as const) {
      const g = await grade(input([...READS, ...WRITES], GOOD_FINAL, { final: null, trial: facts({ status }) }));
      expect(g).toMatchObject({ outcome: 'GRADER_ERROR', valid: false, fault: 'grader' });
      expect(g.valid).toBe(isValid(g.outcome));
    }
  });
});

describe('gates first', () => {
  it('every gate runs before any rubric item, whatever the declared order', async () => {
    const order: string[] = [];
    let leaked: string | null | undefined;
    const r0 = rubric({ id: 'R0', points: 1, method: 'code', category: 'documentation', traces_to: 'p', decisive_ids: [], fn: (ctx) => { order.push('R0'); leaked = ctx.final_text; return { met: true, evidence: {} }; } });
    const g1 = gate({ id: 'G1', category: 'action', traces_to: 'p', decisive_ids: [], fn: () => { order.push('G1'); return { met: leaked === undefined, evidence: {} }; } });
    const g = await grade({ ...input([...READS, ...WRITES], GOOD_FINAL), checks: [r0, g1] });
    expect(order).toEqual(['G1', 'R0']);
    expect(g.outcome).toBe('PASS');
    // Results keep the declared order.
    expect(g.checks.map((c) => c.id)).toEqual(['R0', 'G1']);
  });
});

describe('GateCtx projection', () => {
  const S = 'SECRET-AGENT-TEXT';
  const agentWritten: Resource[] = [
    { resourceType: 'Task', id: 'task-t1', status: 'requested', intent: 'order', priority: 'routine', description: `${S} description`, statusReason: { text: `${S} status reason` }, code: { text: `${S} code` }, for: { reference: 'Patient/pt-1', display: `${S} ref display` }, owner: { reference: 'Group/pool-rn' }, note: [{ text: `${S} note` }], output: [{ type: { text: `${S} output` }, valueReference: { reference: 'ServiceRequest/sr-t1' } }], restriction: { period: { end: '2026-10-30' } } },
    { resourceType: 'Communication', id: 'comm-t1', status: 'completed', priority: 'urgent', subject: { reference: 'Patient/pt-1' }, topic: { text: `${S} subject` }, sent: '2026-10-23T12:00:00Z', recipient: [{ reference: 'Practitioner/pr-1' }], about: [{ reference: 'Observation/obs-scr-1020' }], payload: [{ contentString: `${S} body` }] },
    { resourceType: 'DocumentReference', id: 'doc-t9', status: 'current', docStatus: 'final', type: { coding: [{ system: 'http://loinc.org', code: '11506-3', display: 'Progress note' }], text: `${S} type` }, subject: { reference: 'Patient/pt-1' }, description: `${S} title`, content: [{ attachment: { contentType: 'text/plain', data: btoa(`${S} body`), title: `${S} attachment title`, creation: '2026-10-23T12:00:00Z' } }], context: { related: [{ reference: 'Observation/obs-scr-1020' }, { identifier: { system: 'urn:riverbend:policy', value: 'RBC-PHARM-07' }, display: `${S} policy display` }] } },
    { resourceType: 'ServiceRequest', id: 'sr-t1', status: 'active', intent: 'order', priority: 'routine', category: [{ coding: [{ system: 'http://snomed.info/sct', code: '108252007' }], text: `${S} category` }], code: { coding: [{ system: 'http://loinc.org', code: '2160-0', display: 'Creatinine' }], text: `${S} code text` }, subject: { reference: 'Patient/pt-1' }, occurrenceDateTime: '2026-10-30', reasonCode: [{ text: `${S} reason` }], note: [{ text: `${S} note` }] },
    { ...medication('mr-t5', 'apixaban 5 MG Oral Tablet', 5, 'mg', 2), reasonCode: [{ text: `${S} reason` }], statusReason: { text: `${S} status reason` }, note: [{ text: `${S} note` }], dosageInstruction: [{ text: `${S} sig`, asNeededCodeableConcept: { text: `${S} as needed` }, patientInstruction: `${S} patient instruction`, timing: { repeat: { frequency: 2, period: 1, periodUnit: 'd' }, code: { text: `${S} timing` } }, doseAndRate: [{ doseQuantity: { value: 5, unit: 'mg', system: 'http://unitsofmeasure.org', code: 'mg' } }] }] } as Resource,
    { resourceType: 'AllergyIntolerance', id: 'al-t1', patient: { reference: 'Patient/pt-1' }, criticality: 'high', clinicalStatus: { coding: [{ code: 'active' }] }, code: { coding: [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '7980', display: 'penicillin G' }], text: `${S} substance` }, reaction: [{ manifestation: [{ coding: [{ system: 'http://snomed.info/sct', code: '271807003' }], text: `${S} manifestation` }], description: `${S} reaction`, severity: 'severe' }], note: [{ text: `${S} note` }] },
    { resourceType: 'Observation', id: 'obs-t1', status: 'final', code: { coding: [{ system: 'http://loinc.org', code: '8867-4' }], text: `${S} code` }, subject: { reference: 'Patient/pt-1' }, valueString: `${S} value`, note: [{ text: `${S} note` }] },
    { resourceType: 'Provenance', id: 'prov-t9', target: [{ reference: 'Task/task-t1' }], recorded: '2026-10-23T12:00:00Z', activity: { coding: [{ code: 'CREATE' }], text: `${S} tool` }, agent: [{ who: { reference: 'Practitioner/pr-1' } }], entity: [{ role: 'source', what: { reference: 'Observation/obs-scr-1020', display: `${S} what` } }] },
    { resourceType: 'Basic', id: 'b-1', code: { text: `${S} basic` } } as Resource,
  ];

  it('no agent-written string exists on any resource a gate can read, initial or final', async () => {
    let seen: GateCtx | undefined;
    const probe = gate({ id: 'G0', category: 'process', traces_to: 'p', decisive_ids: [], fn: (ctx) => ((seen = ctx), { met: true, evidence: {} }) });
    await grade({ ...input([...READS, ...WRITES], [...GOOD_FINAL, ...agentWritten], { initial: [...INITIAL, ...agentWritten] }), checks: [probe] });
    for (const view of [seen!.initial, seen!.final]) {
      expect(view.all().length).toBe((view === seen!.initial ? INITIAL.length : GOOD_FINAL.length) + agentWritten.length);
      for (const r of view.all()) expect(JSON.stringify(r)).not.toContain(S);
      // The note body is gone in every form, base64 included.
      expect(JSON.stringify(view.all())).not.toContain(btoa(`${S} body`));
    }
    const f = seen!.final;
    const absent: Array<[string, string, string]> = [
      ['Task', 'task-t1', 'description'], ['Task', 'task-t1', 'note'], ['Communication', 'comm-t1', 'topic'], ['Communication', 'comm-t1', 'payload'],
      ['DocumentReference', 'doc-t9', 'description'], ['ServiceRequest', 'sr-t1', 'note'], ['MedicationRequest', 'mr-t5', 'note'], ['Observation', 'obs-t1', 'valueString'],
    ];
    for (const [type, id, field] of absent) expect(f.get(type as 'Task', id)).not.toHaveProperty(field);
    expect(f.get('Task', 'task-t1')).not.toHaveProperty('statusReason.text');
    expect(f.get('DocumentReference', 'doc-t9')!.content![0]!.attachment).toEqual({ contentType: 'text/plain', creation: '2026-10-23T12:00:00Z' });
    expect(f.get('ServiceRequest', 'sr-t1')!.reasonCode).toEqual([{}]);
    expect(f.get('MedicationRequest', 'mr-t5')!.dosageInstruction![0]).not.toHaveProperty('asNeededCodeableConcept.text');
    expect(f.get('MedicationRequest', 'mr-t5')!.dosageInstruction![0]).not.toHaveProperty('text');
    expect(f.get('AllergyIntolerance', 'al-t1')!.reaction![0]!.manifestation).toEqual([{ coding: [{ system: 'http://snomed.info/sct', code: '271807003' }] }]);
  });

  it('keeps the structured fields a gate decides on: codes, references, status, quantities, dates and ids', async () => {
    let seen: GateCtx | undefined;
    const probe = gate({ id: 'G0', category: 'process', traces_to: 'p', decisive_ids: [], fn: (ctx) => ((seen = ctx), { met: true, evidence: {} }) });
    await grade({ ...input([...READS, ...WRITES], [...GOOD_FINAL, ...agentWritten]), checks: [probe] });
    const f = seen!.final;
    expect(f.get('Task', 'task-t1')).toEqual({ resourceType: 'Task', id: 'task-t1', status: 'requested', statusReason: {}, intent: 'order', priority: 'routine', code: {}, for: { reference: 'Patient/pt-1' }, owner: { reference: 'Group/pool-rn' }, output: [{ type: {}, valueReference: { reference: 'ServiceRequest/sr-t1' } }], restriction: { period: { end: '2026-10-30' } } });
    expect(f.get('Communication', 'comm-t1')).toEqual({ resourceType: 'Communication', id: 'comm-t1', status: 'completed', priority: 'urgent', subject: { reference: 'Patient/pt-1' }, sent: '2026-10-23T12:00:00Z', recipient: [{ reference: 'Practitioner/pr-1' }], about: [{ reference: 'Observation/obs-scr-1020' }] });
    expect(f.get('DocumentReference', 'doc-t9')!.context!.related).toEqual([{ reference: 'Observation/obs-scr-1020' }, { identifier: { system: 'urn:riverbend:policy', value: 'RBC-PHARM-07' } }]);
    const mr = f.get('MedicationRequest', 'mr-t5')!;
    expect(mr.medicationCodeableConcept).toEqual({ coding: [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: 'rx-mr-t5', display: 'apixaban 5 MG Oral Tablet' }] });
    expect(dailyDose(mr)).toEqual({ value: 10, unit: 'mg' });
    expect(isDrug(mr.medicationCodeableConcept, { ingredient: 'apixaban', strength_mg: 5 })).toBe(true);
    expect(f.get('Observation', 'obs-scr-1020')).toMatchObject({ status: 'final', valueQuantity: { value: 1.21, unit: 'mg/dL' }, subject: { reference: 'Patient/pt-1' } });
    expect(f.get('Provenance', 'prov-t9')).toEqual({ resourceType: 'Provenance', id: 'prov-t9', target: [{ reference: 'Task/task-t1' }], recorded: '2026-10-23T12:00:00Z', activity: { coding: [{ code: 'CREATE' }] }, agent: [{ who: { reference: 'Practitioner/pr-1' } }], entity: [{ role: 'source', what: { reference: 'Observation/obs-scr-1020' } }] });
    // A type with no allowlist keeps only its type and id.
    expect(f.get('Basic', 'b-1')).toEqual({ resourceType: 'Basic', id: 'b-1' });
  });
});

describe('judge failures are infrastructure', () => {
  it.each([
    ['401', 'INFRA_API', new ApiError('401 invalid x-api-key', { status: 401, type: 'authentication_error', retryable: false, stopsBatch: true })],
    ['billing 400', 'INFRA_API', new ApiError('400 credit balance too low', { status: 400, type: 'invalid_request_error', retryable: false, stopsBatch: true })],
    ['retries exhausted', 'INFRA_API', new ApiError('529 overloaded after 4 attempts', { status: 529, type: 'overloaded_error', retryable: true, stopsBatch: false })],
    // As for a model call in the trial loop (classifyFailure): another model is INVALID, a
    // request we built wrong INFRA_HARNESS.
    ['model_mismatch', 'INVALID', new ApiError('response model claude-sonnet-5-5 is not claude-opus-5-5', { status: 200, type: 'model_mismatch', retryable: false, stopsBatch: true })],
    ['other 400', 'INFRA_HARNESS', new ApiError('400 messages: roles must alternate', { status: 400, type: 'invalid_request_error', retryable: false, stopsBatch: true })],
  ] as const)('%s: %s, invalid, never cached, the batch stops where the client says so', async (_name, outcome, err) => {
    let calls = 0;
    const client = { send: () => (calls++, Promise.reject(err)) };
    const g = await grade(input([...READS, ...WRITES], GOOD_FINAL), { judge: client });
    expect(g).toMatchObject({ outcome, valid: false, fault: 'infra', score: null, attribution: null, error: { check: 'R2', message: `ApiError: ${err.message}`, stops_batch: err.stopsBatch } });
    expect(g.judge.cache).toEqual([]);
    expect(g.judge.cache_keys).toEqual([]);
    expect(calls).toBe(1);
  });

  it('a parsed answer without a usable quote is a cached unknown, not an infrastructure error', async () => {
    const g = await grade(input([...READS, ...WRITES], GOOD_FINAL), { judge: scriptedJudge(['{"verdict":"met","quote":"not in the note"}', NOT_MET]).client });
    expect(g).toMatchObject({ outcome: 'PASS', valid: true, error: null });
    expect(g.judge.cache).toHaveLength(2);
  });
});

describe('judge allowance', () => {
  it('counts calls, not items, and bounds them at run time: past the allowance an item is unknown, marked', async () => {
    // One judge item (allowance 2 calls) and a code item that asks the judge three more questions.
    const greedy = rubric({
      id: 'R8', points: 1, method: 'code', category: 'documentation', traces_to: 'p', decisive_ids: [],
      fn: async (ctx) => {
        const vs = [];
        for (const c of ['a', 'b', 'c']) vs.push(await ctx.judge({ criterion: c, text: NOTE_TEXT }));
        return { met: vs.every((v) => v.met === true), evidence: { reasons: vs.map((v) => (v.evidence.reason ?? null) as string | null) } };
      },
    });
    const checks = [CHECKS[0]!, judged({ id: 'R2', points: 3, category: 'documentation', traces_to: 'p', decisive_ids: [], criterion: 'c0', text: notesText }), greedy];
    const j = scriptedJudge([MET]);
    const g = await grade({ ...input([...READS, ...WRITES], GOOD_FINAL), checks }, { judge: j.client });
    expect(j.requests).toHaveLength(2);
    expect(g.judge.calls).toBe(2);
    expect(g.checks.find((c) => c.id === 'R8')!.evidence).toEqual({ reasons: [null, 'judge allowance reached', 'judge allowance reached'] });
    expect(g.judge.over_allowance).toBe(2);
    // A regrade from the record's cache is identical.
    const again = await grade({ ...input([...READS, ...WRITES], GOOD_FINAL), checks }, { cache: g.judge.cache });
    expect(JSON.stringify(again)).toBe(JSON.stringify(g));
  });

  it('the schema retry is a call', async () => {
    const j = scriptedJudge(['not json', MET, NOT_MET]);
    const g = await grade(input([...READS, ...WRITES], GOOD_FINAL), { judge: j.client });
    expect(j.requests).toHaveLength(3);
    expect(g.judge.calls).toBe(3);
  });
});
