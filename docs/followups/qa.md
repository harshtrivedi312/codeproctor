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
| QA-D-01 (decided by design 2026-10-05, pending ADR 0013 acceptance; see section 8) | medium | proctor-sdk-engineer (architect to confirm the intended event shape) | TC-050 expects "FULLSCREEN_EXIT logged with duration". `FullscreenMonitor` emits FULLSCREEN_EXIT with no duration and puts the duration on FULLSCREEN_RESTORED. A candidate who never returns leaves no duration at all. Repro: `packages/proctor-sdk/src/qa/qa-tc.test.ts`, test "TC-050 KNOWN DEFECT QA-D-01" (`it.fails`). Expected: the exit is recorded with its duration (for example the SDK also emits a closing event or the server computes it, and test-cases.md says which). Actual: EXIT has no `durationMs`. Switch the test to `it` when decided |
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

### 7.5 TC-063 CI flake (2026-10-05)

Root cause was in the test, not the SDK: it assumed one batch per paste and waited a fixed amount of fake time. On a slow host a slow flush lets the next paste join the pending batch (8 batches, not 9), and IndexedDB needs real turns. The test now sends the browser `online` event (the documented reconnect trigger), polls in real time with a 30 s deadline while advancing fake time, counts delivered events instead of batches, and asserts seq runs 0..n-1 in order. It passed 30 of 30 runs with 16 busy loops and `--pool=forks`, where it failed about 1 in 3 before.

Observation for proctor-sdk-engineer (low, not a data-loss defect; NFR-08 holds): `EventQueue.retryNow()` does nothing while a drain is already running. If the browser `online` event arrives during a send that is about to fail, the next attempt waits for the exponential backoff (up to 30 s) instead of starting at once. Suggested: remember that a retry was requested and run another drain pass when the current one ends in RETRY.


### 7.6 TC-008 evidence is outside the P1 gate's inputs (FU-DB-59, FU-DB-81, 2026-10-05)

