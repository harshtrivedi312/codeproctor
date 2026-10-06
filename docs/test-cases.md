# Test cases

87 test cases cover every FSD module; the 64 marked P1 must pass before the pilot. Types: F = functional, S = security, I = integrity (anti-cheating), P = performance, A = accessibility, R = resilience.

Updated 2026-10-01 (ARC-01 Phase B, D-16..D-23). Changed: TC-007, TC-012, TC-030, TC-048, TC-094. Added: TC-095..TC-099, each marked "added 2026-10-01" and placed in its module table.

Updated 2026-10-06 (ADR 0017, C-43..C-48, C-49). Added: TC-101..TC-111, each marked "added 2026-10-06", in the section "Pilot deployment (ADR 0017)" at the end. They are architect-drafted from ADR 0017 sections 4 to 9 and 15; the owner accepts them with the ADR.

## Identity & access (M1)

| ID | FR | Scenario | Steps | Expected result | Type | Priority |
| --- | --- | --- | --- | --- | --- | --- |
| TC-001 | FR-101 | Valid staff login | Enter correct email and password | 2FA prompt (if enabled) or dashboard | F | P1 |
| TC-002 | FR-101 | Lockout after failures | Enter wrong password 5 times | Account locked 15 min; 6th correct attempt refused; audit entry written | S | P1 |
| TC-003 | FR-102 | 2FA required for reviewer | Log in as reviewer without TOTP set up | Forced TOTP enrollment before any page loads | S | P1 |
| TC-004 | FR-103 | RBAC enforcement | Recruiter calls PATCH /questions/:id directly | 403; no change in DB | S | P1 |
| TC-005 | FR-104 | Refresh token reuse | Use a refresh token twice | Second use rejected; whole token family revoked | S | P1 |
| TC-006 | FR-105 | Audit on data access | Reviewer opens a session review | audit\_logs row with actor, entity, IP | F | P1 |
| TC-007 | FR-106 | Candidate OTP before the test starts | Open invite link (test not started), enter wrong OTP 5 times | Link blocked for 30 min; recruiter notified. (No block once the test is in progress: see TC-097.) | S | P2 |
| TC-008 | NFR-04 | Cross-org access | User from org A requests session from org B | 404 (no data leak) | S | P1 |
| TC-097 | FR-106 | Wrong OTP during a test (added 2026-10-01, D-21) | Start a test, close the browser, reopen the link on another browser, enter a wrong OTP 6 times | No 30-min block; each failure logs RESUME\_OTP\_FAILED and alerts the proctor on the live view; a retry inside the 30 s cooldown is refused with the wait time; the correct OTP then resumes the session; the server clock kept running | S | P2 |
| TC-098 | FR-107 | Staff password reset (added 2026-10-01, D-22) | Request a reset for a reviewer account and for an unknown email; use the link; use the same link again; use a link older than 30 min | Same response for both requests; the valid link sets a new password and revokes all refresh tokens; the second use and the expired link are refused; the next login still asks for TOTP; no token appears in logs | S | P1 |

## Question bank (M2)

| ID | FR | Scenario | Steps | Expected result | Type | Priority |
| --- | --- | --- | --- | --- | --- | --- |
| TC-010 | FR-201 | Create coding question | Fill all fields, save | Draft version 1 created | F | P1 |
| TC-011 | FR-202 | Hidden tests hidden | Candidate fetches question via API | Response has sample cases only; hidden inputs and outputs absent | S | P1 |
| TC-012 | FR-203 | Variant validation | Publish a question whose reference solution passes the default tests but fails one variant's own test data (for example a constant that only that variant changes) | Publish blocked; the validation report shows the failing variant and test | F | P1 |
| TC-013 | FR-204 | Versioning | Edit a published question used in a past session | New version created; past session still shows old version | F | P1 |
| TC-014 | FR-205 | MCQ question | Create MCQ, include in test, answer | Auto-scored correctly | F | P3 |
| TC-100 | FR-202, FR-301 | Staff/recruiter redaction (extends TC-011; DL-32, DL-34; added 2026-10-06) | A recruiter reads questions (list, filters, search, random pick, by-id GET, preview) including a draft-only question, a published question with a draft version 2, a cross-org id and a missing id | Published versions only, through the allowlisted DTO; list, filters, search and random picks never reveal draft-only questions (titles, tags, counts); hidden inputs and outputs, reference solutions, AI references, answer_spec, variant params and validation reports never; an identical 404 for a draft, missing or cross-org id | S | P1 |
| TC-099 | FR-205 | Short answer needing manual scoring (added 2026-10-01, D-23) | Short-answer question with an answer and one accepted variant; three candidates answer with the variant in different case and spacing, with the exact answer, and with an unlisted correct wording | First two auto-scored full points; the third is not scored 0 but marked for manual scoring; the session goes to the review queue; the verdict is blocked until a reviewer marks it; the reviewer's decision sets the score and is audited | F | P3 |

