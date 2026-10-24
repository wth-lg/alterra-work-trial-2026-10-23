import { RotateCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { detectSurface } from './detect.ts';
import { LocalCommand } from './LocalCommand.tsx';

export const RETRY_MS = 2000;

// The runner's own page when its api/health did not answer as chartr-runner. It retries every
// RETRY_MS and on an answer reloads, which also picks up a new token if the runner restarted.
// Nothing here takes a key.
export function RunnerDown() {
  const [checking, setChecking] = useState(false);

  async function check() {
    setChecking(true);
    const s = await detectSurface();
    if (s.kind === 'local-runner') location.reload();
    else setChecking(false);
  }

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const loop = async () => {
      if ((await detectSurface()).kind === 'local-runner') return location.reload();
      if (!stop) timer = setTimeout(loop, RETRY_MS);
    };
    timer = setTimeout(loop, RETRY_MS);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, []);

  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas px-4 py-10">
      <section className="w-full max-w-[440px] rounded-sm border border-line bg-surface p-6" aria-labelledby="runner-down">
        <span className="text-xs text-ink-muted">Riverbend clinical agent environment</span>
        <h1 id="runner-down" className="mt-4 text-base font-semibold text-ink">
          Local runner not responding
        </h1>
        <p className="mt-1 text-ink-muted">
          This page comes from the local runner, but the runner did not answer. Check the terminal where it runs, or start it again. This page retries every few seconds.
        </p>
        <div className="mt-4">
          <LocalCommand />
        </div>
        <button
          type="button"
          onClick={check}
          disabled={checking}
          className="mt-4 inline-flex h-9 items-center gap-2 rounded-sm border border-line-strong px-3 text-ink hover:bg-canvas disabled:opacity-50"
        >
          <RotateCw aria-hidden className="h-4 w-4" strokeWidth={1.75} />
          {checking ? 'Checking…' : 'Retry now'}
        </button>
      </section>
    </main>
  );
}
