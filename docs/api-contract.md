# API contract (ARC-02)

Authoritative REST contract until BE-01's code-first OpenAPI covers a route (ADR 0001 C-8). Paths below follow the backend's current routes under `/api/v1`; ARC-02 part 2 settles the remaining paths and adds the other endpoint groups. Status per section is stated in its heading.

## 1. Re-authentication for 2FA management (Accepted 2026-10-05, owner instruction; ADR 0011)

A signed-in staff user who changes their own two-factor setup must prove they still know their password, so a stolen access token alone cannot enrol, remove or reset a second factor.

### Endpoints that require `currentPassword`

| Method and path | Who | Body | Success |
| --- | --- | --- | --- |
| `POST /auth/2fa/setup/start` (BE name today: enrol start for an already signed-in user) | Any staff | `{ currentPassword }` | 200 with the otpauth URI and manual key |
| `POST /auth/2fa/setup/confirm` | Any staff | `{ currentPassword, code }` | 200 with the 10 recovery codes, shown once |
| `POST /auth/2fa/disable` | Any staff where 2FA is optional (FR-102) | `{ currentPassword }` | 204 |
| `POST /auth/2fa/recovery-codes/regenerate` | Any staff with 2FA on | `{ currentPassword }` | 200 with 10 new codes; old codes stop working |
| `POST /auth/2fa/reset/:userId` | SUPER_ADMIN, same organisation only | `{ currentPassword }` (the admin's own password) | 204 |

The exact paths for start and confirm follow whatever backend PR #26 ships; ARC-02 part 2 fixes them in this table and in fsd.md §4.

### Rules

- `currentPassword` is a string, 1 to `MAX_PASSWORD_LENGTH` characters (the same bound as login), never trimmed or normalised, never logged, never echoed.
- **Wrong password: `403` with code `REAUTH_FAILED`.** Not 401: the web client treats 401 as an expired access token and tries to refresh or sign the user out, and the session itself is still valid here. The body uses the shared error envelope (code, message); the message does not say anything beyond "Password is incorrect".
- Wrong attempts count against the same lockout and rate limit as login (FR-101, TC-002), so the endpoint cannot be used as a password-guessing oracle with a stolen token. Each failure and each success is audited (who, which action, outcome; never the password).
- Check order: authentication and role first, then the re-auth password, then the other fields (`code`, `userId`). A bad `code` after a correct password is the normal 2FA validation error, not `REAUTH_FAILED`.
- **Forced enrolment is unchanged.** Roles whose TOTP is mandatory (FR-102) enrol during login through the challenge-token flow (`/auth/2fa/enroll/start` and `/confirm` with `challengeToken`), which already follows a successful password check. That flow takes no `currentPassword` and issues no access token until enrolment is confirmed (TC-003).
- Open for BE-02/BE-03: whether a mandatory-2FA role may call `disable`. Recommended: no (403 `FORBIDDEN`, not `REAUTH_FAILED`), because disabling would put the account in a state login refuses.

### Frontend (FE Security page)

Ask for the password in a dialog before each of the four self-service actions, send it with the request, keep it in component state only, clear it on success, error and close. On `403 REAUTH_FAILED` show "Password is incorrect" inline and keep the dialog open; do not sign the user out and do not refresh the token.

### Tests (names must cite FR/TC IDs)

FR-102, FR-101, TC-002, TC-003: wrong password gives 403 `REAUTH_FAILED` on each endpoint; repeated wrong passwords lock like login; correct password succeeds; forced enrolment at login needs no `currentPassword`; the password never appears in logs or the audit record.
