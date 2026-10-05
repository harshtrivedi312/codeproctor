# API contract (ARC-02)

Authoritative REST contract (ADR 0001 C-8). BE-01 exists, so a route moves to the code-first OpenAPI once the backend publishes it there and ARC-02 part 2 confirms it matches; until then this file wins. Paths follow the backend's routes under `/api/v1`; ARC-02 part 2 settles the remaining paths, adds the other endpoint groups and the fsd.md §4 rows.

Errors are RFC 7807 problem details (ADR 0001 C-9: `type`, `title`, `status`, `detail`, `instance`, `traceId`, `errors`). This contract adds one extension member, **`code`** (a stable machine-readable string such as `REAUTH_FAILED`). `ProblemDetails` in `apps/api/src/common/problem.filter.ts` gains an optional `code`. Clients branch on `code`, never on `detail` text.

## 1. Re-authentication for 2FA management

Owner decision (2026-10-05): `currentPassword` is required on 2FA setup, disable and recovery-code regeneration; a wrong password returns 403 `REAUTH_FAILED`; forced enrolment is unchanged. Everything marked **(architect detail, owner to confirm)** below was added by the architecture hub to make that decision implementable and is listed in `docs/followups/architecture.md` as an owner question. ADR 0011 records the decision.

### Endpoints

| Method and path                                         | Who                                                  | Body                                     | Success                                                            |
| ------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------ |
| `POST /auth/2fa/setup/start`                            | Any staff, signed in                                 | `{ currentPassword }`                    | 200, otpauth URI and manual key                                    |
| `POST /auth/2fa/setup/confirm`                          | Any staff, signed in                                 | `{ currentPassword, code }`              | 200, the 10 recovery codes, shown once                             |
| `POST /auth/2fa/disable`                                | Staff whose role makes 2FA optional (FR-102)         | `{ currentPassword }`                    | 204                                                                |
| `POST /auth/2fa/recovery-codes/regenerate`              | Staff with 2FA on (409 if off) **(architect detail)** | `{ currentPassword }`                    | 200, 10 new codes; the old ones stop working                       |
| `POST /auth/2fa/reset/:userId` **(architect detail)**   | SUPER_ADMIN, same organisation                       | `{ currentPassword }` (the admin's own)  | 204; an unknown or other-organisation `userId` is 404 (ADR 0006)   |

Exact paths follow what backend PR #26 ships; ARC-02 part 2 pins them here and in fsd.md §4.

### Rules

- `currentPassword`: a string of 1 to `MAX_PASSWORD_LENGTH` characters, the same bound as login; never trimmed or normalised **(architect detail)**.
- **Wrong password: HTTP 403, problem `code: "REAUTH_FAILED"`**, `detail` "Password is incorrect". It is not 401: the session is valid, and a 401 means "access token expired" to the client (it would refresh and retry).
- **Locked account (architect detail).** While `locked_until` is in the future, the check burns an Argon2 verify and returns the identical 403 `REAUTH_FAILED` even for the correct password, so a locked account gives no signal and the route cannot be used to keep guessing. Wrong attempts count towards the same lockout as login (FR-101, TC-002); the failure that triggers the lock writes the same account-locked audit row as login. Whether a successful re-auth resets the failed-login counter as a login does is for BE-02 to decide and document.
- Check order: authentication and role, then body validation (400), then the password, then the remaining checks (`code`, `userId`). A wrong TOTP `code` after a correct password is the ordinary 2FA validation error, not `REAUTH_FAILED`. A role that may not call the route gets 403 `FORBIDDEN`, a different `code`.
- Every re-auth success and failure is audited: who, which action, outcome, never the password **(architect detail)**.
- `currentPassword` (and `password`, `newPassword`) must be on the API's log redact list as defence in depth, and validation errors must never echo submitted values.
- **Forced enrolment is unchanged.** Roles whose TOTP is mandatory (FR-102) enrol during login through the challenge-token flow (`/auth/2fa/enroll/start` and `/confirm` with `challengeToken`), which already follows a password check. It takes no `currentPassword` and issues no access token until enrolment is confirmed (TC-003).

### Open for the owner

1. Does the SUPER_ADMIN reset require the admin's own password (as written)?
2. Do re-auth failures share login's lockout, so five wrong re-auths lock login for 15 minutes (as written)?
3. May a mandatory-2FA role call `disable`? Recommended no (403 `FORBIDDEN`): it would drop the account back to forced enrolment at next login.
4. May an admin reset their own 2FA, or another SUPER_ADMIN's?
5. Do disable and reset revoke the target's refresh-token families? Recommended yes, so a stolen session does not survive the change.
6. Should disable also require a current TOTP code?

### Frontend (Security page)

- Setup: one password prompt that keeps the password in component state from `start` through `confirm`; clear it on confirm, error or close. Disable and regenerate: a prompt per action.
- On 403 with `code: "REAUTH_FAILED"` show "Password is incorrect" inline and keep the dialog open; do not sign out and do not refresh. Any other 403 is a permission problem, not a password problem.
- The bearer-authenticated routes (`/auth/2fa/setup/*`, `disable`, `recovery-codes/regenerate`, `reset`) must not count as auth requests in `isAuthRequest`, so that a real 401 (expired access token while the dialog is open) refreshes and retries once. Today every `/v1/auth/*` path is excluded from refresh.

### Tests (cite FR and TC IDs; QA assigns new TC IDs for re-auth)

FR-102, FR-101, TC-002, TC-003: wrong password is 403 `REAUTH_FAILED` on each endpoint; correct password succeeds; repeated wrong passwords lock; a locked account with the correct password still gets 403 `REAUTH_FAILED`; forced enrolment at login needs no `currentPassword`; role denial is `FORBIDDEN` not `REAUTH_FAILED`; the password never appears in logs or audit records.
