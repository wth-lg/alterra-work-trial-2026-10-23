import { Check, Copy, Eye, EyeOff } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { DEFAULT_SESSION_CAP_USD, MAX_SESSION_CAP_USD, parseCap } from '../spend/cap.ts';
import { sessionCap, setSessionCap } from '../spend/session.ts';
import { LOCAL_START_COMMAND } from '../surface/command.ts';
import type { Surface } from '../surface/detect.ts';
import { SurfaceChip } from '../surface/SurfaceChip.tsx';
import { validateDirect, type DirectResult } from './direct.ts';
import { heldByRunner, holdInTab } from './key.ts';
import { postKey } from './runner.ts';

type Failure = { kind: (DirectResult & { ok: false })['kind'] | 'runner'; message: string };

const WHERE: Record<Surface['kind'], string> = {
  'local-runner': 'The key goes to the local runner on this machine, which keeps it in memory and sends it only to the Anthropic API.',
  'browser-direct': "The key stays in this tab's memory and is sent only to the Anthropic API.",
};

const field = 'h-9 w-full rounded-md border border-line-strong bg-surface px-3 text-ink placeholder:text-ink-subtle';

// The first screen: paste a key, Validate, go. Or browse without one.
export function KeyGate({ surface, onDone, onBrowse, notice }: { surface: Surface; onDone: () => void; onBrowse: () => void; notice?: string | undefined }) {
  const [key, setKey] = useState('');
  const [reveal, setReveal] = useState(false);
  const [remember, setRemember] = useState(false);
  const [capText, setCapText] = useState(String(sessionCap()));
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(notice ? { kind: 'runner', message: notice } : null);
  const ids = { key: useId(), cap: useId(), error: useId() };
  const cap = parseCap(capText);
  const direct = surface.kind === 'browser-direct';

  async function submit(e: FormEvent) {
    e.preventDefault();
    const k = key.trim();
    if (k === '' || cap === null || busy) return;
    setBusy(true);
    setFailure(null);
    setSessionCap(cap);
    try {
      if (direct) {
        const r = await validateDirect(k, cap);
        if (!r.ok) return setFailure(r);
        holdInTab(k, remember);
      } else {
        const r = await postKey(k);
        if (!r.ok) return setFailure({ kind: 'runner', message: r.message });
        heldByRunner();
      }
      setKey('');
      onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas px-4 py-10">
      <form onSubmit={submit} className="w-full max-w-[440px] rounded border border-line bg-surface p-6" aria-describedby={failure ? ids.error : undefined}>
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-ink-muted">Riverbend clinical agent environment</span>
          <SurfaceChip surface={surface} />
        </div>
        <h1 className="mt-4 text-base font-semibold text-ink">Add an API key</h1>
        <p className="mt-1 text-ink-muted">Paste an Anthropic API key and press Validate. Browsing needs no key.</p>

        <label htmlFor={ids.key} className="mt-5 block font-medium text-ink">
          API key
        </label>
        <div className="relative mt-1.5">
          <input
            id={ids.key}
            type={reveal ? 'text' : 'password'}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            autoFocus
            placeholder="sk-ant-…"
            aria-invalid={failure !== null && failure.kind !== 'cap'}
            className={`${field} pr-9 font-mono`}
          />
          <button
            type="button"
            onClick={() => setReveal((r) => !r)}
            aria-label={reveal ? 'Hide key' : 'Show key'}
            className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-ink-subtle hover:text-ink"
          >
            {reveal ? <EyeOff aria-hidden className="h-4 w-4" strokeWidth={1.75} /> : <Eye aria-hidden className="h-4 w-4" strokeWidth={1.75} />}
          </button>
        </div>
        <p className="mt-1.5 text-xs text-ink-muted">{WHERE[surface.kind]} Use a workspace key with a spend limit.</p>

        {failure && <FailureNote id={ids.error} failure={failure} />}

        <div className="mt-4 flex items-end gap-4">
          <div className="w-44">
            <label htmlFor={ids.cap} className="block text-xs text-ink-muted">
              Session spend cap (USD)
            </label>
            <input
              id={ids.cap}
              type="number"
              inputMode="decimal"
              min="0.01"
              max={MAX_SESSION_CAP_USD}
              step="0.01"
              value={capText}
              onChange={(e) => setCapText(e.target.value)}
              placeholder={String(DEFAULT_SESSION_CAP_USD)}
              aria-invalid={cap === null}
              className={`${field} mt-1 h-8`}
            />
          </div>
          {direct && (
            <label className="mb-1.5 inline-flex items-center gap-2 text-ink-muted">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="h-3.5 w-3.5 accent-accent" />
              Remember in this tab
            </label>
          )}
        </div>
        {cap === null && <p className="mt-1 text-xs text-ink-muted">Enter a cap above $0 and at most ${MAX_SESSION_CAP_USD}.</p>}

        <div className="mt-6 flex items-center gap-3">
          <button
            type="submit"
            disabled={busy || key.trim() === '' || cap === null}
            className="h-9 rounded-md bg-primary px-4 font-medium text-on-primary hover:opacity-90 disabled:opacity-40"
          >
            {busy ? 'Validating…' : 'Validate'}
          </button>
          <button type="button" onClick={onBrowse} className="h-9 rounded-md px-3 text-ink-muted hover:bg-canvas hover:text-ink">
            Browse without a key
          </button>
        </div>
      </form>
    </main>
  );
}

function FailureNote({ id, failure }: { id: string; failure: Failure }) {
  const local = failure.kind === 'org-cors' || failure.kind === 'network';
  return (
    <div id={id} role="alert" className="mt-3 rounded-md border border-line-strong bg-canvas p-3">
      <p className="break-words font-mono text-xs text-ink">{failure.message}</p>
      {failure.kind === 'org-cors' && <p className="mt-2 text-ink">This key's organization does not allow browser access.</p>}
      {failure.kind === 'network' && <p className="mt-2 text-ink">The browser could not reach the API from this page.</p>}
      {local && <LocalCommand />}
    </div>
  );
}

function LocalCommand() {
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
    <div className="mt-2">
      <p className="text-ink-muted">Run the environment locally instead; it opens this UI with the key kept on your machine:</p>
      <div className="mt-1.5 flex items-start gap-2 rounded-md border border-line bg-surface p-2">
        <code data-testid="local-command" className="min-w-0 flex-1 break-all font-mono text-xs text-ink">
          {LOCAL_START_COMMAND}
        </code>
        <button type="button" onClick={copy} aria-label="Copy command" title="Copy command" className="shrink-0 rounded p-1 text-ink-muted hover:bg-canvas hover:text-ink">
          {copied ? <Check aria-hidden className="h-3.5 w-3.5 text-accent" strokeWidth={2} /> : <Copy aria-hidden className="h-3.5 w-3.5" strokeWidth={1.75} />}
        </button>
      </div>
    </div>
  );
}
