/* eslint-disable local/isomorphic-imports -- Node-only test: it runs the fixtures:lint CLI. */
// Fixture lint (design section 2, "Fixture lint"): each rule fails on a planted defect and
// passes just outside its margin, and the CLI exits 0 on the committed world and 1 on
// packages/env/test/fixtures/lint-bad.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Resource } from '@medplum/fhirtypes';
import { describe, expect, it } from 'vitest';
import { NOW } from '../clock.ts';
import { lintWorld, type LintSpec } from '../lint/index.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));

const patient = (id: string, birthDate: string): Resource => ({ resourceType: 'Patient', id, birthDate });
const obs = (id: string, value: number, unit: string, effectiveDateTime = '2026-10-20T09:00:00-04:00'): Resource => ({
  resourceType: 'Observation',
  id,
  status: 'final',
  code: { text: id },
  subject: { reference: 'Patient/pt-t1-a' },
  effectiveDateTime,
  valueQuantity: { value, unit, system: 'http://unitsofmeasure.org', code: unit },
});

const rules = (resources: Resource[], spec: LintSpec) => lintWorld(resources, [{ source: 'test', spec }]).map((f) => f.rule);

describe('threshold margins', () => {
  const pt = patient('pt-t1-a', '1944-03-11');
  it.each([
    ['scr', 1.42, 'mg/dL', 1.5, ['threshold-margin']],
    ['scr', 1.71, 'mg/dL', 1.5, []],
    ['scr', 1.21, 'mg/dL', 1.5, []],
    // 133 umol/L is 1.50 mg/dL.
    ['scr', 133, 'umol/L', 1.5, ['threshold-margin']],
    ['weight', 143, '[lb_av]', 66, ['threshold-margin']],
    ['weight', 143, '[lb_av]', 60, []],
    ['potassium', 5.9, 'mmol/L', 6.0, ['threshold-margin']],
    ['potassium', 6.2, 'mmol/L', 6.0, []],
    ['egfr', 48, 'mL/min/{1.73_m2}', 45, ['threshold-margin']],
    ['egfr', 59.8, 'mL/min/{1.73_m2}', 45, []],
  ] as const)('%s %d %s against %d', (quantity, value, unit, threshold, expected) => {
    expect(rules([pt, obs('obs-t1-x', value, unit)], { thresholds: [{ quantity, threshold, observation: 'obs-t1-x' }] })).toEqual(expected);
  });

  it('checks a computed value (CrCl) given directly', () => {
    expect(rules([], { thresholds: [{ quantity: 'crcl', threshold: 30, value: 33.1, label: 'CrCl' }] })).toEqual(['threshold-margin']);
    expect(rules([], { thresholds: [{ quantity: 'crcl', threshold: 30, value: 43.2, label: 'CrCl' }] })).toEqual([]);
  });

  it('reports an observation it cannot read instead of passing it', () => {
    expect(rules([pt], { thresholds: [{ quantity: 'scr', threshold: 1.5, observation: 'obs-missing' }] })).toEqual(['threshold-margin']);
    expect(rules([pt, obs('obs-t1-x', 1.9, 'g/L')], { thresholds: [{ quantity: 'scr', threshold: 1.5, observation: 'obs-t1-x' }] })).toEqual(['threshold-margin']);
  });

  it('ages: at least 1 year from the threshold, no threshold birthday within 30 days', () => {
    // 82 years 7 months at NOW.
    expect(rules([patient('pt-t1-a', '1944-03-11')], { ages: [{ patient: 'pt-t1-a', threshold: 80 }] })).toEqual([]);
    expect(rules([patient('pt-t1-a', '1944-03-11')], { ages: [{ patient: 'pt-t1-a', threshold: 82 }] })).toEqual(['age-margin']);
    // Turns 80 on 2026-11-10, 18 days after NOW.
    expect(rules([patient('pt-t1-a', '1946-11-10')], { ages: [{ patient: 'pt-t1-a', threshold: 80 }] })).toEqual(['age-margin', 'age-margin']);
  });
});

