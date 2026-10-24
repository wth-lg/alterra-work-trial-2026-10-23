// explainTrial (plan phase P14a): outcome, fault, audit label, decisive check, reason and the
// M1-M5 criteria of one trial record, from its current grade, so the UI, audit-check, the
// auditor prompt and the writeup cannot disagree. One fixture per outcome and per taxonomy.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { explainTrial, formatCriterion, NOT_AUDITED_MARKER, type AuditRow, type ExplainContext, type ExplainRecord } from '../explain.ts';
import { OUTCOMES, type Outcome } from '../outcomes.ts';
import { TAXONOMY, type Taxonomy } from '../../grader/attribution.ts';
import { repoRoot } from '../../../scripts/test/helpers.ts';

const MANIFEST = 'h-manifest';
const V = 'v-1';
const NOT_IN_WORLD = 'Observation/obs-not-in-world';
const ctx: ExplainContext = {
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
    const broken = explainTrial(record('FAIL'), undefined, { ...ctx, matrix: { task_version: V, oracle_pass: true, alternatives_pass: false } }).criteria.find((c) => c.id === 'M4')!;
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

  it('an auditor that disagrees needs an adjudication that says model for M5', () => {
    const disagree = { ...agreeing, llm_auditor_agrees: false };
    expect(explainTrial(record('FAIL'), disagree, ctx).criteria.find((c) => c.id === 'M5')!.met).toBe(false);
    expect(explainTrial(record('FAIL'), { ...disagree, adjudication: 'model: the weight was in view at step 6' }, ctx).criteria.find((c) => c.id === 'M5')!.met).toBe(true);
    expect(explainTrial(record('FAIL'), { ...agreeing, model_fault: 'no' }, ctx).criteria.find((c) => c.id === 'M5')!.met).toBe(false);
  });

  it('an audit GRADER_BUG with evidence makes the fault grader', () => {
    const x = explainTrial(record('FAIL'), { ...agreeing, outcome: 'GRADER_BUG', taxonomy: null, model_fault: 'no' }, ctx);
    expect(x.fault).toBe('grader');
    expect(x.label).toBe('grader');
    const noEvidence = explainTrial(record('FAIL'), { ...agreeing, outcome: 'GRADER_BUG', taxonomy: null, model_fault: 'no', evidence_ids: [] }, ctx);
    expect(noEvidence.fault).toBe('model');
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
