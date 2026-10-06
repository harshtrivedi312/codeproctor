// The scanner behind consent-access.spec.ts (ADR 0004 9.5 "System carve-out", FR-105): consent
// records are read and deleted only through ConsentRetentionRepository, with a fixed column list.
// Test only.

/** What is wrong with `text` as a consumer of consent data, or an empty list. */
export function consentAccessHits(text: string): string[] {
  const hits: string[] = [];
  if (/\.consent\s*\.\s*(find|create|update|delete|upsert|count|aggregate|groupBy)\w*/.test(text)) {
    hits.push('client access to the consent model');
  }
  if (/\.consent\s*\(/.test(text)) hits.push('fluent .consent()');
  if (/\[\s*['"`]consent['"`]\s*\]/.test(text)) hits.push('bracket access to consent');
  if (/\.consent\s*\?\./.test(text)) hits.push('optional-chained consent access');
  if (/\b(include|select)\s*:\s*\{[^}]*\bconsent\s*:/.test(text))
    hits.push('consent in an include or select (any value)');
  if (/\{[^}]*\bconsent\b[^}]*\}\s*=\s*\w*(tx|client|prisma)\b/i.test(text))
    hits.push('consent destructured from a client');
  if (/\bconsent\s*:\s*(true|\{)/.test(text)) hits.push('consent in an include or select');
  if (/\bsignedName\b/.test(text)) hits.push('signedName');
  if (
    /\b(FROM|JOIN|INTO|UPDATE|DELETE\s+FROM|TRUNCATE)\s+("?public"?\.)?"?consents"?\b/i.test(text)
  ) {
    hits.push('raw SQL on consents');
  }
  return hits;
}
