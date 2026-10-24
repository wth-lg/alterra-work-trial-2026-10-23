// Steps and evidence exposure (design section 3, "Exposure tagging", and section 5,
// "Attribution"), read from the trajectory exactly as the tools tagged their results (P5):
// a resource counts as seen only when a result exposed it, i.e. it is in exposed_ids. A
// fhir_search row or a search_notes snippet only references a note; reading it with fhir_read
// exposes it. Errors expose nothing. Writes are read from written_ids alone (P6), never inferred
// from a call's input.
import type { TrialEvent } from '../core/events.ts';
import type { Step } from './check.ts';

// The calls that ran, in order, numbered from 1.
export function stepsOf(events: readonly TrialEvent[]): Step[] {
  const steps: Step[] = [];
  for (const e of events) {
    if (e.type !== 'tool_result' || !e.executed) continue;
    steps.push({
      n: steps.length + 1,
      seq: e.seq,
      tool: e.name,
      is_error: e.is_error,
      error_code: e.error_code,
      exposed_ids: e.is_error ? [] : e.exposed_ids,
      referenced_ids: e.is_error ? [] : e.referenced_ids,
      written_ids: e.is_error ? [] : (e.written_ids ?? []),
    });
  }
  return steps;
}

// Whether <Type>/<id> names `id`, given bare or typed.
export const sameId = (key: string, id: string): boolean => (id.includes('/') ? key === id : key.slice(key.indexOf('/') + 1) === id);

export function firstExposed(steps: readonly Step[], id: string): number | null {
  return steps.find((s) => s.exposed_ids.some((k) => sameId(k, id)))?.n ?? null;
}

// The last step whose committed write touched any of `ids`, or null.
export function lastWrite(steps: readonly Step[], ids: readonly string[]): number | null {
  for (let i = steps.length - 1; i >= 0; i--) if (steps[i]!.written_ids.some((k) => ids.some((id) => sameId(k, id)))) return steps[i]!.n;
  return null;
}
