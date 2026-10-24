import { VIEWS, viewHref, type View } from './views.ts';

// The 60px icon rail. Links carry ?view= so a view can be shared and survives a refresh. Each
// link's name is its visible label, in full (WCAG 2.5.3); the active one is stone-200 at 80% (bg-line/80), as
// the reference sidebar's active button.
export function Rail({ active, onNavigate }: { active: View; onNavigate: (id: string) => void }) {
  return (
    <nav aria-label="Views" className="flex w-[60px] shrink-0 flex-col items-center gap-1 border-r border-line bg-surface py-2">
      {VIEWS.map((v) => {
        const current = v.id === active.id;
        const Icon = v.icon;
        return (
          <a
            key={v.id}
            href={viewHref(location.href, v.id)}
            aria-current={current ? 'page' : undefined}
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
              e.preventDefault();
              onNavigate(v.id);
            }}
            className={`flex h-11 w-14 flex-col items-center justify-center gap-1 rounded-sm text-[10px] leading-none tracking-tight ${current ? 'bg-line/80 text-ink' : 'text-ink-muted hover:bg-canvas hover:text-ink'}`}
          >
            <Icon aria-hidden className={`h-4 w-4 ${current ? 'text-accent' : ''}`} strokeWidth={1.75} />
            <span>{v.label}</span>
          </a>
        );
      })}
    </nav>
  );
}
