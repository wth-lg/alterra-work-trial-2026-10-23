import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { installEgressGuard } from '../../../packages/core/egress.ts';
import { dropRemembered, heldByRunner, restoreRemembered } from './keygate/key.ts';
import { runnerToken } from './keygate/runner.ts';
import { App } from './shell/App.tsx';
import { refreshSpent } from './spend/session.ts';
import { detect } from './surface/detect.ts';
import { RunnerDown } from './surface/RunnerDown.tsx';
import './styles/app.css';

installEgressGuard(globalThis);

// The surface is detected once, before the first render, so the gate never shows the wrong
// key path. A runner that already holds a key skips the gate. The tab ledger is read back
// before the meter first shows, so a reload keeps the session's spend.
const [surface] = await Promise.all([detect(runnerToken() !== null), refreshSpent()]);
if (surface.kind === 'local-runner') {
  dropRemembered();
  if (surface.health.key_loaded) heldByRunner();
} else if (surface.kind === 'browser-direct') {
  restoreRemembered();
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>{surface.kind === 'runner-down' ? <RunnerDown /> : <App surface={surface} />}</StrictMode>,
);
