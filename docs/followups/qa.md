# QA follow-ups

Owner: qa-engineer. Written 2026-10-02 (QA-01). Items are tagged **must-fix** (blocks a gate), **should-fix** or **nit**. Section 2 lists changes the QA agent cannot make itself (outside its file scope) and needs the architecture hub or another owner to apply.

## 1. How to run the suite

| What | Command (repo root) | Notes |
| --- | --- | --- |
| Web unit and component tests | `pnpm --filter @codeproctor/web test` | Includes the TC-tagged files `qa-tc.test.tsx` and `qa-contract.test.ts` |
| Coverage per module (apps/web) | `pnpm --filter @codeproctor/qa run coverage:web` | v8 provider; prints a table per folder |
| Matrix check | `pnpm --filter @codeproctor/qa test` | Fails when test-cases.md and test-matrix.md disagree |
| Playwright and axe | `pnpm --filter @codeproctor/web build` with `NEXT_PUBLIC_API_MOCKING=enabled`, then `pnpm --filter @codeproctor/qa run test:e2e` | Serves the production build with `next start` on port 3100 (never the dev server). First time: `pnpm --filter @codeproctor/qa exec playwright install chromium` |
| API integration tests (Testcontainers) | `pnpm --filter @codeproctor/api exec node --experimental-vm-modules node_modules/jest/bin/jest.js -c test/jest.integration.config.js --runInBand --forceExit` | Needs Docker. Throwaway Postgres 16 and Redis per file; the app runs as `app_user`; never touches the dev stack. Add `--json --outputFile=<file>` for the gate |
| Proctor SDK tests | `pnpm --filter @codeproctor/proctor-sdk test` | QA suite: `packages/proctor-sdk/src/qa/qa-tc.test.ts` |
| Worker tests | `cd apps/worker && python3.12 -m venv .venv && .venv/bin/pip install -e '.[dev]' && .venv/bin/python -m pytest --junitxml=<file>` | QA file: `tests/test_qa_tc.py`. Test names write the ID as `TC_073`; the gate reads it as TC-073 |
| Shared contract tests | `pnpm --filter @codeproctor/shared test` | node:test; for the gate add `--test-reporter=junit --test-reporter-destination=<file>` |
| P1 gate | `pnpm --filter @codeproctor/qa run gate <report.json\|report.xml>...` | Used by .github/workflows/qa.yml. `--strict` also fails P1 cases with an automated level and no passing test; turn it on when BE-15A/QA-01B finish |
| Load and ZAP | Actions tab, workflow "QA", Run workflow, pick the scan and give the staging URL | Staging only; needs the `K6_CANDIDATE_TOKENS` secret for k6 |

## 2. Changes needed outside QA's file scope (architecture hub, root files)

