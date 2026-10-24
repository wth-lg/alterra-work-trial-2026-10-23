import { useEffect, useRef, useState } from 'react';
import { KeyGate } from '../keygate/KeyGate.tsx';
import { forget, keyStatus, useKeyStatus } from '../keygate/key.ts';
import { deleteKey } from '../keygate/runner.ts';
import type { Surface } from '../surface/detect.ts';
import { EmptyView } from './EmptyView.tsx';
import { Rail } from './Rail.tsx';
import { TopBar } from './TopBar.tsx';
import { viewFromUrl, viewHref } from './views.ts';

// The app shell: the key gate first when there is no key, then the rail, the top bar and the
// view named in ?view=.
export function App({ surface }: { surface: Surface }) {
  const status = useKeyStatus();
  const [gate, setGate] = useState(() => keyStatus().kind === 'none');
  const [notice, setNotice] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState(() => viewFromUrl(location.href));
  // Set when the gate closes, so focus lands on the view's heading instead of <body>.
  const [arrived, setArrived] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (arrived && !gate) heading.current?.focus();
  }, [arrived, gate]);

  useEffect(() => {
    const onPop = () => setView(viewFromUrl(location.href));
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
  }, []);

  async function onForget() {
    setNotice(undefined);
    if (status.kind === 'runner') {
      setBusy(true);
      const r = await deleteKey();
      setBusy(false);
      if (!r.ok) {
        setNotice(`The local runner did not forget the key: ${r.message}`);
        setGate(true);
        return;
      }
    }
    forget();
    setGate(true);
  }

  const leaveGate = () => {
    setGate(false);
    setArrived(true);
  };
  if (gate) return <KeyGate surface={surface} notice={notice} onDone={leaveGate} onBrowse={leaveGate} />;

  return (
    <div className="flex h-screen flex-col bg-canvas">
      <TopBar surface={surface} status={status} onForget={onForget} onAdd={() => setGate(true)} busy={busy} />
      <div className="flex min-h-0 flex-1">
        <Rail
          active={view}
          onNavigate={(id) => {
            history.pushState(null, '', viewHref(location.href, id));
            setView(viewFromUrl(location.href));
          }}
        />
        <main className="min-w-0 flex-1 overflow-auto">
          <EmptyView view={view} headingRef={heading} />
        </main>
      </div>
    </div>
  );
}
