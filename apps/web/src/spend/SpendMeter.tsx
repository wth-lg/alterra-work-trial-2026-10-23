import { useSessionSpend } from './session.ts';

const usd = (v: number) => `$${v.toFixed(2)}`;

// Session spend against the cap, in the top bar.
export function SpendMeter() {
  const { cap, spent } = useSessionSpend();
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap text-xs text-ink-muted" title="Session spend against the session cap">
      <span>
        Spend <span className="text-ink">{usd(spent)}</span> of {usd(cap)}
      </span>
      <progress
        aria-label="Session spend"
        max={cap}
        value={Math.min(spent, cap)}
        className="h-1 w-16 appearance-none overflow-hidden rounded-full bg-line [&::-moz-progress-bar]:bg-accent [&::-webkit-progress-bar]:bg-line [&::-webkit-progress-value]:bg-accent"
      />
    </span>
  );
}
