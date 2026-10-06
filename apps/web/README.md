# @codeproctor/web

Next.js 16 (App Router, TypeScript strict), Tailwind v4, shadcn/ui-style components, TanStack Query,
react-hook-form + zod (schemas from `@codeproctor/shared`), `openapi-fetch` client, MSW mocks.

Route groups: `(public)` landing and errors, `(staff)` `/admin/*`, `(candidate)` `/t/[token]/*`.

## Run with mocked API (no backend needed)

```sh
pnpm install
pnpm dev:web:mock        # from the repo root; same as: pnpm --filter @codeproctor/web dev:mock
```

Open <http://localhost:3000/t/demo/test> for the mocked candidate test screen preview. The token
`demo` only works when `NEXT_PUBLIC_API_MOCKING=enabled`.

Mock mode is blocked in builds: `next build` fails when `NEXT_PUBLIC_API_MOCKING=enabled`, whatever
`NODE_ENV` is (`next.config.ts`). CI and QA throwaway builds can opt in with
`ALLOW_MOCKING_IN_PRODUCTION_BUILD=staging-only`; never use it in any deployed image.
If the mock worker fails to start, the app shows a toast and API calls stop waiting after 5 s.
`public/mockServiceWorker.js` is committed and still ships as a static file; it does nothing unless
the mock code registers it, and that code is removed from builds without mock mode.

Without mocks: `pnpm dev:web` (expects the API at `NEXT_PUBLIC_API_URL`, default
`http://localhost:4000`).

`predev` builds `@codeproctor/shared` and copies Monaco to `public/monaco` (git-ignored).

## Scripts

| Script                      | What it does                                                      |
| --------------------------- | ----------------------------------------------------------------- |
| `dev`, `dev:mock`           | Dev server, without or with MSW mocks                             |
| `build`, `start`            | Production build and server                                       |
| `test:e2e`                  | Playwright against `next dev` with mocks on (port 3217)           |
| `typecheck`, `lint`, `test` | tsc, eslint, Vitest (MSW runs in Node there)                      |
| `gen:api`                   | Regenerates `src/lib/api/schema.d.ts` from `openapi/openapi.yaml` |

## API contract and mocks

There is no backend OpenAPI spec yet. `openapi/openapi.yaml` is a small hand-written contract for
the endpoints the mocks serve. When the API publishes its spec, replace the file, run `gen:api`, and
delete the matching handlers in `src/mocks` (remove mocks when the backend step merges).

## Content Security Policy

`src/middleware.ts` sets a per-request nonce CSP built by `src/lib/csp.ts` (unit tested).

- `script-src 'self' 'nonce-...' 'strict-dynamic'`. No inline scripts except Next's nonced ones.
- `connect-src 'self'` + `NEXT_PUBLIC_API_URL` origin + `NEXT_PUBLIC_UPLOAD_ORIGINS`.
- `style-src` allows `'unsafe-inline'` (Monaco and Radix inject style attributes). Scripts do not.
- `worker-src 'self' blob:` for Monaco workers and the MSW service worker.
- Dev only (`next dev`): `'unsafe-eval'` in script-src (React dev stacks) and `ws://localhost:*` in
  connect-src (hot reload). Never emitted in production.

## Candidate test preview (`/t/demo/test`)

Mocked only, no proctoring logic. Monaco is self-hosted (copied from `node_modules`, no CDN). Demo
controls: "Enter fullscreen" start gate (or "Continue without fullscreen (demo only)"), and
"Simulate fullscreen exit" (Alt+Shift+X) to show the lock overlay when fullscreen is unavailable.
Sample-run results are fake: code containing `sort` passes samples 1 and 2, adding `<=` or `max(`
also passes sample 3, empty code gives a compile error, `while True` gives a timeout.

## Staff authentication (FE-02, mock mode)

Routes (all under the `(staff)/admin` group; one `AuthProvider` in `admin/layout.tsx`):

