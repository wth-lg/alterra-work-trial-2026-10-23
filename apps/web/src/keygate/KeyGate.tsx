import { Eye, EyeOff } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { DEFAULT_SESSION_CAP_USD, MAX_SESSION_CAP_USD, parseCap } from '../spend/cap.ts';
import { sessionCap, setSessionCap } from '../spend/session.ts';
import type { Surface } from '../surface/detect.ts';
import { LocalCommand } from '../surface/LocalCommand.tsx';
import { SurfaceChip } from '../surface/SurfaceChip.tsx';
import { validateDirect, type DirectResult } from './direct.ts';
import { heldByRunner, holdInTab } from './key.ts';
import { postKey } from './runner.ts';

type Failure = { kind: (DirectResult & { ok: false })['kind'] | 'runner'; message: string };

const WHERE: Record<Surface['kind'], string> = {
  'local-runner': 'The key goes to the local runner on this machine, which keeps it in memory and sends it only to the Anthropic API.',
  'browser-direct': "The key stays in this tab's memory and is sent only to the Anthropic API.",
};

const field = 'h-9 w-full rounded-sm border border-line-strong bg-surface px-3 text-ink placeholder:text-ink-muted';

// The key field stays type="password": the browser masks it natively and assistive technology
// announces it as a secure field. Password managers are asked not to offer to save it
// (autocomplete="off" plus the 1Password, LastPass and Bitwarden ignore attributes);
// Chromium may still offer, because it ignores autocomplete="off" on password inputs. A
// text input styled to look masked would avoid that prompt but loses the native masking and
// semantics, so the residual prompt is the accepted cost.
const NO_SAVE = { autoComplete: 'off', 'data-1p-ignore': 'true', 'data-lpignore': 'true', 'data-bwignore': 'true', 'data-form-type': 'other' } as const;

// The first screen: paste a key, Validate, go. Or browse without one.
export function KeyGate({ surface, onDone, onBrowse, notice }: { surface: Surface; onDone: () => void; onBrowse: () => void; notice?: string | undefined }) {
  const [key, setKey] = useState('');
  const [reveal, setReveal] = useState(false);
  const [remember, setRemember] = useState(false);
  const [capText, setCapText] = useState(String(sessionCap()));
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(notice ? { kind: 'runner', message: notice } : null);
  const ids = { key: useId(), hint: useId(), cap: useId(), error: useId() };
  const cap = parseCap(capText);
  const rounded = cap !== null && cap !== Number(capText.trim());
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
      {/* noValidate: parseCap decides what submits, so the browser never blocks a value the app accepts. */}
      <form onSubmit={submit} noValidate className="w-full max-w-[440px] rounded-sm border border-line bg-surface p-6">
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
            {...NO_SAVE}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            autoFocus
            placeholder="sk-ant-…"
            aria-invalid={failure !== null && failure.kind !== 'cap'}
            aria-describedby={failure ? `${ids.hint} ${ids.error}` : ids.hint}
            className={`${field} pr-9 font-mono`}
          />
          <button
            type="button"
            onClick={() => setReveal((r) => !r)}
            aria-label={reveal ? 'Hide key' : 'Show key'}
            className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-ink-muted hover:text-ink"
          >
            {reveal ? <EyeOff aria-hidden className="h-4 w-4" strokeWidth={1.75} /> : <Eye aria-hidden className="h-4 w-4" strokeWidth={1.75} />}
          </button>
        </div>
        <p id={ids.hint} className="mt-1.5 text-xs text-ink-muted">
          {WHERE[surface.kind]} Use a workspace key with a spend limit.
        </p>

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
        {cap === null && <p className="mt-1 text-xs text-ink-muted">Enter a cap from $0.01 to ${MAX_SESSION_CAP_USD}.</p>}
        {rounded && <p className="mt-1 text-xs text-ink-muted">Rounded to ${cap.toFixed(2)}.</p>}

        <div className="mt-6 flex items-center gap-3">
          <button
            type="submit"
            disabled={busy || key.trim() === '' || cap === null}
            className="h-9 rounded-sm bg-primary px-4 font-medium text-on-primary hover:opacity-90 disabled:opacity-40"
          >
            {busy ? 'Validating…' : 'Validate'}
          </button>
          <button type="button" onClick={onBrowse} className="h-9 rounded-sm px-3 text-ink-muted hover:bg-canvas hover:text-ink">
            Browse without a key
          </button>
        </div>
      </form>
    </main>
  );
}

// A plain statement first, then what to do (for org-CORS and network: run it locally, with the
// command), then the API's own line in small mono.
function FailureNote({ id, failure }: { id: string; failure: Failure }) {
  const local = failure.kind === 'org-cors' || failure.kind === 'network';
  return (
    <div id={id} role="alert" className="mt-3 rounded-sm border border-line-strong bg-canvas p-3">
      {local ? (
        <>
          <p className="font-medium text-ink">
            {failure.kind === 'org-cors' ? "This key's organization does not allow browser access." : 'The browser could not reach the API from this page.'}
          </p>
          <p className="mt-1 text-ink">Run the environment locally instead. It opens this UI and keeps the key on your machine:</p>
          <div className="mt-2">
            <LocalCommand />
          </div>
          <p className="mt-2 break-words font-mono text-xs text-ink-muted">{failure.message}</p>
        </>
      ) : (
        <p className="break-words text-ink">{failure.message}</p>
      )}
    </div>
  );
}
