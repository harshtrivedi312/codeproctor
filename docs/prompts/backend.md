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
Implement FR-101, FR-102 and FR-104 from /docs/fsd.md in an AuthModule:
- POST /auth/login (argon2id verify, lockout after 5 failures for 15 min, generic error messages).
- TOTP 2FA with otplib: enroll (QR code as data URL), verify, recovery codes (hashed). Enforce for SUPER_ADMIN and REVIEWER.
- Access JWT 15 min (in memory on client), refresh token 7 days in an httpOnly, Secure, SameSite=Strict cookie, stored hashed in refresh_tokens, rotated on use; reuse of a rotated token revokes the whole family.
- POST /auth/logout revokes the family.
Write tests for TC-001, TC-002, TC-003, TC-005.
```

## Step 3 — RBAC and audit logging

```text
Implement FR-103 and FR-105:
- @Roles() decorator + RolesGuard applied globally; routes are deny-by-default unless decorated @Public().
- A permission matrix file in packages/shared listing each route and allowed roles, used by the guard and by a test that fails if any controller route is missing from the matrix.
- AuditInterceptor that writes audit_logs for every route marked @Audited('action', 'entityType'), including reads of candidate data.
- Staff user management endpoints for SUPER_ADMIN (invite user, change role, deactivate).
Tests: TC-004, TC-006, TC-008.
```

## Step 4 — Question bank

```text
Implement FR-201 to FR-205 (QuestionsModule): CRUD, versioning (published versions immutable; edits create a new version), test cases, variants with a params schema and a template renderer for statements (use a safe template engine with no code execution, e.g. Mustache), MCQ support, tag and difficulty filters with pagination.
The candidate-facing serializer must never include hidden test cases, reference solutions, or variant params.
POST /questions/:id/validate enqueues a job that runs the reference solution against every test case for every variant (execution service comes in Step 5; stub it behind an interface for now).
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
- Test templates with sections, fixed questions and random-pick rules, proctoring profile, pass score.
- Invitations: 32-byte random token (only its SHA-256 hash stored), window start/end, accommodations JSON validated by a zod schema (extraTimePct, disabledDetectors[], notes).
- Bulk CSV upload with row-level validation report.
- BullMQ queue `email` with a processor using Resend (templates: invitation, reminder 24 h before window_end, OTP, results). Provider behind an interface so Brevo can be swapped in.
Tests: TC-020, TC-022, TC-023, TC-024.
```

## Step 7 — Candidate session and state machine

```text
Implement FR-106, FR-401 and the session state machine in /docs/fsd.md section 3:
- POST /candidate/session/start: invitation token + email OTP (6 digits, 10 min, 5 attempts) → candidate session JWT bound to session ID, short lived, refreshed via heartbeat.
- A SessionStateService that is the only code allowed to change sessions.status; it rejects illegal transitions and records timestamps. Use a table-driven transition map.
- POST /candidate/session/consent stores consents row (consent_version from config).
- On transition to IN_PROGRESS: assign questions (resolve random rules, pick a variant per question, store session_questions), set deadline_at = now + duration adjusted by accommodations, generate a per-session HMAC key (stored encrypted with AES-256-GCM using a KMS-style key from env) and return it once.
- Heartbeat endpoint updates last_heartbeat; a repeatable BullMQ job marks DISCONNECTED after 60 s silence.
Tests: TC-021, TC-030 (API side), TC-047, and unit tests for every allowed and forbidden transition.
```

## Step 8 — Identity verification service

```text
Implement FR-403 across API and worker:
- API: POST /candidate/session/identity accepts R2 keys for the ID image and selfie (uploaded via presigned URLs from Step 9), enqueues a `face-match` job, and returns a job ID; GET returns status.
- Worker (apps/worker, Python FastAPI + a job consumer): use an open-source face embedding model (InsightFace via onnxruntime, CPU) to compute similarity between the ID face and the selfie. Return score and pass/fail against a configurable threshold. Also expose the embedding of the selfie for periodic re-checks (FACE_MISMATCH).
- Failures after one retry go to manual approval, never auto-reject.
- Delete embeddings with the session under the retention job.
Tests: TC-033 with fixture images you generate or source under a permissive license.
```

## Step 9 — Media storage (R2)

```text
Implement FR-701 to FR-704 media endpoints:
- StorageService using the AWS S3 SDK v3 against Cloudflare R2 (endpoint, keys from env). Buckets are private.
- POST /candidate/session/media/presign: returns a presigned PUT URL valid 60 s for key sessions/{sessionId}/{stream}/{seq}.webm, with content-type and max size enforced; records a media_chunks row as pending; a confirm call marks it uploaded.
- Staff playback: GET /review/sessions/:id/media returns a playlist of signed GET URLs valid 15 min, grouped by stream.
- Implement the storage interface used by RetentionService (Database Step 6) and schedule it daily with BullMQ.
Tests: TC-070 (API side), TC-071, TC-072.
```

## Step 10 — Proctor events and keystroke ingestion

```text
Implement FR-801 and the event security rules in /docs/architecture.md:
- POST /candidate/session/events: batch of up to 100 events, each validated by the shared zod schema (packages/shared/events.ts: type, severity, occurredAt, durationMs, confidence, payload, evidenceKey). The whole batch carries an HMAC-SHA256 signature over its canonical JSON + a monotonic batch sequence; reject bad signatures and replayed sequences (TC-065).
- Events with severity HIGH are also published to Redis pub/sub channel `live:{orgId}` for Step 13.
- Certain events change state: SCREEN_SHARE_STOPPED and FULLSCREEN_EXIT move the session to PAUSED; the matching resume events move it back. Paused time is added to paused_ms and extends deadline_at.
- POST /candidate/session/keystrokes: batches of editor events (compressed JSON), same HMAC scheme, stored in keystroke_batches.
Tests: TC-050 and TC-055 (API side), TC-065.
```

## Step 11 — Run, submit and grading

```text
Implement FR-502 to FR-506:
- POST /candidate/answers/:questionId/run: sample tests only, 1 run per 5 s per session (Redis rate limiter), stores a submissions row of kind RUN, autosaves final_code.
- PUT /candidate/answers/:questionId/draft: autosave every 10 s.
- POST /candidate/answers/:questionId/submit: hidden tests, weighted score.
- POST /candidate/session/finish and a scheduled job that auto-submits sessions past deadline_at using the latest saved code.
- On SUBMITTED, enqueue `grade-session` then `analyze-session`; move to GRADED when grading completes.
- All timing uses server time only.
Tests: TC-040, TC-041, TC-045, TC-046, TC-048.
```

## Step 12 — Integrity analysis worker

```text
Implement FR-802 to FR-805 in apps/worker (Python):
- Audio: download the session's audio chunks from R2, run Silero VAD to find speech segments; estimate multiple speakers with a lightweight speaker-change heuristic; emit SPEECH_DETECTED / MULTIPLE_VOICES events with source='SERVER'.
- Keystrokes: reconstruct the editor timeline; detect PASTE_BURST (over 80 inserted characters within 1 s), TYPING_ANOMALY (inter-key timing distribution too regular, suggesting auto-typers), and idle-then-complete patterns.
- Similarity: normalize code (strip comments, whitespace, rename identifiers via tokenization) and compute winnowing fingerprints (MOSS-style) against other submissions for the same question version and against stored AI-generated reference answers for that question; emit CODE_SIMILARITY / AI_LIKENESS above thresholds.
- Risk score: weights and bands from organization settings (defaults in /docs/fsd.md FR-804); write risk_score and risk_band; move to UNDER_REVIEW or COMPLETED (LOW band).
- Every heuristic has unit tests with synthetic data, and every threshold is configurable.
Tests: TC-061 (server side), TC-073, TC-074, TC-075, TC-076.
```

## Step 13 — Review and live proctoring API

```text
Implement FR-901 to FR-904:
- GET /review/queue (filters: band, test, date; sorted by risk desc).
- GET /review/sessions/:id returns a bundle: session, candidate, questions and submissions, events timeline, media playlist, keystroke batch URLs, identity check result.
- PATCH /review/flags/:eventId (CONFIRMED/DISMISSED + note); POST /review/sessions/:id/verdict requires every HIGH flag decided (TC-078).
- Appeals: candidate endpoint via a signed link in the verdict email; assignment to a different reviewer (TC-080).
- Socket.IO gateway /live authenticated with staff JWT: subscribe to org sessions, receive heartbeats, HIGH events and latest webcam thumbnail keys; emit proctor:pause and proctor:message to a specific candidate socket (TC-079). Use the Redis adapter so it scales past one instance.
```

## Step 14 — Reports and integrations

```text
Implement FR-1001 to FR-1003:
- Candidate report PDF generated server-side with a headless-free approach (e.g. pdfkit or @react-pdf/renderer), stored in R2, signed download link.
- Dashboard metrics endpoint (invitations sent, completion rate, pass rate, flag rate by type, by date range) using SQL aggregates.
- Webhooks: org-configured endpoints, HMAC-signed payloads, retries with exponential backoff via BullMQ, delivery log.
- CSV export of results.
Tests: TC-081.
```

## Step 15 — Security and performance hardening

```text
Review the whole backend against OWASP ASVS Level 2 and /docs/fsd.md NFR-01 to NFR-09. Produce /docs/security-review.md listing each finding and its fix, then fix them.
At minimum: dependency audit, secrets scanning in CI, input size limits on every endpoint, strict CORS, SSRF protection on webhooks (block private IP ranges), SQL injection review of any raw queries, rate limits on every public route, and log redaction.
Add k6 load scripts for 200 concurrent candidates (heartbeats, events, keystrokes, runs) and tune until TC-090 and TC-091 pass on the staging VM.
```
