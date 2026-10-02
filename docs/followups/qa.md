# QA follow-ups

Owner: qa-engineer. Written 2026-10-02 (QA-01). Items are tagged **must-fix** (blocks a gate), **should-fix** or **nit**. Section 2 lists changes the QA agent cannot make itself (outside its file scope) and needs the architecture hub or another owner to apply.

## 1. How to run the suite

| What | Command (repo root) | Notes |
| --- | --- | --- |
| Web unit and component tests | `pnpm --filter @codeproctor/web test` | Includes the TC-tagged files `qa-tc.test.tsx` and `qa-contract.test.ts` |
| Coverage per module (apps/web) | `pnpm --filter @codeproctor/qa run coverage:web` | v8 provider; prints a table per folder |
| Matrix check | `pnpm --filter @codeproctor/qa test` | Fails when test-cases.md and test-matrix.md disagree |
| Playwright and axe | `pnpm --filter @codeproctor/web build` with `NEXT_PUBLIC_API_MOCKING=enabled`, then `pnpm --filter @codeproctor/qa run test:e2e` | Serves the production build with `next start` on port 3100 (never the dev server). First time: `pnpm --filter @codeproctor/qa exec playwright install chromium` |
| P1 gate | `pnpm --filter @codeproctor/qa run gate <report.json>...` | Used by .github/workflows/qa.yml. `--strict` also fails P1 cases with an automated level and no passing test; turn it on when BE-15A/QA-01B finish |
| Load and ZAP | Actions tab, workflow "QA", Run workflow, pick the scan and give the staging URL | Staging only; needs the `K6_CANDIDATE_TOKENS` secret for k6 |

## 2. Changes needed outside QA's file scope (architecture hub, root files)

