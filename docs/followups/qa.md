# QA follow-ups

Owner: qa-engineer. Written 2026-10-02 (QA-01). Items are tagged **must-fix** (blocks a gate), **should-fix** or **nit**. Section 2 lists changes the QA agent cannot make itself (outside its file scope) and needs the architecture hub or another owner to apply.

## 1. How to run the suite

| What | Command (repo root) | Notes |
| --- | --- | --- |
| Web unit and component tests | `pnpm --filter @codeproctor/web test` | Includes the TC-tagged files `qa-tc.test.tsx` and `qa-contract.test.ts` |
| Coverage per module (apps/web) | `pnpm --filter @codeproctor/qa run coverage:web` | v8 provider; prints a table per folder |
| Matrix check | `pnpm --filter @codeproctor/qa test` | Fails when test-cases.md and test-matrix.md disagree |
| Playwright and axe | `NEXT_PUBLIC_API_MOCKING=enabled ALLOW_MOCKING_IN_PRODUCTION_BUILD=staging-only pnpm --filter @codeproctor/web build` (the second variable is required once PR #94 lands; its value is a label, not a secret; staging and test builds only, never a deployed image; the guard runs at build time, so `next start` needs only `NEXT_PUBLIC_API_MOCKING`; CI qa.yml already sets both), then `pnpm --filter @codeproctor/qa run test:e2e` | Serves the production build with `next start` on port 3100 (never the dev server). First time: `pnpm --filter @codeproctor/qa exec playwright install chromium` |
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
- [ ] Owner: qa-engineer. A SERVICE writer that **starts after** the erasure fence writes nothing (face-recheck outcome, server-event, disconnected job, report generation, analyze-session); erasure-compatible jobs (ingest close, sweeps, evidence-expire, consent PDF) still run.
- [ ] Owner: qa-engineer. A no-limit or clamped next section ends at the session's effective deadline: pause before the section opens (p = 10, open at 15, resume at 20) and cap exhausted at 40 both end with the session.
- [ ] Owner: qa-engineer. The candidate SUBMIT insert leaves `created_at` to the database default; a no-match with saved code at T alerts and fails.
- [ ] Owner: qa-engineer. Erasure re-run repeats the database steps and removes a late candidate-scope commit.
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
| QA-D-04 | low | FIXED 2026-10-05 in backend PR #60 (FU-BE-33). Was: cold start, `ensureConnected()` (apps/api/src/infrastructure/redis-ready.ts) returned at once while the lazy client was `connecting` and the client has `enableOfflineQueue: false`, so parallel first requests that use Redis (2FA verify) answered 503. `tc-003-coldstart.int.test.ts` is now a plain `it` (five parallel 2FA sign-ins on a fresh boot all 200; any failure fails it) and stays in the gated suite. Hardened after review: logins first (no Redis), a guard that the Redis client is still `wait`, then five verifies fired together. Proof it detects the defect: with the pre-fix `redis-ready.ts` (from ab106f0) temporarily restored, the test failed 8 of 8 runs (five failures); with the fix it passed 10 of 10 |
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

## QA B (ops) (D-51)

| ID | Sev | Owner | Item |
| --- | --- | --- | --- |
| FU-QAB-01 | should-fix | architecture hub | `.github/workflows/qa.yml` job `zap-baseline` (PR #80 review): (1) it counts High alerts with `jq` and passes on an empty report (unreachable target); (2) it has no `actions/checkout`, so `packages/qa/zap/baseline.conf` and `evaluate.mjs` are not on the runner; (3) it has no `-c baseline.conf`. Fix: add `actions/checkout` and `actions/setup-node` (`.nvmrc`), mount the conf, run `node packages/qa/zap/cli.mjs zap/report.json --target-host <host>`, and make a ZAP exit code of 3 (scan failure) fail the job. Also run `node --test packages/qa/zap/*.test.mjs` in the QA workflow (suggestion: a `test:zap` script in packages/qa/package.json, a QA A file, which the hub or QA A adds and the workflow calls). The ZAP image digest in `packages/qa/zap/README.md` must be bumped together with qa.yml. The full diff was sent to the hub. |
| FU-QAB-02 | owner decision | owner | Red-team plan rule 2: may a tester use their own face on staging? Default is no (synthetic faces only, CLAUDE.md, architecture.md:22). A yes needs the owner's written approval and a doc change or ADR via the architecture hub (architecture.md:22 and brd.md:87 say synthetic only); a chat approval is not enough. The volunteer consent form (D-18, C-11) does not cover it. |
| FU-QAB-03 | nit | qa-engineer | RT-43, RT-44 and RT-67 rely on proposed ADR 0015; re-read them when the ADR is accepted or changed. |
| FU-QAB-04 | nit | qa-engineer | Nits from the PR #71 review, in docs/manual-tests.md: (1) the M-05 hook line should say "(SUPER_ADMIN, audited, fresh password check)" to match B.5; (2) say that the local pilot/production-config run uses local or ephemeral DB, storage and secrets only, never real pilot or production credentials or an AWS bucket (ADR 0009); (3) add a receiver clean-up step: delete delivery logs, remove the secret from the environment, ask the admin to rotate it if exposed; (4) move M-01a after step 10; (5) confirm the PR numbers cited in B.1 and B.2. |
| FU-QAB-05 | nit | qa-engineer | Nits from the PR #77 review (k6): (1) `lib/guard.js` uses the `i` flag, so case folding depends on the engine (goja vs Node); use explicit `[A-Za-z0-9.-]` or an ASCII pre-check and add a test for a Kelvin-sign host; (2) set `maxRedirects: 0` in the `options` of both scripts so a 3xx from an allow-listed host cannot send an API POST elsewhere; (3) drop `error` from `SYSTEM_TAGS` (`error_code` is enough) so no URL or object key can reach metric outputs; (4) after a long run, excused slots catch up in a burst (about 30 keystroke posts after a 60 s run); cap catch-up with `due = max(due + every, now)`; (5) README: `STORAGE_ALLOWED_HOSTS` accepts only `https://`, so it blocks every PUT against the http mock; (6) README: the request-rate floor counts setup and graceful-stop time, so smoke runs under 2 minutes can fail it falsely; loosen the margin or say so. |
| FU-QAB-06 | nit | qa-engineer | Nits from the PR #80 review (red-team plan and ZAP): (1) plan rule 2: the physical webcam and microphone carry only generated footage or audio (virtual device, a capture card fed by generated video, or a camera pointed at an empty scene) and are never live on the tester (RT-27, RT-40, RT-46); (2) RT-30 "a pre-recorded video of a face" should say generated; (3) `evaluate.mjs` header still shows `--target-host` as optional (the CLI requires it); (4) `strip` in `evaluate.mjs` only removes `http(s)://` text; widen it to any `scheme://` and optionally `?key=value` pairs. |
| FU-QAB-10 | should-fix | QA A, architecture hub, frontend | Accessibility checklist (docs/qa/accessibility-checklist.md, TC-092). (1) QA A: add the matrix rows from section 10 of the checklist (TC-092 split into axe-per-state, timer-announcement, 320 px reflow and three manual scripts); add real-browser axe for states covered only in jsdom (lock overlay and finish dialog in `test-screen.test.tsx`) and for the time-up banner and output states; jsdom cannot check contrast or layout. (2) Hub: decide the open questions OQ-A11Y-1 to 14 in section 11 of the checklist, the blocking ones first: no stated accessible route for camera-dependent steps (OQ-A11Y-1), microphone-less candidates (OQ-A11Y-3), assistive input versus the paste block and PASTE_BURST (OQ-A11Y-7), assistive tools in FR-305 (OQ-A11Y-6), extra-time limits (OQ-A11Y-9). (3) Frontend, check against the merged FE-09 consent step: Sign must become enabled for a screen-reader user who reads to the end without scrolling (A11Y-CON-03); the on-page Tab-focus hint says Ctrl+M, which may differ on macOS (A11Y-ED-01, unverified). (4) Hub: TC-094 (docs/test-cases.md line 118) says the consent PDF is removed on deletion, but C-17 keeps the consent record and signed PDF until 3 years after signing, even after erasure, so TC-094 needs amending. |

## 13. QA-05 (2026-10-05): BE-03 tests on by default, gate follow-ups

- Flip PR (branch qa/step-5, based on backend PR #84; rebase on main after #84 merges): `BE03_DEFAULT = true` in `apps/api/test/support/be03-routes.ts`; `[BE-03 pending]` removed from every title; `BE13_DEFAULT` stays false (the `[BE-13 pending]` tests stay skipped). Default run with no env switch and BE13_READY unset: 14 suites, 206 passed, 0 failed, 40 skipped (BE-13), 3 todo.
- Invite re-issue (Backend A, `POST /admin/users/:userId/invite`, contract confirmed on backend/invite-reissue @1e1abb6): the entry `users-invite-reissue` in be03-routes.ts and the new `tc-006-reissue.int.test.ts` run only when `ROUTE_PERMISSIONS` has that key, so #101 is green before and after the backend lands it (today the route is absent: file skipped). Asserted: user:manage, SUPER_ADMIN only, no `audited` flag; 200 StaffUserDto status invited with no token fields; one sendStaffInvite after commit with the new link, old token 400, new token works once; one USER_INVITE_REISSUED row with metadata exactly {method, route '/api/v1/admin/users/:userId/invite'}; 409 for a user with a password or a deactivated user; 404 identical for cross-org and missing ids only after the right password (403 REAUTH_FAILED first); audit insert failure gives 500, old link still works, no mail; 429 shares the per-org invite limit; 503 with Redis down; refused calls write no row; plus the generic route checks (401, 403 by role, 400, step-up, no secrets). Verified by overlaying these tests on origin/backend/invite-reissue in a temporary worktree: tc-004-rbac, tc-006 and the new file, 125 passed, 0 failed (40 BE-13 skipped). Gaps: "locked" and "changed mid-request" step-up cases are covered only by the generic reauth test, not specifically for this route.
- p1-gate (follow-ups from the #63 review): whole-file failures are now kept per report (a failing P2 test or an earlier report can no longer hide a runtime-error suite); Playwright top-level `errors[]` fail the gate, and so does `stats.unexpected` when no failing spec names a TC id; a spec with an empty `tests` array is no longer counted as staged. Four new gate tests (packages/qa 34 pass).
- Worker TC-076 queue test: added a second HIGH whose score (75) is above every LOW (70, 69).
- tc-003-coldstart wording softened from "race" to "first Redis use on a cold client".
- Not done: QA-D-04 pre-fix status codes were never measured (only "five failures" recorded), so no "5 x 503" claim is made.

## 14. QA-06 (2026-10-05): p1-gate follow-ups from the PR #101 reviews, mock-build variable

- Gate (`packages/qa/src/p1-gate.ts`, 40 gate tests): (S1) a failed Jest or Vitest file is recorded only when it has no failed assertion, or when one of its P1-tagged assertions was skipped or pending (the beforeAll-crash shape). In real reporters any failed assertion marks the file failed, so a lone P2 or untagged failure no longer gives the false "Test file failed with no failed test recorded"; P1 failures are reported as before. The `jest()` test helper now defaults the file status to failed whenever an assertion failed. (S2) One `idsOf(result)` (leaf title first, full name only when the leaf names none) is used for per-case state, file failures and the Playwright check; test: describe TC-901 (P1) containing a failing leaf TC-903 (P2) while a crash skipped the other TC-901 tests fails the gate. (S3) The empty-spec tests assert exit 0 and `TC-905 no automated run yet`. (S4) A JUnit untagged `<failure>` whose name or classname looks like a test file (`.test.ts`, `.test.mjs`, `.spec.ts`, `.py`) fails the gate (a node:test file that failed to load).
- Nits: each failure kind has its own reason (Playwright `errors[]`, `stats.unexpected`, Jest `numRuntimeErrorTestSuites`, `success: false`, crashed file, skipped P1 after a crash, unloadable JUnit file); Jest status `disabled` counts as staged; Playwright file and describe titles are passed down as `full`, so a TC id or KNOWN DEFECT only in `test.describe` is seen.
- Replaces the stale section 13 gate bullet: `stats.unexpected` is count-based (failing tagged specs are subtracted, so an untagged failure next to a tagged P2 failure still fails), an empty Playwright spec is neither a pass nor staged (no result at all), a failing P2 file is not a gate failure, and the gate suite is now 40 tests, not 34.
- Mock builds: local Playwright runs need `ALLOW_MOCKING_IN_PRODUCTION_BUILD=staging-only` at build time once PR #94 (fe-cand/mock-guards) lands. The guard is in `next.config.ts` and keys on the production build phase only, so the `next start` webServer env in `playwright.config.ts` is unchanged. Section 1 and the config header comment are updated; no `.github` change (qa.yml already sets it). There is no README under packages/qa.
- TC-008 matrix row lists `tc-006-reissue.int.test.ts` (its title at line ~153 names TC-004 and TC-008).

## 15. QA-07 (2026-10-06): BE-04 slice 4a question bank (branch qa/be04-4a, on backend/step-4 @23b3caf; no PR, co-landed with the backend PR)

### 15.1 What was added

- The 11 slice 4a routes are in `BE03_ROUTES` as `step: 'BE-04'` (`BE04_DEFAULT = true`), so `tc-004-rbac.int.test.ts` (401, 403, cross-org 404, same 404 for a random id, effect check) and `tc-006-audit.int.test.ts` (one row, right action, org, actor, IP, no secrets, no row when refused or invalid) drive them. Nothing is in `COVERED_ELSEWHERE`. PATCH /questions/:id has two entries (draft edit, QUESTION_UPDATED; edit of a published question, QUESTION_VERSION_CREATED). New `metadataKeys` field checks the exact metadata keys (ids and field names, never content); fixture `questionFixture` and the secrets `REF_SECRET`, `HIDDEN_IN`, `HIDDEN_OUT` are in be03-routes.ts.
- The audit rows are written by the service in the mutation's own transaction, so the routes carry no `audited` flag; the existing "matrix `audited` flag agrees with the QA list" test confirms it.
- Acceptance files: `tc-010.int.test.ts` (9), `tc-011.int.test.ts` (9), `tc-013.int.test.ts` (9); explicit "recruiter PATCH /questions/:id is 403 and the row is unchanged" test in tc-004-rbac.int.test.ts (the old it.todo is removed). Helpers in `apps/api/test/support/be04-helpers.ts`.
- Full API integration run: 18 suites, 376 passed, 0 failed, 40 skipped (BE-13), 2 todo.

### 15.2 Defects

None confirmed. Every assertion in the three acceptance files and the 123 table-driven BE-04 tests passed against backend/step-4 @23b3caf.

### 15.3 Gaps and observations (not defects)

1. **should-fix, backend-engineer (BE-04 slice 4b):** TC-012 cannot be tested. Publish in slice 4a checks completeness only; the reference solution is never run against the tests or variants, there are no variant routes, and the `ValidationReportSink` is not wired (FU-BEB-01, FU-BEB-07, FU-BEB-14). Until slice 4b a question with a wrong reference solution can be published. `POST /questions/:id/validate` (fsd.md section 4, permission `question:validate`) is not in the route matrix yet: when it lands, add it to the BE-04 list (the registry test will fail until then).
2. **should-fix, architecture hub (docs):** fsd.md section 4 lists only `GET/POST/PATCH /questions, /questions/:id` and `POST /questions/:id/validate` (role "Author"). The code and route-permissions.ts also serve publish, archive, unarchive, preview and the three test-case routes, and let RECRUITER read questions (ADR 0010 section 3). Add the rows and the read roles to the table.
3. **should-fix, qa-engineer / backend-engineer (TC-011, TC-013 session half):** no candidate or session route returns a question yet, so the candidate fetch of TC-011 and the "past session still shows the old version" screen of TC-013 are proven only through GET /questions/:id/preview, the recruiter read and the session_question pointer. Re-test both against the real candidate routes (BE-07, BE-11) and the review screen (BE-13).
4. **nit, qa-engineer:** FR-203 variant parameters and `validation_report` content, AI reference solutions are only exercised by the backend's own questions.e2e-spec.ts (Jest in apps/api/src, not in the QA gate's inputs). If the P1 gate should see TC-012 later, write it as `tc-012.int.test.ts` in the QA suite.
5. **resolved by decision (Backend A, DL-34):** recruiters and reviewers read published versions only (draft 404, same body as a missing id). Tests added in tc-010, tc-011, tc-013; they fail against @23b3caf (recruiter list shows drafts; recruiter `?version=N` reads a draft) until Backend pushes the restriction. The recruiter version allowlist in tc-011 is ASSUMED from the current DTO (DL-32 not on the branch).

### 15.4 Redaction case and later changes (2026-10-06)

- **Staff/recruiter redaction (extends TC-011)** is now TC-100 in docs/test-cases.md (hub-allocated; QA added the row). Tests are the ones titled "TC-100 (FR-202, FR-301, DL-32, DL-34)" in `tc-011.int.test.ts`. Backend head merged: PR #146 @84803fa (DL-32 exact key sets, DL-34 published-only, `revision` and `expectedRevision`, coding publish fails closed).
- **Planned, not written (no empty tests):** random picks for recruiters (FR-301, BE-06): no random-pick route or service exists on backend/step-4 @84803fa. When it lands, test it like the list: a draft-only question is never picked or counted, and a published v1 plus draft v2 picks v1 fields. The list has no search or status parameter; `q`, `search` and `status` are only checked to reveal nothing.
- **Pending hub decision FU-BE-109:** a published archived question is still readable by id by a recruiter (200, allowlisted keys). Tests assert today's behaviour and are marked; flip with one edit.
- **Test stand-in:** coding publish needs a passing validation of the current content (FU-BE-101); until the validate job (slice 4c) exists, tests record it directly in the database (`markValidated` in be03-routes.ts) and then publish through the API.
- Replaces the 15.3 #5 note on drafts visible to recruiters (resolved by DL-34).

## 16. QA-08 (2026-10-06): BE-06 slice 6a test builder (branch qa/be06a on backend/step-6a-tests @2493b6c; no PR, co-landed with the backend PR #147)

### 16.1 What was added

- The 4 routes (`GET /tests`, `POST /tests`, `GET /tests/:id`, `PATCH /tests/:id`) are in `BE03_ROUTES` as `step: 'BE-06'` (`BE06_DEFAULT = true`, no environment switch), so the registry test, the table-driven TC-004 (401 x 6 token kinds, 403 for AUTHOR and REVIEWER, success for RECRUITER and SUPER_ADMIN with an effect check, cross-org 404 identical to a random id, org B list and create leak nothing) and TC-006 (exactly one TEST_CREATED or TEST_UPDATED row with org, actor, IP, DB time, exact metadata `{questions, sections}` or `{fields}`, no name, title, description or reference solution in the row, no row for 400, 401, 403, 404) machinery drive them. One PATCH entry only: the audit test requires one action per entry and the route has one action. Fixtures: `testFixture` (owner role) in be03-routes.ts, `be06-helpers.ts` for the acceptance files.
- The TC-004 reviewer scenario is real: `TC-004: a reviewer (and an author) calling POST /tests directly gets 403, no test row is created and no audit row is written` in tc-004-rbac.int.test.ts. The old it.todo in tc-004.int.test.ts now covers only the BE-13 half (author on the verdict route).
- New files: `tc-020.int.test.ts` (24 + 1 todo), `fr-301-test-builder.int.test.ts` (106), `fr-301-test-builder-scope.int.test.ts` (14), `fr-301-test-builder-throttle.int.test.ts` (1: GET /tests answers 429 within 101 calls under the default limit). Both fr-301 files boot with `THROTTLE_DEFAULT_LIMIT=100000`: the default 100 requests a minute per IP (non-auth routes) makes a validation table of this size fail with 429.
- Full API integration run: 21 suites, 569 passed, 0 failed, 40 skipped (`[BE-13 pending]`), 3 todo. Lint, prettier and the API test typecheck are clean.

### 16.2 Verified vs Partial

- **Verified at API level (behaviour in the docs, ran and passed):** FR-301 create, read, list, PATCH (shapes, bounds, defaults, position ordering, section replacement, `used`, pagination, filters, 409 after an invitation or a session, same 404 for another org's used test), FR-302 profile (STANDARD and STRICT saved, LOCKDOWN 400 on create, PATCH and list filter), no copy, duplicate, clone, archive, unarchive, DELETE or PUT route (404), TC-004 and TC-006 and TC-008 for the 4 routes, TC-013 test side (pinned version), TC-100 test-builder half.
- **Partial: TC-020.** Configuration half only. Missing: starting 10 sessions and the distribution (needs BE-07 start flow and BE-11 sessions); recorded as `it.todo`. Also not covered: the pool is checked at SAVE time only; archiving or unpublishing a matching question later makes the saved test unsatisfiable and nothing in this slice notices. BE-07 must re-check at start and test it.
- **Partial: TC-004** (BE-13 half), **TC-006** (BE-13 review route), **TC-013** (session screen), **TC-008** (BE-13 and `/live`).

### 16.3 Defects

1. **FIXED 2026-10-06 (PR #147 @f52b232), was nit to should-fix, backend-engineer:** `GET /tests?search=` treated `%` and `_` as LIKE wildcards. Now escaped (also backslash); the former `it.failing` KNOWN DEFECT test is 4 plain tests `search wildcards are literal` in fr-301-test-builder.int.test.ts (%, _, backslash, controls). The same pattern may exist in other lists that use `contains` (questions, staff users): not checked.
2. No other defect. Every other assertion passed against @2493b6c.

### 16.4 Observations (not defects)

1. **Proposed test case for the hub (no id invented):** "FR-301, FR-302 | Test builder rules | Recruiter creates tests with duration 4 and 481, 21 sections, 51 questions in a section, pass score above total points, section limits above the duration, profile LOCKDOWN, a draft or archived question, another org's question version; then PATCHes a test that has an invitation | 400 for shape and bound violations, 422 for draft or archived questions and unsatisfiable rules, identical 404 for another org's version, 409 on PATCH after the first invitation or session; nothing saved on any refusal | F | P1". Until the hub allocates an id these tests are named `FR-301` / `FR-302` and are not counted in the P1 gate.
2. **SECURITY FINDING (FIXED 2026-10-06 in PR #147 @f52b232: draft version is now the identical 404, 422 only for a published version of an archived question; the 3 listed tests pass), owner backend-engineer (BE-06, `tests.service.ts` checkReferences):** a fixed slot naming a DRAFT version of the caller's own org answers 422, while a missing or other-org version answers 404. A recruiter can therefore confirm that a version id is a draft in the org, which DL-34 forbids (recruiters never learn drafts exist: the question routes answer 404 with the same body). Expected: a not-published version is the same 404, with a body identical to a missing id's (after removing the id and the per-request fields); only a published version of an ARCHIVED question stays 422. Reproduction: as a recruiter `POST /tests` with `sections[0].questions[0].questionVersionId` = a draft version id (author creates a question, does not publish), then again with a random UUID; compare status and body. Same on `PATCH /tests/:id` with `sections`. Tests that fail against @2493b6c until fixed (expected, not skipped), all in fr-301-test-builder-scope.int.test.ts: `FR-301 TC-100 (DL-34): a draft version is the same 404 as a missing version ...`, `FR-301 TC-100 (DL-34): PATCH with a draft version is the missing-id 404 ...`, `FR-301 TC-100 (DL-34): the recruiter finds attachable versions through the API itself ...`.
   - Backend follow-up text (for the hub to file in docs/followups/backend.md, QA does not edit it): "FU-BE-1xx (blocker, DL-34): TestsService.checkReferences returns 422 for an unpublished version of the caller's org; return the same NotFoundException as a missing version (same message and body) and keep 422 only for a published version whose question is archived. Update the controller's ApiUnprocessableEntityResponse text."
3. `POST /tests` with extra properties such as `orgId` or `createdById`: the test accepts either a 400 or an ignored property and asserts the row has the caller's org and creator. The actual answer is 400 (whitelist). If the hub wants "ignored" instead, nothing breaks.
4. The audit metadata keys for a PATCH are the DTO field names that were sent (`name`, `description`, `durationMinutes`, `profile`, `passScore`, `sections`), never values. Confirmed in tc-006 and in fr-301-test-builder.
5. fsd.md section 4 lists `/tests` for role "Recruiter"; ADR 0010 (and the code) also give SUPER_ADMIN test:read, test:create, test:update. Docs row should say "Recruiter, Super admin" (hub, docs).
6. Concurrency: one test races PATCH against an invitation insert (the backend locks the test row FOR UPDATE). It asserts the final state is one of the two consistent outcomes; a single run cannot prove the lock. The backend's own e2e spec holds the deterministic version.

## 17. QA-09 (2026-10-06): QUESTION_VALIDATION_FINISHED audit coverage (merged with backend PR #156, main @8d02635; branch qa/be04c-followup was co-landed, no separate PR)

- Convention (hub decision, ADR 0001 C-3 "jobs write rows with a null actor"): a QUESTION_VALIDATION_FINISHED row has `actor_id` NULL and `ip` NULL, metadata exactly `{system: true, initiatedBy: <starter user id>, startedAuditId: <id of the STARTED row>, version, outcome, revision (12 hex)}`. TC-006's "actor, entity, IP" applies to request-driven rows only. No open question remains on `ip`.
- Harness: the validate job runs against a harness port that rejects, so the outcome is ERROR on any machine (no JUDGE0_URL dependence); `h.setValidationPort(p)` swaps it per test (a deferred promise holds a job open). `ValidationService` is resolved once in `boot()`; `h.settleValidation()` / `settleValidation(h)` race `whenIdle()` against 30 s and fail with `SettleValidationTimeout`; `close()` is idempotent, waits for jobs and closes everything in try/finally. Called after every successful validate call in tc-004-rbac and tc-006-audit.
- tc-006-audit, `questions-validate`: the exactly-one check counts only STARTED; a separate test asserts the FINISHED row against the convention above (startedAuditId resolves to exactly the STARTED row of the same question, actor and org; outcome ERROR; revision equals the 202 body's `revision.slice(0, 12)`; version equals the 202 body's; no secrets); refused 401/403/404 write neither row after settle; a held job whose question is archived mid-run writes no FINISHED row (STARTED stays).
- Also: a fully passing stubbed run writes FINISHED outcome PASSED with the same job-row shape and sets `validatedAt`; `startedAuditId` is asserted to be a string equal to `String(startedRow.id)`. `h.resetValidationPort()` restores the default stub (`NO_EXECUTION_PORT`, defined once in harness.ts).
- With the backend's actor-null change merged (#156 @4532618) the FINISHED test passes; full API run 0 failures.

## 18. QA-08A (2026-10-06): outage tests that really reach the handler, shared throttle counters (branch qa/step-8, on main @6331019)

### 18.1 Why
Since #175 the global throttle guard keeps its counters in Redis and answers 503 "Service is temporarily unavailable." BEFORE any handler when Redis is down. The old outage tests (tc-003 `/2fa/verify` and `/2fa/disable`, tc-006-reissue) matched the substring "temporarily unavailable" and so would have stayed green if a handler regressed to fail-open. They now assert the handler's own text ("Verification is temporarily unavailable.", also for the re-issue, `UsersService.takeInviteSlot`) and the effects.

### 18.2 Harness (apps/api/test/support/harness.ts, test-only)
- `boot({ memoryThrottle: true })`: overrides the throttler storage with the in-memory `ThrottlerStorageService` (same pattern as auth-coldstart.e2e-spec.ts). Used only in the stop-Redis tests.
- `h.skipFreshnessCheck()`: finding from the mutation work. `JwtAuthGuard` calls `TokenValidityService.isFresh()`, which also needs Redis and throws the SAME "Verification is temporarily unavailable." for every protected route. So even with the memory throttle, `/2fa/disable` and the re-issue never reached their handlers with Redis stopped. This spies `isFresh` to true (that one check only) so the handler's own branch is what answers. Backend FYI: that is a third fail-closed layer whose message is indistinguishable from the handler's; if the owner ever wants the layers distinguishable, a different detail text per layer would let tests tell them apart without a spy.
- `boot({ join: h })`: boots a SECOND API instance against the infra, database and organization of an existing harness (shared Redis counters). `h.stopApp()` closes only that app (an API restart; infra stays). Closing a joined harness closes only its app.
- Flush: each `boot()` starts its OWN Redis container (`startInfra()`), so throttle counters could never leak between test files or suites even before this change. `boot()` now also runs FLUSHALL on a separate client right after the container starts (before the app, so the app's client stays cold for tc-003-coldstart); it is defensive. fr-301-test-builder-throttle (429 at call 101) was already order-independent for that reason.

### 18.3 Tests
- tc-003.int.test.ts: the outage describe is now its own file-level describe, booted with `memoryThrottle`, last in the file; fixtures are made, then Redis is stopped, then tests (a guard black-box test with no spy comes first; the recovery-code verify case was added in the re-review round): `/2fa/disable` (handler 503, 2FA still on, secret unchanged, failedLogins unchanged, refresh token not revoked, no AUTH_2FA_DISABLED row), `/2fa/verify` (no cookie, no accessToken, no session, no refresh row, failedLogins unchanged), `/2fa/enroll/confirm` (new: 2FA stays off, recovery hashes unchanged, no session), and no audit row from any of them.
- tc-006-reissue.int.test.ts: outage suite boots with `memoryThrottle` and `skipFreshnessCheck`; asserts problem+json, handler text, no cookie, token hash unchanged, no mail, no audit row.
- nfr-04-throttle-redis.int.test.ts (new; no TC id covers throttling, tests carry NFR-04 and FU-BE-1): two apps on one Redis (GET limit hit on A is 429 on B; login limit hit on A, B answers 429 even with correct credentials), key shape `throttle:{name}:{64 hex}` with a TTL and no address, email or token in any key, counters survive an app restart (third instance), and the ONE throttler-level test: with Redis down a public route (`POST /auth/login`) answers 503 problem+json "Service is temporarily unavailable." with no Redis, driver or address detail.
- Deviation from the task text: `GET /health` with Redis down does not answer 200. It is not throttled (@SkipThrottle) but reports the outage itself, 503 problem+json with detail naming redis (NFR-09, app.e2e-spec.ts). The test asserts exactly that and that the throttler body is absent.
- Note on keys: Nest's `ThrottlerGuard` derives the tracker key per handler (class, handler, throttler name, tracker), and the store hashes that with SHA-256; the test therefore checks the key SHAPE, not a hash it computes itself.

### 18.4 Mutation check (done locally, mutations reverted, not committed)
| Mutation (src, reverted) | Test that went RED |
| --- | --- |
| `UsersService.takeInviteSlot` catch sets `count = 0` (fail-open) | tc-006-reissue: the re-issue answers the handler 503 |
| `TotpService.verify` catch returns true AND `AuthService.withChallengeUse` catch sets `claimed = 'OK'` | tc-003 `/2fa/verify` and `/2fa/enroll/confirm` outage tests (and the audit-row test) |
| `TotpService.verify` catch returns true AND `TokenValidityService.invalidateIssuedTokens` swallows the error | tc-003 `/2fa/disable` outage test (2FA really switched off) and the audit-row test |
| `TotpService.verify` catch returns true ALONE | NOT red here, by design (two layers). `/2fa/disable` still fails closed because the Redis marker write inside its transaction throws (503, rolled back); `/2fa/verify` still fails closed at `withChallengeUse`. |
| `AuthService.withChallengeUse` catch sets `claimed = 'OK'` ALONE | RED (added in the re-review round): the new black-box test for the RECOVERY-code branch of `/2fa/verify` (that branch has no second Redis layer: no session, recovery code not consumed, failedLogins unchanged). The TOTP-code verify and enroll/confirm tests stay green (second layer, `TotpService.verify`). |
| `TokenValidityService.isFresh` catch returns true (JWT guard fail-open) | RED: new black-box test, no spy, valid recruiter token on `GET /tests` must be 503 problem+json "Verification is temporarily unavailable." (a fail-open guard would answer 200). |

Single-layer regressions of the two-layer routes are covered by the backend's own tests, one layer each: auth.e2e-spec.ts:861 (TOTP replay marker), :881 (challenge claim), :2031 (`invalidateIssuedTokens` on `/2fa/disable`), :2416 (TOTP marker failing for `/2fa/disable`). QA's black-box tests cover the combined behavior. Uncovered spots, recorded for the backend owner: the two layers of `/2fa/enroll/confirm` are not tested one at a time (QA's test only proves the combined fail-closed result), and the recovery-code branch of `/2fa/verify` is protected only by `withChallengeUse` when Redis is down (now covered black-box by QA, not by a backend test). The `skipFreshnessCheck` spy is asserted (`toHaveBeenCalled`) in the disable and re-issue tests, so a refactor that stops it taking effect turns them red; verify and enroll/confirm are public routes that never call `isFresh`, so no spy is used there.

N3 (backend-owned, not edited here): the env reset list in `apps/api/src/test/containers.ts` `applyEnv` (`ENABLE_API_DOCS`, `TRUST_PROXY_HOPS`, `THROTTLE_AUTH_LIMIT`) does not clear the other THROTTLE_* variables, so a test that sets `THROTTLE_DEFAULT_LIMIT` or `THROTTLE_TTL_MS` leaks them into later apps in the same process. QA's harness overrides per boot; the owner may add them to the list.

Full API integration run after the change: 23 suites passed, 718 tests passed, 40 skipped (staged BE-13), 3 todo, 0 failures. Lint, API test typecheck, prettier and the QA package tests (46) are green.

### 18.7 Defects
None found in application code. Observation for the backend owner: the identical wording across the JWT guard, the handlers and the transaction marker makes outage regressions hard to localise (see 18.2).

## 19. QA-10 (2026-10-06): backend pilot PR D auth tests (branch qa/pilot-pr-d on backend/pilot-pr-d-auth @b18e5b7f; no PR, co-landed with backend PR #184)

- Closes FU-BE-143: `expectDisableReauthFailed` and `DISABLE_REAUTH_DETAIL` ('The password or code is incorrect.') in `apps/api/test/support/harness.ts`; the seven failing tc-003 tests use it. `expectReauthFailed` and the old detail stay for reset, regenerate, setup, unlock, re-issue and the table-driven routes. The locked-admin test now compares bodies within each route (disable no longer matches reset and regenerate) and asserts `code` REAUTH_FAILED everywhere.
- New `tc-003-stale-enroll.int.test.ts` (FU-BE-86): stale forced-enrollment challenge after a password reset or deactivation is 401 on enroll/start and enroll/confirm and changes nothing; TOTP enabled meanwhile is 409. Gap (not black-box testable): the read-to-write race inside the service; the backend e2e spec covers it. These black-box tests also pass on the old code (resolveChallenge already checked the password version), so they guard behaviour, they do not prove the new conditional write.
- New `tc-098-counters.int.test.ts` (FU-BE-64): forgot and invite-slot limits unchanged, counters have a TTL, a key whose TTL was removed with PERSIST is repaired by the next hit. Only these two counters use the atomic script; the login limit is the database reservation and the throttler, so there is no "login counter" test here (covered by tc-002 and nfr-04).
- Full API integration run: 25 suites, 732 passed, 0 failed, 40 skipped (`[BE-13 pending]`), 3 todo (run on the merge with backend @b18e5b7f and main).
- Defects: none.
- Conflict note: PR #182 (qa/step-8) also edits harness.ts and tc-003; this branch only adds a harness export block before `stableProblem`, and edits the disable tests and the locked-admin test in tc-003. Docs hub follow-up FU-BE-144 (api-contract.md and frontend dialog copy) is not QA's.
- Not testable from outside: the disable branch where the password changes mid-request (`explainRefusedChange`, auth.service.ts ~:663, must be the fixed disable detail). The backend spec auth.e2e-spec.ts (~:2796, 'disable and regenerate that race a password change') covers it with a hook.
- Open QA follow-ups from the review (should-fix, next QA PR): (1) tc-098-counters invite key hour rollover: wait until at least 30 s before the next hour and assert the exact key `invite:org:<org>:<floor(now/3600000)>` instead of a pattern scan; (2) tc-003-stale-enroll: use a real pending secret (a started enrolment) so 'nothing changes' proves the secret is not replaced, and make the 'even with a correct code' premise real (the code must match the stored secret); (3) tc-003-stale-enroll: count audit rows over all rows (not only actorId) and assert failedLogins and lockedUntil unchanged.

## 20. QA-11 (2026-10-06): revision returned from every question-bank content write (branch qa/revision-in-responses on backend/revision-in-responses @736302a3; no PR, co-landed with the backend PR)

- Harness: `apps/api/test/support/be03-routes.ts` entries questions-testcase-remove, variants-remove and variants-override-remove now expect `ok: [200]` (were 204). The 9 failures against the branch (tc-004-rbac for SUPER_ADMIN and AUTHOR on the three routes, tc-006-audit for the three) pass.
- New `apps/api/test/integration/tc-100-revision.int.test.ts` (6 tests): per-write value checks, round trip and stale 409, exact `{revision}` DELETE bodies, content PATCH top-level and `version.revision`, refused writes unchanged, recruiter never sees a revision, other org 404. The recruiter allowlisted keys in tc-011 are unchanged and still pass.
- Full API integration run, unfiltered (`jest -c test/jest.integration.config.js --runInBand --forceExit`), Jest summary: `Test Suites: 26 passed, 26 total; Tests: 40 skipped, 3 todo, 738 passed, 781 total`. 26 files match `*.int.test.ts`; none failed to run. The first report said "18 suites, 376 passed"; that figure came from a JSON report that listed only 18 files and was wrong (I could not reproduce it; the rerun shows 26). Review round: recruiter variant preview now asserts 200 with the rendered variant as positive control, the recruiter variants list is exactly 403, a tag-only edit keeps the same revision, the cross-org sweep covers variant POST, override PUT, override DELETE and variant DELETE. `computed inside the transaction` is code-verified only. Lint, API typecheck, test tsconfig typecheck, prettier and the QA package tests (46) pass.
- Defects: none.
- Observation (nit, backend-engineer): GET `/questions/:id/versions/:v/variants/:variantId/preview` is `question:read`, so a recruiter gets 200 for it; it is a candidate-level rendering and the test asserts it carries no revision, override or reference data. Keep it that way if the preview shape changes.

- Merged backend/revision-in-responses @03155433 (was 736302a3): refactors only for writers. Content PATCH and test-case POST/PATCH no longer take a `full` flag (writer-only, always the full view; `revision` read from `version.revision`), variant mutations use `currentRevision`, the three DELETE handlers lost `async`, and backend specs gained value checks. No change to revision keys, DELETE bodies or recruiter views; tc-100-revision and be03-routes needed no edit.
- Open QA follow-ups from the review of 24180dca (nits, test code not changed yet): (1) the tc-100-revision cross-org sweep titled "every revision-returning write" omits test case PATCH and variant PATCH: add them or soften the title; (2) the cross-org 404 loop does not scan bodies for leaked content: add `expectNoneOf(res, [...SECRETS, OV_IN, OV_OUT])`; (3) the "positive control" comment in the recruiter test (~lines 336-337) overstates what it checks (only that the writer GET of `/questions/:id` has a 64-hex revision).

## 21. QA-12 (2026-10-06): registry spec learns the CANDIDATE route variant (FU-BE-91; PR #197, branch qa/step-9)

- Cause: tc-004 'route registry matches the QA list' assumed every ROUTE_PERMISSIONS entry is `public` or has `roles`; backend PR #98 (BE-07) adds `{principal: 'CANDIDATE', permission}` entries and the spec rejected the unknown `principal` member.
- Change (QA files only): `loadBackendRegistry` also returns `CANDIDATE_BOOTSTRAP_ROUTES`; new `isCandidateEntry` / `isStaffEntry` guards; new `CANDIDATE_ROUTES` list in `apps/api/test/support/be03-routes.ts`, filtered by `backendHasRoute` so it is green on main now and after #98 merges. It is consumed only by the registry test, so the staff 401/403/404/audit loops (BE03_ROUTES) are untouched (candidate routes use candidate tokens).
- New tc-004 assertions: CANDIDATE entries have exactly `principal` and `permission` (a `candidate_*` permission from packages/shared), registry `roles` empty, `audited` false, `candidatePermission` equal; a `/candidate/` route listed 'public' must be in CANDIDATE_BOOTSTRAP_ROUTES and each bootstrap key is listed 'public'; staff entries never carry a `candidate_*` permission or a non-staff role or @CandidateRoute; a candidate route in the matrix that QA does not list fails (new BE-07..BE-11 routes need a CANDIDATE_ROUTES line). Shared-matrix leak guard (always-run block, no app boot): no staff UserRole holds any `candidate_*` permission, CANDIDATE holds exactly the `candidate_*` permissions and nothing else.
- Expected candidate list on #98 (head 1be14eb6): 3 bootstrap public routes (POST /candidate/session/link, /otp, /start) and 7 CANDIDATE routes (GET /candidate/session/consent candidate_consent:read; POST .../consent/sign candidate_consent:sign; POST .../consent/decline candidate_consent:decline; GET /candidate/session candidate_session:read; POST /candidate/session/test/start candidate_session:start; POST /candidate/session/heartbeat candidate_session:heartbeat; POST /candidate/session/proctor-key candidate_session:key).
- Behavior tests of the candidate routes (candidate tokens, 401/403, session states) are a separate QA step once #98 is merged; this PR is registry agreement only.
- Review round (code-reviewer on 4f1dd368): the per-entry logic now lives in the pure helper `candidateRegistryProblems` (be03-routes.ts). The registry test asserts `[]` on the real data and that the QA list count equals the matrix candidate count; an always-run block feeds the helper synthetic matrices (extra roles/audited key, non candidate_ permission, @CandidateRoute mismatch, roles or @Audited on the route, public /Candidate/x outside bootstrap, staff entry with a candidate permission, unlisted candidate key, clean matrix) so the check is live on main where the candidate sets are empty.
- Follow-up (after #98 merges): make `CANDIDATE_ROUTES` unconditional (or add `BE07_DEFAULT = true`) so a dropped candidate route fails instead of silently leaving the list.

## 22. QA-10 (2026-10-06): candidate route list grows (BE-08b, BE-09, BE-11) and registry check hardening (branch qa/step-10)

- `KNOWN_CANDIDATE_ROUTES` (apps/api/test/support/be03-routes.ts) now also lists, each filtered by `backendHasRoute` so main stays green: BE-09 `POST /candidate/session/media/presign` and `.../media/confirm` (both candidate_media:presign; PR #119, branch backend-cand/be-09-media); BE-08b `POST /candidate/session/identity/presign`, `POST /candidate/session/identity`, `GET /candidate/session/identity` (all candidate_identity:upload; the status read reuses the upload permission, shared has no candidate_identity:read; PR #129 head 2e1aae58); BE-11 `POST /candidate/answers/:questionId/run` (candidate_answer:run), `.../submit` (candidate_answer:submit), `PUT .../draft` (candidate_answer:draft), `POST /candidate/session/finish` (candidate_session:finish), `POST /candidate/session/section/finish` (candidate_section:finish) (registered on PR #187, branch backend-cand/be-11-run-submit, B-3 gated). Keys and permissions were read from each branch's route-permissions.ts and exist in packages/shared PERMISSIONS.
- Not listed: BE-08c `POST /candidate/session/identity/recheck` (not built).
- Hardening: `isCandidatePath` is exported and reused by the registry test; the two `as never` casts are gone; new always-run synthetic tests for principal not CANDIDATE, unknown `candidate_bogus:x`, a candidate key the backend does not serve, a staff route (GET /tests) with @CandidateRoute, and a bootstrap key outside /candidate/ listed public. Mutation check (each check neutralised in the helper, one at a time, restored): all five turned exactly their own test red.
- Overlay evidence: scratch merge of origin/main into #129 head 2e1aae58 plus these test files: 'route registry' 4 passed, all 3 identity keys listed (plus media, via #129's stack); removing the `GET /candidate/session/identity` list line failed the registry test naming that route; tc-004-rbac and tc-006 files: 4 suites, 437 passed, 0 failed. Full API integration run on this branch (main): 26 suites, 752 passed, 0 failed, 40 skipped (BE-13), 3 todo.
- Open follow-up: make `CANDIDATE_ROUTES` unconditional (drop the `backendHasRoute` filter) once #98, #119 and #129 (and #187) have merged, so a dropped candidate route fails instead of silently leaving the list.
- Reminder: the BE-08c re-check route and each BE-10 and BE-12 or later candidate route need a line in `KNOWN_CANDIDATE_ROUTES` when they land (the registry test fails on an unlisted candidate route).

## Deploy check: AWS credential sources on pilot and production (hub, 2026-10-06; from Backend A #203)

Defence in depth beside the API's own boot refusal (static AWS keys, `AWS_PROFILE`, `AWS_SHARED_CREDENTIALS_FILE` and `AWS_CONFIG_FILE` are refused in pilot and production, and so is `EMAIL_PROVIDER=noop`). The deploy workflow or the host provisioning check (QA or DEP-03) also refuses, on pilot and production hosts: the environment variables `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`, `AWS_CONTAINER_CREDENTIALS_FULL_URI`, `AWS_WEB_IDENTITY_TOKEN_FILE` and `AWS_ROLE_ARN`, and any `~/.aws` directory (credentials or config files) for the service user. The SDK default chain must end at the EC2 instance role (IMDSv2) and nothing else. DEP-01 and DEP-03 add the check to the go-live checklist (DEP-02).

## DEP-01 PR 1 and PR 1b (deploy track, files under qa)

| ID | Type | Owner | Item |
| --- | --- | --- | --- |
| FU-QA-13 | should-fix | QA / Deploy | Verify at the owner's first apply (infra/aws/README.md, "Things to verify"): (1) ECR push by the CI role on `codeproctor-pilot-*` repositories and the manifest `s3:PutObject` on both prefixes; (2) Object Lock enabled at bucket creation with GOVERNANCE 12 days works with versioning, and a lifecycle expiry of a locked version is skipped and happens after the lock ends (modelled offline, not exercised; UNVERIFIED); (3) the Lambda function can be created with the expiry role (its trust has no `aws:SourceArn` or `aws:SourceAccount` condition by design; this is a verification note); (4) the freshness, 28 day and anomaly alarms fire (needs the metric producers); (5) browser PUT through the media CORS rule including `x-amz-tagging`; `Content-Range` and `Accept-Ranges` exposure if playback uses fetch or MSE; (6) the instance role can start with an encrypted EBS volume (aws/ebs) and a scheduled start works (owner instance template); (7) `get-role` shows no wrong role and every `codeproctor-pilot-*` role is tagged `pilot` (owner roles) or `owner`; (8) whether IAM rejects `hostedzone/` for an empty `AssessHostedZoneId` (use a sentinel zone id if so); (9) `RetentionService` startup reads versioning and lifecycle on the media bucket; (10) presigned URLs signed by the instance role work with the bucket policies (they stop working when the instance-role credentials that signed them expire); (11) Object Lock needs Content-MD5 or a checksum on every upload and part, and `aws s3 cp` switches to multipart above 8 MB: the uploader must use a single `put-object` or a raised threshold; (12) the alarmed metrics are published with NO dimensions (the alarms have none; with dimensions the notBreaching anomaly alarms never see data); (13) do pgBackRest or WAL-G send Content-MD5 or a checksum on every part on an Object Lock bucket; what a failed or resumed backup does when it cannot delete its partial files (AccessDenied): for the database track's brief; (14) conditional write on the erasure prefixes against real S3: a `put-object` without `--if-none-match` under `db/erasure-list/` and `db/erasure-completed/` is denied, the same with `--if-none-match '*'` passes, a second one for the same key returns 412, multipart under those prefixes is denied, and `If-None-Match` behaviour when the key's current version is a delete marker (`simulate-principal-policy.sh` does not model bucket policies for the instance role, so only a live put proves this); (15) daily-period alarms with missing data breaching may flap between the period boundary and the Lambda's run: consider EvaluationPeriods 2 with DatapointsToAlarm 2 and a matching threshold; (16) `ec2messages` is not needed for Session Manager registration. |
| FU-QA-15 | should-fix | backend (BE-09), architect | Face-image backstop (C-27, C-35): the media bucket lifecycle expires objects tagged `RetentionClass=face` 88 days after the object was created (infra/aws/pilot-data-buckets.yaml). The API must tag them: `x-amz-tagging: RetentionClass=face` on the identity presign (ID image, selfie, re-check frames) and `TaggingDirective` with the tag on the sealing CopyObject, and the same tag on `evidence/sealed/` frames. The sealing CopyObject creates a new object, so the clock restarts at sealing: the real bound is capture-to-seal delay + 88 days + up to 1 day S3 rounding, not a hard 90 days from capture (RetentionService is the real clock). BE-09, BE-13 and the worker presign path must treat a 404 on a face key as already deleted. Until then the rule matches nothing and RetentionService alone enforces the cap. |
| FU-QA-16 | should-fix | QA / Deploy | The Session Manager log group (`codeproctor-pilot-*`, owner template) must have a finite retention (14 days, ADR 0017 5.3) and session use must not print secrets or candidate data. |
| FU-QA-17 | nit | architect | Later hardening (not made after review sign-off): explicit denies on `ssm:CreateAssociation`, `ssm:StartAutomationExecution`, `ssm:ResumeSession` and `ec2-instance-connect:*` are now moot for the CI role (it denies `ssm:*` and `ec2-instance-connect:*` wholesale); keep them in mind for the owner-side roles. |
| FU-QA-18 | should-fix | database (DB-07, Database B #240) | `infra/backup/backup.sh` (timestamped keys, script-side pruning, `delete-object`) and `infra/backup/erasure-list.sh prune` (`delete-object`) do not match ADR 0017 5.3. The instance role has no `s3:DeleteObject` or `s3:DeleteObjectVersion` on the backup bucket and the bucket is versioned with Object Lock. The script must write every dump to the one key `db/dump/latest.dump` in a single `PutObject` carrying checksum and row counts, publish `BackupSuccess` only, in the namespace `codeproctor-pilot-instance` (secondary signal), and never delete. The alarmed metrics are NOT the uploader's: the owner-applied expiry Lambda is the only producer of `NewestDumpAgeHours`, `DumpSizeChangeFactor` (max(new/old, old/new), always >= 1), `DumpVersionsPerDay`, `FullBaseBackupCountChange` (absolute change) and `OldestKeptBackupAgeDays` in `codeproctor-pilot`, computed from `ListObjectVersions` (Size, LastModified), because a compromised instance could keep publishing normal values. S3 user metadata is capped at 2 KB: if the per-table row counts do not fit, the single PutObject must carry a packed tar of the dump and a manifest under the SAME key `db/dump/latest.dump` (R-1's NotResource allows only that key; a sidecar key under `db/dump/` would be denied), so atomic packing, not a sidecar, is the rule; compact or compressed counts are the other option. The erasure-list and erasure-completed entries must be written with `--if-none-match` (the bucket policy denies an overwrite without it, only under those two prefixes), and an entry counts as present if any version of it was ever non-empty (restore and prune). NO role other than `codeproctor-pilot-backup-expiry` may `PutMetricData` into `codeproctor-pilot` (the main, Judge0 and restore roles too): their `cloudwatch:PutMetricData` must be limited to `cloudwatch:namespace` = `codeproctor-pilot-instance` in the owner templates. All metrics are published with no dimensions. The Lambda-fed alarms have a 1 day period, so the Lambda must run (and publish) daily. The erasure-list prune moves to the owner-applied expiry function (its role `codeproctor-pilot-backup-expiry` exists in the data template). `BACKUP_SSE` must be empty on pilot (bucket default SSE-KMS; `AES256` and `aws:kms` without a key id are denied); `docs/runbook.md` and FU-DBB-06 still recommend `AES256`. **Rollout rule:** the data stack must not be applied for pilot use until `erasure-list.sh` writes with `s3api put-object --if-none-match '*'` (not `aws s3 cp`) and treats a 412 as "already recorded" (a 409 ConditionalRequestConflict from concurrent writes to the same key must be retried, never treated as success; any other error fails loudly, so an erasure can never go unrecorded) (append is idempotent and re-puts the same `<stamp>-<uuid>.json` key). |
| FU-QA-19 | should-fix | database, hub | Physical repository (pgBackRest or WAL-G, full base backups only) under `db/wal/`: no lifecycle rule exists; the owner-applied expiry function keeps everything younger than 12 days plus the newest 3 full base backups and the WAL from the oldest of them. The tool's metadata files (`archive.info`, `backup.info`) are rewritten in place: with versioning on, the instance role keeps its put, and the function must not delete metadata a kept backup needs. The function, its daily schedule and ALL the alarmed metrics (see FU-QA-18) belong to a later owner template (code by the database track). The expiry role may delete only under `db/wal/`, `db/erasure-list/` and `db/erasure-completed/` (a bucket-policy deny covers `db/dump/`). The expiry role has no KMS and no GetObject, so it cannot read pgBackRest `backup.info`/`backup.manifest` to find the WAL start of the oldest kept base backup: either choose WAL-G (the start segment is derivable from key names) or add a narrow GetObject on the metadata keys plus Decrypt via S3, with an ADR note. The function must delete by version id (`DeleteObjectVersion` for every version, clean up delete markers, never delete a noncurrent version that belongs to a kept backup); a compromised instance can overwrite a kept base backup's files without changing `FullBaseBackupCountChange`, so the function should also compare sizes or checksums of kept files. The erasure-list pruning rule, ADR 0017 5.3 "Erasure-list pruning" (PR #244), word for word: The expiry function prunes an erasure-list entry only when its completion marker (under `db/erasure-completed/`) is more than one day older than the oldest dump version or full base backup that still exists in the bucket, current or noncurrent, including versions still under Object Lock or waiting for lifecycle expiry (not only "the newest 3"). It never prunes an entry that has no completion marker (ADR 0004 section 9.7, runbook). Every backup taken between the request and the completion still holds the person's data, so the age of the request alone is never the test. The ADR 0015 redaction list and the R-7 re-application log are stored under the same two prefixes and follow the same rule (the database track pins their keys; a key outside the four allowed prefixes would be blocked by the write confinement above). The function also alarms on any object under those two prefixes that does not match `<stamp>-<uuid>.json` or is larger than a small size, so a compromised host cannot keep a dump alive there. The instance role is denied `s3:PutObject*` outside `db/dump/latest.dump`, `db/wal/*`, `db/erasure-list/*` and `db/erasure-completed/*`. Defence in depth for erasure entries: an entry counts as present if ANY version of it, current or noncurrent, was ever non-empty (the union of versions), in the restore and in the prune rule. Detection gaps for the expiry design: (a) at the default of 6 an attacker can push 3 junk dump versions in a day without tripping `DumpVersionsPerDay`, and the size alarm is defeated by matching the size (the lock keeps the real dumps but nothing pages); (b) the function decides "the newest 3 full base backups" from key listings it cannot verify (no GetObject): fake base backups spread over several days stay under `MaxFullBaseBackupCountChange` and could steer it into deleting real ones after 12 days: use a signed or owner-held base-backup inventory. Requirement on that template: no `codeproctor-*` role may hold `iam:PassRole` on the expiry role or `lambda:CreateFunction`, `UpdateFunctionCode` or `UpdateFunctionConfiguration`. |
| FU-QA-20 | nit | hub | ADR 0017 sections 5.1 and 5.3: (a) with `NoncurrentDays` 1 and `NewerNoncurrentVersions` 2 a dump outside the newest 3 goes at the later of creation + 12 days (Object Lock) and replacement + 1 day, so the "within 14 days" and "13 days" wording should say 12; (b) the Object Lock floor does not protect dumps older than 12 days: if backups stall more than 12 days and 3 junk versions then land, the displaced real dumps expire at once (offline model case); only the alarms help; (c) the second alarm is 28 days for a kept backup (ADR) against a 30 day alarm on the newest dump (Delivery Lead): 28 used; (d) day 30 is the owner's decision, nothing deletes automatically. |

## 23. QA-13 (2026-10-06): LOAD TEST PLAN, pilot capacity: 5 concurrent candidates on two instances (branch qa/step-11; plan only, nothing is built or run)

> **GATE.** The 5-candidate load test on the REAL instances (step 2 below) is the gate before the first real candidate (C-43, C-44..C-48). A failed run, a skipped run, or a run whose evidence package is incomplete BLOCKS the first real candidate, unless the owner waives the failed criterion by ID in the sign-off line (23.9); QA never waives; a skipped run cannot be waived. Only the owner signs it off, from the evidence package (section 23.9); QA recommends, the owner decides. Step 1 (local) is an estimate and never satisfies the gate. **Decision record:** the topology (two instances), "identity LIVE", the slot-at-invite flow and the one KMS key come from decisions C-44..C-48 relayed by the Delivery Lead; they are recorded in ADR 0017 (draft PR #237 / FSD #236), final once merged (this branch's docs/compliance/decisions.md stops at C-43). The gate run is only valid once ADR 0017 is accepted: Q13.

### 23.1 What is being proven

| Item | Value |
| --- | --- |
| Source | C-43 (minimal-cost single-schedule AWS pilot) as amended by the owner decisions C-44..C-48 (relayed by the Delivery Lead 2026-10-06: two instances, identity face match stays live; recorded in ADR 0017 (draft PR #237 / FSD #236), final once merged, Q13) and DL-39 (QA A owns packages/qa/k6). C-43 says "the load test proving 5 concurrent candidates" is open until done. NFR-02 and TC-090 stay the 200-candidate case, unchanged (docs/fsd.md says 200; hub answer, Q1); this run is the NEW case TC-105 |
| Topology (relayed by the Delivery Lead; recorded in ADR 0017 (draft PR #237 / FSD #236), final once merged, Q13) | **App host**: one x86 instance, 2 vCPU / 8 GB (m7i.large class): API, worker, Postgres 16, Redis, Caddy. **Judge0 host**: its OWN small isolated instance (Judge0 server, workers, its own Postgres and Redis; ADR 0016 section 3 rules). The app host reaches Judge0 over a private path only. **k6 runner**: a third machine, on neither host |
| Pass (NFR-01, TC-105) | API p95 < 300 ms excluding code execution; run result p95 < 5 s measured end to end through the Judge0 instance including the network hop; zero errors; no OOM kill and no restart of any container on either host |
| Not proven by this run | The 200-candidate figure (TC-090 as written), real browsers, real media bytes, AI/similarity analytics (23.12 Q4), disaster behaviour beyond the failure injection in 23.9 |

### 23.2 Definitions (so the plan is usable without the conversation)

- **Virtual candidate (VC)**: one k6 virtual user bound to one seeded session with its own bearer token and batch key. While identity is live the gate sessions are seeded to CONSENTED (not IN_PROGRESS); the VC does the identity step (I1, which needs the synthetic or licence-clear image set of Q8), waits for VERIFIED and calls start-test itself, so it is IN_PROGRESS only from stage 2 on. With the identity waiver, or against the mock, sessions are seeded IN_PROGRESS and I1 is skipped. Runs are limited to 1 per 5 s per candidate (FR-502), so VCs never share a session.
- **Live view**: FR-903 and architecture.md: the staff app's live grid of active sessions, fed by the Socket.IO channel `WS /live` (fsd.md section 4, role Reviewer: live sessions, events, pause or message) plus the latest webcam thumbnail. In this plan a "live view subscriber" is one staff Socket.IO client connected to `/live` and subscribed to the org's active sessions. Model: 1 recruiter plus 1 reviewer (2 subscribers) for the whole run. The protocol and the thumbnail source are not decided (OI-2, Q-20 in ADR 0013 section 5.3; BE-13 is not built): the definition in 23.4 row L1 is a PROPOSAL to confirm (23.12 Q3).
- **Seeder**: packages/qa/k6/seed (QA B draft PR #99, head 47d7ac9e; QA A re-lands it as a superseding PR on its own branch per DL-39). Prerequisite for this plan, see 23.7.

### 23.3 Two-host resource budget (used by both steps)

The app host and the Judge0 host are measured separately. Neither may OOM, restart or swap.

App host (2 vCPU / 8 GB). Proposed split for the portable (per-service) cap; on a real instance the services share the pool:

| Service | Memory limit | CPU quota (sum 2.0) | Notes |
| --- | --- | --- | --- |
| postgres (16) | 2048m | 0.5 | `shared_buffers=768MB`, `effective_cache_size=3GB`, `max_connections=60`, `work_mem=8MB`, `shared_preload_libraries=pg_stat_statements` (load-test DB only). Candidate-write pool plus main pool stay under 60 (ADR 0013) |
| redis | 384m | 0.1 | `maxmemory 256mb` (NOT in infra/docker-compose.yml, which sets only `--appendonly yes --maxmemory-policy noeviction`; the override in 23.8 adds it), policy `noeviction` (BullMQ), AOF on |
| api (Node) | 1536m | 0.8 | `--max-old-space-size=1024` |
| worker (Python 3.12) | 2048m | 0.6 | Identity face match is LIVE (C-44..C-48): model memory plus bursts when 5 candidates reach the gate together. Anything else the worker runs during the test is open (23.12 Q4) |
| Caddy, dockerd, OS | about 2.1 GiB (not capped; the four caps above sum to 5.875 GiB) | none | What is left of 8 GB: page cache, kernel, Caddy, CloudWatch agent |

Judge0 host (own instance; size is an open question, 23.12 Q5). Assumed for the plan: 2 vCPU, 4 GB (c7i.large class, as ADR 0016 section 3 staging row) with the t3.medium class as the cheaper option to be tested only if CPU credits are measured (23.12 Q5):

| Service | Memory limit | Notes |
| --- | --- | --- |
| judge0-server (Rails) | 640m | no candidate code runs here |
| judge0-worker (`COUNT`=2) | 1536m | privileged, isolate; each sandbox up to `MAX_MEMORY_LIMIT` 512 MB; this is where run and submit CPU is spent |
| judge0-db, judge0-redis | 384m, 128m | separate from the application's Postgres and Redis (infra/judge0/docker-compose.judge0.yml) |

### 23.4 Per-virtual-candidate scenario and expected rates

Cadences come from FSD, ADR 0013 section 5 and the SDK; "Built?" is the status on `main` @144020e0 or on an open PR branch (see 23.6).

| # | Activity | Cadence (per VC) | Route | Req/s per VC | Built? |
| --- | --- | --- | --- | --- | --- |
| H1 | Heartbeat (FR-609) | 10 s | `POST /candidate/session/heartbeat` | 0.100 | BE-07 PR #98 (open) |
| E1 | Event batch, 2 events (FR-601..; signed) | 5 s | `POST /candidate/session/events` | 0.200 | BE-10 not built; mock only |
| K1 | Keystroke batch, 10 edits (FR-608; signed) | 2 s | `POST /candidate/session/keystrokes` | 0.500 | BE-10 not built; mock only |
| A1 | Draft autosave (FR-504: every 10 s and on every run) | 10 s plus each run | `PUT /candidate/answers/:questionId/draft` (about 1 to 4 KiB code; body cap 16 KiB) | 0.117 | BE-11 PR #187 (open, B-3 gated) |
| M1 | Media presign + confirm, 3 streams (SCREEN, WEBCAM, AUDIO) | 10 s per stream | `POST /candidate/session/media/presign` then `.../media/confirm` | 0.600 | BE-09 PR #119 (open) |
| R1 | Code run: 3 sample tests (one Judge0 batch of 3 sandboxes) | once a minute | `POST /candidate/answers/:questionId/run` | 0.017 | BE-11 PR #187 (open); Judge0 wiring: BE-05 branch, not main |
| S1 | Submit: hidden tests (assumed 5 tests, weights 1,1,2,2,4, TC-048) | 1 per 5 min, staggered | `POST /candidate/answers/:questionId/submit` | 0.003 | BE-11 PR #187 (open) |
| I1 | Identity gate (live): ID presign, selfie presign, confirm, status | once at start of the run (burst, 5 VCs inside 30 s) | `POST /candidate/session/identity/presign`, `POST /candidate/session/identity`, `GET /candidate/session/identity` | burst only | BE-08b PR #129 (open); worker face match: integrity-id/be-08-worker-face branch, not main |
| I2 | Identity re-check (every 120 s) | 120 s | `POST /candidate/session/identity/recheck` (plus presign) | 0.017 | BE-08c not built; optional |
| F1 | Finish | once at the end | `POST /candidate/session/finish` | n/a | BE-11 PR #187 (open) |
| L1 | Live view: 2 staff Socket.IO subscribers on `/live`; each VC raises 1 HIGH event a minute that fans out; thumbnail read every 10 s per session (source undecided) | continuous | `WS /live`, thumbnail route TBD | 2 sockets; 5 HIGH events a minute to 2 subscribers is about 0.17 pushes per second in total; thumbnails about 1.0 req/s in total if each subscriber reads them | BE-13 not built |

Totals. Steady-state API requests per VC: 0.100 + 0.200 + 0.500 + 0.117 + 0.600 + 0.017 + 0.003 (+ 0.017 with I2, presign and re-check together) = **1.54 per second (1.55 with I2)**. For 5 VCs that is about **7.7 requests per second**, plus L1 thumbnails about 1.0 per second, so **about 9 per second** (storage PUTs: 3 streams x 6 a minute x 5 VCs = 90 a minute, 1.5 per second, from the runner, not on either host). The offered load is small; the risks are CPU contention (Judge0 submit bursts on the Judge0 host, face match on the app host), Postgres lock waits (503 `BUSY`, DL-37) and memory. The headroom stage in 23.5 therefore also runs 10 and 15 VCs; those figures are informational, never part of the gate.

Why the storage PUTs stay in k6: `confirm` HEADs the object and answers 409 `UPLOAD_NOT_FOUND` if it is missing (ADR 0013 5.5), which would break "zero errors". The existing scripts PUT tiny objects (default 256 KiB video, 64 KiB audio; use 64 KiB for all in this run) from the runner to the bucket. That costs neither host anything (about 0.3 PUT/s per VC from the runner). The Delivery Lead brief said k6 does NOT upload; if the owner insists, `confirm` must be left out of the scenario and its coverage is lost: Q6.

### 23.5 Stages (identical in both steps)

| Stage | VCs | Duration | Purpose | Counted in the gate? |
| --- | --- | --- | --- | --- |
| 0 Pre-check | 0 | 15 min before; sessions are seeded right after it (precondition 7) | stack healthy, sampling started, `docker events` capture started, restart/OOM baseline recorded | no |
| 1 Identity burst | 5 (sessions seeded CONSENTED) | 2 min | all 5 do I1 (identity) inside 30 s and reach VERIFIED (the gate comes before the test, as in a real slot). Worker CPU, queue depth, face match latency | yes |
| 2 Ramp | 1 to 5 | 2 min (one more VC calls start-test every 30 s) | warm-up (JIT, pools, caches); a staggered start is lighter than a real simultaneous start, which stage 5 and the headroom stage cover | yes in the whole-run figures, but see PC-1 (stage 3 alone) |
| 3 Steady | 5 | 15 min (step 1: 10 min is acceptable) | the gate measurement | yes |
| 4 Soak | 5 | default: the longest pilot test length plus its grace (for example 90 + 10 = 100 min); reduced option: 10 min, only if the owner accepts it (Q10). Directly after steady, no restart | leaks: memory, connections, queue growth | yes |
| 5 Run burst | 5 | 12 rounds, 1 per minute, all 5 at once | worst case for NFR-01 run p95: 5 simultaneous runs (15 sandboxes on 2 workers) and a simultaneous submit once | yes (TC-091 flavour) |
| 6 Headroom | 10, then 15| 5 min each | where it breaks (informational) | no |
| 7 Injection | 5 | five slots of 5 min each (about 2 min injected, then restore and observation until recovered), step 2 only | 23.9, failure injection | no (own criteria) |
| 7b Rerun after injection | 5 | 5 min, after the LAST restore | proves the stack recovered fully: must meet PC-1 and PC-3 | yes (PC-10) |
| 8 Ramp down | 5 to 0 | 1 min | finish route, queues drain, nothing left pending | yes (no pending jobs) |

Duration of stages 1 to 5 and 8: 2 + 2 + 15 + 10 + 12 = 41 minutes for stages 1 to 5, plus the 1-minute stage 8 ramp down = 42 minutes with the reduced 10-minute soak; with the default soak it is 32 + soak minutes. The ramp at 1 to 4 VCs LOWERS a whole-run p95 (it is not conservative), so PC-1 is evaluated twice: over the whole gate run and over stage 3 (steady) alone, using a `phase` tag on every request (script work item 4). Both must pass. Stage 6 and 7 are separate k6 invocations with their own summary files so their numbers cannot contaminate the gate.

### 23.6 What exists today and what is missing

Candidate routes on `main` @144020e0: none. `apps/api/src` has no candidate controller on main; `execution` and `judge0` modules exist (BE-05 port and client). Open PR branches:

| Piece | Where | State | Exercisable after |
| --- | --- | --- | --- |
| BE-07 session, OTP, consent, heartbeat, proctor-key, test/start | PR #98 (backend-cand/be-07-session) | open | merge of #98 (everything else is stacked on it) |
| BE-09 media presign and confirm, StorageService | PR #119 (backend-cand/be-09-media) | open, stacked on #98 | merge of #119 |
| BE-08b identity presign, upload, status | PR #129 (integrity-id/be-08b-identity) | open, stacked on #119 and #98 | merge of #129 |
| Worker face match (identity) | branch integrity-id/be-08-worker-face | not on main, no PR seen | its merge; I1 latency needs it |
| BE-11 run, submit, draft, finish, section finish | PR #187 (backend-cand/be-11-run-submit), B-3 gated | open, stacked on #98 | merge of #187 |
| BE-10 events and keystrokes with HMAC | none found | not built | the k6 mock is the only target now |
| BE-05 Judge0 wiring on the app side | branch backend-cand/be-05-execution | not on main | its merge |
| BE-13 live gateway (`/live`) and thumbnails | none | not built | merge; L1 protocol to confirm |
| BE-08c identity re-check | none | not built | optional I2 |
| Deploy compose for API, worker, Caddy; Judge0 host provisioning | infra/docker-compose.yml has only postgres, redis, adminer; infra/judge0 has the Judge0 fragment; infra/caddy is empty | deploy track (DEP) not delivered | the proof cannot start before it |
| Seeder (#99) | origin/qa-ops/k6-seed @47d7ac9e, packages/qa/k6/seed | draft, written against the docs, not against BE-07 | re-landed by QA A, then re-checked against BE-07 |

Consequence: today only the TC-090 script against `mock/server.mjs` can run (routes H1, E1, K1, M1, R1; not A1, S1, I1, F1, L1). The gate cannot run before BE-07, BE-09, BE-10, BE-11, BE-08b plus the worker face match, BE-05 wiring, the deploy compose and both instances exist. L1 may be added later but if BE-13 is not part of the pilot slice it must be said so in the report.

### 23.7 k6 script work needed (owned by QA A under DL-39; QA B is silent)

New scenario `tc-105-pilot-capacity` in packages/qa/k6 (a new file, `packages/qa/k6/tc-105-pilot-capacity.js`, reusing `lib/`). Exact changes, none made here:

1. `lib/candidate.js` SCHEDULE: add `draft` (every 10 s, `PUT /candidate/answers/:questionId/draft`, tag `endpoint:draft`, also fired after each run), `submit` (configurable `SUBMIT_EVERY_MS`, default 300000, staggered by VU id, tag `endpoint:submit`, excluded from `api_duration` like runs because grading has a 120 s deadline, but with its own threshold `http_req_duration{endpoint:submit}` p(95)<30000 as a stated assumption to confirm, Q7), `finish` (once, from a `teardown`-like last tick), `identity` (I1: presign, PUT an image from the Q8 synthetic or licence-clear set, confirm; the upload answers 202 and the result is read by polling `GET /candidate/session/identity` until a terminal status or 60 s; tag `endpoint:identity`; records `cp_identity_ms`). A zero-filled placeholder will not pass the face match (FR-403: a failed match gets one retry and then manual review), so I1 depends on the Q8 image set, not only on a seeder mode. A VC that reaches a terminal status other than VERIFIED, or times out at 60 s, never hangs: it is counted in its own counter `cp_identity_not_verified` (distinct from `cp_failures`), marked finished, and the other VCs go on; the gate threshold is `cp_identity_not_verified: count==0` (PC-8). Keep every new call out of the `url` tag and inside the host guard.
2. Follow the heartbeat token renewal (`sessionToken`, ADR 0013 5.3), in memory only and never logged, so a run longer than the token lifetime does not die. Parameterise the rate constants (`HEARTBEAT_MS` 10000, `EVENTS_MS` 5000, `KEYSTROKES_MS` 2000, `CHUNK_MS` 10000) from the environment so a rehearsal can change them; the pass run uses the defaults above and the summary prints the effective values.
3. `lib/config.js`: add `endpoint` sub-metrics for `draft`, `identity`, `submit`, `finish`; write full metrics (p50, p95, p99 per endpoint) with `handleSummary` to a path given by `SUMMARY_OUT` (the CI job already passes `--summary-export`; sub-metrics appear in it only if they have a threshold, hence the thresholds below).
4. `tc-105-pilot-capacity.js`: scenarios `gate` (stages 1 to 5 and 8, `ramping-vus` plus a `per-vu-iterations` burst scenario for stage 5, `startTime` offsets), `headroom` (stage 6, 10 then 15 VCs) and `inject` selected by `STAGE=gate|headroom|inject`. `inject` runs 5 VCs at the steady cadence for `INJECT_MIN` minutes counted from the moment the last VC has finished I1 (default 30: five 5-minute injection slots, then the 5-minute stage 7b rerun); the owner applies each injection by hand at the slot starts, and the script tags requests `phase:inject` or, in the last 5 minutes, `phase:rerun`. Only `phase:rerun` carries the PC-1 and PC-3 thresholds, because errors are expected while a dependency is down. Every request carries a `phase` tag (`identity`, `ramp`, `steady`, `soak`, `runburst`, `down`) set from the elapsed time, so thresholds can also be written on `{phase:steady}`. Thresholds (whole `gate` run, and the same `api_duration` ones again on `{phase:steady}`):

| Threshold | Meaning |
| --- | --- |
| `api_duration: p(95)<300` and `http_req_duration{kind:api}` the same, per `endpoint` (heartbeat, events, keystrokes, draft, presign, confirm, identity, finish) | NFR-01, excludes runs, submits and storage PUTs. `endpoint:api` in the brief maps to the existing `api_duration` and `kind:api` tags; no rename needed |
| `api_duration{phase:steady}: p(95)<300` and the same per endpoint | stage 3 alone (PC-1) |
| `http_req_failed{kind:storage}: rate<0.001`, `cp_storage_failures` as in the README | storage PUTs from the runner are judged separately, not as API errors |
| `http_req_duration{endpoint:run}: p(95)<5000` | NFR-01 run result, end to end through the Judge0 instance |
| `http_req_failed{kind:api}: rate==0`, `cp_failures: count==0`, `cp_setup_failures: count==0`, `checks: rate==1` | zero errors; a 429 or 503 counts |
| `cp_late_slots: rate<0.01`, `http_reqs{kind:api}: rate>=0.9 x expected` | proof the offered load was really sent (expected is about 7.7 per second at 5 VCs; the script computes it from the schedule) |

5. `mock/server.mjs`: add draft, submit, finish, identity and (when specified) a `/live` Socket.IO stub so the scenario can be checked offline with the mock; add `mock/judge0-stub.mjs`, a stand-in Judge0 (`POST /submissions/batch`, `GET /submissions/batch?tokens=`, configurable latency `STUB_MS` and 3-to-N sandboxes) for step 1.
6. Seeder (prerequisite): the VCs need sessions with a token each (CONSENTED while identity is live, 23.2). Findings from packages/qa/k6/seed/README.md on origin/qa-ops/k6-seed @47d7ac9e, and what it means for this plan:
   - It creates sessions through the PUBLIC API only (no database access): `POST /tests/:id/invitations`, link token read from a Mailpit-compatible mail sink, `POST /candidate/session/otp` then `start`, consent (`GET consent`, `POST consent/sign`), `system-check`, room scan (presign, PUT of one placeholder chunk, confirm), then start-test polled until VERIFIED to IN_PROGRESS. Output: a 0600 sessions file with `token`, `sessionQuestionId`, `questionId`, `seedRunId`, `tokenExpiresAt`, plus an ids-only manifest for cleanup by run id (`--cleanup --run-id`, needs the erase permission).
   - Gaps against this plan: (a) it uses the identity WAIVER (no face, C-25, ADR 0015), but identity is LIVE now (C-44..C-48). Sessions seeded with the waiver skip I1. Either the seeder gets a `--identity` mode (ID and selfie placeholders; real faces are forbidden, so a synthetic or licence-clear test face image set and a worker configured to accept it are needed: Q8) or the seeder stops at CONSENTED (after consent and system-check) and I1 runs in k6, which is what the gate needs: the seeder gets a `--stop-at CONSENTED` mode. (b) It needs a mail sink; the pilot-class instance sends through SES and `EMAIL_PROVIDER=noop` is refused in pilot and production (Q9). (c) Its token is short lived and k6 does not follow renewal: seed within minutes of the run and check `tokenExpiresAt` against the run length (42 minutes with the reduced soak, longer with the default soak; if shorter, k6 must follow renewal, item 2). (d) It paces at 5 requests per second, 5 candidates take seconds. (e) It requires an org name containing "synthetic" and refuses hosts containing `prod`, `production` or `pilot`: the capacity host name must be neutral (Q2). (f) It was written against the docs, not BE-07; re-check `lib/routes.mjs` when #98 merges. (g) It issues no proctor key (k6 does).
   - Seed PER k6 INVOCATION, just before it starts: 5 sessions for `gate`, 15 for `headroom` (stage 6 runs 10 and then 15 VCs, and the gate's 5 are finished in stage 8), 5 for `inject` (stages 7 and 7b). The proctor-key route answers 409 on a second call, so a session is never reused, and a session seeded for the gate cannot outlive the 42-minute run unless renewal is followed (item 2). All of them are seeded CONSENTED and do I1 first (identity time is excluded from the headroom and inject figures).

### 23.8 Step 1: LOCAL ESTIMATE (app-host stack capped; Judge0 stubbed or on a separate Linux host)

What it can and cannot prove, stated first:

| Platform | Can show | Cannot show |
| --- | --- | --- |
| Mac (Apple Silicon), a SEPARATE 2 CPU / 8 GB Colima or Lima VM, Judge0 stubbed | Whether the API, Postgres and Redis keep p95 < 300 ms at about 9 requests per second (7.7 API requests at 5 VCs plus about 1.0 thumbnail request with L1) inside the capped VM; memory shape; lock waits; connection counts; the worker's face-match memory only if its image has an arm64 build | Anything about x86 speed (an Apple core is faster than an m7i vCPU, so latencies are optimistic); Judge0 (needs Linux x86, cgroup v1, privileged isolate; ADR 0016; the earlier notes that TC-042..044 need a Linux x86 runner); the network hop to a second host; S3 behaviour |
| Linux x86 VM of the same shape (2 vCPU / 8 GB), Judge0 stubbed | The above on the real architecture; the cgroup cap method B (faithful) | the Judge0 host |
| Plus a second Linux x86 VM (2 vCPU / 2 to 4 GB, cgroup v1) running infra/judge0 | A first honest figure for run p95 including a network hop on a LAN | AWS network, instance credits, S3 and SES |

Meaning of the result: **PASS in step 1 = "no reason to expect failure", an estimate. FAIL in step 1 = a real finding (a defect or a capacity problem) to fix before step 2. Neither replaces step 2.** Report every step-1 figure with its platform row.

**1.1 Cap the whole app-host stack** (Judge0 is NOT in this stack). Options, best first. **On a Mac every docker command in section 23 (compose, stats, inspect, events, exec) must run against the capped VM's context, never Docker Desktop (the shared dev stack): run `export DOCKER_CONTEXT=colima-cp-capped` once in each shell used for this plan, and check `docker context show` first.**

- **A. A SEPARATE VM of the right size (preferred, caps everything including the kernel's share).** On a Mac create a dedicated VM, never resize Docker Desktop: `colima start --profile cp-capped --cpu 2 --memory 8 --disk 40 --vm-type vz` (or a Lima profile, or `multipass launch 22.04 --name cp-app --cpus 2 --memory 8G --disk 30G`). Colima gives the VM its own Docker daemon and context (`colima-cp-capped`; with multipass install Docker in the VM and create the context by hand); use `docker --context colima-cp-capped ...` for every command of this plan. Changing Docker Desktop's Resources restarts its VM, which stops every container including the SHARED dev stack and leaves it permanently capped, so QA never does it; only the human may, with the Database session's agreement and no other project running. Check: `docker --context colima-cp-capped info --format '{{.NCPU}} CPUs, {{.MemTotal}} bytes'` must print `2 CPUs` and about 8 GiB (8,3xx,xxx,xxx bytes minus VM overhead; record the value). On Linux x86: `multipass launch 22.04 --name cp-app --cpus 2 --memory 8G --disk 30G` (or a throwaway cloud VM of the real class for an hour), then install Docker inside. The k6 runner stays on the host, outside the VM, reaching the VM's published ports.
- **B. Linux only: one systemd slice for the whole compose project.** `/etc/systemd/system/codeproctor-app.slice`:
  ```ini
  [Slice]
  CPUQuota=200%
  MemoryAccounting=true
  CPUAccounting=true
  MemoryMax=8G
  MemorySwapMax=0
  ```
  Then `sudo systemctl daemon-reload`, and put `cgroup_parent: codeproctor-app.slice` on each service of the override file below. Verify with `systemd-cgls` and `cat /sys/fs/cgroup/codeproctor-app.slice/cpu.max` (`200000 100000`). On a cgroup v1 host use `MemoryLimit=8G` and check `memory.limit_in_bytes`. This slice must NOT contain Judge0 (isolate creates its own cgroups outside the container). 8 GB here is the app host's memory including the kernel cache the slice is charged for; it is a close, not exact, model of the instance.
- **C. Portable fallback: per-service limits that sum to 2 CPU and 5.875 GiB** (the other 2.1 GiB or so model the OS). This runs as its OWN compose project with its own volumes and ports, preferably inside the separate VM of option A (on a shared Docker Desktop VM other containers pollute the measurement; record it if so). It must never run in the shared development stack (project `codeproctor`, volume `postgres_data`): CLAUDE.md rule 14 says "Only the Database session starts or stops the local Docker stack (`dev:infra`, `dev:infra:down`). Resets (`db:reset`, `dev:infra:reset`) stay human-only per the Rules above and ADR 0009. Other sessions may connect to the stack but never start, stop or reset it." A QA session therefore never starts, stops or resets the shared dev stack; the human (or the Database session) starts the separate project below, with a throwaway database and a throwaway password in its own env file, applies the schema with the project's migrate script (never `db push` or a reset), and creates `pg_stat_statements` only in that throwaway database. `infra/docker-compose.loadtest.yml` is an untracked override you create locally (not committed; `api` and `worker` are assumed service names until the deploy compose exists):
  ```yaml
  services:
    postgres:
      ports: !override ['127.0.0.1:55432:5432'] # Compose v2.24.4 or newer; cannot collide with the dev stack
      command: ['postgres', '-c', 'shared_buffers=768MB', '-c', 'effective_cache_size=3GB', # a planner hint, harmless above the 2 GiB cap
         '-c', 'max_connections=60', '-c', 'shared_preload_libraries=pg_stat_statements', '-c', 'track_io_timing=on']
      deploy: { resources: { limits: { cpus: '0.5', memory: 2048M } } }
      memswap_limit: 2048M
    redis:
      ports: !override ['127.0.0.1:56379:6379']
      command: ['redis-server', '--appendonly', 'yes', '--maxmemory-policy', 'noeviction', '--maxmemory', '256mb']
      deploy: { resources: { limits: { cpus: '0.1', memory: 384M } } }
      memswap_limit: 384M
    api:
      deploy: { resources: { limits: { cpus: '0.8', memory: 1536M } } }
      memswap_limit: 1536M
    worker:
      deploy: { resources: { limits: { cpus: '0.6', memory: 2048M } } }
      memswap_limit: 2048M
  ```
  Run (by the human, with `DOCKER_CONTEXT` exported as above): `docker compose -p codeproctor-loadtest --env-file .env.loadtest -f infra/docker-compose.yml -f infra/docker-compose.loadtest.yml up -d postgres redis api worker` (adminer is not started; `-p` gives it its own volumes and the override above remaps both published ports; `up ... api worker` cannot work until the deploy compose defines those services, so before that only `postgres redis` start; QA connects to it only; `docker update --cpus 0.8 --memory 1536m --memory-swap 1536m <container>` changes a running container without a restart). Weakness: quotas are per service, so an idle share cannot be borrowed as on the instance (pessimistic for a burst, but a leak in one service is not seen as it would be in a shared 8 GB). Prefer A or B; record which one was used.

**1.2 Judge0 for step 1.** (a) API-only load: start `node packages/qa/k6/mock/judge0-stub.mjs` (script work item 5) outside the cap and set the API's Judge0 base URL and tokens to it (`STUB_MS=900` models 3 sandboxes plus polling; sweep 400, 900, 2500). It proves the API-side cost of the run route (the VU is blocked while Judge0 answers, so connection and event-loop pressure is real) and says nothing about sandbox time. (b) Run latency: only on a second Linux x86 machine with cgroup v1: `docker compose -f infra/judge0/docker-compose.judge0.yml --env-file .env up -d`, set `COUNT` to the value under test, check `docker compose exec judge0-worker curl -m 3 https://1.1.1.1` fails. That runs from the worker container, not inside an isolate box, so it is a smoke check only; the real sandbox network test is TC-042 (ADR 0016). Then point the API at it. The TC-042..044 sandbox checks are not part of this plan.

**1.3 Run it (k6 outside the capped set; docker commands use the `DOCKER_CONTEXT` of 1.1 on a Mac).** k6 on the Mac host or a different machine; never inside the capped VM. Seed the sessions of each invocation (5, 15, 5) with the seeder (23.7) just before that invocation. Then:

```sh
export SESSIONS_FILE=/absolute/path/outside/repo/sessions.json   # never paste its content anywhere
k6 run --summary-export=/absolute/path/outside/repo/results/gate-summary.json \
  -e API_BASE_URL=http://localhost:4000/api/v1 -e ALLOWED_HOSTS=localhost \
  -e STAGE=gate -e VUS=5 -e RAMP_UP=2m -e HOLD=15m -e SOAK=<longest test length + grace, or 10m reduced> \
  -e CHUNK_BYTES_VIDEO=65536 -e CHUNK_BYTES_AUDIO=65536 \
  packages/qa/k6/tc-105-pilot-capacity.js 2>&1 | sed -E 's#https?://[^" ]*#<url-redacted>#g' > /absolute/path/outside/repo/results/gate-k6.log
```

Warm-up: stage 2 is the warm-up and is counted in the whole-run figures; PC-1 is also read on stage 3 alone (23.5). In addition run `VUS=1` for 2 minutes once after every stack restart and discard it. Duration: 42 minutes for stages 1 to 5 and 8 with the reduced soak (32 + soak otherwise), plus 10 minutes for stage 6. Step 1 may shorten the steady stage to 10 minutes.

**1.4 What to record** (every docker command here runs with the `DOCKER_CONTEXT` of 1.1; start before stage 0, stop after stage 8; all into `results/` outside the repo, one directory per run named by date and platform):

| Data | Command (every 5 s unless stated) |
| --- | --- |
| Per-container CPU, memory, PIDs, I/O | `while true; do ts=$(date -u +%FT%TZ); docker stats --no-stream --format '{{.Name}},{{.CPUPerc}},{{.MemUsage}},{{.MemPerc}},{{.NetIO}},{{.BlockIO}},{{.PIDs}}' \| sed "s/^/$ts,/"; sleep 5; done >> docker-stats.csv` (cAdvisor is an acceptable alternative) |
| Whole-host CPU, memory, swap, run queue | inside the VM or instance: `vmstat -t -w 5 > vmstat.txt`; also `mpstat -P ALL 5 > mpstat.txt` and `free -m -s 5 > free.txt` (CPU `st` steal must stay near 0) |
| Restarts and OOM | before and after: `docker inspect -f '{{.Name}} oom={{.State.OOMKilled}} restarts={{.RestartCount}} started={{.State.StartedAt}}' $(docker ps -aq) > inspect-before.txt` (and `-after`); during: `docker events --filter event=oom --filter event=die --filter event=restart --format '{{json .}}' > events.jsonl`; on Linux also `sudo dmesg -T \| grep -i -E 'out of memory\|oom-kill\|killed process' > dmesg-oom.txt` (empty is the expectation; inside a Colima or Lima VM run it in the VM, for example `colima ssh -p cp-capped -- sudo dmesg -T`; `docker events` is the cross-platform evidence) |
| Postgres hot queries | once, at the start of stage 3, `SELECT pg_stat_statements_reset();` and at the end of stage 5 (so the top 15 covers stages 3 to 5) `SELECT calls, round(total_exec_time) AS ms_total, round(mean_exec_time::numeric,2) AS ms_mean, rows, left(query,120) FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 15;`; sampled: `SELECT count(*) FILTER (WHERE wait_event_type='Lock') AS lock_waits, count(*) AS conns FROM pg_stat_activity;` and `SELECT deadlocks, conflicts FROM pg_stat_database WHERE datname=current_database();` (run as the owner of the stack, with the throwaway credentials in `.env.loadtest` (option C) or those of the stack's own env file; never from an agent session against staging or pilot, ADR 0009) |
| Redis | `REDISCLI_AUTH=... redis-cli info memory`, `info stats` (watch `evicted_keys` = 0, `rejected_connections` = 0, `instantaneous_ops_per_sec`), `redis-cli --latency-history -i 5` for the run, `slowlog get 20` at the end |
| Queues (worker and BullMQ) | queue depth and oldest-job age of the identity and session jobs: `redis-cli --scan --pattern 'bull:*:wait'` then `LLEN` each; names come from the API configuration. Worker CPU is its row in docker-stats.csv; face-match latency from the worker log (no media keys, no images in the log) |
| Judge0 queue time and run phases | Judge0 host: docker stats as above; `redis-cli -h judge0-redis LLEN resque:queue:default` (verify the queue name on the running version); per-submission queue time from `created_at` and `finished_at` fields on `GET /submissions/:token` only if the API leaves them readable (it DELETEs after reading, so the capture must be in the stub or in an API debug log, which must not hold source code); the k6 `run` trend minus the stub or Judge0 `time` is the overhead |
| API latency per route | the k6 summary (`p(50)`, `p(95)`, `p(99)` per `endpoint` tag; `summaryTrendStats` already has them) and, as the server-side cross-check, the Caddy JSON access log `duration` per route (no query strings, no bodies, no tokens) |
| Errors | k6 `http_req_failed{kind:api}`, `cp_failures`, `cp_duplicate_batches`, `checks`; API logs grepped for `level>=50` and 5xx counts (no secrets in the output) |

**1.5 Step 1 report** (QA writes it as a short section here or in docs/qa/pilot-capacity-report.md, labelled ESTIMATE): platform row, cap method A/B/C and the verified numbers, k6 summary, the CSV peaks (CPU and memory per container as a share of its limit), restart and OOM result, top 5 Postgres statements, and the first container to reach 80 % of its CPU or memory limit.

### 23.9 Step 2: the real proof on the provisioned instances (THE GATE)

**Preconditions (all must be true; QA checks, the owner confirms):**

1. Both instances exist and are the pilot class: app host 2 vCPU / 8 GB x86 (m7i.large class; if a burstable t-class is used, CloudWatch `CPUCreditBalance` is recorded before and after, Q5), Judge0 host sized per Q5, Ubuntu 22.04 cgroup v1 with the boot check of ADR 0016 section 3.5 on the Judge0 host. Same AMI, Docker and compose files as the pilot will use. Region and AZ the same for both.
2. Network: the app host reaches Judge0 over a private address and security-group rule only; Judge0 has no route to the app database or secrets; no egress from the sandbox (a `curl -m 3` from the worker is a smoke check; the real test is TC-109 / TC-042, hub and QA cases). The runner reaches only the app host's public Caddy endpoint.
3. Stack deployed through the deploy track (not by hand), the exact commit recorded; instance role on S3 (no static keys, section "Deploy check: AWS credential sources" above); the load-test bucket and database are SYNTHETIC ONLY. If these are the pilot's own instance and database, they are rebuilt or reset by the human before any real candidate (nothing here is reused; D-10 principle of ADR 0016: a load-tested host is never promoted as it is). Agents never reset (CLAUDE.md, ADR 0009).
4. The k6 runner: a small separate machine on neither host (for example a t3.small in the same region and a different AZ, so it adds a realistic network hop and cannot steal CPU), k6 from the image pinned by digest in .github/workflows/qa.yml. **The gate run must come from this runner** (or a self-hosted GitHub runner installed on that machine); a GitHub-hosted runner, a laptop, and the `k6` job of qa.yml on a GitHub-hosted runner are informational only and carry no gate status (different network path).
5. Target host name is allow-listed and neutral. The k6 guard and the seeder refuse any host containing `prod`, `production` or `pilot`, and CI allows only hosts in `QA_STAGING_HOSTS`, with the secret from the `staging` GitHub environment (`K6_SESSIONS_JSON`). C-43 says there is no staging on AWS, so the hub and owner must give the capacity-test instance a host name such as `capacity.<domain>`, add it to `QA_STAGING_HOSTS`, and decide how the gate runs without editing the guard (Q2). CI configuration is hub-owned: this plan proposes no workflow edit; what the hub provides: the allow-list entry, a `k6-pilot-capacity` dispatch option that runs `tc-105-pilot-capacity.js` from the mounted folder (as README section "CI (hub changes, not made here)") and the artefact upload of the summary. The gate itself is run by the owner with the commands of 1.3 from the precondition-4 runner. Also set `STORAGE_ALLOWED_HOSTS` to the S3 bucket host (the S3 endpoint of the load-test bucket) so a presign pointing elsewhere is not followed.
6. Secrets: sessions list (bearer tokens and batch keys) and staff credentials for the seeder live only in the human's secret store or the GitHub environment secret; nobody pastes them into a session, a PR, a log or this file. The seeder and k6 are run by the human, or by CI with secrets mapped to the environment. QA never receives them.
7. Seed fresh sessions PER k6 invocation, after the stage-0 pre-check and at most 10 minutes before that invocation starts: 5 for the gate, 15 for stage 6, 5 for stages 7 and 7b (a session is never reused). Check that `tokenExpiresAt` is later than the end of the whole invocation (42 minutes for the gate with the reduced soak, longer otherwise) or that renewal is followed (item 2 of 23.7, required for the gate if the token lifetime is shorter); a mail sink (or a SES sandbox mailbox the human reads) for the invitation mail (Q9).
8. Sampling installed on BOTH hosts (1.4 commands; `vmstat`, `docker stats` CSV, `docker events`, dmesg, Postgres on the app host, Judge0 queue on the Judge0 host), clocks in sync (chrony), CloudWatch agent not CPU-hungry (record its share).

**Run order and who does what:**

| # | Step | Who |
| --- | --- | --- |
| 1 | Provision both instances, deploy the stack, set the allow-list and secrets, confirm preconditions 1 to 8 | Owner (with Deploy: DEP track/Backend A for the compose files, host provisioning and the boot check) |
| 2 | Provide the scripts, thresholds, command lines and an analysis template; dry-run on the mock and at step 1 (`--dry-run` of the seeder) | QA A |
| 3 | Seed, start sampling, run stages 0 to 5 and 8 (`STAGE=gate`), then 6 (`STAGE=headroom`), then 7 and 7b (`STAGE=inject`) | Owner, from the precondition-4 runner (a CI dispatch is informational only) |
| 4 | Collect the evidence package, analyse, write the report, list defects with owners | QA A, then hands defects to the project manager |
| 5 | Sign off or reject | Owner |

**Pass and fail criteria. One rule: ANY failed criterion blocks the first real candidate, unless the owner waives that criterion BY ID in the sign-off line. QA never waives. PC-5, PC-6, PC-7 and PC-8 carry QA-proposed numbers (Q10, Q11); the owner may change a number before the run, not after.**

| ID | Criterion | Source | Evidence |
| --- | --- | --- | --- |
| PC-1 | `api_duration` p(95) < 300 ms for the whole gate run AND, separately, for stage 3 (steady) alone (`phase:steady`), and per endpoint (heartbeat, events, keystrokes, draft, presign, confirm, identity, finish), excluding runs, submits, storage PUTs; both readings must pass | NFR-01, TC-090 | k6 summary JSON; Caddy `duration` cross-check |
| PC-2 | `http_req_duration{endpoint:run}` p(95) < 5000 ms end to end through the Judge0 instance (over the whole gate run: the steady, soak and the 12 stage-5 rounds; stage 5 may also be read alone with `phase:runburst`) | NFR-01, TC-091 | k6 summary JSON |
| PC-3 | Zero errors: `http_req_failed{kind:api}` rate = 0, `cp_failures` = 0, `cp_setup_failures` = 0, `checks` rate = 1, no 429, no 503, no 5xx; storage PUT failures < 0.1 % (`http_req_failed{kind:storage}`) | TC-090 "no errors"| k6 summary; API log 5xx count = 0 |
| PC-4 | No OOM kill and no restart of any container on EITHER host: every `RestartCount` unchanged, every `OOMKilled=false`, `dmesg` shows no oom-kill, no unexpected `die` event | brief | inspect-before/after, events.jsonl, dmesg-oom.txt |
| PC-5 | Offered load proven: `http_reqs{kind:api}` rate >= 90 % of expected, `cp_late_slots` < 1 %, over stages 3 to 5 the run count equals 5 x elapsed minutes (+- 1 each) | QA proposal (Q10): the 90 %, 1 % and +-1 figures are not in the docs | k6 summary |
| PC-6 | No resource cliff: no container above 90 % of its memory limit at any sample, host swap 0, CPU `steal` < 5 %, app host CPU and Judge0 host CPU 5-minute averages < 85 % in stage 3 | engineering margin (QA proposal; Q10) | docker-stats.csv, vmstat.txt |
| PC-7 | No leak in the soak: each container's memory at the end of stage 4 is within +10 % of its value at minute 5 of stage 3; Postgres connections and Redis memory flat; BullMQ and Judge0 queues at 0 after stage 8 | QA proposal (Q10): the +10 % figure is not in the docs | CSV trends, queue counts |
| PC-8 | Identity gate: all 5 reach VERIFIED within the proposed 60 s (FR-403; a number to confirm, Q11) and `cp_identity_not_verified` = 0; worker CPU recorded; no failed job | C-44..C-48 | `cp_identity_ms`, `cp_identity_not_verified`, worker log, queue samples |
| PC-9 | No lost data: 5 final submissions graded, drafts equal the last autosave sent, every presigned chunk confirmed, no `duplicate:true` | FR-504, FR-701 | database counts by the owner, `cp_duplicate_batches` = 0 |
| PC-10 | Failure injection (below) behaves as specified, only on the capacity instances, and the 5-VC rerun 7b after the last restore meets PC-1 and PC-3 | NFR-09 | injection log |
| PC-11 | Evidence package complete (below) and every k6 and server log redacted | this plan | the package |

Informational (never fails the gate): stage 6 (10 and 15 VCs) breakpoint, Postgres top queries, the first container to reach 80 %, Judge0 `COUNT` sensitivity.

**Failure injection (stage 7, synthetic data, owner runs, 5 VCs; each injection has its own 5-minute slot: about 2 minutes injected, then restore and observation until recovered; the 70-second network cut fits in its slot the same way; then the 5-minute rerun 7b):**

| Injection | Expected (to be confirmed against the code; a hang or a 500 is a defect) |
| --- | --- |
| `docker compose stop` Judge0 server and workers (Judge0 host)| Run answers a clear error (503 with `Retry-After`) within the 15 s Run deadline of ADR 0016, never hangs, never 500; heartbeat, events, keystrokes, draft, presign and confirm stay 200 with api p95 < 300 ms; after restore the next run succeeds within 60 s without an API restart |
| Block the private path (security group) between app and Judge0 | same as above (a timeout, not a hang beyond the deadline) |
| `docker compose stop redis` (app host) | Fail closed: candidate routes answer 503 problem+json with `Retry-After` promptly (rate limits and token freshness need Redis, section 18), no 200 with a lost write, no hang over 5 s; after restore the SDK-style resend drains and no event is duplicated or lost |
| Stop Postgres (app host) | 503 `BUSY` or equivalent, no hang; recovery without restarting the API |
| Pull the runner network for 70 s | the DISCONNECTED rule of FR-609 (more than 60 s) fires and RECONNECTED follows (TC-063 note on 45 s) |

**Evidence package** (a folder the owner keeps outside git, the redacted summaries copied to docs/qa/pilot-capacity-report.md by QA): the k6 summary JSON for gate, headroom and inject runs; the redacted k6 logs; docker-stats.csv, vmstat, mpstat and free files for both hosts; inspect-before and inspect-after, events.jsonl, dmesg output; pg_stat_statements top 15, lock and connection samples; Redis info samples; Judge0 queue samples; Caddy access-log duration percentiles per route; the commit SHAs and image digests deployed, the instance types and the AMI ids, the effective environment values for `COUNT` and pool sizes (no secrets), the seeder run ids and the cleanup confirmation (`--cleanup` or the owner's erase); and the owner's sign-off line (name, date, "PASS" or "FAIL", the criteria IDs waived if any, with the reason). No candidate media keys, tokens, OTPs, URLs or secrets appear in any file.

**Sign-off.** The owner signs. A waived criterion is the owner's explicit decision recorded in the sign-off line; QA does not waive. If any criterion fails or the package is incomplete, the first real candidate is blocked until a rerun passes or the owner waives that criterion by ID. After a failed run QA files defects (reproduction, expected vs actual, owner) for the project manager; the typical levers are Judge0 `COUNT` or the worker's concurrency, Postgres pool and `shared_buffers`, moving face match to a lower priority, or a bigger app host.

### 23.10 Proposed test-case entry for the capacity gate (id TC-105 from the hub, draft PR #237, final once it merges; test-cases.md and test-matrix.md are NOT edited here). The other deploy-track cases are in section 24

| Id | Source | Test | Level | Pri | How |
| --- | --- | --- | --- | --- | --- |
| TC-105 (id from draft PR #237, final once merged) | C-43..C-48, NFR-01 | Pilot capacity: 5 concurrent candidates on the two instances (this plan, section 23.9) | load, gate (owner-run) | P1 | Section 23.9 criteria PC-1..PC-11 and the owner's sign-off. Step 1 is the estimate and carries no TC status |

QA's practice: the test carries its TC id in its name once the hub assigns it; the matrix row is added by QA after the id exists (rule: every TC id appears in the matrix with level and status).

### 23.11 Work order for QA A (nothing started; each item is its own small PR after the hub assigns ids and QA A re-lands #97 and #99)

1. Re-land the seeder (#99) as a superseding PR from QA A's own branch, add the `--stop-at CONSENTED` mode (what the gate needs, 23.7 item 6a), optionally an `--identity` mode (needs the Q8 image set), and the BE-07 re-check once #98 merges.
2. Script work of 23.7 (items 1 to 5) with mock-based checks (`k6 inspect`, mock run), as in the existing README.
3. Analysis template and the CSV sampling script under packages/qa (no secrets).
4. After the owner's run: the report and the matrix row.

### 23.12 Open questions

| # | For | Question |
| --- | --- | --- |
| Q1 | Hub | Answered by the hub: the pilot-capacity case is NEW (TC-105); NFR-02 and TC-090 stay the 200-candidate case, unchanged (TC-091 too). Nothing to do except keep the matrix rows separate. |
| Q2 | Owner, hub | Host naming and allow-list: the guard and seeder refuse `prod`, `production`, `pilot` in the host name and CI allows only `QA_STAGING_HOSTS`. What host name does the capacity run use, and is the run done on the pilot's own instances before go-live (then they are rebuilt per D-10) or on twins? Partly answered (relayed by the Delivery Lead, pending the ADR text): the API is `api.assess.thebigbraintech.com` and the web app is `app.assess.thebigbraintech.com`; whether those names pass the `prod`/`pilot` host guard, and whether the run uses them or twins, is still open. |
| Q3 | Delivery Lead, hub | What exactly is "live view" load: subscribers (2 proposed), HIGH-event fan-out rate, thumbnail source and rate, Socket.IO or raw WebSocket (OI-2, Q-20)? Which HIGH event type does not pause the session or change the risk band (so a test can raise it without ending the run)? |
| Q4 | Delivery Lead, owner | Does the worker run anything else on the app host during a test besides identity face match: AI-likeness, voice, keystroke analytics, similarity, audio checks? C-43 defers audio and similarity to after the sessions; confirm the deferral is enforced by configuration (a queue that is paused until the session window ends) and whether the test must include the deferred queue running at the end of the slot. |
| Q5 | Owner | Judge0 instance size (t3.small, t3.medium or c7i.large class) and the app host class: burstable classes can run out of CPU credits during a 42-minute test (longer with the default soak); if one is chosen the plan adds the CPU credit check and a run long enough to exhaust the launch credits. Judge0 `COUNT` (2 assumed) and the CPU ceiling of the Judge0 workers while an API call is being served. |
| Q6 | Delivery Lead | The brief says k6 does NOT upload media bytes. Confirm needs the object. Keep tiny PUTs from the runner (proposed), or drop `confirm` from the scenario and its coverage. |
| Q7 | Backend, hub | Submit time bound: NFR-01 gives 5 s for a run only; grading polls up to 120 s per batch (ADR 0016). Is there a target for the submit of 5 simultaneous candidates (30 s is assumed), and does submit run hidden tests inline or as a queued job? |
| Q8 | Owner, Integrity | Identity is live: what synthetic or licence-clear face and ID image set may the load test use (real people forbidden), and does the face model accept it? Also whether to exercise a deliberate no-match (retry and manual-review path): that would run OUTSIDE the gate invocation, in its own run, because it would trip `cp_identity_not_verified`. |
| Q9 | Owner, Deploy | Mail for seeding: SES in sandbox with a mailbox the human reads, or a Mailpit-compatible sink reachable only by the runner? `EMAIL_PROVIDER=noop` is refused in pilot and production. Partly answered (relayed by the Delivery Lead, pending the ADR text): mail goes through SES on `assess.thebigbraintech.com` (C-52, relayed, not in decisions.md on this branch); which mailbox the seeder reads, and sandbox versus production SES, is still open. |
| Q10 | Owner | The engineering margins in PC-6 (90 % memory, 85 % CPU, steal < 5 %) are QA proposals, not in the docs; accept or change. Also the S3 presign expiry (60 s in ADR 0013 5.5), expected autosave size (1 to 4 KiB assumed), and whether the reduced 10-minute soak is acceptable instead of the default (the longest pilot test length plus grace). The owner may change a number before the run, not after; the 60 s of PC-8 is Q11. The numbers in PC-5 (90 % offered load, 1 % late slots), PC-6 and PC-7 (+10 % memory) are QA proposals. |
| Q11 | Integrity, Frontend | The time allowed for the identity check to reach a result (60 s assumed) and whether 5 candidates starting the gate in the same 30 s is the realistic worst case (a slot starts for all five at once). |
| Q12 | Backend A (Deploy) | Postgres tuning for an 8 GB host shared with the API, worker and Redis: the proposed values in 23.3 (`shared_buffers` 768 MB, `max_connections` 60); and who provides the deploy compose with `api` and `worker` services and memory limits that match 23.3. |
| Q13 | Hub, owner | C-43..C-48 and C-49 (renamed in #232) are recorded by the hub in ADR 0017 (PR #233), with test cases in draft PR #237 and FSD #236, none merged. Confirm ADR 0017 is ACCEPTED (and the PRs merged) before the gate run, so the gate is measured against recorded decisions; also that the TC ids below are final. Partly answered (relayed by the Delivery Lead, pending the ADR text): the owner will approve ADR 0017 (PR #233) once its re-review is clean (C-53, relayed); it is not accepted yet. |

### 23.13 What could not be verified in this plan

- No candidate route, deploy compose or Judge0 host exists on main, so no number here is measured; every rate is from the docs (FSD FR-504, FR-609, FR-701; ADR 0013 section 5; k6 README R-02) and the SDK, not from the running code.
- SDK default cadences were taken from the docs and `AUTOSAVE_INTERVAL_MS = 10_000` in apps/web; the events, keystrokes and chunk timings follow ADR 0013 and the k6 README, not a fresh reading of packages/proctor-sdk.
- The seeder README was read from origin/qa-ops/k6-seed @47d7ac9e only; its code and tests were not run.
- Judge0 queue-time fields (`created_at`, `finished_at`, queue names) and the Colima flags are described from memory and are marked "verify on the running version".
- The contents of #237, #236 and ADR 0017 (ids, titles, FR ids, the 14-day backup expiry) were relayed by the hub and NOT read by QA.
- The 202 answer of the identity upload and the exact terminal statuses of `GET /candidate/session/identity` come from the review comments, not from a reading of the code.
- Cgroup method B on a cgroup v1 host (Judge0's requirement) was not tried; it is only used for the app host, which has no isolate.

## 24. QA-13 (2026-10-06): deploy-track test cases for the pilot (ids from the hub's draft PR #237, branch arc/test-cases-pilot-deploy @1a0d12e, section "Pilot deployment (ADR 0017)" of docs/test-cases.md; the ids are final once that PR merges; separate from the capacity gate of section 23; test-cases.md and test-matrix.md are NOT edited here)

QA-owned cases (QA writes the tests and the manual scripts; the matrix rows are added by QA after the PR merges; each test carries its TC id in its name):

| Id (draft #237) | Source | Test | Level | Pri | How |
| --- | --- | --- | --- | --- | --- |
| TC-101 (id from draft PR #237, final once merged) | C-43, DEP | OIDC role isolation: the deploy role (GitHub OIDC) can only do what the deploy needs, cannot read the data bucket or the database secrets, and a workflow from another repo, branch or environment cannot assume it | unit (offline policy test) + manual (owner-run simulation) | P1 | Offline: parse the IAM trust and permission policies in code (conditions `sub`, `aud`, ref and environment, no wildcard on resources or actions beyond the list); owner-run: `aws iam simulate-principal-policy` and a failing assume-role from a non-matching workflow |
| TC-102 (id from draft PR #237, final once merged) | C-43 | Instance start and stop around a booked slot: scheduled start before the slot, self-stop ONLY when no session is active, no upload is pending, and all queues (BullMQ, Judge0, worker) are empty; a stop must never be issued while any of the three is non-empty | integration + manual | P1 | Integration: the stop decision function with table-driven state (active session, pending chunk, queue depth, Judge0 queue, one slot ending while a candidate is in its grace period); manual: owner-run on the real instance with a 5-minute slot, then a slot with a deliberately late upload |
| TC-103 (id from draft PR #237, final once merged) | C-43 | Restore drill from S3: nightly or at-shutdown backup restores into a fresh instance; row counts and a checksum match; erasure re-apply list is applied (infra/backup/restore.sh, reapply-erasures.sql) | manual (+ integration for the script with a fake S3) | P1 | Owner-run on a throwaway instance with synthetic data; QA script checks counts, checksums, that erased candidates stay erased, and records the time to restore |
| TC-104 (id from draft PR #237, final once merged) | C-43 | Daily maintenance wake: exactly one wake a day starts the instance, retention, erasure and reminder jobs run, and the instance stops by itself under the TC-102 rule; no wake when it is already running | integration + manual | P2 | Scheduler rule inspected; owner-run: observe one cycle, count wakes in 24 hours = 1, jobs completed, stop condition honoured |

Added to TC-103 (restore drill): backups expire after 14 days (as relayed by the hub, not read by QA), so the drill also checks that the restore uses the newest backup inside that window and that an object older than 14 days is gone (lifecycle rule inspected, owner-run listing). Added to TC-105: the run uses the identity face match LIVE (stage 1, I1), worker CPU recorded.

Hub cases listed for completeness (not QA load; titles and owners as relayed by the hub, not read by QA, to be confirmed in #237):

| Id (draft #237) | Case | Owner |
| --- | --- | --- |
| TC-106 | Slot rules (FR-306); covers what this plan earlier called "slot chosen at invite", no separate QA case | hub, Backend |
| TC-107 | Closed-instance page (FR-407), served while the instance is off | hub, Frontend and Deploy |
| TC-108 | The hard ceiling cannot be cancelled | hub, Deploy |
| TC-109 | Judge0 isolation | hub, Deploy and Integrity |
| TC-110 | Signed release at boot | hub, Deploy |
| TC-111 | Schedule view and review windows (FR-307) | hub, Frontend and Backend |

"One KMS key" (an earlier QA placeholder) is covered by ADR 0017 and has no separate case; QA does not add one.
