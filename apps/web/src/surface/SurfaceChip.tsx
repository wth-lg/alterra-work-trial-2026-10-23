import { Globe, Server } from 'lucide-react';
import { SURFACE_LABEL, type Surface } from './detect.ts';

const HINT: Record<Surface['kind'], string> = {
  'local-runner': 'Trials run in the local runner on this machine. The key stays in its memory.',
  'browser-direct': 'Trials run in this tab and call the API directly. The key stays in tab memory.',
};

export function SurfaceChip({ surface }: { surface: Surface }) {
  const Icon = surface.kind === 'local-runner' ? Server : Globe;
  return (
    <span title={HINT[surface.kind]} className="inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-line px-2 text-xs text-ink-muted">
      <Icon aria-hidden className="h-3.5 w-3.5" strokeWidth={1.75} />
      <span data-testid="surface-chip">{SURFACE_LABEL[surface.kind]}</span>
    </span>
  );
}
