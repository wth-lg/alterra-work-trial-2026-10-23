// explainTrial (plan phase P14a): outcome, fault, audit label, decisive check, reason and the
// M1-M5 criteria of one trial record, from its current grade, so the UI, audit-check, the
// auditor prompt and the writeup cannot disagree. One fixture per outcome and per taxonomy.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { auditLabelOf, blocksRun, explainTrial, formatCriterion, NOT_AUDITED_MARKER, type AuditRow, type ExplainContext, type ExplainRecord } from '../explain.ts';
import { CONFIRMATION_CRITERIA, FAULT_DEFINITIONS, FAULT_PRECEDENCE, OUTCOMES, type Fault, type Outcome } from '../outcomes.ts';
import { TAXONOMY, type Taxonomy } from '../../grader/attribution.ts';
import { repoRoot } from '../../../scripts/test/helpers.ts';

const MANIFEST = 'h-manifest';
const V = 'v-1';
const NOT_IN_WORLD = 'Observation/obs-not-in-world';
const ctx: ExplainContext = {
  events: [],
  world_state_hash: MANIFEST,
  exposable: (id) => id !== NOT_IN_WORLD,
  matrix: { task_version: V, oracle_pass: true, alternatives_pass: true },
  checks: [
    { id: 'G1', traces_to: 'RBC-PHARM-07 §2' },
    { id: 'note_on_patient', traces_to: 'prompt line 3' },
  ],
};

const gate = (id: string, met: boolean, evidence: Record<string, unknown> = {}, category = 'action') => ({ id, kind: 'gate', method: 'code', category, points: null, met, evidence });
const G1_FAILED = gate('G1', false, { expected: 'apixaban 5 mg 2/day', found: 'apixaban 2.5 mg 2/day' });

function record(outcome: Outcome, over: Partial<ExplainRecord> = {}): ExplainRecord {
  const valid = ['REFUSAL', 'LIMIT', 'FAIL', 'PASS'].includes(outcome);
  const statusOf: Record<string, string> = { FAIL: 'COMPLETED', PASS: 'COMPLETED', GRADER_ERROR: 'COMPLETED' };
  return {
    task_id: 'renal-dose-review', task_version: V, outcome, valid, status: statusOf[outcome] ?? outcome, detail: null,
    turns: 12, cost_usd: 0.8, started: '2026-10-24T00:00:00.000Z', ended: '2026-10-24T00:05:00.000Z', summary: null, refusal_category: null,
    tool_errors: { INVALID_INPUT: 0, NOT_FOUND: 0, CONFLICT: 0, NOT_SUPPORTED: 0, INTERNAL: 0 },
    state_hash: { initial: MANIFEST, final: 'h-final', replay_final: 'h-final' },
    checks: outcome === 'FAIL' ? [G1_FAILED, gate('note_on_patient', true)] : outcome === 'PASS' ? [gate('G1', true), gate('note_on_patient', true)] : [],
    attribution: outcome === 'FAIL' ? { auto: 'reasoning', first_failed: 'G1', decisive_step: 9, exposure: [{ id: 'Observation/obs-wt-1', first_exposed_step: 6 }] } : null,
    error: null,
    ...over,
  };
}

type Exposure = Array<{ id: string; first_exposed_step: number | null }>;
const failWith = (auto: Taxonomy, exposure: Exposure = [{ id: 'Observation/obs-wt-1', first_exposed_step: 6 }]) =>
  record(auto === 'did_not_finish' ? 'LIMIT' : 'FAIL', {
    checks: [G1_FAILED],
    attribution: { auto, first_failed: 'G1', decisive_step: 9, exposure },
    ...(auto === 'did_not_finish' ? { status: 'LIMIT', detail: 'turns', turns: 80 } : {}),
  });

