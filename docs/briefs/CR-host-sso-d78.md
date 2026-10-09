# Change request: staff sign-in through the host application (D-78)

Status: **Draft for the owner** (hub, 2026-10-09). Not in the BRD, FSD or any ADR. Nothing here is decided; the effort figures are the architect's rough estimates, not commitments.

## 1. Why

- D-70: two-factor sign-in is optional for every staff role, so a password alone opens a Reviewer or Super Admin account. That account sees recordings, ID images and verdicts.
- D-78: the owner accepts that, because CodeProctor will sit inside a host application that already signs staff in with a second factor (Azure Authenticator). The second factor is expected to come from the host's sign-in. That integration does not exist.
- DPIA R1 stays High for EU/UK and Illinois candidates until it does (or until the compensating measures in R1 are live). DPIA section 6 item 9 and status.md R-23 make it a gate before the first real candidate: staff reach CodeProctor through the host application's sign-in with a second factor, and CodeProctor's own password sign-in is disabled or unreachable for staff in that environment.

## 2. What is asked

In the pilot environment, staff (Recruiter, Author, Reviewer, Super Admin) sign in only through the host application's identity provider, with its second factor. CodeProctor's password and TOTP sign-in stay in the product for local, demo and other environments, and are refused for staff where the host sign-in is on. Candidates are unaffected (they use the invitation link and the one-time code).

## 3. Scope

In scope:
- A configured sign-in mode per environment (for example `AUTH_MODE=password|oidc`, required, no default, like `APP_ENV`). In `oidc` mode the staff password, password-reset, TOTP and forced-enrolment routes answer a fixed refusal, and the boot check refuses a pilot or production start without a complete OIDC configuration.
- The OpenID Connect sign-in routes, the callback, the mapping from the identity provider's user to a CodeProctor staff user and role, and the logout.
- CodeProctor keeps issuing its own short access token and rotating refresh cookie after the host sign-in (FR-104, ADR 0003 unchanged), so every existing guard, org scope and audit rule keeps working.
- A shared-contract, schema and ADR change: ADR 0019 (this decision), `users` gets the identity provider's stable subject, new problem codes, new env settings, `packages/shared` additions. All are owner items under CLAUDE.md rule 7.

Out of scope: candidate authentication; SCIM or automatic deprovisioning (see questions); changing D-70 (TOTP stays optional inside CodeProctor).

## 4. Approach options

| Option | What | Verdict |
| --- | --- | --- |
| A. OpenID Connect relying party (authorization code with PKCE) against the host's identity provider (Microsoft Entra ID if that is what the host uses) | Standard, supported by Entra, no shared secret with the browser, the provider's `amr`/`acr` claim shows whether a second factor was used | **Recommended** |
| B. SAML 2.0 | Also standard in Entra; heavier library and XML-signature attack surface | Only if the host cannot do OIDC |
| C. Trust a header or token set by a reverse proxy in front of CodeProctor | Least code, but anyone who can reach the app directly can forge the header, and it ties the product to one deployment | Rejected |

## 5. Design sketch (option A)

- Routes: `GET /auth/oidc/start` (creates `state`, `nonce` and a PKCE verifier, stored server side or in a short-lived signed cookie with `SameSite=Lax`, because the callback is a cross-site top-level navigation and the refresh cookie is `SameSite=Strict`), `GET /auth/oidc/callback`, `POST /auth/oidc/logout`.
- Validation on the callback: `state`, `nonce`, PKCE, `iss`, `aud`, signature against the provider's keys (cached, rotated), `exp` with a small clock skew, and the second-factor claim: the sign-in is refused unless the provider says a second factor was used (the exact claim and value depend on the provider; Entra puts `mfa` in `amr`). The ID token is never stored or logged; only the stable subject (`sub` or `oid`) is kept.
- Mapping: a staff user is matched by the provider's subject, linked on first sign-in by verified email to a pre-created CodeProctor user (the organisation admin invites as today). Roles stay managed in CodeProctor, not read from the provider, so a provider change cannot silently grant Super Admin. Unknown or deactivated users are refused with the same generic response (no account-existence oracle).
- Break-glass: a deliberate decision for the owner (question 4). The safest option is none in the product: the owner uses the console and an admin reset path outside the app.
- Redirect URIs are an exact allowlist per environment. Sessions keep their existing revocation (password change no longer applies in `oidc` mode; deactivation and role change revoke as today).

## 6. Effort (architect's rough estimate)

Backend about 5 to 8 days (routes, validation, mapping, mode guard, tests including a fake provider); Frontend 2 to 3 days (sign-in page, error states, logout); QA 3 days (flows, refusal of password routes in `oidc` mode, negative tests for `state`, `nonce`, `iss`, `aud`, expiry and missing second factor); Architecture 1 to 2 days (ADR 0019, contract text); DPIA and consent wording update by the Delivery Lead. Roughly two to three calendar weeks with the host details in hand; the estimate cannot be firmer until question 1 is answered.

## 7. Questions for the owner

1. What is the host application, and what is its identity provider (Entra ID tenant, B2C, something else)? Does the host start CodeProctor by a link, an embedded frame, or a reverse proxy? An embedded frame is a problem for the strict cookies and needs a separate design.
2. Does the host's provider expose the second-factor claim (`amr`), and may CodeProctor require it?
3. Provisioning: invite-then-link (recommended) or create-on-first-sign-in from the provider's groups (more convenient, more risk)? Is automatic deprovisioning needed (SCIM), or is deactivation in CodeProctor enough for the pilot?
4. Break-glass: no local sign-in at all in the pilot (owner recovers through the console), or one local Super Admin with a password plus mandatory TOTP?
5. Timing: this must land before the first real candidate (R-23). Is the host-application date known, and is the pilot allowed to start with the compensating measures of R1 instead if it slips?

## 8. Links

D-70, D-78; DPIA R1 and section 6 item 9; status.md R-23; FR-101, FR-102, FR-104; ADR 0003 (sessions), ADR 0011 (re-authentication); CLAUDE.md rules 3 and 7.
