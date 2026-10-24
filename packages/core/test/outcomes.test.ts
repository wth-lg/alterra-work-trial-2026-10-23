// The attribution definitions (plan phase P14a): one sentence and ordered criteria per Fault, the
// AUDIT_LABEL mapping to the three audit labels, and PASS_DEFINITION and DENOMINATOR_RULE built
// from the outcome table, so no surface lists them by hand.
import { describe, expect, it } from 'vitest';
import {
  AUDIT_LABEL, AUDIT_LABELS, DENOMINATOR_RULE, FAULT, FAULT_DEFINITIONS, OUTCOMES, PASS_DEFINITION, RERUN_OUTCOMES, VALID_OUTCOMES, isValid, type Fault,
} from '../outcomes.ts';

const FAULTS: Fault[] = ['model', 'refusal', 'env', 'grader', 'infra'];

describe('FAULT_DEFINITIONS', () => {
  it('gives every Fault one plain sentence and ordered criteria, each with an id, a text and a check', () => {
    expect(Object.keys(FAULT_DEFINITIONS).sort()).toEqual([...FAULTS].sort());
    for (const f of FAULTS) {
      const d = FAULT_DEFINITIONS[f];
      expect(d.sentence).toMatch(/^[A-Z][^\n]*\.$/);
      expect(d.criteria.length).toBeGreaterThan(0);
      for (const c of d.criteria) {
        expect(c.id).toMatch(/^[A-Z]+[0-9]+$/);
        expect(c.text).toMatch(/^[A-Z][^\n]*\.$/);
        expect(typeof c.check).toBe('function');
      }
    }
  });

  it('lists the model criteria M1-M5 in order', () => {
    expect(FAULT_DEFINITIONS.model.criteria.map((c) => c.id)).toEqual(['M1', 'M2', 'M3', 'M4', 'M5']);
  });

  it('derives the infra and refusal criteria from the FAULT map: one per outcome of that fault', () => {
    for (const f of ['infra', 'refusal'] as const) {
      const outcomes = OUTCOMES.filter((o) => FAULT[o] === f);
      expect(FAULT_DEFINITIONS[f].criteria).toHaveLength(outcomes.length);
      outcomes.forEach((o, i) => expect(FAULT_DEFINITIONS[f].criteria[i]!.text).toContain(o));
    }
  });

  it('has no two criteria with the same id or text', () => {
    const all = FAULTS.flatMap((f) => FAULT_DEFINITIONS[f].criteria);
    expect(new Set(all.map((c) => c.id)).size).toBe(all.length);
    expect(new Set(all.map((c) => c.text)).size).toBe(all.length);
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
  it('PASS_DEFINITION says every gate check met, the environment clean and replay OK', () => {
    expect(PASS_DEFINITION).toMatch(/every gate check/);
    expect(PASS_DEFINITION).toMatch(/environment/);
    expect(PASS_DEFINITION).toMatch(/replay/);
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

  it('says grader_error=0 checks each current grade after any offline regrade, and grader_error_history is disclosure, never a require key', () => {
    expect(DENOMINATOR_RULE).toMatch(/grader_error=0[^.]*checks each record's current grade after any offline regrade/);
    expect(DENOMINATOR_RULE).toMatch(/grader_error_history[^.]*for disclosure/);
    expect(DENOMINATOR_RULE).toMatch(/grader_error_history is never a require key/);
    expect(DENOMINATOR_RULE).toMatch(/ENV_ERROR still counts raw/);
    expect(DENOMINATOR_RULE).toMatch(/refusal counts as a model failure inside the denominator/);
  });
});
