// The attribution definitions (plan phase P14a): one sentence and ordered criteria per Fault, the
// AUDIT_LABEL mapping to the three audit labels, and PASS_DEFINITION and DENOMINATOR_RULE built
// from the outcome table, so no surface lists them by hand.
import { describe, expect, it } from 'vitest';
import {
  AUDIT_LABEL, AUDIT_LABELS, CONFIRMATION_CRITERIA, CONFIRMATION_DEFINITIONS, DENOMINATOR_OPERATOR_NOTE, DENOMINATOR_RULE, FAULT, FAULT_DEFINITIONS, FAULT_PRECEDENCE,
  FAULT_PRECEDENCE_RULE, OUTCOMES, PASS_DEFINITION, RERUN_OUTCOMES, RUN_BLOCKS, VALID_OUTCOMES, isValid, type Fault,
} from '../outcomes.ts';

const FAULTS: Fault[] = ['model', 'refusal', 'env', 'grader', 'infra'];

describe('FAULT_DEFINITIONS', () => {
  it('gives every Fault one plain sentence and the criteria that decide it, each with an id, one sentence, the record fields it reads and a check', () => {
    expect(Object.keys(FAULT_DEFINITIONS).sort()).toEqual([...FAULTS].sort());
    const all = [...FAULTS.flatMap((f) => FAULT_DEFINITIONS[f].criteria), ...CONFIRMATION_CRITERIA, ...RUN_BLOCKS];
    for (const f of FAULTS) {
      expect(FAULT_DEFINITIONS[f].sentence).toMatch(/^[A-Z][^\n.]*\.$/);
      expect(FAULT_DEFINITIONS[f].criteria.length).toBeGreaterThan(0);
    }
    for (const c of all) {
      expect(c.id).toMatch(/^[A-Z]+[0-9]+$/);
      // One sentence: a capital, no full stop inside, a full stop at the end.
      expect(c.text, c.id).toMatch(/^[A-Z][^\n]*\.$/);
      expect(c.text.slice(0, -1), c.id).not.toMatch(/\.\s/);
      expect(c.reads.length, c.id).toBeGreaterThan(0);
      for (const r of c.reads) expect(r, c.id).toMatch(/^(?:record|audit|manifest|matrix|world|trajectory)\b/);
      expect(typeof c.check).toBe('function');
    }
  });

  it('lists the confirmation criteria M1-M5 in order, and decides model by MF1 (FAIL) and MF2 (LIMIT)', () => {
    expect(CONFIRMATION_CRITERIA.map((c) => c.id)).toEqual(['M1', 'M2', 'M3', 'M4', 'M5']);
    expect(FAULT_DEFINITIONS.model.criteria.map((c) => c.id)).toEqual(['MF1', 'MF2']);
  });

  it('gives each infra and refusal outcome of the FAULT map one criterion', () => {
    expect(FAULT_DEFINITIONS.infra.criteria.map((c) => c.id)).toEqual(['I1', 'I2', 'I3', 'I4']);
    expect(OUTCOMES.filter((o) => FAULT[o] === 'infra')).toHaveLength(4);
    expect(FAULT_DEFINITIONS.refusal.criteria.map((c) => c.id)).toEqual(['R1']);
  });

  it('defines E5 as the negation of M1 and GR4 as the negation of M4', () => {
    const ids = (f: Fault) => FAULT_DEFINITIONS[f].criteria.map((c) => c.id);
    expect(ids('env')).toEqual(['E1', 'E2', 'E3', 'E4', 'E5']);
    expect(ids('grader')).toEqual(['GR1', 'GR2', 'GR3', 'GR4']);
    expect(FAULT_DEFINITIONS.env.criteria[4]!.text).toMatch(/M1/);
    expect(FAULT_DEFINITIONS.grader.criteria[3]!.text).toMatch(/M4/);
  });

  it('has no two criteria with the same id or text', () => {
    const all = [...FAULTS.flatMap((f) => FAULT_DEFINITIONS[f].criteria), ...CONFIRMATION_CRITERIA, ...RUN_BLOCKS];
    expect(new Set(all.map((c) => c.id)).size).toBe(all.length);
    expect(new Set(all.map((c) => c.text)).size).toBe(all.length);
  });
});