- **should-fix (qa-engineer):** the TC-008 tests live in `apps/api/src/database/tc-008-org-isolation.spec.ts` (DB-05, PR #30), run by `apps/api/jest.config.js`. The P1 gate in `.github/workflows/qa.yml` reads only the report from `test/jest.integration.config.js`, so it does not see the TC-008 results. The test-matrix path is fixed (architecture hub, 2026-10-05); CI is not changed here. QA decides whether to add the API unit Jest report to the gate inputs or to move the TC-008 run into the integration config.

## Architecture hub: TC-050 follow-through (ADR 0013 section 5.9, PR #39)

- [ ] Rewrite `TC-050 KNOWN DEFECT QA-D-01` (`it.fails` in `packages/proctor-sdk/src/qa/qa-tc.test.ts`) as plain tests: FULLSCREEN_EXIT has no `durationMs`, FULLSCREEN_RESTORED has one.
- [ ] Add the BE-10 API test for the server-filled `duration_ms`, including the close at session end.
- [ ] Remove TC-050 from the known-defect list in `docs/test-matrix.md` (line 15) once both tests pass.
- [ ] TC-063: the test drops the network for 45 s but expects DISCONNECTED, while FR-609 logs it only after 60 s (ADR 0013 Q13).
- [ ] Owner: qa-engineer. Section gate (ADR 0013 CS-4.6): read, Run, draft, answer and submit outside the open section get 409; fail-closed with Redis flushed; after the section deadline and after the session deadline, with the close job delayed, draft and submit get 409 and a late SUBMIT is never graded; writes during a PROCTOR pause get 409 `SESSION_PAUSED`.
- [ ] Owner: qa-engineer. The re-check matrix per owner decision C-34 (waiver; face detectors off; both; neither): refused with 409 `IDENTITY_CHECK_WAIVED` (waiver) or `DETECTOR_DISABLED` (face detectors off) when either is set, allowed only when neither is.
- [ ] Owner: qa-engineer. Face tier per C-27 and C-35: ID images, selfies and sealed mismatch frames are deleted at face clock + LEAST(`retention_days`, 90), where face clock = COALESCE(`submitted_at`, the latest identity capture, the terminal transition time, `created_at`), even while a review hold is open; `retention_days` = 30 deletes them at 30 days.
- [ ] Owner: qa-engineer. Retention markers (ADR 0004 section 9): a marker is written only after a complete listing, no DeleteObjects errors and an empty re-listing; erasure writes no markers, fences a live session first, and its re-run deletes a late PUT; R-10 deletes the whole session prefix.
- [ ] Owner: qa-engineer. Tiered retention clocks (face, media, results, consent), see row (c) in section 9.
- [ ] Owner: qa-engineer. Close-section and grading order: `grade-session` runs only after every `close-section` child completes; the graded row is the SUBMIT whose `created_at` equals the section's `ended_at` (two matches fail loudly, none scores 0); a failed `close-section` can be re-enqueued; closing the last section moves the session to SUBMITTED.
- [ ] Owner: qa-engineer. Per-section pause credit (ADR 0013 effectiveDeadline): (1) the deadline variant closes section k while PAUSED past the cap, and k+1 gets no credit for the earlier pause time; (2) a section-finish clicked during a PROCTOR pause does not give k+1 extra time.
- [ ] Owner: qa-engineer. Erasure serialisation: a `close-section` run interleaved with erasure does not re-insert code (guardLive); a fence after a status read is still seen.
- [ ] Owner: qa-engineer. A session past its deadline with a lost auto-submit job is submitted by the reconciler.
- [ ] Owner: qa-engineer. DeviceInfoService fencing: concurrent writers lose no update; a skip sets resync and the next heartbeat asks for full capabilities; the first write fences on `{}`.
- [ ] Owner: qa-engineer. `detachForSessionJob` refusals: in any scope, with a raw-SQL hatch open, with a grant present; a discovery processor cannot run a session handler inline.
- [ ] Owner: qa-engineer. Section finished by the button: the latest saved code is graded (close-section is the only writer of `ended_at`, ADR 0013 5.11).
- [ ] Owner: qa-engineer. A PROCTOR pause spanning a section deadline does not close the section, which closes at the credited deadline + 5 s (TC-079, ADR 0002 P-3/P-4).
- [ ] Owner: qa-engineer. A failed `close-section` child does not strand `grade-session` (`failParentOnFailure`), and the grading reconciler re-creates a lost flow.
- [ ] Owner: qa-engineer. A session with no work at all is graded with score 0 and is not mistaken for one past R-10.
- [ ] Owner: qa-engineer. DL-17: writes during a PROCTOR, SCREEN_SHARE_STOPPED or SIDE_CAMERA_LOST pause get 409 `SESSION_PAUSED` (an unmodified client cannot keep editing with the share stopped; against a modified client, recording-gap detection applies); FULLSCREEN_EXIT does not block autosave; the client keeps the draft and saves it after resume.
- [ ] Owner: qa-engineer. close-section concurrency: finish and deadline variants run together produce one close, one snapshot set and one next-section opening; the final variant never opens a section; a retry after a failed post-commit enqueue still enqueues the next deadline job.
- [ ] Owner: qa-engineer. effectiveDeadline: during an active PROCTOR pause the gate, the heartbeat deadline and the deadline jobs use the credited deadline; the deadline job re-delays to a future time (no hot loop); past the cap the section closes and the session auto-submits even while PAUSED.
- [ ] Owner: qa-engineer. Grants: a query detached from `fn` (not awaited) after `fn` resolves throws; a grant without `ids` cannot be created.
- [ ] Owner: qa-engineer. Erasure of a live session starts no grading, analysis, webhook or reconciler run.
- [ ] Owner: qa-engineer. Assign TC IDs to the ADR 0013 CS-4.8 suite (DMMF model sweep, the six relation vectors, column allowlists including where/orderBy/groupBy, write-column refusals, SERVER-event invisibility, injected filters, actor crossing, raw SQL refusal) and to the cross-candidate route suite (5.10), then add them to test-cases.md and test-matrix.md.

## 8. QA step 2b (2026-10-05): BE-02 security hardening contract changes

Branch `qa/step-2b`, on top of backend PR #26. API integration suite: 9 suites, 77 passed, 3 todo, 0 failed (was 11 failing against the new contract). API unit suite 124 passed; lint and typecheck clean; the P1 gate over all reports shows no failing P1 case.

### 8.1 What changed in the tests

1. `tc-098`: forgot-password answers the same 202 and mails after the response. The harness now exposes `h.settle()` (calls `AuthService.settleDeferred()`), and the test helper waits for it before reading `h.mails`. The two-device session test signs the second device in with a recovery code, because a TOTP code is now accepted once per time step.
2. `tc-003`: challenges are single-use, so the recovery-code test logs in again for a fresh challenge; new tests for a spent challenge (401) and a challenge issued before a password change (401). Setup routes send `currentPassword` (missing 400; wrong or locked is 403 REAUTH_FAILED with identical bodies, no lockedUntil or 423; updated for the final BE-02 contract). New tests: /2fa/disable (403 TWO_FACTOR_REQUIRED_FOR_ROLE for SUPER_ADMIN and REVIEWER after the password check, 409 when off, audit row), /2fa/recovery-codes/regenerate, SUPER_ADMIN /2fa/reset/:userId (403 other roles, 404 other org or unknown, 400 self or non-UUID, sessions revoked, audit row), Cache-Control no-store on login, verify, refresh, enrol, setup and regenerate, locked account (401 login, 400 code), 503 on /2fa/verify with Redis stopped.
3. `tc-004`: the 200 at ~78 failed only because setup/start now needs `currentPassword`; fixed. Added per-request guard coverage (deactivated, role change, org change, password change, challenge token is not a session). A pending-invite user cannot be built for the guard test: the `users_check` constraint forbids a null password on an active user, so that path is covered by the database.
4. `test/support/harness.ts`: `settle()`, `signIn()` and `signInWithTotp()` helpers.

### 8.2 Gaps

- 503 on `/2fa/enroll/confirm` and "the challenge stays usable after Redis returns" are not tested. Testcontainers cannot restart Redis on the same host port, and `docker pause` makes the client hang with no command timeout. The verify 503 test stops Redis for good and is the last test in `tc-003.int.test.ts`; keep it last. A proper test needs a Redis client override or a TCP proxy in the harness.
- Challenge single-use under concurrency (two parallel verifies, one wins) is not tested.
- TC-004 stays Partial (question and review routes still do not exist).

### 8.3 Defects

None confirmed. Observation for backend-engineer (nit): the Redis client has no command timeout, so an unreachable but not closed Redis (paused container, network black hole) holds a request open until the HTTP layer gives up instead of returning the documented 503.

## 8. QA-03 round (2026-10-05): BE-03 acceptance tests staged

### 8.1 What was added

- `apps/api/test/support/be03-routes.ts`: the single list of BE-03 (and BE-13 review) routes with permission, audit action, sample body and fixtures, plus the switches `BE03_READY` and `BE13_READY` (also `BE03_READY=1` / `BE13_READY=1` in the environment for a trial run). Every guessed name is marked `// ASSUMED`. To swap in Backend's route registry, edit this file only.
- `apps/api/test/integration/tc-004-rbac.int.test.ts`, `tc-006-audit.int.test.ts`, `tc-002-unlock.int.test.ts` (P-03: alert on lock, audited admin unlock). Titles carry `[BE-03 pending]` or `[BE-13 pending]`; they are skipped until the switch is on. A few matrix-only checks run now.
- `apps/api/test/support/be03-helpers.ts`: minimal local `actor` (create and sign in, with TOTP) and `call`. The fuller settle/signIn/expectReauthFailed helpers are on qa/step-2b (pending merge into backend PR #26); the rebase after #26 should dedupe.
- The route list imports the permission matrix by relative path (`packages/shared/src/permissions`) because apps/api does not depend on `@codeproctor/shared`; if Backend adds that dependency, switch to the package import.
- A trial run with `BE03_READY=1` against today's API ran the setup (users, sign-in with TOTP, org B) and failed only on the missing routes (404), so the bodies exercise real code paths.

### 8.2 Assumptions to confirm with Backend (all marked ASSUMED)

Routes: GET /users, POST /users/invite, PATCH /users/:id/role, POST /users/:id/deactivate, POST /users/:id/unlock; permission `user:manage` (SUPER_ADMIN only) for all. Audit actions: USER_INVITED, USER_ROLE_CHANGED, USER_DEACTIVATED, USER_UNLOCKED (entity type `user`, entity id the target user); review: REVIEW_SESSION_VIEWED (session), REVIEW_FLAG_DECIDED (proctor_event, flag id = event id), REVIEW_VERDICT_SET (session). User list and review queue are not audited. A refused call (401, 403, 404, 400) writes no audit row. Success codes 200 or 201 or 204. Alert on lock (Backend, 2026-10-05; no ADMIN_ALERT row exists): the existing AUTH_ACCOUNT_LOCKED audit row, a SUPER_ADMIN-only org-scoped lock-events list (path `/users/lock-events` ASSUMED) and `locked`/`lockedUntil` on GET /users for SUPER_ADMIN only; e-mail via MailPort 'staff-account-locked' (no-op until BE-06). Lock fields must never appear on login, refresh, 2FA, setup, re-auth, logout or password responses (FU-BE-22; tested now in tc-002-lock-privacy.int.test.ts). Whether unlock needs the admin's currentPassword (403 REAUTH_FAILED) is undecided: switch `UNLOCK_NEEDS_REAUTH` in be03-routes.ts. A deactivated user and a demoted user are refused on the next call (guard reads the database, not only the token).

### 8.3 TC-008 coverage review (PR #30, branch db/step-5)

Strong: 31 models, every read, write and delete as org A against org B, positive controls, filter widening, transactions, raw SQL, `app_user` grants. Gaps: (1) the HTTP cases use a test `ProbeController`, not a real route; (2) the 404 body shape (RFC 7807) and sameness of missing versus cross-org ids (no existence oracle) are not asserted; (3) a public route that reads org data answers 500, which the test accepts; the real contract should be a clean 4xx; (4) no WebSocket /live case and no candidate-token cross-org case; (5) the file runs under the apps/api unit Jest config, so the QA gate (which reads the integration run) does not see TC-008; add it to the gate input or move a thin wrapper to `test/integration`. FU-DB-59: the matrix points at that file as planned (PR #30), not Verified.

### 8.4 TC-050 and QA-D-01 (pending ADR 0013 acceptance)

Hub decision: FULLSCREEN_EXIT is emitted at once without `durationMs`; FULLSCREEN_RESTORED carries `durationMs`; the server fills `duration_ms` on the open FULLSCREEN_EXIT when RESTORED arrives or at session end. The p1-gate now handles both states: while the `it.fails` test exists it prints KNOWN DEFECT open with the matrix status; once it is replaced by plain tests it prints them as passing, not verified; if the `it.fails` test starts failing it prints a message that the defect was fixed or decided and the test must become a plain test (still a failure, on purpose). Checked with synthetic reports for all three cases.

Proposed TC-050 wording for test-cases.md (not edited here; the hub carries it in ADR 0013's PR #39): Expected result: "Editor locked, overlay shown; FULLSCREEN_EXIT logged when the candidate leaves; on return FULLSCREEN_RESTORED logged with the time spent out; the server stores that duration on the FULLSCREEN_EXIT (also when the session ends while still out)."

Planned (BE-10): `apps/api/test/integration/tc-050.int.test.ts`: duration_ms filled on the open FULLSCREEN_EXIT when RESTORED arrives, and at session end when it never does.

### 8.5 Follow-ups to pick up

- After merge: #32 (worker hardening), #30 (DB-05, TC-008), #26 (dedupe harness helpers), ADR 0013 (TC-050), BE-03 (flip the switches, fix assumed names, run, update the matrix from the run).
- #25 and #27 added tests tagged TC-005 and TC-074; the matrix check passes with them.

### 8.6 Code-reviewer round on PR #42 (approved, no blockers)

Applied in the staged tests: a success on a mutating route must have an effect (`unchanged() === false`); cross-org 404 over every allowed role, with the TC-008 tag in the title; list routes checked for leaks by org A user ids, e-mails and an org A session (for /review/queue), not only the org id; existence-oracle comparison of cross-org 404 against a random-uuid 404; TC-006 runs each route as the least-privileged allowed role first; the harness fake MailPort now records every `send*` method (so the BE-03 invite mail is captured) and the invite test asserts a token was mailed; `entityId` must be defined on every audited route; all actors and fixtures are created before the audit baseline. A trial run with both switches on found and fixed a fixture bug (the `users_check` constraint needs a hash or set-password token).

p1-gate: staged (skipped, pending, todo) tests are counted per TC and printed as "N passing, M staged (skipped)"; `--strict` fails a P1 TC with staged tests; a Jest or Vitest file that failed with no assertion results (compile error, crash) fails the gate and names the file. Checked with synthetic reports. Not done: a BE03_READY canary (it could false-fail when BE-03 merges before the switch is flipped); the switch flip is listed under "After merge" in 8.5.

Nits: the cheap ones were applied with the items above; the remaining nits (the reviewer's list 3, 8 and 9 was not itemised in the message I received) are open, please repeat them if they matter.

Hub request (nit 10, test-cases.md is not QA-owned): TC-002 expected result should add the P-03 behaviour. Proposed wording: "Account locked 15 min; the 6th, correct attempt refused; audit entry written; a SUPER_ADMIN of the org sees the lock (AUTH_ACCOUNT_LOCKED event, locked and lockedUntil on GET /users, never on any auth response or to other roles) and can unlock it with an audited USER_UNLOCKED action, after which the user can sign in and the failed-attempt counter is reset."

## 9. Proposed TC cases for compliance decisions (C-01..C-16)

Source: docs/compliance/decisions.md (PR #44, branch dl/compliance-decisions). No TC IDs are invented here: docs/test-cases.md is hub-owned and `packages/qa/src/matrix.test.ts` requires matrix and test-cases.md to agree. The hub assigns IDs; QA then adds matrix rows and tests (tests are not written until the FSD text exists). Test file names use `tc-XXX` as the placeholder for the assigned ID. Items C-01, C-03, C-06 to C-09, C-11, C-12 and C-14 to C-16 are documents, DPIA, wording or process decisions and need no new automated case (C-06 erasure timing is covered by existing erasure cases once the NFR-05 wording lands; C-07 is the existing TC-095).

| Ref | Title | Level | Owner | Pri | Expected result | Planned test file |
| --- | --- | --- | --- | --- | --- | --- |
| (a) C-02, FR-305 | "No face match / no identity check" accommodation, and audited accommodation changes | integration (plus e2e for the UI) | backend-engineer (BE-06), integrity-engineer (BE-08 skip), frontend-engineer (FE-05) | P1 | A recruiter sets the accommodation on an invitation; the candidate session skips the face match and the identity re-check and is not rejected; the review screen shows "identity check waived by accommodation" (OQ-3) with the recruiter's reason. Every change of an accommodation (set, change, clear) writes exactly one audit row with org, actor (recruiter), invitation id, IP and no secrets; a role without `invitation:create` gets 403; another org gets 404. Without the accommodation the face match still runs for every candidate. | `apps/api/test/integration/tc-XXX.int.test.ts` (API, audit); `packages/qa/e2e/tc-XXX.spec.ts` (UI) |
| (b) C-02, FR-401 | Decline screen shows the recruiter contact | e2e | frontend-engineer (FE-09), backend-engineer (BE-07) | P2 | Declining consent ends the session with no recording and shows the recruiter's contact (name and e-mail from the invitation); no media request was made; the contact is the invitation's recruiter, not another org's. | `packages/qa/e2e/tc-XXX.spec.ts` |
| (c) C-04, C-26, C-27, ADR 0004 §5 and §9 (PR #48), ADR 0013 5.7 | Retention is tiered: face 90 days, media `retention_days`, results 1 year, consent 3 years | integration | database-engineer (DB-06), backend-engineer | P1 | Face tier: `identity/**` and `evidence/sealed/**` deleted at LEAST(`retention_days`, 90) and their keys nulled. Media tier: the session prefix except `reports/` deleted at `retention_days`, and keystroke batches deleted. Results tier: `reports/` deleted and `report_key` nulled at 1 year. Consent record and PDF kept to 3 years, also through erasure (C-17). Nothing deleted while a review or appeal is open. Face embeddings never stored (C-18). The exact clock starts are open in ADR 0013 owner questions. Extends TC-072. | `apps/api/test/integration/tc-XXX.int.test.ts` (next to TC-072) |
| (d) C-05 | Retention schedule link on the consent step and the candidate portal | e2e plus a11y | frontend-engineer (FE-09) | P2 | The consent document and the candidate portal both show a link to the published retention and destruction schedule; the link resolves (200) and is keyboard reachable; axe finds no violation on the consent step. | `packages/qa/e2e/tc-XXX.spec.ts` |
| (e) C-13, new FR (FAIR-01) | Optional demographics: separate consent, hidden from staff, not used in scoring, aggregate only (min group 10), deleted with the session | integration (API and database) plus e2e for the form, a11y for the form | database-engineer, backend-engineer, frontend-engineer (FAIR-01) | P1 (privacy) | The form appears after the test, with its own explicit consent and a "prefer not to say" option, and the test works without answering. Stored separately from the session. No staff role (SUPER_ADMIN, RECRUITER, AUTHOR, REVIEWER) can read an individual answer by any route (403 or 404, tested per role and per route, plus a schema check that no staff-visible serializer includes the fields). Changing a demographic answer changes no score, risk score, band or review queue entry (same session scored with and without). The aggregate report returns a group only when it has at least 10 members (9 hidden, 10 shown; a group of 10 where one is deleted becomes hidden), and never a per-candidate row. Deleting the session deletes its demographics. Needs the FAIR-01 ADR for the storage and access design before the exact checks are fixed. | `apps/api/test/integration/tc-XXX.int.test.ts`; `packages/qa/e2e/tc-XXX.spec.ts` |
| (f) D-28, C-10, ADR 0013 | Model licence gate passes only the files listed under D-28 in docs/status.md section 9 | unit (script) plus CI | integrity-engineer, backend-engineer (DEP-01/03) | P1 | The gate passes an `unverified` model only when every one of its files (AuraFace `glintr100.onnx`; COCO-SSD `model.json` and each weight shard) is listed by `name@sha256` in the `licence-acceptances` block of docs/status.md section 9 under decision D-28 (as extended by C-10); a missing or duplicated block fails pilot and production; the same file with one byte changed is blocked; any other model file without a verified licence is blocked; the gate fails the deploy job on a block. | `infra/scripts/tc-XXX.test.mjs` (node:test, run by root `pnpm test`) or the gate's own test directory, as ADR 0013 defines it |

Open dependencies for these cases: OQ-1 (consent record on erasure), OQ-2 (embeddings never stored), OQ-3 (fallback for a waived identity check) in decisions.md; the FAIR-01 ADR; the ADR 0013 gate interface.

## 10. QA-04a (2026-10-05): staged BE-03 tests moved to the final contract

Branch `qa/step-4a`. `apps/api/test/support/be03-routes.ts` and the dependent tests (tc-002-unlock, tc-002-lock-privacy, tc-004-rbac, tc-006-audit) follow the final BE-03 contract: `/admin/users` routes, `currentPassword` step-up on invite, PATCH and unlock (the `UNLOCK_NEEDS_REAUTH` switch is gone), audit actions, interceptor rows for the list reads, fake `MailPort` that records the method and all arguments. The route list is checked against the backend registry (`ROUTE_PERMISSIONS`, `listRoutes`, `matrixProblems`) through `loadBackendRegistry()`, loaded lazily so main compiles without those files. To switch everything on when BE-03 merges, change `BE03_DEFAULT` to `true` in be03-routes.ts (one line).

Trial run with `BE03_READY=1` against `origin/backend/step-3` (4251cfb) in a temporary worktree: 198 passed, 0 failed, 41 BE-13 tests skipped, 3 todo. First run had 14 failures; all were test bugs (shared SUPER_ADMIN used up by wrong-password tests and locked, a pre-reset Nest class token, same-step TOTP reuse for a fresh sign-in, a wrong audit failure body assumption, `instance` echoing the caller's own URL, self-unlock of a locked admin).

Product findings (owner backend-engineer):

| ID | Sev | Finding |
| --- | --- | --- |
| QA-D-04 | low | Cold start: `ensureConnected()` (apps/api/src/infrastructure/redis-ready.ts) returns at once when the lazy client is `connecting`, the client has `enableOfflineQueue: false`, so parallel first requests that use Redis (2FA verify) answer 503. Reproduced on main: `tc-003-coldstart.int.test.ts` (`it.failing`, KNOWN DEFECT), 8 of 8 runs on a fresh boot, so it is near-deterministic and stays in the gated suite. The body throws only when every failure is the 503; any other failure, or no failure (fixed), turns it red on purpose. Backend fixes it in backend/redis-cold-start; QA flips it to a plain test afterwards |
| QA-O-01 | doc | backend.md says an audit write failure gives "500, no body". The answer is a bare problem+json (type, title, status, instance, traceId) with no route data. Fix the wording or the code; the test accepts the bare problem |
| QA-O-02 | observation | Each password-protected admin call reserves a password attempt on the shared lockout, so more than 5 parallel calls from one admin get 403 REAUTH_FAILED with the right password, and 5 wrong passwords lock the admin (AUTH_ACCOUNT_LOCKED). A locked admin cannot unlock themself (their own password check fails); another SUPER_ADMIN must. Probably by design; tell the frontend (no bulk parallel admin actions) |
| QA-O-03 | observation | A token issued in the same second as a role change or reactivation is refused (marker in epoch seconds): a sign-in right after reactivation can get a dead token. Documented by backend; tests wait 1.1 s |

Done in QA-04b (section 11): TC-065 follow-ups, compliance proposals g, h, i-m and the C-28 impact list, gate tests, re-checking the TC-002..008 and TC-098 matrix rows that existed only on qa/step-2b, the TC-008 gate reader.

Review round on PR #54: lock mail recipients now exclude another org and a deactivated admin (one mail each); PASSWORD is an audit secret on the reauth routes; a captureLogs case checks passwords, invite token and access token are not logged; the fail-closed invite test checks no invite mail and restores the grant; unlock of a non-locked account pins a USER_UNLOCKED row with wasLocked false; the invalid-body test registers only for mutating routes with a body; the registry check takes BE-13 routes only when BE13_READY and rejects unknown matrix fields. Nits applied: alg:none in the 401 list, non-holder 403 is not REAUTH_FAILED, any race 403 is REAUTH_FAILED, 429 sends no mail and writes no row. Logged, not done: none.

## 11. QA-04b (2026-10-05)

Branch `qa/step-4b`, off main after PR #54 and #55.

### 11.1 Done

- PR #54 reviewer nits: the captureLogs test asserts the route path appears in the logs; deferred-mail assertions use `flushDeferred` (settle plus several event-loop turns) instead of one `setImmediate`; the no-op USER_UNLOCKED row is checked with `findMany` length 1 plus actor and org; the registry test asserts every `COVERED_ELSEWHERE` key exists in `ROUTE_PERMISSIONS`; the vacuous `Wrong-Password-1` scan is dropped. The RECRUITER disable test in tc-003 is retitled and now checks the AUTH_2FA_DISABLED row.
- QA-D-04 (cold-start test, nit about matching `/2fa/verify` and the detail): left to the agent flipping it in backend PR #60 (branch qa/qa-d-04-flip); not touched here.
- TC-065: matrix row now lists `stop-inflight.test.ts` and `finish-inflight.test.ts` (PR #47: stop and finish wait for a batch being signed). SDK suite: 171 passed. The batch-count question in proctor-sdk.md ("flush timer window") is a product decision for the hub, not a test gap.
- Gate tests: `packages/qa/src/p1-gate.test.ts` (24 tests) runs the gate as CI does, on synthetic Jest, Vitest, Playwright and JUnit reports and a fake docs tree (`P1_GATE_ROOT`): failing P1 test, failing P2 note, Verified row with no run or only staged tests, unknown TC id, id only in the describe block, KNOWN DEFECT passing, failing and only in the describe block, staged tests with and without `--strict`, `--strict` on an automated P1 case with no run, a failed file with only passing tests (afterAll, Jest `numRuntimeErrorTestSuites`, Vitest `success: false`), pytest `TC_901` names, `<error>` and `<skipped>`, a collection `<error>` with no TC id, Playwright nested suites, `ok:false` and all-skipped specs, missing report (exit 2), manual cases (exit 0). The gate itself now fails a test file that failed as a whole even when every recorded test passed, and a JUnit `<error>` with no TC id. `tsx` is a devDependency of packages/qa.
- TC-008 gate reader: proposed to the hub in section 12 (a workflow step plus `api-unit.json` in the gate's report list); NOT applied (CI config goes through the hub). The matrix row stays Planned.
- Matrix rows TC-002, TC-003, TC-004, TC-005, TC-006 and TC-098 (they existed only on qa/step-2b before #26) are on main and match the runs: integration suite 13 suites, 96 passed, 148 staged, 3 todo (BE03 off). TC-008 stays Planned.
- C-28 (#55) re-check of the worker: TC-075 unchanged (`test_qa_tc.py` and `test_risk.py`: 55 tests pass; the whole worker suite: 166 passed, 1 skipped); TC-076 matrix row rewritten to the C-28 expectation and two QA tests added (queue is HIGH, MEDIUM, LOW even when a lower band has the higher score, in shuffled input order; fast path only for LOW without a hold, `needs_review` always true).

### 11.2 Not done, and why

- The stale "already off 409" sentence and the "PR #51 is merged" heading are not in qa.md on main (they are on another branch), and `signInKeepingCookie` is not in the main harness (qa/tc001-totp-resolved @04b6107, going into backend #58). Nothing to change on main; redo after #58 merges.
- `be03-routes.ts` is unchanged (BE-03 contract unchanged) and `BE03_DEFAULT` stays false: BE-03 is not on main.

### 11.3 C-28 impact (decisions.md C-28; fsd.md section 3 and FR-805 still describe auto-clear, hub owns them)

| Case | Today | Under C-28 |
| --- | --- | --- |
| TC-076 (P1) | "Session scores MEDIUM; appears in review queue" | Proposed: "Sessions of every band (LOW, MEDIUM, HIGH) reach UNDER_REVIEW and the queue; none is COMPLETED automatically. Queue order: HIGH, sessions with an identity or short-answer hold, MEDIUM, LOW (oldest first) (DL-18). A LOW session without a hold opens the fast review (summary, one-click verdict, timeline available); with a hold it opens the full review." Test: `apps/api/test/integration/tc-076.int.test.ts` (BE-12, BE-13) |
| GRADED to COMPLETED | fsd.md state table: GRADED goes to UNDER_REVIEW or COMPLETED; COMPLETED "verdict set or auto-clean" | Only UNDER_REVIEW follows GRADED; COMPLETED only after a verdict. Add an API test: after grading a LOW, clean session the status is UNDER_REVIEW, never COMPLETED, and no `session.completed` is sent |
| TC-081 (P3) webhook | "Complete a session: session.completed delivered, signed" | The event is sent after the verdict only, never at grading; add "no webhook before the verdict" |
| TC-078, TC-080 | Verdict required, appeal routing | Unchanged, but their fixtures must reach COMPLETED through a verdict, not by auto-clean |
| New (P1) | none | Recruiters, exports and webhooks see no score or verdict before the reviewer signs off: GET results as RECRUITER before the verdict is 403 or has no result fields; after the verdict it works (BE-14, FR-1002, FR-1003) |
| New (P2, FE-11, FE-13) | none | Fast-review UI: summary and one-click verdict, timeline reachable, axe clean |

Answered (DL-20): BE-13 (the API) owns the full review-queue order, because holds (identity not confirmed, manual scoring) are API state. The worker supplies only band, score and the fast or full path. BE-13 applies DL-18: HIGH, then holds, then MEDIUM, then LOW, oldest first within each tier. The worker tests keep only the band-order assertion. Planned BE-13 tests (go with TC-076, file `apps/api/test/integration/tc-076.int.test.ts`; no TC id invented):

| Planned test | Level | Owner | Expected result |
| --- | --- | --- | --- |
| Queue endpoint ordering per tier | integration | backend-engineer (BE-13) | With sessions seeded in every tier (HIGH, a LOW with an identity hold, a MEDIUM with a manual short-answer hold, MEDIUM, LOW), the queue returns HIGH, then held sessions, then MEDIUM, then LOW, regardless of insertion order |
| Ties by age | integration | backend-engineer (BE-13) | Within a tier, equal sessions come oldest first; a LOW queue is oldest first |
| Hold flags come from API state | integration | backend-engineer (BE-13) | Confirming the identity or scoring the short answer by a reviewer removes the hold and moves the session to its band tier; the flags are not taken from the client or the worker request |
| Fast path versus full review | integration | backend-engineer (BE-13) | A LOW session with no hold is marked fast-review; any hold, MEDIUM or HIGH is full review |
| Nothing auto-clears | integration | backend-engineer (BE-12, BE-13) | After grading, a LOW clean session is UNDER_REVIEW, never COMPLETED, and appears in the queue; COMPLETED only after a verdict |

### 11.4 Proposed TC cases, compliance decisions C-17 to C-33

Same rule as section 9: no TC IDs are invented here; the hub assigns them and QA then adds matrix rows and tests. Items with no automated case: C-18 (existing design, covered by TC-072 and the "no embeddings stored" checks of BE-08), C-20, C-21 (done in TC-003), C-22 to C-24, C-29, C-33 (process).

| Ref | Title | Level | Owner | Pri | Expected result | Planned test file |
| --- | --- | --- | --- | --- | --- | --- |
| (g) C-17 | Erasure keeps only the consent proof until 3 years | integration | database-engineer (DB-06), backend-engineer | P1 | After an erasure request everything is erased at once (recordings, ID image, selfie, evidence, keystrokes, code, results per C-26) except the signed consent record (version, name, timestamp, IP, user agent, signed PDF), which stays until 3 years after signing, then is deleted. The confirmation tells the candidate this. Extends (c) and TC-072. | `apps/api/test/integration/tc-XXX.int.test.ts` |
| (h) C-19 | Waived identity check: reason, "identity check waived", video ID check, all audited | integration plus e2e | backend-engineer (BE-06, BE-13), integrity-engineer (BE-08), frontend-engineer (FE-05, FE-11) | P1 | Waiving needs a reason (400 without); the identity check records a waived state; the recruiter can record "video ID check done: yes/no"; the review screen shows "identity check waived" and the reason; each of the three writes one audit row (org, actor, invitation, IP, no secrets); another org 404, wrong role 403. Extends (a). | `apps/api/test/integration/tc-XXX.int.test.ts`, `packages/qa/e2e/tc-XXX.spec.ts` |
| (i) C-26 | Results kept 1 year, then only anonymised statistics | integration | database-engineer (DB-06) | P1 | A session's scores, verdicts, reviewer notes and reports are deleted 1 year after the test (clock moved); anonymised aggregates remain and carry no candidate id; media still goes at 90 days and consent at 3 years. | next to TC-072 |
| (j) C-27 | Face images capped at 90 days whatever the setting | integration | database-engineer (DB-06) | P1 | `retention_days` of 7 shortens ID image, selfie and mismatch frames to 7 days; a setting of 365 leaves them at 90 days (never longer); other media follow the setting. | next to TC-072 |
| (k) C-30 | Age 18 confirmation required and stored | integration plus e2e | backend-engineer (BE-07), frontend-engineer (FE-09) | P1 | The consent step cannot be completed without the 18-or-older confirmation (400, UI blocks); the confirmation is stored with the consent record; a candidate who does not confirm cannot continue and no media is requested. | `apps/api/test/integration/tc-XXX.int.test.ts`, `packages/qa/e2e/tc-XXX.spec.ts` |
| (l) C-32 | Client-error endpoint: DTO, rate limit, scrubbing | integration | backend-engineer | P2 | A browser error is accepted with a valid body (400 otherwise), rate limited per client (429), email addresses, tokens and URLs with tokens are scrubbed before logging, and nothing reaches a third party. C-31 (SES): the mail adapter sends only through the MailPort; covered by the BE-06 adapter tests, plus a check that no `resend` or `sentry` dependency remains (`pnpm why`). | `apps/api/test/integration/tc-XXX.int.test.ts` |
| (m) C-25, OQ-15 | Two accommodation settings: "no identity check" and "face detectors off" | integration (API and worker) plus unit (SDK) | backend-engineer, integrity-engineer, proctor-sdk-engineer | P1 | "No identity check" skips the verification step only (C-19 applies) and the face detectors still run; "face detectors off" turns off the in-browser and server face detectors (FACE, GAZE) and the server answers 409 DETECTOR_DISABLED for their events, and the identity re-check still runs; each combination tested; refusing biometrics switches off every face-based detector (OQ-15). Known gap: the SDK has one FACE id today (proctor-sdk.md). | `apps/api/test/integration/tc-XXX.int.test.ts`, `packages/proctor-sdk/src/qa/qa-tc.test.ts`, worker tests |


## 12. Workflow step for TC-008 (hub request; CI config goes through the hub, CLAUDE.md rule 12)

The gate has no api-unit-specific code: the apps/api unit Jest JSON (`api-unit.json`) is ordinary Jest JSON, which it reads like any other Jest report. To make the P1 gate see the TC-008 spec (`apps/api/src/database/tc-008-org-isolation.spec.ts`, DB PR #30), `.github/workflows/qa.yml` needs one extra step before "P1 gate" and `test-results/api-unit.json` appended to the gate's report list. Land it together with, or after, DB PR #30. Exact change (a diff against main; QA did NOT apply it):

```diff
@@ -113,6 +113,12 @@ jobs:
         if: ${{ !cancelled() }}
         run: pnpm --filter @codeproctor/api exec node --experimental-vm-modules node_modules/jest/bin/jest.js -c test/jest.integration.config.js --runInBand --forceExit --json --outputFile=../../packages/qa/test-results/api-int.json
 
+      # The apps/api unit config also holds TC-008 (org isolation, src/database/tc-008-org-isolation.spec.ts
+      # once DB PR #30 is on main). Its JSON goes to the gate so TC-008 is read like any other P1 case.
+      - name: API unit and org-isolation tests (TC-008)
+        if: ${{ !cancelled() }}
+        run: pnpm --filter @codeproctor/api exec node --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand --forceExit --json --outputFile=../../packages/qa/test-results/api-unit.json
+
       - name: Install the Playwright browser
         if: ${{ !cancelled() }}
         run: pnpm --filter @codeproctor/qa exec playwright install --with-deps chromium
@@ -125,7 +131,7 @@ jobs:
       # own as well; the gate makes the P1 verdict explicit and prints one line per P1 case.
       - name: P1 gate
         if: ${{ !cancelled() }}
-        run: pnpm --filter @codeproctor/qa run gate test-results/web.json test-results/qa.json test-results/sdk.json test-results/shared.xml test-results/worker.xml test-results/api-int.json test-results/e2e.json
+        run: pnpm --filter @codeproctor/qa run gate test-results/web.json test-results/qa.json test-results/sdk.json test-results/shared.xml test-results/worker.xml test-results/api-int.json test-results/api-unit.json test-results/e2e.json
 
       - name: Upload test reports
         if: ${{ !cancelled() }}
```

Until it lands the gate does not read `api-unit.json` and TC-008 stays Planned in the matrix.
## TC-003 disable freshness depends on backend PR #51

The tc-003 "turn 2FA off" test proves `totpEnabled` is fresh after a disable through a new login and a refresh of that new session, not through the pre-disable cookie, because #51 revokes every refresh family on disable. The later "already off" check (409) still reuses the pre-disable access token; if BE-03 or #51 invalidates access tokens on disable, switch it to the new session's token. Owner: qa-engineer.


## QA B (ops) follow-ups (2026-10-05)

Owner: qa-engineer (QA B session). Items for QA A and the hub; QA B does not edit the matrix, `packages/qa/src`, `apps/*/test` or CI.

### B.1 Matrix rows for QA A (manual scripts added in docs/manual-tests.md)

The manual script is a secondary level for TCs that already have an automated level; QA A decides the primary level and status. Status for all rows below is Planned until a person runs the script.

| TC or ref | Script | Level to add | Pri | Note |
| --- | --- | --- | --- | --- |
| TC-095 | M-01 | manual (secondary) | P1 | 18+ confirmation (C-30), server timestamp, emailed copy, retention link (C-05), new signature per session |
| TC-030 | M-01 steps 1 and 4 | manual (secondary) | P1 | no media request before signing or without the 18+ confirmation |
| TC-096 | M-02 | manual (secondary) | P1 | decline screen shows the recruiter contact (C-02) |
| TC-075, TC-076 | M-04 | manual (secondary) | P1 | C-28: every session reviewed; band LOW still goes to UNDER_REVIEW. The current text of TC-076 ("Session scores MEDIUM") and FR-805 predates C-28 (see B.3) |
| TC-072, TC-094 | M-05 | manual (secondary) | P1/P2 | tiers C-26, C-27, C-35; consent proof kept (C-17); erasure waits for an open appeal (C-06) |
| Compliance proposal (a) (section 9 above) | M-03 | manual (secondary) | P1 | waived identity check, two accommodation settings (C-25, C-34); TC ID pending from the hub |
| C-30 (proposal (k), section 11.4) | M-01 | manual (secondary) | P1 | age confirmation; the hub assigns a TC ID |
| Compliance proposal (b), (d) (section 9 above) | M-02, M-01 step 8 | manual (secondary) | P2 | decline contact, retention link; TC ID pending |
| Compliance proposal (e) (section 9 above) | M-06 | manual (secondary) | P1 (privacy) | demographics, blocked until FAIR-01; TC ID pending |
| TC-090 | packages/qa/k6 | load (k6) | P1 | script added by QA B (see B.2); status stays Planned until DEP-01 |
| TC-091 | packages/qa/k6 | load (k6) | P2 | same |
| TC-093 | packages/qa/zap | scan (ZAP) | P1 | config added by QA B; status stays Planned until DEP-01 |
| TC-065, TC-053, TC-054, TC-056, TC-064, TC-036 | docs/qa/redteam-plan.md (in PR #80) | manual / red team | P1/P2 | QA-02 adversarial re-attempts; report goes to docs/red-team-report.md after DEP-01 |

### B.2 Notes on the existing k6 scripts (packages/qa/k6, QA A)

QA B has replaced the placeholder `packages/qa/k6/tc-090-load.js` and `tc-091-code-run.js` in place (PR #77). The old scripts used placeholder paths (`/v1/sessions/current/...`) that matched neither FSD section 4 nor ADR 0013, and sent no presign, confirm, keystrokes or signed batches. The new ones use the ADR 0013 routes and the real cadence (R-02). The hub should update the k6 job in `.github/workflows/qa.yml` (see B.4).

### B.3 Doc disagreements found (for the hub)

1. FSD FR-805 and TC-076 say only MEDIUM and HIGH sessions go to the review queue; C-28 says a person reviews every session and GRADED always goes to UNDER_REVIEW. FSD section 3 (COMPLETED "Verdict set or auto-clean") has the same old wording.
2. FSD FR-401 has no age confirmation (C-30), and FR-305 has no "no identity check" or "face detectors off" accommodation (C-02, C-25).
3. TC-094 still says "provisional, Legal to confirm"; C-06 made the erasure hold final.
4. TC-063 (45 s) versus FR-609 (60 s) is still open (already listed above; ADR 0013 section 5.3 flags it as Q13).
5. Proposal (m) in section 11.4 says that with "face detectors off" the identity re-check still runs and GAZE is off. C-34 refuses the re-check when either accommodation is on, ADR 0015 (proposed) is the same, and M-03 expects GAZE may still fire (OQ-15). Hub to reconcile; QA A owns that row.
6. The face-tier clock reads "after the assessment is finished" in retention-schedule.md but "from capture or submission" in C-35. M-05 follows C-35; testers record the date the job used and do not file it as a new defect each run.

### B.4 CI changes needed (hub, rule 12; none made by QA B)

QA B made none of these changes. The exact diff is sent to the architecture hub, who apply it to `.github/workflows/qa.yml`. Summary:

- k6 job: mount `packages/qa/k6` at `/k6` and run with `-w /k6`; set `API_BASE_URL=<target>/api/v1`; map the secret `K6_CANDIDATE_TOKENS` to `K6_SESSIONS_JSON` and pass it into the container as `docker -e SESSIONS_JSON`; add `--summary-export` and upload the summary as an artifact.
- ZAP job: copy `packages/qa/zap/baseline.conf` and pass it with `-c`; replace the `jq` check with `node packages/qa/zap/evaluate.mjs`; optionally run a second scan against `api_url`.

### B.5 Retention clock-shift hook (for DB-06 and backend)

M-05 steps 5, 5a and 6 need a way to run the retention job with a shifted clock, which the docs do not yet specify. Requirement from QA: the hook exists on staging only, is admin-gated (SUPER_ADMIN, audited, with a fresh password check), and is absent from pilot and production builds. M-05 includes a check that it is absent there. Owners: database-engineer (DB-06, the job and its clock input) and backend-engineer (any route that exposes it). Until the hook is specified, the clock steps rely on the integration tests for TC-072.
