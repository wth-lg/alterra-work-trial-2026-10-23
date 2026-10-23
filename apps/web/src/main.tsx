import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { installEgressGuard } from '../../../packages/core/egress.ts';
import { dropRemembered, heldByRunner, restoreRemembered } from './keygate/key.ts';
import { App } from './shell/App.tsx';
import { detectSurface } from './surface/detect.ts';
import './styles/app.css';

installEgressGuard(globalThis);

// The surface is detected once, before the first render, so the gate never shows the wrong
// key path. A runner that already holds a key skips the gate.
const surface = await detectSurface();
if (surface.kind === 'local-runner') {
  dropRemembered();
  if (surface.health.key_set) heldByRunner();
} else {
  restoreRemembered();
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App surface={surface} />
  </StrictMode>,
);
