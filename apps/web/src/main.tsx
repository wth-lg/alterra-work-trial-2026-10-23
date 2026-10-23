import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { installEgressGuard } from '../../../packages/core/egress.ts';
import './index.css';

installEgressGuard(globalThis);

function App() {
  return (
    <main className="min-h-screen bg-stone-50 p-8 text-stone-900">
      <h1 className="text-2xl font-semibold">Riverbend clinical agent environment</h1>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
