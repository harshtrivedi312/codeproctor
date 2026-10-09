# Compliance review: optional staff 2FA (PR #327) and the dev-only demo consent (PR #322)

Status: **DRAFT for owner approval.** Reviewed 2026-10-08 by the compliance reviewer, at the Delivery Lead's request under the owner's instruction that compliance and legal-approval documents go through compliance review first. This prepares the owner's approval; it does not replace it, or the professional legal review C-15 and R-17 call for. Nothing here changes an owner decision (D-70, D-71, D-73). Reviewed heads: #327 at `7095838f` (branch `dl/d70-compliance`), #322 at `55b694bb` (branch `db/demo-consent-text`). Legal statements are claims for a qualified lawyer to confirm.

## Summary

1. #327 is accurate in what it removes, but the replacement sentence in consent section 6 is confusing for a candidate and duplicates a sentence that already follows it.
2. The R1 re-rating to "Medium to high" is too low for EU/UK candidates and for Illinois biometric data. The DPIA's own section 9 (overall residual risk "Medium"; no Art. 36 consultation) was not updated and is now inconsistent with R1.
3. Optional password-only access to face images and recordings is the weakest point in the whole package. It is the owner's decision (D-70), so I record it as a risk and a recommendation, not an override. Under CLAUDE.md rule 3 it is a security weakness in authentication, so the code PRs that implement D-70 need the Lead's decision on whether it blocks them.
4. No other compliance document except `decisions.md` C-21 answer (3) still assumes mandatory reviewer 2FA. No new consent version number or re-consent is needed now, because no version has been approved or served; the rule for later is in F5.
5. #322's demo consent text is safe for development by construction (the seed refuses outside local development), but nothing in the pilot/production path would reject it if the row ever reached another database. Two small code guards are recommended (D3).

## Part A. PR #327 (consent v0.4, DPIA v0.3, status R-23)

### A1. Consent section 6: is the new wording accurate and not misleading?

**v0.4 text:** "Every Reviewer signs in to their own account, two-factor sign-in is recommended to them, and every time anyone opens your recordings or images it is logged."

- **Accurate?** Mostly. A `REVIEW_PLAYBACK_ISSUED` audit row is written whenever a playback link is issued (`apps/api/src/review/review.controller.ts:61`). That is "logged when a recording is opened", close enough. I found no equivalent audit for opening the ID image or selfie; *verify* before the document says "recordings or images".
- **Misleading?** Not intentionally, but it is poor candidate text. "Two-factor sign-in is recommended to them" tells a candidate nothing they can use, uses jargon, and reads as a security promise it does not make. It also now repeats the sentence two lines below: "Every time a staff member opens your recordings or images, it is logged."
- **Wrong direction to over-correct.** Do not promise a security control the system does not enforce (that is what D-73 fixed). Equally, a consent document is not where security controls should be described at all; Art. 13 only needs recipients and categories, and security belongs in the privacy notice.

**Should-fix F1. Replacement wording (draft for approval), section 6 Reviewer bullet:**

> - **Our staff with the Reviewer role** see the recordings, images, flags and your code, so they can review the assessment. They sign in to their own accounts.

and keep the existing later sentence, with one word changed so it is checkable against the code:

> Every time a staff member opens one of your recordings or images, it is logged.

(Backend to confirm that opening the ID image and selfie is audited. If it is not, say "recordings" only until it is.)

### A2. DPIA v0.3 and R1: is the re-rating and are the measures sound?

What #327 does: Medium to "Medium to high", "accepted by the owner, D-73", and lists two measures "not yet decided".

**Findings**

