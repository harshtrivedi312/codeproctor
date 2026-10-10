# QA completeness audit of the test cases

Owner: QA A. Requested by the Delivery Lead for the owner ("make sure before going to pilot no development, testing or anything is left"). Source: docs/test-cases.md (90 TCs), docs/test-matrix.md, the test files on main, and the demo walks of 2026-10-08 to 2026-10-10. **Basis and limits:** statuses come from the test files that exist on main and the CI P1 gate (green on recent heads), plus what I observed in the walks; I did not re-run every suite locally (DL-45). "VERIFIED (auto)" means a passing automated test covers the full expected result; "VERIFIED (manual)" means I saw it in the walk with generated media; PARTIAL means a test or a walk covers part of it; NOT RUN has a script or a plan but no run; BLOCKED needs code or an environment that does not exist yet; DEFECT is a known failing case. The matrix is refreshed from this audit in the next docs PR.

## Counts

| Status | P1 | P2 | P3 | Total |
| --- | --- | --- | --- | --- |
| VERIFIED (auto) | 6 | 0 | 0 | 6 |
| VERIFIED (manual) | 6 | 1 | 1 | 8 |
| PARTIAL | 27 | 8 | 1 | 36 |
| NOT RUN | 17 | 5 | 0 | 22 |
| BLOCKED | 7 | 8 | 2 | 17 |
| DEFECT | 1 | 0 | 0 | 1 |
| **Total** | 64 | 22 | 4 | 90 |

## Cases that can only be verified on the AWS pilot stack

TC-042, TC-043, TC-044, TC-072, TC-090, TC-091, TC-101, TC-102, TC-103, TC-104, TC-105, TC-107, TC-108, TC-109, TC-110, TC-112, TC-113, TC-114

(TC-012 and TC-042..044 need a real Judge0 on Linux x86: the pilot Judge0 instance, or a Linux host if the owner wants it before AWS.)

## Every non-verified P1: what is needed

