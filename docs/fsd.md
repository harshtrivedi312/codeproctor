# Functional Specification Document (FSD)

This tab turns each business requirement into testable functional requirements (FR), screens, API contracts and rules. Requirement IDs here are referenced by the Test Cases tab and the build prompts.

## 1. Modules

| Module | Covers BR | Owner service |
| --- | --- | --- |
| M1 Identity & Access | BR-14 | API: auth, users |
| M2 Question Bank | BR-05, BR-08 | API: questions |
| M3 Test Builder & Invitations | BR-01 | API: tests, invitations |
| M4 Candidate Portal | BR-02, BR-12 | Web: candidate app |
| M5 Coding Environment & Execution | BR-05 | Web + API + Judge0 |
| M6 Proctoring Client | BR-03, BR-04 | Web: proctor SDK |
| M7 Media Pipeline | BR-03, BR-13 | API + object storage (S3-compatible) + worker |
| M8 Integrity Engine | BR-06, BR-10 | Worker |
| M9 Review & Live Proctoring | BR-07, BR-09 | Web: staff app + Socket.IO |
| M10 Reporting & Integrations | BR-15 | API |
| M11 Lockdown Client | BR-11 | Electron (Phase 3) |

## 2. Functional requirements

### M1 Identity & Access

- **FR-101** Staff log in with email + password (Argon2id hashed); lock account for 15 minutes after 5 failed attempts.
- **FR-102** TOTP two-factor authentication is mandatory for Super Admin and Reviewer, optional for others.
- **FR-103** Role-based access control with roles SUPER\_ADMIN, RECRUITER, AUTHOR, REVIEWER. Permissions are checked on every API route.
- **FR-104** Access token lifetime 15 minutes, refresh token 7 days, rotated on use and revocable.
- **FR-105** Every read or change of candidate data by staff writes an audit log entry (who, what, when, IP).
- **FR-106** Candidates do not have passwords; they authenticate with a one-time invitation token plus an email OTP. Before the test starts, 5 wrong OTPs block the link for 30 minutes and notify the recruiter. Once the test is in progress there is no lockout: a wrong OTP (for example when resuming on a new device) logs an event, alerts the proctor and allows a retry after a short cooldown (updated 2026-10-01, D-21).
- **FR-107** Staff can reset a forgotten password through an emailed single-use link with a short expiry. The response never reveals whether an account exists, a reset revokes all of the user's refresh tokens, and TOTP is still required at the next login for roles that have it (added 2026-10-01, D-22).

### M2 Question Bank

- **FR-201** Authors create coding questions with title, markdown statement, difficulty, tags, allowed languages, time and memory limits, starter code per language, and a reference solution.
- **FR-202** Each question has visible sample test cases and hidden test cases, each with a weight.
- **FR-203** A question can define variant parameters (for example array sizes, constants, entity names) so each candidate gets a different but equivalent version. Each variant has its own test inputs and expected outputs for the same test slots and weights. The reference solution must pass every variant's tests before publishing (ADR 0007).
- **FR-204** Questions are versioned; editing a published question creates a new version and never changes past attempts.
- **FR-205** Multiple-choice and short-answer questions are supported as secondary types. Multiple-choice answers are scored automatically. A short answer is scored automatically when, after normalization, it exactly matches the question's answer or one of its accepted variants. A short answer that does not match goes to manual scoring by a reviewer and is never automatically marked wrong (updated 2026-10-01, D-23).

### M3 Test Builder & Invitations

- **FR-301** Recruiters build a test from fixed questions or random picks by tag and difficulty, with total duration and per-section time limits. Sections run in order; the server enforces each section's deadline, and a finished section cannot be reopened. Extra time scales section limits by the same percentage as the total (ADR 0002).
- **FR-302** Proctoring profile per test: STANDARD (web), STRICT (web + second camera), LOCKDOWN (desktop client required). LOCKDOWN is not offered in this build; it returns with the lockdown client in a later phase (D-13, ADR 0007).
- **FR-303** Invitations are sent by email with a unique token link, valid within a start window (for example 7 days) and usable once.
- **FR-304** Bulk invitations by CSV upload; reminders 24 hours before window closes.
- **FR-305** Per-candidate accommodations: extra time percentage, disabled detectors, allowed assistive tools.

