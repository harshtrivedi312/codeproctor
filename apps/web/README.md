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

| Route                    | What it is                                                           |
| ------------------------ | -------------------------------------------------------------------- |
| `/admin/login`           | Email + password (FR-101), locked-account message, "Forgot password" |
| `/admin/2fa`             | 6-digit code or recovery code (FR-102)                               |
| `/admin/2fa/enroll`      | Forced enrollment: QR code, manual key, confirm, recovery codes      |
| `/admin/forgot-password` | Same confirmation for any email (FR-107)                             |
| `/admin/reset-password`  | Set a new password from the emailed link (FR-107, D-22)              |
| `/admin/set-password`    | Same page for a staff invite (ADR 0003 section 4)                    |
| `/admin`                 | Dashboard inside the staff shell (see FE-03 below)                   |

Try it: `pnpm dev:web:mock`, then open <http://localhost:3000/admin/login>. Mock users (fake):

| Email                    | Password            | Role        | Behaviour                                                                         |
| ------------------------ | ------------------- | ----------- | --------------------------------------------------------------------------------- |
| `recruiter@example.test` | `Recruiter-Pass-1`  | RECRUITER   | No 2FA, goes straight in                                                          |
| `admin@example.test`     | `Admin-Pass-12345`  | SUPER_ADMIN | TOTP already set up: code `123456`, or recovery code `ABCD-EFGH-2345-6723` (once) |
| `author@example.test`    | `Author-Pass-12345` | AUTHOR      | No 2FA, goes straight in                                                          |
| `reviewer@example.test`  | `Reviewer-Pass-12`  | REVIEWER    | Not enrolled: forced to enroll, confirm with `123456`                             |

Five wrong passwords for a known email lock it for 15 minutes (a sixth, correct attempt is refused).
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

## Staff shell and Settings (FE-03, mock mode)

Sign in as above, then use the sidebar. Every route lives under `(staff)/admin/(app)`.

| Route                     | Who (permission, from the shared matrix) | What it is                                              |
| ------------------------- | ---------------------------------------- | ------------------------------------------------------- |
| `/admin`                  | any staff                                | Dashboard with links to your areas                      |
| `/admin/questions`        | `question:read`                          | Placeholder (Step 4)                                    |
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