## Tests & invitations (M3)

| ID | FR | Scenario | Steps | Expected result | Type | Priority |
| --- | --- | --- | --- | --- | --- | --- |
| TC-020 | FR-301 | Random pick rule | Test with 2 random MEDIUM questions tagged arrays; start 10 sessions | Each session gets 2 matching questions; distribution varies | F | P1 |
| TC-021 | FR-303 | Single-use link | Complete a test, reopen link with the API up (with the instances off, see TC-107) | "Already used" page; no new session | S | P1 |
| TC-022 | FR-303 | Window enforcement | Open link after window\_end with the API up; separately let window\_end pass while the instances are off, then start them | "Expired" page; status EXPIRED (set on opening the link, or by the expiry job at the next start) | F | P1 |
| TC-023 | FR-304 | Bulk CSV invite | Upload a CSV of 10 rows: 7 valid rows in two slots (4 candidates and 3 candidates, each within the capacity of 5) and 3 rows with invalid emails; then upload a row that would make one slot hold 6 | 7 invitations sent; the error report lists the 3 invalid rows, and the row that would make 6 with its reason (FR-306) | F | P2 |
| TC-024 | FR-305 | Extra time accommodation | Invite with +50% time on 60-min test | Server deadline is 90 min after start | F | P1 |

## Candidate portal (M4)

