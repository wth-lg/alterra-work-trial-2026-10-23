import { Gauge } from 'lucide-react';
import { KeyChip } from '../keygate/KeyChip.tsx';
import type { KeyStatus } from '../keygate/key.ts';
import { SpendMeter } from '../spend/SpendMeter.tsx';
import { SurfaceChip } from '../surface/SurfaceChip.tsx';
import type { Surface } from '../surface/detect.ts';

// The 48px top bar: the product name, then the surface, the effort every trial runs at, the
// session spend meter and the key status.
export function TopBar(props: { surface: Surface; status: KeyStatus; onForget: () => void; onAdd: () => void; busy: boolean }) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-4 border-b border-line bg-surface px-4">
      <span className="font-medium text-ink">Riverbend</span>
      <span className="hidden text-ink-muted sm:inline">Clinical agent environment</span>
      <span className="ml-auto flex items-center gap-3">
        <SurfaceChip surface={props.surface} />
        <span className="inline-flex items-center gap-1.5 text-xs text-ink-muted" title="Every trial runs at effort high">
          <Gauge aria-hidden className="h-3.5 w-3.5" strokeWidth={1.75} />
          Effort high
        </span>
        <SpendMeter />
        <KeyChip status={props.status} onForget={props.onForget} onAdd={props.onAdd} busy={props.busy} />
      </span>
    </header>
  );
}
