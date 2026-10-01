# Project status

Owner: project-manager. As of 2026-10-01. Sources: /docs/build-plan.md, /docs/requirements-trace.md.

## 1. Blocked and needs a human (read first)

| # | Item | Blocks | What the human must do |
| --- | --- | --- | --- |
| B-01 | **Cleared 2026-10-01 by the initial commit.** `main` had no commits (untracked: .claude/, .gitignore, CLAUDE.md, docs/). Branches and git worktrees for agents cannot be created. | Every task | Make the initial commit on main (docs, CLAUDE.md, .claude/agents, .gitignore). Decide whether `.claude/agents-generated-backup/` is committed or ignored. |
| B-02 | Schema questions Q-01..Q-17, Q-23, Q-24 and the review findings routed to ARC-01 (D-03) are open. DB-02 must not start before the schema freeze list (ADR 0008) exists. | ARC-01, DB-02, and everything after | Decide the ARC-01 options when they arrive; A-01 (variant model) and A-03 (section timing) come first. |
| B-03 | Change requests PA-01..PA-06 (section 8) need approval. | DB-01 CI file, BE-15 split, ARC gates | Approve, reject or amend. |
| B-04 | No owning agent for DEP-01, DEP-02 (Q-36). FE-14 is out of scope for this build (D-13). | DEP-01 (Phase 4) | Choose owners; proposals are in build-plan.md section 2. |

## 2. Current phase and progress

- **Current phase:** Phase 0, Kickoff and contracts. The plan, trace and first three briefs are written. No task has started.
- **Next milestone:** M0 (schema freeze list approved, contracts v0 published, first commit on main).

| Measure | Value |
| --- | --- |
| Tasks started | 0 of 48 |
| Tasks done (merged) | 0 of 48 |
| Test cases verified | 0 of 67 (0 of 48 P1) |
| Requirements Done | 0 of 81 (15 BR, 57 FR, 9 NFR) |
| Branches open | 0 |
| Open questions | 41 open of 44 (section 6; Q-07, Q-27 and Q-41 closed), plus 31 review findings A-01..A-31 in /docs/adr/review-2026-09-30-plan-and-schema.md |
| Open risks | 14 (section 5) |

## 3. Done this period

- Read CLAUDE.md, all /docs files, all four prompt playbooks and all agent definitions.
- Wrote /docs/build-plan.md (48 tasks, 7 phases, dependency graph, gates).
- Wrote /docs/requirements-trace.md (81 requirements, 67 TCs, gap lists).
- Wrote this file and the first three briefs in /docs/briefs/.
- Nothing else. No code, no commits.
- 2026-10-01: architect wrote ADR 0001 (overall architecture) and a review note with 31 findings. The owner accepted ADR 0001 and took decisions D-01..D-09 (section 9). Applied: ADR renumbering in the ARC-01 and DB-02 briefs, ARC-01 scope widened, frontend.md Step 9 (OTP before consent), code-reviewer privacy rule, Redis 8.8 in DB-01, AWS in architecture.md Deployment.

## 4. Next up

1. ARC-01 (architect) and DB-01 (db-engineer) start together; neither depends on the other.
2. DB-02 (db-engineer) after DB-01 is merged and the ARC-01 freeze list is approved.
3. QA-01A (qa-engineer, docs only) can use any idle slot.

## 5. Risks

