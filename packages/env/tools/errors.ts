// Tool errors (design section 3, "Errors"). A tool reports a fault that is the model's by
// throwing a ToolError; the registry turns it into `is_error: true` with
// {"error":{"code","message","field?"}}. Anything else a tool throws is a bug in the
// environment: it propagates out of callTool, and the loop that called the tool records it as
// INTERNAL and flags the trial ENV_ERROR. eslint-rules/no-generic-catch.js keeps every catch
// in tools/ from turning such a bug into an ordinary result.

export const ERROR_CODES = ['INVALID_INPUT', 'NOT_FOUND', 'CONFLICT', 'NOT_SUPPORTED', 'INTERNAL'] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorBody {
  error: { code: ErrorCode; message: string; field?: string };
}

export class ToolError extends Error {
  override name = 'ToolError';
  readonly code: ErrorCode;
  // The input property at fault, when there is one.
  readonly field: string | undefined;

  constructor(code: ErrorCode, message: string, field?: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.field = field;
  }

  body(): ErrorBody {
    return { error: { code: this.code, message: this.message, ...(this.field === undefined ? {} : { field: this.field }) } };
  }
}

// The result body for an exception that escaped a tool. The message names the exception so
// the trial record can locate the bug; it carries no stack.
export function internalError(e: unknown): ErrorBody {
  const what = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return { error: { code: 'INTERNAL', message: `environment error (${what})` } };
}
