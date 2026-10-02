# Follow-ups

Non-blocking review findings. Only blockers stop a merge; should-fix items and nits are recorded here.

## frontend/step-1 (code-reviewer, verdict: MERGE, no blockers)

The reviewer read the code only and did not run build, lint, typecheck or tests; CI is the real check.

### Must-fix before Step 10 merges

Items 1, 3 and 8 below (mock start hang, Run/Finish error states, demo controls in the real bundle) are **must-fix before Step 10 merges**, since Step 10 builds on this screen.

### Should-fix

1. **[MUST-FIX before Step 10] Failed mock start hangs every API call.** `apps/web/src/components/providers/msw-init.tsx:10-13`, `apps/web/src/lib/api/client.ts:19`. If `worker.start()` rejects, `markMockingReady()` is never called and the screen sticks on "Loading your test…". Add a `.catch` that toasts and marks ready, and give `mockingReady` a timeout.
2. **No hard stop for mock mode in a production build.** `apps/web/src/lib/env.ts:3`, `apps/web/public/mockServiceWorker.js`. Fail the build in `next.config.ts` when `NODE_ENV === 'production'` and mocking is enabled (unless an explicit staging override is set); read the env var inline in `msw-init.tsx` so the mock import is dropped; copy the MSW worker only for dev.
3. **[MUST-FIX before Step 10] Run and Finish section error handling.** `apps/web/src/features/candidate-test/test-screen.tsx:172-200`. `run()` needs try/finally so `running` cannot stick. `finishSection()` must only set `finished` when the response is OK (ADR 0002: finishing is final).
4. **Autosave-on-run can skip the latest code (FR-504).** `apps/web/src/features/candidate-test/use-autosave.ts:30`. `flush()` should await an in-flight save, then save again if `latest` changed.
5. **Tests do not name TC IDs; failure paths untested.** `test-screen.test.tsx`, `logic.test.ts`, `use-autosave.test.tsx`. Name tests with TC-040/041/045/050 and cover the 429 path (`mocks/handlers.ts:96` ties the 429 to latency, so the Node test server never hits it; give it its own `cooldownMs`), paste blocking (TC-052), run network error and finish failure.
6. **Contract changes need architect sign-off.** Resolved in PR #4: the architect reviewed `packages/shared` and the placeholder OpenAPI, bounded the code and login inputs, and tracked the rest under ARC-02 below. Still open: the `Language` enum is duplicated in shared and the YAML (see the architect section).
9. **No client-side code length check.** `test-screen.tsx` does not validate against `runRequestSchema` (100,000 chars) before Run or the draft PUT, so an oversized submission gets a server rejection with no clear message.
7. **Permissions-Policy blocks the microphone.** `apps/web/next.config.ts:24`. `microphone=()` breaks FR-402, FR-607 and FR-701 later; use `microphone=(self)` or add a TODO tied to FE Steps 7 and 9.
8. **[MUST-FIX before Step 10] Demo-only controls ship in the real route bundle.** `apps/web/src/app/(candidate)/t/[token]/test/page.tsx:2`, `test-screen.tsx:144-152,422-431`. Alt+Shift+X "Simulate fullscreen exit", "Continue without fullscreen (demo only)" and the demo banner would bypass the lock in a real session. Load via `next/dynamic` only in mock mode or move into a demo wrapper before Step 10 builds on this screen.

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

### Architect review of shared contracts (frontend/step-1)

Verdict: approve after the blocker fixes below. Fixed on this branch: `RunRequest.code` and `DraftRequest.code` now carry `maxLength: 100000` in `apps/web/openapi/openapi.yaml`, matching the new `MAX_SOURCE_CODE_LENGTH` in `packages/shared/src/code-run.ts`; `loginRequestSchema` now caps email at 254 and password at 1024 characters (`MAX_EMAIL_LENGTH`, `MAX_PASSWORD_LENGTH`) so an anonymous caller cannot send an unbounded string to Argon2id (FR-101, NFR-04). Tests added in `apps/web/src/lib/forms.test.ts`. The items below are for ARC-02 (shared + API contract v0) and do not block this merge.

