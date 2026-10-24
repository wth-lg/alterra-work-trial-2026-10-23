// The Worker side of a browser trial (design section 1: one dedicated Worker per trial). The
// page posts one start message; the host runs run() and posts each TrialEvent as it is emitted,
// then the record. A cancel message aborts the trial through run()'s signal, so it ends with a
// cancelled event. The Worker entry passes its global scope and a setup that builds what run()
// takes from the start message: the task source, the world, the clock and a MessagesClient
// from a BatchGrant (apps/web/src/adapters/), so the host itself touches no DOM or Worker
// global and sends only through that client. Setup defers its teardown (closing the grant) as
// soon as it has something to tear down; the host runs what was deferred once, after run() or
// when setup fails, before it posts the result or the failure.
import type { TrialEvent } from './events.ts';
import { run, type Effort, type RunOptions, type TrialRecord } from './run.ts';

export interface HostStart {
  type: 'start';
  task: string;
  model: string;
  effort?: Effort;
  maxTurns?: number;
  maxCostUsd?: number;
  maxWallMs?: number;
  trialId?: string;
}
export type HostInbound<S extends HostStart = HostStart> = S | { type: 'cancel'; reason?: string };
export type HostOutbound = { type: 'event'; event: TrialEvent } | { type: 'result'; record: TrialRecord } | { type: 'failed'; error: string };

export interface HostScope {
  postMessage(message: HostOutbound): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
}

// What setup provides; the host adds the caps, effort, signal and onEvent from the start message.
// run() clamps maxCostUsd to the per-trial cap, so a start message cannot raise it.
export type HostSetup<S extends HostStart> = (
  start: S,
  defer: (teardown: () => Promise<void> | void) => void,
) => Promise<Pick<RunOptions, 'tasks' | 'client' | 'world' | 'worldHash' | 'now' | 'timeout' | 'definitions'>>;

export function hostTrial<S extends HostStart>(scope: HostScope, setup: HostSetup<S>): void {
  const controller = new AbortController();
  let started = false;
  scope.addEventListener('message', ({ data }) => {
    const msg = data as HostInbound<S>;
    if (msg?.type === 'cancel') {
      controller.abort(msg.reason ?? 'cancelled by the page');
      return;
    }
    if (msg?.type !== 'start') return;
    if (started) {
      scope.postMessage({ type: 'failed', error: 'this Worker already ran a trial; start each trial in a new Worker' });
      return;
    }
    started = true;
    const teardowns: Array<() => Promise<void> | void> = [];
    void (async () => {
      let record: TrialRecord;
      try {
        const deps = await setup(msg, (t) => teardowns.push(t));
        ({ record } = await run(msg.task, msg.model, {
          ...deps,
          signal: controller.signal,
          onEvent: (event) => scope.postMessage({ type: 'event', event }),
          ...(msg.effort === undefined ? {} : { effort: msg.effort }),
          ...(msg.maxTurns === undefined ? {} : { maxTurns: msg.maxTurns }),
          ...(msg.maxCostUsd === undefined ? {} : { maxCostUsd: msg.maxCostUsd }),
          ...(msg.maxWallMs === undefined ? {} : { maxWallMs: msg.maxWallMs }),
          ...(msg.trialId === undefined ? {} : { trialId: msg.trialId }),
        }));
      } finally {
        for (const t of teardowns.reverse()) await t();
      }
      scope.postMessage({ type: 'result', record });
    })().catch((e: unknown) => scope.postMessage({ type: 'failed', error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }));
  });
}
