import { describe, expect, it } from 'vitest';
import {
  AUDITOR_ALLOWANCE_USD,
  finalReserve,
  formatProjection,
  JUDGE_ALLOWANCE_USD,
  p90,
  PER_TRIAL_CAP_USD,
  perTrialCost,
  projectBatch,
  RERUN_FACTOR,
  type TrialObservation,
} from '../cost.ts';

function obs(run: string, run_order: number, task_id: string, task_version: string, costs: number[]): TrialObservation[] {
  return costs.map((cost_usd, i) => ({ run, run_order, task_id, task_version, cost_usd, started: `2026-10-2${run_order}T00:00:0${i}Z` }));
}

const TEN = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.3, 2.0];

describe('p90', () => {
  it('takes the nearest-rank 90th percentile', () => {
    expect(p90(TEN)).toBe(1.3);
    expect(p90([3])).toBe(3);
    expect(p90([5, 1, 2])).toBe(5);
  });
});

describe('batch projection (case 14)', () => {
  it('with no cost data prints $6 per trial plus the judge allowance', () => {
    const p = projectBatch([{ task_id: 'renal-dose-review', task_version: 'v1', trials: 1 }], []);
    expect(p.lines[0]?.per_trial).toEqual({ usd: PER_TRIAL_CAP_USD, basis: 'cap' });
    expect(p.total).toBeCloseTo(1 * 6 * RERUN_FACTOR + JUDGE_ALLOWANCE_USD, 9);
    const text = formatProjection(p).join('\n');
    expect(text).toContain('$6.00 per trial (cap: no cost data)');
    expect(text).toContain(`judge allowance $${JUDGE_ALLOWANCE_USD.toFixed(2)}`);
    expect(text).toContain(`total $${p.total.toFixed(2)}`);
  });

  it('uses the latest p90 for the task_version from the --cost-from runs', () => {
    const data = [...obs('results/pilot-0', 0, 'T1', 'v1', [9, 9, 9]), ...obs('results/pilot-1', 1, 'T1', 'v1', TEN)];
    const p = projectBatch([{ task_id: 'T1', task_version: 'v1', trials: 3 }], data);
    expect(p.lines[0]?.per_trial).toMatchObject({ usd: 1.3, basis: 'p90', run: 'results/pilot-1', task_version: 'v1', n: 10 });
    expect(p.total).toBeCloseTo(3 * 1.3 * RERUN_FACTOR + JUDGE_ALLOWANCE_USD, 9);
    expect(formatProjection(p).join('\n')).toContain('$1.30 per trial (p90 of 10 trials of v1 in results/pilot-1)');
  });

  it('falls back to the same task’s latest earlier version when the version was bumped', () => {
    const data = [
      ...obs('results/pilot-1', 1, 'T1', 'v1', [4, 4, 4]),
      ...obs('results/pilot-2', 2, 'T1', 'v2', TEN),
      ...obs('results/pilot-2', 2, 'T2', 'w1', [0.1]),
    ];
    expect(perTrialCost('T1', 'v3', data)).toMatchObject({ usd: 1.3, basis: 'earlier-version-p90', task_version: 'v2' });
    expect(perTrialCost('T3', 'x1', data)).toEqual({ usd: PER_TRIAL_CAP_USD, basis: 'cap' });
  });

  it('ignores records without a finite cost', () => {
    const data = [...obs('r', 0, 'T1', 'v1', [1]), { run: 'r', run_order: 0, task_id: 'T1', task_version: 'v1', cost_usd: Number.NaN }];
    expect(perTrialCost('T1', 'v1', data)).toMatchObject({ usd: 1, n: 1 });
  });
});

describe('final-run reserve', () => {
  it('with no runs is 60 x $6 x 1.15 plus the auditor allowance', () => {
    const r = finalReserve({ observations: [], finalTrials: [], auditorDone: false });
    expect(r.total).toBeCloseTo(60 * 6 * 1.15 + AUDITOR_ALLOWANCE_USD, 9);
    const text = formatProjection(r).join('\n');
    expect(text).toContain('6 tasks without data x 10 trials x $6.00');
    expect(text).toContain(`auditor allowance $${AUDITOR_ALLOWANCE_USD.toFixed(2)}`);
  });

  it('uses each task’s p90, subtracts valid final trials and drops the auditor allowance once audited', () => {
    const tasks = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6'];
    const data = tasks.flatMap((t, i) => obs('results/pilot-2', 2, t, `${t}-v1`, TEN.map((c) => c + i)));
    const finalTrials = [
      { task_id: 'T1', outcome: 'PASS' },
      { task_id: 'T1', outcome: 'FAIL' },
      { task_id: 'T1', outcome: 'ENV_ERROR' },
      { task_id: 'T2', outcome: 'INFRA' },
    ];
    const r = finalReserve({ observations: data, finalTrials, auditorDone: true });
    // T1 has 2 valid final trials, so 8 remain; every other task has 10 remaining.
    const expected = (8 * 1.3 + tasks.slice(1).reduce((s, _t, i) => s + 10 * (1.3 + i + 1), 0)) * RERUN_FACTOR;
    expect(r.total).toBeCloseTo(expected, 9);
    expect(r.allowance).toEqual({ name: 'auditor', usd: 0 });
    expect(r.lines.find((l) => l.task_id === 'T1')?.trials).toBe(8);
  });
});
