// Test-only page: the real-browser POST check (e2e/live/browser-post.spec.ts). It holds no
// key: the spec passes the key as a page.evaluate argument, never in a URL or storage.
import { probeOnce, type ProbeResult } from '../../../../packages/core/anthropic.ts';
import { PROBE_PARAMS, probeHistory } from './request.ts';

declare global {
  interface Window {
    chartrProbe?: (apiKey: string) => Promise<ProbeResult>;
  }
}

window.chartrProbe = (apiKey) => probeOnce({ apiKey, history: probeHistory(), params: PROBE_PARAMS });
document.body.dataset.page = 'probe';
