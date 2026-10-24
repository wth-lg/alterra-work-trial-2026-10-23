// The inputs of a task's grader validation matrix (design section 5, "Grader validation
// matrix"), as a task ships them:
//   solution/solve.ts      `oracle`: the reference solution, a script of tool calls
//   tests/alternatives.ts  `alternatives`: other correct solutions, each expected to PASS
//   tests/mutants.ts       `mutants`: near misses, one trap each, each expected to FAIL on
//                          exactly the gate checks it declares
//   tests/agents.ts        `spray`, `output_gap` and, where the task declares it, `status_only`
//   tests/grader.ts        `checks`
//   expected.ts            `expected`: the expected end state, written by hand
//   policy.ts              `derive(world)`: the same, computed from the initial world
//   tests/judge-cache.json the canned judge and extractor answers the matrix grades with
//   task.toml [matrix]     traps = [...] (each needs a mutant); status_only = true|false
// A script is data: the calls a scripted model makes, turn by turn, through the same tools and
// the same run() loop as a live trial. The null agent (finish, nothing else) is built in.
import type { Resource } from '../../env/store.ts';
import type { Check, Json } from '../check.ts';
import type { JudgeCacheEntry } from '../judge.ts';

export interface ScriptCall {
  name: string;
  input: { [k: string]: Json };
}

// One answer: optional text, then its tool calls in order. An answer with no calls ends the
// episode (end_turn), as does running past the last answer.
export interface ScriptTurn {
  text?: string;
  calls: readonly ScriptCall[];
}

export type Script = readonly ScriptTurn[];

export interface Agent {
  id: string;
  // What the agent does differently, in a clinician's words.
  why: string;
  script: Script;
}

export interface Mutant extends Agent {
  // The task.toml trap it exercises.
  trap: string;
  // The gate checks it must fail, and no other.
  fails: readonly string[];
}

export interface Agents {
  spray?: Script;
  output_gap?: Script;
  status_only?: Script;
}

// What task.toml's [matrix] table declares.
export interface Declares {
  traps: readonly string[];
  status_only: boolean;
}

// The initial world as policy.ts reads it.
export interface WorldView {
  get(type: string, id: string): Readonly<Resource> | undefined;
  all(type?: string): readonly Readonly<Resource>[];
}

export interface MatrixTask {
  id: string;
  instruction: string;
  policies: ReadonlyArray<{ id: string; text: string }>;
  declares: Declares;
  checks: readonly Check[];
  oracle: Script | null;
  alternatives: readonly Agent[];
  mutants: readonly Mutant[];
  agents: Agents;
  expected: Json | undefined;
  derive: ((world: WorldView) => Json) | undefined;
  cache: readonly JudgeCacheEntry[];
}