### M4 Candidate Portal

- **FR-401** Landing page shows the rules, what is recorded and the retention period. After the candidate passes the email OTP, the candidate must sign a consent document before every test session; a signature is never reused across sessions or tests (updated 2026-10-01, D-17).
  - The document is 2-3 pages, versioned and stored. It covers what is recorded (screen, webcam, microphone, keystrokes), the ID image and selfie, face matching, automated detection and human review, how results are used in hiring, retention and deletion, who can access the data, appeals, accommodations and how to withdraw.
  - The candidate scrolls to the end and signs by typing their full legal name. The server records the date and time.
  - Stored per session: document version, signed name, signed timestamp, IP, user agent, and a generated PDF of the signed document in object storage. The candidate is emailed a copy.
  - Declining ends the session without any recording and shows a contact for alternatives or accommodations.
  - No device access or recording starts before the document is signed.
  - Until Legal supplies and approves the text, it is a clearly marked placeholder, and pilot and production refuse it.
- **FR-402** System check: browser (Chromium required for STANDARD and STRICT), camera, microphone, screen-share support, network speed, single monitor.
- **FR-403** Identity check: photo of government ID and a live selfie with liveness prompt (turn head, blink); face match score stored; ID image never used for other purposes. A failed or low-confidence match gets one retry and then goes to manual reviewer comparison; it never rejects the candidate or blocks the test (D-05, ADR 0004).
- **FR-404** Room scan: candidate rotates the camera 360 degrees and shows the desk surface; stored as a clip.
- **FR-405** STRICT profile: candidate opens a QR-code link on a phone that streams a side view of the desk.
- **FR-406** A practice question lets candidates try the editor before the timed test.

### M5 Coding Environment & Execution

- **FR-501** Monaco editor with syntax highlighting per language; autocomplete limited to language keywords (no AI completion).
- **FR-502** Run button executes code against sample tests; Submit runs hidden tests. Limit: 1 run per 5 seconds per candidate.
- **FR-503** Code executes in Judge0 with CPU time, wall time and memory limits; no network access.
- **FR-504** Code autosaves every 10 seconds and on every run, so a crash or reconnect loses at most 10 seconds.
- **FR-505** Server-side timer is the source of truth; the test auto-submits at time zero.
- **FR-506** Coding question score = question points × (sum of passed hidden test weights ÷ sum of all hidden test weights). MCQ and short-answer question score = question points if correct, else 0. Session score = sum of question scores (updated 2026-10-01, ADR 0007).

### M6 Proctoring Client

- **FR-601** Fullscreen is required; exiting fullscreen pauses the editor and logs FULLSCREEN\_EXIT.
- **FR-602** Page visibility and window focus changes log TAB\_SWITCH / FOCUS\_LOST with duration.
- **FR-603** Paste, drop, right-click and common devtools shortcuts are blocked inside the test and each attempt is logged.
- **FR-604** Screen share must be the entire screen (displaySurface = monitor); stopping it pauses the test until re-shared.
- **FR-605** Multiple monitors detected (Window Management API where available) logs MULTI\_MONITOR and blocks start.
- **FR-606** Webcam frames are analyzed in-browser every 1 second: NO\_FACE (over 5 s), MULTIPLE\_FACES, FACE\_MISMATCH (periodic re-check against selfie), GAZE\_AWAY (over 5 s), PHONE\_DETECTED, BOOK\_DETECTED.
- **FR-607** Microphone audio levels and voice activity are analyzed; SPEECH\_DETECTED and MULTIPLE\_VOICES are logged.
- **FR-608** Every keystroke and editor change is recorded with a timestamp (insert, delete, cursor move) for replay.
- **FR-609** Heartbeat every 10 s; missing heartbeats over 60 s logs DISCONNECTED; the test resumes on reconnect with time continuing.
- **FR-610** DevTools open detection, virtual-camera device name detection, and browser extension interference checks log events where detectable.

### M7 Media Pipeline