| ID | Risk | Impact | Mitigation / owner |
| --- | --- | --- | --- |
| R-01 | Judge0 CE needs an x86 host, privileged containers and (historically) cgroup v1. The developer machine is macOS; Judge0 on Docker Desktop or Apple Silicon may not run the sandbox reliably. Hosting is AWS (D-04): pick an x86 instance and OS image that run the sandbox. Verify current Judge0 cgroup support. | BE-05 P1 tests (TC-042..TC-044) and staging | ARC-05 feasibility spike before BE-05; run integration tests on a Linux x86 runner or VM |
| R-02 | Request volume estimate (PM estimate, unverified): per-chunk presign and confirm for 3 streams, events every 5 s, keystrokes every 2 s, heartbeat every 10 s gives roughly 250-300 requests per second at 200 candidates on one VM against p95 under 300 ms | TC-090 (P1), NFR-01, NFR-02 | Architect to consider batched presign and larger keystroke batches in ARC-02; BE-15A k6 scripts must use the real cadence |
| R-03 | R2 free tier (believed 10 GB) versus roughly 0.3-0.4 GB per 60 minute session (PM estimate) and 90 day retention; DB backups also go to R2 | A 20 candidate pilot may use 7 GB or more; BO-5 | Verify current R2 limits; decide budget in DEP-02; tune bitrates in FE-07 |
| R-04 | Detectors and the HMAC key live in the candidate's browser; a motivated candidate can forge events or disable detectors | Integrity claims overstated | Server-side checks in BE-12; QA-02 documents bypasses; state the limit to stakeholders |
| R-05 | Liveness and face checks run client-side; `identity_checks.liveness_passed` is client-reported | TC-034 weak | ARC-04 decision; manual review path |
| R-06 | False positives and bias (BRD section 7 and 9); no task monitors flag rates across groups (Q-34) | Legal and reputational | Configurable thresholds, human verdicts, pilot tuning |
| R-07 | Legal approval of consent text and retention (BIPA, GDPR, CCPA) is on the path to pilot | Pilot start | Human action, Q-43; DEP-02 lists it |
| R-08 | Next.js App Router with nonce-based CSP middleware on Cloudflare Pages needs an adapter and edge runtime constraints; self-hosted MediaPipe and TF.js model files are large | FE-01, DEP-01 | ARC-05 decision before FE-01 is finished |
| R-09 | Merge hot spots: packages/shared (events.ts, permission matrix), apps/api app module, apps/worker shared by BE-08 and BE-12, prisma schema after freeze | Conflicts, rework | Architect owns shared; merge order by dependency; PR notes |
| R-10 | Frontend builds on MSW mocks; drift from the real API | Late integration bugs | ARC-02 contract; FE-13 unmock sweep |
| R-11 | Seed reference solutions (6 questions x 3 languages) are unverified until Judge0 exists | Bad demo data | BE-05 validates all seeded questions |
| R-12 | Browser API limits: displaySurface, getScreenDetails, isExtended are Chromium-specific; devtools detection is heuristic; blocking keys and paste can harm screen-reader users (BR-12) | False positives, accessibility conflicts | SDK capability flags; accommodations honored; QA-02 |
| R-13 | One AWS VM (D-04) runs API, worker (face model, VAD), Redis, Judge0 and its DB | Memory and CPU pressure | ARC-05 sizing; DEP-01 measurements |
| R-14 | No effort or date data in the docs; BRD has no target date | No schedule can be promised | Human to supply a target if one exists |

## 6. Open questions (doc contradictions, gaps and ambiguities)

CLAUDE.md says if code and docs disagree, stop and ask. No code exists yet, so these are disagreements between the docs. Nothing below has been resolved; the plan assumes nothing unless stated. "Decider" is the suggested owner of the answer.

### A. Schema and data model (gate for ARC-01 and DB-02)

