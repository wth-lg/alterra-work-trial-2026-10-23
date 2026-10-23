// The wrapper every write tool goes through: the input has passed the schema (step 1) in
// callTool; before the tool's own checks, every string in it must be non-blank and free of
// unpaired surrogates (checks.ts).
import type { Tool, ToolInput } from '../registry.ts';
import { checkStrings } from './checks.ts';
import type { WriteContext } from './context.ts';

export function writeTool(tool: Tool<WriteContext>): Tool<WriteContext> {
  return {
    ...tool,
    run(input: ToolInput, ctx: WriteContext) {
      checkStrings(input, '');
      return tool.run(input, ctx);
    },
  };
}
