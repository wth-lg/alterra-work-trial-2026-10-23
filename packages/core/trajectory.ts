// The trajectory file (design section 6): the trial's events as JSONL, one JSON.stringify(event)
// per line, in seq order. Writing each line as its event arrives makes the file the trial's
// checkpoint: a crash leaves a valid prefix. The tool log, which replay re-executes against a
// fresh store, is read from it.
import { parseEvent, type ToolCallEvent, type TrialEvent } from './events.ts';

export const toJsonLine = (e: TrialEvent): string => `${JSON.stringify(e)}\n`;

export const toJsonl = (events: readonly TrialEvent[]): string => events.map(toJsonLine).join('');

// Every line validated; errors name the 1-based line.
export function parseTrajectory(jsonl: string): TrialEvent[] {
  return jsonl
    .split('\n')
    .map((line, i) => [line, i + 1] as const)
    .filter(([line]) => line.trim() !== '')
    .map(([line, n]) => {
      try {
        return parseEvent(JSON.parse(line));
      } catch (e) {
        throw new Error(`trajectory line ${n}: ${(e as Error).message}`, { cause: e });
      }
    });
}

// The JSONL with every ts removed: what two runs of the same mocked trial must agree on.
export const stripTimestamps = (jsonl: string): string =>
  parseTrajectory(jsonl)
    .map(({ ts: _ts, ...rest }) => `${JSON.stringify(rest)}\n`)
    .join('');

// The calls that ran, in order: every tool_call whose tool_result says executed.
export function toolLog(events: readonly TrialEvent[]): ToolCallEvent[] {
  const executed = new Set(events.flatMap((e) => (e.type === 'tool_result' && e.executed ? [e.tool_use_id] : [])));
  return events.filter((e): e is ToolCallEvent => e.type === 'tool_call' && executed.has(e.tool_use_id));
}