| Route                    | What it is                                                                       |
| ------------------------ | -------------------------------------------------------------------------------- |
| `/admin/login`           | Email + password (FR-101), one neutral failed-sign-in message, "Forgot password" |
| `/admin/2fa`             | 6-digit code or recovery code (FR-102)                                           |
| `/admin/2fa/enroll`      | Forced enrollment: QR code, manual key, confirm, recovery codes                  |
| `/admin/forgot-password` | Same confirmation for any email (FR-107)                                         |
| `/admin/reset-password`  | Set a new password from the emailed link (FR-107, D-22)                          |
| `/admin/set-password`    | Same page for a staff invite (ADR 0003 section 4)                                |
| `/admin`                 | Dashboard inside the staff shell (see FE-03 below)                               |

Try it: `pnpm dev:web:mock`, then open <http://localhost:3000/admin/login>. Mock users (fake):

| Email                    | Password            | Role        | Behaviour                                                                         |
| ------------------------ | ------------------- | ----------- | --------------------------------------------------------------------------------- |
| `recruiter@example.test` | `Recruiter-Pass-1`  | RECRUITER   | No 2FA, goes straight in                                                          |
| `admin@example.test`     | `Admin-Pass-12345`  | SUPER_ADMIN | TOTP already set up: code `123456`, or recovery code `ABCD-EFGH-2345-6723` (once) |
| `author@example.test`    | `Author-Pass-12345` | AUTHOR      | No 2FA, goes straight in                                                          |
| `reviewer@example.test`  | `Reviewer-Pass-12`  | REVIEWER    | Not enrolled: forced to enroll, confirm with `123456`                             |

Five wrong passwords for a known email lock it for 15 minutes (a sixth, correct attempt is refused). Wrong password, unknown email and locked account all get the same generic 401, and the login screen shows one message for all of them (FU-BE-22).
Reset link: `/admin/reset-password#token=mock-reset-token` (works once; `mock-expired-token` is always
refused). Invite link: `/admin/set-password#token=mock-invite-token`. The mock keeps its state
(failed logins, enrolled users, used tokens, the fake refresh "cookie") in one mock-only cookie,
`mock_auth_state`, so it survives reloads; clear cookies to reset. After a reset the mock still
accepts the original passwords above.

How it works:

- The access token lives in memory only (`src/lib/auth-token.ts`). Nothing is put in storage.
- `src/lib/auth-session.ts` does the silent refresh through the httpOnly cookie endpoint
  (`POST /v1/auth/refresh`, one call at a time). `AuthProvider` runs it on first load. The API client
  retries a staff request once after a 401 and a refresh; if the refresh fails the user is sent to
  `/admin/login?reason=expired&next=...`.
- The 2FA challenge token is held in `AuthProvider` state only; a reload goes back to login. No
  access token is issued until enrollment is confirmed, so no staff page opens before that (TC-003).
- Reset and invite links should carry the token in the fragment (`#token=...`) so it never reaches a
  server log; a `?token=` query is accepted and both are removed from the address bar on load. The
  page sends `Referrer-Policy: no-referrer` and `Cache-Control: no-store`, and the token is only
  held in component state until the one POST.
- MSW is started with `quiet: true` because it would otherwise print request bodies (passwords,
  codes, tokens) to the console.

Tests: `pnpm --filter @codeproctor/web test` (Vitest) and `pnpm --filter @codeproctor/web test:e2e`
(Playwright, needs Chromium: `npx playwright install chromium`). The e2e specs run axe-core on each
auth page.

## Security page (FR-102, mock mode)

`/admin/security` (user menu, "Security"), open to every staff role. Set up 2FA (QR, manual key, first
code, one-time recovery codes with download), Disable 2FA (hidden for SUPER_ADMIN and REVIEWER, who
get an explanation), and Regenerate recovery codes. Each action opens one shared dialog that first asks
for the current password and sends it as `currentPassword`. A wrong password is 403 `REAUTH_FAILED`
and shows "Password incorrect" in the dialog without signing out. Try it as `recruiter@example.test`
(`Recruiter-Pass-1`) or `author@example.test`: set up with code `123456`, then sign out and in again
to see the code prompt, and disable. `admin@example.test` and an enrolled reviewer see Regenerate only.
The mock keeps this state in the same `mock_auth_state` cookie. Code: `src/features/security`.
Playwright: `e2e/security.spec.ts`.

