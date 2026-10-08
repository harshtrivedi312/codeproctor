// The dev-only demo consent text ("0.2-local-demo", prisma/seed/demo-consent.ts) must never reach a
// real candidate. In a shared environment (staging, pilot, production, or anything that is not
// APP_ENV development/test) the consent service refuses to serve or accept a text that carries a
// demo marker, even when legal_approved_at is set, e.g. after a restore, a dump or a manual insert
// (compliance review 2026-10-08, K2/F6).
const DEMO_VERSION_SUFFIX = '-local-demo';
const DEMO_APPROVER_PREFIX = 'local-demo';

export function isDemoConsentText(text: {
  readonly version: string;
  readonly legalApprovedBy: string | null;
}): boolean {
  return (
    text.version.endsWith(DEMO_VERSION_SUFFIX) ||
    (text.legalApprovedBy?.startsWith(DEMO_APPROVER_PREFIX) ?? false)
  );
}
