import type { View } from './views.ts';

export function EmptyView({ view }: { view: View }) {
  const Icon = view.icon;
  return (
    <section className="mx-auto max-w-3xl px-6 py-6">
      <h1 className="text-base font-semibold text-ink">{view.label}</h1>
      <div className="mt-4 flex items-start gap-3 rounded border border-line bg-surface p-4">
        <Icon aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-ink-subtle" strokeWidth={1.75} />
        <p className="text-ink-muted">{view.empty}</p>
      </div>
    </section>
  );
}