1. **must-fix (when the API lands):** the root `pnpm test` runs `pnpm -r test`, which already includes `@codeproctor/qa` (its `test` script is the matrix check). Nothing to change now. When apps/api gets Testcontainers tests, add a CI step (or let QA's workflow do it) that has Docker available; the GitHub-hosted runner has it.
2. **should-fix:** make `QA / P1 gate` a required status check on `main` in branch protection (repository settings; human or architecture hub). Without that the gate does not block a merge.
3. **should-fix:** `.github/workflows/ci.yml` and `.github/workflows/qa.yml` both install and build. If CI minutes matter, merge the two later, or make QA depend on the CI artifact. Left separate on purpose so the QA gate can be edited without touching the baseline CI approved in D-25.
4. **should-fix (frontend-engineer):** vitest in apps/web has no coverage provider. QA installs `@vitest/coverage-v8` in packages/qa and points it at apps/web (`--root`). If the frontend wants `pnpm test:coverage` in its own package, move the dev dependency there.
5. **should-fix (frontend-engineer):** apps/web's `vitest.config.mts` and `playwright` dependency: apps/web has `@playwright/test` as a devDependency but no Playwright config. QA owns the e2e config in packages/qa, so the web dependency can be removed to avoid two versions drifting.
6. **should-fix (architect):** an `apps/api` test layout is needed for the planned integration tests: QA assumes `apps/api/test/integration/tc-NNN.int.test.ts` and `apps/api/src/**/*.unit.test.ts` with Vitest (the DB-05 brief says "unit tests" without a runner). Confirm or change the paths in the matrix.
7. **should-fix (db-engineer):** TC-008, TC-072 and TC-094 need Testcontainers PostgreSQL 16 with `prisma migrate deploy` (never `db push`). DB-03 migrations are not merged yet, so no DB test could be written. Please expose a helper (for example `apps/api/test/support/postgres.ts`) that starts the container, applies migrations and returns a client as `app_user`, so every integration test shares one setup.
8. **nit:** Node 22 is installed on the QA machine while `engines` asks for Node 24; the local runs above passed on Node 22. CI uses Node 24 from `.nvmrc`.

## 3. Defects and observations from the first run

No product defect was confirmed this round: the merged code is a mocked demo, and the server side does not exist yet. Observations:

1. **should-fix, frontend-engineer (candidate test screen):** the demo, the mocked `/run` handler and the UI send one request per 5 seconds, consistent with FR-502, but the client-side rate limit is only a UI guard (aria-disabled). TC-041 must also be tested against the real API (a second request inside 5 seconds must get 429 from the server). Tracked in the matrix as partial.
2. **should-fix, frontend-engineer:** at time zero the demo only locks the editor and says "In the real test your latest saved work is submitted automatically" (FR-505, TC-046). Auto-submit is not wired yet; expected, since FE-10 is not merged. Re-test TC-046 end to end after FE-10 and BE-11.
3. **should-fix, frontend-engineer:** autosave runs on a 10 s interval only (and on Run and Finish). There is no flush on `pagehide` or `visibilitychange`, so code typed in the last seconds before the candidate closes the browser can be lost. TC-045 says "Type, wait 10 s, close browser" so the case passes as written, but FR-504 "code restored within 10 s of last edit" is satisfied only by the interval. Suggest `navigator.sendBeacon` or a keepalive fetch on `pagehide`.
4. **nit, frontend-engineer:** the `jsdom` axe run cannot check the landmark rule (no layout). QA disables the rule in jsdom only; Playwright axe covers the real page and passes.
5. **nit, qa-engineer:** the first Playwright run after a fresh `next start` failed 4 of 4 once (button never appeared within 30 s) and could not be reproduced in 9 later runs. A `globalSetup` warm-up was added and CI retries once. If it returns, suspect the MSW service worker registering after the first fetch on a cold page (the worker and `mockingReady` race on first load); report to frontend-engineer.

## 4. Gaps in the test cases themselves (for the architect and project-manager)

1. **should-fix:** TC-054, TC-055 and TC-056 are P1 but cannot be automated (browser share picker, second monitor), so they depend on the manual scripts. The pilot gate "all 51 P1 green" in build-plan M5 needs a rule for manual P1 cases: suggested "signed manual run record per build, kept in the PR".
2. **should-fix:** TC-057 to TC-059 (P1) can be automated with Chromium's `--use-file-for-fake-video-capture` and a recorded clip. Planned as QA-01B work once FE-08 merges. Needs the volunteer clips (B-05 item 3) or synthetic faces.
3. **should-fix:** TC-090 and TC-091 assume the event endpoint accepts k6 requests. TC-065 requires HMAC signing on every batch; the k6 scripts need a signer (k6 has `k6/crypto` HMAC) or a load-test mode. Needs the signing rule from ARC-03 and the endpoint paths from the API contract; the paths in the scripts are guesses from the FSD and must be corrected after BE-10 and BE-11.
4. **nit:** TC-031 asks for Firefox; Playwright can run a Firefox project, but the unsupported-browser check must work by user agent and feature detection. Both should be tested.
5. **nit:** TC-063 says "Disable network 45 s" while DISCONNECTED is logged after 60 s without heartbeat (FR-609), so a 45 s drop should produce no DISCONNECTED event at all. The expected result "DISCONNECTED/RECONNECTED" does not match for 45 s. Either the drop should be longer than 60 s or the expected result should say "no event for 45 s, DISCONNECTED/RECONNECTED for 90 s". The manual script tests both.
6. **nit:** TC-041 says "3 times within 2 s: only first executes" which matches the 5 s limit; the UI test checks it.

## 5. Not done in QA-01 (blocked)

- Testcontainers integration tests for every server-side TC: apps/api has only a Prisma client factory, and DB-03 migrations do not exist.
- Playwright tests against the real candidate flow: FE-09 and BE-07 not merged.
- TC-093 ZAP and TC-090/091 k6 runs: no staging environment (DEP-01).
- QA 2 (red team, /docs/red-team-report.md): needs staging and the proctor SDK. Not started.