describe('FAULT_PRECEDENCE and confirmation', () => {
  it('orders every fault once: infra, grader, env, refusal, model, and the rule names them in that order', () => {
    expect(FAULT_PRECEDENCE).toEqual(['infra', 'grader', 'env', 'refusal', 'model']);
    expect([...FAULT_PRECEDENCE].sort()).toEqual([...FAULTS].sort());
    expect(FAULT_PRECEDENCE_RULE).toMatch(/infra[^.]*grader[^.]*environment[^.]*refusal[^.]*model/);
  });

  it('defines confirmed, provisional and contradicted in one sentence each', () => {
    expect(Object.keys(CONFIRMATION_DEFINITIONS)).toEqual(['confirmed', 'provisional', 'contradicted']);
    for (const s of Object.values(CONFIRMATION_DEFINITIONS)) expect(s).toMatch(/^[A-Z][^\n]*\.$/);
  });
});

describe('AUDIT_LABEL', () => {
  it('maps the five faults to the three audit labels; infra has none', () => {
    expect(AUDIT_LABEL).toEqual({
      model: { label: 'model', subtype: null },
      refusal: { label: 'model', subtype: 'refusal' },
      grader: { label: 'grader', subtype: null },
      env: { label: 'environment', subtype: null },
      infra: null,
    });
    expect([...AUDIT_LABELS].sort()).toEqual(['environment', 'grader', 'model']);
  });
});