- **FR-701** Screen, webcam and audio are recorded with MediaRecorder in 10-second chunks and uploaded directly to object storage (Cloudflare R2 on staging, AWS S3 on pilot and production) using short-lived presigned URLs.
- **FR-702** Failed chunk uploads are retried with backoff and buffered in IndexedDB up to 200 MB.
- **FR-703** Recordings are encrypted at rest; playback uses signed URLs valid for 15 minutes.
- **FR-704** A scheduled job deletes recordings and ID images after the retention period (default 90 days, configurable). The period counts from the session's final outcome, and nothing is deleted while a review or appeal is open (ADR 0004).

### M8 Integrity Engine

- **FR-801** Every proctoring event has a type, severity (LOW, MEDIUM, HIGH), timestamp, duration and evidence reference.
- **FR-802** Keystroke analytics compute: paste-like bursts (over 80 characters in under 1 s), typing speed outliers, ratio of deletions, idle-then-complete patterns.
- **FR-803** Code similarity against other submissions for the same question and against stored AI-generated reference solutions.
- **FR-804** Risk score 0–100 = weighted sum of event severities and analytics, capped at 100. Bands: 0–29 LOW, 30–59 MEDIUM, 60–100 HIGH. Weights are configurable.
- **FR-805** Sessions in MEDIUM or HIGH band go to the review queue automatically. So do sessions whose identity check awaits manual review and sessions with a short answer awaiting manual scoring (ADR 0002).

### M9 Review & Live Proctoring

- **FR-901** Review page: timeline of events, synchronized screen/webcam video, keystroke replay at 1x–16x speed, code diff per run, test results.
- **FR-902** Reviewer marks each flag CONFIRMED or DISMISSED with a note, then sets session verdict CLEAN, SUSPICIOUS or VIOLATION.
- **FR-903** Live view grid of active sessions with latest webcam thumbnail and live events; proctor can send a message or pause a session.
- **FR-904** Candidates can submit an appeal within 7 days of a VIOLATION verdict; appeals go to a different reviewer.

### M10 Reporting & Integrations

- **FR-1001** Candidate report (score, per-question results, verdict, reviewer notes) as PDF.
- **FR-1002** Dashboard: invitations sent, completion rate, pass rate, flag rate by type.
- **FR-1003** Webhooks on session.completed and session.reviewed; CSV export.

### M11 Lockdown Client (Phase 3)

- **FR-1101** Electron app loads the candidate portal in kiosk mode and blocks OS shortcuts, clipboard and screen capture tools.
- **FR-1102** Detects and blocks known remote-desktop, virtual machine and AI assistant processes; reports them as events.
- **FR-1103** The server refuses LOCKDOWN tests from anything but a signed client (attested with a per-session key).

## 3. Session state machine

| State | Entered when | Next states |
| --- | --- | --- |
| INVITED | Invitation created (the session row is created with it) | OPENED, EXPIRED |
| OPENED | Candidate opens link inside the window and passes OTP | CONSENTED, DECLINED, EXPIRED |
| CONSENTED | Consent document signed | VERIFIED, EXPIRED |
| VERIFIED | System check, ID and selfie attempts and room scan done (identity passed or sent to manual review; never rejected) | IN\_PROGRESS, EXPIRED |
| IN\_PROGRESS | Timer starts | PAUSED, SUBMITTED |
| PAUSED | Fullscreen exit, share stopped, STRICT side camera lost, proctor pause (only a proctor pause stops the clock) | IN\_PROGRESS, SUBMITTED |
| SUBMITTED | Candidate submits, last section ends, or time runs out | GRADED |
| GRADED | Hidden tests and risk score done | UNDER\_REVIEW, COMPLETED |
| UNDER\_REVIEW | Risk MEDIUM/HIGH, identity awaiting manual review, or a short answer awaiting manual scoring | COMPLETED |
| COMPLETED | Verdict set or auto-clean | APPEALED |
| APPEALED | Candidate appeals within 7 days of a VIOLATION verdict | COMPLETED |
| EXPIRED | Start window closed before the test started | — |
| DECLINED | Candidate declined the consent document; no recording | — |

Rules and timing details: ADR 0002 (updated 2026-10-01, D-16, D-17).

