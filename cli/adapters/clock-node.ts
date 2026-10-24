// The wall clock run() is given in Node: epoch milliseconds, for event timestamps, the record's
// started and ended, and the wall-clock cap. The loop itself never reads a clock
// (eslint-rules/determinism.js covers packages/core/loop.ts).
export const nodeNow = (): number => Date.now();