- **[ARC-02] Placeholder paths disagree with fsd.md §4.** The YAML uses `/v1/...` with server `http://localhost:4000`; fsd.md §4 says `/api/v1`. Run is `/candidate/questions/{id}/run` in the YAML but `/candidate/answers/:questionId/run` in fsd.md. `GET /candidate/session`, `PUT .../draft`, `GET /time` and `POST /candidate/sections/{id}/finish` are not in the fsd.md table, although ADR 0002 S-1/S-5 needs section finish and draft calls. ARC-02 must decide the final paths and add the missing rows to fsd.md §4 (or /docs/api-contract.md per ADR 0001 C-8); FE-01 then renames the mocks. Safe now only because the file is labelled placeholder and nothing on the backend reads it.
- **[ARC-02] Language list exists twice.** `codeLanguageSchema` (shared) and `components.schemas.Language` (YAML) both list python, javascript, java. ADR 0005 also names `AI_REFERENCE_LANGUAGES` with the same values. Make one shared constant the source (for example `CODE_LANGUAGES`, with `AI_REFERENCE_LANGUAGES` derived or equal), and either generate the YAML enum from it or add a parity test that loads the YAML and compares. Once NestJS publishes its code-first spec this disappears.
- **[ARC-02] `MAX_SOURCE_CODE_LENGTH = 100_000` is a new limit not yet in any doc.** Record it (with the submit and draft bodies, and `session_questions.final_code`) in the API contract, and note that zod `.max` counts UTF-16 code units while OpenAPI `maxLength` counts characters; non-BMP characters make the two differ slightly. The backend must also set a JSON body size limit consistent with it.
- **[ARC-02] `DraftRequest` has no shared zod schema** and is not a discriminated union: `kind: code` does not require `language`/`code`, `kind: mcq` does not require `selectedOptionId`. ADR 0007 makes `answer_spec` a discriminated union by question type; the draft and answer bodies should follow it (and cover short-answer, which the `kind` enum omits).
- **[ARC-02] `RunResult.outcome` is narrower than Judge0.** Missing at least memory-limit-exceeded and an internal/system error value (FR-503, TC-042..TC-044). Add them before BE wires Judge0, and move `RunResult` into packages/shared as zod.
- **[ARC-02] 429 shape.** The rate-limit response carries `retryAfterSeconds` in the body only; also send the standard `Retry-After` header and define one shared error envelope for 4xx (409 for out-of-section calls per ADR 0002 S-5 is not described).
- **[ARC-02] No security schemes in the YAML.** Candidate routes use the session token and staff routes the access token (ADR 0003); declare both so the generated client and docs show which routes need which.
- **[BE-02] `otpCodeSchema` is six digits only.** `/auth/2fa/verify` must also accept a recovery code (ADR 0003 §1), so BE-02 needs a separate `recoveryCodeSchema` or a union; do not reuse `otpCodeSchema` as the whole 2FA body.
- **[BE-02] Password reset schema must use `MAX_PASSWORD_LENGTH`** as its upper bound so a password that can be set can always be used to log in.
- **Nit:** `z.string().email()` is deprecated in zod 4 in favour of `z.email()`; switch when the auth schemas grow.
- **Nit:** `pnpm --filter @codeproctor/web gen:api` writes unformatted output while the committed `schema.d.ts` is prettier-formatted (and the file is in `.prettierignore`), so every regeneration shows a whole-file diff. Either append a prettier step to `gen:api` or commit the raw output.
- **Nit:** `packages/shared` resolves to `dist/` for `tsc` but to `src/` for vitest; a new export can pass tests and fail typecheck until `shared` is rebuilt. Consider `exports` with a source condition or TS project references in ARC-02.
