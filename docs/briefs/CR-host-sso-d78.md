# Change request: staff sign-in through the host application (D-78)

Status: **Draft for the owner** (hub, 2026-10-09). Not in the BRD, FSD or any ADR. Nothing here is decided; the effort figures are the architect's rough estimates, not commitments.

## 1. Why

- D-70: two-factor sign-in is optional for every staff role, so a password alone opens a Reviewer or Super Admin account. That account sees recordings, ID images and verdicts.
- D-78: the owner accepts that, because CodeProctor will sit inside a host application that already signs staff in with a second factor (Azure Authenticator). The second factor is expected to come from the host's sign-in. That integration does not exist.
- DPIA R1 stays High for EU/UK and Illinois candidates until it does (or until the compensating measures in R1 are live). DPIA section 6 item 9 is an either/or before the first real candidate: either staff reach CodeProctor through the host application's sign-in with a second factor and CodeProctor's own password sign-in is disabled or unreachable for staff in that environment, or the compensating measures in R1 are live and counsel has said whether prior consultation under Art. 36 is needed. status.md R-23 records the accepted risk.

## 2. What is asked

In the pilot environment, staff (Recruiter, Author, Reviewer, Super Admin) sign in only through the host application's identity provider, with its second factor. CodeProctor's password and TOTP sign-in stay in the product for local, demo and other environments, and are refused for staff where the host sign-in is on. Candidates are unaffected (they use the invitation link and the one-time code).

## 3. Scope

In scope:
- A configured sign-in mode per environment (for example `AUTH_MODE=password|oidc`, required, no default, like `APP_ENV`). In `oidc` mode the staff password, password-reset, TOTP and forced-enrolment routes answer a fixed refusal, and the boot check refuses a pilot or production start without a complete OIDC configuration.
- The OpenID Connect sign-in routes, the callback, the mapping from the identity provider's user to a CodeProctor staff user and role, and the logout.
- CodeProctor keeps issuing its own short access token and rotating refresh cookie after the host sign-in (FR-104, ADR 0003 unchanged), so every existing guard, org scope and audit rule keeps working.
- A shared-contract, schema and ADR change: a new ADR (next free number) for this decision, `users` gets the identity provider's stable subject, new problem codes, new env settings, `packages/shared` additions. All are owner items under CLAUDE.md rule 7.

