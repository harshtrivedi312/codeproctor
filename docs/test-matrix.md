# Test matrix

Owner: qa-engineer. Source: /docs/test-cases.md (72 test cases: 51 P1, 17 P2, 4 P3). Rebuilt 2026-10-02 (QA-01).

How to read this file:

- **Level**: unit, integration (API plus database, Testcontainers), e2e (Playwright), a11y (axe), load (k6), security (ZAP or negative tests), manual (needs people or hardware, script in /docs/manual-tests.md).
- **Owner**: the agent that builds the feature and fixes a defect found by the test. The "Owner tasks" column uses the task IDs in /docs/requirements-trace.md.
- **Test file**: where the test lives, or will live. Planned paths do not exist yet.
- **Status**: only runs count. "Partial pass" means the listed tests ran and passed, but they cover the browser or validation side only; the case is **not verified** until the server side exists and passes. Verified TCs: 0 of 72.
- Test names start with the TC ID. `pnpm --filter @codeproctor/qa test` fails if a TC ID in test-cases.md is missing here, or if a test names a TC ID that is not here.

Status on 2026-10-02: only the database schema (DB-02) and the mocked candidate test screen (FE-01) are merged. There is no API code, no migrations (DB-03) and no proctor SDK, so every server-side case is blocked. The suite is wired so that each blocked case gets its test as soon as its owner task merges.

Last local runs: apps/web Vitest 51 passed, packages/qa matrix check 4 passed; Playwright (Chromium, production build with mocks) 4 passed. Run commands are in /docs/followups/qa.md section 1.

## P1 (must pass before the pilot)

