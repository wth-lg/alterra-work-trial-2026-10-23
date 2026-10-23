import { VIEWS, viewHref, type View } from './views.ts';

// The 60px icon rail. Links carry ?view= so a view can be shared and survives a refresh.
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
            aria-label={v.label}
            aria-current={current ? 'page' : undefined}
            title={v.label}
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
              e.preventDefault();
              onNavigate(v.id);
            }}
            className={`flex h-11 w-11 flex-col items-center justify-center gap-0.5 rounded-md text-[10px] leading-none ${current ? 'bg-canvas text-ink' : 'text-ink-muted hover:bg-canvas hover:text-ink'}`}
          >
            <Icon aria-hidden className={`h-4 w-4 ${current ? 'text-accent' : ''}`} strokeWidth={1.75} />
            <span aria-hidden>{v.label === 'Environment' ? 'Env' : v.label}</span>
          </a>
        );
      })}
    </nav>
  );
}
