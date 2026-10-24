// Steps and evidence exposure (design section 3, "Exposure tagging", and section 5,
// "Attribution"), read from the trajectory exactly as the tools tagged their results (P5):
// a resource counts as seen only when a result exposed it, i.e. it is in exposed_ids. The rule
// behind the tags is in packages/env/tools/registry.ts: a result exposes a resource when it
// shows the fields a clinician acts on. A fhir_search row shows a note's size, not its text, so
// it only references the note; a search_notes snippet or fhir_read shows text and exposes it.
// Since a snippet shows only part of a note, each step also carries the exact text it showed
// (Step.shown), so a gate can ask whether a decisive phrase was shown (textShown). Errors
// expose and show nothing. Writes are read from written_ids alone (P6), never inferred from a
// call's input.
import type { TrialEvent } from '../core/events.ts';
import { shownText } from '../env/tools/registry.ts';
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
      shown: e.is_error ? {} : shownText(e.content),
    });
  }
  return steps;
}

// Whether <Type>/<id> names `id`, given bare or typed.
export const sameId = (key: string, id: string): boolean => (id.includes('/') ? key === id : key.slice(key.indexOf('/') + 1) === id);

export function firstExposed(steps: readonly Step[], id: string): number | null {
  return steps.find((s) => s.exposed_ids.some((k) => sameId(k, id)))?.n ?? null;
}

// The text steps[0..upToIndex] (inclusive, 0-based) showed for `ref`, given bare or typed, in
// step order and newline-joined; '' when none did. A gate checks a decisive phrase with
// textShown(ctx.steps, ref, i).includes(phrase).
export function textShown(steps: readonly Step[], ref: string, upToIndex: number): string {
  return steps
    .slice(0, Math.max(0, upToIndex + 1))
    .flatMap((s) => Object.entries(s.shown).filter(([k]) => sameId(k, ref)).map(([, t]) => t))
    .join('\n');
}

// The last step whose committed write touched any of `ids`, or null.
export function lastWrite(steps: readonly Step[], ids: readonly string[]): number | null {
  for (let i = steps.length - 1; i >= 0; i--) if (steps[i]!.written_ids.some((k) => ids.some((id) => sameId(k, id)))) return steps[i]!.n;
  return null;
}
