// The dev-only demo consent text ("0.2-local-demo", prisma/seed/demo-consent.ts) must never reach a
// real candidate. In a shared environment (staging, pilot, production, or anything that is not
// APP_ENV development/test) the consent service and the consent PDF job refuse to serve, accept,
// store or email a text that carries a demo marker, even when legal_approved_at is set, e.g. after a
// restore, a dump or a manual insert (compliance review 2026-10-08, K2/F6).
// The markers are the seed's strings: a version ending "-local-demo" and an approver STARTING
// "local-demo" (a prefix, so a suffix such as "(synthetic data, development only)" still matches).
// They are compared after NFKC, trim and lower-casing so a copied value with different case or
// spacing still matches. Anyone who can hand-write consent_texts in a shared DB can defeat any
// string marker; this guards accidental copies of the seeded row (FU-BEB-149).
import type { ConfigService } from '@nestjs/config';
import { isSharedEnv } from '../config/env';
import type { Env } from '../config/env';

const DEMO_VERSION_SUFFIX = '-local-demo';
const DEMO_APPROVER_PREFIX = 'local-demo';

const fold = (s: string): string => s.normalize('NFKC').trim().toLowerCase();

export function isDemoConsentText(text: {
  readonly version: string;
  readonly legalApprovedBy: string | null;
}): boolean {
  return (
    fold(text.version).endsWith(DEMO_VERSION_SUFFIX) ||
    (text.legalApprovedBy !== null && fold(text.legalApprovedBy).startsWith(DEMO_APPROVER_PREFIX))
  );
}

/** True when this environment is shared and the text is a demo text: it must not be used. */
export function isDemoTextRefused(
  config: ConfigService<Env, true>,
  text: { readonly version: string; readonly legalApprovedBy: string | null },
): boolean {
  return (
    isSharedEnv({
      APP_ENV: config.get('APP_ENV', { infer: true }),
      NODE_ENV: config.get('NODE_ENV', { infer: true }),
    }) && isDemoConsentText(text)
  );
}