1. **must-fix (when the API lands):** the root `pnpm test` runs `pnpm -r test`, which already includes `@codeproctor/qa` (its `test` script is the matrix check). Nothing to change now. When apps/api gets Testcontainers tests, add a CI step (or let QA's workflow do it) that has Docker available; the GitHub-hosted runner has it.
2. **should-fix:** make `QA / P1 gate` a required status check on `main` in branch protection (repository settings; human or architecture hub). Without that the gate does not block a merge.
3. **should-fix:** `.github/workflows/ci.yml` and `.github/workflows/qa.yml` both install and build. If CI minutes matter, merge the two later, or make QA depend on the CI artifact. Left separate on purpose so the QA gate can be edited without touching the baseline CI approved in D-25.
4. **should-fix (frontend-engineer):** vitest in apps/web has no coverage provider. QA installs `@vitest/coverage-v8` in packages/qa and points it at apps/web (`--root`). If the frontend wants `pnpm test:coverage` in its own package, move the dev dependency there.
5. **should-fix (frontend-engineer):** apps/web's `vitest.config.mts` and `playwright` dependency: apps/web has `@playwright/test` as a devDependency but no Playwright config. QA owns the e2e config in packages/qa, so the web dependency can be removed to avoid two versions drifting.
6. **should-fix (architect):** an `apps/api` test layout is needed for the planned integration tests: QA assumes `apps/api/test/integration/tc-NNN.int.test.ts` and `apps/api/src/**/*.unit.test.ts` with Vitest (the DB-05 brief says "unit tests" without a runner). Confirm or change the paths in the matrix.
7. **CLOSED 2026-10-05 (QA-02):** TC-008, TC-072 and TC-094 need Testcontainers PostgreSQL 16 with `prisma migrate deploy` (never `db push`). DB-03 migrations are not merged yet, so no DB test could be written. Please expose a helper (for example `apps/api/test/support/postgres.ts`) that starts the container, applies migrations and returns a client as `app_user`, so every integration test shares one setup.
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

- Testcontainers integration tests: done for staff auth, audit append-only and seed (QA-02, section 7). Still blocked: every TC that needs BE-03 to BE-14 routes.
- Playwright tests against the real candidate flow: FE-09 and BE-07 not merged.
- TC-093 ZAP and TC-090/091 k6 runs: no staging environment (DEP-01).
- QA 2 (red team, /docs/red-team-report.md): needs staging and the proctor SDK. Not started.

## 6. Code-reviewer round on PR #7

### 6.1 Defect

- **FU-QA-01, should-fix (must-fix before TC-047 is verified), owner frontend-engineer:** TC-047 / FR-505 client clock. Reproduction: open the candidate test screen, let it load, then move the OS clock forward one hour (in the test, `Date.now()` is advanced by 1 hour without a re-sync). Expected: the displayed countdown is unchanged, because the server deadline is unchanged. Actual: `useServerClock` in `apps/web/src/features/candidate-test/use-clock.ts` reads `/v1/time` once (`staleTime: Infinity`) and never re-syncs, so the countdown drops by one hour and the editor locks as "time is up". The server must stay the authority (BE-07 test), but the client should re-sync the offset, for example from each heartbeat or run response. Test: `qa-tc.test.tsx`, "TC-047 KNOWN DEFECT", written with `it.fails` so CI stays green; change to `it` when fixed. The matrix row says NOT PASSING and the P1 gate prints "KNOWN DEFECT open".

### 6.2 Done in this round

Staging allowlist (`QA_STAGING_HOSTS`) on the ZAP and k6 jobs; `environment: staging` on k6; header comment corrected; ZAP and k6 images pinned by digest; k6 TC-090 tags endpoints so p95 under 300 ms excludes `/run`, 429 on a run is now an error (one run a minute per candidate), paths labelled as placeholders, heartbeat every 10 s; manual scripts: gaze threshold, TC-063 step 4 pending the architect, TC-055, TC-056 and TC-036 timings marked as observations; TC-041 listener removed in `finally`.

Setup needed from a human: create the GitHub environment `staging` (with the secret `K6_CANDIDATE_TOKENS`) and the repository variable `QA_STAGING_HOSTS` (comma separated staging hostnames).

### 6.3 Open items

| ID | Type | Owner | Item |
| --- | --- | --- | --- |
| FU-QA-02 | should-fix | architect | The web demo uses `POST /v1/candidate/questions/{questionId}/run` (apps/web/openapi/openapi.yaml), while the FSD section 4 run path is different. Decide the path in the API contract (ARC-02), then update the web mocks and the k6 scripts. |
| FU-QA-03 | nit | qa-engineer | `qa-tc.test.tsx` has two imports from `@testing-library/react` (one for `render`, one for `act, renderHook`); merge them. |
| FU-QA-04 | nit | qa-engineer | TC-046 is tested twice in the web suite (QA test and the older `logic.test.ts` helper test). Keep the QA one, drop the duplicate when the frontend next touches `logic.test.ts`. |
| FU-QA-05 | nit | qa-engineer | TC-040 UI test only checks the results text and that no "hidden" words appear; strengthen it to assert each sample test row (name, input, expected, actual). |
| FU-QA-06 | nit | qa-engineer | TC-041 e2e clicks with `force: true` after the first run and relies on the 5 s cooldown; the "e2e runs wait" for the first run result is a fixed `findByText`. Use an explicit wait for the run to finish before counting requests. |
| FU-QA-07 | nit | qa-engineer | The P1 gate prints "passed (N tests; partial coverage is listed in docs/test-matrix.md)" for partial coverage. Print "partial, see matrix" and read the status column so a partial pass cannot be mistaken for verified. |
| FU-QA-08 | nit | qa-engineer | `--strict` mode: date-stamp the rule in the matrix, and decide when it is switched on (BE-15A/QA-01B). |
| FU-QA-09 (CLOSED 2026-10-05: gate reads pytest JUnit, matrix check scans worker tests) | nit | qa-engineer | The gate scans only `*.test.ts`, `*.test.tsx`, `*.spec.ts`, `*.test.mjs` and `*.js`; add `*.py` so TC IDs in `apps/worker` tests (pytest) are checked and reported. |
| FU-QA-10 | nit | qa-engineer | TC-045 is listed at level e2e in the matrix but the passing tests are hook-level unit tests. Re-level to unit plus e2e once BE-11 and FE-10 give a real reopen test. |
| FU-QA-11 | nit | qa-engineer | The k6 comment in TC-091 says "stay under one run per 5 s": it sleeps 5.5 s; keep the number and the comment in step. |
| FU-QA-12 | nit | qa-engineer | Playwright has only a Chromium project. Add a Firefox project for TC-031 (unsupported browser) when FE-09 merges. |

## 7. QA-02 round (2026-10-05): staff auth, audit, seed, SDK, worker

Added: `apps/api/test/` (harness, Jest config, 9 integration files), `packages/proctor-sdk/src/qa/qa-tc.test.ts`, `apps/worker/tests/test_qa_tc.py`, `packages/qa/e2e/tc-004-rbac.spec.ts`, a `web-staff` Playwright project that runs the frontend's `apps/web/e2e` specs against the production build, JUnit and Jest support in the gate, and the new CI steps in `.github/workflows/qa.yml` (every test step runs even after a failure, then the gate prints one line per P1 case and fails the job on any failing P1 test). The matrix check now also fails when a Verified or Partial row lists a test file that does not exist.

### 7.1 Defects

| ID | Severity | Owner | Defect |
| --- | --- | --- | --- |
| QA-D-01 | medium | proctor-sdk-engineer (architect to confirm the intended event shape) | TC-050 expects "FULLSCREEN_EXIT logged with duration". `FullscreenMonitor` emits FULLSCREEN_EXIT with no duration and puts the duration on FULLSCREEN_RESTORED. A candidate who never returns leaves no duration at all. Repro: `packages/proctor-sdk/src/qa/qa-tc.test.ts`, test "TC-050 KNOWN DEFECT QA-D-01" (`it.fails`). Expected: the exit is recorded with its duration (for example the SDK also emits a closing event or the server computes it, and test-cases.md says which). Actual: EXIT has no `durationMs`. Switch the test to `it` when decided |
| QA-D-02 | medium (blocks every browser-to-API run) | frontend-engineer (config) and backend-engineer (prefix) | The web client calls `/v1/auth/*` on `NEXT_PUBLIC_API_URL`, whose default and `.env.example` value is `http://localhost:4000`. The API serves `/api/v1/*` only, so `POST /v1/auth/login` is 404. Repro: `apps/api/test/integration/web-contract.int.test.ts`. Expected: the example value and the web default end in `/api`, or the web paths carry it |
| QA-D-03 | low | frontend-engineer, architect | `apps/web/openapi/openapi.yaml` declares the error body as `{ code, message }` (and the MSW mocks return it). The real API returns RFC 7807 problem JSON (`type, title, status, detail, instance, traceId`), per ADR 0001 C-9. The web reads only HTTP status today, so nothing breaks, but the mocks hide the real shape. Update the schema and mocks to the problem shape before any screen reads `code` |
| FU-QA-01 | should-fix | frontend-engineer | Still open: TC-047 client clock (see 6.1). The `it.fails` test still passes as expected, so the defect is not fixed and the marker stays |

### 7.2 Observations (not defects)

1. The pre-existing API tests (`apps/api/src/**/*.e2e-spec.ts`) run the app as the container superuser, so the `app_user` grants are never exercised. The QA harness runs the app as `app_user`; all auth flows pass that way, so the grants are sufficient for BE-02.
2. `apps/worker` has no `test` script, so root `pnpm test` and ci.yml never run its 136 pytest tests; only the QA workflow does now. Architect: add `"test"` to `apps/worker/package.json` (python3.12 -m pytest) so CI covers it too.
3. `apps/api` has no `test:integration` script and its tsconfig includes only `src`; `apps/api/test/tsconfig.json` and `test/jest.integration.config.js` are QA's. Backend-engineer: optionally add a `test:integration` script that runs the command in section 1.
4. `apps/api/src/test/containers.ts` (backend) is reused by the QA harness. The DB-engineer's wish for `apps/api/test/support/postgres.ts` (section 2 item 7) is met by `apps/api/test/support/harness.ts`; it applies the migration SQL files directly, not `prisma migrate deploy`, so `_prisma_migrations` is absent in tests.
5. The mock auth state in the web app lives in a cookie, so `web-staff` specs are independent per browser context. They ran 22 of 22 in the production build, not only in `next dev`.
6. TC-075 is implemented in `apps/worker/src/worker/risk.py` (with the constants in packages/shared), not in `apps/api/src/risk`. The matrix points at the worker tests.
7. Seeded `TC-xxx` naming: the `web` settings tests tag the admin consent page with TC-096; that is the admin side only, so TC-096 stays Planned.

### 7.3 Blocked, by step

| Blocked TCs | Waiting for |
| --- | --- |
| TC-008 | DB-05 (org scope), BE-03 (guards), BE-13 (review routes) |
| TC-004 (403 on PATCH /questions/:id), TC-006 (review audit) | BE-03, BE-04, BE-13 |
| TC-010..013, TC-011 (endpoint), TC-012 | BE-04, BE-05 |
| TC-020..024 | BE-06, BE-07 |
| TC-030..033, TC-095, TC-096, TC-007, TC-097 | BE-07, BE-08, FE-09 |
| TC-040..048, TC-041 (server) | BE-05, BE-11, FE-10 (Judge0 on Linux x86 for TC-042..044) |
| TC-065 (server side), TC-062/063/070 end to end | BE-09, BE-10, FE-10, FE-11 |
| TC-071, TC-072, TC-094 | BE-09, DB-06 |
| TC-076, TC-074 (API), TC-078..081 | BE-12, BE-13, BE-14 |
| TC-090, TC-091, TC-093 | staging (DEP-01), BE-15B |
| Manual: TC-054..056, 058, 059, 034, 036, 060, 061, 064 | a person with the right hardware; scripts in docs/manual-tests.md |

### 7.4 Code-reviewer round on PR #28 (2026-10-05)

Fixed in QA's own files: the gate now fails a row marked Verified that has no run (all modes); a KNOWN DEFECT test that fails counts as a failure (the defect was fixed or the test broke); TC IDs are read from the leaf test title and fall back to the full title only when the leaf names none; TC-001, TC-003 and TC-098 are relabelled "Verified (API); UI mocked, pending QA-D-02" and TC-003 is level integration; the TC-065 rogue-detector test asserts the hook exists; the misleading TC-030 tag was dropped from the SDK consent test; the RBAC e2e waits for the page heading before asserting there is no denial; TC-005 now has a real logout test; the harness stops the containers and closes the app if `boot` fails half way. Review item 5 was not spelled out in the message I received and is not addressed; please repeat it.

Backend-owned nits (backend-engineer):

1. `apps/api/src/test/containers.ts` pulls `postgres:16` and `redis:8.8` by tag; pin them by digest like the QA workflow images.
2. The config module reads `.env` through `envFilePath`; in tests it should use `ignoreEnvFile` so a developer's `.env` can never leak into an integration run.
3. Add a `test:integration` script (see 7.2 item 3).