## 4. Core API (REST, JSON, `/api/v1`)

| Method | Path | Role | Purpose |
| --- | --- | --- | --- |
| POST | /auth/login | Staff | Password login, returns 2FA challenge if enabled |
| POST | /auth/2fa/verify | Staff | Completes login |
| POST | /auth/refresh | Staff | Rotate tokens |
| POST | /auth/password/forgot | Public | Request a password reset link; same response whether or not the account exists (FR-107) |
| POST | /auth/password/reset | Public | Set a new password with the single-use reset token (FR-107) |
| GET/POST/PATCH | /questions, /questions/:id | Author (read: also Super Admin, Recruiter) | CRUD and versions. Roles without `question:update` get published versions only, with hidden test cases and the reference solution omitted (FR-202, FR-301, TC-011) |
| GET | /questions/:id/preview | Author | Candidate-view preview of a version |
| POST | /questions/:id/publish, /archive, /unarchive | Author | Publish a version, archive or restore a question (FR-204) |
| POST/PATCH/DELETE | /questions/:id/versions/:version/test-cases[/:testCaseId] | Author | Sample and hidden test cases with weights (FR-202) |
| POST | /questions/:id/validate | Author | Run reference solution on all tests and variants |
| GET/POST/PATCH | /tests, /tests/:id | Recruiter | Test templates |
| POST | /tests/:id/invitations | Recruiter | Single or bulk invite |
| POST | /candidate/session/start | Candidate | Exchange invitation token + OTP for session token |
| GET | /candidate/session/consent | Candidate | The consent document for this session (version and text) |
| POST | /candidate/session/consent/sign | Candidate | Sign with the typed full legal name; server timestamps it, stores the PDF and emails a copy (FR-401) |
| POST | /candidate/session/consent/decline | Candidate | Decline; ends the session with no recording (FR-401) |
| POST | /candidate/session/identity | Candidate | Upload ID + selfie, returns match result |
| POST | /candidate/session/media/presign | Candidate | Presigned URL for next recording chunk |
| POST | /candidate/session/events | Candidate | Batch of proctoring events |
| POST | /candidate/session/keystrokes | Candidate | Batch of editor events |
| POST | /candidate/answers/:questionId/run | Candidate | Run sample tests |
| POST | /candidate/answers/:questionId/submit | Candidate | Submit and grade hidden tests |
| POST | /candidate/session/finish | Candidate | End test |
| GET | /review/queue | Reviewer | Sessions awaiting review |
| GET | /review/sessions/:id | Reviewer | Full review bundle |
| PATCH | /review/flags/:id | Reviewer | Confirm or dismiss a flag |
| POST | /review/sessions/:id/verdict | Reviewer | Final verdict |
| WS | /live | Reviewer | Live sessions, events, pause/message |

## 5. Non-functional requirements

| ID | Area | Requirement |
| --- | --- | --- |
| NFR-01 | Performance | API p95 under 300 ms excluding code execution; code run result under 5 s p95 |
| NFR-02 | Capacity | 200 concurrent candidates on the pilot deployment |
| NFR-03 | Availability | 99.5% during scheduled test windows |
| NFR-04 | Security | OWASP ASVS Level 2; TLS 1.2+; secrets in environment vault; rate limits on all public endpoints |
| NFR-05 | Privacy | Data minimization, encryption at rest, retention jobs, deletion on request within 30 days. Provisional (D-19, Legal to confirm): erasure waits while a review or appeal is open and runs as soon as it closes; the candidate is told. Proposed wording for Legal (D-27): erasure completes within 30 days of the request, or within 30 days after an open review or appeal closes, whichever is later; the candidate is told about any delay. The hold is configurable |
| NFR-06 | Accessibility | WCAG 2.1 AA on candidate and staff screens |
| NFR-07 | Browser support | Chrome and Edge (latest 2 versions) for STANDARD/STRICT; Firefox and Safari blocked with a clear message |
| NFR-08 | Resilience | A network drop of up to 60 s loses no code and no recording chunks |
| NFR-09 | Observability | Structured logs, error tracking, uptime alerts, per-session trace ID |
