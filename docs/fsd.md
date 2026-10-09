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
- **FR-102** TOTP two-factor authentication is optional and recommended for every staff role (D-70, the owner's decision of 2026-10-08, replacing the earlier rule that it was mandatory for Super Admin and Reviewer; asked as "Should it [staff two-factor sign-in] become optional for every role?", answered "Optional for all, recommended"). A user without it signs in with the password only, and the app nudges them after sign-in to set it up (a dismissible prompt; the wording is the frontend's). A user who has TOTP enrolled is always asked for the code at sign-in, and no path (password reset, token refresh, recovery) signs them in without the second factor. Turning it off still needs the current password and a current code (ADR 0011). **Risk accepted by the owner (D-70):** an account without TOTP is exposed to takeover by a guessed or stolen password; for a Reviewer or Super Admin, who see candidate media, identity images and verdicts, that is a higher exposure than before. It is recommended that the owner revisit this before the pilot opens to real candidates.
- **FR-103** Role-based access control with roles SUPER\_ADMIN, RECRUITER, AUTHOR, REVIEWER. Permissions are checked on every API route.
- **FR-104** Access token lifetime 15 minutes, refresh token 7 days, rotated on use and revocable.
- **FR-105** Every read or change of candidate data by staff writes an audit log entry (who, what, when, IP). The audit trail is kept for 3 years (C-40; ADR 0004 10.3, Proposed).
- **FR-106** Candidates do not have passwords; they authenticate with a one-time invitation token plus an email OTP. Before the test starts, 5 wrong OTPs block the link for 30 minutes and notify the recruiter. Once the test is in progress there is no lockout: a wrong OTP (for example when resuming on a new device) logs an event, alerts the proctor and allows a retry after a short cooldown (updated 2026-10-01, D-21).
- **FR-107** Staff can reset a forgotten password through an emailed single-use link with a short expiry. The response never reveals whether an account exists, a reset revokes all of the user's refresh tokens, and TOTP is still required at the next login for users who have it enrolled (added 2026-10-01, D-22; reworded for D-70).

### M2 Question Bank

- **FR-201** Authors create coding questions with title, markdown statement, difficulty, tags, allowed languages, time and memory limits, starter code per language, and a reference solution.
- **FR-202** Each question has visible sample test cases and hidden test cases, each with a weight.
- **FR-203** A question can define variant parameters (for example array sizes, constants, entity names) so each candidate gets a different but equivalent version. Each variant has its own test inputs and expected outputs for the same test slots and weights. The reference solution must pass every variant's tests before publishing (ADR 0007).
- **FR-204** Questions are versioned; editing a published question creates a new version and never changes past attempts.
- **FR-205** Multiple-choice and short-answer questions are supported as secondary types. Multiple-choice answers are scored automatically. A short answer is scored automatically when, after normalization, it exactly matches the question's answer or one of its accepted variants. A short answer that does not match goes to manual scoring by a reviewer and is never automatically marked wrong (updated 2026-10-01, D-23).

### M3 Test Builder & Invitations