const words = (s: string) => s.trim().split(/\s+/).length;
const contract = readFileSync(join(repoRoot, 'docs/requirements/ui-contract.md'), 'utf8');
// The reason pattern under the contract's Patterns: the backticked regex that matches all three forms.
const REASON = new RegExp(/`(\\b\(\?:\[A-Za-z\][^`]*refused: \))`/.exec(contract)![1]!);
const CHECK_ID = /^[A-Za-z][A-Za-z0-9_]*$/;

const refusalEvents = [
  { v: 2, seq: 1, ts: '2026-10-24T00:00:00.000Z', turn: 1, type: 'response', id: 'msg_1', model: 'claude-opus-5-5', stop_reason: 'refusal', stop_details: { category: 'cyber', explanation: null },
    content: [{ type: 'text', text: 'I cannot help with changing these medication orders because they need a licensed prescriber to sign off first.' }], usage: {}, attempts: 1, cost_usd: 0.01 },
] as unknown as NonNullable<ExplainContext['events']>;
const limitEvent = (limit: string, cap: number, value: number) =>
  [{ v: 2, seq: 1, ts: '2026-10-24T00:00:00.000Z', turn: 1, type: 'limit', limit, cap, value }] as unknown as NonNullable<ExplainContext['events']>;

describe('explainTrial: one fixture per outcome', () => {
  const cases: Array<{ outcome: Outcome; rec: ExplainRecord; c?: ExplainContext; fault: string | null; label: string | null; subtype?: string | null; valid: boolean; check: string | null; reason: RegExp }> = [
    { outcome: 'INVALID', rec: record('INVALID', { detail: 'model_mismatch' }), fault: 'infra', label: null, valid: false, check: null, reason: /^INVALID\b.*model_mismatch/ },
    { outcome: 'INFRA_HARNESS', rec: record('INFRA_HARNESS', { detail: 'worker_crash' }), fault: 'infra', label: null, valid: false, check: null, reason: /^INFRA_HARNESS\b.*worker_crash/ },
    { outcome: 'INFRA_API', rec: record('INFRA_API', { detail: 'overloaded' }), fault: 'infra', label: null, valid: false, check: null, reason: /^INFRA_API\b.*overloaded/ },
    { outcome: 'CANCELLED', rec: record('CANCELLED'), fault: 'infra', label: null, valid: false, check: null, reason: /^CANCELLED\b/ },
    { outcome: 'ENV_ERROR', rec: record('ENV_ERROR', { detail: 'INTERNAL', tool_errors: { INTERNAL: 1 }, state_hash: { initial: MANIFEST, final: null, replay_final: null } }), fault: 'env', label: 'environment', valid: false, check: null, reason: /^ENV_ERROR\b.*INTERNAL/ },
    { outcome: 'GRADER_ERROR', rec: record('GRADER_ERROR', { valid: false, error: { check: 'G1', message: 'TypeError: cannot read mg', stops_batch: false } }), fault: 'grader', label: 'grader', valid: false, check: null, reason: /^GRADER_ERROR\b.*G1 threw/ },
    { outcome: 'REFUSAL', rec: record('REFUSAL', { refusal_category: 'cyber' }), c: { ...ctx, events: refusalEvents }, fault: 'refusal', label: 'model', subtype: 'refusal', valid: true, check: null, reason: /^refused: I cannot help with changing these medication orders because they need a$/ },
    { outcome: 'LIMIT', rec: record('LIMIT', { detail: 'turns', turns: 80 }), c: { ...ctx, events: limitEvent('turns', 80, 80) }, fault: 'model', label: 'model', valid: true, check: null, reason: /^turn limit reached: 80 turns$/ },
    { outcome: 'FAIL', rec: record('FAIL'), fault: 'model', label: 'model', valid: true, check: 'G1', reason: /^G1 failed: expected apixaban 5 mg 2\/day, found apixaban 2\.5 mg 2\/day; .*reasoning/ },
    { outcome: 'PASS', rec: record('PASS'), fault: null, label: null, valid: true, check: null, reason: /^PASS\b/ },
  ];

  it('covers all ten outcomes', () => expect(cases.map((c) => c.outcome).sort()).toEqual([...OUTCOMES].sort()));

  it.each(cases)('$outcome gives fault $fault, label $label and its reason', ({ outcome, rec, c, fault, label, subtype, valid, check, reason }) => {
    const x = explainTrial(rec, undefined, c ?? ctx);
    expect(x.outcome).toBe(outcome);
    expect(x.fault).toBe(fault);
    expect(x.label).toBe(label);
    expect(x.label_subtype).toBe(subtype ?? null);
    expect(x.valid).toBe(valid);
    expect(x.decisive_check?.id ?? null).toBe(check);
    expect(x.reason).toMatch(reason);
    expect(words(x.reason)).toBeLessThanOrEqual(25);
    if (check !== null) expect(x.decisive_check).toEqual({ id: 'G1', traces_to: 'RBC-PHARM-07 §2', expected: 'apixaban 5 mg 2/day', found: 'apixaban 2.5 mg 2/day' });
  });
});

describe('explainTrial: one fixture per taxonomy', () => {
  it.each(TAXONOMY.map((t) => [t]))('%s names the decisive check with its expected and found values and the taxonomy', (auto) => {
    const exposure: Exposure = auto === 'retrieval' ? [{ id: 'Observation/obs-wt-1', first_exposed_step: null }] : [{ id: 'Observation/obs-wt-1', first_exposed_step: 6 }];
    const x = explainTrial(failWith(auto, exposure), undefined, ctx);
    expect(x.taxonomy).toBe(auto);
    expect(x.fault).toBe('model');
    expect(x.decisive_check?.id).toBe('G1');
    expect(x.decisive_step).toBe(9);
    expect(x.reason).toMatch(/^G1 failed: expected apixaban 5 mg 2\/day, found apixaban 2\.5 mg 2\/day; /);
    expect(x.reason).toContain(auto.replace(/_/g, ' '));
    expect(words(x.reason)).toBeLessThanOrEqual(25);
  });
});

describe('explainTrial: criteria', () => {
  it('a FAIL whose decisive id was never exposed is retrieval, with M1 met through "exposable"', () => {
    const x = explainTrial(failWith('retrieval', [{ id: 'Observation/obs-wt-1', first_exposed_step: null }]), undefined, ctx);
    expect(x.taxonomy).toBe('retrieval');
    const m1 = x.criteria.find((c) => c.id === 'M1')!;
    expect(m1.met).toBe(true);
    expect(m1.evidence).toMatch(/exposable/);
  });

  it('a decisive id that was never exposed and is not in the world leaves M1 not met', () => {
    const x = explainTrial(failWith('retrieval', [{ id: NOT_IN_WORLD, first_exposed_step: null }]), undefined, ctx);
    const m1 = x.criteria.find((c) => c.id === 'M1')!;
    expect(m1.met).toBe(false);
    expect(m1.evidence).toMatch(new RegExp(`${NOT_IN_WORLD}.*never exposed.*not exposable`));
  });

  it('one INTERNAL tool error makes the fault env, with M2 not met and the label environment', () => {
    const x = explainTrial(record('FAIL', { tool_errors: { INTERNAL: 1 } }), undefined, ctx);
    expect(x.fault).toBe('env');
    expect(x.label).toBe('environment');
    expect(x.criteria.find((c) => c.id === 'M2')!.met).toBe(false);
    // A valid non-pass trial still gets the check form of the reason.
    expect(x.reason).toMatch(REASON);
    expect(x.reason).toMatch(/environment/);
  });

  it('an initial hash that is not the manifest, or a replay mismatch, leaves M3 not met and the fault env', () => {
    const drift = explainTrial(record('FAIL', { state_hash: { initial: 'h-other', final: 'h-final', replay_final: 'h-final' } }), undefined, ctx);
    expect(drift.fault).toBe('env');
    expect(drift.criteria.find((c) => c.id === 'M3')!.met).toBe(false);
    const replay = explainTrial(record('FAIL', { state_hash: { initial: MANIFEST, final: 'h-final', replay_final: 'h-other' } }), undefined, ctx);
    expect(replay.fault).toBe('env');
    expect(replay.criteria.find((c) => c.id === 'M3')!.met).toBe(false);
  });

  it('M4 reads the matrix of the same task_version: an oracle or alternative failure is not met; another version is pending', () => {
    const met = explainTrial(record('FAIL'), undefined, ctx).criteria.find((c) => c.id === 'M4')!;
    expect(met.met).toBe(true);
    const broken = explainTrial(record('FAIL'), undefined, { ...ctx, matrix: { task_version: V, oracle_pass: true, alternatives_pass: false, failed_checks: ['G1'] } }).criteria.find((c) => c.id === 'M4')!;
    expect(broken.met).toBe(false);
    const other = explainTrial(record('FAIL'), undefined, { ...ctx, matrix: { task_version: 'v-0', oracle_pass: true, alternatives_pass: true } }).criteria.find((c) => c.id === 'M4')!;
    expect(other.met).toBe('pending');
  });

  it('with no audit row: audited false, M1-M4 evaluated and M5 pending', () => {
    const x = explainTrial(record('FAIL'), undefined, ctx);
    expect(x.audited).toBe(false);
    expect(x.criteria.map((c) => c.id)).toEqual(['M1', 'M2', 'M3', 'M4', 'M5']);
    for (const c of x.criteria.slice(0, 4)) expect(c.met, `${c.id}: ${c.evidence}`).toBe(true);
    expect(x.criteria[4]!.met).toBe('pending');
    expect(formatCriterion(x.criteria[4]!)).toBe('M5: pending');
  });

  const agreeing: AuditRow = { trial: 'renal-dose-review/3', outcome: 'FAIL', taxonomy: 'reasoning', model_fault: 'yes', decisive_step: 9, evidence_ids: ['Observation/obs-wt-1'], llm_auditor_agrees: true };

  it('with an agreeing audit row: audited true and M5 met', () => {
    const x = explainTrial(record('FAIL'), agreeing, ctx);
    expect(x.audited).toBe(true);
    expect(x.criteria.find((c) => c.id === 'M5')!.met).toBe(true);
    expect(x.fault).toBe('model');
  });

  it('an auditor that disagrees needs adjudicated_label model for M5; the prose in note decides nothing', () => {
    const m5 = (row: AuditRow) => explainTrial(record('FAIL'), row, ctx).criteria.find((c) => c.id === 'M5')!;
    const disagree = { ...agreeing, llm_auditor_agrees: false };
    expect(m5(disagree).met).toBe(false);
    expect(m5({ ...disagree, adjudicated_label: 'model', note: 'the weight was in view at step 6' }).met).toBe(true);
    expect(m5({ ...agreeing, model_fault: 'no' }).met).toBe(false);
    // Probe D: the prose says "model" but the structured label says environment.
    expect(m5({ ...agreeing, model_fault: 'unclear', llm_auditor_agrees: false, adjudicated_label: 'environment', note: 'not the model; fixture bug' }).met).toBe(false);
    expect(m5({ ...agreeing, model_fault: 'unclear', llm_auditor_agrees: false, note: 'not the model; fixture bug' }).met).toBe(false);
  });

  it('a null LLM auditor verdict reads "no LLM auditor verdict" (probe E)', () => {
    const m5 = explainTrial(record('FAIL'), { ...agreeing, llm_auditor_agrees: null }, ctx).criteria.find((c) => c.id === 'M5')!;
    expect(m5.evidence).toMatch(/no LLM auditor verdict/);
    expect(m5.evidence).not.toMatch(/agrees/);
  });

  it('an audit GRADER_BUG with evidence makes the fault grader', () => {
    const x = explainTrial(record('FAIL'), { ...agreeing, outcome: 'GRADER_BUG', taxonomy: null, model_fault: 'no' }, ctx);
    expect(x.fault).toBe('grader');
    expect(x.label).toBe('grader');
    const noEvidence = explainTrial(record('FAIL'), { ...agreeing, outcome: 'GRADER_BUG', taxonomy: null, model_fault: 'no', evidence_ids: [] }, ctx);
    expect(noEvidence.fault).toBe('model');
    expect(noEvidence.confirmation).toBe('contradicted');
  });

  it('a regrade that ended GRADER_ERROR makes the fault grader', () => {
    const x = explainTrial(record('FAIL', { regrades: [{ outcome: 'GRADER_ERROR', valid: false, score: null, checks: [] }] }), undefined, ctx);
    expect(x.outcome).toBe('GRADER_ERROR');
    expect(x.fault).toBe('grader');
    expect(x.valid).toBe(false);
  });
});

describe('explainTrial: current grade', () => {
  it('reads the decisive check from the last regrade, not the recorded checks', () => {
    const regraded = record('FAIL', {
      regrades: [{ outcome: 'FAIL', valid: true, score: 0, checks: [gate('G1', true), gate('note_on_patient', false, { expected: 'a note on Patient/pt-1', found: 'a note on Patient/pt-2' })] }],
    });
    const x = explainTrial(regraded, undefined, ctx);
    expect(x.decisive_check).toEqual({ id: 'note_on_patient', traces_to: 'prompt line 3', expected: 'a note on Patient/pt-1', found: 'a note on Patient/pt-2' });
    expect(x.reason).toMatch(/^note_on_patient failed: expected a note on Patient\/pt-1, found a note on Patient\/pt-2/);
    // The recorded attribution names another check, so its taxonomy and step are not this check's.
    expect(x.taxonomy).toBeNull();
  });

  it('a FAIL regraded to PASS is a PASS, nobody\'s fault', () => {
    const x = explainTrial(record('FAIL', { regrades: [{ outcome: 'PASS', valid: true, score: 1, checks: [gate('G1', true)] }] }), undefined, ctx);
    expect(x).toMatchObject({ outcome: 'PASS', fault: null, label: null, decisive_check: null });
  });
});

describe('explainTrial: the UI contract strings', () => {
  const nonPass: ExplainRecord[] = [
    record('FAIL'),
    ...TAXONOMY.map((t) => failWith(t)),
    record('LIMIT', { detail: 'turns', turns: 80 }),
    record('LIMIT', { detail: 'cost', cost_usd: 6.01 }),
    record('LIMIT', { detail: 'wall_clock' }),
    record('LIMIT', { detail: 'max_tokens' }),
    record('REFUSAL', { refusal_category: 'cyber' }),
    record('REFUSAL', { checks: [G1_FAILED] }),
    record('FAIL', { checks: [gate('note_on_patient', false, { expected: 'x, y and z', found: 'x' })] }),
  ];

  it('every valid non-pass trial has a reason in one of the three contract forms, at most 25 words', () => {
    for (const r of nonPass) {
      const x = explainTrial(r, undefined, ctx);
      expect(x.valid).toBe(true);
      expect(x.reason, JSON.stringify(r.checks)).toMatch(REASON);
      expect(words(x.reason)).toBeLessThanOrEqual(25);
      if (x.decisive_check) expect(x.decisive_check.id).toMatch(CHECK_ID);
    }
  });

  it('builds the limit sentences from the limit event, as the contract writes them', () => {
    const at = (detail: string, events: NonNullable<ExplainContext['events']>) => explainTrial(record('LIMIT', { detail }), undefined, { ...ctx, events }).reason;
    expect(at('turns', limitEvent('turns', 80, 80))).toBe('turn limit reached: 80 turns');
    expect(at('cost', limitEvent('cost', 6, 6.0123))).toBe('cost limit reached: $6.01 of $6.00');
    expect(at('wall_clock', limitEvent('wall_clock', 1_800_000, 1_800_400))).toBe('time limit reached: 1800 s of 1800 s');
    expect(at('max_tokens', limitEvent('max_tokens', 1, 1))).toBe('output limit reached: 2 cut-off responses in a row');
  });

  it('caps a long check sentence at 25 words and keeps the check form', () => {
    const long = Array.from({ length: 40 }, (_, i) => `w${i}`).join(' ');
    const x = explainTrial(record('FAIL', { checks: [gate('G1', false, { expected: long, found: long })] }), undefined, ctx);
    expect(words(x.reason)).toBeLessThanOrEqual(25);
    expect(x.reason).toMatch(REASON);
  });

  it('reads expected and found from a range and a value when the check states no expected and found', () => {
    const x = explainTrial(record('FAIL', { checks: [gate('metformin_dose', false, { active: ['MedicationRequest/mr-1'], mg_per_day: 2550, range: { min: 1000, max: 2000 } })] }), undefined, ctx);
    expect(x.decisive_check).toMatchObject({ id: 'metformin_dose', expected: '1000-2000', found: '2550' });
    const extra = explainTrial(record('FAIL', { checks: [gate('no_other_changes', false, { extra: ['MedicationRequest/mr-9'] }, 'safety')] }), undefined, ctx);
    expect(extra.decisive_check).toMatchObject({ expected: 'none', found: 'MedicationRequest/mr-9' });
  });

  it('the not-human-audited marker and the criterion texts are the contract\'s', () => {
    expect(NOT_AUDITED_MARKER).toBe('not human-audited');
    expect(contract).toContain('`not human-audited`');
    const audited = explainTrial(record('FAIL'), { trial: 't/1', outcome: 'FAIL', taxonomy: 'reasoning', model_fault: 'yes', decisive_step: 9, evidence_ids: ['x'], llm_auditor_agrees: true }, ctx);
    for (const c of audited.criteria) expect(formatCriterion(c)).toMatch(new RegExp(`\\b${c.id}: (?:met|not met)\\b`));
  });
});

describe('explainTrial: the criteria decide the fault', () => {
  const crit = (x: ReturnType<typeof explainTrial>, id: string) => x.criteria.find((c) => c.id === id)!;

  it('probe A: a decisive id that is not in the world makes the fault env through E5, with M1 not met', () => {
    const x = explainTrial(failWith('retrieval', [{ id: NOT_IN_WORLD, first_exposed_step: null }]), undefined, ctx);
    expect(crit(x, 'M1').met).toBe(false);
    expect(x).toMatchObject({ fault: 'env', label: 'environment', deciding: { fault: 'env', id: 'E5' } });
    expect(x.deciding!.evidence).toMatch(new RegExp(`${NOT_IN_WORLD}.*not exposable`));
    expect(x.reason).toMatch(REASON);
    expect(x.reason).toMatch(/environment/);
  });

  it('probe B: an oracle or alternative that fails the matrix on the trial\'s task_version, on the check the trial failed, makes the fault grader through GR4, with M4 not met', () => {
    for (const matrix of [{ task_version: V, oracle_pass: false, alternatives_pass: true, failed_checks: ['G1'] }, { task_version: V, oracle_pass: true, alternatives_pass: false, failed_checks: ['G1'] }]) {
      const x = explainTrial(record('FAIL'), undefined, { ...ctx, matrix });
      expect(crit(x, 'M4').met).toBe(false);
      expect(x).toMatchObject({ fault: 'grader', label: 'grader', deciding: { fault: 'grader', id: 'GR4' } });
      expect(x.reason).toMatch(REASON);
    }
    // A matrix of another task_version decides nothing: M4 pending, the label provisional.
    const other = explainTrial(record('FAIL'), undefined, { ...ctx, matrix: { task_version: 'v-0', oracle_pass: false, alternatives_pass: false } });
    expect(other).toMatchObject({ fault: 'model', confirmation: 'provisional' });
  });

  it('probe G: a missing final state hash makes the fault env through E4, with M3 not met', () => {
    const x = explainTrial(record('FAIL', { state_hash: { initial: MANIFEST, final: null, replay_final: null } }), undefined, ctx);
    expect(crit(x, 'M3').met).toBe(false);
    expect(x).toMatchObject({ fault: 'env', deciding: { fault: 'env', id: 'E4' } });
    const noInitial = explainTrial(record('FAIL', { state_hash: { initial: null, final: 'h-final', replay_final: 'h-final' } }), undefined, ctx);
    expect(noInitial).toMatchObject({ fault: 'env', deciding: { id: 'E2' } });
  });

  it('when two faults apply, FAULT_PRECEDENCE decides and the other shows as a note', () => {
    const threwWithInternal = explainTrial(record('GRADER_ERROR', { error: { check: 'G1', message: 'TypeError', stops_batch: false }, tool_errors: { INTERNAL: 1 } }), undefined, ctx);
    expect(threwWithInternal).toMatchObject({ fault: 'grader', deciding: { fault: 'grader', id: 'GR1' } });
    expect(threwWithInternal.notes.map((n) => `${n.fault} ${n.id}`)).toEqual(['env E1']);
    const apiWithInternal = explainTrial(record('INFRA_API', { detail: 'overloaded', tool_errors: { INTERNAL: 2 } }), undefined, ctx);
    expect(apiWithInternal).toMatchObject({ fault: 'infra', label: null, deciding: { fault: 'infra', id: 'I3' } });
    expect(apiWithInternal.notes.map((n) => n.id)).toEqual(['E1']);
    const brokenMatrixAndInternal = explainTrial(record('FAIL', { tool_errors: { INTERNAL: 1 } }), undefined, { ...ctx, matrix: { task_version: V, oracle_pass: false, alternatives_pass: true, failed_checks: ['G1'] } });
    expect(brokenMatrixAndInternal).toMatchObject({ fault: 'grader', deciding: { id: 'GR4' } });
    expect(brokenMatrixAndInternal.notes.map((n) => n.id)).toEqual(['E1']);
    expect(FAULT_PRECEDENCE.indexOf('grader')).toBeLessThan(FAULT_PRECEDENCE.indexOf('env'));
  });

  it('every model criterion that is not met makes a deciding criterion of another fault hold, so a model label never sits next to M1-M4 not met', () => {
    const variants: Array<{ rec: ExplainRecord; c: ExplainContext }> = [];
    const states = [
      { initial: MANIFEST, final: 'h-final', replay_final: 'h-final' }, { initial: 'h-other', final: 'h-final', replay_final: 'h-final' },
      { initial: MANIFEST, final: 'h-final', replay_final: 'h-other' }, { initial: null, final: 'h-final', replay_final: 'h-final' }, { initial: MANIFEST, final: null, replay_final: null },
    ];
    const exposures: Exposure[] = [[{ id: 'Observation/obs-wt-1', first_exposed_step: 6 }], [{ id: 'Observation/obs-wt-1', first_exposed_step: null }], [{ id: NOT_IN_WORLD, first_exposed_step: null }]];
    const matrices = [ctx.matrix!, { task_version: V, oracle_pass: false, alternatives_pass: true, failed_checks: ['G1'] }, { task_version: V, oracle_pass: true, alternatives_pass: false, failed_checks: ['G1'] }];
    for (const state_hash of states) for (const exposure of exposures) for (const matrix of matrices) for (const INTERNAL of [0, 1]) {
      variants.push({ rec: { ...failWith('reasoning', exposure), state_hash, tool_errors: { INTERNAL } }, c: { ...ctx, matrix } });
    }
    for (const { rec, c } of variants) {
      const x = explainTrial(rec, undefined, c);
      const notMet = x.criteria.filter((m) => m.met === false).map((m) => m.id);
      if (notMet.length > 0) expect(x.fault, `${JSON.stringify(rec.state_hash)} ${notMet.join(',')}`).not.toBe('model');
      else expect(x.fault).toBe('model');
    }
  });

  it('confirmation: provisional without an audit or with a criterion pending, confirmed when M1-M5 are met, contradicted by a disagreeing audit', () => {
    const agreeing: AuditRow = { trial: 'renal-dose-review/3', outcome: 'FAIL', taxonomy: 'reasoning', model_fault: 'yes', decisive_step: 9, evidence_ids: ['Observation/obs-wt-1'], llm_auditor_agrees: true };
    expect(explainTrial(record('FAIL'), undefined, ctx).confirmation).toBe('provisional');
    expect(explainTrial(record('FAIL'), agreeing, ctx).confirmation).toBe('confirmed');
    expect(explainTrial(record('FAIL'), agreeing, { ...ctx, matrix: null }).confirmation).toBe('provisional');
    // Probe C: the audit says environment; the computed label stays, the disagreement is shown.
    const c = explainTrial(record('FAIL'), { ...agreeing, taxonomy: 'environment', model_fault: 'no' }, ctx);
    expect(c).toMatchObject({ fault: 'model', label: 'model', audit_label: 'environment', confirmation: 'contradicted' });
    // An env fault the record proves (E1) is confirmed without an audit and by one that says environment, contradicted by one that says model.
    const env = record('FAIL', { tool_errors: { INTERNAL: 1 } });
    expect(explainTrial(env, undefined, ctx).confirmation).toBe('confirmed');
    expect(explainTrial(env, { ...agreeing, label: 'environment', model_fault: 'no' }, ctx).confirmation).toBe('confirmed');
    expect(explainTrial(env, agreeing, ctx).confirmation).toBe('contradicted');
    // Infra is decided by the record alone; a PASS has no fault and no confirmation.
    expect(explainTrial(record('INFRA_API'), undefined, ctx).confirmation).toBe('confirmed');
    expect(explainTrial(record('PASS'), undefined, ctx).confirmation).toBeNull();
  });

  it('returns every fault\'s criteria with met or not met, and the criterion that decided', () => {
    const x = explainTrial(record('ENV_ERROR', { detail: 'invariant_broken', status: 'ENV_ERROR' }), undefined, ctx);
    expect(Object.keys(x.fault_criteria).sort()).toEqual([...FAULT_PRECEDENCE].sort());
    for (const f of FAULT_PRECEDENCE) expect(x.fault_criteria[f as Fault].map((c) => c.id)).toEqual(FAULT_DEFINITIONS[f as Fault].criteria.map((c) => c.id));
    expect(x.deciding).toMatchObject({ fault: 'env', id: 'E3' });
    expect(x.fault_criteria.env.find((c) => c.id === 'E3')!.met).toBe(true);
    expect(x.criteria.map((c) => c.id)).toEqual(CONFIRMATION_CRITERIA.map((c) => c.id));
  });

  it('the infra and refusal criteria read the observable record fields, not the outcome', () => {
    expect(explainTrial(record('INVALID', { status: 'COMPLETED', models_returned: ['claude-other'], model_requested: 'claude-opus-5-5' }), undefined, ctx).deciding).toMatchObject({ id: 'I1', evidence: expect.stringMatching(/claude-other/) });
    expect(explainTrial(record('INFRA_HARNESS'), undefined, ctx).deciding?.id).toBe('I2');
    expect(explainTrial(record('INFRA_API'), undefined, ctx).deciding?.id).toBe('I3');
    expect(explainTrial(record('CANCELLED'), undefined, ctx).deciding?.id).toBe('I4');
    expect(explainTrial(record('REFUSAL', { stop_reason: 'refusal' }), undefined, ctx).deciding).toMatchObject({ fault: 'refusal', id: 'R1', evidence: expect.stringMatching(/stop_reason refusal/) });
    expect(explainTrial(record('LIMIT', { detail: 'turns' }), undefined, ctx).deciding).toMatchObject({ fault: 'model', id: 'MF2' });
    expect(explainTrial(record('FAIL'), undefined, ctx).deciding).toMatchObject({ fault: 'model', id: 'MF1' });
  });

  it('M1 is not applicable when no gate check failed', () => {
    const x = explainTrial(record('LIMIT', { detail: 'turns' }), undefined, ctx);
    expect(crit(x, 'M1').met).toBe('n/a');
    expect(formatCriterion(crit(x, 'M1'))).toBe('M1: not applicable');
  });
});

describe('explainTrial: edge records (verifier P14a-1)', () => {
  it('an empty expected value reads "none"', () => {
    const x = explainTrial(record('FAIL', { checks: [gate('G1', false, { expected: '', found: 'x' })] }), undefined, ctx);
    expect(x.reason).toMatch(/^G1 failed: expected none, found x; /);
    expect(x.reason).toMatch(REASON);
  });

  it('a FAIL whose failed check has no kind falls back to the first check not met', () => {
    const x = explainTrial(record('FAIL', { checks: [{ id: 'G1', met: true }, { id: 'G2', met: false, evidence: { expected: 'a', found: 'b' } }], attribution: null }), undefined, ctx);
    expect(x.decisive_check?.id).toBe('G2');
    expect(x.reason).toMatch(REASON);
  });

  it('a PASS with an INTERNAL error stays a PASS with no fault; the environment criterion is a note', () => {
    const x = explainTrial(record('PASS', { tool_errors: { INTERNAL: 1 } }), undefined, ctx);
    expect(x).toMatchObject({ outcome: 'PASS', fault: null, label: null, deciding: null });
    expect(x.notes).toEqual([expect.objectContaining({ fault: 'env', id: 'E1' })]);
    expect(x.reason).toMatch(/^PASS: every gate check met; note E1/);
  });
});

describe('explainTrial: review round 3 (pr-review P14a-2)', () => {
  const crit = (x: ReturnType<typeof explainTrial>, id: string) => x.criteria.find((c) => c.id === id)!;
  const failsG1 = { task_version: V, oracle_pass: false, alternatives_pass: true, failed_checks: ['G1'] };
  const agreeing: AuditRow = { trial: 'renal-dose-review/3', outcome: 'FAIL', taxonomy: 'reasoning', model_fault: 'yes', decisive_step: 9, evidence_ids: ['Observation/obs-wt-1'], llm_auditor_agrees: true };

  it('D1: a refusal on a task whose oracle fails the matrix stays a refusal; the failing matrix is a run-level note B1', () => {
    const x = explainTrial(record('REFUSAL', { stop_reason: 'refusal', turns: 1, checks: [gate('G1', true)], summary: 'I cannot change medication orders without a prescriber.' }), undefined, { ...ctx, matrix: failsG1 });
    expect(x).toMatchObject({ fault: 'refusal', label: 'model', label_subtype: 'refusal', deciding: { id: 'R1' } });
    expect(x.notes.map((n) => `${n.fault} ${n.id}`)).toEqual(['grader B1']);
    expect(x.reason).toMatch(/^refused: I cannot change/);
    expect(blocksRun(x)).toMatch(/B1/);
  });

  it('D1b: a FAIL on another check than the one the matrix fails is the model\'s; the failing matrix is a note B1', () => {
    const rec = record('FAIL', { checks: [gate('note_on_patient', false, { extra: ['MedicationRequest/mr-9 deleted'] })], attribution: { auto: 'over_action', first_failed: 'note_on_patient', decisive_step: 4, exposure: [] } });
    const x = explainTrial(rec, undefined, { ...ctx, matrix: failsG1 });
    expect(x).toMatchObject({ fault: 'model', label: 'model', deciding: { id: 'MF1' } });
    expect(crit(x, 'M4').met).toBe(true);
    expect(x.notes.map((n) => n.id)).toEqual(['B1']);
    expect(x.reason).not.toMatch(/grader/);
    // The same matrix decides grader on a FAIL of the check it fails (GR4), and B1 is not repeated.
    const same = explainTrial(record('FAIL'), undefined, { ...ctx, matrix: failsG1 });
    expect(same).toMatchObject({ fault: 'grader', deciding: { id: 'GR4' } });
    expect(same.notes.map((n) => n.id)).toEqual([]);
    // A failing matrix that does not say which checks fail cannot decide a fault: M4 pending, B1 a note.
    const unknown = explainTrial(record('FAIL'), undefined, { ...ctx, matrix: { task_version: V, oracle_pass: false, alternatives_pass: true } });
    expect(unknown).toMatchObject({ fault: 'model', confirmation: 'provisional' });
    expect(crit(unknown, 'M4').met).toBe('pending');
    expect(unknown.notes.map((n) => n.id)).toEqual(['B1']);
    // A PASS on that task shows B1 as a note too.
    expect(explainTrial(record('PASS'), undefined, { ...ctx, matrix: failsG1 }).notes.map((n) => n.id)).toEqual(['B1']);
  });

  it('D2: one M5 rule: an adjudicated_label of model settles an unsure or disagreeing audit, and auditLabelOf returns it first', () => {
    const row: AuditRow = { ...agreeing, taxonomy: 'environment', label: 'environment', model_fault: 'unclear', llm_auditor_agrees: false, adjudicated_label: 'model' };
    const x = explainTrial(record('FAIL'), row, ctx);
    expect(x).toMatchObject({ label: 'model', audit_label: 'model', confirmation: 'confirmed' });
    expect(crit(x, 'M5').met).toBe(true);
    expect(auditLabelOf(row)).toBe('model');
    // Adjudicated environment on a model trial: the audit says environment, contradicted.
    const env = explainTrial(record('FAIL'), { ...agreeing, model_fault: 'unclear', adjudicated_label: 'environment' }, ctx);
    expect(env).toMatchObject({ audit_label: 'environment', confirmation: 'contradicted' });
    expect(crit(env, 'M5').met).toBe(false);
    // Without adjudication, model needs model_fault yes and an LLM auditor that does not disagree.
    expect(crit(explainTrial(record('FAIL'), { ...agreeing, model_fault: 'unclear' }, ctx), 'M5').met).toBe(false);
    expect(crit(explainTrial(record('FAIL'), { ...agreeing, llm_auditor_agrees: null }, ctx), 'M5').met).toBe(true);
  });

  it('D3: an environment- or grader-labelled valid failure is excluded from the headline and blocks the run', () => {
    const e5 = explainTrial(record('FAIL', { checks: [gate('G1', false, { expected: '500', found: '1000' })], attribution: { auto: 'retrieval', first_failed: 'G1', decisive_step: 9, exposure: [{ id: NOT_IN_WORLD, first_exposed_step: null }] } }), undefined, ctx);
    expect(e5).toMatchObject({ fault: 'env', label: 'environment', valid: true, outcome: 'FAIL' });
    expect(blocksRun(e5)).toMatch(/excluded from the headline denominator/);
    expect(blocksRun(explainTrial(record('FAIL'), undefined, { ...ctx, matrix: failsG1 }))).toMatch(/excluded from the headline denominator/);
    expect(blocksRun(explainTrial(record('FAIL'), undefined, ctx))).toBeNull();
    expect(blocksRun(explainTrial(record('PASS'), undefined, ctx))).toBeNull();
    // An excluded outcome is handled by its own rule (rerun, or summary's grader_error), not here.
    expect(blocksRun(explainTrial(record('INFRA_API'), undefined, ctx))).toBeNull();
  });

  it('F5: an env or grader label the record alone proves is confirmed; a judgment criterion waits for the audit', () => {
    const internal = explainTrial(record('ENV_ERROR', { detail: 'INTERNAL', tool_errors: { INTERNAL: 1 }, state_hash: { initial: MANIFEST, final: null, replay_final: null } }), undefined, ctx);
    expect(internal).toMatchObject({ fault: 'env', confirmation: 'confirmed' });
    const threw = explainTrial(record('GRADER_ERROR', { error: { check: 'G1', message: 'TypeError: x is undefined' } }), undefined, ctx);
    expect(threw).toMatchObject({ fault: 'grader', deciding: { id: 'GR1' }, confirmation: 'confirmed' });
    const regrade = explainTrial(record('FAIL', { regrades: [{ outcome: 'GRADER_ERROR', valid: false, score: null, checks: [] }] }), undefined, ctx);
    expect(regrade).toMatchObject({ deciding: { id: 'GR2' }, confirmation: 'confirmed' });
    const invariant = explainTrial(record('ENV_ERROR', { detail: 'invariant_broken' }), undefined, ctx);
    expect(invariant).toMatchObject({ deciding: { id: 'E3' }, confirmation: 'confirmed' });
    // E5 and GR4 are judgments over the world and the matrix: provisional until audited.
    const e5 = explainTrial(failWith('retrieval', [{ id: NOT_IN_WORLD, first_exposed_step: null }]), undefined, ctx);
    expect(e5).toMatchObject({ deciding: { id: 'E5' }, confirmation: 'provisional' });
    expect(explainTrial(record('FAIL'), undefined, { ...ctx, matrix: failsG1 }).confirmation).toBe('provisional');
    // A record-proven label is still contradicted by an audit that says otherwise.
    expect(explainTrial(record('GRADER_ERROR', { error: { check: 'G1', message: 'TypeError' } }), { ...agreeing, outcome: 'GRADER_ERROR' }, ctx).confirmation).toBe('contradicted');
  });

  it('verify m1: a valid record decided infra gets no taxonomy clause', () => {
    const x = explainTrial(failWith('retrieval', [{ id: 'Observation/x', first_exposed_step: null }]), undefined, { ...ctx, ...{} });
    const infra = explainTrial({ ...failWith('retrieval', [{ id: 'Observation/x', first_exposed_step: null }]), models_returned: ['claude-opus-5-5', 'claude-other'], model_requested: 'claude-opus-5-5' }, undefined, ctx);
    expect(x.reason).toMatch(/retrieval/);
    expect(infra).toMatchObject({ fault: 'infra', label: null });
    expect(infra.reason).not.toMatch(/retrieval/);
    expect(infra.reason).toMatch(REASON);
  });

  it('verify m3: I1 holds when the requested model is not MODEL, even if the API returned what was asked', () => {
    const x = explainTrial(record('FAIL', { model_requested: 'claude-other', models_returned: ['claude-other'] }), undefined, ctx);
    expect(x).toMatchObject({ fault: 'infra', deciding: { id: 'I1', evidence: expect.stringMatching(/claude-other/) } });
  });
});
