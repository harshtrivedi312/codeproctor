# API contract (ARC-02)

Authoritative REST contract (ADR 0001 C-8). BE-01 exists, so a route moves to the code-first OpenAPI once the backend publishes it there and ARC-02 part 2 confirms it matches; until then this file wins. Paths follow the backend's routes under `/api/v1`; ARC-02 part 2 settles the remaining paths, adds the other endpoint groups and the fsd.md §4 rows.

Errors are RFC 7807 problem details (ADR 0001 C-9, as implemented in `problem.filter.ts`: `type`, `title`, `status`, `detail`, `instance`, `traceId`, `errors`). This contract adds one extension member, **`code`** (a stable machine-readable string such as `REAUTH_FAILED`). `ProblemDetails` in `apps/api/src/common/problem.filter.ts` gains an optional `code`. `code` is set only where this contract names one: `REAUTH_FAILED` and `TWO_FACTOR_REQUIRED_FOR_ROLE` (the `PROBLEM_CODES` in backend PR #26). Guard 403s (role or permission denial) carry no `code`. Clients branch on `code`, never on `detail` text.

## 1. Re-authentication for 2FA management

Owner decision (2026-10-05): `currentPassword` is required on 2FA setup, disable and recovery-code regeneration; a wrong password returns 403 `REAUTH_FAILED`; forced enrolment is unchanged. Everything marked **(architect detail, owner to confirm)** below was added by the architecture hub to make that decision implementable and is listed in `docs/followups/architecture.md` as an owner question. ADR 0011 records the decision.

### Endpoints

| Method and path                                         | Who                                                  | Body                                     | Success                                                            |
| ------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------ |
| `POST /auth/2fa/setup/start`                            | Any staff, signed in                                 | `{ currentPassword }`                    | 200, otpauth URI and manual key                                    |
| `POST /auth/2fa/setup/confirm`                          | Any staff, signed in                                 | `{ currentPassword, code }`              | 200, the 10 recovery codes, shown once                             |
| `POST /auth/2fa/disable`                                | Any signed-in staff; refused for roles whose 2FA is mandatory (SUPER_ADMIN, REVIEWER): 403 `TWO_FACTOR_REQUIRED_FOR_ROLE`, checked after the password (C-21) | `{ currentPassword, code }` (a current TOTP code is required, C-21; backend follow-up) | 204 |
| `POST /auth/2fa/recovery-codes/regenerate`              | Staff with 2FA on (409 if off) **(architect detail)** | `{ currentPassword }`                    | 200, 10 new codes; the old ones stop working                       |
| `POST /auth/2fa/reset/:userId` (C-21)                    | SUPER_ADMIN, same organisation; not for the caller's own account (400, checked before the password) | `{ currentPassword }` (the admin's own)  | 204; an unknown or other-organisation `userId` is 404 (ADR 0006); revokes the target's refresh sessions |

Exact paths follow what backend PR #26 ships; ARC-02 part 2 pins them here and in fsd.md §4.

### Rules