- **FR-301** Recruiters build a test from fixed questions or random picks by tag and difficulty, with total duration and per-section time limits. Sections run in order; the server enforces each section's deadline, and a finished section cannot be reopened. Extra time scales section limits by the same percentage as the total (ADR 0002).
- **FR-302** Proctoring profile per test: STANDARD (web), STRICT (web + second camera), LOCKDOWN (desktop client required). LOCKDOWN is not offered in this build; it returns with the lockdown client in a later phase (D-13, ADR 0007).
- **FR-303** Invitations are sent by email with a unique token link and usable once. The recruiter picks a slot when inviting (C-46, ADR 0017). The identity and system gate (OTP, consent, system check, ID and selfie, room scan, STRICT phone pairing) takes time, so the invitation stores the moment the gate opens as `window_start`, which is 30 minutes before the slot start, and the last moment the timed test may start as `window_end`, which is the slot start plus 15 minutes (the owner confirmed the 30-minute gate offset and the 15-minute late start, D-66; the gate offset is a constant of 30 minutes, so the slot start of a row is always its `window_start` plus 30 minutes; the late-start allowance is a setting whose value is stored in `window_end` when the invitation is created). Before `window_start` the link answers with the same neutral page as FR-407 and no OTP is sent; the gate opens only at `window_start`. The 45-minute early start of the instances leaves 15 minutes of warm-up before the gate opens. The candidate cannot open the gate before `window_start` or start the timed test before the slot start. After `window_end` the link shows the expired page and the session becomes EXPIRED (ADR 0002), at the next start of the instances or when the link is opened with the API up (the 5-minute expiry job runs only while an instance runs). A candidate cannot self-book or reschedule: a reschedule request goes to the recruiter, who changes the slot.
- **FR-304** Bulk invitations by CSV upload, with a slot per row. A row whose slot is refused by the capacity rule of FR-306 is refused on its own, with the reason in the error report; the other rows are sent. Reminders are sent by the app while it runs, in the daily maintenance window before the slot (ADR 0017 sections 4.5 and 4.6), and the invitation and reminder emails state, in UTC and in the time zone stored on the invitation, when the gate opens (`window_start`), the slot start, the latest start (`window_end`) and the time that candidate is allowed (the test duration including their own extra time); the email never shows the window's end or another candidate's accommodation (`invitations.time_zone`, an IANA zone name chosen by the recruiter on the invite or the CSV row, C-53), and in UTC only when no time zone is stored. A slot made after a day's maintenance window and starting before the next one gets only the invitation email, with no reminder (*detail chosen by architect, owner to confirm*: reminders cannot be sent while the instances are off).
- **FR-305** Per-candidate accommodations: extra time percentage, disabled detectors, allowed assistive tools (P-44; OQ-A11Y-6, OQ-A11Y-9). Extra time has **no cap** (C-61, the owner's P-44 decision): the recruiter decides per candidate and sets it with the slot when inviting, and it cannot be changed during the test. A change after booking re-books the slot (a new window and ceiling, ADR 0017 4.3, refused if the new window contains the old ceiling) and is made while the instances run. A candidate asks the recruiter for extra time (there is no self-service request). A change to the org's `maxProctorPauseMinutes` (ADR 0002 P-3) does not change windows that are already booked. Because there is no cap, the session's deadline, the slot length and the instances' hard stop are calculated from that candidate's own deadline including extra time and never from a global maximum (FR-306, FR-307, ADR 0017 4.3). Allowed assistive tools are screen readers, screen magnifiers, dictation, on-screen or switch keyboards and text expansion; none of them is a violation by itself, and any flag they cause is decided by a person (C-14). **Assistive input label:** the recruiter can mark a candidate as using assistive input (dictation, on-screen or switch keyboards, text expansion). The reviewer then sees the label next to that candidate's paste-like, keystroke and speech flags; it never turns a detector off, never removes an event and never changes a risk score, and a person still decides every flag. The stored accommodation keys this needs (the assistive input label, the no-microphone and ID-upload allowances and the room-scan alternative of FR-402 and FR-403) are a change to the shared accommodations contract (`accommodationsSchema` in `packages/shared`, ADR 0010 and ADR 0015) and need an ADR amendment before they are built, with an audit row on every change (C-02) and the same lock as extra time (*detail chosen by architect, owner to confirm; Integrity B confirms against ADR 0005*). **Face refusal is a right and a "no webcam" accommodation exists (C-02 amendment, OQ-14, OQ-15; ADR 0015 10.2 and 10.4, Proposed).** When a candidate asks not to be face-matched, the recruiter grants it and may not refuse; the reason "candidate preference" is allowed, and refusing biometrics turns off every face-based detector. A separate "no webcam" setting is for a candidate who cannot use a camera: it implies no identity check, the face and object detectors off and the room-scan alternative, and the reviewer sees "No webcam".
- **FR-306** Slot capacity limits (C-43, ADR 0017). No slot may be created that would put more than 5 candidates in overlapping occupancy (the pilot's capacity, NFR-02; the number is a configured limit, *detail chosen by architect, owner to confirm*). An invitation's occupancy runs from `window_start` to `window_end` plus the longest accommodated duration (the test duration scaled by the extra-time percentage, plus the pause allowance, ADR 0002 S-3 and S-7) plus a 15-minute drain margin for uploads (*architect detail*). A slot is also refused if its window overlaps the daily maintenance wake or an outstanding ceiling stop (ADR 0017 4.3), or would take the booked instance-hours of the month above the configured limit. There is no global maximum on a slot's length (P-44): the slot length, the ceiling stop and the occupancy are calculated per invitation from that candidate's own deadline including extra time, and the window is the longest of them. **The recruiter sees the resulting slot length** (the gate opening, the end of the longest session, the ceiling stop and the instance-hours it takes) when booking, before confirming, so a long accommodation is visible. A refused slot returns a clear error that names the reason, and the recruiter picks another. The stop schedule uses the same per-session bound. **Defaults (env configuration in `apps/api`, shared by every organisation, DL-48; *values chosen by architect, owner to confirm, except the gate offset and the late start, which the owner confirmed (D-66)*):** the daily maintenance wake starts at 08:00 UTC and the period 08:00 to 09:00 UTC is reserved (the wake runs about 15 minutes but its unconditional stop is at 60 minutes, so no slot window may overlap it); the pause allowance used in occupancy and ceilings is 30 minutes (the ADR 0002 P-3 default of `maxProctorPauseMinutes`), and on the pilot a pause credit never exceeds it, so a deadline cannot pass its booked ceiling even if an organisation raises the setting; the drain margin is 15 minutes; the late-start allowance is 15 minutes and the gate offset is 30 minutes (FR-303). **Monthly instance-hours limit (C-66, the owner's decision):** a hard cap of 50 instance-hours a month (environment configuration, about the compute share of the roughly $12 monthly budget, C-49; ADR 0017 section 10): a slot that would take the month above 50 is refused. An alert reaches the owner when the booked or used hours of the month reach 30 (an environment-configured alert threshold). A slot's hours are counted from the instance start (15 minutes before the gate opens) to the window end `ends_at` (the longest accommodated session plus the analysis allowance, not the ceiling stop), once for the pair of instances, overlapping windows once as a union; the daily wake counts 15 minutes for each day of the month; the month is the UTC calendar month of the instance start, and windows in the status SCHEDULED or DONE count (*values chosen by architect, owner to confirm*).
- **FR-307** Staff schedule view and review windows (C-43). Recruiters and reviewers see the schedule: slots, their windows and capacity, the daily maintenance window and the review windows. Slots of other organisations appear only as anonymous busy capacity, never their tests, candidates or counts. A reviewer can request a review window for a time when the instances are running or for a later slot; the request is created while the app runs and the app schedules the start and the ceiling as for a slot (ADR 0017 4.1). Staff can use the app only while the instances run (ADR 0017 4.6); the schedule view says when the next window opens, and shows each window's length, its ceiling stop and the instance-hours it takes (including any long accommodation, FR-306). Review windows and the ceiling times are stored in the new table `scheduled_windows` (ADR 0017 section 4.7, an ADR 0008 delta approved with ADR 0017, C-53), which `database.md` does not have yet; the monthly instance-hours are derived from the stored windows.

### M4 Candidate Portal

- **FR-401** Landing page shows the rules, what is recorded and the retention period. After the candidate passes the email OTP, the candidate must sign a consent document before every test session; a signature is never reused across sessions or tests (updated 2026-10-01, D-17). **Separate biometric consent (C-39, S1; ADR 0013 amendment, Proposed).** Where face processing applies to the session (the ID face match and the in-test face analysis, C-36), the consent step has a separate, required, not pre-ticked tick box for explicit consent to biometric processing, beside the signature; the Sign action stays disabled until it is ticked. The page also offers "I do not consent to biometric processing", which does not decline the test: it shows the recruiter's contact so the candidate can ask for the no-face-match path (a right, FR-305). Where the identity waiver or the refusal is already set, the biometric box is not shown (there is nothing to consent to). The ticked box is recorded with the signature (`consents.biometric_consent_at`, server time).
  - The document is 2-3 pages, versioned and stored. It covers what is recorded (screen, webcam, microphone, keystrokes), the ID image and selfie, face matching, automated detection and human review, how results are used in hiring, retention and deletion, who can access the data, appeals, accommodations and how to withdraw.
  - The candidate scrolls to the end and signs by typing their full legal name. The server records the date and time.
  - Stored per session: document version, signed name, signed timestamp, IP, user agent, and a generated PDF of the signed document in object storage. The candidate is emailed a copy.
  - Declining ends the session without any recording and shows a contact for alternatives or accommodations.
  - No device access or recording starts before the document is signed.
  - Until Legal supplies and approves the text, it is a clearly marked placeholder, and pilot and production refuse it.
- **FR-402** System check: browser (Chromium required for STANDARD and STRICT), camera, microphone, screen-share support, network speed, single monitor. A candidate who cannot use the microphone is never blocked at this step: the recruiter turns off the audio detectors for that candidate (FR-305) and the check then reports the microphone as not required (P-44, OQ-A11Y-3). Whether audio is still recorded when a microphone exists follows ADR 0015 section 3, and the consent text matches. The system check runs after the consent document is signed (ADR 0002: CONSENTED to VERIFIED), so a candidate on an unsupported browser can still read the consent in their own browser and gets the browser message at this step (A11Y OQ-A11Y-12).
- **FR-403** Identity check: photo of government ID and a live selfie with liveness prompt (turn head, blink); face match score stored; ID image never used for other purposes. A failed or low-confidence match gets one retry and then goes to manual reviewer comparison; it never rejects the candidate or blocks the test (D-05, ADR 0004). Camera alternatives (P-44, OQ-A11Y-1). The ID photo may be uploaded from a photo the candidate took with their own device when the recruiter has enabled that allowance for the candidate. The image source (captured or uploaded) is recorded and shown to the reviewer as evidence, the file is re-encoded with its EXIF and location data removed, type and size are limited, and an upload from a phone link uses a scoped single-use token like FR-405. A candidate who cannot do a camera step (the ID photo, the liveness prompts or the 360-degree room scan) asks the recruiter through the contact in the invitation email, not from the invitation page (before the slot the page shows nothing, FR-303 and FR-407), for the identity-check waiver (ADR 0015) or an alternative room-scan path that the recruiter and reviewer check by another route (C-02); the reviewer sees "room scan replaced" and the change is audited. Nothing is rejected automatically. The room-scan alternative changes the room scan that ADR 0015 section 3 keeps running under the waiver, so it needs the ADR amendment named in FR-305. **Withdrawing biometric consent (C-38; ADR 0015 10.3, Proposed).** The candidate can use an explicit "withdraw biometric consent" action at any time while their session token is valid; after that, a Super Admin does it on the candidate's request. It deletes the ID image, selfie and re-check frames (the same day as the target, within 30 days at the latest), nulls the derived match values, turns the identity check into a video check recorded by the recruiter, and switches the face detectors off for that session and for the candidate's later invitations. The right overrides the loss of evidence of a mismatch; the reviewer sees that consent was withdrawn and whether this happened after the identity check ran.
- **FR-404** Room scan: candidate rotates the camera 360 degrees and shows the desk surface; stored as a clip.
- **FR-405** STRICT profile: candidate opens a QR-code link on a phone that streams a side view of the desk.
- **FR-406** A practice question lets candidates try the editor before the timed test.
- **FR-407** Closed-instance page (C-46, ADR 0017 4.6). While the instances are off, the invitation link opens a static page on Cloudflare Pages that says: "The test is not available right now. Your invitation email has the time." The same page is shown for a valid, an expired, a used and an unknown link, so it gives no signal that a slot or invitation exists. The page holds no candidate data and stores nothing. It shows no time, which is an architect detail for privacy and to avoid an oracle (C-43 asked for "the test opens at <time>"; owner to confirm); the time is in the invitation email. The token travels in the URL fragment (`#...`), which browsers never send to a server, so it never reaches Cloudflare's logs (*detail chosen by architect, owner to confirm*; the invitation link format is checked in BE-06 and FE-05). The page polls only an unauthenticated health route, and sends the token to the API only after that route answers. The expired and used pages of ADR 0002 L-3 and L-4 appear only while the API is up.

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
- **FR-704** A scheduled job deletes recordings and ID images after the retention period (default 90 days, configurable). The period counts from the session's final outcome, and nothing is deleted while a review or appeal is open (ADR 0004). **Updated by ADR 0004 section 10 (Proposed, D-81):** everything that shows a face (ID image, selfie, re-check frames, webcam, room scan and second-camera recordings, evidence snapshots, thumbnails) is deleted 90 days from capture whatever any review or appeal says (C-37; the organisation may shorten it, never extend it); a candidate's erasure request deletes recordings and face data at once even while a review is open, and only results and reviewer notes wait, for at most 60 days (C-41); a Super Admin can place a legal hold that suspends every other deletion but never the 90 days (OQ-10); results are kept 1 year, or 4 years for a test marked as California-based (C-68).

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
| GET/POST/PATCH | /questions, /questions/:id | Author | CRUD and versions |
| POST | /questions/:id/validate | Author | Run reference solution on all tests and variants |
| GET/POST/PATCH | /tests, /tests/:id | Recruiter | Test templates |
| POST | /tests/:id/invitations | Recruiter | Single or bulk invite, with a slot (FR-303, FR-306) |
| GET | /schedule | Recruiter, Reviewer | Slots, windows, capacity and the next window (FR-307) |
| POST | /review-windows | Reviewer | Request a review window (FR-307) |
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
| NFR-02 | Capacity | 5 concurrent candidates on the pilot deployment (C-43; two scheduled instances, ADR 0017), proven by the load test on the real instances before the first candidate (C-49). 200 concurrent candidates is the production target |
| NFR-03 | Availability | 99.5% during the scheduled windows of the two-instance pilot (C-43, ADR 0017), measured from the start of a slot's window to its end. The means are the 45-minute early start, the health check and the owner alarm (C-49) |
| NFR-04 | Security | OWASP ASVS Level 2; TLS 1.2+; secrets in environment vault; rate limits on all public endpoints |
| NFR-05 | Privacy | Data minimization, encryption at rest, retention jobs, deletion on request within 30 days. Provisional (D-19, Legal to confirm): erasure waits while a review or appeal is open and runs as soon as it closes; the candidate is told. Proposed wording for Legal (D-27): erasure completes within 30 days of the request, or within 30 days after an open review or appeal closes, whichever is later; the candidate is told about any delay. The hold is configurable |
| NFR-06 | Accessibility | WCAG 2.1 AA on candidate and staff screens |
| NFR-07 | Browser support | Chrome and Edge (latest 2 versions) for STANDARD/STRICT; Firefox and Safari blocked with a clear message |
| NFR-08 | Resilience | A network drop of up to 60 s loses no code and no recording chunks |
| NFR-09 | Observability | Structured logs, error tracking, uptime alerts, per-session trace ID |
