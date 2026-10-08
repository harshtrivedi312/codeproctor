// Stable ids for seed rows (DB-04). Every seeded row that has a uuid key gets one derived from a
// fixed name, so a second run computes the same ids and inserts nothing. The ids are UUID version 5
// style (SHA-1 over a fixed namespace and the name). The five identity columns are GENERATED
// ALWAYS and are never set by the seed.
import { createHash } from 'node:crypto';

// Fixed for the life of the seed. Changing it makes every seeded row look new to a second run.
const NAMESPACE = Buffer.from('6f1d8c1e5b7a4c2f9e3d0a8b7c6d5e4f', 'hex');

export function seedId(name: string): string {
  const bytes = Buffer.from(createHash('sha1').update(NAMESPACE).update(name).digest());
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex', 0, 16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/**
 * A value for a hash column (invitation and refresh tokens) that no raw token can ever match: it is
 * not a SHA-256 digest, so the API's "hash what the client sent, then compare" never succeeds.
 * Seeded invitation links and refresh tokens are therefore unusable. Send a fresh invitation
 * through the API to try the candidate flow.
 */
export function unusableTokenHash(name: string): string {
  return `seed-unusable-token-hash:${seedId(name)}`;
}

/** 32 deterministic bytes that stand in for an HMAC signature. Not verifiable: no key exists. */
export function syntheticSignature(name: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(createHash('sha256').update(`seed-synthetic-signature:${name}`).digest());
}

/** The named ids of the seed. One place, so the content and delivery plans agree. */
export const ID = {
  org: seedId('org:demo-corp'),
  user: (role: string): string => seedId(`user:${role}`),
  refreshToken: (name: string): string => seedId(`refresh-token:${name}`),
  refreshFamily: (name: string): string => seedId(`refresh-family:${name}`),
  consentText: seedId('consent-text:placeholder-v0'),
  // The dev-only approved demo consent text (D-69). Written and made current only when
  // APP_ENV is exactly "development" (prisma/seed/apply.ts: applyApprovedDemoConsent). The
  // current row has its own id; a version bump (M1, compliance review) gives a new id and lists
  // the prior one in supersededDemoConsentTexts so the seed repoints an already-seeded DB.
  approvedConsentText: seedId('consent-text:local-demo-approved-v1'),
  /** Prior approved demo-consent ids (newest bump first), repointed off when a bump supersedes them. */
  supersededDemoConsentTexts: [seedId('consent-text:local-demo-approved-v0')],
  question: (slug: string): string => seedId(`question:${slug}`),
  questionVersion: (slug: string): string => seedId(`question-version:${slug}:1`),
  testCase: (slug: string, index: number): string => seedId(`test-case:${slug}:${index}`),
  variant: (slug: string, index: number): string => seedId(`variant:${slug}:${index}`),
  aiReference: (slug: string, assistant: string, language: string): string =>
    seedId(`ai-reference:${slug}:${assistant}:${language}`),
  test: (key: string): string => seedId(`test:${key}`),
  testSection: (testKey: string, position: number): string =>
    seedId(`test-section:${testKey}:${position}`),
  testQuestion: (testKey: string, sectionPosition: number, position: number): string =>
    seedId(`test-question:${testKey}:${sectionPosition}:${position}`),
  candidate: (key: string): string => seedId(`candidate:${key}`),
  invitation: (key: string): string => seedId(`invitation:${key}`),
  session: (key: string): string => seedId(`session:${key}`),
  sessionQuestion: (sessionKey: string, position: number): string =>
    seedId(`session-question:${sessionKey}:${position}`),
  submission: (sessionKey: string, position: number, kind: string): string =>
    seedId(`submission:${sessionKey}:${position}:${kind}`),
  consent: (sessionKey: string): string => seedId(`consent:${sessionKey}`),
  identityCheck: (sessionKey: string): string => seedId(`identity-check:${sessionKey}:1`),
  review: (sessionKey: string): string => seedId(`session-review:${sessionKey}`),
  flagDecision: (sessionKey: string, eventKey: string): string =>
    seedId(`flag-decision:${sessionKey}:${eventKey}`),
};
