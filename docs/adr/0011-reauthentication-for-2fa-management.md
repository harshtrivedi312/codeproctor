# ADR 0011: Re-authentication for 2FA management

| Field | Value |
| --- | --- |
| Status | Accepted 2026-10-05 by the owner (instruction in chat) |
| Author | architecture hub |
| Serves | FR-101, FR-102, FR-104; NFR-04; TC-002, TC-003 |
| Builds on | ADR 0003 (credential storage), ADR 0001 TB-1 |
| Affects | backend-engineer (BE-02, PR #26), frontend-engineer (Security page, FE-03), qa-engineer |

## Context

Changing a second factor with only an access token lets a stolen token take over an account. The backend already has self-service setup, disable, recovery-code regeneration and an admin reset.

## Decision

Setup, disable and recovery-code regeneration (and the SUPER_ADMIN reset, with the admin's own password) require `currentPassword` in the body. A wrong password returns `403 REAUTH_FAILED`, not 401. Forced enrolment during login is unchanged. Full rules, the endpoint table and the frontend behaviour are in `docs/api-contract.md` section 1.

## Options considered

1. **Password in the body, 403 REAUTH_FAILED (chosen).** Simple, no new token type, does not trip the client's 401 refresh logic.
2. **A short-lived "recent login" claim on the access token.** No password prompt each time, but needs token and refresh changes (ADR 0003 territory) for a rarely used screen.
3. **Return 401 on a wrong password.** Rejected: the client would refresh or sign the user out although the session is valid.

## Consequences

- PR #26 currently returns 401 for a wrong password on these routes; BE changes it to 403 `REAUTH_FAILED` before or after merge (security-sensitive, so before).
- A `reauth` body schema in packages/shared is wanted; adding it is part of ARC-02 part 2 and needs no new ADR.
- Wrong re-auth attempts share login's lockout and are audited.
