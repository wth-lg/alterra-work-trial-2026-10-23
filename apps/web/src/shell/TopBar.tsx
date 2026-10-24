import { Gauge } from 'lucide-react';
import { KeyChip } from '../keygate/KeyChip.tsx';
import type { KeyStatus } from '../keygate/key.ts';
import { SpendMeter } from '../spend/SpendMeter.tsx';
import { SurfaceChip } from '../surface/SurfaceChip.tsx';
import type { Surface } from '../surface/detect.ts';

// The 48px top bar: the product name, then the surface, the effort every trial runs at, the
// session spend meter and the key status. Below lg the surface, effort and meter move to a
// second row under the name and the key, so nothing scrolls sideways on a phone and Add key /
// Forget key stay on screen.
export function TopBar(props: { surface: Surface; status: KeyStatus; onForget: () => void; onAdd: () => void; busy: boolean }) {
  return (
    <header className="flex shrink-0 flex-wrap items-center gap-x-4 border-b border-line bg-surface px-4">
      <span className="flex h-12 items-center font-medium text-ink">Riverbend</span>
      <span className="hidden text-ink-muted lg:inline">Clinical agent environment</span>
      <span className="order-last -mx-4 flex w-[calc(100%+2rem)] flex-wrap items-center gap-x-3 gap-y-1 border-t border-line px-4 py-2 lg:order-none lg:mx-0 lg:ml-auto lg:w-auto lg:border-0 lg:p-0">
        <SurfaceChip surface={props.surface} />
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs text-ink-muted" title="Every trial runs at effort high">
          <Gauge aria-hidden className="h-3.5 w-3.5" strokeWidth={1.75} />
          Effort high
        </span>
        <SpendMeter />
      </span>
      <span className="ml-auto lg:ml-0">
        <KeyChip status={props.status} onForget={props.onForget} onAdd={props.onAdd} busy={props.busy} />
      </span>
    </header>
  );
}
