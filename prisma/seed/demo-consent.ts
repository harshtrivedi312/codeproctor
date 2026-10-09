// The dev-only approved demo consent text (D-69, owner decision 2026-10-08). The placeholder text
// (non-coding.ts: CONSENT_BODY_MD, version "0.1-placeholder") is deliberately unapproved and the web
// placeholder guard (apps/web/src/features/consent/placeholder-guard.ts) refuses to show it. For the
// local demo the owner approved a SYNTHETIC, development-only consent text so the candidate flow can be
// shown end to end. It is written and made current ONLY when APP_ENV is exactly "development"
// (prisma/seed/apply.ts: applyApprovedDemoConsent); staging, pilot and production never get it.
//
// The body paraphrases the placeholder's ten ADR 0007 section 10 sections as real (synthetic) prose, with
// no square-bracket fill-ins, none of the words placeholder/draft/lorem ipsum/todo/tbd, no
// @example.com/org/net address, and none of the "not approved", "pending approval" or "for owner approval"
// phrases, so evaluateConsentDocument passes it unchanged. A spec runs this body through copies of that
// guard's regexes so the text cannot regress (apps/api/test/integration/seed.int.test.ts).
import type { Prisma } from '../../apps/api/src/generated/prisma/client';
import { ID } from './ids';

/** The version string, used as the natural key with the org (consent_texts @@unique([orgId, version])).
 * Bumped for the M1 compliance-review edits (2026-10-08): a body change needs a new version (FU-DB-285). */
export const DEMO_APPROVED_CONSENT_VERSION = '0.3-local-demo';

/**
 * A footer marker the signed-consent PDF should carry for this version, so a printed copy is unmistakably a
 * demo (M1). Exported for the consent-PDF renderer (candidate track) to append for this version; the seed
 * does not render PDFs.
 */
export const DEMO_APPROVED_CONSENT_PDF_FOOTER = '(development demo, synthetic data)';

/** The first line of the body, and the human label the owner decision named. */
export const DEMO_APPROVED_CONSENT_TITLE = 'Local demo consent (synthetic data, development only)';

/** Who approved it: a fixed, synthetic marker, never a real person. */
export const DEMO_APPROVED_CONSENT_APPROVED_BY = 'local-demo (synthetic data, development only)';

/** A fixed approval time, so a re-run of the seed writes an identical row (idempotent). */
export const DEMO_APPROVED_CONSENT_APPROVED_AT = new Date('2026-01-01T00:00:00.000Z');

export const DEMO_APPROVED_CONSENT_BODY_MD = `${DEMO_APPROVED_CONSENT_TITLE}

This consent document is synthetic content for the local development demo. It is approved for use only on a developer's machine with synthetic data, and it is never shown to real candidates or used in staging, pilot or production. By continuing you agree to the terms below for this practice session. THIS IS NOT A REAL CONSENT. DEVELOPMENT DEMO ONLY.

## What is recorded

During the test we capture your screen, your webcam video, your microphone audio and your keystroke timing. Recording begins when the test starts and stops when it ends.

## Identity check

We take a photo of an identity document and a live selfie, and we store a face-match score that compares the two. We do not keep a face embedding.

## Automated detection and human review

Software marks unusual events during the session. A reviewer looks at every marked event before any verdict is set, and a marked event on its own never rejects a candidate.

## How results are used in hiring

Your score and the reviewer's outcome are shared with the hiring team to inform their decision. They are one input among several and are never the only basis for a rejection.

## Retention and deletion

Recordings and results are kept for ninety days and then removed. You may ask the talent team to delete your data sooner. The periods stated here are for the demo and are not the real retention rules.

## Who can access the data

Only the recruiter, the assigned reviewer and administrators of the organisation can see recordings and results. Access stays with the people who run the assessment.

## Appeals

If a session receives a violation verdict, you may appeal within seven days and ask for a second look.

## Accommodations

You may request extra time, or ask the talent team to switch off a specific detector, before the test starts.

## How to withdraw

Declining before the test starts ends the session and records nothing. You may stop at any time, and anything captured up to that point follows the retention rule above.
`;

/** The approved demo consent row, for an idempotent upsert on (orgId, version). */
export function buildApprovedDemoConsentText(): Prisma.ConsentTextCreateManyInput {
  return {
    id: ID.approvedConsentText,
    orgId: ID.org,
    version: DEMO_APPROVED_CONSENT_VERSION,
    bodyMd: DEMO_APPROVED_CONSENT_BODY_MD,
    legalApprovedAt: DEMO_APPROVED_CONSENT_APPROVED_AT,
    legalApprovedBy: DEMO_APPROVED_CONSENT_APPROVED_BY,
    createdById: ID.user('super-admin'),
  };
}