| TC | FR / NFR | Scenario | Type | Level | Owner | Owner tasks | Test file | Status | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-001 | FR-101 | Valid staff login | F | integration | backend-engineer | BE-02, FE-02 | `apps/api/test/integration/tc-001.int.test.ts`<br>`apps/web/src/lib/qa-contract.test.ts` | Partial pass: shared login schema only | Server login flow needs BE-02. |
| TC-002 | FR-101 | Lockout after failures | S | integration | backend-engineer | BE-02, FE-02 | `apps/api/test/integration/tc-002.int.test.ts` | Planned, blocked until the owner task merges |  |
| TC-003 | FR-102 | 2FA required for reviewer | S | e2e | backend-engineer | BE-02, FE-02 | `packages/qa/e2e/tc-003.spec.ts` | Planned, blocked until the owner task merges |  |
| TC-004 | FR-103 | RBAC enforcement | S | integration | backend-engineer | BE-03 | `apps/api/test/integration/tc-004.int.test.ts` | Planned, blocked until the owner task merges |  |
| TC-005 | FR-104 | Refresh token reuse | S | integration | backend-engineer | BE-02 | `apps/api/test/integration/tc-005.int.test.ts` | Planned, blocked until the owner task merges |  |
| TC-006 | FR-105 | Audit on data access | F | integration | backend-engineer | BE-03, BE-13 | `apps/api/test/integration/tc-006.int.test.ts` | Planned, blocked until the owner task merges |  |
| TC-008 | NFR-04 | Cross-org access | S | integration | db-engineer | DB-05, BE-03, BE-13 | `apps/api/test/integration/tc-008.int.test.ts` | Planned, blocked until the owner task merges | Testcontainers; DB-03 migrations needed first. |
| TC-098 | FR-107 | Staff password reset (added 2026-10-01, D-22) | S | integration | backend-engineer | BE-02, FE-02, BE-06 | `apps/api/test/integration/tc-098.int.test.ts` | Planned, blocked until the owner task merges |  |
| TC-010 | FR-201 | Create coding question | F | integration | backend-engineer | BE-04 | `apps/api/test/integration/tc-010.int.test.ts` | Planned, blocked until the owner task merges |  |
| TC-011 | FR-202 | Hidden tests hidden | S | integration | backend-engineer | BE-04 | `apps/api/test/integration/tc-011.int.test.ts`<br>`apps/web/src/lib/qa-contract.test.ts` | Partial pass: OpenAPI candidate schemas carry no hidden fields | The real endpoint test needs BE-04. |
| TC-012 | FR-203 | Variant validation | F | integration | backend-engineer | BE-05, FE-04 | `apps/api/test/integration/tc-012.int.test.ts` | Planned, blocked until the owner task merges |  |
| TC-013 | FR-204 | Versioning | F | integration | backend-engineer | BE-04 | `apps/api/test/integration/tc-013.int.test.ts` | Planned, blocked until the owner task merges |  |
| TC-020 | FR-301 | Random pick rule | F | integration | backend-engineer | BE-06, BE-07 | `apps/api/test/integration/tc-020.int.test.ts` | Planned, blocked until the owner task merges |  |
| TC-021 | FR-303 | Single-use link | S | integration | backend-engineer | BE-07 | `apps/api/test/integration/tc-021.int.test.ts` | Planned, blocked until the owner task merges |  |
| TC-022 | FR-303 | Window enforcement | F | integration | backend-engineer | BE-06, BE-07 | `apps/api/test/integration/tc-022.int.test.ts` | Planned, blocked until the owner task merges |  |
| TC-024 | FR-305 | Extra time accommodation | F | integration | backend-engineer | BE-06, BE-07 | `apps/api/test/integration/tc-024.int.test.ts` | Planned, blocked until the owner task merges |  |
| TC-030 | FR-401 | No recording before consent | S | e2e | frontend-engineer | BE-07, FE-09 | `packages/qa/e2e/tc-030.spec.ts` | Planned, blocked until the owner task merges | Asserts no getUserMedia/getDisplayMedia call and no network uploads before signing. |
| TC-095 | FR-401 | Sign the consent document (added 2026-10-01, D-17) | F | e2e | backend-engineer | BE-07, BE-06, BE-09, FE-09 | `packages/qa/e2e/tc-095.spec.ts` | Planned, blocked until the owner task merges | PDF stored part needs BE-09 (build-plan note). |
| TC-096 | FR-401 | Decline the consent document (added 2026-10-01, D-17) | S | e2e | frontend-engineer | BE-07, FE-09 | `packages/qa/e2e/tc-096.spec.ts` | Planned, blocked until the owner task merges |  |
| TC-031 | FR-402 | Unsupported browser | F | e2e | frontend-engineer | FE-09 | `packages/qa/e2e/tc-031.spec.ts` | Planned, blocked until the owner task merges | Playwright Firefox project. |
| TC-032 | FR-402 | Camera denied | F | e2e | frontend-engineer | FE-09 | `packages/qa/e2e/tc-032.spec.ts` | Planned, blocked until the owner task merges | Chromium with permission denied. |
| TC-033 | FR-403 | Face match fails | I | integration | integrity-engineer | BE-08, FE-09 | `apps/api/test/integration/tc-033.int.test.ts` | Planned, blocked until the owner task merges | Fixture photos of two different people (volunteer set, Legal B-05 item 3). |
| TC-040 | FR-502 | Run sample tests | F | e2e | backend-engineer | BE-11, FE-10 | `apps/web/src/features/candidate-test/qa-tc.test.tsx`<br>`packages/qa/e2e/candidate-test.spec.ts`<br>`apps/api/test/integration/tc-040.int.test.ts` | Partial pass: mocked UI | Real Judge0 run in under 5 s needs BE-05, BE-11. |
| TC-042 | FR-503 | Sandbox: network | S | integration | backend-engineer | BE-05 | `apps/api/test/integration/tc-042.int.test.ts` | Planned, blocked until the owner task merges | Needs Judge0 on a Linux x86 runner (R-01). |
| TC-043 | FR-503 | Sandbox: infinite loop | S | integration | backend-engineer | BE-05 | `apps/api/test/integration/tc-043.int.test.ts` | Planned, blocked until the owner task merges | Needs Judge0 on a Linux x86 runner. |
| TC-044 | FR-503 | Sandbox: fork bomb / memory | S | integration | backend-engineer | BE-05 | `apps/api/test/integration/tc-044.int.test.ts` | Planned, blocked until the owner task merges | Needs Judge0 on a Linux x86 runner. |
| TC-045 | FR-504 | Autosave | R | e2e | backend-engineer | BE-11, FE-10 | `apps/web/src/features/candidate-test/qa-tc.test.tsx`<br>`apps/api/test/integration/tc-045.int.test.ts` | Partial pass: 10 s autosave timing (hook level) | Restore after reopen needs BE-11. |
| TC-046 | FR-505 | Auto-submit at time zero | F | integration | backend-engineer | BE-11, FE-10 | `apps/web/src/features/candidate-test/qa-tc.test.tsx`<br>`apps/api/test/integration/tc-046.int.test.ts` | Partial pass: client countdown and read-only at zero | Auto-submit and grading need BE-11. |
| TC-047 | FR-505 | Client clock tampering | S | integration | backend-engineer | BE-07 | `apps/web/src/features/candidate-test/qa-tc.test.tsx`<br>`apps/api/test/integration/tc-047.int.test.ts` | Partial pass: client offset logic | Server deadline test needs BE-07. |
| TC-048 | FR-506 | Weighted scoring | F | unit | backend-engineer | BE-11 | `apps/api/src/scoring/scoring.unit.test.ts` | Planned, blocked until the owner task merges | Pure function: 100 x 7 / 10 = 70.00. |
| TC-050 | FR-601 | Fullscreen exit | I | e2e | proctor-sdk-engineer | BE-10, FE-06, FE-10 | `apps/web/src/features/candidate-test/qa-tc.test.tsx`<br>`packages/qa/e2e/candidate-test.spec.ts` | Partial pass: lock overlay on simulated exit (mocked) | Real FULLSCREEN_EXIT event with duration needs FE-06, BE-10. |
| TC-051 | FR-602 | Tab switch | I | e2e | proctor-sdk-engineer | FE-06, FE-10 | `packages/qa/e2e/tc-051.spec.ts` | Planned, blocked until the owner task merges |  |
| TC-052 | FR-603 | Paste blocked | I | e2e | proctor-sdk-engineer | FE-06, FE-10 | `packages/qa/e2e/tc-052.spec.ts` | Planned, blocked until the owner task merges |  |
| TC-054 | FR-604 | Window-only share | I | manual | proctor-sdk-engineer | FE-06 | `docs/manual-tests.md#tc-054` | Manual script written | The browser picker cannot be driven by Playwright. |
| TC-055 | FR-604 | Stop sharing mid-test | I | manual | proctor-sdk-engineer | BE-10, FE-06, FE-10 | `docs/manual-tests.md#tc-055` | Manual script written | Stop-sharing bar is browser UI. |
| TC-056 | FR-605 | Second monitor | I | manual | proctor-sdk-engineer | FE-06, FE-09 | `docs/manual-tests.md#tc-056` | Manual script written | Needs a second monitor. |
| TC-057 | FR-606 | No face | I | e2e | proctor-sdk-engineer | FE-08 | `packages/qa/e2e/tc-057.spec.ts`<br>`docs/manual-tests.md#tc-057` | Planned, blocked until the owner task merges | Automated with a Chromium fake video file; manual script as backup. |
| TC-058 | FR-606 | Second person | I | manual | proctor-sdk-engineer | FE-08 | `docs/manual-tests.md#tc-058` | Manual script written | Needs a second person. Fake-video automation is a follow-up. |
| TC-059 | FR-606 | Phone in view | I | manual | proctor-sdk-engineer | FE-08 | `docs/manual-tests.md#tc-059` | Manual script written | Needs a phone. Fake-video automation is a follow-up. |
| TC-062 | FR-608 | Keystroke replay | F | e2e | proctor-sdk-engineer | FE-11, FE-10, BE-10 | `packages/qa/e2e/tc-062.spec.ts` | Planned, blocked until the owner task merges |  |
| TC-063 | FR-609 | Network drop | R | e2e | proctor-sdk-engineer | FE-07, FE-10 | `packages/qa/e2e/tc-063.spec.ts`<br>`docs/manual-tests.md#tc-063` | Planned, blocked until the owner task merges | Playwright offline mode for 45 s; manual script for the real network. |
| TC-065 | Security | Forged events | S | integration | backend-engineer | BE-10, FE-06 | `apps/api/test/integration/tc-065.int.test.ts` | Planned, blocked until the owner task merges | Replay a captured batch with a changed payload. |
| TC-070 | FR-701 | Chunked upload | F | e2e | backend-engineer | BE-09, FE-07 | `packages/qa/e2e/tc-070.spec.ts` | Planned, blocked until the owner task merges | 30-minute run, nightly only. |
| TC-071 | FR-703 | Signed playback URL | S | integration | backend-engineer | BE-09 | `apps/api/test/integration/tc-071.int.test.ts` | Planned, blocked until the owner task merges |  |
| TC-072 | FR-704 | Retention deletion | F | integration | db-engineer | DB-06, BE-09 | `apps/api/test/integration/tc-072.int.test.ts` | Planned, blocked until the owner task merges |  |
| TC-073 | FR-802 | Paste burst via typing tool | I | e2e | integrity-engineer | BE-12 | `packages/qa/e2e/tc-073.spec.ts` | Planned, blocked until the owner task merges | Playwright keyboard.type with zero delay stands in for xdotool. |
| TC-075 | FR-804 | Risk banding | F | unit | integrity-engineer | BE-12 | `apps/api/src/risk/risk-band.unit.test.ts` | Planned, blocked until the owner task merges |  |
| TC-076 | FR-805 | Review routing | F | integration | integrity-engineer | BE-12, BE-13 | `apps/api/test/integration/tc-076.int.test.ts` | Planned, blocked until the owner task merges |  |
| TC-090 | NFR-02 | Load | P | load | backend-engineer | BE-15B | `packages/qa/k6/tc-090-load.js` | Script written, not run | Needs a running API (staging). |
| TC-092 | NFR-06 | Accessibility | A | a11y | frontend-engineer | FE-13 | `apps/web/src/features/candidate-test/qa-tc.test.tsx`<br>`packages/qa/e2e/candidate-test.spec.ts` | Partial pass: candidate test screen demo (axe, WCAG 2.1 AA tags) | Full candidate flow and staff screens need FE-09, FE-13. Screen-reader pass is manual. |
| TC-093 | NFR-04 | OWASP scan | S | security | qa-engineer | QA-01B | `.github/workflows/qa.yml (zap-baseline job)` | Workflow written, not run | Manual dispatch against staging; staging does not exist yet. |