| TC | Status | What is needed |
| --- | --- | --- |
| TC-003 2FA optional and recommended for every staff role (D-70; was: required | PARTIAL | Optional-2FA suites rewritten in #323 ran in CI; refresh the matrix from a real run; the set-up dialog QR/code step is not axe or manually checked |
| TC-004 RBAC enforcement | PARTIAL | Registry and role matrix tests exist; BE-13 rows (BE13_DEFAULT) still off; the browser sweep runs on the mocked build; needs a run against the real API |
| TC-006 Audit on data access | PARTIAL | Audit shape tests exist; BE-13 review rows gated (FU-BE-238 flag semantics, mine to fix) |
| TC-008 Cross-org access | PARTIAL | Cross-org 404 asserted route by route in many e2e specs; no single full-sweep run against all candidate and review routes |
| TC-012 Variant validation | BLOCKED | Variant validation needs a real code runner (Judge0 on Linux x86); the stub cannot validate reference solutions |
| TC-013 Versioning | PARTIAL | API tests for versioning exist; UI half not re-run |
| TC-020 Random pick rule | PARTIAL | Random-assignment and feasibility specs pass; the 10-session distribution run has not been done |
| TC-021 Single-use link | PARTIAL | e2e and unit tests exist for used links; reopen-after-submit not walked |
| TC-022 Window enforcement | PARTIAL | Window checks exist (invitation window); slot rules arrive with #261 / TC-106; expiry on a live clock not run |
| TC-024 Extra time accommodation | PARTIAL | Accommodation extra time computed server side in specs; the 90-minute deadline not walked |
| TC-032 Camera denied | PARTIAL | Unit tests only; real camera denial not walked |
| TC-033 Face match fails | BLOCKED | Needs face models (P-13 owner OK) and the worker running; identity falls to MANUAL_REVIEW without them |
| TC-040 Run sample tests | PARTIAL | Run works with the stub label; sample results under 5 s need a real Judge0 |
| TC-042 Sandbox: network | BLOCKED | Needs real Judge0 (Linux x86: pilot AWS Judge0 instance or a Linux host) |
| TC-043 Sandbox: infinite loop | BLOCKED | Needs real Judge0 (Linux x86) |
| TC-044 Sandbox: fork bomb / memory | BLOCKED | Needs real Judge0 (Linux x86), cgroup limits |
| TC-046 Auto-submit at time zero | PARTIAL | Auto-submit at zero covered by unit tests; timer expiry not walked (needs a short test) |
| TC-047 Client clock tampering | DEFECT | Known defect FU-QA-01 (client clock); fix status unverified on current main; recheck |
| TC-048 Weighted scoring | PARTIAL | Scoring unit tests pass; weighted hidden tests need a real Judge0 |
| TC-050 Fullscreen exit | PARTIAL | Fullscreen exit events reach the review timeline (walk); the lock overlay and restore not driven in a real browser |
| TC-051 Tab switch | PARTIAL | SDK unit only; real tab switch not run (manual) |
| TC-052 Paste blocked | PARTIAL | SDK unit only; real paste not run (manual) |
| TC-054 Window-only share | NOT RUN | Manual script; needs a real browser window/screen picker (human) |
| TC-055 Stop sharing mid-test | NOT RUN | Manual script; needs a real browser share stop (human) |
| TC-056 Second monitor | NOT RUN | Manual script; needs a second monitor (human); system-check unit passes |
| TC-057 No face | PARTIAL | Rules unit pass; needs face models and a person leaving the frame |
| TC-058 Second person | NOT RUN | Needs face models and a second person (human) |
| TC-059 Phone in view | NOT RUN | Needs the object model and a phone in view (human) |
| TC-062 Keystroke replay | PARTIAL | Keystrokes route and wiring (#301, #345, #384) merged; replay view not exercised |
| TC-063 Network drop | NOT RUN | Manual network-drop script; SDK unit with fake timers passes |
| TC-065 Forged events | PARTIAL | Signed batch and HMAC rejection covered in proctor-events e2e (#301); refresh the matrix from a run |
| TC-070 Chunked upload | PARTIAL | Chunks upload and play back (walk, 12 parts); the 30-minute no-gap run not done |
| TC-071 Signed playback URL | PARTIAL | Playback URL is presigned with a 15 minute TTL (code and e2e); the 20-minute expiry not walked |
| TC-072 Retention deletion | PARTIAL | Retention scanner and store tests pass; needs the staging-only clock-shift hook (M-05) to run end to end |
| TC-073 Paste burst via typing tool | PARTIAL | Worker detection tests pass; real auto-typing (xdotool) not run |
| TC-090 Load | NOT RUN | k6 script and seeder ready, never run; needs a runner and a target (pilot AWS or local stack) |
| TC-092 Accessibility | PARTIAL | Axe on staff screens and the 2FA dialog; candidate stepper in jsdom only; NVDA and VoiceOver passes (humans) not done |
| TC-093 OWASP scan | NOT RUN | ZAP workflow and config ready; never run; needs a reachable stack (QA B) |
| TC-096 Decline the consent document (added 2026-10-01, D-17) | PARTIAL | Decline route and UI tests exist; not walked |
| TC-100 Staff/recruiter redaction (extends TC-011; DL-32, DL-34; added 2026-10 | PARTIAL | Revision tests exist for question and test routes; sweep of PATCH variants listed in follow-ups |
| TC-101 OIDC role isolation (added 2026-10-06, ADR 0017 sections 6 and 7) | BLOCKED | infra/aws offline policy test and owner-run IAM simulation not written; needs the pilot AWS account |
| TC-102 Start and stop around a slot (added 2026-10-06, ADR 0017 4.1, 4.2) | NOT RUN | Runbook step; needs the provisioned pilot (start/stop around a slot) |
| TC-103 Restore drill from S3 (added 2026-10-06, ADR 0017 5.3, 5.4) | NOT RUN | Restore drill; needs the pilot backups bucket and a throwaway instance (never a dev machine) |
| TC-105 Pilot capacity: 5 concurrent candidates (added 2026-10-06, C-49 gate) | NOT RUN | Capacity gate; plan done (qa.md section 23); scenario script not written; needs the pilot instances and the k6 runner module |
| TC-106 Slot rules (added 2026-10-06, ADR 0017 4.1, 4.3, 4.7) | PARTIAL | Slot-rule specs exist (schedule-capacity, scheduled-windows); not run against the real API in the UI |
| TC-107 Closed-instance page (added 2026-10-06, ADR 0017 4.6, C-46) | BLOCKED | Static closed-instance page and instance stop are pilot-only; no test file |
| TC-108 Hard ceiling cannot be cancelled or bypassed by the host (added 2026-1 | NOT RUN | IAM simulation and live check; needs the pilot AWS |
| TC-109 Judge0 instance isolation (added 2026-10-06, C-45, ADR 0017 9) | NOT RUN | Judge0 isolation checks; needs the pilot Judge0 instance |
| TC-110 Signed release at boot (added 2026-10-06, ADR 0017 6) | NOT RUN | Signed release at boot; needs the pilot |
| TC-112 API DNS reset on stop (added 2026-10-06, ADR 0017 section 8) | NOT RUN | API DNS reset on stop; needs the pilot |
| TC-113 Session Manager restricted (added 2026-10-06, ADR 0017 section 3, C-50 | NOT RUN | Session Manager restriction; needs the pilot AWS |
| TC-114 Main-instance IMDS isolation (added 2026-10-06, ADR 0017 section 3) | NOT RUN | IMDS isolation on the main instance; needs the pilot |

## All 90 cases

| TC | Pri | Requirement | Title | Status | Evidence | Needed | Where |
| --- | --- | --- | --- | --- | --- | --- | --- |
| TC-001 | P1 | FR-101 | Valid staff login | VERIFIED (auto) | auth.e2e-spec.ts, seed.int.test.ts |  |  |
| TC-002 | P1 | FR-101 | Lockout after failures | VERIFIED (auto) | auth.e2e-spec.ts, users.e2e-spec.ts |  |  |
| TC-003 | P1 | FR-102 | 2FA optional and recommended for every staff role (D-70; was: required | PARTIAL | auth.e2e-spec.ts, seed.int.test.ts | Optional-2FA suites rewritten in #323 ran in CI; refresh the matrix from a real run; the set-up dialog QR/code step is not axe or manually checked |  |
| TC-004 | P1 | FR-103 | RBAC enforcement | PARTIAL | auth.e2e-spec.ts, users.e2e-spec.ts | Registry and role matrix tests exist; BE-13 rows (BE13_DEFAULT) still off; the browser sweep runs on the mocked build; needs a run against the real API |  |
| TC-005 | P1 | FR-104 | Refresh token reuse | VERIFIED (auto) | auth.e2e-spec.ts, tc-005.int.test.ts |  |  |
| TC-006 | P1 | FR-105 | Audit on data access | PARTIAL | users.e2e-spec.ts, tc-006.int.test.ts | Audit shape tests exist; BE-13 review rows gated (FU-BE-238 flag semantics, mine to fix) |  |
| TC-007 | P2 | FR-106 | Candidate OTP before the test starts | PARTIAL | candidate-session.e2e-spec.ts, qa-contract.test.ts; walk 2026-10-10 (demo, generated media) | Wrong code refused with the message in the walk; the 5-wrong-codes 30-minute block and the recruiter notice have e2e only, not walked |  |
| TC-008 | P1 | NFR-04 | Cross-org access | PARTIAL | media.e2e-spec.ts, tests.e2e-spec.ts | Cross-org 404 asserted route by route in many e2e specs; no single full-sweep run against all candidate and review routes |  |
| TC-010 | P1 | FR-201 | Create coding question | VERIFIED (auto) | questions.e2e-spec.ts, tc-010.int.test.ts | Question form UI half (FE-04) not re-run |  |
| TC-011 | P1 | FR-202 | Hidden tests hidden | VERIFIED (manual) | questions.e2e-spec.ts, answers.e2e-spec.ts; walk 2026-10-10 (demo, generated media) | Candidate view carries samples only, 0 for MCQ (walk); unit and e2e also pass |  |
| TC-012 | P1 | FR-203 | Variant validation | BLOCKED | questions.e2e-spec.ts, question-validation.e2e-spec.ts | Variant validation needs a real code runner (Judge0 on Linux x86); the stub cannot validate reference solutions |  |
| TC-013 | P1 | FR-204 | Versioning | PARTIAL | questions.e2e-spec.ts, tc-013.int.test.ts | API tests for versioning exist; UI half not re-run |  |
| TC-014 | P3 | FR-205 | MCQ question | VERIFIED (manual) | questions.e2e-spec.ts, candidate-view.spec.ts; walk 2026-10-10 (demo, generated media) | MCQ auto-scored 20/20 in the walk (total 60 = 40 + 0 + 20); scoring unit tests pass |  |
| TC-020 | P1 | FR-301 | Random pick rule | PARTIAL | tests.e2e-spec.ts, tc-020.int.test.ts | Random-assignment and feasibility specs pass; the 10-session distribution run has not been done |  |
| TC-021 | P1 | FR-303 | Single-use link | PARTIAL | candidate-session.e2e-spec.ts, session-transitions.spec.ts; walk 2026-10-10 (demo, generated media) | e2e and unit tests exist for used links; reopen-after-submit not walked |  |
| TC-022 | P1 | FR-303 | Window enforcement | PARTIAL | candidate-session.e2e-spec.ts, entry-otp.test.tsx | Window checks exist (invitation window); slot rules arrive with #261 / TC-106; expiry on a live clock not run |  |
| TC-023 | P2 | FR-304 | Bulk CSV invite | BLOCKED | invitations.spec.ts, csv.test.ts | No bulk invite API route on main (single POST only); CSV parser tests exist in web |  |
| TC-024 | P1 | FR-305 | Extra time accommodation | PARTIAL | candidate-session.e2e-spec.ts, accommodations.spec.ts; walk 2026-10-10 (demo, generated media) | Accommodation extra time computed server side in specs; the 90-minute deadline not walked |  |
| TC-030 | P1 | FR-401 | No recording before consent | VERIFIED (manual) | candidate-session.e2e-spec.ts, consent-step.test.tsx; walk 2026-10-10 (demo, generated media) | No capture request before signing (walk, network log); consent e2e passes |  |
| TC-031 | P1 | FR-402 | Unsupported browser | VERIFIED (manual) | checks.test.ts, system-check-step.test.tsx; walk 2026-10-10 (demo, generated media) | Firefox user agent refused with the clear message (walk, UA override); real Firefox/Safari not run |  |
| TC-032 | P1 | FR-402 | Camera denied | PARTIAL | checks.test.ts, system-check-step.test.tsx; walk 2026-10-10 (demo, generated media) | Unit tests only; real camera denial not walked |  |
| TC-033 | P1 | FR-403 | Face match fails | BLOCKED | identity.e2e-spec.ts, test_signing.py | Needs face models (P-13 owner OK) and the worker running; identity falls to MANUAL_REVIEW without them |  |
| TC-034 | P2 | FR-403 | Liveness spoof | BLOCKED | identity.e2e-spec.ts, test_face_routes.py | Needs face models and a human or printed-photo test (manual script) |  |
| TC-035 | P2 | FR-404 | Room scan required | VERIFIED (manual) | media.e2e-spec.ts, room-scan-step.test.tsx; walk 2026-10-10 (demo, generated media) | Start refused until the room scan was confirmed (walk, verify-session conditions); media e2e passes |  |
| TC-036 | P2 | FR-405 | Second camera (STRICT) | BLOCKED | (none) | Side-camera routes not built (phone step skipped, #341); STRICT profile only |  |
| TC-040 | P1 | FR-502 | Run sample tests | PARTIAL | answers.e2e-spec.ts, candidate-flow.e2e-spec.ts | Run works with the stub label; sample results under 5 s need a real Judge0 |  |
| TC-041 | P2 | FR-502 | Run rate limit | PARTIAL | answers.e2e-spec.ts, qa-tc.test.tsx; walk 2026-10-10 (demo, generated media) | API refuses within 5 s (429, walk); UI same-tick gate #412 merged, recheck pending |  |
| TC-042 | P1 | FR-503 | Sandbox: network | BLOCKED | judge0.integration.spec.ts, execution.service.spec.ts | Needs real Judge0 (Linux x86: pilot AWS Judge0 instance or a Linux host) | AWS pilot |
| TC-043 | P1 | FR-503 | Sandbox: infinite loop | BLOCKED | judge0.integration.spec.ts, execution.service.spec.ts | Needs real Judge0 (Linux x86) | AWS pilot |
| TC-044 | P1 | FR-503 | Sandbox: fork bomb / memory | BLOCKED | judge0.integration.spec.ts, execution.service.spec.ts | Needs real Judge0 (Linux x86), cgroup limits | AWS pilot |
| TC-045 | P1 | FR-504 | Autosave | VERIFIED (manual) | answers.e2e-spec.ts, qa-tc.test.tsx; walk 2026-10-10 (demo, generated media) | Draft PUT 200 every 10 s and on Run; reload restores the saved answer (walk, twice); auto tests pass |  |
| TC-046 | P1 | FR-505 | Auto-submit at time zero | PARTIAL | answers.e2e-spec.ts, qa-tc.test.tsx; walk 2026-10-10 (demo, generated media) | Auto-submit at zero covered by unit tests; timer expiry not walked (needs a short test) |  |
| TC-047 | P1 | FR-505 | Client clock tampering | DEFECT | qa-tc.test.tsx, candidate-session.e2e-spec.ts | Known defect FU-QA-01 (client clock); fix status unverified on current main; recheck |  |
| TC-048 | P1 | FR-506 | Weighted scoring | PARTIAL | answers.e2e-spec.ts, scoring.spec.ts | Scoring unit tests pass; weighted hidden tests need a real Judge0 |  |
| TC-050 | P1 | FR-601 | Fullscreen exit | PARTIAL | qa-tc.test.ts, qa-tc.test.tsx; walk 2026-10-10 (demo, generated media) | Fullscreen exit events reach the review timeline (walk); the lock overlay and restore not driven in a real browser |  |
| TC-051 | P1 | FR-602 | Tab switch | PARTIAL | qa-tc.test.ts | SDK unit only; real tab switch not run (manual) |  |
| TC-052 | P1 | FR-603 | Paste blocked | PARTIAL | qa-tc.test.ts | SDK unit only; real paste not run (manual) |  |
| TC-053 | P2 | FR-603 | Drag-and-drop text | PARTIAL | qa-tc.test.ts, events.test.ts | SDK unit only; real drag-drop not run |  |
| TC-054 | P1 | FR-604 | Window-only share | NOT RUN | qa-tc.test.ts, system-check.test.ts | Manual script; needs a real browser window/screen picker (human) |  |
| TC-055 | P1 | FR-604 | Stop sharing mid-test | NOT RUN | qa-tc.test.ts, proctor-events.e2e-spec.ts | Manual script; needs a real browser share stop (human) |  |
| TC-056 | P1 | FR-605 | Second monitor | NOT RUN | qa-tc.test.ts, candidate-flow.e2e-spec.ts | Manual script; needs a second monitor (human); system-check unit passes |  |
| TC-057 | P1 | FR-606 | No face | PARTIAL | qa-tc.test.ts, rules.test.ts | Rules unit pass; needs face models and a person leaving the frame |  |
| TC-058 | P1 | FR-606 | Second person | NOT RUN | qa-tc.test.ts, events.test.ts | Needs face models and a second person (human) |  |
| TC-059 | P1 | FR-606 | Phone in view | NOT RUN | qa-tc.test.ts, rules.test.ts | Needs the object model and a phone in view (human) |  |
| TC-060 | P2 | FR-606 | Gaze away | NOT RUN | rules.test.ts | Needs face/gaze models (human) |  |
| TC-061 | P2 | FR-607 | Second voice | NOT RUN | rules.test.ts, vision-monitor.test.ts | Needs a second voice and the VAD (human) |  |
| TC-062 | P1 | FR-608 | Keystroke replay | PARTIAL | test_qa_tc.py, test_keystrokes.py | Keystrokes route and wiring (#301, #345, #384) merged; replay view not exercised |  |
| TC-063 | P1 | FR-609 | Network drop | NOT RUN | qa-tc.test.ts, proctor-events.e2e-spec.ts | Manual network-drop script; SDK unit with fake timers passes |  |
| TC-064 | P2 | FR-610 | Virtual camera | NOT RUN | system-check.test.ts, monitors.test.ts | Manual script with a virtual camera (human); SDK unit passes |  |
| TC-065 | P1 | Security | Forged events | PARTIAL | qa-tc.test.ts, proctor-events.e2e-spec.ts | Signed batch and HMAC rejection covered in proctor-events e2e (#301); refresh the matrix from a run |  |
| TC-070 | P1 | FR-701 | Chunked upload | PARTIAL | media.e2e-spec.ts, storage-keys.spec.ts; walk 2026-10-10 (demo, generated media) | Chunks upload and play back (walk, 12 parts); the 30-minute no-gap run not done |  |
| TC-071 | P1 | FR-703 | Signed playback URL | PARTIAL | media.e2e-spec.ts, storage.service.spec.ts; walk 2026-10-10 (demo, generated media) | Playback URL is presigned with a 15 minute TTL (code and e2e); the 20-minute expiry not walked |  |
| TC-072 | P1 | FR-704 | Retention deletion | PARTIAL | clocks.spec.ts, s3-object-store.spec.ts | Retention scanner and store tests pass; needs the staging-only clock-shift hook (M-05) to run end to end | AWS pilot |
| TC-073 | P1 | FR-802 | Paste burst via typing tool | PARTIAL | test_qa_tc.py, test_keystrokes.py | Worker detection tests pass; real auto-typing (xdotool) not run |  |
| TC-074 | P2 | FR-803 | Identical submissions | PARTIAL | test_qa_tc.py, test_similarity.py | Worker similarity tests pass; two real submissions not compared |  |
| TC-075 | P1 | FR-804 | Risk banding | VERIFIED (auto) | test_qa_tc.py, staff-shell.spec.ts |  |  |
| TC-076 | P1 | FR-805 | Review routing | VERIFIED (manual) | test_qa_tc.py; walk 2026-10-10 (demo, generated media) | Session appears in the review queue Under review via the dev-only flow (#399, walk); the real MEDIUM routing rule has unit tests |  |
| TC-077 | P2 | FR-901 | Synced review | PARTIAL | review.test.tsx; walk 2026-10-10 (demo, generated media) | Review UI tests exist; click-to-seek not driven (recordings play, walk) |  |
| TC-078 | P2 | FR-902 | Verdict required | BLOCKED | (none) | HIGH-flag verdict gate not built (FR-902, FU-BE-268) |  |
| TC-079 | P2 | FR-903 | Live pause | BLOCKED | candidate-session.e2e-spec.ts, deadlines.spec.ts | Live view and pause: no API routes for the live view (candidates list, live view, reports have no API routes) |  |
| TC-080 | P3 | FR-904 | Appeal routing | BLOCKED | (none) | Appeal routing not built (no routes or tests) |  |
| TC-081 | P3 | FR-1003 | Webhook | BLOCKED | (none) | Webhook not built (no tests); M-04 self-hosted receiver script written |  |
| TC-090 | P1 | NFR-02 | Load | NOT RUN | tc-090-load.js, seed.test.mjs | k6 script and seeder ready, never run; needs a runner and a target (pilot AWS or local stack) | AWS pilot |
| TC-091 | P2 | NFR-01 | Code execution latency | NOT RUN | tc-090-load.js, tc-091-code-run.js | k6 script ready, never run; needs a real Judge0 for a meaningful run | AWS pilot |
| TC-092 | P1 | NFR-06 | Accessibility | PARTIAL | qa-tc.test.tsx, candidate-test.spec.ts | Axe on staff screens and the 2FA dialog; candidate stepper in jsdom only; NVDA and VoiceOver passes (humans) not done |  |
| TC-093 | P1 | NFR-04 | OWASP scan | NOT RUN | evaluate.test.mjs | ZAP workflow and config ready; never run; needs a reachable stack (QA B) |  |
| TC-094 | P2 | NFR-05 | Deletion on request | PARTIAL | staff-shell.spec.ts, clocks.spec.ts; walk 2026-10-10 (demo, generated media) | Retention/erasure schema and flow tests pass; async erasure end to end and the admin UI not walked |  |
| TC-095 | P1 | FR-401 | Sign the consent document (added 2026-10-01, D-17) | VERIFIED (manual) | candidate-session.e2e-spec.ts, candidate-interim.spec.ts; walk 2026-10-10 (demo, generated media) | Consent signed with the typed name and 18+ box, one request, copy email arrives (walk); PDF store tests pass |  |
| TC-096 | P1 | FR-401 | Decline the consent document (added 2026-10-01, D-17) | PARTIAL | candidate-session.e2e-spec.ts, settings.test.tsx; walk 2026-10-10 (demo, generated media) | Decline route and UI tests exist; not walked |  |
| TC-097 | P2 | FR-106 | Wrong OTP during a test (added 2026-10-01, D-21) | PARTIAL | candidate-session.e2e-spec.ts, events.test.ts; walk 2026-10-10 (demo, generated media) | Resume code path partly walked (new code after reload, wrong code refused); the in-test wrong-code limit not run |  |
| TC-098 | P1 | FR-107 | Staff password reset (added 2026-10-01, D-22) | VERIFIED (auto) | auth.e2e-spec.ts, users.e2e-spec.ts |  |  |
| TC-099 | P3 | FR-205 | Short answer needing manual scoring (added 2026-10-01, D-23) | PARTIAL | answers.e2e-spec.ts, review-decisions.e2e-spec.ts; walk 2026-10-10 (demo, generated media) | Reviewer scoring PATCH 200 and verdict walked on coding answers; a SHORT_ANSWER answer (#411) not yet walked |  |
| TC-100 | P1 | FR-202, FR-301 | Staff/recruiter redaction (extends TC-011; DL-32, DL-34; added 2026-10 | PARTIAL | tc-011.int.test.ts, tc-100-revision.int.test.ts | Revision tests exist for question and test routes; sweep of PATCH variants listed in follow-ups |  |
| TC-101 | P1 | NFR-04 | OIDC role isolation (added 2026-10-06, ADR 0017 sections 6 and 7) | BLOCKED | (none) | infra/aws offline policy test and owner-run IAM simulation not written; needs the pilot AWS account | AWS pilot |
| TC-102 | P1 | NFR-03 | Start and stop around a slot (added 2026-10-06, ADR 0017 4.1, 4.2) | NOT RUN | (none) | Runbook step; needs the provisioned pilot (start/stop around a slot) | AWS pilot |
| TC-103 | P1 | NFR-05 | Restore drill from S3 (added 2026-10-06, ADR 0017 5.3, 5.4) | NOT RUN | (none) | Restore drill; needs the pilot backups bucket and a throwaway instance (never a dev machine) | AWS pilot |
| TC-104 | P2 | NFR-05 | Daily maintenance wake (added 2026-10-06, ADR 0017 4.5, C-47) | NOT RUN | (none) | Daily wake; needs the pilot scheduler | AWS pilot |
| TC-105 | P1 | NFR-02 | Pilot capacity: 5 concurrent candidates (added 2026-10-06, C-49 gate) | NOT RUN | seed.test.mjs | Capacity gate; plan done (qa.md section 23); scenario script not written; needs the pilot instances and the k6 runner module | AWS pilot |
| TC-106 | P1 | FR-306 | Slot rules (added 2026-10-06, ADR 0017 4.1, 4.3, 4.7) | PARTIAL | schedule-capacity.spec.ts, scheduled-windows.spec.ts | Slot-rule specs exist (schedule-capacity, scheduled-windows); not run against the real API in the UI |  |
| TC-107 | P1 | FR-407 | Closed-instance page (added 2026-10-06, ADR 0017 4.6, C-46) | BLOCKED | (none) | Static closed-instance page and instance stop are pilot-only; no test file | AWS pilot |
| TC-108 | P1 | NFR-03 | Hard ceiling cannot be cancelled or bypassed by the host (added 2026-1 | NOT RUN | (none) | IAM simulation and live check; needs the pilot AWS | AWS pilot |
| TC-109 | P1 | NFR-04 | Judge0 instance isolation (added 2026-10-06, C-45, ADR 0017 9) | NOT RUN | (none) | Judge0 isolation checks; needs the pilot Judge0 instance | AWS pilot |
| TC-110 | P1 | NFR-04 | Signed release at boot (added 2026-10-06, ADR 0017 6) | NOT RUN | (none) | Signed release at boot; needs the pilot | AWS pilot |
| TC-111 | P2 | FR-307 | Schedule view and review windows (added 2026-10-06, ADR 0017 4.1) | PARTIAL | call-sites.spec.ts, schedule-capacity.spec.ts; walk 2026-10-10 (demo, generated media) | Schedule view specs exist; UI not walked |  |
| TC-112 | P1 | NFR-04 | API DNS reset on stop (added 2026-10-06, ADR 0017 section 8) | NOT RUN | (none) | API DNS reset on stop; needs the pilot | AWS pilot |
| TC-113 | P1 | NFR-04 | Session Manager restricted (added 2026-10-06, ADR 0017 section 3, C-50 | NOT RUN | (none) | Session Manager restriction; needs the pilot AWS | AWS pilot |
| TC-114 | P1 | NFR-04 | Main-instance IMDS isolation (added 2026-10-06, ADR 0017 section 3) | NOT RUN | (none) | IMDS isolation on the main instance; needs the pilot | AWS pilot |
| TC-115 | P2 | FR-402 | No-microphone path (added 2026-10-07, P-44) | BLOCKED | (none) | Accommodations ADR not accepted; no code or tests |  |
| TC-116 | P2 | FR-305 | Extra time over 100% and the assistive input label (added 2026-10-07,  | BLOCKED | (none) | Accommodations ADR not accepted; no code or tests |  |
| TC-117 | P2 | FR-403 | Camera alternatives (added 2026-10-07, P-44) | BLOCKED | (none) | Accommodations ADR not accepted; no code or tests |  |
