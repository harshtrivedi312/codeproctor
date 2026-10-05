# Review: build plan and database design against the source docs

| Field     | Value                                                                                                                                               |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Type      | Review note. This is not an ADR and decides nothing.                                                                                                |
| Date      | 2026-09-30                                                                                                                                          |
| Author    | architect                                                                                                                                           |
| Reviewed  | /docs/build-plan.md, /docs/database.md, plus /docs/status.md (Q-01..Q-44, R-01..R-14, PA-01..PA-06), /docs/requirements-trace.md, /docs/briefs/*.md |
| Against   | CLAUDE.md, /docs/brd.md, /docs/fsd.md, /docs/architecture.md, /docs/test-cases.md, /docs/prompts/_.md, .claude/agents/_.md                          |
| Companion | /docs/adr/0001-overall-architecture.md (Proposed)                                                                                                   |

CLAUDE.md says "If code and docs disagree, stop and ask". Nothing here is resolved. Each finding gives a recommendation for the human to decide on. I edited no source doc, plan, brief or prompt.

**Severity scale**

- **Blocker:** must be decided before DB-02 (schema freeze) or before the first wave. Otherwise the artifact is built wrong.
- **Major:** must be decided before the owning task starts. Otherwise there will be rework, a failing P1 TC, or a security or privacy defect.
- **Minor:** can be settled inside the owning task, or is doc hygiene.

Line numbers (`L`) refer to the files as of 2026-09-30.

## 1. Summary

- **Findings.** 31 new findings: 3 blocker, 12 major, 16 minor (section 2).
- **PM items.** 38 of 44 questions, 12 of 14 risks and all 6 change requests are relevant to architecture or schema (section 3).
  - Questions: 18 confirmed, 1 refuted, 19 refined.
  - Risks: 9 confirmed, 3 refined.
  - Change requests: 3 confirmed, 3 refined.
- **What I checked and found sound.** The counts hold:
  - 24 tables, 13 enums, 5 CHECK constraints, 15 ON DELETE CASCADE foreign keys.
  - 57 FRs.
  - 67 TCs, of which 48 are P1, 16 P2 and 3 P3. By type: 27 F, 18 I, 17 S, 2 P, 2 R, 1 A.
  - The plan's dependency graph matches the prompt order, and the critical path of 22 tasks is correct.
  - The idea of ARC gates before DB-02 is right. Its scope is too narrow, though (section 5).

## 2. Findings

### Blockers

#### A-01 · Blocker · Variant-specific test data has no storage

- **Conflict**
  - fsd.md FR-203 (L37): "variant parameters (for example array sizes, constants, entity names) ... The reference solution must pass all variants before publishing."
  - test-cases.md TC-012 (P1): "Publish question whose reference solution fails one variant | Publish blocked; failing variant shown".
  - database.md `test_cases` (L244-252) links only to `question_version_id` (input, expected_output, is_hidden, weight). `question_variants` (L254-260) holds only `params, rendered_statement, is_active`.
  - backend.md Step 4 (L45): "a template renderer for statements". Step 4 (L47): "runs the reference solution against every test case for every variant".
- **Why it matters**
  - If a variant changes constants or sizes, the expected outputs change too. With one shared set of test cases, a fixed reference solution cannot "fail one variant".
  - Grading a variant (FR-506, TC-048) would use the wrong expected outputs.
  - BR-08 is a Must requirement.
- **Recommended resolution.** Pick one:
  - (a) Limit variants to cosmetic changes that never alter input or output. No schema change, but FR-203 is narrowed.
  - (b) Template test inputs with params and store expected outputs per variant. This means a new `variant_test_cases` table, or a nullable `test_cases.variant_id`, plus a parameterized reference solution.
  - (c) Generate the outputs at validation time into `question_variants.test_data jsonb`.
  - The human chooses between (a) and (b). The choice goes into the freeze list.
- **Owner / tasks.** Architect and human (ARC-01, content ADR, renumbered 0007). Affects DB-02, DB-04, BE-04, BE-05, BE-11, FE-04, and PA-05.

#### A-02 · Blocker · `media_chunks.object_key` is NOT NULL but retention must null it

- **Conflict**
  - database.md L390: `object_key text NOT NULL`.
  - Data rules (L462): "delete R2 objects referenced by media_chunks and identity_checks, then null the keys".
  - test-cases.md TC-072 (P1): "Objects deleted from R2, keys nulled, audit logged".
  - database prompt Step 6 (L85): "nulls those keys in one transaction".
- **Why it matters.** DB-02 must match the DDL "exactly", and DB-06 then cannot pass TC-072.
- **Recommended resolution**
  - (a) Make `object_key` nullable and add `deleted_at timestamptz`. This keeps the chunk timeline for review and audit.
  - (b) Delete the rows instead, and amend the Data rules and TC-072.
  - I recommend (a).
- **Owner / tasks.** Architect (ARC-01, identity and retention ADR, renumbered 0004). Affects DB-02, DB-06, DB-08.

#### A-03 · Blocker · A session has no per-section timing, and its questions have no link back to a section

- **Conflict**
  - fsd.md FR-301 (L42): "with total duration and per-section time limits".
  - FR-505 (L63): "Server-side timer is the source of truth".
  - database.md: `test_sections.time_limit_min` (L280) exists. But `sessions` (L318-334) has only `started_at, deadline_at, paused_ms`, and `session_questions` (L338-348) has no `test_question_id` or section reference.
  - backend.md Step 7 (L78) sets only "deadline_at = now + duration adjusted by accommodations".
- **Why it matters**
  - Once random picks are resolved, the server cannot tell which section a served question belongs to.
  - The server holds no section start or deadline. Section limits could only be enforced in the browser, which contradicts FR-505.
  - How extra time (FR-305, TC-024) applies to section limits is undefined.
- **Recommended resolution**
  - (a) Add `session_questions.test_question_id` (FK), plus either a `session_sections(session_id, section_id, started_at, deadline_at)` table or `sessions.section_deadlines jsonb`.
  - (b) The human defers per-section limits for the pilot. Only add `test_question_id`, for traceability.
- **Owner / tasks.** Architect and human (ARC-01, renumbered 0002 or 0007). Affects DB-02, BE-06, BE-07, FE-05, FE-10.

### Major

#### A-04 · Major · Recording chunks cannot be played on their own, and restarts are not modelled

- **Conflict**
  - fsd.md FR-701: "MediaRecorder in 10-second chunks".
  - frontend.md Step 7 (L73): "10-second chunks ... resume after reload".
  - backend.md Step 9 (L99) key: `sessions/{sessionId}/{stream}/{seq}.webm`.
  - database.md `media_chunks` (L385-396) has no segment or recording id.
  - TC-077: "Video seeks to that time on all streams".
  - backend.md Step 12 (L133) downloads audio chunks for VAD.
- **Fact (verified, W3C mediacapture-record discussion).** With `start(timeslice)`, only the first blob carries the WebM header, and later blobs cannot be played alone.
- **Why it matters**
  - Review playback (FR-901, TC-077), the worker's audio pass (FR-607) and the live thumbnails (A-28) all have to reassemble chunks in order from each recording's first chunk.
  - A reload, or a screen share that is stopped and restarted (FR-604), starts a new header. The schema cannot group chunks by recording.
  - If the first chunk is lost, the whole segment becomes unplayable.
- **Recommended resolution**
  - (a) Add `media_chunks.segment int` (or `recording_id`). The SDK uploads the first chunk with priority, the player appends each segment through MSE, and the worker concatenates each segment.
  - (b) Restart the recorder every 10 s so each chunk is self-contained. This costs small gaps and more CPU.
  - (c) Add a server-side remux after SUBMITTED (worker with ffmpeg).
  - I recommend (a) now and (c) later. If (a) is chosen, the column goes into the freeze list.
- **Owner / tasks.** Architect (ARC-01 or ARC-03). Affects FE-07, BE-09, BE-12, FE-11.

#### A-05 · Major · The candidate stepper puts consent before OTP, but the state machine and API put OTP first

- **Conflict**
  - frontend.md Step 9 (L98-99): "1. Welcome + rules + what is recorded + retention period + consent checkbox ... 2. Email OTP."
  - fsd.md §3 (L118-119): "OPENED | Candidate opens link and passes OTP | CONSENTED" and "CONSENTED | Consent logged".
  - fsd.md §4 (L140-141): `/candidate/session/start` "Exchange invitation token + OTP for session token", then `/candidate/session/consent`.
  - architecture.md sequence: OTP, then session token, then "Consent, system check, ID + selfie".
- **Why it matters**
  - `consents.session_id` is NOT NULL, and the session token exists only after OTP.
  - A checkbox shown before OTP either records nothing ("No recording starts before consent is logged", FR-401) or has to be asked again. TC-030 is P1.
- **Recommended resolution.** Show the rules and what is recorded before OTP, as information only. Record the consent checkbox after OTP. This needs no schema change. The human amends frontend.md Step 9.
- **Owner / tasks.** Human (prompt amendment). Affects FE-09, BE-07.

#### A-06 · Major · The state machine has gaps beyond Q-01 and Q-22

- **Conflict**
  - **APPEALED.** fsd.md §3 (L126): "COMPLETED | Verdict set or auto-clean | APPEALED". There is no APPEALED row, so it has no entry condition and no next states. The enum (database.md L149) does include it.
  - **Dead ends.** CONSENTED can only move to VERIFIED, and VERIFIED only to IN_PROGRESS. EXPIRED can be reached only from INVITED or OPENED.
  - **Manual identity approval.** TC-033: "retry once, then flagged for manual approval", yet VERIFIED means "ID and room scan done".
  - **Focus lost.** frontend.md Step 10 (L116) locks on "focus lost", but PAUSED lists only "Fullscreen exit, share stopped, proctor pause".
  - **Appeal outcome.** FR-904: "appeals go to a different reviewer". Yet `session_reviews.session_id` is UNIQUE (L426), and `appeals` has a status but no verdict field.
- **Why it matters**
  - BE-07 must build a table-driven map with "unit tests for every allowed and forbidden transition". Missing rows turn into guesses.
  - Candidates who abandon after consent stay in CONSENTED forever. That skews FR-1002 completion rates and the retention anchor.
  - An overturned appeal can only overwrite the first verdict, so the history is lost.
- **Recommended resolution.** The session-lifecycle ADR (renumbered 0002) proposes the full table:
  - APPEALED moves to COMPLETED.
  - CONSENTED and VERIFIED move to EXPIRED when the window closes.
  - The identity-pending path is either held at CONSENTED with `identity_checks` in a manual-review status, or allowed to start with a flag.
  - Focus lost is an overlay only.
  - The appeal outcome is stored as a verdict on `appeals`, or as a second `session_reviews` row (drop UNIQUE and add a `kind` column).
- **Owner / tasks.** Architect and human. Affects DB-02, BE-07, BE-13, FE-05, FE-10.

#### A-07 · Major · Cross-tenant references are not constrained

- **Conflict**
  - database.md Data rules (L460): "every API query filters by the caller's org_id".
  - The DDL allows `invitations.test_id` and `invitations.candidate_id` to point at different orgs.
  - `test_questions.question_version_id` may reference another org's question.
  - These reference users of any org: `session_reviews.reviewer_id`, `flag_decisions.reviewer_id`, `appeals.assigned_to`, and `*.created_by`.
  - The database prompt Step 5 extension filters reads on tables that have `org_id`, but it does not validate foreign-key targets. TC-008 is P1.
- **Why it matters.** Filtering reads does not stop a write that links org A's test to org B's candidate or question. A single bug would expose another tenant's hidden tests (NFR-04).
- **Recommended resolution**
  - (a) Composite FKs that include `org_id`, which needs `org_id` denormalized onto child tables.
  - (b) A service rule: every foreign ID in a create or update is loaded through the org-scoped client first, with tests for it.
  - (c) Postgres row-level security.
  - For the pilot I recommend (b), plus `org_id` on `sessions` (which also helps with Q-10). Record this in the org-scoping ADR (renumbered 0006) and add it to the code-reviewer checklist.
- **Owner / tasks.** Architect. Affects DB-02, DB-05, BE-03 to BE-13.

#### A-08 · Major · The append-only audit log cannot be erased, so PII in audit rows would defeat deletion on request

- **Conflict**
  - architecture.md Security (L78): "Audit log is append-only; database role for the app cannot delete from it."
  - `audit_logs.entity_id text, metadata jsonb` (L198-208).
  - NFR-05 (L163): "deletion on request within 30 days".
  - TC-094: "All personal data and media removed within 30 days".
  - backend.md Step 3 (L37): AuditInterceptor writes "including reads of candidate data".
- **Why it matters**
  - If the interceptor copies emails, names or file keys into `metadata`, the app can never delete them, and TC-094 fails.
  - Media keys would also end up in a table that staff can read.
- **Recommended resolution.** Adopt ADR 0001 C-3: audit metadata holds only IDs and action names, enforced with an allow-list and a test. Legal confirms that IDs and staff IPs may be kept after erasure. No schema change.
- **Owner / tasks.** Architect and human (legal). Affects BE-03, DB-06.

#### A-09 · Major · Retention can delete evidence while a review or appeal is still open

- **Conflict**
  - database.md L167: `retention_days ... CHECK (retention_days BETWEEN 7 AND 730)`.
  - L462: "for sessions older than organizations.retention_days, delete R2 objects".
  - FR-904 (L99): "appeal within 7 days of a VIOLATION verdict".
  - brd.md §9 lists a "candidate appeal path" as a mitigation.
- **Why it matters**
  - With a 7-day retention, a verdict on day 5 leaves an appeal window until day 12, but the recordings are deleted on day 7.
  - UNDER_REVIEW sessions can outlast retention too.
- **Recommended resolution**
  - Anchor retention on the later of `submitted_at` and the final verdict or appeal resolution.
  - Skip sessions that are UNDER_REVIEW or APPEALED, or have an OPEN appeal (a legal hold).
  - Decide this together with Q-11.
- **Owner / tasks.** Architect and human (privacy). Affects DB-06, BE-09, BE-13.

#### A-10 · Major · Replay protection for event batches has nowhere durable to store its state

- **Conflict**
  - backend.md Step 10 (L109): "monotonic batch sequence; reject bad signatures and replayed sequences (TC-065)".
  - `keystroke_batches` has `UNIQUE (session_id, seq)`, but `proctor_events` stores single events with no batch sequence, and `sessions` has no last-sequence column.
  - TC-065 is P1.
- **Why it matters.** Rejecting a replayed event batch needs the last accepted sequence per session. Redis-only state is lost on a flush or restore, and with more than one instance it needs atomic compare-and-set.
- **Recommended resolution.** Pick one:
  - (a) `sessions.last_event_seq bigint`, updated atomically with the insert.
  - (b) A `proctor_event_batches(session_id, seq)` table with a UNIQUE constraint.
  - (c) Redis with AOF, and no schema change.
  - Decide in ARC-01 (the event taxonomy ADR, renumbered 0005) together with ARC-03's canonical JSON.
- **Owner / tasks.** Architect. Affects DB-02, BE-10, FE-06.

#### A-11 · Major · Schema gaps that Q-01..Q-17 do not cover

- **Conflict**
  1. backend.md Step 3 (L37): "invite user". But `users.password_hash text NOT NULL` (L177), and there is no storage for an invite token.
  2. Step 14 (L158): "org-configured endpoints, HMAC-signed payloads, retries ..., delivery log". There is no table for endpoints, per-endpoint secrets or deliveries, and `organizations.settings jsonb` would hold the secrets in plain text.
  3. Step 14 (L156): report PDF "stored in R2". There is no key column, so retention cannot find the file.
  4. frontend.md Step 4: "Validate button showing per-variant, per-test results from the API job". Only `question_versions.validated_at` exists.
  5. FR-305 (L45) lists "allowed assistive tools", but the backend.md Step 6 (L65) zod schema has only "(extraTimePct, disabledDetectors[], notes)".
- **Why it matters.** Each of these forces a later ADR and migration (build-plan §10), or an unsafe workaround: secrets in jsonb, or PII outside retention.
- **Recommended resolution.** ARC-01 either lists each item in the freeze list or defers it by name to an ADR due before its task.
  - Invites: a nullable `password_hash` plus an invite-token hash.
  - Webhooks: `webhook_endpoints` (secret encrypted) and `webhook_deliveries`.
  - Reports: a `report_key` column or a `reports` table, covered by retention.
  - Validation: a `validation_report jsonb` column.
  - Assistive tools: add the field to the shared zod schema.
- **Owner / tasks.** Architect. Affects DB-02, BE-03, BE-04, BE-05, BE-06, BE-14.

#### A-12 · Major · IndexedDB buffering breaks the code-reviewer rule "no candidate data in client storage"

- **Conflict**
  - code-reviewer.md (L15): "Privacy: nothing recorded before consent, retention respected, no candidate data in client storage."
  - FR-702 (L81): "buffered in IndexedDB up to 200 MB".
  - frontend.md Step 6 (L62): "persists unsent batches in IndexedDB".
  - Step 7 (L73): "store in IndexedDB (cap 200 MB) ... resume after reload".
  - TC-063 (P1). NFR-08.
- **Why it matters**
  - code-reviewer will return REQUEST CHANGES on FE-06 and FE-07 for doing what FR-702 requires.
  - Recordings may stay on a shared device after the test.
- **Recommended resolution.** Reword the rule: "except the FR-702 upload buffer, cleared on confirmed upload and on finish, capped at 200 MB, never holding tokens or keys unless ARC-03 allows". This edits an agent definition, so the human must approve it. Q-02 and Q-23 decide whether the key and token may persist for reload.
- **Owner / tasks.** Human, and architect (ARC-03). Affects FE-06, FE-07, code-reviewer.

#### A-13 · Major · The invitation token in the URL path ends up in access logs and Referer headers

- **Conflict**
  - frontend.md Step 1 (L14): "(candidate) for /t/[token]/*".
  - CLAUDE.md (L11): "Never log secrets, tokens, OTPs, or candidate media keys."
  - backend.md Step 6 (L65): "only its SHA-256 hash stored".
  - architecture.md Deployment: Caddy and Cloudflare Pages.
- **Why it matters**
  - Until the token is used (and during resume, Q-23), it is a bearer credential.
  - Every page under `/t/[token]/` puts it in edge logs, browser history and Referer headers.
  - Storing only the hash in the DB is undone by the logs.
- **Recommended resolution.** The landing page exchanges the token once and then redirects to a route without the token. Or move the token into the URL fragment. In both cases add `Referrer-Policy: no-referrer` and Caddy log filters. Decide in ARC-03 before FE-01 fixes the route groups.
- **Owner / tasks.** Architect (ARC-03). Affects FE-01, FE-09, BE-01, BE-07, DEP-01.

#### A-14 · Major · Staging is also the pilot environment

- **Conflict**
  - architecture.md Deployment (L67): "Staging / pilot | One Oracle Cloud Always Free VM".
  - QA 2 (agents-qa-deploy.md L39): "Using the running staging environment, attempt every bypass".
  - frontend.md Step 13: "against the seeded staging data".
  - database prompt Step 4 (L63): password "ChangeMe!2026".
  - brd.md §10: "Pilot of at least 20 real candidates".
- **Why it matters**
  - Real recordings, ID images and biometrics (BIPA and GDPR, brd.md §7) would share a DB and buckets with known-password seed accounts, red-team attacks and e2e fixtures.
  - This is exactly the brd.md §9 risk "Recording storage breach".
- **Recommended resolution.** Pick one:
  - (a) A separate pilot stack: its own DB, buckets and secrets.
  - (b) One stack, but the pilot starts only after QA-02 is finished, the seed is removed, secrets are rotated and buckets are emptied, and no red-team work happens once real data exists. Record this in DEP-02.
- **Owner / tasks.** Human and architect (ARC-05). Affects DEP-01, DEP-02, QA-02, FE-13, DB-04.

#### A-15 · Major · ADR number collision

- **Conflict**
  - docs/briefs/ARC-01.md reserves 0001 to 0006 for the schema-gap ADRs and 0007 for the freeze list.
  - docs/briefs/DB-02.md gates on `/docs/adr/0007-schema-freeze-list.md`.
  - The human now wants 0001 to be the overall architecture.
- **Why it matters.** After the shift, 0007 becomes the content and settings ADR. A DB-02 agent following its brief would read the wrong file as its freeze list.
- **Recommended resolution**
  - Shift the planned ADRs to 0002 to 0008 (section 4).
  - Refer to ADRs by slug in briefs.
  - Number later ARC-02 to ARC-05 ADRs from 0009 in the order they are written.
- **Owner / tasks.** project-manager (briefs), architect. Affects the DB-02 gate.

### Minor

#### A-16 · Minor · Some security-relevant tasks have no architect review at PR

- **Conflict**
  - build-plan.md §6 (L197) lists architect PR review only for DB-02, DB-03, DB-05, DB-06, BE-02, BE-03, BE-07, BE-09, BE-10, BE-12 and BE-15A.
  - architect.md owns "auth, session HMAC signing, storage access, sandbox isolation, data retention".
- **Why it matters.** These tasks touch areas the architect owns but get no architect review:
  - BE-05: sandbox isolation.
  - BE-08: biometrics and worker integration.
  - BE-13: WebSocket auth and audit.
  - BE-14: webhook signing and SSRF.
  - FE-06: client HMAC signing.
  - FE-07: presign flow and IndexedDB.
- **Recommended resolution.** Add architect review to those six tasks.
- **Owner.** PM.

#### A-17 · Minor · Agent scopes do not match task assignments

- **Conflict**
  - db-engineer.md (L13): scope is "prisma/, infra/docker-compose.yml (postgres, redis, adminer only), infra/scripts/backup.sh and restore.sh, apps/api/src/prisma/, retention and erasure services, database tests". But the DB-01 brief scopes it to every app, package and `.github/workflows/`, and DB-07 adds a GitHub Actions workflow.
  - BE-05 adds Judge0 to the same compose file that db-engineer owns.
  - FE-14's proposed owner is proctor-sdk-engineer, whose scope is "packages/proctor-sdk and the /dev/proctor demo page".
  - Nobody is named to implement the internal worker-to-API endpoints (ARC-04).
- **Recommended resolution**
  - The human approves DB-01 and DB-07 working outside the db-engineer scope.
  - Put Judge0 in `infra/judge0/` as a separate compose file or profile owned by backend-engineer. This also lets `pnpm dev:infra` run on macOS.
  - Name the owner of the internal endpoints; integrity-engineer is proposed.
- **Owner.** PM and human.

#### A-18 · Minor · Gate order, and ADR 0001 is missing from the plan

- **Conflict**
  - build-plan W1 (L168): "ARC-02 → ARC-03 → ...".
  - ARC-02's deliverable (L288) is the "batch envelope with sequence and signature field".
  - ARC-03's deliverable (L294) is "canonical JSON and replay rules".
- **Why it matters.** The envelope depends on ARC-03, so ARC-02 would need a revision.
- **Recommended resolution**
  - Write ARC-03's HMAC section before ARC-02, or together with it.
  - Add ADR 0001 to Phase 0 and to the status.md decision log.
- **Owner.** PM.

#### A-19 · Minor · `redis:7` is not OSI open source

- **Conflict**
  - database prompt Step 1 (L33): "redis:7".
  - CLAUDE.md: "Prefer free and open-source tools."
  - Verified: 7.4 and later are RSALv2/SSPLv1. Redis 8 adds AGPLv3. Valkey (BSD-3) is a fork of 7.2.4.
- **Recommended resolution.** Pick one: pin 7.2 (support status not verified), use Valkey 8 (BullMQ compatibility not verified), or use Redis 8 under AGPLv3.
- **Owner.** Human. Affects DB-01, DEP-01.

#### A-20 · Minor · Presign details, R2 CORS and local storage

- **Conflict**
  - backend.md Step 9 (L99): "presigned PUT URL valid 60 s ... content-type and max size enforced; records a media_chunks row as pending".
  - Verified: R2 does not support presigned POST ("POST ... is not currently supported"), so there is no `content-length-range` policy.
  - A retry after a 60 s drop (NFR-08) outlives a 60 s URL.
  - `UNIQUE (session_id, stream, seq)` makes a second presign for the same chunk fail.
  - No task sets the R2 bucket CORS rules that browser PUTs need.
  - Local compose has no S3-compatible store.
- **Recommended resolution**
  - Presign for every upload attempt, and upsert the pending row.
  - Sign Content-Length and Content-Type. Whether R2 enforces this is not verified, so BE-09 should run a spike.
  - Confirm each upload with HEAD.
  - Add CORS to DEP-01.
  - Decide between a dev bucket and a local S3-compatible service.
- **Owner.** Architect (ARC-03). Affects BE-09, FE-07, DEP-01.

#### A-21 · Minor · Small inconsistencies across schema, FSD and prompts

- **Conflict**
  1. FR-606 (L73) analyzes "every 1 second" for PHONE_DETECTED and BOOK_DETECTED. frontend.md Step 8 (L85) runs "COCO-SSD every 2 s". Affects FE-08.
  2. The room scan is stored in two places: `media_stream` has 'ROOM_SCAN' (L151), and there is also `identity_checks.room_scan_key`. Affects ADR 0004, BE-09, FE-09.
  3. backend.md Step 10 (L112) says "compressed JSON", but `keystroke_batches.events jsonb` cannot hold compressed bytes. Affects BE-10.
  4. These enumerations are free-text columns with no defined values: `identity_checks.status` ('PENDING'), `proctor_events.source` ('CLIENT', while Step 12 uses 'SERVER'), and `sessions.client_kind` ('WEB').
  5. The ERD cardinalities `invitations ||--|| sessions` and `sessions ||--|| consents` (L22-23) say "exactly one", which the DDL does not enforce.
- **Recommended resolution.**
  - (1) The human picks the cadence.
  - (2) Pick one location for the room scan.
  - (3) Send plain JSON with HTTP compression.
  - (4) Define the values in packages/shared.
  - (5) Keep the DDL authoritative and fix the ERD along with Q-17.
- **Owner.** Architect.

#### A-22 · Minor · Foreign-key columns have no indexes

- **Conflict**
  - database.md defines 6 non-unique indexes.
  - These columns have none: `invitations(test_id)`, `invitations(candidate_id)`, `session_questions(session_id)`, `identity_checks(session_id)`, `refresh_tokens(user_id)` (used for family revoke), `test_cases(question_version_id)`, `question_variants(question_version_id)`, `appeals(session_review_id)`, and the retention anchor.
  - DB-02 may not "invent" indexes.
- **Why it matters.** It hurts review bundles and status pages (NFR-01) and slows cascade deletes during erasure.
- **Recommended resolution.** Add these indexes to the freeze list (0008).
- **Owner.** Architect. Affects DB-02, DB-03.

#### A-23 · Minor · The score formula is ambiguous: points or weights

- **Conflict**
  - FR-506 (L64): "sum of passed hidden test weights".
  - TC-048 (P1): "Score reflects passed weights exactly".
  - database.md: `test_questions.points DEFAULT 100` (L288), plus `session_questions.points` and `tests.pass_score`.
- **Why it matters.** A raw weight sum and a points-scaled score give different numbers, so the expected result of TC-048 is unclear.
- **Recommended resolution.** Define it as points × passed weight / total hidden weight, or drop `points`. Decide in ADR 0007.
- **Owner.** Architect and human. Affects BE-11, FE-05.

#### A-24 · Minor · API contract details disagree

- **Conflict**
  - fsd.md §4 (L151) has `PATCH /review/flags/:id`, but backend.md Step 13 (L147) uses `:eventId`.
  - `/candidate/answers/:questionId` exposes stable question IDs across candidates, which weakens BR-08.
  - For identity, fsd.md says it "returns match result", but Step 8 (L87) "returns a job ID".
  - Submit may return pass/fail for each hidden test, which lets candidates probe the hidden tests. TC-011 only forbids returning the inputs and outputs.
- **Recommended resolution.** Settle all four in ARC-02. Use the session_question id in candidate paths.
- **Owner.** Architect. Affects BE-08, BE-11, BE-13, FE-10, FE-11.

#### A-25 · Minor · The test-naming rule does not fit Python or tasks without TCs

- **Conflict**
  - CLAUDE.md: "reference FR and TC IDs from the docs in test names".
  - pytest names cannot contain hyphens.
  - Tasks such as BE-01 and DB-02 have no TC.
- **Recommended resolution.** Adopt ADR 0001 C-11.
- **Owner.** qa-engineer (QA-01A), integrity-engineer.

#### A-26 · Minor · Strict CSP versus WASM and Web Worker detectors (not verified)

- **Conflict**
  - frontend.md Step 1 (L16): "no inline scripts except Next nonces, connect-src limited to the API and the R2 upload endpoint".
  - Step 8 runs MediaPipe and TF.js in a Web Worker.
- **Why it matters.** WASM usually needs `'wasm-unsafe-eval'`, workers need `worker-src`, and the candidate socket needs `wss:` in `connect-src`. A CSP without these breaks FE-08.
- **Recommended resolution.** List these directives in FE-01 and verify them in FE-08.
- **Owner.** frontend-engineer, proctor-sdk-engineer.

#### A-27 · Minor · IP-based throttling will hit candidates who share a NAT

- **Conflict**
  - backend.md Step 1 (L14): "stricter limits on /auth and /candidate".
  - NFR-02 requires 200 concurrent candidates.
- **Why it matters.** A cohort testing from one campus or office shares a single public IP.
- **Recommended resolution.** Key candidate limits by session (after auth) and by token hash (before auth).
- **Owner.** backend-engineer (BE-01, BE-15A).

#### A-28 · Minor · Nothing produces the live-view thumbnails

- **Conflict**
  - FR-903: "latest webcam thumbnail".
  - backend.md Step 13 (L149): "thumbnail keys".
  - frontend.md Step 12 (L136): "refreshed every 10 s".
  - No SDK step creates a thumbnail and there is no stream type for one. The chunks cannot be played alone (A-04).
- **Recommended resolution.** In ARC-02, choose between a small JPEG uploaded through presign every 10 s (about 20 extra requests per second at 200 candidates, R-02) and a tiny thumbnail sent over the socket.
- **Owner.** Architect. Affects FE-08, BE-13, FE-12.

#### A-29 · Minor · architecture.md is missing its diagram and its external services

- **Conflict**
  - architecture.md (L7): "[embedded content: CodeProctor system architecture · 3 clients, 1 API, 6 backing services]". The diagram is not in the repo.
  - These services are named only in the prompts: Resend/Brevo, Sentry, Supabase/Neon, Cloudflare Pages and GHCR. Doppler appears in architecture.md Security.
  - architect.md: no new service without an ADR.
- **Recommended resolution.** After ADR 0001 is approved, add a mermaid diagram and an external-services table to architecture.md. The table lists each service's purpose, the data sent, its limits and whether a DPA is needed. It feeds DEP-02.
- **Owner.** Architect.

#### A-30 · Minor · Lockdown attestation designs disagree, and LOCKDOWN can be selected with no client

- **Conflict**
  - FR-1103 (L111): "attested with a per-session key".
  - frontend.md Step 14 (L154): "a build-time signing key". A key built into a distributed binary can be extracted.
  - FR-302 and the `proctor_profile` enum allow LOCKDOWN today.
- **Recommended resolution.** Decide Q-41. If lockdown is deferred, BE-06 and FE-05 hide or reject LOCKDOWN, and attestation gets its own ADR later.
- **Owner.** Human, architect.

#### A-31 · Minor · Secrets and PII rest outside Postgres

- **Conflict**
  - backend.md Step 6 (L67): the `email` queue carries the invitation link and the OTP. The raw token exists only there, and Redis has append-only persistence on (DB-01 brief).
  - The default retention of completed BullMQ jobs is not verified.
  - database prompt Step 7 (L94): 14-day backups hold candidate PII. A restore would bring back candidates who were erased after the backup was taken.
- **Recommended resolution.** Remove email jobs once they finish and give them a short TTL. Add a runbook step that re-applies erasures made after the backup date.
- **Owner.** Architect (ARC-03). Affects BE-06, DB-07, DEP-01.

## 3. Verdicts on the PM's questions, risks and change requests

- **Confirm:** I checked the quoted doc lines and the claim holds. Any additions are in the notes.
- **Refute:** the claim is wrong.
- **Refine:** the claim holds only in part, or the framing or resolution should change.

**Not assessed** (process, traceability or legal only): Q-29, Q-31, Q-32, Q-33, Q-37, Q-43, R-07, R-14.

| ID                                 | Verdict               | Evidence and notes                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q-01                               | **Refute** (headline) | Nothing in the DDL prevents creating the session row, with status 'INVITED', when the invitation is created. The ERD `invitations                                                                                                                                                                                                                                                                                                     |     | --  |     | sessions`even implies it, and the enum has INVITED and EXPIRED. The real conflict is the DDL default 'OPENED' (L321) and NOT NULL`hmac_key_enc`, which imply creation at open. So this is a decision, not an impossibility. Confirmed: no step has an expiry job. See also A-06. |
| Q-02                               | Confirm               | backend.md L78, database.md L322 and architecture.md L74 hold as quoted. Also: pre-start events (FR-605 MULTI_MONITOR "blocks start", VIRTUAL_CAMERA in the system check) happen before any key exists, and DB-04 must seed `hmac_key_enc`.                                                                                                                                                                                           |
| Q-03                               | Confirm               | backend.md L25 "recovery codes (hashed)"; `users` has no column for them.                                                                                                                                                                                                                                                                                                                                                             |
| Q-04                               | Refine                | The OTP, attempt count and 30-minute block are short-lived and can live in Redis with a TTL, with no schema change. A durable record is needed only for the recruiter notice and audit. Confirmed: Step 6 has no recruiter-notification template.                                                                                                                                                                                     |
| Q-05                               | Refine                | TC-005 can be met by walking the `replaced_by` chain with a recursive CTE. A `family_id` is simpler and indexable. This is a design choice, not a hard gap.                                                                                                                                                                                                                                                                           |
| Q-06                               | Confirm               | backend.md Step 8 L88 and L90. Embeddings are biometric identifiers (BIPA, brd.md §7), so the consent text and retention must name them.                                                                                                                                                                                                                                                                                              |
| Q-07                               | Confirm               | FR-803 L90. Generating AI reference solutions implies an LLM, which is a paid external dependency and needs an ADR (architect.md rule 2), or authors upload them by hand.                                                                                                                                                                                                                                                             |
| Q-08                               | Confirm               | Enum L157-162. Also missing: CUT (frontend.md Step 6 blocks "cut"), blocked-shortcut attempts (FR-603 "each attempt is logged"; DEVTOOLS_OPEN is detection, not an attempt), PROCTOR_RESUME (FE-12), and identity or liveness failures.                                                                                                                                                                                               |
| Q-09                               | Confirm               | FR-804 gives bands only; backend.md L136 cites defaults that do not exist.                                                                                                                                                                                                                                                                                                                                                            |
| Q-10                               | Refine                | Confirmed as stated. Also add cross-parent tenant integrity (A-07) and the cost of multi-hop org joins on hot candidate routes (NFR-01). Options: `org_id` on `sessions` and hot child tables, or RLS.                                                                                                                                                                                                                                |
| Q-11                               | Refine                | Also add A-02 (NOT NULL key) and A-09 (legal hold). Erasure mechanics: `invitations.candidate_id` and `sessions.invitation_id` are NO ACTION, so the candidate row must be anonymized in place. `appeals.session_review_id` has no ON DELETE, so deleting a session with an appeal fails. `consents.ip` and `user_agent` are PII.                                                                                                     |
| Q-12                               | Confirm               | L381 is free text. See A-06 for the state-machine impact.                                                                                                                                                                                                                                                                                                                                                                             |
| Q-13                               | Refine                | A static practice question needs no schema. But `submissions.session_question_id` is NOT NULL, the run endpoint is keyed by question, and practice happens before IN_PROGRESS (frontend.md L104). Run authorization and storage need a decision.                                                                                                                                                                                      |
| Q-14                               | Confirm               | `submissions.language` and `source_code` are NOT NULL; `mcq_options` has no documented answer key.                                                                                                                                                                                                                                                                                                                                    |
| Q-15                               | Refine                | Also: two connection URLs are needed (migration owner and `app_user`). A grant "on all tables" covers only tables that exist at that moment, so it needs `ALTER DEFAULT PRIVILEGES` or a re-grant in each migration. Role creation on Supabase or Neon is not verified.                                                                                                                                                               |
| Q-16                               | Refine                | Also: the consent text itself, not just a version string, must be kept for each version as legal proof (brd.md §7 "Explicit, logged consent ... plain-language explanation").                                                                                                                                                                                                                                                         |
| Q-17                               | Refine                | Also: the ERD cardinalities for invitations to sessions and sessions to consents (A-21 item 5). The DDL stays authoritative, as the DB-02 brief already says.                                                                                                                                                                                                                                                                         |
| Q-18                               | Confirm               | Also missing: the FACE_MISMATCH re-check endpoint (frontend.md L86 "send a selfie frame ... via the API").                                                                                                                                                                                                                                                                                                                            |
| Q-19                               | Refine                | Also: synchronous versus asynchronous (fsd.md "returns match result" against Step 8 "returns a job ID"). R2 has no presigned POST (verified), so every object type uses presigned PUT.                                                                                                                                                                                                                                                |
| Q-20                               | Refine                | TC-079 needs the overlay "within 2 s", but the heartbeat runs every 10 s (FR-609). A heartbeat reply cannot meet that, so a push channel or polling at 2 s or faster is needed (adds to R-02).                                                                                                                                                                                                                                        |
| Q-21                               | Refine                | Not a contradiction. BullMQ has an official Python client that works with Node queues but supports only a subset of features (verified). The real issue is that Prisma is Node-only, so a Python worker writing to the DB would be a second schema consumer.                                                                                                                                                                          |
| Q-22                               | Confirm               | fsd.md L124 against backend.md L124 and L136.                                                                                                                                                                                                                                                                                                                                                                                         |
| Q-23                               | Confirm               | FR-303 against TC-045 and TC-063; `invitations.used_at` has no documented semantics.                                                                                                                                                                                                                                                                                                                                                  |
| Q-24                               | Refine                | FR-505 does not say that time keeps running during a pause. FR-609's "time continuing" is about disconnects, and TC-079 says "timer paused" for a proctor pause. Only candidate-caused pauses (fullscreen exit, share stopped) are open, and there Step 10 lets a candidate buy extra time.                                                                                                                                           |
| Q-25                               | Refine                | A device fingerprint also blocks the STRICT phone (a second device, Q-42), and it is personal data that the consent text must cover (NFR-05).                                                                                                                                                                                                                                                                                         |
| Q-26                               | Confirm               | architecture.md L74 "so forged event batches are rejected" overstates the protection. The threat model covers transport tampering, replay and third parties, not the candidate (R-04).                                                                                                                                                                                                                                                |
| Q-27                               | Confirm               | Verified: the InsightFace README says the pretrained models are "for non-commercial research purposes only", and the code is MIT.                                                                                                                                                                                                                                                                                                     |
| Q-28                               | Confirm               | database prompt L63. See A-14.                                                                                                                                                                                                                                                                                                                                                                                                        |
| Q-30                               | Refine                | Propose mapping TC-065 to NFR-04 plus the ARC-03 signing ADR, so it has a requirement ID.                                                                                                                                                                                                                                                                                                                                             |
| Q-34                               | Refine                | Monitoring "across groups" needs protected-attribute data. The schema has none, and collecting it conflicts with NFR-05 data minimization and may be special-category data under GDPR. Legal must decide. An option is a voluntary survey, consented separately and stored in aggregate outside candidate records.                                                                                                                    |
| Q-35                               | Confirm               | NFR-09 per-session trace ID (see ADR 0001 C-9); FR-1103 has no server step.                                                                                                                                                                                                                                                                                                                                                           |
| Q-36                               | Confirm               | The names differ. The ownership effects are covered in A-17.                                                                                                                                                                                                                                                                                                                                                                          |
| Q-38                               | Confirm               | backend.md L9 "Steps 8–12 can run in parallel" hides the dependencies of Steps 8 and 12.                                                                                                                                                                                                                                                                                                                                              |
| Q-39                               | Refine                | Approve PA-06 only if DB-05 stays inside `apps/api/src/prisma/` (db-engineer scope). BE-01 owns `main.ts` and the app module.                                                                                                                                                                                                                                                                                                         |
| Q-40                               | Confirm               | DB-08 "passes in CI" and QA 1 both need a CI baseline.                                                                                                                                                                                                                                                                                                                                                                                |
| Q-41                               | Refine                | Also covers the attestation design conflict and LOCKDOWN being selectable (A-30).                                                                                                                                                                                                                                                                                                                                                     |
| Q-42                               | Refine                | Also: the phone needs its own auth, which conflicts with fingerprint binding (Q-25). Whether iOS Safari records WebM is not verified.                                                                                                                                                                                                                                                                                                 |
| Q-44                               | Refine                | SameSite works by site (registrable domain), not by origin. `app.example.com` and `api.example.com` are same-site, so Strict works with custom domains. `*.pages.dev` is cross-site (Public Suffix List, not re-verified). R-08 may also move the web app off Pages.                                                                                                                                                                  |
| R-01                               | Confirm               | Verified: Judge0's Ubuntu 22.04 guide requires `systemd.unified_cgroup_hierarchy=0` (cgroup v1). The Oracle free x86 shape is 1/8 OCPU with 1 GB, and A1 is ARM. So no free Oracle shape can host Judge0 together with the API and worker, which puts BO-5 at risk. GitHub-hosted runners are believed to use cgroup v2 (not verified), so the "agreed Linux runner" is probably self-hosted or the staging VM.                       |
| R-02                               | Refine                | I get about 1.5 requests per second per candidate (presign 0.3, confirm 0.3, events 0.2, keystrokes 0.5, heartbeat 0.1, autosave 0.1), which is about 300 requests per second. On top of that come snapshots, thumbnails (A-28) and face re-checks. Also add the latency from the managed DB's location and Neon's compute suspend after about 5 minutes idle (secondary source), which causes a cold start when a test window opens. |
| R-03                               | Confirm               | Verified: the free tier is 10 GB-month and 1M Class A operations. About 1,080 PUTs per session-hour is fine for the pilot. The storage figure is an unverified estimate.                                                                                                                                                                                                                                                              |
| R-04, R-05, R-06, R-09, R-10, R-12 | Confirm               | Checked against the cited lines. For R-06, see also the Q-34 refinement.                                                                                                                                                                                                                                                                                                                                                              |
| R-08                               | Refine                | Verified: `@cloudflare/next-on-pages` is deprecated, and OpenNext targets Workers, so "web on Cloudflare Pages" (architecture.md L67) is out of date. Alternative: run Next.js on the VM behind Caddy. That makes it same-site with the API (fixes Q-44), but adds load (R-13).                                                                                                                                                       |
| R-11                               | Confirm               | PA-05 must be variant-aware (A-01).                                                                                                                                                                                                                                                                                                                                                                                                   |
| R-13                               | Refine                | See R-01. Also: face re-checks every 2 minutes for 200 candidates give about 100 CPU face-match jobs per minute, which needs queue priority (ADR 0001 C-7).                                                                                                                                                                                                                                                                           |
| PA-01                              | Confirm               | Recommend approving. `.github/workflows` ownership is covered in A-17.                                                                                                                                                                                                                                                                                                                                                                |
| PA-02                              | Refine                | Approve with amendments: renumbering (A-15), ARC-01 scope expansion (section 5), ARC-03 before or with ARC-02 (A-18), and ADR 0001 added to Phase 0.                                                                                                                                                                                                                                                                                  |
| PA-03, PA-04                       | Confirm               | Both are sound.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| PA-05                              | Refine                | The validation must cover every variant, and it depends on A-01.                                                                                                                                                                                                                                                                                                                                                                      |
| PA-06                              | Refine                | Approve with the constraint in the Q-39 note.                                                                                                                                                                                                                                                                                                                                                                                         |

## 4. ADR renumbering impact (files not edited)

**Target numbering**

| New  | Old  | File                                    |
| ---- | ---- | --------------------------------------- |
| 0001 | new  | overall-architecture (written)          |
| 0002 | 0001 | session-lifecycle-and-invitation-expiry |
| 0003 | 0002 | credential-and-otp-storage              |
| 0004 | 0003 | identity-biometrics-and-retention-scope |
| 0005 | 0004 | integrity-event-taxonomy-and-defaults   |
| 0006 | 0005 | org-scoping-and-db-roles                |
| 0007 | 0006 | content-and-settings-model-gaps         |
| 0008 | 0007 | schema-freeze-list                      |

| File                  | Line | Current text                                                      | Change to                |
| --------------------- | ---- | ----------------------------------------------------------------- | ------------------------ |
| docs/briefs/ARC-01.md | 65   | `0001-session-lifecycle-and-invitation-expiry.md`                 | `0002-...`               |
| docs/briefs/ARC-01.md | 66   | `0002-credential-and-otp-storage.md`                              | `0003-...`               |
| docs/briefs/ARC-01.md | 67   | `0003-identity-biometrics-and-retention-scope.md`                 | `0004-...`               |
| docs/briefs/ARC-01.md | 68   | `0004-integrity-event-taxonomy-and-defaults.md`                   | `0005-...`               |
| docs/briefs/ARC-01.md | 69   | `0005-org-scoping-and-db-roles.md`                                | `0006-...`               |
| docs/briefs/ARC-01.md | 70   | `0006-content-and-settings-model-gaps.md`                         | `0007-...`               |
| docs/briefs/ARC-01.md | 77   | `/docs/adr/0007-schema-freeze-list.md`                            | `0008-...`               |
| docs/briefs/ARC-01.md | 95   | commit `propose schema gap decisions 0001-0006`                   | `0002-0007`              |
| docs/briefs/ARC-01.md | 97   | commit `add schema freeze list 0007`                              | `0008`                   |
| docs/briefs/DB-02.md  | 9    | `(/docs/adr/0007-schema-freeze-list.md)`                          | `0008-...`               |
| docs/briefs/DB-02.md  | 23   | `0007-schema-freeze-list.md and the ADRs it cites (0001 to 0006)` | `0008`, `(0002 to 0007)` |

- **build-plan.md.** It contains **no numeric ADR references**; grep confirms this, so the premise that it reserves 0001 to 0007 does not hold. It names the freeze list only by name (L45, L282, L326) and "new ADR" for FE-14 (L195, L264, L576). No renumbering edit is needed, but the PM should add ADR 0001 as a Phase 0 item (A-18).
- **status.md.** No numbers (L10, L17, L40 give the name only). Record ADR 0001 in section 9, the decision log, once it is approved.
- **No change needed.** requirements-trace.md has no references. `.claude/agents/architect.md` L13 uses the pattern `NNNN-title.md` only. DB-02.md L59 ("cited by ADR number") is generic.
- **Unnumbered ADRs still to come.** These come from ARC-02 (contract ownership and OpenAPI), ARC-03, ARC-04, ARC-05 and FE-14. They take 0009 onward in the order they are written. Briefs should cite ADRs by slug so that numbering never breaks a gate again.

## 5. Proposed routing of new schema findings into the planned ADRs (keeps the 0002 to 0008 set)

| Planned ADR                          | Add                                                          |
| ------------------------------------ | ------------------------------------------------------------ |
| 0002 session lifecycle               | A-06, A-03 (session side)                                    |
| 0003 credential and OTP storage      | A-11 item 1 (staff invites)                                  |
| 0004 identity, biometrics, retention | A-02, A-04 (if a column is chosen), A-09, A-21 items 2 and 4 |
| 0005 integrity event taxonomy        | A-10, the Q-08 additions                                     |
| 0006 org scoping and DB roles        | A-07, the Q-15 default privileges                            |
| 0007 content and settings            | A-01, A-03 (test side), A-11 items 2 to 5, A-23              |
| 0008 freeze list                     | Every approved delta above, plus the A-22 indexes            |

## 6. Decisions needed from the human (priority order)

1. **Approve ADR 0001 and the renumbering** (A-15). Tell the PM to update ARC-01.md and DB-02.md.
2. **Expand ARC-01's scope** to cover section 5 before the freeze list is written. Decide the variant model (A-01) and per-section limits (A-03), because both change core tables.
3. **Hosting versus BO-5** (R-01, R-13, A-14). Accept a small paid x86 host for Judge0 and staging, or name another free option. Decide whether the pilot runs on a separate stack.
4. **Face model** (Q-27). Choose a model licensed for commercial use, or buy an InsightFace licence. Also decide where AI reference solutions come from (Q-07).
5. **Consent before OTP** (A-05). Amend frontend.md Step 9.
6. **Client storage rule** (A-12). Approve the code-reviewer amendment.
7. **Pause and resume policy** (Q-24, Q-23), plus the retention legal hold (A-09).
8. **Redis licence** (A-19) and **lockdown in or out** (Q-41, A-30).
