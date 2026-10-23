// Header and text redaction for anything a live run records or prints: Playwright request,
// preflight and response dumps, console lines, error messages. x-api-key is always replaced;
// so is any value that contains one of the given secrets. Header names are kept.
export const REDACTED = '[redacted]';

// Shorter strings would redact unrelated values; keyscan uses the same floor.
const MIN_SECRET_LENGTH = 8;

export type HeaderRecord = Record<string, string>;
export type HeaderArray = Array<{ name: string; value: string }>;

const usable = (secrets: readonly string[]) => secrets.filter((s) => s.length >= MIN_SECRET_LENGTH);

function redactValue(name: string, value: string, secrets: readonly string[]): string {
  if (name.toLowerCase() === 'x-api-key') return REDACTED;
  return secrets.some((s) => value.includes(s)) ? REDACTED : value;
}

export function redactHeaders(headers: HeaderArray, secrets?: readonly string[]): HeaderArray;
export function redactHeaders(headers: HeaderRecord, secrets?: readonly string[]): HeaderRecord;
export function redactHeaders(headers: HeaderRecord | HeaderArray, secrets: readonly string[] = []): HeaderRecord | HeaderArray {
  const s = usable(secrets);
  if (Array.isArray(headers)) return headers.map(({ name, value }) => ({ name, value: redactValue(name, value, s) }));
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, redactValue(name, value, s)]));
}

export function redactText(text: string, secrets: readonly string[]): string {
  return usable(secrets).reduce((t, s) => t.split(s).join(REDACTED), text);
}
