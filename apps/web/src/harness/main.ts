// Test-only page. It never holds a key. Playwright specs drive it through window.harness,
// which forwards each request to a module Worker and resolves with the Worker's result.
import type { HarnessReply, HarnessRequest, HarnessResult } from './protocol.ts';

declare global {
  interface Window {
    harness: { call(req: HarnessRequest): Promise<HarnessResult> };
  }
}

document.body.dataset.page = 'harness';

const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
const pending = new Map<number, { resolve(r: HarnessResult): void; reject(e: Error): void }>();
let nextId = 0;

worker.addEventListener('message', (event: MessageEvent<HarnessReply>) => {
  const reply = event.data;
  const waiter = pending.get(reply.id);
  pending.delete(reply.id);
  if (reply.ok) waiter?.resolve(reply.result);
  else waiter?.reject(new Error(reply.error));
});

window.harness = {
  call(req) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, req });
    });
  },
};
document.body.dataset.ready = 'true';
