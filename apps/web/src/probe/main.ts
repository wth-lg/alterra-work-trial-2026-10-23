// Test-only page: the real-browser POST check (e2e/live/browser-post.spec.ts). It holds no
// key: the spec's MessagesClient, in Node, sends through pageFetch here, passing the request
// (key included) as a page.evaluate argument, never in a URL or storage. The page installs the
// egress guard like every entry point; the relay keeps the fetch from before it, because the
// Request it forwards was registered and claimed on the Node side (relayFetch), and a Request
// cannot cross into the page. window.clinenvFetch is the page's one path to the API host.
import { installEgressGuard } from '../../../../packages/core/egress.ts';
import { pageFetch, type PageReply, type PageRequest } from './transport.ts';

declare global {
  interface Window {
    clinenvFetch?: (url: string, req: PageRequest) => Promise<PageReply>;
  }
}

const send = globalThis.fetch.bind(globalThis);
installEgressGuard(globalThis);

window.clinenvFetch = (url, req) => pageFetch(send, url, req);
document.body.dataset.page = 'probe';
