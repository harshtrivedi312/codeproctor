# Prompts — Backend (API + worker)

Run these 15 prompts in order after the Database track is merged. Each step names the FSD requirements and test cases it must satisfy, so the agent can check its own work.

## Before you start

- The `CLAUDE.md` context prompt from the Database tab must already be in the repo root.
- Work on a branch `backend/<step>` per step; open a pull request when the step's verification passes.
- Steps 1–7 are sequential. Steps 8–12 can run in parallel sub-agents once Step 7 is merged. Steps 13–15 come last.

## Step 1 — API foundation

```text
In apps/api set up NestJS with: @nestjs/config with zod-validated environment, pino structured logging with a per-request trace ID, a global exception filter returning RFC 7807 problem JSON, helmet, CORS limited to the web app origin, @nestjs/throttler rate limiting (global default plus stricter limits on /auth and /candidate), Swagger/OpenAPI at /api/docs (disabled in production), a /health endpoint checking Postgres and Redis, and graceful shutdown.
All routes under /api/v1.
Add Jest + Supertest with a test database via Testcontainers.
Verify: `pnpm --filter api test` passes; /health returns ok with infra running.
```

## Step 2 — Staff authentication

```text
Implement FR-101, FR-102, FR-104 and FR-107 from /docs/fsd.md in an AuthModule (schema per ADR 0003):
- POST /auth/login (argon2id verify, lockout after 5 failures for 15 min, generic error messages). Users with no password_hash (pending invite) cannot log in.
- TOTP 2FA with otplib: enroll (QR code as data URL), verify, recovery codes (10 random codes, SHA-256 hashes in users.recovery_code_hashes, removed on use). Enforce for SUPER_ADMIN and REVIEWER.
- Access JWT 15 min (in memory on client), refresh token 7 days in an httpOnly, Secure, SameSite=Strict cookie, stored hashed in refresh_tokens with a family_id, rotated on use; reuse of a rotated token revokes the whole family.
- POST /auth/logout revokes the family.
- Password reset (FR-107, D-22): POST /auth/password/forgot always returns the same 202 response, is rate-limited per email and IP, and for an active user stores the SHA-256 of a 32-byte token in set_password_token_hash with a 30-minute expiry and emails a single-use link (template password-reset, Step 6). POST /auth/password/reset checks hash and expiry, sets the new argon2id hash, clears the token, revokes every refresh-token family, clears the lockout and writes an audit row. It never signs the user in and never disables TOTP. Never log the token.
Write tests for TC-001, TC-002, TC-003, TC-005, TC-098.
```

## Step 3 — RBAC and audit logging

```text
Implement FR-103 and FR-105:
- @Roles() decorator + RolesGuard applied globally; routes are deny-by-default unless decorated @Public().
- A permission matrix file in packages/shared listing each route and allowed roles, used by the guard and by a test that fails if any controller route is missing from the matrix.
- AuditInterceptor that writes audit_logs for every route marked @Audited('action', 'entityType'), including reads of candidate data.
- Staff user management endpoints for SUPER_ADMIN (invite user through a 72-hour set-password link, template staff-invite; change role; deactivate).
Tests: TC-004, TC-006, TC-008.
```

## Step 4 — Question bank

```text
Implement FR-201 to FR-205 (QuestionsModule): CRUD, versioning (published versions immutable; edits create a new version), test cases, variants with a params schema and a template renderer for statements, starter code and reference solutions (use a safe template engine with no code execution, e.g. Mustache), per-variant test data in variant_test_cases that overrides a test slot's input and expected output (ADR 0007), MCQ and short-answer support through answer_spec (short answer: canonical answer plus accepted variants, D-23), tag and difficulty filters with pagination.
AI reference solutions (ADR 0005, D-20): author endpoints to add, list and supersede rows in ai_reference_solutions for Python, JavaScript and Java only (shared constant AI_REFERENCE_LANGUAGES); rows are append-only and audited; publishing requires rows from at least aiReferences.minAssistants (default 2) distinct assistants for each allowed language in that list. These rows are never used for grading.
The candidate-facing serializer must never include hidden test cases, reference solutions, AI reference solutions, answer_spec, or variant params; it shows the variant's rendered statement and its own sample cases.
POST /questions/:id/validate enqueues a job that runs the rendered reference solution against every test slot of every active variant with that variant's data and stores validation_report (execution service comes in Step 5; stub it behind an interface for now).
Tests: TC-010, TC-011, TC-013, TC-014.
```

## Step 5 — Code execution with Judge0