## Question bank (FE-04, FR-201..FR-205, mock mode)

Sign in as `author@example.test` (`Author-Pass-12345`) or the super admin, then open Questions.
`recruiter@example.test` can list questions (`question:read`) and open a question for a read-only
summary. The mock follows the real BE-04a API (PR #146): a caller without `question:update` gets the
allowlisted read view of the PUBLISHED version only (statement, visible samples; a hidden test case
is just `{id, position, isHidden, weight}`; no revision, reference solution, answer spec or
validation report; TC-011, DL-32), a draft or never-published question is a plain 404 ("This
question is not available to you"), a published but archived question is still readable, and every
write route is 403. Writers get an opaque `revision` (a content digest) and send it back as
`expectedRevision` on save and publish (409 when stale); editing a published question forks the next
draft (`createdNewVersion`), copying test cases and variants with new ids. Variants follow the real
BE-04b routes (`/versions/{n}/variants`, per-slot overrides, candidate-shaped preview): a variant has
params, an active flag and a rendered statement but no name, so the editor calls them "Variant 1",
"Variant 2" by list position. Validation and AI reference solutions follow the real BE-04c routes:
`POST /validate` starts a run bound to the revision it validated, `GET /validation` reports NONE,
RUNNING, PASSED, FAILED, STALE (the content changed, result dropped) or ERROR plus the report per
variant and language; AI rows belong to ONE version (a new version starts with none), the server
stamps their time, and publishing a coding question needs a passing run of the current revision and
current rows from two distinct assistants per language. The only route the API does not serve is
prefill, a web-only placeholder. See `docs/followups/frontend.md` ("BE-04a/b/c sync").

| Route                    | What it is                                                                       |
| ------------------------ | -------------------------------------------------------------------------------- |
| `/admin/login`           | Email + password (FR-101), one neutral failed-sign-in message, "Forgot password" |
| `/admin/2fa`             | 6-digit code or recovery code (FR-102)                                           |
| `/admin/2fa/enroll`      | Forced enrollment: QR code, manual key, confirm, recovery codes                  |
| `/admin/forgot-password` | Same confirmation for any email (FR-107)                                         |
| `/admin/reset-password`  | Set a new password from the emailed link (FR-107, D-22)                          |
| `/admin/set-password`    | Same page for a staff invite (ADR 0003 section 4)                                |
| `/admin`                 | Dashboard inside the staff shell (see FE-03 below)                               |

Try it: `pnpm dev:web:mock`, then open <http://localhost:3000/admin/login>. Mock users (fake):

| Email                    | Password            | Role        | Behaviour                                                                         |
| ------------------------ | ------------------- | ----------- | --------------------------------------------------------------------------------- |
| `recruiter@example.test` | `Recruiter-Pass-1`  | RECRUITER   | No 2FA, goes straight in                                                          |
| `admin@example.test`     | `Admin-Pass-12345`  | SUPER_ADMIN | TOTP already set up: code `123456`, or recovery code `ABCD-EFGH-2345-6723` (once) |
| `author@example.test`    | `Author-Pass-12345` | AUTHOR      | No 2FA, goes straight in                                                          |
| `reviewer@example.test`  | `Reviewer-Pass-12`  | REVIEWER    | Not enrolled: forced to enroll, confirm with `123456`                             |

Five wrong passwords for a known email lock it for 15 minutes (a sixth, correct attempt is refused). Wrong password, unknown email and locked account all get the same generic 401, and the login screen shows one message for all of them (FU-BE-22).
Reset link: `/admin/reset-password#token=mock-reset-token` (works once; `mock-expired-token` is always
refused). Invite link: `/admin/set-password#token=mock-invite-token`. The mock keeps its state
(failed logins, enrolled users, used tokens, the fake refresh "cookie") in one mock-only cookie,
`mock_auth_state`, so it survives reloads; clear cookies to reset. After a reset the mock still
accepts the original passwords above.

How it works:

- The access token lives in memory only (`src/lib/auth-token.ts`). Nothing is put in storage.
- `src/lib/auth-session.ts` does the silent refresh through the httpOnly cookie endpoint
  (`POST /v1/auth/refresh`, one call at a time). `AuthProvider` runs it on first load. The API client
  retries a staff request once after a 401 and a refresh; if the refresh fails the user is sent to
  `/admin/login?reason=expired&next=...`.
- The 2FA challenge token is held in `AuthProvider` state only; a reload goes back to login. No
  access token is issued until enrollment is confirmed, so no staff page opens before that (TC-003).
- Reset and invite links should carry the token in the fragment (`#token=...`) so it never reaches a
  server log; a `?token=` query is accepted and both are removed from the address bar on load. The
  page sends `Referrer-Policy: no-referrer` and `Cache-Control: no-store`, and the token is only
  held in component state until the one POST.
- MSW is started with `quiet: true` because it would otherwise print request bodies (passwords,
  codes, tokens) to the console.

Tests: `pnpm --filter @codeproctor/web test` (Vitest) and `pnpm --filter @codeproctor/web test:e2e`
(Playwright, needs Chromium: `npx playwright install chromium`). The e2e specs run axe-core on each
auth page.

## Security page (FR-102, mock mode)

`/admin/security` (user menu, "Security"), open to every staff role. Set up 2FA (QR, manual key, first
code, one-time recovery codes with download), Disable 2FA (hidden for SUPER_ADMIN and REVIEWER, who
get an explanation), and Regenerate recovery codes. Each action opens one shared dialog that first asks
for the current password and sends it as `currentPassword`. A wrong password is 403 `REAUTH_FAILED`
and shows "Password incorrect" in the dialog without signing out. Try it as `recruiter@example.test`
(`Recruiter-Pass-1`) or `author@example.test`: set up with code `123456`, then sign out and in again
to see the code prompt, and disable. `admin@example.test` and an enrolled reviewer see Regenerate only.
The mock keeps this state in the same `mock_auth_state` cookie. Code: `src/features/security`.
Playwright: `e2e/security.spec.ts`.

## Question bank (FE-04, FR-201..FR-205, mock mode)

Sign in as `author@example.test` (`Author-Pass-12345`) or the super admin, then open Questions.
`recruiter@example.test` can list questions (`question:read`) and open `/admin/questions/q-merge` for a
read-only summary: the mock answers the detail routes for anyone without `question:update` with an
allowlisted view (statement and visible samples only; reference solutions, hidden tests and answer
keys never reach other roles, TC-011, DL-32) and 403 on every other route.

| Route                                      | What it is                                                         |
| ------------------------------------------ | ------------------------------------------------------------------ |
| `/admin/questions`                         | List: filters (type, difficulty, status, tag) and search           |
| `/admin/questions/new`                     | Pick a type (coding, multiple choice, short answer), then the form |
| `/admin/questions/[id]`                    | Editor with tabs, Save, Validate, Publish                          |
| `/admin/questions/[id]/versions`           | Version history (FR-204)                                           |
| `/admin/questions/[id]/versions/[version]` | An older version, read-only                                        |

Coding editor tabs: Statement (Markdown, live preview, no raw HTML), Languages and starter code
(Monaco, self-hosted), Reference solution, Test cases (hidden toggle, weight), Variants (explicit
parameters per variant as JSON of strings and numbers, rendered preview, per-slot input and output
overrides, "Prefill from reference solution" that only proposes values until you accept them),
AI reference solutions (add, supersede, the organisation's real requirement from `GET /questions/ai-policy`, a refresh-due badge only if the API sends a refresh interval), Limits. Multiple
choice and short-answer questions have Statement and Answer.

Mock questions to try: **Merge intervals** (published, 2 versions, 2 variants, AI rows for every language),
**Rotate an array** (draft; its "Variant 2" fails validation, TC-012: fix the expected
output of slot 2, Save, Validate, add two AI solutions for Python, Publish), **Running average**
(validated draft, one AI assistant per language: add a second one to publish), **Cost of binary search** (MCQ, published), **Cost of a hash
lookup (draft)** (a complete MCQ draft: the real API publishes it, so Publish works), **Status code
for a created resource** (short-answer draft), **Legacy tokenizer (archived)**. The mock
"executor" behind the validate job is fake: a slot fails when its expected output is blank or starts
with `TODO`; tests make it end in an error or a timeout with
`setMockQuestionScenario({ executor: 'TIMEOUT' })`, and set the organisation's policy with
`setMockQuestionScenario({ aiMinAssistants: 3, aiRefreshDays: 30 })` from `src/mocks/question-handlers.ts`. State is in
memory; reload to reset.

Code map: `src/features/questions` (pages, editor, `tabs/`, `draft.ts` schemas and conversions,
`template.ts` Mustache `{{name}}`, `params.ts`, `gate.ts` publish gate), `src/mocks/question-*.ts`.
The question lives only in React Query and component state, never in a URL, storage or log.
Playwright: `e2e/question-bank.spec.ts`. The placeholder contract is tagged [ARC-02] in
`docs/followups/frontend.md`.

## Staff shell and Settings (FE-03, mock mode)

Sign in as above, then use the sidebar. Every route lives under `(staff)/admin/(app)`.

| Route                     | Who (permission, from the shared matrix) | What it is                                              |
| ------------------------- | ---------------------------------------- | ------------------------------------------------------- |
| `/admin`                  | any staff                                | Dashboard with links to your areas                      |
| `/admin/questions`        | `question:read`                          | Question bank (FE-04, see "Question bank" below)        |
| `/admin/tests`            | `test:read`                              | Placeholder (Step 5)                                    |
| `/admin/candidates`       | `invitation:create`, `candidate:erase`   | Candidate list and the erase action (NFR-05, D-19)      |
| `/admin/review`           | `review_queue:read`                      | Placeholder (Step 11)                                   |
| `/admin/live`             | `live:view`                              | Placeholder (Step 12)                                   |
| `/admin/reports`          | `report:read` (web-local)                | Placeholder (Step 14)                                   |
| `/admin/settings/users`   | `user:manage`                            | Invite, change role, deactivate, reactivate (FR-103)    |
| `/admin/settings/data`    | `org_settings:manage`                    | Retention days (FR-704), erasure hold (D-19)            |
| `/admin/settings/risk`    | `org_settings:manage`                    | Points, cap, band thresholds, per-type weights (FR-804) |
| `/admin/settings/consent` | `org_settings:manage`                    | Consent versions, current one, decline contact (D-17)   |

Roles: use the SUPER_ADMIN to see everything, RECRUITER for tests and candidates (no erase), AUTHOR
for questions only, REVIEWER for review, live and reports. A page opened by a role without access
shows an explanation; the mock API also answers 403 (the fake access token carries the role).

Code map: `src/features/staff` (shell, nav, breadcrumbs, permissions), `src/features/admin`
(Settings pages, queries, web-local zod schemas), `src/components/data-table` (the one table; every
list uses it), `src/mocks/admin-handlers.ts` (in-memory mock; reload the page to reset it).
The mock environment allows placeholder consent texts; to see the "approval required" state (pilot
and production), call `resetMockAdminState({ legalApprovalRequired: true })` as the Vitest tests do.
Playwright: `e2e/staff-shell.spec.ts`.

## Tests and invitations (FE-05, FR-301..FR-305)

Sign in as `recruiter@example.test` (`Recruiter-Pass-1`) or the super admin and open Tests. The test builder follows the real BE-06a API (`/v1/tests`): sections you can reorder with the mouse or the Move buttons, fixed questions picked from the published bank, random picks (tags, difficulty, type; one slot picks one question, so "3 random questions" is 3 slots), a STANDARD or STRICT proctoring profile with a plain explanation of what each records, a pass score, and the rule that section limits must fit the duration. A test that already has invitations is read-only: build a new one from it. Mock tests to try: **Backend engineer screening** (in use), **Frontend and algorithms (strict)**, **Random arrays round**. Code: `src/features/tests`, `src/mocks/test-handlers.ts`. Playwright: `e2e/test-builder.spec.ts`. What is real and what is not: `docs/followups/frontend.md`, section "frontend/fe-05".
