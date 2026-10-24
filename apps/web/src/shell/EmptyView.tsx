import type { Ref } from 'react';
import type { View } from './views.ts';

// headingRef lets the shell move focus to the heading when it opens from the key gate.
export function EmptyView({ view, headingRef }: { view: View; headingRef?: Ref<HTMLHeadingElement> }) {
  const Icon = view.icon;
  return (
    <section className="mx-auto max-w-3xl px-6 py-6">
      <h1 ref={headingRef} tabIndex={-1} className="text-base font-semibold text-ink focus-visible:outline-none">{view.label}</h1>
      <div className="mt-4 flex items-start gap-3 rounded-sm border border-line bg-surface p-4">
        <Icon aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-ink-muted" strokeWidth={1.75} />
        <p className="text-ink-muted">{view.empty}</p>
      </div>
    </section>
  );
}