1. **The rating is too low where the harm is greatest.** The assets behind R1 are ID images, selfies, face recordings and verdicts. Likelihood moves from "possible" towards "likely" when a single phished or reused password opens all of it (credential stuffing is the commonest real-world route). With severity "severe" and no second factor, the residual risk should be shown as **High** for EU/UK candidates and for any Illinois candidate, until a second factor or an equivalent control is in place. Regulators treat multi-factor authentication for access to special-category and biometric data as an expected measure under GDPR Art. 32; BIPA 15(e) requires the "reasonable standard of care" for the industry. Both are the owner's judgement to accept, but the DPIA should say "High" so the acceptance is informed.
2. **Section 9 is now wrong.** "Overall residual risk: Medium, acceptable for a pilot if ..." and "Prior consultation (Art. 36): not needed if the residual risks above are accepted as medium or low" were written with R1 at Medium. With R1 High, either the high residual risk is mitigated before the first EU/UK candidate, or the Art. 36 line must say prior consultation with the regulator is to be considered. Update section 9 in the same PR.
3. **D-76 is missing**, as the Lead noted (email to the account holder on 2FA changes; approved after the PR was written; PR #329 holds the contract change). Add it as a *planned* measure, not an existing one.
4. **The measures list is thin.** Email on 2FA changes helps after an attacker disables or resets 2FA, but does nothing against an attacker who simply logs in. Compensating measures that fit a password-only account, in order of value:
   - least-privilege access: a Reviewer can open only the sessions assigned to them, not every session in the organisation (check ADR 0006 org scoping; say if per-assignment access exists);
   - alerts on unusual access: bulk playback issuance, access outside working hours or from a new country, many sessions opened in a short time;
   - short sessions and re-authentication (password again) before issuing a playback link for ID images;
   - breached-password checking and a minimum password length on staff accounts;
   - the existing measures that stay valid: 15-minute playback URLs, the append-only access log, lockout, org scoping.
5. **The "revisit before the pilot" recommendation is only in the Lead's note (D-70), not in the DPIA.** Put it in section 6 (measures still to put in place) with an owner and a date: "Decide before the first real candidate whether 2FA is required again for Reviewer and Super Admin."

**Should-fix F2. Replacement wording (draft for approval):**

DPIA R1 row, last two columns:

> Encryption at rest; private buckets; 15-minute playback URLs; org scoping; audit log of every access; least-privilege roles; lockout; incident response plan (DEP-02). **Two-factor sign-in is recommended but optional (D-70), so a stolen or reused reviewer or admin password alone opens recordings and ID images.** Planned, not yet in place: an email to the account holder when two-factor is turned on, off or reset (D-76, PR #329); alerts on unusual access; a password re-check before issuing playback of ID images; breached-password checking. Not yet decided: requiring two-factor again before the first real candidate.
> Residual: **High** (raised from Medium by D-70) for EU/UK and Illinois candidates until a second factor or equivalent control is in place; the owner has accepted this for now (D-73).

DPIA section 6, add item 9:

> 9. Before the first real candidate, decide whether two-factor sign-in is required again for Reviewer and Super Admin (D-70 revisit; status.md R-23). If it is not, record why the remaining measures are enough, and reconsider whether prior consultation under Art. 36 is needed.

DPIA section 9, replace the first two rows:

> | Overall residual risk | Medium for the pilot **only if** OQ-9 and OQ-10 are decided, the processor agreements are in place, the human-review evidence (R10) is collected, **and R1 is brought back down (two-factor required again, or the compensating measures in R1 are live)**. With R1 at High, the overall residual risk is High for EU/UK candidates |
> | Prior consultation with a supervisory authority (Art. 36) | Not needed if the residual risks are accepted as medium or low. **With R1 at High and unmitigated, consider it before the first EU/UK candidate** (*verify* with counsel). Revisit if R5 or R2 cannot be brought down |

### A3. Does anything else in `docs/compliance` assume mandatory reviewer 2FA?

I searched `docs/compliance` (and the 2026-10-06 review file) for "two-factor", "2FA", "TOTP" on `origin/main`.

| File | Line | Status |
| --- | --- | --- |
| `consent-document.md` | 81 | Fixed by #327 (see A1) |
| `dpia.md` | 71 and 84 | Fixed by #327 (see A2) |
| `decisions.md` | C-21, answer (3): "roles where 2FA is mandatory cannot turn it off" | **Stale in effect.** C-21 is an owner decision about ADR 0011; D-70 makes no role mandatory, so answer (3) has no roles to apply to. **Should-fix F3:** add a note under C-21 (not an edit of the decision): "Answer (3) is moot after D-70 (2026-10-08): no role is mandatory." The hub should also update `docs/fsd.md` FR-102 (still says mandatory for Super Admin and Reviewer) and ADR 0011 (PR #319) |
| `retention-schedule.md`, `processors.md`, `volunteer-consent-form.md`, `legal-brief.md` | none | Nothing assumes 2FA |
| `review-2026-10-06.md` | none | Nothing assumes 2FA |
| OQ-1 to OQ-21 | none mention 2FA | No OQ depends on it |

Outside `docs/compliance`: `docs/fsd.md` FR-102 and the TCs for mandatory 2FA (hub), and the TC/code that enforces `TWO_FACTOR_REQUIRED_FOR_ROLE` (ADR 0011, Backend A). Not in my scope; listed for routing.

### A4. Does the change need a new consent version number or a re-consent note?

- **Now: no re-consent, and the draft number v0.4 is enough.** No consent version has been approved or served to a candidate (the placeholder guard stops the pilot and production from running any draft). The version numbers v0.3 to v0.4 are draft numbers only.
- **Rule for later (F5, record it in the document's drafting notes):** once the owner approves and loads a consent version, any change to a statement about who can see data or how it is secured needs a **new version number** and a new signature from candidates who have not yet signed. For candidates who signed a version that promised 2FA (none today), a change that *weakens* a promise should also trigger a notice to them, because it makes their data less protected than they were told. Today there are none, which is why D-73 is cheap now and would not be after the pilot starts.
- **D-73 hygiene:** the status line of v0.4 correctly records the change and its reason. Keep it in the final approved version's change log.

### A5. status.md D-73 and R-23

- The risk text "Before D-70 this needed a second factor" and the mitigations list are accurate. Add R-23's link to the DPIA's "High" residual (F2) and to the D-76 plan, and remove "Not yet decided: an email ..." once D-76 is recorded (D-76 is approved).
- "DPIA R1 re-rated Medium to high" in R-23 will become "to High (EU/UK, Illinois)" if F2 is accepted.
- The Delivery Lead owns `status.md`; I make no edit.

### A6. Decision for the owner (single)

**Recommendation (not a decision):** keep D-70 for development and the demo, but before the first real candidate, **require a second factor again for the roles that can open recordings, ID images and selfies (Reviewer, Super Admin)**. Reason: the harm if they are phished is severe (face images, home recordings, ID documents; BIPA statutory damages of USD 1,000 to 5,000 per person; GDPR Art. 32 and 33), and the compensating measures do not close the gap. If you decide to keep it optional, the High rating and the accepted-risk entry (R-23) are the right way to record it, and the DPIA's Art. 36 line needs counsel's view. Needs a qualified lawyer's confirmation for the EU/UK reading.

## Part B. PR #322 (dev-only "Local demo consent")

Files: `prisma/seed/demo-consent.ts`, `prisma/seed/apply.ts`, `prisma/seed.ts`, `prisma/seed/ids.ts`.

### B1. What a real candidate could mistake for the real consent

I read the full text (`DEMO_APPROVED_CONSENT_BODY_MD`). It starts with the title "Local demo consent (synthetic data, development only)" and a first paragraph that says it is synthetic, for local development, never shown to real candidates, and not for staging, pilot or production. That is clear and sits at the top. It uses no placeholder-style words, so it passes the web guard by design (the owner's D-71 requires it).

Things a candidate could mistake or that could mislead if it ever were shown:

1. **It is thinner than the real consent in ways that matter legally.** It has no biometric consent or written release, no controller identity, no legal basis, no international transfer statement, no rights section, no age confirmation, no mention of the retention schedule, and an "appeals" and "accommodations" statement that differs from the real text. A candidate who signed it would not have given BIPA or GDPR Art. 9 consent. This is acceptable for development only and is exactly why D3 below matters.
2. **It makes specific promises the real text may not:** "kept for ninety days and then removed" for "recordings and results" (the real rule: recordings 90 days, results 1 year, consent records 3 years), and "ask the talent team to delete" (the real contact is privacy@...). If it ever reached a real candidate, those promises would be false.
3. **"By continuing you agree"** is an acceptance-by-continuing sentence; the real flow requires a typed-name signature (C-07). Harmless in a demo, but it should not look like the signature mechanism.
4. The approval marker is a plain string (`legalApprovedBy: 'local-demo (synthetic data, development only)'`) and a fixed timestamp of 2026-01-01. Nothing downstream distinguishes it from a real approval.

**Minor M1. Recommended edit (the owner's D-71 text, so for the Database track to apply):** end the first paragraph with a sentence that survives being cropped in a screenshot or PDF: "THIS IS NOT A REAL CONSENT. DEVELOPMENT DEMO ONLY." and repeat "(development demo, synthetic data)" in the signed-PDF footer for this version. Add one sentence so nobody mistakes the retention promise: "The periods stated here are for the demo and are not the real retention rules." No change to the guard's regexes is required (none of these words is on its list).

### B2. Can it reach any environment but development?

Checked on the branch:

- `applyApprovedDemoConsent` calls `requireDevelopment(env)` (APP_ENV must be exactly `"development"`), and the whole seed already requires development and a database host that resolves to this machine (`assertResolvedHostIsLocal`, `prisma/seed/guard.ts`). So the seed cannot write the row to staging, pilot or production.
- The API refuses to boot in pilot or production with `REQUIRE_LEGAL_APPROVED_CONSENT=false` (`apps/api/src/config/env.ts` around line 387), but this does **not** stop a consent text whose `legalApprovedAt` is set from being served: `consent.service.ts` only checks `legalApprovedAt !== null`. The web guard (`placeholder-guard.ts`) accepts the demo text by design.
- **Residual path:** the seed is not the only way a row gets into a database: a database restore or dump from a developer machine, a manual insert, a copied fixture or a future seed change would put an "approved" demo text in front of real candidates, and nothing would catch it. Staging also gets real-looking traffic from the owner and testers.

**Should-fix F6 (Backend and Frontend tracks, not `docs/compliance`):**

1. API: in `consent.service.ts`, when the environment is shared (`isSharedEnv` in `env.ts`), refuse to serve or accept a consent text whose version ends in `-local-demo` or whose `legalApprovedBy` starts with `local-demo`, returning the existing `CONSENT_NOT_APPROVED`. One small, tested check.
2. Web: add `development only` and `synthetic data` to the placeholder guard's `NOT_APPROVED_PHRASES` list **unless** the build is development. (Or accept the API check alone; the API check is the one that matters.)
3. Test: a spec that seeds the demo row with `APP_ENV=staging` semantics through the service and expects the refusal.

This is a consent-integrity weakness (candidate data and consent), so by the project's own rule it is a merge blocker for the PR that introduces the text if the Lead agrees with F6; the owner's D-71 decision allows the text, not the lack of a backstop.

### B3. D-71 versus the real approval

`docs/status.md` B-05 item 1 and the placeholder guard are unchanged by #322, which is right. One check for the owner: the real consent's version number must never be `0.2-local-demo` or sort below it; use a version like `1.0` when you approve the real text.

## Findings by severity

**Blockers (owner or Lead decision needed before real candidates):**

- **K1.** R1 is understated and DPIA section 9 contradicts it (A2). Pilot cannot start for EU/UK candidates until the DPIA is internally consistent and the owner has accepted the right rating.
- **K2.** No backstop against the demo consent reaching a shared environment (B2 / F6). Block merge of #322 unless the Lead and the owner accept the residual path.

**Should fix:** F1 (consent wording), F2 (R1 row, section 6 item 9, section 9), F3 (note under C-21; FSD FR-102 and ADR 0011 routing), F5 (record the version rule), F6 (demo-consent guards), M1 (demo text banner).

**Minor:** verify the ID-image audit claim (A1); keep the version scheme clear (B3).

## Decisions needed from the owner (batched)

1. A6: require 2FA again before the first real candidate for Reviewer and Super Admin (recommended), or keep it optional with the High rating and counsel's view on Art. 36.
2. Approve the F1 wording for consent section 6 and the F2 wording for the DPIA.
3. Confirm the F6 backstop for the demo consent.

## Questions for a qualified lawyer

1. Is password-only staff access to biometric data and face recordings compatible with GDPR Art. 32 and BIPA's reasonable standard of care for a hiring platform?
2. With R1 at High, is prior consultation under Art. 36 required before the first EU/UK candidate?
3. If a version that promised a security control was signed before the control was removed, is a notice or re-consent required?

*All wording above is a draft for owner approval and has not been reviewed by a licensed lawyer.*

## Re-review of #327 at `049bcec4` (2026-10-08, after D-77 to D-79)

The owner decided (D-78) that 2FA stays optional inside CodeProctor, because it will sit behind a host application that already uses a second factor (Azure Authenticator), and (D-79) to merge #322 now and build the F6 API refusal as a pre-pilot blocker. #327 applies F1, F2, F3 and F5 and records D-78. I checked the diff against this review.

- **Accurate and consistent.** Consent section 6 no longer promises a security control, and the duplicated logging sentence is gone. R1 is High for EU/UK and Illinois "until the host application's sign-in with a second factor, or an equivalent control, is in place"; section 9 and the Art. 36 line match it; DPIA section 6 item 9 gates the first real candidate; D-76 is shown as planned, not in place. The C-21 note and drafting note 10 are as proposed. No new consent version or re-consent is needed.
- **Honest about what exists.** The text says the host sign-in is "not built today". Keep that wording until it is.
- **Should-fix S-D78 (small, can follow #327).** The host-application control only works if it cannot be bypassed. If CodeProctor keeps its own password login reachable in the pilot, an attacker with a stolen password skips the host's second factor. Add to DPIA section 6 item 9: "...and CodeProctor's own password sign-in is disabled or unreachable for staff in that environment." Also record the host-application integration as a scope item for the hub (it is not in the BRD or ADRs), since R1's rating now depends on it.
- **Still needs counsel.** Whether the compensating measures alone are enough, and whether Art. 36 consultation applies while R1 is High.

Verdict: **compliance-reviewed, no blockers.** The F6 refusal (K2) stays a pre-pilot blocker owned by Backend B (D-79); the demo text banner (M1) goes to Database A.