## P2

| TC | FR / NFR | Scenario | Type | Level | Owner | Owner tasks | Test file | Status | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-007 | FR-106 | Candidate OTP before the test starts | S | integration | backend-engineer | BE-07 | `apps/api/test/integration/tc-007.int.test.ts`<br>`apps/web/src/lib/qa-contract.test.ts` | Partial pass: OTP format schema only | Lockout needs BE-07. |
| TC-097 | FR-106 | Wrong OTP during a test (added 2026-10-01, D-21) | S | integration | backend-engineer | BE-07, FE-09 | `apps/api/test/integration/tc-097.int.test.ts`<br>`apps/web/src/lib/qa-contract.test.ts` | Partial pass: OTP format schema only | Cooldown, alert and resume need BE-07. |
| TC-023 | FR-304 | Bulk CSV invite | F | integration | backend-engineer | BE-06, FE-05 | `apps/api/test/integration/tc-023.int.test.ts` | Planned, blocked until the owner task merges |  |
| TC-034 | FR-403 | Liveness spoof | I | manual | integrity-engineer | FE-09, BE-08 | `docs/manual-tests.md#tc-034` | Manual script written | Printed photo needs a person. |
| TC-035 | FR-404 | Room scan required | F | e2e | frontend-engineer | FE-09 | `packages/qa/e2e/tc-035.spec.ts` | Planned, blocked until the owner task merges |  |
| TC-036 | FR-405 | Second camera (STRICT) | I | manual | frontend-engineer | FE-09, BE-10 | `docs/manual-tests.md#tc-036` | Manual script written | Needs a real phone. |
| TC-041 | FR-502 | Run rate limit | F | e2e | backend-engineer | BE-11, FE-10 | `apps/web/src/features/candidate-test/qa-tc.test.tsx`<br>`packages/qa/e2e/candidate-test.spec.ts`<br>`apps/api/test/integration/tc-041.int.test.ts` | Partial pass: browser sends one request (mocked) | Server 429 behavior needs BE-11. |
| TC-053 | FR-603 | Drag-and-drop text | I | e2e | proctor-sdk-engineer | FE-06, FE-10 | `packages/qa/e2e/tc-053.spec.ts` | Planned, blocked until the owner task merges |  |
| TC-060 | FR-606 | Gaze away | I | manual | proctor-sdk-engineer | FE-08 | `docs/manual-tests.md#tc-060` | Manual script written |  |
| TC-061 | FR-607 | Second voice | I | manual | proctor-sdk-engineer | BE-12, FE-08 | `docs/manual-tests.md#tc-061` | Manual script written | Needs a second voice. |
| TC-064 | FR-610 | Virtual camera | I | manual | proctor-sdk-engineer | FE-06 | `docs/manual-tests.md#tc-064` | Manual script written | Needs OBS Virtual Camera. |
| TC-074 | FR-803 | Identical submissions | I | integration | integrity-engineer | BE-12 | `apps/api/test/integration/tc-074.int.test.ts` | Planned, blocked until the owner task merges |  |
| TC-077 | FR-901 | Synced review | F | e2e | frontend-engineer | FE-11, BE-13 | `packages/qa/e2e/tc-077.spec.ts` | Planned, blocked until the owner task merges |  |
| TC-078 | FR-902 | Verdict required | F | integration | backend-engineer | BE-13, FE-11 | `apps/api/test/integration/tc-078.int.test.ts` | Planned, blocked until the owner task merges |  |
| TC-079 | FR-903 | Live pause | F | e2e | backend-engineer | BE-13, FE-12 | `packages/qa/e2e/tc-079.spec.ts` | Planned, blocked until the owner task merges |  |
| TC-091 | NFR-01 | Code execution latency | P | load | backend-engineer | BE-15B | `packages/qa/k6/tc-091-code-run.js` | Script written, not run | Needs staging with Judge0. |
| TC-094 | NFR-05 | Deletion on request | S | integration | db-engineer | DB-06, BE-03 | `apps/api/test/integration/tc-094.int.test.ts` | Planned, blocked until the owner task merges |  |

