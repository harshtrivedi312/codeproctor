# ADR 0011: Re-authentication for 2FA management

| Field | Value |
| --- | --- |
| Status | Accepted 2026-10-05 for the owner's decision (currentPassword on setup, disable and recovery-code regeneration; 403 REAUTH_FAILED; forced enrolment unchanged). Detail rules added by the architecture hub are marked in `docs/api-contract.md` and await owner confirmation. |
| Author | architecture hub |
| Serves | FR-101, FR-102, FR-104; NFR-04; TC-002, TC-003 |
| Builds on | ADR 0003 (credential storage), ADR 0001 TB-1 |
| Affects | backend-engineer (BE-02, PR #26), frontend-engineer (Security page, FE-03), qa-engineer |

## Context

Changing a second factor with only an access token lets a stolen token take over an account. The backend already has self-service setup, disable, recovery-code regeneration and an admin reset.

## Decision

Setup, disable and recovery-code regeneration require `currentPassword` in the body (owner decision). A wrong password returns `403` with problem `code: "REAUTH_FAILED"`, not 401 (owner decision). Architect details, to be confirmed by the owner: the SUPER_ADMIN reset takes the admin's own password; failures share login's lockout and a locked account returns the same 403; all attempts are audited. Forced enrolment during login is unchanged. Full rules, the endpoint table and the frontend behaviour are in `docs/api-contract.md` section 1.

## Options considered

1. **Password in the body, 403 REAUTH_FAILED (chosen).** Simple, no new token type, does not trip the client's 401 refresh logic.
2. **A short-lived "recent login" claim on the access token.** No password prompt each time, but needs token and refresh changes (ADR 0003 territory) for a rarely used screen.
3. **Return 401 on a wrong password.** Rejected: 401 means an expired access token, so a refresh-and-retry or sign-out would be triggered although the session is valid.

## Consequences

- API shape change (C-8): `ProblemDetails` gains an optional `code` member (RFC 7807 extension). Affects backend (problem filter), frontend (API client) and QA.
- PR #26 currently returns 401 for a wrong password on these routes; BE changes it to 403 `REAUTH_FAILED` before PR #26 merges.
- Frontend: stop excluding the bearer-authenticated 2FA management routes from refresh-and-retry in `isAuthRequest`.
- A `reauth` body schema in packages/shared is wanted (ARC-02 part 2).
- QA assigns new TC IDs for re-auth; TC-002 and TC-003 are not reused for it.
- fsd.md §4 rows for these routes are added in ARC-02 part 2.
