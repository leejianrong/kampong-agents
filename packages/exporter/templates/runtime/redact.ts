// Vendored from packages/engine/src/redact.ts as part of a `kampong export`
// -- see docs/adr/0010-exported-runtime-is-vendored-not-retemplated.md. It is
// copied unchanged. From here on this file is yours: it will not be touched
// again by a future export.
//
// One place for secret redaction and the deep string walk (KAN-1845 review). A resolved secret
// reaches a request in more than one spelling: raw in a header, percent-encoded in a query string,
// form-encoded in a form body, JSON-escaped inside a JSON body. Redacting only the raw value
// leaves the encoded forms on disk and in logs, so every spelling is redacted.

const REDACTED = "[REDACTED]";

/** The distinct spellings a secret can take once it is placed in a request. */
export function secretVariants(secret: string): string[] {
  if (!secret) return [];
  const variants = new Set<string>([
    secret,
    encodeURIComponent(secret),
    new URLSearchParams({ v: secret }).toString().slice(2),
    JSON.stringify(secret).slice(1, -1),
  ]);
  // Longest first, so a variant that contains another is replaced whole.
  return [...variants].filter(Boolean).sort((a, b) => b.length - a.length);
}

export function redactString(value: string, secrets: readonly string[]): string {
  let result = value;
  for (const secret of secrets) {
    for (const variant of secretVariants(secret)) {
      result = result.split(variant).join(REDACTED);
    }
  }
  return result;
}

/** Applies `fn` to every string inside a JSON-like value, preserving its shape. */
export function mapStringsDeep(value: unknown, fn: (text: string) => string): unknown {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return value.map((entry) => mapStringsDeep(entry, fn));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        mapStringsDeep(entry, fn),
      ]),
    );
  }
  return value;
}
