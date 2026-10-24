// The wall clock run() is given in the browser: epoch milliseconds, for event timestamps, the
// record's started and ended, and the wall-clock cap. The loop itself never reads a clock.
export const browserNow = (): number => Date.now();
