# Follow-ups: Frontend track

## frontend/step-1 (code-reviewer, verdict: MERGE, no blockers)

The reviewer read the code only and did not run build, lint, typecheck or tests; CI is the real check.

### Must-fix before Step 10 merges

Items 1, 3 and 8 below (mock start hang, Run/Finish error states, demo controls in the real bundle) are **must-fix before Step 10 merges**, since Step 10 builds on this screen.

### Should-fix

1. **FIXED in PR #94.** **[MUST-FIX before Step 10] Failed mock start hangs every API call.** `apps/web/src/components/providers/msw-init.tsx:10-13`, `apps/web/src/lib/api/client.ts:19`. If `worker.start()` rejects, `markMockingReady()` is never called and the screen sticks on "Loading your test…". Add a `.catch` that toasts and marks ready, and give `mockingReady` a timeout.
2. **FIXED in PR #94 (the `public/mockServiceWorker.js` copy is left as is).** **No hard stop for mock mode in a production build.** `apps/web/src/lib/env.ts:3`, `apps/web/public/mockServiceWorker.js`. Fail the build in `next.config.ts` when `NODE_ENV === 'production'` and mocking is enabled (unless an explicit staging override is set); read the env var inline in `msw-init.tsx` so the mock import is dropped; copy the MSW worker only for dev.
3. **[MUST-FIX before Step 10] Run and Finish section error handling.** `apps/web/src/features/candidate-test/test-screen.tsx:172-200`. `run()` needs try/finally so `running` cannot stick. `finishSection()` must only set `finished` when the response is OK (ADR 0002: finishing is final).
4. **Autosave-on-run can skip the latest code (FR-504).** `apps/web/src/features/candidate-test/use-autosave.ts:30`. `flush()` should await an in-flight save, then save again if `latest` changed.
5. **Tests do not name TC IDs; failure paths untested.** `test-screen.test.tsx`, `logic.test.ts`, `use-autosave.test.tsx`. Name tests with TC-040/041/045/050 and cover the 429 path (`mocks/handlers.ts:96` ties the 429 to latency, so the Node test server never hits it; give it its own `cooldownMs`), paste blocking (TC-052), run network error and finish failure.
6. **Contract changes need architect sign-off.** Resolved in PR #4: the architect reviewed `packages/shared` and the placeholder OpenAPI, bounded the code and login inputs, and tracked the rest under ARC-02 below. Still open: the `Language` enum is duplicated in shared and the YAML (see the architect section).
7. **No client-side code length check.** `test-screen.tsx` does not validate against `runRequestSchema` (100,000 chars) before Run or the draft PUT, so an oversized submission gets a server rejection with no clear message.
8. **Permissions-Policy blocks the microphone.** `apps/web/next.config.ts:24`. `microphone=()` breaks FR-402, FR-607 and FR-701 later; use `microphone=(self)` or add a TODO tied to FE Steps 7 and 9.
9. **[MUST-FIX before Step 10] Demo-only controls ship in the real route bundle.** `apps/web/src/app/(candidate)/t/[token]/test/page.tsx:2`, `test-screen.tsx:144-152,422-431`. Alt+Shift+X "Simulate fullscreen exit", "Continue without fullscreen (demo only)" and the demo banner would bypass the lock in a real session. Load via `next/dynamic` only in mock mode or move into a demo wrapper before Step 10 builds on this screen.

### Nits

- `middleware.ts:29`: comment says prefetches keep the CSP; the `missing` matcher means they skip the middleware.
- `test-screen.tsx:118`: `(r as { error?: unknown }).error` cast; type the job results or check `response.ok`.
- `test-screen.tsx:271`: "(saved draft)" shows before any save.
- `test-screen.tsx:185`: a run result shows under the new question if the candidate switches mid-run; store per question ID.
- `test-screen.tsx:545`: `SavedIndicator` `role="status"` announces about every 10 s; drop the time or use `aria-live="off"` and announce errors only.
- `test-screen.tsx:209,249`: expiry announced twice (live region plus `role="alert"`).
- `code-editor.tsx:87-89`: DOM paste/drop/dragover listeners are never removed.
- `code-editor.tsx`: add a Tab-trap hint ("Press Ctrl+M to move focus out of the editor"), WCAG 2.1.2.
- `next.config.ts`: no HSTS header (architecture.md:82); comment that Caddy sets it, if so.
- `mocks/handlers.ts:64`: `startedAt` is set at module load, not at the start gate; add a comment.

### Not verified by the author

- Real browser fullscreen (headless Chromium cannot enter it); re-entering after a real exit is untested.
- Lighthouse only on `/` (accessibility 100); not on `/t/demo/test`; performance, best practices and SEO not run.
- Nothing ran on Node 24 (sandbox has 22.23.3; installed with `--config.engine-strict=false`).
- **[ARC-05]** `middleware.ts` is kept for now instead of Next 16 `proxy.ts`, because `proxy.ts` is Node-only and Cloudflare Pages needs the edge runtime (R-08). The build prints a deprecation warning. Decide in ARC-05 whether to move to `proxy.ts` or stay.

