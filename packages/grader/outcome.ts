// Outcomes (design section 5, "Outcomes"): each trial gets exactly one, checked in this order.
// The first five are never valid trials and never model failures: they are rerun, not graded.
// CANCELLED sits with the INFRA outcomes: the run was stopped from outside, so it says nothing
// about the model. REFUSAL, LIMIT, FAIL and PASS are valid and count in the headline
// denominator. GRADER_BUG is set only by an audit, never here.
import { MODEL } from '../core/anthropic.ts';
import type { TrialStatus } from '../core/events.ts';

export const OUTCOMES = ['INVALID', 'INFRA_HARNESS', 'INFRA_API', 'CANCELLED', 'ENV_ERROR', 'REFUSAL', 'LIMIT', 'FAIL', 'PASS'] as const;
export type Outcome = (typeof OUTCOMES)[number];
export const VALID_OUTCOMES: readonly Outcome[] = ['REFUSAL', 'LIMIT', 'FAIL', 'PASS'];

// What the grader reads from a trial record.
export interface TrialFacts {
  status: TrialStatus;
  models_returned: readonly string[];
  tool_errors: Readonly<Record<string, number>>;
  state_hash: { initial: string | null; final: string | null; replay_final: string | null };
  // The summary the agent gave finish.
  summary: string | null;
}

// The outcome the trial has before its checks run, or null when the gates decide (FAIL or PASS).
export function trialOutcome(t: TrialFacts): Exclude<Outcome, 'FAIL' | 'PASS'> | null {
  if (t.status === 'INVALID' || t.models_returned.some((m) => m !== MODEL)) return 'INVALID';
  if (t.status === 'INFRA_HARNESS') return 'INFRA_HARNESS';
  if (t.status === 'INFRA_API') return 'INFRA_API';
  if (t.status === 'CANCELLED') return 'CANCELLED';
  const h = t.state_hash;
  if (t.status === 'ENV_ERROR' || (t.tool_errors.INTERNAL ?? 0) > 0 || h.initial === null || h.final === null || h.replay_final !== h.final) return 'ENV_ERROR';
  if (t.status === 'REFUSAL') return 'REFUSAL';
  if (t.status === 'LIMIT') return 'LIMIT';
  return null;
}

export const isValid = (o: Outcome): boolean => VALID_OUTCOMES.includes(o);
