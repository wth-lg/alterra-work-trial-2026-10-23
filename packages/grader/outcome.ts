// The outcome a trial has before its checks run (design section 5, "Outcomes"), from its
// record. Which outcomes exist, which are valid and whose fault each is live in
// packages/core/outcomes.ts, the one definition the cost model shares.
import { MODEL } from '../core/anthropic.ts';
import type { TrialStatus } from '../core/events.ts';
import type { Outcome } from '../core/outcomes.ts';

export { FAULT, isValid, OUTCOMES, VALID_OUTCOMES, type Fault, type Outcome } from '../core/outcomes.ts';

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
export function trialOutcome(t: TrialFacts): Exclude<Outcome, 'GRADER_ERROR' | 'FAIL' | 'PASS'> | null {
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