## frontend/step-2 (staff authentication screens, FE-02)

Built against MSW mocks; the paths below are placeholders like the rest of `apps/web/openapi/openapi.yaml`.

### Needed shared and contract changes for ARC-02 (web used web-local copies)

- **[ARC-02] Move `recoveryCodeSchema` and the 2FA verify body to `packages/shared`.** Web has them in `apps/web/src/features/auth/schemas.ts` (16 base32 characters, spaces and dashes ignored, upper-cased). `/auth/2fa/verify` takes a 6-digit code or a recovery code; the API must normalise the same way. See also the existing [BE-02] note on `otpCodeSchema`.
- **[ARC-02] Add the password-reset and set-password schemas and the password policy to `packages/shared`.** No doc defines the strength rules. Web assumes at least 12 characters, one lower-case, one upper-case and one digit, at most `MAX_PASSWORD_LENGTH` (`PASSWORD_RULES` in `schemas.ts`). The architect must confirm or change the policy; the backend must enforce the same list.
- **[ARC-02] Add `forgotPasswordRequestSchema` (email only) and `challengeToken` bodies** for `/auth/2fa/*`.
- **[ARC-02] Add the staff auth endpoints to the API contract and fsd.md section 4.** Placeholders used: `POST /v1/auth/login` (200 `authenticated` or `two_factor_required` or `two_factor_enrollment_required`, generic 401), `POST /v1/auth/2fa/enroll/start`, `POST /v1/auth/2fa/enroll/confirm` (returns the session and the 10 recovery codes once), `POST /v1/auth/2fa/verify`, `POST /v1/auth/refresh`, `POST /v1/auth/logout`, `POST /v1/auth/password/forgot` (202), `POST /v1/auth/password/reset` (204, or 400 with one message for unknown, expired and used tokens). fsd.md section 4 lists only login, 2fa/verify, refresh, forgot and reset; enrollment start/confirm and logout are missing.
- **[ARC-02] Decide the shape of the 2FA challenge.** Web holds an opaque `challengeToken` (returned by login, sent to the 2FA calls) in memory. The API needs a short-lived, single-purpose token for this and must not issue an access token before enrollment is confirmed (TC-003). Document its lifetime.
- **[ARC-02] Email links must carry the token in the URL fragment** (`/admin/reset-password#token=...`, `/admin/set-password#token=...`) so it never appears in server or proxy access logs. Web also accepts `?token=` and strips it, but a query token has already reached the server by then (ADR 0001 C-5, A-13). BE-06 templates `password-reset` and `staff-invite` should use the fragment.
- **[ARC-02] Add `StaffRole` and a permission matrix to `packages/shared`.** `RequireRole` takes an explicit role list because no shared permission matrix exists yet; the OpenAPI `StaffRole` enum duplicates `UserRole` from prisma (same drift risk as `Language`).
- **[ARC-02] Access token lifetime is unknown to the client.** Web refreshes on first load and after a 401 only. If the API returns `expiresIn`, add a timer to refresh just before expiry and avoid a failed first call.
- **[ARC-02] Account-lock response. Resolved by owner decision (FU-BE-22).** The API returns a generic 401 for locked accounts and never sends 423, `lockedUntil` or `Retry-After`. Web shows one neutral message for every failed sign-in ("Sign-in failed. If this keeps happening, wait 15 minutes or contact your administrator."), and the mock answers a locked account with the same 401 as a wrong password.

### Should-fix

1. **Production build can ship the mock auth state.** Same root cause as item 2 under frontend/step-1 (mock mode is not blocked in production). `apps/web/src/mocks/auth-handlers.ts` is only imported through `mocks/handlers.ts`, so it is dropped when mocking is off, but there is no hard stop.
2. **Playwright runs against `next dev` only.** `apps/web/playwright.config.ts` uses `next dev` with mocks. CI wiring (browser install, port, a production-build variant) is not done: CI config was out of scope. The `Cache-Control: no-store` header was checked by hand against `next start` (it is overridden in dev), not by a test.
3. **`/admin` guard is client-side.** `RequireRole` shows the page shell for a moment ("Checking your sign-in") before redirecting. A server-side check needs a cookie the web origin can read; revisit when the cookie domain is decided (ARC-03).
4. **Roles and the mock.** The mock treats SUPER_ADMIN and REVIEWER as TOTP-mandatory and the others as no-2FA; optional TOTP for RECRUITER and AUTHOR (FR-102) has no enrollment entry point yet (Settings, FE-03).
5. **No rate-limit message on login or forgot password.** A 429 shows the generic "could not sign in" or "wait a minute" text; once the API defines `Retry-After`, show the seconds.

### Nits