describe('PASS_DEFINITION and DENOMINATOR_RULE', () => {
  it('PASS_DEFINITION says every gate check of the current grade is met and any environment or grader criterion that holds is a note (verify m2, review F4)', () => {
    expect(PASS_DEFINITION).toMatch(/every gate check of its current grade is met/);
    expect(PASS_DEFINITION).toMatch(/environment or grader criterion that holds is shown as a note/);
    expect(PASS_DEFINITION).not.toMatch(/no environment criterion/);
    expect(PASS_DEFINITION).not.toMatch(/valid outcomes/);
  });

  it('names as counted exactly VALID_OUTCOMES and as excluded exactly the other outcomes', () => {
    const excluded = OUTCOMES.filter((o) => !VALID_OUTCOMES.includes(o));
    const [counted, rest] = DENOMINATOR_RULE.split('every other outcome is excluded');
    expect(rest).toBeDefined();
    for (const o of VALID_OUTCOMES) expect(counted).toMatch(new RegExp(`\\b${o}\\b`));
    for (const o of excluded) {
      expect(counted).not.toMatch(new RegExp(`\\b${o}\\b`));
      expect(rest).toMatch(new RegExp(`\\b${o}\\b`));
    }
    expect(excluded).toEqual(['INVALID', 'INFRA_HARNESS', 'INFRA_API', 'CANCELLED', 'ENV_ERROR', 'GRADER_ERROR']);
  });

  it('reruns every excluded outcome but GRADER_ERROR, which blocks the run until a grader fix and a full offline regrade', () => {
    expect(RERUN_OUTCOMES).toEqual(OUTCOMES.filter((o) => !isValid(o) && FAULT[o] !== 'grader'));
    expect(RERUN_OUTCOMES).not.toContain('GRADER_ERROR');
    expect(DENOMINATOR_RULE).toMatch(/GRADER_ERROR[^.]*blocks the run until a grader fix and a full offline regrade/);
    expect(DENOMINATOR_RULE).toMatch(/GRADER_ERROR is excluded and never rerun as a model trial/);
    // Every "rerun" that is not "never rerun" is said of the rerun outcomes only.
    const rerunClause = /([A-Z_, ]+(?:and [A-Z_]+)?) (?:are|is) excluded and rerun/.exec(DENOMINATOR_RULE);
    expect(rerunClause).not.toBeNull();
    expect(rerunClause![1]).not.toMatch(/GRADER_ERROR/);
    for (const o of RERUN_OUTCOMES) expect(rerunClause![1]).toMatch(new RegExp(`\\b${o}\\b`));
  });

  it('the operator note says grader_error=0 checks each current grade after any offline regrade, and grader_error_history is disclosure, never a require key', () => {
    expect(DENOMINATOR_OPERATOR_NOTE).toMatch(/grader_error=0[^.]*checks each record's current grade after any offline regrade/);
    expect(DENOMINATOR_OPERATOR_NOTE).toMatch(/grader_error_history[^.]*for disclosure/);
    expect(DENOMINATOR_OPERATOR_NOTE).toMatch(/grader_error_history is never a require key/);
    expect(DENOMINATOR_OPERATOR_NOTE).toMatch(/env_error_raw/);
    expect(DENOMINATOR_RULE).not.toMatch(/require|env_error_raw|summary --/);
  });

  it('the reader rule counts a refusal as a model failure and names refusal_excluded_rate, the view without refusals', () => {
    expect(DENOMINATOR_RULE).toMatch(/refusal counts as a model failure inside the denominator/);
    expect(DENOMINATOR_RULE).toMatch(/refusal_excluded_rate/);
    // 115: round 3 added the environment- and grader-labelled exclusion and how each is resolved.
    expect(DENOMINATOR_RULE.split(/\s+/).length).toBeLessThanOrEqual(115);
  });
});

describe('round 3 (pr-review P14a-2): denominator, precedence and confirmation text', () => {
  it('DENOMINATOR_RULE excludes an environment- or grader-labelled valid failure and says how each is resolved (review F3)', () => {
    expect(DENOMINATOR_RULE).toMatch(/valid failure labelled environment or grader is excluded from the denominator and blocks the run/);
    expect(DENOMINATOR_RULE).toMatch(/environment fix and a rerun of only the affected trials, disclosed in results\/CHANGELOG\.md, or that grader fix and regrade/);
  });

  it('FAULT_PRECEDENCE_RULE no longer says an environment fault only reruns the trial, and gives the reason for each step', () => {
    expect(FAULT_PRECEDENCE_RULE).not.toMatch(/only reruns/);
    expect(FAULT_PRECEDENCE_RULE).toMatch(/check the trial failed/);
    expect(FAULT_PRECEDENCE_RULE).toMatch(/refusal/);
  });

  it('CONFIRMATION_DEFINITIONS.confirmed names the record-fact criteria and the audit for the rest', () => {
    expect(CONFIRMATION_DEFINITIONS.confirmed).toMatch(/E1-E4, GR1 or GR2/);
    expect(CONFIRMATION_DEFINITIONS.confirmed).toMatch(/E5, GR3 or GR4/);
  });

  it('GR4 and M4 read the matrix\'s failed checks against the trial\'s failed check; B1 is the run-level block', () => {
    const gr4 = FAULT_DEFINITIONS.grader.criteria.find((c) => c.id === 'GR4')!;
    expect(gr4.text).toMatch(/same gate check the trial failed/);
    expect(gr4.reads.join(' ')).toMatch(/failed_checks/);
    expect(RUN_BLOCKS.map((c) => c.id)).toEqual(['B1']);
    expect(RUN_BLOCKS[0]!.text).toMatch(/^[A-Z][^\n]*\.$/);
  });

  it('the M5 text is the rule the code checks', () => {
    const m5 = CONFIRMATION_CRITERIA.find((c) => c.id === 'M5')!;
    expect(m5.text).toMatch(/adjudicated_label, else its label/);
  });
});
