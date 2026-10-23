// Which surface this page is on, decided once at load. The local runner serves the UI and
// answers a same-origin GET api/health (relative to the page base) with a body parseHealth
// accepts. The static build answers with its own api/health file, which is not chartr-runner;
// any other answer, an error or no answer within the timeout also means browser-direct. Only
// the local runner is ever sent the key (keygate/runner.ts). The body is parsed from its text:
// a static host may serve the extensionless file under any content type.
import { HEALTH_PATH, parseHealth, type Health } from '../../../../packages/core/runner-api.ts';

export const HEALTH_TIMEOUT_MS = 1500;

export type Surface = { kind: 'local-runner'; health: Health } | { kind: 'browser-direct' };

export async function detectSurface(base = document.baseURI, fetchFn: typeof fetch = fetch, timeoutMs = HEALTH_TIMEOUT_MS): Promise<Surface> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(new URL(HEALTH_PATH, base), { cache: 'no-store', credentials: 'same-origin', redirect: 'error', signal: controller.signal });
    if (res.status !== 200) return { kind: 'browser-direct' };
    return { kind: 'local-runner', health: parseHealth(JSON.parse(await res.text())) };
  } catch {
    return { kind: 'browser-direct' };
  } finally {
    clearTimeout(timer);
  }
}

export const SURFACE_LABEL: Record<Surface['kind'], string> = {
  'local-runner': 'Local runner',
  'browser-direct': 'Browser-direct',
};