- QR code is generated in the browser with the `qrcode` package (MIT) from the otpauth URI the API returns; the secret therefore passes through the page. That is inherent to showing a manual key as well.
- Recovery codes download uses a short-lived blob URL and a text file; there is no "copy" button.
- The `Field` helper renders the hint as a `div`; the password rule list sits inside it.
- Next.js adds its own `role="alert"` route announcer, so Playwright selectors must exclude `#__next-route-announcer__`.
- `pnpm --filter @codeproctor/web gen:api` output must be run through `prettier --ignore-path /dev/null --write` (the file is in `.prettierignore`) to keep diffs small; see the step-1 nit.

### frontend/step-2 code-reviewer findings (verdict: no real blockers)

The reviewer's only "blocker" was a possible Prettier failure it could not run; `pnpm format:check` passes. It read the code only and did not run build, lint or tests.

#### Should-fix

1. **[MUST-FIX before Step 3 (FE-03) adds deep-linked staff pages] FIXED in FE-03: `next` is lost after 2FA verify.** `apps/web/src/features/auth/two-factor-verify-form.tsx:38-41,51-53`. `signIn()` clears `pending`, so the page bounces to `/admin/login` after the `router.replace(next)`, and the login page then forwards to `/admin`. The 401 branch also loses `?reason=expired`. Fix with a `submittedRef` or a `status !== 'authenticated'` check, and add a test that `next=/admin/x` survives the 2FA step. _Done: `finishedRef` in `two-factor-verify-form.tsx`; tests in `two-factor.test.tsx` cover `next=/admin/x` and the 401 `?reason=expired` redirect._
2. **Multiple tabs and refresh-token rotation.** `lib/auth-session.ts:30-35`, `auth-provider.tsx:51`. Two tabs refreshing at once can look like refresh-token reuse (FR-104) and revoke the family. Share one refresh across tabs with `navigator.locks` or BroadcastChannel, or add a short server-side reuse grace window ([BE-02]).
3. **FIXED in FE-03: A stale refresh can restore a session after sign-out.** `auth-session.ts:37-55`, `auth-provider.tsx:61-71`. Add a generation counter bumped by `signOut`, and drop results from an older generation. _FIXED in FE-03 (`invalidateRefreshes` in `auth-session.ts`, test in `session.test.tsx`)._
4. **FIXED in FE-03: Retry check hard-codes `/v1/auth/`.** `lib/api/client.ts:21`. Breaks when ARC-02 moves the API to `/api/v1` or `NEXT_PUBLIC_API_URL` has a path. Compare against the base path or tag auth calls explicitly. _FIXED in FE-03 (`isAuthRequest` in `client.ts`, relative to the API base URL and tolerant of `/api/v1`)._
5. **FIXED in FE-03: A failed logout call leaves an unhandled rejection.** `auth-provider.tsx:63-70`. Add `catch {}`; local sign-out still happens. _FIXED in FE-03 (test: failed logout still signs out)._ _Superseded in frontend/step-3-fixes: a failed logout now sets a "sign-out pending" boolean in localStorage (no token). While it is set the first-load silent refresh is skipped and the logout is retried; it clears only on a confirmed success or the next sign-in, and the login screen shows "We could not confirm you were signed out" with a retry button. The retry has no access token (it was dropped locally), so the API's `POST /v1/auth/logout` must revoke by the httpOnly refresh cookie alone._

#### Nits

- `require-role.tsx:33`: `next` drops the query string.
- `two-factor-enroll.tsx:107-113`: the "could not start set-up" alert has no link back to login.
- `two-factor-enroll.tsx:48`: the challenge token is in the React Query key; use a constant key.
- `client.ts:18-23`: every authenticated request is cloned up front; watch for large code bodies (NFR-01).
- `two-factor-verify-form.tsx:49`: the code is trimmed twice.

## frontend/step-3 (staff shell and Settings, FE-03)

Built against MSW mocks; the `/v1/admin/*` paths are placeholders in `apps/web/openapi/openapi.yaml`.

### Needed shared and contract changes for ARC-02 and BE-03 (web used web-local copies)

