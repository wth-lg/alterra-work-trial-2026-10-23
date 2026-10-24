import { Check, Copy } from 'lucide-react';
import { Fragment, useState } from 'react';
import { LOCAL_START_COMMAND } from './command.ts';

// The command split at spaces and after each slash. Each piece stays on one line (no break
// inside a token), and a line may break only at a space or after a slash. The text content is
// still exactly LOCAL_START_COMMAND.
const PIECES = LOCAL_START_COMMAND.split(' ').map((word) => word.split(/(?<=\/)/));

// LOCAL_START_COMMAND with a Copy button, on the org-CORS note and the runner-down screen.
export function LocalCommand() {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(LOCAL_START_COMMAND);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="flex items-start gap-2 rounded-sm border border-line bg-surface p-2">
      <code data-testid="local-command" className="min-w-0 flex-1 font-mono text-xs leading-5 text-ink">
        {PIECES.map((parts, w) => (
          <Fragment key={w}>
            {w > 0 && ' '}
            {parts.map((p, i) => (
              <Fragment key={i}>
                {i > 0 && <wbr />}
                <span data-piece className="whitespace-nowrap">
                  {p}
                </span>
              </Fragment>
            ))}
          </Fragment>
        ))}
      </code>
      <button
        type="button"
        onClick={copy}
        aria-label="Copy command"
        title="Copy command"
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-ink-muted hover:bg-canvas hover:text-ink"
      >
        {copied ? <Check aria-hidden className="h-3.5 w-3.5 text-accent" strokeWidth={2} /> : <Copy aria-hidden className="h-3.5 w-3.5" strokeWidth={1.75} />}
      </button>
    </div>
  );
}