```text
Add Judge0 CE to infra/docker-compose.yml following its official self-hosting instructions (its own Postgres and Redis, privileged workers), on an internal Docker network with no internet egress for the workers.
Create an ExecutionService in apps/api with a Judge0 client: map our language keys to Judge0 language IDs, submit in batch mode, poll with backoff, apply per-question limits (cpu_ms, wall_ms, memory_kb), normalize outputs (trim trailing whitespace) before comparison, and return per-test results.
Wire the Step 4 validate job to it; publishing a question requires a passing validation (FR-203, TC-012).
Tests: TC-042, TC-043, TC-044 as integration tests against the local Judge0.
```

## Step 6 — Tests, invitations and email

```text
Implement FR-301 to FR-305 (TestsModule, InvitationsModule):
- Test templates with sections run in order (section time limits may not add up to more than duration_minutes, ADR 0002), fixed questions and random-pick rules, proctoring profile (STANDARD or STRICT; LOCKDOWN does not exist in this build), pass score. A test that has sessions is copied or archived, never edited in place.
- Invitations: 32-byte random token (only its SHA-256 hash stored), window start/end, accommodations JSON validated by a zod schema (extraTimePct, disabledDetectors[], allowedAssistiveTools[], notes). Creating an invitation also creates its session in status INVITED through SessionStateService (ADR 0002). A repeatable job moves sessions not yet started to EXPIRED after window_end.
- Bulk CSV upload with row-level validation report.
- BullMQ queue `email` with a processor using Amazon SES (C-31; `MailPort`, `EMAIL_PROVIDER=ses` in pilot and production, `noop` locally; credentials only from the AWS SDK default chain, never static keys; templates: invitation, reminder 24 h before window_end, OTP, results, otp-lockout recruiter notice, consent-copy with the signed consent PDF attached (D-17), password-reset (D-22), staff-invite, erasure-delayed (D-19)). The provider sits behind the `MailPort` interface. Jobs carrying an OTP, token or PDF are removed when they finish.
Tests: TC-020, TC-022, TC-023, TC-024.
```

## Step 7 — Candidate session and state machine

```text
Implement FR-106, FR-401 and the session state machine in /docs/fsd.md section 3 (rules in ADR 0002):
- POST /candidate/session/start: invitation token + email OTP (6 digits, 10 min; OTP state in Redis keyed with an HMAC pepper, ADR 0003) → candidate session JWT bound to session ID and auth_epoch, short lived, refreshed via heartbeat. Before the test starts, 5 wrong OTPs block the link for 30 min and notify the recruiter (TC-007). Once the session is IN_PROGRESS or PAUSED there is no block: each wrong OTP logs RESUME_OTP_FAILED, alerts the proctor on live:{orgId}, and allows a retry after a 30 s cooldown (D-21, TC-097). Each successful OTP increments auth_epoch.
- A SessionStateService that is the only code allowed to change sessions.status; it rejects illegal transitions and records timestamps (including retention_anchor_at on COMPLETED, EXPIRED and DECLINED). Use a table-driven transition map.
- Consent document (D-17): GET /candidate/session/consent returns the org's current consent text (refused when REQUIRE_LEGAL_APPROVED_CONSENT is true and the text has no Legal approval). POST /candidate/session/consent/sign stores the consents row with consent_text_id, the typed full legal name, server signed_at, IP and user agent, moves OPENED → CONSENTED, and enqueues a job that renders the signed PDF (document text, version, signed name, server timestamp) with a headless-free PDF library such as pdfkit, stores it in object storage (consents.pdf_key) and emails the candidate a copy (template consent-copy). POST /candidate/session/consent/decline stores declined_at and moves OPENED → DECLINED: no device access, no recording. Every session needs its own signature.
- On transition to IN_PROGRESS: set invitations.used_at; assign questions (resolve random rules, pick a variant per question, store session_questions with test_question_id), create session_sections and open the first, set deadline_at = now + duration adjusted by accommodations (section limits scale the same way), generate a per-session HMAC key (stored encrypted with AES-256-GCM using a KMS-style key from env) and return it once.
- Resume rules (ADR 0002 L-1..L-5): reopening the link resumes an IN_PROGRESS or PAUSED session; SUBMITTED or later shows "Already used"; DECLINED shows the declined page with the org's contact.
- Heartbeat endpoint updates last_heartbeat; a repeatable BullMQ job logs a DISCONNECTED event after 60 s silence (an event, not a status).
Tests: TC-021, TC-030 (API side), TC-047, TC-095 and TC-096 (API side), TC-097, and unit tests for every allowed and forbidden transition.
```

## Step 8 — Identity verification service