- **[ARC-02] The shared permission matrix skeleton has gaps the staff shell needed.** `packages/shared/src/permissions.ts` has no entry for Reports (Step 14) or candidate erasure (NFR-05, D-19), so `apps/web/src/features/staff/permissions.ts` adds `report:read` (SUPER_ADMIN, RECRUITER, REVIEWER) and `candidate:erase` (SUPER_ADMIN) locally. Add both to shared, then delete `LOCAL_ROLE_PERMISSIONS`. The Candidates sidebar item is gated by `invitation:create` or `candidate:erase` because there is no `candidate:read`; add one.
- **[ARC-02] `OrgSettings` and the form schemas belong in shared.** ADR 0007 section 6 says shared defines `OrgSettings`. Web-local copies are in `apps/web/src/features/admin/schemas.ts` (invite, retention 7..730, risk points 0..100, cap 1..20, MEDIUM 1..99 < HIGH 2..100, weights 0..5, consent version and body limits, decline contact up to 300 characters). The API must enforce the same bounds.
- **[ARC-02] Decide the org-settings and admin endpoints** (placeholders: `GET/POST /v1/admin/users`, `PATCH /v1/admin/users/{id}`, `GET/PATCH /v1/admin/settings`, `GET/POST /v1/admin/consent-texts`, `PUT /v1/admin/consent-texts/{id}/current`, `GET /v1/admin/candidates`, `POST /v1/admin/candidates/{id}/erasure`) and add them to fsd.md section 4 (it has none of them). The consent list also returns `legalApprovalRequired` (REQUIRE_LEGAL_APPROVED_CONSENT, ADR 0007) so the UI can disable "Use as current" for a placeholder; the API must refuse it too (409). Legal approval is recorded outside this UI (Q-43); there is no approve action.
- **[BE-03] Staff user rules the UI assumes:** a Super Admin cannot change their own role or deactivate themselves, nor remove the last Super Admin (409); deactivation revokes refresh tokens; an invite creates a user in an `invited` state until the first sign-in. Erasure answers 202 with the candidate's erasure state (`waiting` with `waitingFor` review or appeal, `queued`, `erased`).
- **[ARC-02] Risk settings shape.** Web sends the full `risk` object (points per severity, cap, band minimums, weights keyed by event type). Confirm that shape against ADR 0005 and ADR 0007 section 6, including what happens to an event type added later (web falls back to the shared default weight).
- **[ARC-02] Default roles for Review and Live:** the shared skeleton gives SUPER_ADMIN review and live rights (BE-03 open question). The sidebar follows it; if BE-03 removes them, the nav follows automatically.

### Should-fix

1. **Candidate-erasure confirmation is a single click.** TC-094 and D-19 are irreversible; consider typing the candidate's email to confirm, once Legal confirms the flow.
2. **The users and consent tables are client-side only.** `DataTable` filters, sorts and pages in the browser; switch to server-side paging behind the same props before lists can exceed a few thousand rows (candidates will, in Step 5).
3. **No keyboard shortcuts for navigation yet.** The shell has none; the review workspace shortcuts come with Step 11. A `g` then letter sequence for the sidebar would fit staff users.
4. **`MswInit` starts the worker twice under React StrictMode in `next dev`.** The dev server logs "cannot configure an already enabled network" as an unhandled rejection (same file as step-1 item 1; give it a `.catch` and a start guard).
5. **Settings tabs are links, not a tablist.** Fine for now (they navigate); keep as nav links.
6. **Screenshots not produced.** No PR was opened; capture them when the PR is created.
7. **The deactivate and erase confirmations are Radix dialogs inside the table page;** focus returns to the trigger button on close, but the row can re-render and lose it (the row button for a just-deactivated user turns into Reactivate). Move focus to the table caption after the action if screen reader users report it.

### Nits

- The mock admin state is in memory, so a reload resets it, unlike the auth state which uses a cookie.
- Weight inputs in the risk table are `type=number`; the browser's spinner can change a value on scroll. Consider `type=text inputMode=decimal` with the same zod rules.
- `DataTable` search matches only columns that give a `sortValue` or `searchValue`.
- `welcome-panel.tsx` still lives under `features/auth`; move it to `features/staff` when the real dashboard arrives. `UserBadge` and `SignOutButton` are now unused by the shell (kept for `ROLE_LABELS` and tests).

## frontend/step-3 code-reviewer findings

Items from the review of FE Step 3 that were not fixed in `frontend/step-3-fixes`. The sign-out race, role-change confirmation and login lock message are fixed there.

### Should-fix

1. **Risk settings: weight errors in hidden rows are invisible.** When a table filter hides a row whose weight input is invalid, Save fails with no visible error. Show a summary above the table that lists the hidden invalid rows, or clear the filter on submit.
2. **Risk settings page shows the raw server message** on a failed save. Replace it with fixed copy plus a fix-it hint; log the server message only through the approved logger.
3. **`c.facet!` non-null assertions in `DataTable`.** Narrow the type (a filtered list of columns that have a facet) instead of asserting.
4. **`DataTable` recomputes filtering and sorting on every render.** Wrap in `useMemo` keyed on rows, query, facets and sort. Fine for the small Step 3 lists; do it before the server-side paging change.

### Nits

- The TC-004 tag on the mock and UI tests overstates what they prove. TC-004 is a backend authorization case; label these tests FR-103 and keep TC-004 for the real API tests.
- The TC-075 example in the risk settings UI ignores the weights, so the sample score it shows can differ from what the engine computes. Compute the example from the current weights.

## Must-fix before later steps merge

- **[MUST-FIX before Step 10 merges] QA defect TC-047 / FR-505: a forward OS clock change shrinks the candidate's countdown.** `useServerClock` (`apps/web/src/features/candidate-test/use-clock.ts`) reads server time once and never re-syncs, so the remaining time follows the device clock afterwards. Fix: compute remaining time from the server deadline using a monotonic clock (`performance.now`) and re-sync with the server on every heartbeat. When it is fixed, tell QA so TC-047 becomes a normal test. Not fixed now; this is Step 10 work.

## frontend/step-3 session follow-ups (for backend and later web work)