Out of scope: candidate authentication; SCIM or automatic deprovisioning (see questions); changing D-70 (TOTP stays optional inside CodeProctor, though question 2 asks whether the host's second factor may be required).

## 4. Approach options

| Option | What | Verdict |
| --- | --- | --- |
| A. OpenID Connect relying party (authorization code with PKCE) against the host's identity provider (Microsoft Entra ID if that is what the host uses) | Standard, supported by Entra, no shared secret with the browser, the provider's `amr`/`acr` claim shows whether a second factor was used | **Recommended** |
| B. SAML 2.0 | Also standard in Entra; heavier library and XML-signature attack surface | Only if the host cannot do OIDC |
| C. Trust a header or token set by a reverse proxy in front of CodeProctor | Least code, but anyone who can reach the app directly can forge the header, and it ties the product to one deployment | Rejected |

## 5. Design sketch (option A)

- Flow: authorization code only (no implicit or hybrid); the ID token is taken only from the back-channel token response. CodeProctor is a confidential client (a client secret or `private_key_jwt`, never logged). PKCE with `S256` only. One fixed provider configuration per environment, never discovered from user input; check the RFC 9207 `iss` response parameter when the provider sends it (mix-up defence).
- Routes: `GET /auth/oidc/start`, `GET /auth/oidc/callback`, `POST /auth/oidc/logout`. `state` is bound to the browser by an HttpOnly `__Host-` cookie even when the rest is stored server side, single use, lifetime 10 minutes or less, cleared after the callback; the PKCE verifier and `nonce` are encrypted, not only signed. Use `response_mode=query`: the callback is then a cross-site top-level GET, which a `SameSite=Lax` state cookie survives. Entra's `form_post` is a cross-site POST and a Lax cookie is not sent on it, so it is not used. The refresh cookie stays `SameSite=Strict`, so it is not sent on the redirect chain after the callback: the callback sets it and lands on a page that calls refresh by a same-site fetch. A post-login `returnTo` is a relative-path allowlist. On the callback any existing session is discarded and a fresh refresh family is issued (no session fixation). `/start` and `/callback` are rate limited (NFR-04). The code, state, nonce, verifier and provider tokens are never logged.
- ID token validation: signature against the provider's keys (cached, rotation handled, `alg` allowlist RS256, `none` and HS refused), `iss` exactly the configured issuer, `aud` equal to the client ID (and `azp` when there are several audiences), `exp`, `nbf` and `iat` with a small clock skew, `nonce`, and `auth_time` against `max_age` where used. The ID token is never stored; only the stable identity is kept.
- Tenant and identity key (the account-takeover risk): the app registration is single-tenant, `iss` and `tid` are validated against the one configured tenant, and a user is keyed on (issuer, `tid`, `oid`), not on `sub` (which is pairwise per application) and not on email. Email, `upn` and `preferred_username` can be edited by tenant administrators (and, in a multi-tenant setup, by any tenant), so they are never used to authorize or to link accounts (the "nOAuth" class of attack). Linking is through the invitation: an organisation admin pre-creates the user as today; the invited person follows a single-use invitation token and completes the OIDC sign-in, which binds their `oid` to that user; or an admin pre-registers the `oid`. If email is ever used at all, only with a provider-verified claim (Entra `xms_edov`) and still with the tenant pinned. This is stated as an owner item (question 3).
- Second factor: the primary control is a Conditional Access policy at the identity provider that requires MFA for this app registration. CodeProctor additionally checks the provider's claim as defence in depth (`amr` containing `mfa`, or an authentication-context `acrs` value), knowing that Entra v2.0 tokens may not carry `amr` reliably and that `amr: mfa` can reflect an earlier MFA session; a token that fails the check is refused.
- Roles stay managed in CodeProctor, not read from the provider, so a provider change cannot silently grant Super Admin. An unknown or deactivated user is refused with the same generic response (no account-existence oracle).
- Step-up: ADR 0011's re-authentication and R1's planned "password re-check before issuing playback of ID images" depend on the password, which does not exist in `oidc` mode. In that mode step-up is a fresh OIDC round trip (`prompt=login` or `max_age=0`, then `auth_time` is checked).
- Logout and deprovisioning: CodeProctor logout revokes the local refresh family. Without front- or back-channel logout or SCIM, a user disabled at the provider keeps a CodeProctor session until the refresh token's lifetime ends. State that absolute lifetime in the ADR, or re-check with the provider on refresh. Session revocation on deactivation or role change stays as today.
- Outage: if the provider is down, all staff are locked out. This is question 4 (break-glass).
- Redirect URIs are an exact allowlist per environment.

## 6. Effort (architect's rough estimate)

Backend about 5 to 8 days (routes, validation, mapping, mode guard, tests including a fake provider); Frontend 2 to 3 days (sign-in page, error states, logout); QA 3 days (flows, refusal of password routes in `oidc` mode, negative tests for `state`, `nonce`, `iss`, `aud`, expiry and missing second factor); Architecture 1 to 2 days (ADR 0019, contract text); DPIA and consent wording update by the Delivery Lead. Roughly two to three calendar weeks with the host details in hand; the estimate cannot be firmer until question 1 is answered.

## 7. Questions for the owner

1. What is the host application, and what is its identity provider (Entra ID tenant, B2C, something else)? Does the host start CodeProctor by a link, an embedded frame, or a reverse proxy? An embedded frame is a problem for the strict cookies and needs a separate design.
2. May CodeProctor refuse a sign-in that lacks the second factor? The host's Conditional Access policy requiring MFA for this app is the recommended control, with a claim check in CodeProctor as defence in depth. Note that this makes a second factor mandatory for staff in that environment, while D-78 says two-factor stays optional inside CodeProctor: it is a policy decision, not an implementation detail.
3. Provisioning: invite-then-bind (recommended, the invitation token binds the provider identity) or create-on-first-sign-in from the provider's groups (more convenient, more risk)? Is the single-tenant pin acceptable? Is automatic deprovisioning needed (SCIM), or is deactivation in CodeProctor plus a bounded refresh lifetime enough for the pilot?
4. Break-glass: no local sign-in at all in the pilot (the owner recovers through the console), or one local Super Admin with a password plus mandatory TOTP? A provider outage locks out all staff otherwise.
5. Timing: DPIA section 6 item 9 allows either the host sign-in or the R1 compensating measures plus counsel's view on Art. 36 before the first real candidate. Is the host-application date known, and do you confirm that the pilot may start on the compensating measures if this slips?

## 8. Links

D-70, D-78; DPIA R1 and section 6 item 9; status.md R-23; FR-101, FR-102, FR-104; ADR 0003 (sessions), ADR 0011 (re-authentication); CLAUDE.md rules 3 and 7.