```text
Implement FR-403 across API and worker:
- API: POST /candidate/session/identity accepts object storage keys for the ID image and selfie (uploaded via presigned URLs from Step 9), enqueues a `face-match` job, and returns a job ID; GET returns status.
- Worker (apps/worker, Python FastAPI + a job consumer): use an open-source face embedding model (AuraFace: only the recognition model glintr100.onnx from fal/AuraFace-v1, Apache 2.0, via onnxruntime on CPU, behind a swappable face-matching interface; MediaPipe for face detection and alignment to the 112x112 crop; load no InsightFace pretrained model files; see ADR 0001 D-05 and section 12) to compute similarity between the ID face and the selfie. Return score and pass/fail against a configurable threshold. Keep the selfie embedding only in worker memory for periodic re-checks (FACE_MISMATCH), recomputing it from the stored selfie image when needed.
- Failures after one retry go to manual approval, never auto-reject.
- Never store embeddings (ADR 0004): only the score, model_id and threshold are kept on identity_checks, so the retention job has no embeddings to delete.
Tests: TC-033 with fixture images you generate or source under a permissive license.
```

## Step 9 — Media storage (S3-compatible)

```text
Implement FR-701 to FR-704 media endpoints:
- StorageService using the AWS S3 SDK v3 behind one S3-compatible interface: Cloudflare R2 on staging (synthetic data only), AWS S3 on pilot and production. Only configuration (endpoint, region, credentials, bucket names from env) differs between environments; follow ADR 0001 section 2.1. Buckets are private.
- POST /candidate/session/media/presign: returns a presigned PUT URL valid 60 s for the chunk's key (layout per ARC-03), with content-type and max size enforced; records a media_chunks row (stream, segment, seq) as pending, upserting on retry; a confirm call checks the object with HEAD and marks it uploaded. A recorder restart starts a new segment (ADR 0004).
- Staff playback: GET /review/sessions/:id/media returns a playlist of signed GET URLs valid 15 min, grouped by stream and segment in seq order.
- Implement the storage interface used by RetentionService and CandidateErasureService (Database Step 6), including consent PDFs and report PDFs, and schedule retention daily with BullMQ.
Tests: TC-070 (API side), TC-071, TC-072.
```

## Step 10 — Proctor events and keystroke ingestion

```text
Implement FR-801 and the event security rules in /docs/architecture.md:
- POST /candidate/session/events: batch of up to 100 events, each validated by the shared zod schema (packages/shared/events.ts: type, occurredAt, durationMs, confidence, payload, evidenceKey; severity is assigned by the server from the type, ADR 0005). The whole batch carries an HMAC-SHA256 signature over its canonical JSON + a batch sequence. Store the batch in proctor_event_batches in the same transaction as its events: same seq and same signature is an idempotent retry (200, nothing stored); same seq and a different signature is rejected (TC-065); late batches after an outage are accepted.
- Events with severity HIGH are also published to Redis pub/sub channel `live:{orgId}` for Step 13.
- Certain events change state (ADR 0002 section 5): SCREEN_SHARE_STOPPED, FULLSCREEN_EXIT and SIDE_CAMERA_DISCONNECTED add a pause reason and move the session to PAUSED; FULLSCREEN_RESTORED, SCREEN_SHARE_RESUMED and SIDE_CAMERA_RECONNECTED remove it, and the session returns to IN_PROGRESS when no reason is left. These candidate-caused pauses do not stop the clock: deadline_at and paused_ms do not change. Only a proctor pause (Step 13) is credited.
- POST /candidate/session/keystrokes: batches of editor events (plain JSON; compression only at the HTTP level), same HMAC scheme and idempotency, stored in keystroke_batches with their signature.
Tests: TC-050 and TC-055 (API side), TC-065.
```

## Step 11 — Run, submit and grading

```text
Implement FR-502 to FR-506:
- POST /candidate/answers/:questionId/run: sample tests only (the variant's own sample data), 1 run per 5 s per session (Redis rate limiter), stores a submissions row of kind RUN, autosaves final_code. Only questions in the open section are accepted (409 otherwise, ADR 0002 S-5).
- PUT /candidate/answers/:questionId/draft: autosave every 10 s (code, or the MCQ or short-answer answer in session_questions.answer).
- POST /candidate/answers/:questionId/submit: hidden tests with the variant's data; question score = points x passed hidden weight / total hidden weight (FR-506, TC-048 expects 70.00).
- POST /candidate/session/finish, a job that closes each section at its deadline (submitting that section's latest saved code and opening the next), and a scheduled job that auto-submits sessions past deadline_at using the latest saved code.
- Scoring of MCQ and short answers in grade-session (D-23): MCQ by key; a short answer that matches the canonical answer or an accepted variant after normalization (NFKC, trim, collapse whitespace, lower-case) gets full points; any other short answer is set to scoring MANUAL_PENDING with no score (never 0) and the session must go to UNDER_REVIEW. Provide the endpoint reviewers use to mark it correct or incorrect (sets score, scoring MANUAL, scored_by, scored_at; audited); total_score is computed when the last one is scored.
- On SUBMITTED, enqueue `grade-session` then `analyze-session`; move to GRADED when grading completes.
- All timing uses server time only.
Tests: TC-040, TC-041, TC-045, TC-046, TC-048, TC-099 (API side).
```