## P3

| TC | FR / NFR | Scenario | Type | Level | Owner | Owner tasks | Test file | Status | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-014 | FR-205 | MCQ question | F | integration | backend-engineer | BE-04, BE-11 | `apps/api/test/integration/tc-014.int.test.ts` | Planned, blocked until the owner task merges |  |
| TC-099 | FR-205 | Short answer needing manual scoring (added 2026-10-01, D-23) | F | integration | backend-engineer | BE-11, BE-13, FE-11 | `apps/api/test/integration/tc-099.int.test.ts` | Planned, blocked until the owner task merges |  |
| TC-080 | FR-904 | Appeal routing | F | integration | backend-engineer | BE-13 | `apps/api/test/integration/tc-080.int.test.ts` | Planned, blocked until the owner task merges |  |
| TC-081 | FR-1003 | Webhook | F | integration | backend-engineer | BE-14 | `apps/api/test/integration/tc-081.int.test.ts` | Planned, blocked until the owner task merges |  |

## Summary by level

| Level | P1 | P2 | P3 | Total |
| --- | --- | --- | --- | --- |
| unit | 2 | 0 | 0 | 2 |
| integration | 25 | 6 | 4 | 35 |
| e2e | 16 | 5 | 0 | 21 |
| a11y | 1 | 0 | 0 | 1 |
| load | 1 | 1 | 0 | 2 |
| security | 1 | 0 | 0 | 1 |
| manual | 5 | 5 | 0 | 10 |
