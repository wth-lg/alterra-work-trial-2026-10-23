// The fixed clock (design section 2, "Clock"). Every trial, overlay and fixture lint reads
// time from here; packages/env never reads the wall clock (eslint-rules/determinism.js).
//
// NOW is a Friday in US Eastern Daylight Time. US DST ends 2026-11-01, so the -04:00 offset
// holds for every write a trial stamps; the fixture lint rejects a task time window that
// crosses a transition.

export const NOW = '2026-10-23T08:00:00-04:00';
export const NOW_MS = Date.parse(NOW);
export const TIME_ZONE = 'America/New_York';
const OFFSET = '-04:00';
const OFFSET_MS = -4 * 3_600_000;

// The line the system prompt states (design section 4, "Shared rules").
export const NOW_PROMPT = 'Current time: Friday 2026-10-23 08:00 America/New_York.';

// ISO 8601 with the -04:00 offset, to the second.
export function eastern(ms: number): string {
  return new Date(ms + OFFSET_MS).toISOString().slice(0, 19) + OFFSET;
}

export interface Clock {
  readonly now: string;
  readonly nowMs: number;
  // The timestamp of a trial's n-th write (1-based): NOW + n seconds.
  stamp(writeSeq: number): string;
}

export const clock: Clock = {
  now: NOW,
  nowMs: NOW_MS,
  stamp(writeSeq) {
    if (!Number.isInteger(writeSeq) || writeSeq < 1) throw new Error(`clock: write sequence ${writeSeq} is not a positive integer`);
    return eastern(NOW_MS + writeSeq * 1000);
  },
};