- **[BE-02] `POST /v1/auth/logout` must be idempotent and revoke by the httpOnly refresh cookie alone.** Answer 204 when the cookie is missing, expired or already revoked, and do not require an access token: after a failed logout the web retries it on the next page load with no access token. Logout with a rotated or reused refresh token must revoke the WHOLE token family (TC-005 reuse detection); otherwise treating a 401 from logout as confirmed is unsafe, because a stolen older token could still be live. Web treats 204 and 401 as "confirmed" (a 401 means no valid session is left), and keeps a "sign-out pending" marker in localStorage for any other answer. If the API returned 5xx forever the marker would stay until the next sign-in.
- **Refresh failures other than 401/403 sign the user out.** `doRefresh` in `apps/web/src/lib/auth-session.ts` publishes "signed out" on 429, 5xx and network errors too. Better: sign out on 401/403 only and retry the rest, but first-load needs a third state ("cannot reach the server, retry") so the staff layout does not show "Checking your sign-in" forever. Not done in this PR.

### Playwright flake (observed while preparing the session-fixes PR)

- **Should-fix:** about 2 failed runs out of roughly 12 on the staff e2e suite (`pnpm --filter @codeproctor/web test:e2e`): one `toBeVisible` timeout in a single test, not reproduced when run again and not identified. Capture a trace (`trace: 'retain-on-failure'`) before wiring Playwright into CI, so the flaky test can be found.

### frontend/step-3-session-fixes: round 4 review (verdict: MERGE, no blockers)

- **Should-fix (session, judged not a blocker: no data or action crosses identities):** a tab whose first-load refresh is still in flight (`currentUserId` null) ignores the `cp.sessionEpoch` event, so after Y signs in elsewhere it can end up showing X, whose cookie it sent, until its next 401. Fix: when an epoch arrives with a refresh in flight, `invalidateRefreshes()` and drop a refresh result whose user differs from the announced id; add a TC-005-tagged test. The late `Set-Cookie` overwriting Y's refresh cookie cannot be fixed client-side; needs a server-side follow-up [BE-02].
- **Not introduced here:** tab A signing out as X while tab B signs in as Y sends a logout with the shared cookie, which may revoke Y's new session depending on server behaviour [BE-02].
- **Nits:** stale comments in `auth-session.ts` (generation bumped on any user change; epoch holds `nonce|userId`); move `generation`/`inFlight` declarations above `publishSession`; comment the `inFlight` clear gap in `publishSession`; duplicate `getSessionUserId()` check in `auth-provider.tsx:129`; consider removing `cp.sessionEpoch` in `confirmSignedOut`; add a test for an in-flight settings save during a storage-event sign-out.

## frontend/security-page (Security page under the user menu, FR-102)

Built against MSW mocks; paths are placeholders like the rest of `apps/web/openapi/openapi.yaml`. `/admin/security` is open to every signed-in staff role and linked from the user menu. Forced enrollment (`/admin/2fa/enroll`, `/v1/auth/2fa/enroll/*`) is unchanged and asks for no password.

