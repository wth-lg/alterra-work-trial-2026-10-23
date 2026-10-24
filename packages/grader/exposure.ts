// Steps and evidence exposure (design section 3, "Exposure tagging", and section 5,
// "Attribution"), read from the trajectory exactly as the tools tagged their results (P5):
// a resource counts as seen only when a result exposed it, i.e. it is in exposed_ids, or, for
// a note whose check declares a decisive phrase, when a step showed that phrase. The rule
// behind the tags is in packages/env/tools/registry.ts: a result exposes a resource when it
// shows the fields a clinician acts on. For a note or report that is its whole text, which only
// fhir_read returns: a fhir_search row shows its size and a search_notes row an excerpt, so both
// only reference it. Each step also carries the text it showed (Step.shown: snippets, note
// texts read with fhir_read, policy texts, whitespace-collapsed), so a gate or attribution can
// ask whether a decisive phrase was shown (shows). Errors expose and show nothing. Writes are
// read from written_ids alone (P6), never inferred from a call's input.
//
// Steps are numbered by Step.n, from 1, and every helper here speaks that index: exposedAt and
// firstExposed return an n, lastWrite returns an n, and shows takes beforeStepN, an n it
// excludes, so "shown before the first write" is shows(ctx.steps, ref, firstWrite.n, phrase).
//
// Regrading an old record: exposed_ids and referenced_ids are read from the record as the tools
// tagged them then, while shown is derived now from the recorded content. Records made before
// GRADER_VERSION 5 were tagged under the older rule (a search_patients row did not expose its
// Patient), so their exposed_ids predate it while their shown text follows the current shapes;
// a gate comparing the two on such a record compares two rules. No merged record has a note
// exposed by a snippet: that tagging existed only on an unmerged branch.
import type { TrialEvent } from '../core/events.ts';
import { collapseWhitespace, shownText } from '../env/tools/registry.ts';
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

const comparable = (text: string) => collapseWhitespace(text).toLowerCase();

// Whether step `s` showed `phrase` in the text of `ref` (bare or typed). Each shown text is
// checked alone (Step.shown joins two with a newline, which collapsing leaves nowhere else), so
// a phrase never matches across two snippets.
function showedIn(s: Step, ref: string, phrase: string): boolean {
  const want = comparable(phrase);
  return want !== '' && Object.entries(s.shown).some(([k, t]) => sameId(k, ref) && t.split('\n').some((part) => comparable(part).includes(want)));
}

// Whether a step numbered below beforeStepN (Step.n, 1-based, exclusive) showed `phrase` in the
// text of `ref`, given bare or typed. Both sides are whitespace-collapsed and compared ignoring
// case. Shown text comes from a search_notes snippet, a fhir_read of a note or report, or a
// whole policy (Step.shown); a resource of any other type is never shown, so this is false for
// it. An empty phrase is never shown.
export function shows(steps: readonly Step[], ref: string, beforeStepN: number, phrase: string): boolean {
  return steps.some((s) => s.n < beforeStepN && showedIn(s, ref, phrase));
}

// The first step that showed `phrase` in the text of `ref`, or null; shows(steps, ref, n + 1,
// phrase) holds exactly from that n on.
export function firstShown(steps: readonly Step[], ref: string, phrase: string): number | null {
  return steps.find((s) => showedIn(s, ref, phrase))?.n ?? null;
}

// The last step whose committed write touched any of `ids`, or null.
export function lastWrite(steps: readonly Step[], ids: readonly string[]): number | null {
  for (let i = steps.length - 1; i >= 0; i--) if (steps[i]!.written_ids.some((k) => ids.some((id) => sameId(k, id)))) return steps[i]!.n;
  return null;
}
