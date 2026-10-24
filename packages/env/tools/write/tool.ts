// The wrapper every write tool goes through: the input has passed the schema (step 1) in
// callTool; before the tool's own checks, the episode must not have finished (a write after
// finish, or a second finish, is CONFLICT), and every string in the input must be non-blank and
// free of unpaired surrogates (checks.ts).
import { ToolError } from '../errors.ts';
import type { Tool, ToolInput } from '../registry.ts';
import { checkStrings } from './checks.ts';
import type { WriteContext } from './context.ts';

export function writeTool(tool: Tool<WriteContext>): Tool<WriteContext> {
  return {
    ...tool,
    run(input: ToolInput, ctx: WriteContext) {
      if (ctx.session.summary !== undefined) throw new ToolError('CONFLICT', 'episode already finished');
      checkStrings(input, '');
      return tool.run(input, ctx);
    },
  };
}