- `currentPassword`: a string of 1 to `MAX_PASSWORD_LENGTH` characters, the same bound as login; never trimmed or normalised **(architect detail)**.
- **Wrong password: HTTP 403, problem `code: "REAUTH_FAILED"`**, `detail` "The current password is incorrect.". It is not 401: the session is valid, and a 401 means "access token expired" to the client (it would refresh and retry).
- **Locked account (architect detail).** While `locked_until` is in the future, the check burns an Argon2 verify and returns the identical 403 `REAUTH_FAILED` even for the correct password, so a locked account gives no signal and the route cannot be used to keep guessing. Wrong attempts count towards the same lockout as login (FR-101, TC-002); the failure that triggers the lock writes the same account-locked audit row as login. Whether a successful re-auth resets the failed-login counter as a login does is for BE-02 to decide and document.
- Check order (as implemented in #26): authentication and role guard (a role or permission denial is a plain 403 with no `code`), then body validation and path validation (400, including a UUID check and, for reset, a self-target which is 400), then the password (403 `REAUTH_FAILED` when wrong or locked), then the remaining checks: for `disable`, a role whose 2FA is mandatory gets 403 `TWO_FACTOR_REQUIRED_FOR_ROLE` (after the password, so it is not revealed without it); the 409 when regenerate or disable is called with 2FA off is also after the password and is not a guard; an unknown or other-organisation reset target is 404. A wrong TOTP `code` after a correct password is the ordinary 2FA validation error, not `REAUTH_FAILED`.
- Every re-auth success and failure is audited: who, which action, outcome, never the password **(architect detail)**.
- `currentPassword`, `password` and `newPassword` must be on the API's pino redact list as defence in depth (`req.body.currentPassword`, `req.body.password`, `req.body.newPassword`, and the same under any logged error context), and validation errors must never echo submitted values.
- **Forced enrolment is unchanged.** Roles whose TOTP is mandatory (FR-102) enrol during login through the challenge-token flow (`/auth/2fa/enroll/start` and `/confirm` with `challengeToken`), which already follows a password check. It takes no `currentPassword` and issues no access token until enrolment is confirmed (TC-003).

### Owner answers (C-21, 2026-10-05, D-49)

1. A SUPER_ADMIN reset needs the admin's own password. Matches #26.
2. Re-auth failures share the login lockout (five wrong attempts lock login for 15 minutes). Trade-off noted: someone holding a stolen access token can lock the real user out repeatedly; an anonymous attacker who knows the email can already do that, so there is no new exposure. Matches #26.
3. Mandatory-2FA roles (SUPER_ADMIN, REVIEWER) cannot disable 2FA: 403 `TWO_FACTOR_REQUIRED_FOR_ROLE`, checked after the password. Matches #26.
4. An admin can reset another admin's 2FA but not their own: a self-reset is 400, checked before the password. Matches #26.
5. Disabling or resetting 2FA revokes that user's sessions. Reset already revokes the target's refresh-token families in #26; **disable does not yet: backend follow-up pending.** Access tokens already issued expire within 15 minutes, so this is not an immediate compromise response.
6. Disabling 2FA also needs a current TOTP code. **Backend follow-up pending** (#26 requires only the password today).

### Frontend (Security page)

- Setup: one password prompt that keeps the password in component state from `start` through `confirm`; clear it on confirm, error or close. Disable and regenerate: a prompt per action.
- On 403 with `code: "REAUTH_FAILED"` show "Password is incorrect" inline and keep the dialog open; do not sign out and do not refresh. `TWO_FACTOR_REQUIRED_FOR_ROLE` means this role must keep 2FA (hide or disable the control for SUPER_ADMIN and REVIEWER); any other 403 is a permission problem, not a password problem.
- The bearer-authenticated routes (`/auth/2fa/setup/*`, `disable`, `recovery-codes/regenerate`, `reset`) must not count as auth requests in `isAuthRequest`, so that a real 401 (expired access token while the dialog is open) refreshes and retries once. The challenge-token routes (`/auth/2fa/enroll/*`, `/auth/2fa/verify`), login, refresh and logout stay excluded. The retry copy of the request (it carries `currentPassword`) must be dropped when the retry settles; the password stays in memory only, never in storage. Today every `/v1/auth/*` path is excluded from refresh.

### Tests (QA assigns new TC IDs for re-auth; TC-002 and TC-003 are cited only for the lockout and forced-enrolment regressions)

FR-102, FR-101, TC-002, TC-003: wrong password is 403 `REAUTH_FAILED` on each endpoint; correct password succeeds; repeated wrong passwords lock; a locked account with the correct password still gets 403 `REAUTH_FAILED`; forced enrolment at login needs no `currentPassword`; a role denial carries no `code`; disable by SUPER_ADMIN or REVIEWER is 403 `TWO_FACTOR_REQUIRED_FOR_ROLE` after the password; a self-reset is 400 before the password; reset revokes the target's refresh sessions; disable without a current TOTP code is refused once the backend follow-up lands; the password never appears in logs or audit records.
