// Allowed in every scoped directory: both runtimes provide these.
export const digest = (data: Uint8Array) => crypto.subtle.digest('SHA-256', data);
export const load = (url: string) => fetch(url);
export const epoch = new Date(0);
export const parsed = Date.parse('2026-10-23T00:00:00Z');
