// audit-check against the attribution definitions (plan phase P14a): its label set and criteria
// come from packages/core/outcomes.ts, each valid non-PASS label equals AUDIT_LABEL of the
// trial's fault, INFRA and CANCELLED trials carry no label and stay outside the valid set, and
// audit.jsonl holds each labelled trial's criteria as explainTrial gives them. P12's fixtures
// exit as before.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { explainTrial, type AuditRow } from '../../packages/core/explain.ts';
import { tempDir } from '../../scripts/test/helpers.ts';
import { explainContext, main as auditCheck } from '../audit-check.ts';
import { AUDIT_FIXTURES, SUMMARY_FIXTURES, writeFixtureRun, type Fixture } from './run-fixtures.ts';

function run(fixture: Fixture): string {
  const dir = tempDir(`audit-${fixture}`);
  writeFixtureRun(dir, fixture);
  return dir;
}

async function check(dir: string) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await auditCheck([dir, '--json'], { out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, json: JSON.parse(out.join('\n')) as { violations: string[]; environment: number; grader: number }, text: err.join('\n') };
}

const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
const writeJson = (file: string, x: unknown) => writeFileSync(file, `${JSON.stringify(x, null, 2)}\n`);
const labels = (dir: string) => readFileSync(join(dir, 'audit.jsonl'), 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as AuditRow & { criteria?: unknown });
const writeLabels = (dir: string, rows: object[]) => writeFileSync(join(dir, 'audit.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

// Turns t-alpha/9 (a labelled FAIL in the clean run) into another outcome.
function retrial(dir: string, over: Record<string, unknown>): void {
  const file = join(dir, 'trials/t-alpha/9.json');
  writeJson(file, { ...readJson(file), checks: [], attribution: null, ...over });
}

describe('audit-check: P12 fixtures exit as before', () => {
  // Each P12 fixture's exit code from audit-check on main at b06d202, before P14a.
  const ON_MAIN: Record<Fixture, number> = {
    clean: 0, 'grader-error-regraded': 0, 'nine-trials': 0, 'model-mismatch': 0, 'requeued-env-error': 1, 'replay-mismatch': 1, 'eight-of-ten': 0,
    'missing-task': 0, 'mock-mode': 0, 'grader-error': 0, 'fail-regraded-pass': 1, 'missing-label': 1, 'environment-label': 1, 'evidence-absent': 1,
    unadjudicated: 1, 'never-exposable': 1, 'one-audited-pass': 1, 'model-fault-no': 1,
  };

  it('lists every fixture', () => expect(Object.keys(ON_MAIN).sort()).toEqual(['clean', 'grader-error-regraded', ...SUMMARY_FIXTURES, ...AUDIT_FIXTURES].sort()));

  it.each(Object.entries(ON_MAIN) as Array<[Fixture, number]>)('%s exits %i', async (fixture, code) => {
    const r = await check(run(fixture));
    expect(r.code, r.json.violations.join('\n')).toBe(code);
  });
});

describe('audit-check: labels from AUDIT_LABEL', () => {
  it('a label on an INFRA trial exits 1 and names it', async () => {
    const dir = run('clean');
    retrial(dir, { outcome: 'INFRA_API', valid: false, status: 'INFRA_API', detail: 'overloaded', score: null });
    const r = await check(dir);
    expect(r.code).toBe(1);
    expect(r.json.violations.join('\n')).toMatch(/t-alpha\/9: INFRA_API carries the label model/);
  });

  it('an INFRA or CANCELLED record inside the valid set exits 1', async () => {
    const dir = run('clean');
    retrial(dir, { outcome: 'CANCELLED', valid: true, status: 'CANCELLED', score: null });
    writeLabels(dir, labels(dir).filter((l) => l.trial !== 't-alpha/9'));
    const r = await check(dir);
    expect(r.code).toBe(1);
    expect(r.json.violations.join('\n')).toMatch(/t-alpha\/9: CANCELLED is in the valid set/);
  });

  it('an unlabelled INFRA record outside the valid set is no violation', async () => {
    const dir = run('clean');
    retrial(dir, { outcome: 'INFRA_HARNESS', valid: false, status: 'INFRA_HARNESS', score: null });
    writeLabels(dir, labels(dir).filter((l) => l.trial !== 't-alpha/9'));
    const r = await check(dir);
    expect(r.code, r.json.violations.join('\n')).toBe(0);
  });

  it('a REFUSAL is labelled model with subtype refusal; environment, or another subtype, is a violation', async () => {
    const dir = run('clean');
    retrial(dir, { outcome: 'REFUSAL', valid: true, status: 'REFUSAL', score: null, refusal_category: 'cyber' });
    const base = labels(dir).filter((l) => l.trial !== 't-alpha/9');
    const refusal = { trial: 't-alpha/9', outcome: 'REFUSAL', taxonomy: null, label: 'model', label_subtype: 'refusal', model_fault: 'yes', decisive_step: 2, evidence_ids: ['Patient/pt-0001'], llm_auditor_agrees: true };
    writeLabels(dir, [...base, refusal]);
    const ok = await check(dir);
    expect(ok.code, ok.json.violations.join('\n')).toBe(0);
    writeLabels(dir, [...base, { ...refusal, label: 'environment', label_subtype: null }]);
    const env = await check(dir);
    expect(env.code).toBe(1);
    expect(env.json.violations.join('\n')).toMatch(/t-alpha\/9: labelled environment, and its fault refusal has the label model/);
    writeLabels(dir, [...base, { ...refusal, label_subtype: null }]);
    expect((await check(dir)).json.violations.join('\n')).toMatch(/t-alpha\/9: label subtype none, and its fault refusal has the subtype refusal/);
  });

  it('a label outside the three AUDIT_LABEL values is a violation', async () => {
    const dir = run('clean');
    writeLabels(dir, labels(dir).map((l) => (l.trial === 't-alpha/5' ? { ...l, label: 'harness' } : l)));
    const r = await check(dir);
    expect(r.code).toBe(1);
    expect(r.json.violations.join('\n')).toMatch(/t-alpha\/5: label harness is not one of model, environment, grader|t-alpha\/5: label harness is not one of/);
  });

  it('a FAIL with an INTERNAL tool error is the environment\'s fault: its model label is a violation', async () => {
    const dir = run('clean');
    const file = join(dir, 'trials/t-alpha/5.json');
    writeJson(file, { ...readJson(file), tool_errors: { INTERNAL: 1 } });
    const r = await check(dir);
    expect(r.code).toBe(1);
    expect(r.json.violations.join('\n')).toMatch(/t-alpha\/5: labelled model, and its fault env has the label environment/);
  });
});

describe('audit-check: criteria in audit.jsonl', () => {
  it('writes each labelled trial\'s criteria, equal to explainTrial\'s, and a second run changes nothing', async () => {
    const dir = run('clean');
    expect((await check(dir)).code).toBe(0);
    const first = readFileSync(join(dir, 'audit.jsonl'), 'utf8');
    const ctxOf = await explainContext(dir);
    for (const l of labels(dir)) {
      const [task, index] = l.trial.split('/');
      const r = readJson(join(dir, `trials/${task}/${index}.json`));
      const { criteria, ...row } = l;
      expect(criteria, l.trial).toEqual(explainTrial(r as never, row, await ctxOf(r as never)).criteria);
      expect((criteria as Array<{ id: string }>).map((c) => c.id)).toEqual(['M1', 'M2', 'M3', 'M4', 'M5']);
    }
    expect((await check(dir)).code).toBe(0);
    expect(readFileSync(join(dir, 'audit.jsonl'), 'utf8')).toBe(first);
  });

  it('the never-exposable fixture records M1 not met for t-beta/9', async () => {
    const dir = run('never-exposable');
    await check(dir);
    const m1 = (labels(dir).find((l) => l.trial === 't-beta/9')!.criteria as Array<{ id: string; met: unknown; evidence: string }>)[0]!;
    expect(m1).toMatchObject({ id: 'M1', met: false });
    expect(m1.evidence).toMatch(/Observation\/never-in-world.*never exposed.*not exposable/);
  });
});
