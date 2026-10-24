// Test-only page. It never holds a key. Playwright specs drive it through window.harness,
// which forwards each request to a module Worker and resolves with the Worker's result.
// harness.trial runs one mocked trial in its own trial Worker (trial-worker.ts) and collects
// the events that Worker posts, in order, until its result.
import type { TrialEvent } from '../../../../packages/core/events.ts';
import type { TrialRecord } from '../../../../packages/core/run.ts';
import type { HostOutbound } from '../../../../packages/core/worker-host.ts';
import type { HarnessReply, HarnessRequest, HarnessResult } from './protocol.ts';
import type { HarnessStart } from './trial-worker.ts';

// The result type of each operation.
export type ResultOf<R extends HarnessRequest> = Extract<HarnessResult, { op: R['op'] }>;

declare global {
  interface Window {
    harness: {
      call<R extends HarnessRequest>(req: R): Promise<ResultOf<R>>;
      trial(start: Omit<HarnessStart, 'type'>): Promise<{ events: TrialEvent[]; record: TrialRecord }>;
    };
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
  call<R extends HarnessRequest>(req: R) {
    const id = nextId++;
    return new Promise<ResultOf<R>>((resolve, reject) => {
      // The Worker answers each request with the result of the same op.
      pending.set(id, { resolve: (r) => resolve(r as ResultOf<R>), reject });
      worker.postMessage({ id, req });
    });
  },
  trial(start) {
    const trialWorker = new Worker(new URL('./trial-worker.ts', import.meta.url), { type: 'module' });
    const events: TrialEvent[] = [];
    return new Promise((resolve, reject) => {
      trialWorker.addEventListener('message', ({ data }: MessageEvent<HostOutbound>) => {
        if (data.type === 'event') events.push(data.event);
        else {
          trialWorker.terminate();
          if (data.type === 'result') resolve({ events, record: data.record });
          else reject(new Error(data.error));
        }
      });
      trialWorker.addEventListener('error', (e) => reject(new Error(e.message)));
      trialWorker.postMessage({ type: 'start', ...start } satisfies HarnessStart);
    });
  },
};
document.body.dataset.ready = 'true';