- **[ARC-02] Contract now mirrors backend PR #26 (FU-BE-39); shared schemas still to add.** Bodies: `{ currentPassword }` (string, 1 to `MAX_PASSWORD_LENGTH`) for `POST /v1/auth/2fa/setup/start`, `/2fa/disable` and `/2fa/recovery-codes/regenerate`; `{ currentPassword, code }` (6 digits) for `/2fa/setup/confirm`. Responses: setup/start 200 `{ manualKey, otpauthUri, qrDataUrl }`, setup/confirm 200 `{ recoveryCodes }`, regenerate 200 `{ recoveryCodes }`, disable 204. Add these to `packages/shared` (web-local copies: `apps/web/src/features/security/schemas.ts`, `reauthBodySchema`, `setupConfirmBodySchema`).
- **[ARC-02] Error codes, as PR #26 sends them (RFC 7807 problem body: `type`, `title`, `status`, `detail`, `instance`, `traceId`, optional `errors`, `code`).** Add `REAUTH_FAILED` and `TWO_FACTOR_REQUIRED_FOR_ROLE` to the shared code list. 403 `REAUTH_FAILED` (detail "The current password is incorrect.") for a wrong password or a locked account, one identical body; wrong attempts share the login lockout counter (5 failures); the correct password on the 6th attempt is refused the same way. 403 `TWO_FACTOR_REQUIRED_FOR_ROLE` on disable for SUPER_ADMIN and REVIEWER, checked after the password. 400 for a missing or invalid field (and a wrong first code on setup/confirm), 401 for a missing or expired token, 409 for a state conflict (disable or regenerate with 2FA off, setup when it was turned on concurrently). Web: REAUTH_FAILED shows only "Password incorrect" in the dialog (stays open, no sign-out, no refresh); TWO_FACTOR_REQUIRED_FOR_ROLE shows a role message; 400 a field message; 409 a state-conflict message. The web also hides Disable for those roles (web-local `TWO_FACTOR_MANDATORY_ROLES`; move to shared).
- **[ARC-02] Disable now needs a TOTP code and signs out everywhere (backend PR #51, ADR 0011 answers 5 and 6).** Body `{ currentPassword, totpCode }`; `totpCode` is 6 digits only (a recovery code or malformed code is 400; the web trims whitespace). 403 `REAUTH_FAILED` for a wrong or locked password or a wrong or replayed code (the web shows "Password or code incorrect", keeps the dialog open, empties both fields, never signs out); 409 if 2FA is already off; 403 `TWO_FACTOR_REQUIRED_FOR_ROLE` for SUPER_ADMIN and REVIEWER; 503 shows "Verification is temporarily unavailable" with a try-again hint. Server check order: password, 409, code, role. On 204 the server revokes every refresh-token family (this one too) and clears the cookie, so the web treats it as a sign-out (`signOutRevoked` in `AuthProvider`: no refresh, no logout call, session forgotten first, cache cleared; the sign-out marker is set briefly only as a cross-tab broadcast and cleared last, so nothing stays pending) and goes to `/admin/login?reason=two-factor-off` with a one-time notice. No `totpEnabled` re-read after disable or regenerate (it does not change); after set-up the re-read runs when the user clicks Done on the recovery codes, never while they show. Access tokens already issued stay valid up to 15 minutes (FU-BE-59). Reconcile when #51 lands.
- **[ARC-02] Naming resolved.** The hub's `docs/api-contract.md` now says `totpCode` for disable (matching the web and backend PR #51); `setup/confirm` correctly keeps `code`.
- **[Hub follow-up, not this PR]** `docs/api-contract.md:17` still says "#51 pending" and that the UI calls `POST /auth/logout` after disable. #51 is on main, and the web makes no logout call (the server already revoked every session and cleared the cookie).
- **[Follow-up, low]** If the disable 204 arrives for the same user but a newer session generation, the web closes the dialog and does not sign out (fails closed; unlikely). The stale-session branch closes silently; consider a short notice. `confirmSignedOut()` removes the sign-out marker unconditionally; that is intended (it is the last step of a sign-out), keep it in mind if another sign-out can overlap.
- **[ARC-02] 2FA state comes from the session user.** The placeholder `GET /v1/auth/2fa/status` is removed. The web depends on Backend adding `totpEnabled: boolean` to `AuthUserDto` (returned by login, 2fa/verify, enroll-confirm and refresh). `openapi.yaml` already lists it as required and the mock mirrors it (derived from the per-user mock 2FA state). The Security page reads `useAuth().user.totpEnabled` (undefined, from a session that does not carry it yet, shows "Your two-factor status is not available yet", offers no actions and tells the user to contact the administrator if it keeps happening; signing in again cannot help until Backend PR #58 returns the field) and re-reads the user through the silent-refresh guard once set-up is acknowledged (Done). Reconcile when that backend PR lands. Note: a failed refresh there follows the existing rule that `doRefresh` signs out on any failure (see the refresh-failure follow-up above).
- **Status of this work:** the web builds against mocks. When PR #26 merges, switch to the generated client from the real spec, delete the new handlers in `src/mocks/auth-handlers.ts` and reconcile any remaining differences.
- **Rate limits are the server's job.** The web assumes setup, disable and regenerate are rate limited server-side; the UI has no attempt counter. The mock mirrors only the shared lockout, not request rate limits.
- **401 handling.** The client's refresh-and-retry skips `/v1/auth/*`, so these calls retry once after a silent refresh themselves (`features/security/api.ts`). A 403 never reaches that path and never signs the user out.

- **[QA] Allocate TC IDs for the optional 2FA flows.** There are none yet for optional set-up, disable, regenerate and the re-auth rules: a re-auth 403 `REAUTH_FAILED` does not sign the user out and makes no refresh call; its lockout is shared with login (5 failures, the 6th correct password is refused with the identical body); recovery codes are shown once (and the old set stops working on regenerate); a 401 replay never crosses users. Tests in `features/security/security.test.tsx` and `e2e/security.spec.ts` are tagged FR-102 for now; rename them when the IDs exist.
- **Session handling.** The "401, refresh, send again" guard is one helper, `refreshForReplay` in `src/lib/auth-session.ts`, used by both `lib/api/client.ts` and `features/security/api.ts`: it replays only for the same signed-in user and an unchanged session generation, otherwise the call fails with `session` and no second request (the password is never sent as another user).

### frontend/security-page re-review (verdict: MERGE, no blockers)

- **Should-fix (tests):** add a test where a security call gets a 401 with no signed-in user (expect no refresh, failure `session`) and one where `beginSignOut()` runs while a security POST is in flight and the response is a 401 (expect no refresh, no second POST). Strengthen the assertion at `security.test.tsx:503` to `getSessionUserId()` and `getAccessToken()` both null, and count that exactly one refresh happened.
- **Nits:** take the session stamp in the same synchronous step as the token in `lib/api/client.ts` (today the token is attached in `authMiddleware.onRequest` and the stamp in the next middleware, after an await; no realistic trigger found); in `features/security/api.ts` replay with the token `refreshForReplay` just checked or re-check the stamp synchronously before `send()`; update the `getGeneration` doc comment in `auth-session.ts:139` (requests now use `captureSessionStamp`).

### frontend/csp-wasm-candidate-test review (D-45 / P-05; verdict: MERGE, no blockers)

- **Should-fix (before the in-browser detectors ship):** the stepper's "Start test" action (FE-09) must reach `/t/[token]/test` by a full document navigation (`window.location.assign` or a server redirect), not `router.push`, or the test page keeps the stepper's CSP and WebAssembly is blocked (detectors report DETECTOR_UNAVAILABLE). Add a test asserting that when the action is built. The landing-page preview link is already a plain anchor.
- **Nits:** the SDK uses only tfjs webgl/cpu backends today, so "tfjs wasm backends" in the `csp.ts` comment is forward-looking; the inference worker script is served from `/_next/static/`, which the matcher skips, so it gets no CSP header of its own (consider a CSP header for worker scripts); Safari before 16 does not recognise `'wasm-unsafe-eval'` (note in R-08 / ARC-05 browser support); if the FR-402 camera check on the stepper ever runs face detection it needs a new owner decision, since D-45 limits this to the test route; track Next 16's `middleware.ts` to `proxy.ts` deprecation (already tagged ARC-05).

### Test flake: admin tables (seen once in CI)

- `apps/web/src/features/admin/settings.test.tsx` ("FR-103: lists staff users sorted by name with status and role") timed out under CI load while the table was still loading (the CI run after PR #28 merged). Fixed by awaiting the loaded state, with a 30 s `testTimeout` in `vitest.config.mts` so the wait is not cut short by Vitest's default 5 s per-test limit (`findLoadedTable` / `findLoadedRow` in `src/test/table-utils.ts`: table not `aria-busy`, no skeleton rows, or the empty state) instead of relying on a time limit; applied to the users, candidates and consent tests and to `cross-user-cache.test.tsx`.

### frontend/csp-wasm-candidate-test delta review (verdict: MERGE, no blockers)

- **Accepted risk, decide under R-08 / ARC-05:** requests carrying `Purpose: prefetch` (or `next-router-prefetch`) skip the CSP middleware, so a document fetched that way has no CSP header or nonce. This is Next's documented matcher pattern and was already in place before D-45; the app emits no document prefetch links, Next's own RSC prefetches are not documents, and Chrome sends `Sec-Purpose` (which still runs the middleware). Either drop the `purpose` rule so every document gets a CSP (cost: one nonce per prefetch) or keep it as an accepted risk.
- **Nits:** mention browser Back/Forward in the `isCandidateTestPath` comment (a popstate navigation may keep the previous page's allowance, negligible); add TC IDs to the CSP tests if `docs/test-cases.md` gains CSP cases; add an assertion that `{ purpose: 'other' }` still runs the middleware. The step-1 nit about the "Prefetches keep the CSP" comment is resolved.

## Frontend B (candidate) (D-51)

Follow-ups from the review of PR #79 (candidate screen must-fix before Step 10). IDs FU-FEB-nn.

- **FU-FEB-01 (FIXED in PR #94) (should-fix, owner Frontend A) mock `savedAt` vs `/v1/time`.** `apps/web/src/mocks/handlers.ts`: the `/v1/time` mock runs 90 s ahead of the browser, but the draft PUT mock returns `savedAt: new Date()` (no offset). The candidate screen re-syncs its countdown from `savedAt`, so in mock mode the countdown jumps by 90 s after the first save. Return `new Date(Date.now() + 90_000)` from the draft and finish mocks, or share one `mockServerNow()` helper. The web unit tests do not hard-code the mock offset.
- **FU-FEB-02 (should-fix, owner architect, ARC-02) server time and finish codes in the contract.** `savedAt` must be the server's current time (the screen uses it as a clock sample). Ask ARC-02 to add `serverNow` to the run and heartbeat responses, and to document 409 (already finished) and 410 (section or test expired) on `POST /v1/candidate/sections/{sectionId}/finish` in `apps/web/openapi/openapi.yaml`. The screen treats 409 as finished.
- **FU-FEB-03 (FIXED in PR #94) (should-fix, owner Frontend A) mock startup and build guard.** `components/providers/msw-init.tsx`: add a `.catch` that marks mocking ready and a timeout on `mockingReady` (`lib/mock-ready.ts`; the candidate tests currently mock that module because mock mode never becomes ready in jsdom). `next.config.ts`: fail the build when `NODE_ENV=production` and `NEXT_PUBLIC_API_MOCKING=enabled`, unless an explicit staging override is set (see frontend/step-1 items 1 and 2).
- **FU-FEB-04 (should-fix, owner QA) CI check for demo strings.** Add a CI step that builds with mocking off and greps `.next/static` (and `.next/server`, excluding `*.map`) for `Simulate fullscreen exit`, `demo only` and `Nothing here is real`; the job fails on any hit. Verified by hand on PR #79: absent with mocking off, present with it on.
- **FU-FEB-05 (QA note) TC-047 is a normal test now.** `qa-tc.test.tsx` "TC-047 moving the OS clock forward one hour after load keeps the countdown" is a regular `it` and passes (the countdown uses `performance.now()`, re-syncs from save responses, a 60 s `/v1/time` re-fetch, window focus, and an immediate re-fetch when `Date.now` and `performance.now` diverge by more than 2 s). FU-QA-01 and the TC-047 matrix row (`docs/test-matrix.md`) can be closed by QA.
- **FU-FEB-06 (should-fix, owner architect, ARC-02) finish status is inferred.** The session response has no per-section "finished" flag, and the finish contract does not say what a 409 means (already finished, SESSION_PAUSED, SESSION_NOT_ACTIVE, outside the open section). The screen therefore never trusts a status code: after a failure or any 409 it re-reads `/v1/candidate/session` with a plain request (no cache write) and treats a different `section.id` as finished; otherwise it shows a "not finished" or "could not confirm" message. Add `section.finishedAt` (or a status) to `CandidateSession` and a problem `code` on 409, then match on them. The candidate-session cache is only updated when the candidate presses Continue after the finished banner.
- **FU-FEB-07 (nit) warn on a stale clock.** If the countdown has not re-synced with the server for N minutes (for example 5), show a calm "We could not confirm the time with the server since HH:MM" notice. Today a failed periodic re-fetch keeps the last offset silently; only a never-loaded clock pauses the editor.

### Playwright flake: staff-shell loading state (seen once, FE-03)

- `e2e/staff-shell.spec.ts` "shows a loading state before the rows arrive" failed once in a full run and passed on the rerun (25 of 25). Not reproduced; likely a race between the mock's response and the assertion on the skeleton rows. Capture a trace on failure before wiring Playwright into CI, and make the test hold the response with a gated handler instead of relying on timing.

### Sign-out and enrollment ordering (PR #66 rounds)

- **Should-fix (S2):** a remounted provider (for example a client-side navigation that remounts `AuthProvider`) loses the "could not confirm you were signed out" warning although the marker is still set. Derive the initial warning state from the marker after mount.
- **Fixed here:** forced enrollment now calls `announceSession` as soon as `enroll/confirm` returns (clears the marker, announces the sign-in, does not publish the session or navigate), so no tab retries a logout with the new user's cookie while the recovery codes are still on screen. "Retry sign-out" also checks that the failed answer is still current and the marker is still set, and is disabled while a retry runs.
- **[BE-02] Residual:** for login and 2FA verify the same cookie-before-`signIn` window is a few milliseconds between the server's Set-Cookie and `signIn`; it cannot be closed on the client. Backend could make `POST /v1/auth/logout` safe to retry against a rotated cookie (it only ends the session the cookie belongs to) but cannot tell the web whose cookie it is.

### frontend/security-signout-order round 4 review (verdict: MERGE, no blockers)

- **Should-fix (tests):** in `session.test.tsx` (forced-enrollment case, ~756-763) the "a tab that opens or reloads sends no logout" check can pass even if the code regresses: one empty `act` flush does not guarantee a wrongly sent `/logout` reached the handler. Count `/v1/auth/refresh` hits and `await waitFor(() => expect(refreshCalls).toBe(1))` to prove boot took the refresh branch, then assert `logoutCalls === 1`; call `resetInMemorySignOutFlagForTests()` before the second render so it models a real reload. Add a variant where a separate provider holds the failed logout and receives the marker-null and epoch `StorageEvent`s that `beginSession` produces, asserting its Retry is gone and a stale Retry click sends no `/logout` (today the other-tab handler is covered only with synthetic events elsewhere).
- **Nits:** comment in `announceSession` that it deliberately does not touch `logoutOutstanding` (the generation check covers a late answer); the comment in `two-factor-enroll.tsx` should say this tab's own Retry is cleared too.
- **FU-FEB-08 (should-fix) test that lock state survives a section change.** Add a test that the fullscreen lock phase and warning count (now held in `TestScreen`) are unchanged after Continue moves to the next section.
- **FU-FEB-09 (should-fix) test a 409 whose re-read reports the next section.** The re-read path is tested after a network error; add the same for a 409 response, which must show the finished banner.
- **FU-FEB-10 (should-fix) feedback when Continue fails.** `advance()` in `test-screen.tsx` shows nothing if the refetch fails or the section is unchanged; show a fix-it message and keep the button usable.
- **FU-FEB-11 (should-fix, a11y) move focus to the banner.** When the finished banner appears, move focus to its "Continue to the next section" button (the dialog that had focus has just closed).
- **FU-FEB-12 (later step) last-section path.** After the last section the banner has no action. A "test submitted" view is needed (later step, FE-10 and after).
- **FU-FEB-13 (nit) `fsFailed` belongs in `TestScreen`.** It is per-section state in `TestScreenInner`, but the start gate and fullscreen request are test-wide now that the lock state is lifted.
