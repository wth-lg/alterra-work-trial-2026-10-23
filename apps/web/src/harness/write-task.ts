// A harness-only task that offers a write tool, so the loop tests and the Worker parity spec
// check the state hash after a committed write (the write scenario in scenarios.ts). It is not
// under tasks/, so no TaskSource lists it on its own: each caller adds it to the directories
// its adapter reads (trial-worker.ts, worker-parity.spec.ts).
import type { TaskFiles } from '../../../../packages/core/tasks.ts';

export const WRITE_TASK: TaskFiles = {
  id: '_write',
  files: {
    'task.toml': ['[task]', 'id = "_write"', 'title = "Harness: one committed write"', 'max_turns = 6', 'tools = ["get_context", "fhir_read", "create_task", "finish"]', ''].join('\n'),
    'instruction.md': 'Create a routine follow-up Task for Patient pt-0001 owned by the RN triage pool, due 2026-11-06, then call finish.\n',
  },
};