| ID | Topic | Doc references | Blocks | Decider |
| --- | --- | --- | --- | --- |
| Q-01 | INVITED and EXPIRED cannot be stored. FSD has states INVITED and EXPIRED, but `sessions.invitation_id` is NOT NULL and `status` defaults to OPENED, so no session row exists before the link is opened; `invitations` has no status column. TC-022 expects "status EXPIRED". No backend step has an expiry job. | fsd.md section 3; database.md `sessions`, `invitations`; test-cases.md TC-022; backend.md Steps 6, 7 | ARC-01, DB-02, BE-06, BE-07 | Human + architect |
| Q-02 | HMAC key timing. Step 7 generates the key on the transition to IN_PROGRESS and returns it "once", but `sessions.hmac_key_enc` is NOT NULL on a row that starts at OPENED. Architecture says the key is issued "at start". A reload mid-test (TC-045, TC-063) would lose a key that was returned once. | backend.md Step 7; database.md `sessions`; architecture.md Security architecture | ARC-01, ARC-03, BE-07, FE-06 | Architect |
| Q-03 | Recovery codes (hashed) have no column. | backend.md Step 2; database.md `users` | ARC-01, BE-02 | Architect |
| Q-04 | Candidate OTP (6 digits, 10 min, 5 attempts) and the 30 minute link block plus recruiter notification (TC-007) have no storage, and Step 6 lists no email template for the recruiter notification. | backend.md Steps 6, 7; test-cases.md TC-007; database.md | ARC-01, BE-06, BE-07 | Architect |
| Q-05 | "Whole token family revoked" (TC-005) but `refresh_tokens` has only `replaced_by`, no family id. | fsd.md FR-104; test-cases.md TC-005; database.md `refresh_tokens` | ARC-01, BE-02 | Architect |
| Q-06 | Face embeddings ("expose the embedding", "delete embeddings with the session") have no table or column, and retention does not list them. | backend.md Step 8; database.md `identity_checks`, Data rules | ARC-01, BE-08, DB-06 | Architect |
| Q-07 | **Closed 2026-10-01 (D-12): authors collect solutions from 2-3 AI assistants at publish time; similarity only; refreshed periodically. Storage in ARC-01 ADR 0005.** FR-803 and Step 12 compare against "stored AI-generated reference answers"; no table or column exists (`reference_solution` is the author's) and no step generates them. | fsd.md FR-803; backend.md Step 12; database.md `question_versions` | ARC-01, ARC-04, BE-12 | Human + architect |
| Q-08 | `event_type` enum lacks types the docs need: SIDE_CAMERA disconnect (TC-036), drop attempt (FR-603, TC-053), extension interference (FR-610), matching "resume" events (Step 10), idle-then-complete (FR-802), SDK capability flags. DDL is authoritative, so additions need an ADR. | database.md enum `event_type`; test-cases.md TC-036, TC-053; fsd.md FR-603, FR-610, FR-802; backend.md Step 10 | ARC-01, ARC-02, BE-10, FE-06 | Architect |
| Q-09 | Step 12 says default weights are "in FR-804", but FR-804 gives only bands. No default severity per event type (FR-801) and no default weights exist; TC-075 needs them. | backend.md Step 12; fsd.md FR-801, FR-804; test-cases.md TC-075 | ARC-01, BE-12 | Human + integrity-engineer |
| Q-10 | Org scoping for child tables. Only `users`, `questions`, `tests`, `candidates`, `audit_logs` carry `org_id`. Step 5 adds an automatic `org_id` filter for tables that have it; `sessions`, `submissions`, `proctor_events` etc. are scoped only through parent chains, yet TC-008 requires org B sessions to return 404. Data rules also says every table "except audit_logs" is scoped through its parents, although `audit_logs` has `org_id` directly. | database.md Data rules, DDL; prompts/database.md Step 5; test-cases.md TC-008 | ARC-01, DB-02, DB-05 | Architect |
| Q-11 | Retention scope and clock. Rules cover only `media_chunks` and `identity_checks` keys, but JPEG evidence (`proctor_events.evidence_key`), report PDFs in R2 (Step 14), face embeddings (Step 8) and keystroke batches also hold candidate data. "Sessions older than" names no timestamp. No entry point for admin erasure. | fsd.md FR-704, NFR-05; database.md Data rules; frontend.md Step 8; backend.md Steps 8, 14; prompts/database.md Step 6 | ARC-01, DB-06, BE-09 | Human (privacy) + architect |
| Q-12 | `identity_checks.status` is free text (values undefined); no fields or workflow for "manual approval" (who, where, UI); liveness is client-reported; retries create several rows per session. | database.md `identity_checks`; fsd.md FR-403; test-cases.md TC-033; backend.md Step 8; frontend.md Steps 9, 11 | ARC-01, BE-08, FE-11 | Human + architect |
| Q-13 | Practice question (FR-406) has no data model or API. | fsd.md FR-406; frontend.md Step 9 item 8; database.md | ARC-01, FE-09 | Human |
| Q-14 | MCQ and short-answer flow is undefined: candidate answering, storage (`submissions` has code columns only), scoring (FR-506 is test weights only), short-answer grading. TC-014 expects auto-scoring. | fsd.md FR-205, FR-506; test-cases.md TC-014; backend.md Steps 4, 11; frontend.md Step 10; database.md `submissions` | ARC-01, BE-04, BE-11, FE-10 | Human |
| Q-15 | Migration creates role `app_user` and revokes on `audit_logs`, but the docs do not say how the role gets login credentials, which role runs migrations, or how this works on Supabase or Neon. | prompts/database.md Step 3; architecture.md Deployment; agents-qa-deploy.md Deploy 1 | ARC-01, DB-03, DEP-01 | Architect |
| Q-16 | Org settings and consent version. Frontend Step 3 edits retention days, risk weights and consent text version in Settings; Step 7 reads `consent_version` "from config"; Step 12 reads weights from organization settings; no backend step provides org settings endpoints. | frontend.md Step 3; backend.md Steps 7, 12; database.md `organizations.settings` | ARC-01, ARC-02, FE-03, BE-07 | Architect |
| Q-17 | Doc hygiene. ERD shows `users.totp_secret`, DDL has `totp_secret_enc`. Data rules wording about `audit_logs`. Table count (24) is correct. | database.md ERD, DDL, Data rules | ARC-01 | Architect |

### B. API and integration contracts (gate for ARC-02 and ARC-04)

| ID | Topic | Doc references | Blocks | Decider |
| --- | --- | --- | --- | --- |
| Q-18 | FSD section 4 is titled "Core API" but prompts and TCs need endpoints it lacks: candidate fetch of session and questions (TC-011), draft autosave and restore (Step 11 PUT draft, TC-045), heartbeat, timer sync, logout and 2FA enroll, identity status, media confirm, staff media playlist, room scan, side-camera pairing, candidate list and status and results for recruiters (BRD section 4, FE-05), org settings, appeals, webhook admin, dashboard, CSV, user management, practice question, admin erasure. | fsd.md section 4; backend.md Steps 2, 3, 7, 8, 9, 11, 13, 14; frontend.md Steps 5, 9, 10; test-cases.md TC-011, TC-045; brd.md section 4 | ARC-02 | Architect |
| Q-19 | Identity upload method conflicts. FSD says POST identity "Upload ID + selfie"; Step 8 says it accepts R2 keys uploaded through presigned URLs; Step 9 defines presign only for `sessions/{id}/{stream}/{seq}.webm`. No key layout or content type for ID image, selfie, evidence JPEG, report PDF. Architecture says heavy media never passes through the API. | fsd.md section 4; backend.md Steps 8, 9; frontend.md Step 8; architecture.md overview | ARC-02, ARC-03, BE-08, BE-09 | Architect |
| Q-20 | Candidate realtime channel undefined. FSD lists WS /live for Reviewer only; Step 13 emits `proctor:pause` and `proctor:message` to "a specific candidate socket"; FE-10 shows proctor messages from "the live channel"; FE-12 adds a resume action that FR-903 does not mention. | fsd.md section 4, FR-903; backend.md Step 13; frontend.md Steps 10, 12; test-cases.md TC-079 | ARC-02, BE-13, FE-10 | Architect |
| Q-21 | Worker-to-API. Step 7 makes SessionStateService the only writer of `sessions.status`; Step 12 has the Python worker move sessions to UNDER_REVIEW or COMPLETED. No internal API or service auth is defined. Architecture names BullMQ (Node) as the queue while Step 8 describes a Python "job consumer". | backend.md Steps 7, 8, 12; architecture.md Components, sequence | ARC-04, BE-08, BE-12 | Architect |
| Q-22 | GRADED ordering. FSD: GRADED means hidden tests and risk score done. Step 11 moves to GRADED when grading completes then enqueues analysis; Step 12 then moves to UNDER_REVIEW or COMPLETED. | fsd.md section 3; backend.md Steps 11, 12 | ARC-02, ARC-04, BE-11, BE-12 | Architect |

### C. Behavior and security policy (gate for ARC-03)

| ID | Topic | Doc references | Blocks | Decider |
| --- | --- | --- | --- | --- |
| Q-23 | "Usable once" versus resume. FR-303 and TC-021 say the link is single-use; TC-045, TC-063 and FR-609 need the candidate to reopen mid-test. When is `used_at` set and is the OTP required again? | fsd.md FR-303, FR-609; test-cases.md TC-021, TC-045, TC-063; backend.md Step 7 | ARC-01 (moved by D-08), BE-07 | Human + architect |
| Q-24 | Paused time. Step 10 adds paused time to `paused_ms` and extends `deadline_at` for FULLSCREEN_EXIT and SCREEN_SHARE_STOPPED; FR-505 and FR-609 say server time continues. A candidate could pause to gain time. No cap defined. | backend.md Step 10; fsd.md FR-505, FR-601, FR-609; test-cases.md TC-050, TC-079 | ARC-01 (moved by D-08), BE-10 | Human |
| Q-25 | Architecture binds the candidate token to session ID and a device fingerprint; Step 7 binds to session ID only. | architecture.md Security architecture; backend.md Step 7; database.md `sessions.device_info` | ARC-03, BE-07 | Architect |
| Q-26 | HMAC details. "Canonical JSON" is not specified; the key is held in the browser (forgery possible by a determined candidate); Step 10 says keystrokes use the "same scheme" but the SDK step lists no keystroke signing (FR-608 is in Frontend Step 10). | architecture.md Security architecture; backend.md Step 10; frontend.md Steps 6, 10; test-cases.md TC-065 | ARC-03, BE-10, FE-06, FE-10 | Architect |
| Q-27 | **Closed 2026-10-01 (D-05): keep InsightFace, non-commercial use.** Step 8 names InsightFace. To the PM's knowledge its published pretrained models are licensed for non-commercial research only; CLAUDE.md says prefer free and open-source tools. Needs a licence check. | backend.md Step 8; CLAUDE.md Rules | ARC-04, BE-08 | Human + architect |
| Q-28 | Seed creates four staff users with the known password "ChangeMe!2026". Nothing stops it from running on staging. | prompts/database.md Step 4; agents-qa-deploy.md Deploy 1 | DB-04, DEP-01 | Human |

### D. Requirements and traceability

| ID | Topic | Doc references | Blocks | Decider |
| --- | --- | --- | --- | --- |
| Q-29 | test-cases.md says 67 cases "cover every FSD module". M11 has none, and FR-302, FR-406, FR-501, FR-702, FR-801, FR-1001, FR-1002 also have none. BRD launch criterion is "all P1 test cases passing". | test-cases.md intro; fsd.md section 2; brd.md section 10 | QA-01A | Human |
| Q-30 | TC-065 has "Security" in the requirement column. No FR covers event signing. | test-cases.md TC-065; architecture.md Security architecture | QA-01A | Human |
| Q-31 | NFR-03, NFR-07, NFR-08, NFR-09 have no direct TC. | fsd.md section 5; test-cases.md | QA-01A | Human |
| Q-32 | FRs with no parent BR; BR-12 sits under M4 in FSD section 1 while accommodations (FR-305) are in M3 and "screen-reader support" has no FR; BR-08 has no TC for variant assignment. | fsd.md section 1; brd.md section 6 | Trace accuracy | Human |
| Q-33 | 14 TCs are named by no prompt step (TC-007, 032, 034, 035, 036, 053, 054, 056, 057, 058, 059, 060, 064, 093); 7 are P1. The plan assigns owners (PM-assigned in the trace). | test-cases.md; all four prompts | Plan accuracy | Human |
| Q-34 | BRD section 7 says flag rates are monitored across groups. No FR, TC or task implements this, and FR-1002 reports flag rate by type only. | brd.md section 7; fsd.md FR-1002 | Compliance | Human (legal) |
| Q-35 | Partial build coverage: FR-904 (no candidate appeal page, reviewer appeal UI or verdict email; email templates list has none), FR-1003 (session.reviewed, CSV and webhook admin UI), FR-1103 (server attestation), NFR-09 (per-session trace ID; BE-01 has per-request). | fsd.md FR-904, FR-1003, FR-1103, NFR-09; backend.md Steps 1, 6, 13, 14; frontend.md Steps 13, 14 | Plan accuracy | Human |

### E. Process, agents and infrastructure

| ID | Topic | Doc references | Blocks | Decider |
| --- | --- | --- | --- | --- |
| Q-36 | Agent names differ: the orchestrator prompt uses backend-core, backend-media, backend-integrity, backend-review, frontend-staff, frontend-candidate, frontend-review, hardening, qa; `.claude/agents/` has backend-engineer, integrity-engineer, etc. Step 11 belongs to backend-integrity in the prompt but to backend-engineer in its agent definition. Deploy 1 and 2, BE-15 and FE-14 have no clear owner. | agents-qa-deploy.md orchestrator; .claude/agents/*; .claude/agents-generated-backup/ | Dispatch | Human |
| Q-37 | SDK start timing differs: project-manager.md says after BE-07 (parallel with BE-08..12); the orchestrator prompt starts it with backend-core; frontend.md says the frontend can start alongside Backend Step 2 by mocking an OpenAPI spec that does not exist until BE-01. The plan follows the orchestrator and adds ARC-02. | project-manager.md; agents-qa-deploy.md; frontend.md intro | Wave 2 | Human |
| Q-38 | "Steps 8-12 in parallel" hides dependencies: BE-08 needs BE-09's presign; BE-12 needs the worker scaffold from BE-08, StorageService, events and submissions. Encoded in the plan. | backend.md Before you start, Steps 8, 9, 12 | Wave 3 | Human (confirm) |
| Q-39 | DB-05 and DB-06 need NestJS in apps/api, but NestJS setup is BE-01 and DB-01 says "empty apps". Plan assumes DB-05 creates a minimal module structure that BE-01 extends. | prompts/database.md Steps 1, 5, 6; backend.md Step 1 | DB-05 | Human (confirm) |
| Q-40 | No step creates baseline lint, type-check, test scripts or CI, yet DB-08 says "passes in CI", Step 15 says "secrets scanning in CI", QA 1 adds a CI job, and every agent's DoD says run lint and type-check. Proposed as PA-01. | prompts/database.md Step 8; backend.md Step 15; agents-qa-deploy.md QA 1; architecture.md layout | DB-01 | Human |
| Q-41 | **Closed 2026-10-01 (D-13): out of scope for this build; FE-14 moves to a later phase.** Lockdown scope. Frontend Step 14, FR-1101..FR-1103, BR-11 (Should, Phase 3); orchestrator omits Step 14; no TC; server attestation has no backend step. In or out of this build? | frontend.md Step 14; agents-qa-deploy.md; brd.md section 5; fsd.md M11 | FE-14 | Human |
| Q-42 | STRICT profile uses a phone as side camera, but NFR-07 blocks Safari, recorders use webm (VP8/Opus), which iOS Safari does not record, and BRD puts mobile test-taking out of scope. | fsd.md FR-405, NFR-07; frontend.md Steps 7, 9; brd.md section 5 | FE-07, FE-09 | Human + architect |
| Q-43 | Who supplies and approves the consent text and retention wording (BRD says Legal must approve before launch)? Needed for real copy in FE-09 and for the consent version. | brd.md section 7, section 10; fsd.md FR-401; frontend.md Step 9 | FE-09, DEP-02 | Human (legal) |
| Q-44 | Refresh cookie is `SameSite=Strict` (Step 2, FE-02) but web (Cloudflare Pages) and API (VM) are on separate origins on staging; Strict cookies are not sent cross-site, so silent refresh would fail unless both share one registrable domain. | backend.md Step 2; frontend.md Step 2; architecture.md Deployment | ARC-05, FE-02, DEP-01 | Human + architect |

## 7. Task table

Status values: Not started, In progress, In review, Changes requested, Done (merged), Blocked. "Blocked by" shows the open gate.

| ID | Title | Owner | Status | Blocked by | Review | Merged |
| --- | --- | --- | --- | --- | --- | --- |
| ARC-01 | Schema readiness review (widened, D-03, D-08) | architect | Not started | Human answers (to finalize) | | |
| ARC-02 | Shared contracts and API contract v0 | architect | Not started | DB-01, ARC-01 | | |
| ARC-03 | Security model ADRs | architect | Not started | ARC-01 | | |
| ARC-04 | Worker and async integration ADR | architect | Not started | ARC-01, ARC-03 | | |
| ARC-05 | Deployment and Judge0 host feasibility | architect | Not started | human-provisioned x86 host | | |
| DB-01 | Monorepo and local infrastructure | db-engineer | Not started | B-01 | | |
| DB-02 | Prisma schema | db-engineer | Not started | DB-01, ARC-01 | | |
| DB-03 | Migrations | db-engineer | Not started | DB-02 | | |
| DB-04 | Seed data | db-engineer | Not started | DB-03 | | |
| DB-05 | Org scoping helpers | db-engineer | Not started | DB-03 | | |
| DB-06 | Retention and erasure services | db-engineer | Not started | DB-05 | | |
| DB-07 | Backups and restore | db-engineer | Not started | DB-03 | | |
| DB-08 | Database verification | db-engineer | Not started | DB-03..DB-07 | | |
| BE-01 | API foundation | backend-engineer | Not started | DB-08 | | |
| BE-02 | Staff authentication | backend-engineer | Not started | BE-01, ARC-03 | | |
| BE-03 | RBAC and audit logging | backend-engineer | Not started | BE-02, ARC-02 | | |
| BE-04 | Question bank | backend-engineer | Not started | BE-03 | | |
| BE-05 | Code execution with Judge0 | backend-engineer | Not started | BE-04, ARC-05 | | |
| BE-06 | Tests, invitations and email | backend-engineer | Not started | BE-05 | | |
| BE-07 | Candidate session and state machine | backend-engineer | Not started | BE-06, ARC-03 | | |
| BE-08 | Identity verification service | integrity-engineer | Not started | BE-07, BE-09, ARC-04 | | |
| BE-09 | Media storage (R2) | backend-engineer | Not started | BE-07, ARC-03 | | |
| BE-10 | Proctor events and keystroke ingestion | integrity-engineer | Not started | BE-07, ARC-02, ARC-03 | | |
| BE-11 | Run, submit and grading | backend-engineer | Not started | BE-07 | | |
| BE-12 | Integrity analysis worker | integrity-engineer | Not started | BE-08..BE-11, ARC-04 | | |
| BE-13 | Review and live proctoring API | backend-engineer | Not started | BE-12, ARC-02 | | |
| BE-14 | Reports and integrations | backend-engineer | Not started | BE-13 | | |
| BE-15A | Security review and fixes | backend-engineer | Not started | BE-14 | | |
| BE-15B | Staging load tuning | backend-engineer | Not started | BE-15A, DEP-01 | | |
| FE-01 | Web app foundation | frontend-engineer | Not started | DB-08, ARC-02 | | |
| FE-02 | Staff authentication screens | frontend-engineer | Not started | FE-01 | | |
| FE-03 | Staff shell and navigation | frontend-engineer | Not started | FE-02 | | |
| FE-04 | Question bank UI | frontend-engineer | Not started | FE-03 | | |
| FE-05 | Tests and invitations UI | frontend-engineer | Not started | FE-04 | | |
| FE-06 | Proctor SDK: browser lock and events | proctor-sdk-engineer | Not started | DB-08, ARC-02, ARC-03 | | |
| FE-07 | Proctor SDK: recording pipeline | proctor-sdk-engineer | Not started | FE-06 | | |
| FE-08 | Proctor SDK: in-browser AI detectors | proctor-sdk-engineer | Not started | FE-07 | | |
| FE-09 | Candidate pre-test flow | frontend-engineer | Not started | BE-07, FE-01, FE-08 | | |
| FE-10 | Candidate test screen | frontend-engineer | Not started | FE-09 | | |
| FE-11 | Review workspace | frontend-engineer | Not started | FE-03, FE-10 | | |
| FE-12 | Live proctoring | frontend-engineer | Not started | FE-03, FE-10 | | |
| FE-13 | Dashboard, reports, polish | frontend-engineer | Not started | FE-09..FE-12, BE-14 | | |
| FE-14 | Lockdown client (later phase) | TBD | Out of scope (D-13) | | | |
| QA-01A | Test matrix and manual scripts | qa-engineer | Not started | none | | |
| QA-01B | Automation, CI gate, scans | qa-engineer | Not started | BE-14, FE-13, DEP-01 | | |
| QA-02 | Red team | qa-engineer | Not started | DEP-01, BE-15A, FE-13 | | |
| DEP-01 | Staging on AWS | TBD | Not started | ARC-05, BE-12, FE-10 | | |
| DEP-02 | Production readiness review | TBD | Not started | BE-15B, QA-01B, QA-02 | | |

## 8. Change requests (plan additions awaiting human approval)

| ID | Proposal | Reason | Status |
| --- | --- | --- | --- |
| PA-01 | In DB-01, add root `lint`, `typecheck`, `test` scripts and a baseline CI workflow. The scripts and strict tsconfig and `no-explicit-any` rule follow CLAUDE.md and every agent's DoD; the CI workflow file is the part that needs approval. | Q-40 | Proposed |
| PA-02 | Add architect gate tasks ARC-01..ARC-05. | PM routing rules: schema, shared contracts and security go to the architect first; Q-01..Q-28 | Proposed |
| PA-03 | Split Backend Step 15 into BE-15A (audit, fixes, k6 scripts) and BE-15B (tuning on staging). | Tuning needs the staging VM from DEP-01 | Proposed |
| PA-04 | Split QA 1 into QA-01A (matrix and manual scripts, docs only, start early) and QA-01B (automation, CI gate, scans, last). | Matrix does not depend on code | Proposed |
| PA-05 | In BE-05, also run the validate job over all seeded questions. | R-11 | Proposed |
| PA-06 | In DB-05, create a minimal NestJS module structure if BE-01 has not run. | Q-39 | Proposed |

## 9. Decision log

| ID | Date | Decision | By |
| --- | --- | --- | --- |
| D-01 | 2026-10-01 | ADR 0001 (overall architecture) accepted. | Harsh Trivedi |
| D-02 | 2026-10-01 | ARC-01 ADRs renumbered 0002 to 0007; schema freeze list is 0008; ARC-02..ARC-05 ADRs take 0009 onward. | Harsh Trivedi |
| D-03 | 2026-10-01 | ARC-01 widened to the review's schema findings (review section 5). Variant model (A-01) and per-section timing (A-03) are decided before DB-02. | Harsh Trivedi |
| D-04 | 2026-10-01 | Hosting on AWS instead of Oracle Always Free. BO-5's free-tier pilot no longer applies to hosting. Layout details in ARC-05. | Harsh Trivedi |
| D-05 | 2026-10-01 | Keep InsightFace pretrained models. Owner states CodeProctor is non-commercial, which the model licence permits. Revisit before any commercial use. Closes Q-27. | Harsh Trivedi |
| D-06 | 2026-10-01 | OTP before consent in the candidate stepper; frontend.md Step 9 amended (review A-05). | Harsh Trivedi |
| D-07 | 2026-10-01 | code-reviewer privacy rule allows the FR-702 IndexedDB upload buffer (review A-12). | Harsh Trivedi |
| D-08 | 2026-10-01 | Pause and resume policy (Q-23, Q-24) and a retention hold during review and appeals (A-09) to be decided now, in ARC-01 (ADRs 0002 and 0004). | Harsh Trivedi |
| D-09 | 2026-10-01 | Redis 8.8 under its AGPLv3 licence option replaces `redis:7` (review A-19). | Harsh Trivedi |
| D-10 | 2026-10-01 | The pilot gets its own stack, separate from staging: its own instance, database and storage bucket. Staging holds synthetic data only (review A-14). | Harsh Trivedi |
| D-11 | 2026-10-01 | Pilot and production keep candidate data in AWS: the database and recordings storage sit alongside the compute. The web front end stays on Cloudflare Pages. Staging may use Supabase/Neon and R2 free tiers with synthetic data only. | Harsh Trivedi |
| D-12 | 2026-10-01 | Q-07: question authors generate AI reference solutions at publish time by running each question through 2-3 popular AI assistants. They are stored for similarity checks only, never used for grading, and refreshed periodically. | Harsh Trivedi |
| D-13 | 2026-10-01 | Q-41: the lockdown client is out of scope for this build; FE-14 moves to a later phase. | Harsh Trivedi |
| D-14 | 2026-10-01 | brd.md BO-5 and the section 8 constraint, and fsd.md FR-401, updated to match D-04, D-06, D-10 and D-11. | Harsh Trivedi |

## 10. Next 3 tasks, blockers, decisions

- **Next 3 tasks:** ARC-01 (architect, widened, /docs/briefs/ARC-01.md; running from 2026-10-01 on branch `arch/adr-schema-gaps`). DB-01 (db-engineer) is on hold until the owner approves the ARC-01 ADRs. DB-02 follows DB-01 and ADR 0008.
- **Blockers:** B-02 to B-04 above. B-01 is cleared by the initial commit on 2026-10-01.
- **Decisions still needed from a human:** decide ARC-01's options, A-01 and A-03 first (B-02); approve PA-01..PA-06 (B-03); assign DEP-01 and DEP-02 owners (B-04); who owns consent text (Q-43); domain plan (Q-44).
