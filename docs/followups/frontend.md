# Follow-ups: Frontend track

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