| ID | FR | Scenario | Steps | Expected result | Type | Priority |
| --- | --- | --- | --- | --- | --- | --- |
| TC-030 | FR-401 | No recording before consent | Open link, pass OTP, inspect network and devices while the consent document is shown and before signing it | No camera, microphone or screen access requested; no uploads; no event batches | S | P1 |
| TC-095 | FR-401 | Sign the consent document (added 2026-10-01, D-17) | Pass OTP; try to sign before scrolling to the end; scroll to the end, type the full legal name, sign | Sign is disabled until the end is reached; the consents row stores the document version, signed name, server timestamp (not the client's), IP and user agent; status CONSENTED; a PDF of the signed document is stored in object storage; the candidate receives an email with a copy; a new session for the same candidate asks for a new signature | F | P1 |
| TC-096 | FR-401 | Decline the consent document (added 2026-10-01, D-17) | Pass OTP, open the consent document, choose Decline; then reopen the invite link | Status DECLINED; no camera, microphone or screen access requested and no uploads, before or after declining; the contact for alternatives or accommodations is shown; reopening the link shows the declined page and starts nothing | S | P1 |
| TC-031 | FR-402 | Unsupported browser | Open link in Firefox for STANDARD test | Clear block message with supported browsers | F | P1 |
| TC-032 | FR-402 | Camera denied | Deny camera permission | Cannot proceed; help text shown | F | P1 |
| TC-033 | FR-403 | Face match fails | Use ID photo of another person | Match below threshold; retry once, then flagged for manual approval | I | P1 |
| TC-034 | FR-403 | Liveness spoof | Hold a printed photo to the webcam | Liveness check fails | I | P2 |
| TC-035 | FR-404 | Room scan required | Skip room scan | Start button disabled | F | P2 |
| TC-036 | FR-405 | Second camera (STRICT) | Scan QR on phone, then close phone page mid-test | SIDE\_CAMERA disconnect event (HIGH); test pauses | I | P2 |

## Coding environment (M5)

| ID | FR | Scenario | Steps | Expected result | Type | Priority |
| --- | --- | --- | --- | --- | --- | --- |
| TC-040 | FR-502 | Run sample tests | Write correct solution, click Run | Sample results shown in under 5 s | F | P1 |
| TC-041 | FR-502 | Run rate limit | Click Run 3 times within 2 s | Only first executes; message shown | F | P2 |
| TC-042 | FR-503 | Sandbox: network | Submit code that opens a socket to the internet | Fails; no outbound traffic from Judge0 | S | P1 |
| TC-043 | FR-503 | Sandbox: infinite loop | Submit while(true) | Time limit exceeded; runner healthy | S | P1 |
| TC-044 | FR-503 | Sandbox: fork bomb / memory | Submit fork bomb and large allocation | Killed by limits; no impact on other sessions | S | P1 |
| TC-045 | FR-504 | Autosave | Type, wait 10 s, close browser, reopen link | Code restored within 10 s of last edit | R | P1 |
| TC-046 | FR-505 | Auto-submit at time zero | Let timer expire | Latest code submitted and graded; status SUBMITTED | F | P1 |
| TC-047 | FR-505 | Client clock tampering | Change OS clock forward 1 hour | Server deadline unchanged | S | P1 |
| TC-048 | FR-506 | Weighted scoring | On a 100-point question with hidden test weights 1, 1, 2, 2, 4, pass the tests weighted 1, 2 and 4 | Question score 70.00 (100 × 7 ÷ 10); session total includes it | F | P1 |

## Proctoring client (M6)

| ID | FR | Scenario | Steps | Expected result | Type | Priority |
| --- | --- | --- | --- | --- | --- | --- |
| TC-050 | FR-601 | Fullscreen exit | Press Esc during test | Editor locked, overlay shown; FULLSCREEN\_EXIT logged immediately; duration filled on restore or at session end (ADR 0013 §5.9) | I | P1 |
| TC-051 | FR-602 | Tab switch | Alt+Tab to another window for 8 s | TAB\_SWITCH/FOCUS\_LOST with \~8 s duration | I | P1 |
| TC-052 | FR-603 | Paste blocked | Copy code from outside, Ctrl+V into editor | Nothing pasted; PASTE\_ATTEMPT logged | I | P1 |
| TC-053 | FR-603 | Drag-and-drop text | Drag text from another window into editor | Blocked and logged | I | P2 |
| TC-054 | FR-604 | Window-only share | Choose "window" instead of "entire screen" | Rejected; asked to share entire screen | I | P1 |
| TC-055 | FR-604 | Stop sharing mid-test | Click browser "Stop sharing" | Test paused; SCREEN\_SHARE\_STOPPED (HIGH) | I | P1 |
| TC-056 | FR-605 | Second monitor | Connect second monitor before start | Start blocked with instructions | I | P1 |
| TC-057 | FR-606 | No face | Leave camera view for 10 s | NO\_FACE event after 5 s | I | P1 |
| TC-058 | FR-606 | Second person | Second person enters frame | MULTIPLE\_FACES (HIGH) with snapshot | I | P1 |
| TC-059 | FR-606 | Phone in view | Hold phone up to camera | PHONE\_DETECTED with snapshot | I | P1 |
| TC-060 | FR-606 | Gaze away | Look at a spot off-screen for 7 s | GAZE\_AWAY logged | I | P2 |
| TC-061 | FR-607 | Second voice | Another person speaks for 10 s | MULTIPLE\_VOICES or SPEECH\_DETECTED logged | I | P2 |
| TC-062 | FR-608 | Keystroke replay | Type a solution, open replay in review | Replay reproduces final code exactly | F | P1 |
| TC-063 | FR-609 | Network drop | Disable network 45 s, re-enable | DISCONNECTED/RECONNECTED; no code or chunks lost | R | P1 |
| TC-064 | FR-610 | Virtual camera | Use OBS virtual camera as webcam | VIRTUAL\_CAMERA logged | I | P2 |
| TC-065 | Security | Forged events | Replay a captured event batch with modified payload | Rejected: HMAC mismatch | S | P1 |

## Media, integrity, review (M7–M10)

| ID | FR | Scenario | Steps | Expected result | Type | Priority |
| --- | --- | --- | --- | --- | --- | --- |
| TC-070 | FR-701 | Chunked upload | 30-min session | All streams present, no gaps over 10 s | F | P1 |
| TC-071 | FR-703 | Signed playback URL | Copy playback URL, open after 20 min | Access denied | S | P1 |
| TC-072 | FR-704 | Retention deletion | Set retention 7 days, advance clock | Objects deleted from object storage, keys nulled, audit logged | F | P1 |
| TC-073 | FR-802 | Paste burst via typing tool | Auto-type 300 chars in 0.5 s (xdotool) | PASTE\_BURST event | I | P1 |
| TC-074 | FR-803 | Identical submissions | Two candidates submit identical code | CODE\_SIMILARITY on both | I | P2 |
| TC-075 | FR-804 | Risk banding | Session with 2 HIGH + 3 MEDIUM events | Score and band match configured weights | F | P1 |
| TC-076 | FR-805 | Review routing | Session scores MEDIUM | Appears in review queue | F | P1 |
| TC-077 | FR-901 | Synced review | Click a flag in timeline | Video seeks to that time on all streams | F | P2 |
| TC-078 | FR-902 | Verdict required | Try to complete review with undecided HIGH flags | Blocked until each is decided | F | P2 |
| TC-079 | FR-903 | Live pause | Proctor pauses a live session | Candidate sees pause overlay within 2 s; timer paused | F | P2 |
| TC-080 | FR-904 | Appeal routing | Candidate appeals a VIOLATION | Assigned to a different reviewer | F | P3 |
| TC-081 | FR-1003 | Webhook | Complete a session | session.completed webhook delivered, signed | F | P3 |

## Non-functional

| ID | NFR | Scenario | Steps | Expected result | Type | Priority |
| --- | --- | --- | --- | --- | --- | --- |
| TC-090 | NFR-02 | Load | k6: 200 simulated candidates, events + heartbeats + runs | API p95 under 300 ms; no errors | P | P1 |
| TC-091 | NFR-01 | Code execution latency | 50 concurrent runs | p95 under 5 s | P | P2 |
| TC-092 | NFR-06 | Accessibility | axe + screen reader on candidate flow | No WCAG 2.1 AA violations | A | P1 |
| TC-093 | NFR-04 | OWASP scan | OWASP ZAP baseline against staging | No high findings | S | P1 |
| TC-094 | NFR-05 | Deletion on request | Admin deletes a candidate: once with no open review or appeal, once while an appeal is open, then close the appeal | No open review or appeal: all personal data, media, consent PDF, code and answers removed within 30 days, only anonymized scores kept, audit logged. Open appeal: erasure waits and the candidate is told; it runs as soon as the appeal closes (D-19, provisional, Legal to confirm) | S | P2 |

## Pilot deployment (ADR 0017)

| ID | FR | Scenario | Steps | Expected result | Type | Priority |
| --- | --- | --- | --- | --- | --- | --- |
| TC-101 | NFR-04 | OIDC role isolation (added 2026-10-06, ADR 0017 sections 6 and 7) | Offline: parse the trust and permission policy JSON of `codeproctor-pilot-deploy`. Owner-run: assume the role from this repository's `pilot` environment, from another repository, from another branch and from another environment; run the IAM policy simulator for the actions CI must not have, including a write outside the two manifest prefixes | The trust allows only this repository's `environment:pilot`; the permissions allow only the registry push and `s3:PutObject` on the two manifest prefixes (main and Judge0) only; a write outside them is denied; every other assume and every other action (data buckets, KMS, `ec2:*`, `scheduler:*`, `iam:*`, SSM, Route 53) is denied; no long-lived access key or user exists | S | P1 |
| TC-102 | NFR-03 | Start and stop around a slot (added 2026-10-06, ADR 0017 4.1, 4.2) | On the provisioned pilot: create a slot; observe the start 45 minutes before; observe the health probe 5 minutes before the gate opens, covering both instances; leave the queues empty and no staff traffic through the warm-up and the gate opening; run sessions; end them. Repeat with an active session, a pending upload, an unfinished close sweep, a waiting or active job, a delayed job due within 30 minutes, a delayed job due later, and a recruiter working in a staff window. From the internet, request the loopback check route through Caddy | Both instances start and the stack is healthy at the probe. The host does not stop itself before the gate opens (the 45-minute lead). After the window the main host stops itself only when all of ADR 0017 4.2 hold continuously for 10 minutes: no session active, no upload unconfirmed, the close sweep done, no waiting or active job and no delayed job due within 30 minutes, no recent staff request, and the shutdown sequence (dump, WAL, Redis save) finished; a delayed job due later does not block it; each blocking case keeps it up. The loopback route is denied through Caddy. A session is never cut off. The Judge0 host stops after the main host stops pinging it | R | P1 |
| TC-103 | NFR-05 | Restore drill from S3 (added 2026-10-06, ADR 0017 5.3, 5.4) | Owner-run on a throwaway AWS instance (never a developer machine): restore the latest base backup and WAL to a point-in-time target, then the latest dump; run the migration check and a read-only smoke test; re-apply the erasure list; destroy the instance. Also run the same restore after the 14-day lifecycle has run | The restore works from the S3 archive alone within the agreed time and reaches the point-in-time target; `verify-schema` passes; row counts and checksums match; the backup tool's repository metadata survived the 14-day lifecycle and the no-overwrite policy; an erased candidate does not reappear; backups older than 14 days are gone; the drill record holds no real credentials and no login was needed | R | P1 |
| TC-104 | NFR-05 | Daily maintenance wake (added 2026-10-06, ADR 0017 4.5, C-47) | Let the daily wake run, including the weekly day; then block it (disable the schedule) for one day | The instance starts at the scheduled time; retention, erasure, reminders and, on its weekly day, the base backup run to completion (audit rows written, the "maintenance complete" log line); it stops by itself after about 15 minutes, never beyond the 60-minute ceiling. With the schedule blocked, the owner alarm fires within 30 minutes of the missed start | R | P2 |
| TC-105 | NFR-02 | Pilot capacity: 5 concurrent candidates (added 2026-10-06, C-49 gate) | k6 with 5 simulated candidates (events, heartbeats, runs, submits, uploads, in-test face re-checks) on the real m7i.large (api, worker, Postgres, Redis) plus the small Judge0 instance, with the live face match at the start and the post-session analysis in the same window | API p95 under 300 ms, run result p95 under 5 s, no errors, no out-of-memory kill or container restart on either instance, the in-test face re-checks keep up, the analysis finishes before the ceiling | P | P1 |
| TC-106 | FR-306 | Slot rules (added 2026-10-06, ADR 0017 4.1, 4.3, 4.7) | Create slots until 5 candidates overlap, then a sixth; add an accommodated session whose extra time overlaps a following slot; a slot overlapping the daily wake; a slot overlapping the old ceiling of a cancelled slot; a window longer than the backstop maximum minus the margin; a slot that would exceed the monthly instance-hours limit; slots of organisation B while organisation A books. Read the schedule names | Each refused slot returns a clear reason; occupancy counts the longest accommodated duration plus pause and the 15-minute drain margin; another organisation's slots count toward capacity; accepted slots create the start and ceiling schedules; a rescheduled slot replaces its start schedules and its old ceiling is not overlapped; schedule names carry only a slot id, never a candidate, invitation or email | F | P1 |
| TC-107 | FR-407 | Closed-instance page (added 2026-10-06, ADR 0017 4.6, C-46) | Stop both instances; open a valid, an expired, a used and an unknown invitation link; also open a valid link while the instances are up but before `window_start`; inspect localStorage, sessionStorage, IndexedDB and cookies | The same static page for all of them: "The test is not available right now. Your invitation email has the time."; no candidate data, slot time or existence signal; no OTP is sent before `window_start`; the page stores nothing client-side; the token stays in the URL fragment and no request carries it before the health route answers; the normal flow starts when the API answers after `window_start`. (Manual step, not e2e: the token is absent from the Pages request logs.) | S | P1 |
| TC-108 | NFR-03 | Hard ceiling cannot be cancelled or bypassed by the host (added 2026-10-06, ADR 0017 4.1, 4.3) | With the app role, try to delete or update a ceiling schedule; call `ec2:StartInstances` and `ec2:StopInstances` directly; use the start-only role from the ceiling group; pass any role other than the three scheduler roles; delete or overwrite an object in the backups bucket. Leave a window running past its ceiling; leave an instance running past the 6-hour backstop. Stop a window by the ceiling | Each attempt is denied (including the `aws:SourceArn` and `iam:PassedToService` conditions); the ceiling stop fires and both instances stop with an alert; the backstop stops an over-long run and emails the owner; after a ceiling stop the database is restorable (dump uploaded, WAL archived and Redis saved within `stop_grace_period`) | S | P1 |
| TC-109 | NFR-04 | Judge0 instance isolation (added 2026-10-06, C-45, ADR 0017 9) | From the Judge0 instance and from a sandboxed run, try to reach Postgres, Redis, the media and backup buckets, IMDS credentials and the main instance's other ports; search the Judge0 host for the CA private key; from the Judge0 instance connect to the main instance | Every attempt fails; the Judge0 instance has a minimal role with only its own three secrets, its manifest prefix and image pull (an IAM policy simulation), IMDS is unreachable from sandboxed runs, and it holds no app secret and no CA private key; only the `judge0-tls` port from the main instance is reachable; the main instance's security group allows no inbound from the Judge0 instance | S | P1 |
| TC-110 | NFR-04 | Signed release at boot (added 2026-10-06, ADR 0017 6) | Start the main instance and the Judge0 instance with an unsigned manifest, a manifest from another workflow or branch, an older signed manifest (lower sequence number), and a valid new one; roll back by publishing the previous release as a new manifest; start with no good release and no network to the signing service | The first three are refused: the host keeps the last good release and alerts the owner (with none, it stays down); the valid one is pulled by digest and started; the rollback with a higher sequence number is applied; verification works offline from the bundle; the Judge0 host verifies its own manifest the same way; the pre-migration dump exists when the manifest carries migrations | S | P1 |
| TC-111 | FR-307 | Schedule view and review windows (added 2026-10-06, ADR 0017 4.1) | As a recruiter and a reviewer of organisation A, open the schedule while organisation B has slots; as a reviewer request a review window while the instances run and for a later slot | Organisation B's slots appear only as anonymous busy capacity (no tests, candidates or counts; cross-organisation reads also belong to TC-008); the schedule shows the next window; the review window creates its start and ceiling schedules; a window that breaks the rules of TC-106 is refused with its reason | F | P2 |
| TC-112 | NFR-04 | API DNS reset on stop (added 2026-10-06, ADR 0017 section 8) | Stop the main instance by self-stop, by the ceiling and by killing it (crash); read the `api` record each time; inspect the CAA record on `api`; with the instance role, try to change any other record, a record of another type, a CNAME, and any record in another hosted zone | After each kind of stop the `api` A record is 192.0.2.1 (the state-change rule, not a host script); the CAA record on `api` allows only Let's Encrypt for Caddy's account; the instance role can only UPSERT the `api` A record in the assess zone, and every other change, every other zone and `GetChange` handling behave as ADR 0017 section 8 says | S | P1 |
| TC-113 | NFR-04 | Session Manager restricted (added 2026-10-06, ADR 0017 section 3, C-50) | As the owner role, start a shell session; try a port-forwarding session and an SSH session; as the instance roles, CI and the app, try `ssm:StartSession` and `ssm:SendCommand`; end a session and read the log and the alert | Only the owner role (with MFA, a short session) can start a session, and only on the shell document; port forwarding and SSH are denied; no other principal can start a session or send a command; the `StartSession` alert emails the owner; the session is logged to the log group and to CloudTrail | S | P1 |
| TC-114 | NFR-04 | Main-instance IMDS isolation (added 2026-10-06, ADR 0017 section 3) | From the `worker`, `caddy`, `postgres` and `redis` containers, request the instance role credentials from the metadata address; repeat from `api` and from a host process | Only `api` and host processes get credentials; the other containers cannot reach the metadata address (the `DOCKER-USER` rule matches `api`'s fixed address on its own egress network, not a whole bridge) | S | P1 |
