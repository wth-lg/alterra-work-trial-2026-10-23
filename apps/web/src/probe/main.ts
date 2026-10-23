// Test-only page: the real-browser POST check (e2e/live/browser-post.spec.ts). It holds no
// key and no API code: the spec's MessagesClient sends through pageFetch here, passing the
// request (key included) as a page.evaluate argument, never in a URL or storage.
import { pageFetch } from './transport.ts';

declare global {
  interface Window {
    chartrFetch?: typeof pageFetch;
  }
}

window.chartrFetch = pageFetch;
document.body.dataset.page = 'probe';