describe('date margins', () => {
  const pt = patient('pt-t1-a', '1950-01-01');
  // A 3-year lookback ends at 2023-10-23.
  const window = (traps?: Record<string, string>) => ({ windows: [{ name: '3y lookback', boundary: { years: 3 }, resources: ['obs-t1-x'], ...(traps ? { traps } : {}) }] });
  it('fails a date within 14 days of the boundary', () => {
    expect(rules([pt, obs('obs-t1-x', 1, 'mg/dL', '2023-10-30')], window())).toEqual(['date-margin']);
    expect(rules([pt, obs('obs-t1-x', 1, 'mg/dL', '2023-10-10T10:00:00-04:00')], window())).toEqual(['date-margin']);
  });
  it('passes a date 14 days or more away, or a named trap', () => {
    expect(rules([pt, obs('obs-t1-x', 1, 'mg/dL', '2023-11-07')], window())).toEqual([]);
    expect(rules([pt, obs('obs-t1-x', 1, 'mg/dL', '2023-10-30')], window({ 'obs-t1-x': 'just inside the lookback' }))).toEqual([]);
  });
  it('takes a fixed boundary date', () => {
    const spec = { windows: [{ name: 'interval from the index study', boundary: '2026-06-04', resources: ['obs-t1-x'] }] };
    expect(rules([pt, obs('obs-t1-x', 1, 'mg/dL', '2026-06-10')], spec)).toEqual(['date-margin']);
    expect(rules([pt, obs('obs-t1-x', 1, 'mg/dL', '2026-06-19')], spec)).toEqual([]);
  });
});

describe('answer leakage', () => {
  const doc: Resource = {
    resourceType: 'DocumentReference',
    id: 'doc-t1-note',
    status: 'current',
    content: [{ attachment: { contentType: 'text/plain', title: 'Plan: Apixaban 2.5 MG twice daily' } }],
  };
  it('finds an answer token in policy text or a distractor field, case-insensitively', () => {
    expect(rules([], { leakage: { answers: ['apixaban 2.5 mg'], texts: [{ source: 'policy RBC-1', text: 'Reduce to APIXABAN 2.5 mg when...' }] } })).toEqual(['leakage']);
    expect(rules([doc], { leakage: { answers: ['apixaban 2.5 mg'], distractors: ['doc-t1-note'] } })).toEqual(['leakage']);
  });
  it('passes when no answer appears', () => {
    expect(rules([doc], { leakage: { answers: ['apixaban 5 mg'], texts: [{ source: 'policy', text: 'dose by age, weight, SCr' }], distractors: ['doc-t1-note'] } })).toEqual([]);
  });
});

describe('clock sanity', () => {
  it('every weekday named in a prompt matches its date', () => {
    expect(rules([], { prompts: ['Appointment Monday 2026-10-26 09:00 -04:00.'] })).toEqual([]);
    expect(rules([], { prompts: ['Appointment Tuesday, 2026-10-26 09:00.'] })).toEqual(['weekday']);
  });
  it('no DST transition inside a task time window', () => {
    expect(rules([], { timeWindows: [{ name: 'prep', start: '2026-10-23T08:00:00-04:00', end: '2026-10-26T09:00:00-04:00' }] })).toEqual([]);
    expect(rules([], { timeWindows: [{ name: 'prep', start: '2026-10-30T08:00:00-04:00', end: '2026-11-02T09:00:00-05:00' }] })).toEqual(['dst']);
    expect(rules([], { timeWindows: [{ name: 'spring', start: '2027-03-13T12:00:00-05:00', end: '2027-03-15T12:00:00-04:00' }] })).toEqual(['dst']);
  });
  it('no recorded clinical fact is dated after NOW; scheduled times may be', () => {
    const future = obs('obs-t1-x', 1, 'mg/dL', '2026-10-23T08:00:01-04:00');
    const appt: Resource = { resourceType: 'Appointment', id: 'appt-t5-1', status: 'booked', start: '2026-10-26T09:00:00-04:00', participant: [{ status: 'accepted' }] };
    expect(rules([patient('pt-t1-a', '1950-01-01'), future, appt], {})).toEqual(['future-date']);
    expect(rules([patient('pt-t1-a', '1950-01-01'), obs('obs-t1-x', 1, 'mg/dL', NOW), appt], {})).toEqual([]);
  });
});

it('every reference resolves', () => {
  expect(rules([obs('obs-t1-x', 1, 'mg/dL')], {})).toEqual(['dangling-reference']);
});

describe('pnpm fixtures:lint', () => {
  const lint = (...args: string[]) => spawnSync('node', ['scripts/fixtures-lint.ts', ...args], { cwd: root, encoding: 'utf8' });
  it('exits 0 on the committed world', () => {
    const r = lint();
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });
  it('exits 1 on the planted threshold-margin fixture, with exactly that finding', () => {
    const r = lint('packages/env/test/fixtures/lint-bad');
    expect(r.status).toBe(1);
    expect(r.stdout.trim().split('\n').filter((l) => l.startsWith('lint-bad'))).toEqual([
      expect.stringContaining('threshold-margin'),
    ]);
  });
});