## Step 12 — Integrity analysis worker

```text
Implement FR-802 to FR-805 in apps/worker (Python):
- Audio: download the session's audio chunks from object storage, run Silero VAD to find speech segments; estimate multiple speakers with a lightweight speaker-change heuristic; emit SPEECH_DETECTED / MULTIPLE_VOICES events with source='SERVER'.
- Keystrokes: reconstruct the editor timeline; detect PASTE_BURST (over 80 inserted characters within 1 s), TYPING_ANOMALY (inter-key timing distribution too regular, suggesting auto-typers), and idle-then-complete patterns.
- Similarity: normalize code (strip comments, whitespace, rename identifiers via tokenization) and compute winnowing fingerprints (MOSS-style) against other submissions for the same question version and against stored AI-generated reference answers for that question; emit CODE_SIMILARITY / AI_LIKENESS above thresholds.
- Risk score: weights and bands from organization settings (defaults in /docs/fsd.md FR-804); write risk_score and risk_band; move to UNDER_REVIEW or COMPLETED (LOW band and no identity check or short answer awaiting a human, ADR 0002), always through SessionStateService.
- Every heuristic has unit tests with synthetic data, and every threshold is configurable.
Tests: TC-061 (server side), TC-073, TC-074, TC-075, TC-076.
```

## Step 13 — Review and live proctoring API

```text
Implement FR-901 to FR-904:
- GET /review/queue (filters: band, test, date; sorted by risk desc).
- GET /review/sessions/:id returns a bundle: session, candidate, questions and submissions, events timeline, media playlist, keystroke batch URLs, identity check result.
- PATCH /review/flags/:eventId (CONFIRMED/DISMISSED + note); POST /review/sessions/:id/verdict requires every HIGH flag decided (TC-078), the identity decision recorded when the identity check is in MANUAL_REVIEW (ADR 0004), and every short answer manually scored (D-23).
- Proctor pause and resume follow ADR 0002 section 5: only a proctor pause stops the clock, and its time is credited to deadline_at and the open section, capped by maxProctorPauseMinutes.
- Appeals: candidate endpoint via a signed link in the verdict email; assignment to a different reviewer (TC-080).
- Socket.IO gateway /live authenticated with staff JWT: subscribe to org sessions, receive heartbeats, HIGH events and latest webcam thumbnail keys; emit proctor:pause and proctor:message to a specific candidate socket (TC-079). Use the Redis adapter so it scales past one instance.
```

## Step 14 — Reports and integrations

```text
Implement FR-1001 to FR-1003:
- Candidate report PDF generated server-side with a headless-free approach (e.g. pdfkit or @react-pdf/renderer), stored in object storage under sessions.report_key (removed by retention and erasure), signed download link. Reuse the PDF renderer introduced in Step 7 for the consent PDF.
- Dashboard metrics endpoint (invitations sent, completion rate, pass rate, flag rate by type, by date range) using SQL aggregates; DECLINED and EXPIRED sessions count as not completed.
- Webhooks: org-configured endpoints in webhook_endpoints (secret encrypted with AES-256-GCM), HMAC-signed payloads, retries with exponential backoff via BullMQ, delivery log in webhook_deliveries (no payload stored).
- CSV export of results.
Tests: TC-081.
```

## Step 15 — Security and performance hardening

```text
Review the whole backend against OWASP ASVS Level 2 and /docs/fsd.md NFR-01 to NFR-09. Produce /docs/security-review.md listing each finding and its fix, then fix them.
At minimum: dependency audit, secrets scanning in CI, input size limits on every endpoint, strict CORS, SSRF protection on webhooks (block private IP ranges), SQL injection review of any raw queries, rate limits on every public route, and log redaction.
Add k6 load scripts for 200 concurrent candidates (heartbeats, events, keystrokes, runs) and tune until TC-090 and TC-091 pass on the staging VM.
```
