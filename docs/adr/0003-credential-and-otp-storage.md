# ADR 0003: Credential and OTP storage

| Field | Value |
| --- | --- |
| Status | **Accepted** 2026-10-01 (D-16): every recommendation as proposed; amended by D-21 (no OTP lockout during a test) and D-22 (self-service password reset). See section 6. Applied to database.md; deltas in ADR 0008. |
| Author | architect |
| Decides | Q-03, Q-04, Q-05, A-11 item 1 |
| Serves | FR-101, FR-102, FR-104, FR-106, FR-107 (added by D-22); NFR-04; TC-003, TC-005, TC-007, TC-097, TC-098 |
| Hands off | The OTP pepper and other secrets go into ARC-03's environment inventory. |

## 1. Recovery codes (Q-03)

- (a) **Accepted:** `users` add `recovery_code_hashes text[] NOT NULL DEFAULT '{}'`.
  - Issue 10 codes of 16 random base32 characters (80 bits each) and store them as SHA-256 hex. High-entropy codes do not need Argon2.
  - A used code is removed by the same UPDATE that checks it (`WHERE $hash = ANY(recovery_code_hashes)`), so two concurrent uses cannot both succeed. audit_logs records the use.
- (b) Table `user_recovery_codes(id, user_id FK ON DELETE CASCADE, code_hash, used_at)`. It keeps used codes, but adds a table.

## 2. Candidate OTP and the 30-minute block (Q-04)

- (a) **Accepted, no schema change.** Short-lived state lives in Redis with a TTL. The block applies only before the test starts (D-21, section 6).
  - `otp:{invitationId}` holds {HMAC-SHA256(code, OTP_PEPPER), attempts}, TTL 10 minutes.
  - `otp-block:{invitationId}` is set after the 5th failure, TTL 30 minutes.
  - The hash is keyed with a server secret because a plain SHA-256 of a 6-digit code falls to a million guesses.
  - The block writes an audit_logs row (null actor) and enqueues a recruiter email (new template `otp-lockout` in BE-06; TC-007).
  - Keys are per invitation, not per IP (A-27).
  - If Redis loses data, the candidate requests a new code. Nothing durable is lost.
- (b) Table `candidate_otps(invitation_id, code_hmac, expires_at, attempts)` plus `invitations.otp_blocked_until`. It survives a Redis flush, but adds writes on a hot path.

Email jobs that carry an OTP or a raw invitation token are removed when they finish (A-31, ADR 0001 C-5).

## 3. Refresh-token family (Q-05)

- (a) **Accepted:** `refresh_tokens` add `family_id uuid NOT NULL`. A new family is created at login and copied on each rotation. Add `CREATE INDEX ON refresh_tokens (family_id)` and `CREATE INDEX ON refresh_tokens (user_id)` (A-22). Reuse of a rotated token revokes `WHERE family_id = $1` (TC-005), and logout does the same.
- (b) Walk `replaced_by` with a recursive CTE. No schema change, but it is slower and harder to test.

## 4. Staff invites (A-11 item 1)

- (a) **Accepted:** `users.password_hash` becomes nullable.
  - Add `set_password_token_hash text UNIQUE` and `set_password_expires_at timestamptz`.
  - Add `CHECK (password_hash IS NOT NULL OR set_password_token_hash IS NOT NULL)`.
  - Login refuses a user with no password. The same columns also serve an admin-triggered password reset.
- (b) A separate `user_invites` table, with the `users` row created on acceptance. `password_hash` stays NOT NULL, but there is one more table and the email-uniqueness check runs in two places.

Self-service "forgot password" was a gap; D-22 put it in scope (section 6).

## 5. Consequences and affected agents

- **Accepted delta:** `users` (nullable `password_hash`, 3 columns, 1 CHECK) and `refresh_tokens` (`family_id`, 2 indexes). No new tables.
- **db-engineer:** DB-02 and DB-03 apply the delta. DB-04 sets `family_id` on seeded tokens.
- **backend-engineer:** BE-02 (recovery codes, family revoke, password reset), BE-03 (invite through set-password token), BE-06 (`otp-lockout`, `password-reset` and `staff-invite` templates), BE-07 (Redis OTP, D-21 rules).
- **frontend-engineer:** FE-02 (recovery codes download, forgot and reset password pages), FE-03 (invite flow).
- **architect:** ARC-03 adds `OTP_PEPPER` to the environment inventory.

