/**
 * Canonical JSON for signing: UTF-8, no whitespace, object keys sorted by UTF-16 code unit,
 * `undefined` members dropped. ARC-03 has not fixed the canonical form yet; this follows the
 * common JCS (RFC 8785) subset that our payloads use (strings, integers, finite numbers, booleans,
 * null, arrays, objects). The API verifies the exact `body` string it receives, so the server does
 * not need to re-canonicalise (see docs/followups/proctor-sdk.md).
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('Non-finite number cannot be signed.');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v ?? null)).join(',')}]`;
      const obj = value as Record<string, unknown>;
      const parts: string[] = [];
      for (const key of Object.keys(obj).sort()) {
        const v = obj[key];
        if (v === undefined) continue;
        parts.push(`${JSON.stringify(key)}:${canonicalJson(v)}`);
      }
      return `{${parts.join(',')}}`;
    }
    default:
      throw new TypeError(`Cannot sign a value of type ${typeof value}.`);
  }
}
