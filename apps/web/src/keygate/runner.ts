// The key gate on the local runner: Validate posts the key to the same-origin runner, which
// makes the validation call from Node and keeps the key in its memory; Forget deletes it there.
// Both send the X-Clinenv-Token the runner injected into index.html, so another page on this
// machine cannot set or clear the runner's key. The tab keeps no copy after a 200. Every
// message is redacted against the key the tab holds at that moment, as MessagesClient redacts
// browser-direct errors: the runner contract says it never echoes the key, and this keeps a
// runner that breaks it from showing the key on screen.
import { redactText } from '../../../../packages/core/redact.ts';
import { KEY_PATH, parseKeyState, parseRunnerError, TOKEN_HEADER, TOKEN_META } from '../../../../packages/core/runner-api.ts';

export type RunnerResult = { ok: true } | { ok: false; message: string };

export function runnerToken(doc: Document = document): string | null {
  return doc.querySelector<HTMLMetaElement>(`meta[name="${TOKEN_META}"]`)?.content || null;
}

const NO_TOKEN = "This page has no runner token. Open the UI at the address the runner printed and try again.";

async function call(method: 'POST' | 'DELETE', token: string | null, key?: string): Promise<RunnerResult> {
  const r = await send(method, token, key);
  return r.ok ? r : { ok: false, message: redactText(r.message, key === undefined ? [] : [key]) };
}

async function send(method: 'POST' | 'DELETE', token: string | null, key?: string): Promise<RunnerResult> {
  if (token === null) return { ok: false, message: NO_TOKEN };
  const body = key === undefined ? undefined : JSON.stringify({ key });
  let res: Response;
  try {
    res = await fetch(new URL(KEY_PATH, document.baseURI), {
      method,
      headers: { [TOKEN_HEADER]: token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      credentials: 'same-origin',
      cache: 'no-store',
      // A redirect would re-send the key body to wherever it points.
      redirect: 'error',
      ...(body === undefined ? {} : { body }),
    });
  } catch (e) {
    return { ok: false, message: `The local runner did not answer: ${(e as Error).message}` };
  }
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    // not JSON: the status says enough
  }
  if (res.status === 200) {
    try {
      const state = parseKeyState(parsed);
      if (state.key_set === (method === 'POST')) return { ok: true };
    } catch {
      // falls through to the error below
    }
    return { ok: false, message: `The local runner answered ${method} ${KEY_PATH} with an unexpected body.` };
  }
  try {
    return { ok: false, message: parseRunnerError(parsed).error.message };
  } catch {
    return { ok: false, message: `The local runner answered HTTP ${res.status}.` };
  }
}

export const postKey = (key: string, token = runnerToken()) => call('POST', token, key);
export const deleteKey = (token = runnerToken()) => call('DELETE', token);