## 6. Amendments after acceptance (D-21, D-22)

**D-21: no OTP lockout once a test is in progress.**
- The `otp-block:{invitationId}` key is set only while the session is INVITED, OPENED, CONSENTED or VERIFIED. TC-007 is unchanged for that phase.
- While the session is IN_PROGRESS or PAUSED, a wrong OTP does three things:
  - sets `otp-cooldown:{invitationId}` with a 30-second TTL;
  - logs the SERVER event RESUME_OTP_FAILED;
  - publishes it to `live:{orgId}` so the proctor is alerted.
- Attempts during the cooldown get 429 with the seconds left. There is no attempt cap while the test runs (TC-097).
- *Detail chosen by architect; owner to confirm:* the 30-second cooldown; the event name; no cap.

**D-22: self-service staff password reset (new FR-107, TC-098).**
- `POST /auth/password/forgot {email}` always answers 202 with the same body, so it never reveals whether the account exists.
  - It is rate-limited per email and per IP.
  - For an active user it stores the SHA-256 of a 32-byte token in `set_password_token_hash`, sets `set_password_expires_at`, and emails a link (template `password-reset`).
  - A new request replaces any earlier token.
- `POST /auth/password/reset {token, newPassword}` checks the hash and the expiry, sets the Argon2id hash, and clears the token (single use) in one transaction. It also:
  - revokes every refresh-token family of the user;
  - resets `failed_logins` and `locked_until`;
  - writes an audit row.
- It never signs the user in, and it never disables TOTP. SUPER_ADMIN and REVIEWER still pass TOTP at their next login (FR-102).
- The token travels in the URL, so it gets the same never-log and Referer rules as the invitation token (ADR 0001 C-5, A-13).
- *Detail chosen by architect; owner to confirm:*
  - reset links expire after 30 minutes (staff invite links after 72 hours);
  - invite and reset share the two `set_password_*` columns;
  - a reset clears the login lockout.

## 7. Proposed amendment: refresh reuse grace (owner approval required, not in force)

Status: Proposed. A rotated refresh token that comes back is treated as theft and revokes its family (TC-005). Two simultaneous tabs trip this today: the loser's update waits on the winner's row lock, sees no live row and revokes the family, signing out both. A rotation response lost after commit (the retry carries the old cookie) is a different case, handled by the unknown-commit rule in api-contract section 8 (Refresh bullet), not by this grace.

Preferred first step, no security cost: a client-side single-flight refresh across tabs (Web Locks API, with BroadcastChannel as the fallback), so two tabs never refresh at the same moment. Frontend owns it. The grace below is needed only if the owner wants server-side protection as well.

Proposal: a token rotated less than 10 seconds ago (`replaced_by_id` set; never a token revoked by logout, reset, deactivation or family revocation), whose successor has not been used, answers the fixed 401 without revoking the family. It applies on both reuse paths: the `revokedAt` check before the transaction and the in-transaction `RefreshReuseSignal`. The 401 sets no cookie and clears none (the browser keeps the winning tab's cookie, and a retry succeeds). The grace is a code constant `REFRESH_REUSE_GRACE_MS` (10000; 0 switches it off), not an environment variable. Every grace hit writes a low-severity `AUTH_REFRESH_REUSE_GRACE` audit row or metric, so repeated hits stay visible. The family is marked suspect: if its successor is used after a grace hit, or the user signs in fresh while the mark is set, the family is revoked and the theft alert fires.

Cost: without the suspect mark the grace would disable TC-005 when the attacker wins the race: the attacker rotates T0 to T1, the owner's T0 inside 10 s gets a 401, the owner signs in again, T0 never returns, and the attacker's family lives to the end of its TTL (today the owner's T0 revokes it at once). The suspect mark closes that case only if the owner's fresh sign-in or the attacker's next use hits it, which is why both revoke. Residual: an attacker who rotates and then never uses T1 is not detected, as today. Backend builds this only after the owner accepts it.
