# Red-team plan (QA-02)

Owner: qa-engineer (QA B session). Written 2026-10-05, before DEP-01. This is the plan; the results go in /docs/red-team-report.md when the attacks run (QA-02 deliverable). Covers FR-601 to FR-610, FR-801 to FR-805, NFR-04, TC-036, TC-053, TC-054, TC-056, TC-064, TC-065, TC-008, TC-011, TC-047, TC-071, plus the new compliance rules C-02, C-19, C-25, C-28, C-34.

Sources: docs/prompts/agents-qa-deploy.md (QA 2), docs/build-plan.md (QA-02), docs/fsd.md (M6, M7, M8, section 4), ADR 0013 (transport, keys, section 5.10 candidate scope), ADR 0005 (event taxonomy), ADR 0002 (session lifecycle), ADR 0015 (waived identity check, proposed), docs/compliance/decisions.md.

## 1. Purpose and the question each attack answers

Act as a candidate (or an outsider with a candidate link) who wants to cheat, or to read someone else's data. For each attempt the report records: method, detected (yes or no), event produced (or server answer), and a proposed fix. An undetected method becomes an issue for the architect to triage (QA-02 done-when).

The design says what is allowed to be undetected. ADR 0013 states that the HMAC key protects against forgery by anyone without the key, but not against the candidate's own browser: a modified SDK can sign anything, suppress events or fake timestamps, and "server re-checks and human review compensate". So the plan separates three outcomes:

| Outcome | Meaning |
| --- | --- |
| Blocked | The server or client refused it (4xx, locked editor, start refused) and, where the docs say so, logged it. |
| Detected | Allowed, but an event, a gap marker or a review flag lets a human see it (C-28: every session is reviewed by a person). |
| Undetected | Neither. Reported with severity: High if it lets a candidate cheat undetected with common tools, or read or change another person's data (security finding, a blocker under CLAUDE.md rule 3); Medium if it needs skill or hardware; Low if cosmetic. Accepted residual risks already written in an ADR are recorded as "known, ADR x" and not re-filed. |

## 2. Rules of engagement

1. Staging only, after DEP-01 exists (CLAUDE.md, task constraint). Never the pilot or production stack. Nothing runs before that; this file is a plan.
2. Synthetic data only: test organisations, test accounts, invitations created for mailboxes the tester controls. Faces are synthetic: licensed or generated footage played through OBS Virtual Camera or a fake-capture video file. Staging holds no real faces (CLAUDE.md, architecture.md:22, brd.md:87), and the volunteer consent form (D-18, C-11) covers face-match threshold tuning only, so it is not a basis for red-team faces. The tester's own face is used only with the owner's written approval, cited in the report (open owner decision, section 7 item 7). Test sessions, uploads and accounts are deleted from staging after each round. Never a real candidate's data.
3. The tester is not the author of the control under test.
4. Never record a token, OTP, HMAC key, signature, presigned URL or object key in the report, an issue, a screenshot or a chat. Record the route, the HTTP status, the problem `code`, the event type and the event id. Use placeholders such as `<token-A>`. If a real secret leaks into a note, treat it as an incident: rotate it and tell the Delivery Lead.
5. No database reset or schema command, no changes to staging infrastructure, no denial-of-service beyond the documented load test (TC-090). Rate-limit probing (RT-13, RT-14) stays under 10 times a limit and stops at the first 429.
6a. Testers act only through the public staging API and web origin, with tester-created accounts. They never use staging or pilot database or infrastructure credentials (ADR 0009).
6. No attack on staff accounts beyond what the scripts below name. Credential guessing is TC-002 and not repeated here.
7. Every attempt is run twice: once with an unmodified client (what a casual candidate can do) and, where the attack needs it, once with a modified client or direct API calls (what a motivated one can do).
8. Findings in authentication, authorization, session handling, cryptography or candidate data are reported to the Delivery Lead the same day as blockers (CLAUDE.md rule 3), not held for the final report.

## 3. Environment and tools

| Need | Detail |
| --- | --- |
| Staging build | the commit under test is written in every record; STANDARD and STRICT tests; one test with the identity waiver (ADR 0015) and one with "face detectors off" |
| Accounts | two organisations (A, B) each with recruiter and reviewer; at least four candidate sessions: A1, A2 in org A, B1 in org B, plus a spare |
| Browsers | Chrome and Edge current stable (NFR-07); Firefox for the unsupported-browser check |
| Tools | browser DevTools, a local intercepting proxy (mitmproxy or Burp Community), curl, Node 24 for a signing helper, OBS Studio with Virtual Camera, xdotool or AutoHotkey, a second monitor, a phone, a clean browser profile, one extension that reads or writes the clipboard |
| Signing helper | a small script that implements the ADR 0013 scheme (canonical JSON, HMAC-SHA256 hex over the exact body) with a key the tester exported from a controlled build (a local client build that is never deployed to staging; the exported key is deleted after use); used only to build the negative cases in RT-01 to RT-08 |
| Observation | the staff review page for the session in a second browser profile, the problem `code` of every API answer, the "Recording gaps" panel (ADR 0013 section 5.8) |

Recording template for every attempt (one row in /docs/red-team-report.md):

| Field | Content |
| --- | --- |
| ID | RT-nn from this plan |
| Date, build, browser, OS, tester | |
| Method | what was done, with placeholders instead of secrets |
| Outcome | Blocked, Detected or Undetected |
| Event or answer | event type and id, or HTTP status and problem `code` |
| Expected | from the plan |
| Result vs expected | Same or Different (a difference is a defect or a finding) |
| Proposed fix | owner agent and change; for Undetected, a severity |
| Issue | link |

## 4. Attack catalogue

RT-43, RT-44 and RT-67 are marked provisional: they rely on ADR 0015, which is still proposed.

Priority P1 runs first, then P2, then P3, as for the test cases. "TC" names the existing case that the attempt re-tries adversarially. Expected results come from the docs; where the docs are silent, the cell says "docs silent" and the result is a question for the architect, not a pass or fail.

### 4.1 Forged, replayed and suppressed events (FR-801, TC-065, ADR 0013 section 2)

| ID | Pri | Attack | Expected | TC |
| --- | --- | --- | --- | --- |
| RT-01 | P1 | Capture a signed event batch with the proxy; change one payload byte; resend with the old `X-Signature` | 403 `SIGNATURE_INVALID`; nothing stored; no event on the timeline | TC-065 |
| RT-02 | P1 | Resend the captured batch unchanged | 200 `duplicate: true`; no second row | TC-065 |
| RT-03 | P1 | Resend the same `seq` with a different body and a valid new signature | 409 `SEQ_CONFLICT`; stored batch unchanged | TC-065 |
| RT-04 | P1 | Send a batch with no `X-Signature`, a 63-character one, upper-case hex, and a signature from another session's key | 403 `SIGNATURE_INVALID` or 400, never 200; constant behaviour for all four | TC-065 |
| RT-05 | P1 | Send a batch signed with the A1 key using the token of session A2 (same org), then with the token of B1 | 403 or 401; no row in either session | TC-008, ADR 0013 5.10 |
| RT-06 | P1 | Replace a client-sent severity, `source: SERVER`, or an event type that only the server writes (PASTE_BURST, DISCONNECTED, FACE_MISMATCH) inside a correctly signed batch | Severity ignored (server assigns it); server-only types rejected with 400 `VALIDATION_FAILED`; no SERVER row from a candidate | ADR 0010, ADR 0013 CS-4 |
| RT-07 | P1 | Signed batch with `occurredAt` far in the past and in the future; `evidenceKey` naming another session's object, an unknown name and a used name | Timestamp clamped to the session window; evidence key dropped to NULL, batch succeeds; no other session's object is ever referenced | ADR 0013 5.2 |
| RT-08 | P2 | Oversized batch, one input at a time: events body of 257 KiB, keystrokes body of 2.1 MiB (limits 256 KiB and 2 MiB), `Content-Encoding: gzip`, `Content-Type: text/plain`, invalid UTF-8, 101 events | one expectation per input: events over 256 KiB 413; keystrokes over 2 MiB 413; gzip 415; `text/plain` 415; invalid UTF-8 400; 101 events 400; the server never buffers beyond the limit (watch memory in staging metrics) | ADR 0013 5.2 |
| RT-09 | P1 | Key extraction: from the page (DevTools, a console script on the candidate origin, an extension) try to read the batch key: `crypto.subtle.exportKey`, the IndexedDB `{sessionId}:hmacKey` entry, memory | The key is a non-extractable `CryptoKey`; `exportKey` throws; IndexedDB holds only the object. Record that code running in the page can still sign through the live key (known, ADR 0013 "does not protect against XSS": the CSP is the control) | ADR 0013 section 2 |
| RT-10 | P1 | Fetch the key a second time in the same epoch with the same token (`POST /candidate/session/proctor-key`) | 409 `KEY_ALREADY_ISSUED`; no key in the answer; limit 5 per minute respected | ADR 0013 section 4 |
| RT-11 | P1 | Take over the session from a second browser profile (pass the OTP again) while the first keeps sending | Old token gets 401 `SESSION_TAKEN_OVER`; the old device purges; new key issued once for the new epoch; the takeover is visible to the reviewer and the proctor | TC-097, ADR 0002 |
| RT-12 | P2 | Suppress events: drop every `POST .../events` at the proxy for 5 minutes, then release; and drop them permanently | Heartbeat continues, so no DISCONNECTED; the missing `seq` range shows as a hole in the review panel (ADR 0013 5.8); a permanent block is Detected through the hole and the missing events. Record whether the reviewer's summary view (C-28) makes the hole visible | ADR 0013 section 2 table |
| RT-13 | P3 | Exceed the per-session limits (events 120 a minute, keystrokes 240 a minute, heartbeat 12, key 5, presign 60 per stream), by at most 10 times, stopping at the first 429 | 429 with `Retry-After`; the limit is per session, not per IP (a test centre shares an IP); other sessions are not slowed | ADR 0013 5.1 |
| RT-14 | P3 | Send batches after submit: inside the 300 s grace, after it, and after erasure | Accepted inside the grace; 409 `SESSION_NOT_ACTIVE` after; 401 after erasure | ADR 0013 section 2 |

### 4.2 Disabling or tampering with the detectors (FR-601 to FR-610, SDK tampering)

| ID | Pri | Attack | Expected | TC |
| --- | --- | --- | --- | --- |
| RT-20 | P1 | Block the model files (`/models/proctor/*`) at the proxy before the test starts, then mid-test | `DETECTOR_UNAVAILABLE` (MEDIUM) logged, or the start is refused; docs for a mid-test block are silent: record what happens | ADR 0005, ADR 0013 licence and models |
| RT-21 | P1 | Replace the served SDK bundle with a modified one that never sends events (proxy rewrite); and one that sends only heartbeats | Heartbeat still arrives; no events and no recording chunks arrive; the gap appears in the review (events hole, "Recording gaps"); the reviewer sees an empty timeline for a long session. Undetected if nothing distinguishes this from a genuinely clean session: report as High and propose a server-side minimum (for example an expected event or chunk rate per active minute) | FR-609, ADR 0013 5.5 |
| RT-22 | P1 | In the console, stub `document.hasFocus`, `visibilityState`, `fullscreenElement` and the `blur`, `visibilitychange` and `fullscreenchange` listeners (override `addEventListener`), then switch tabs and leave fullscreen | Note which signals the SDK reads independently; at least the server-side pause state and `FULLSCREEN_EXIT` path must still trigger, or the miss is a finding. Docs: browser signals cannot be proven by the server (ADR 0013 section 2) | TC-050, TC-051 |
| RT-23 | P1 | Disable the paste handlers: remove listeners through DevTools, use an extension that writes into the Monaco model, drag-drop, middle-click paste on Linux, the context-menu paste and the browser's accessibility dictation | Blocked and logged where the SDK sees it (PASTE_ATTEMPT, DROP_ATTEMPT, SHORTCUT_BLOCKED); when text still lands in the editor, the keystroke analysis must show it as PASTE_BURST (server) | TC-052, TC-053, TC-073 |
| RT-24 | P1 | Auto-typing: xdotool or AutoHotkey typing a 300-character solution at 600 characters per second, at 50 per second, and with random 20 to 80 ms delays | The fast case gives PASTE_BURST (over 80 characters in under 1 s, FR-802); the slow and humanised cases: docs say typing-speed outliers and idle-then-complete patterns are computed (FR-802); record what fires. A humanised typist that no analytic flags is a Medium finding for the architect (docs set no threshold) | TC-073 |
| RT-25 | P1 | Extensions: install a clipboard manager, an AI side panel and a screen-capture extension, then use them during a test | `EXTENSION_INTERFERENCE` and DEVTOOLS_OPEN where "detectable" (FR-610); record which extensions are invisible. Docs expect best effort | FR-610 |
| RT-26 | P1 | DevTools: open with F12, Ctrl+Shift+I, detached window, undocked at a small size, the Network and Sources panels, a breakpoint on the SDK | `DEVTOOLS_OPEN` (heuristic) and shortcut blocking; record the detached and the undocked cases separately; the accepted limitation is a separate-window DevTools | FR-603, FR-610 |
| RT-27 | P1 | Second browser profile or incognito window open next to the test, used for searching; and a second device (phone, tablet) | Profile on the same screen: `FOCUS_LOST` or `TAB_SWITCH` when the test window loses focus; a phone or second device is not detectable by the browser: Detected only through gaze, `PHONE_DETECTED` and `GAZE_AWAY`, and for STRICT through the side camera. Record the miss rate for a phone placed below the camera | TC-051, TC-059, TC-060 |
| RT-28 | P1 | Remote desktop or virtual machine: run the browser inside a VM or a remote session while the helper runs on the host | The test is not blocked in the web client (FR-1102 is Phase 3, lockdown); record Undetected and propose it as an input to the Phase 3 decision. Check the `uaMismatch` note and any VM hint in the capabilities | FR-1102 |
| RT-29 | P2 | Tamper with the SDK's thresholds: set the no-face timer or gaze threshold in the page to a huge value; replace the detector callbacks with no-ops | A modified client can do this (ADR 0013: not protected); Detected only through the absence of any face event over a long session combined with the server-sourced identity re-check (FACE_MISMATCH every 2 minutes, C-08); record whether a reviewer can tell | FR-606 |
| RT-30 | P1 | Replay a pre-recorded video of a face into the webcam path: a virtual camera (OBS), a video file used as fake capture (`--use-file-for-fake-video-capture`), a phone pointed at a screen playing a loop | See RT-40 to RT-42 | TC-064, TC-034 |

### 4.3 Screen, fullscreen, monitors and virtual camera (FR-601, FR-604, FR-605, FR-610)

| ID | Pri | Attack | Expected | TC |
| --- | --- | --- | --- | --- |
| RT-31 | P1 | Share a window or a tab, then change to the entire screen after the check; share an entire screen of a second monitor while using the first for the test | Window or tab: rejected (`displaySurface` not monitor) and re-asked. Switching surfaces mid-test: `SCREEN_SHARE_STOPPED` with `WRONG_SURFACE`. Sharing the other monitor: docs silent for a sole second monitor; record. Check that the capability value is "unverifiable" on browsers that do not report the surface (ADR 0013 5.8) | TC-054, TC-055 |
| RT-32 | P1 | Disguise a window as a screen: use a browser window sized to fill the screen, a full-screen virtual desktop, or a screen-share of a virtual display | The picker reports a window; if the surface type is `monitor` for a virtual display, the share is accepted: record as Detected only by the recording content (a reviewer sees it) | TC-054 |
| RT-33 | P1 | Stop sharing at the browser bar, then re-share the same screen after 30 s; repeat 10 times quickly | Pause on stop, `SCREEN_SHARE_STOPPED` (HIGH); resume with `SCREEN_SHARE_RESUMED`; the pause budget is accounted for by the state machine; the test cannot be extended by repeated stops (compare the server deadline with the time spent; ADR 0002 says only a proctor pause stops the clock) | TC-055, TC-047 |
| RT-34 | P1 | Second monitor before start: connect in extended and in mirrored mode, connect after the system check but before Start, connect mid-test, connect with the Window Management API permission denied, and use a laptop lid closed with an external display | Start blocked with instructions (extended, FR-605); start refused again with 409 `SYSTEM_CHECK_BLOCKED` when the check is stale or blocked; mid-test: signed `MULTI_MONITOR` (HIGH); permission denied: docs say "where available": record Undetected for that case and the capability flag; mirrored mode: docs silent | TC-056 |
| RT-35 | P1 | Fullscreen escape: leave with Esc, F11, a window switch with Alt+Tab, Cmd+Tab, the Windows key, a second virtual desktop, and the browser's own fullscreen override | Editor locked, `FULLSCREEN_EXIT` logged at once, duration on restore (ADR 0013 5.9); every route produces the lock; none leaves the editor usable | TC-050 |
| RT-36 | P2 | Clock: change the OS clock forward and back by 1 hour and by 1 day, before the check and mid-test; change the browser time zone | Server deadline and the displayed countdown unchanged (the display may need a re-sync; follow-up FU-QA-01 in docs/followups/qa.md is open for the web client); `occurredAt` clamped; nothing the candidate sends moves the deadline | TC-047, FR-505 |

### 4.4 Cameras, voice and the room (FR-606, FR-607, FR-610, TC-064)

| ID | Pri | Attack | Expected | TC |
| --- | --- | --- | --- | --- |
| RT-40 | P1 | OBS Virtual Camera as the webcam, at the system check and switched in mid-test | `VIRTUAL_CAMERA` (HIGH) logged and, per FR-610 and ADR 0013 5.4, logged without blocking; the switch mid-test is detected by `devicechange` monitoring; record the device-name checks that fail (a renamed virtual device, a hardware capture card, a USB camera that is really a capture dongle) | TC-064 |
| RT-41 | P1 | Rename the virtual camera device (OBS, ManyCam, a macOS camera extension, a v4l2loopback device with a custom label) | Name-based detection misses a custom label: report as Undetected-by-name; check whether the frame content (static loop, no sensor noise) or the liveness check catches it. Docs expect best effort only | FR-610 |
| RT-42 | P1 | Photo or video of the ID owner at the selfie step: a printed photo, a phone playing a loop, a different person's ID with the tester's face (identity match), then the real person | Liveness fails for the first two (TC-034); a face that does not match goes to retry once, then manual review and is never auto-rejected; every session is reviewed by a person (C-28) | TC-033, TC-034 |
| RT-43 (provisional) | P1 | Identity waiver abuse (ADR 0015): as a candidate, try to reach the identity-check skip: call the identity routes when the waiver is off, send `identityCheckWaived` in a body, replay the waiver state from another invitation | The candidate cannot set or learn the waiver; the identity routes answer 409 `IDENTITY_CHECK_WAIVED` only when the recruiter set it; the server-only key is rejected from clients | C-19, C-25, C-34 |
| RT-44 (provisional) | P1 | "Face detectors off" or the waiver on one candidate: confirm the settings cannot be turned off by the candidate; and that, with them off, no face event or re-check is accepted (409 `DETECTOR_DISABLED` or `IDENTITY_CHECK_WAIVED`) | Settings come from the invitation only; the server refuses face data when they are set (C-34); the reviewer sees "identity check waived" or the re-check being off | C-25, C-34 |
| RT-45 | P2 | A second person: off-camera helper, whispering, a headset with a talk-back voice, a monitor-mounted second camera angle | `MULTIPLE_FACES` only when in frame; voice events only above the threshold; STRICT: side camera shows the desk; record the helper cases that are not detected | TC-058, TC-061 |
| RT-46 | P2 | Cover or point the webcam elsewhere, wear a hat or mask, change lighting to defeat the face model | `NO_FACE` after 5 s; `FACE_MISMATCH` goes to human review; no automatic rejection; false-negative rate recorded | TC-057 |
| RT-47 | P3 | Phone placement: below the desk, behind the monitor, a smartwatch, notes on a second paper sheet or a book | `PHONE_DETECTED` or `BOOK_DETECTED` when visible; gaze events; the rest are known residual risk | TC-059, TC-060 |

### 4.5 Uploads, recordings and evidence (FR-701, FR-702, TC-070, TC-071)

| ID | Pri | Attack | Expected | TC |
| --- | --- | --- | --- | --- |
| RT-50 | P1 | Block uploads to the storage host at the proxy or hosts file for the whole test, while keeping the API reachable | Chunks buffer in IndexedDB up to 200 MB, the SDK reports dropped chunks through the heartbeat; the server shows seq holes and missing trailing chunks in the "Recording gaps" panel; the reviewer sees a session with no recording. Undetected only if the gap is not visible or not flagged. Record whether the gap affects the risk band (owner question Q6: docs silent) | FR-702, ADR 0013 5.5 |
| RT-51 | P1 | Block only the webcam stream, only the screen stream, only audio; or stop the MediaRecorder from the console | The same gap evidence per stream; a stopped recorder is visible in the heartbeat `recorder` health and in the gaps | TC-070 |
| RT-52 | P1 | Overwrite a confirmed chunk: re-PUT to a presigned URL after confirm; PUT a larger object than declared; use a presigned URL after 60 s; use one stream's URL for another | Second PUT fails with 412 when `If-None-Match` is honoured (R2 support is unverified, ADR 0013); a larger object than declared: either the storage host answers 403 on the signed Content-Length, or confirm answers 422 and deletes the object (record which); confirm rejects wrong size or type with 422; expired URL refused; wrong-stream URL refused; the sweep removes the rest | ADR 0013 5.5 |
| RT-53 | P1 | Upload a chunk of another session's key prefix, ask for presign with `segment` or `seq` outside the limits, or a stream the state does not allow (ROOM_SCAN after start) | 400, 409 `SEQ_CONFLICT` or `SESSION_NOT_ACTIVE`; the key is built from the token, never from client input; no URL for another prefix | CS-3, ADR 0013 5.10 |
| RT-54 | P1 | Presign flood: request more than `ceil(duration/10 s) x 1.5 + 50` presigns for one stream | Refused at the per-session cap; the number of existing URLs is bounded | ADR 0013 5.5 |
| RT-55a | P1 | Playback URL for another org: as staff of org A, ask the API for a playback URL of an org B session or chunk | 404 from the API; no URL issued | TC-008 |
| RT-55b | P1 | Playback URL expiry and reuse: open a signed playback URL after 20 minutes (TC-071; the URL lives 15 minutes), and from another browser before expiry | Denied after expiry (TC-071). A URL leaked before expiry works from any browser until it expires: known, ADR 0013 (review GET URLs, 15 min) and FR-703; record, do not re-file | TC-071 |
| RT-56 | P2 | Evidence names: request an evidence presign for the purpose of another session, reuse a name after it is used, and fetch a sealed object by key | Names are single-purpose and single-use; sealed objects are never presigned | ADR 0013 5.6 |

### 4.6 Cross-organisation, cross-candidate and role access (NFR-04, TC-004, TC-008, TC-011)

| ID | Pri | Attack | Expected | TC |
| --- | --- | --- | --- | --- |
| RT-60 | P1 | With a candidate token of A1, send A2's `questionId`, `sessionQuestionId`, section, attempt, evidence and media identifiers to every `/candidate/*` route: read, run, draft, submit, presign, confirm, evidence, re-check, batches | 404, or success without touching A2's data; no presigned URL for A2's prefix (ADR 0013 5.10 test list; QA assigns the ID) | TC-008 sibling |
| RT-61 | P1 | The same with B1's token and A's identifiers (other organisation) | 404 everywhere; identical body and timing for "does not exist" and "belongs to another org" (no oracle) | TC-008 |
| RT-62 | P1 | Staff token on `/candidate/*` and candidate token on staff routes (`/review/*`, `/questions`, `/tests`) | 401 in both directions | ADR 0013 5.10 |
| RT-63 | P1 | Recruiter A calls reviewer routes, author routes, admin routes and `PATCH /questions/:id`; reviewer calls recruiter routes; author reads sessions | 403 with no change in the database; no `code` on role denials | TC-004 |
| RT-64 | P1 | Staff in org A request sessions, candidates, invitations, reports, exports and webhooks of org B by id, by list filter, by search and by CSV export | 404 or empty; the export contains only org A rows | TC-008 |
| RT-65 | P1 | Candidate asks for hidden test inputs and outputs: the question route, the run route error messages, the submit answer, timing differences, a submission that prints its inputs | Only sample cases returned; submit returns `{ accepted: true, submissionId }` and nothing else; hidden tests cannot be used as an oracle; the submit limits (one per 10 s, 20 per question) hold | TC-011, ADR 0013 5.11 |
| RT-66 | P1 | Results before review (C-28): ask for the report, score, verdict, export and webhook of a session in UNDER_REVIEW as recruiter, as candidate, and by guessing the report object key | No result before the verdict; webhook not sent early; the report key is not guessable and not presignable | C-28, FR-1001, FR-1003 |
| RT-67 (provisional) | P1 | Reviewer-only data: as recruiter, request the identity-waiver reason (if the reviewer should not see it, test the reverse), face images and evidence frames, and the demographic answers when FAIR-01 exists | Only the roles named in ADR 0015 / C-13 see them; individual demographic answers are visible to no staff role | C-13, C-19 |
| RT-68 | P1 | Candidate link abuse: reuse a used invite link, open one after `window_end`, enumerate invitation tokens, brute-force the OTP before the test (5 wrong) and during it (6 wrong), reuse an old OTP | Single use (TC-021); expired page (TC-022); 5 wrong OTPs block the link for 30 minutes before the test (TC-007); no block during the test, RESUME_OTP_FAILED logged, 30 s cooldown (TC-097); no oracle in the messages | TC-007, TC-021, TC-022, TC-097 |
| RT-69 | P1 | Consent bypass (C-30, TC-030, TC-095): call `/candidate/session/identity`, `/media/presign`, `/events` and `/start` directly with a token in OPENED (not yet signed) and after DECLINED; sign without the 18+ confirmation | 409 `SESSION_NOT_ACTIVE` or the state error; 400 for the missing confirmation; nothing recorded or uploaded before the signature | TC-030, TC-095, TC-096, C-30 |
| RT-70 | P2 | Erased session (R-6): use an old token, a captured playback URL and an old key after erasure | 401 for the token; playback denied; no data left except the consent proof (C-17) | TC-094 |
| RT-71 | P1 | Live proctor channel (Socket.IO): join another org's room and another session's room as staff; join a staff room with a candidate token; join with no token or an expired one; subscribe to events of a session after it is erased | Connection or join refused (no room data, no acknowledgement of whether the room exists); candidate token never accepted on the staff socket; no event from another org arrives | NFR-04, TC-008, ADR 0013 5.10 |
| RT-72 | P1 | XSS from candidate content into staff pages: put script and markup payloads in code, run output (stdout and stderr), uploaded filenames, event payload strings and free-text fields, then open the staff review page, the live proctor view and the report | Rendered as text; the CSP blocks inline script and a canary beacon never fires; no token reachable from the page. Compare with the ADR 0013 note that the CSP is the control | NFR-04, FR-104, ADR 0013 |
| RT-73 | P1 | Judge0 sandbox escape and side channels from submitted code: network egress to an AI API, an internal host and the cloud metadata address; read other submissions, test files or environment; hidden-test side channels (timing, exit code, output length, stderr) | No network from the sandbox; nothing of other submissions or hidden tests readable; limits (time, memory, processes) hold; no hidden-test oracle (see RT-65) | TC-011, FR-401 |
| RT-74 | P2 | SSRF through webhook endpoint registration: register URLs for internal IPs, loopback, link-local and the metadata address, DNS names that resolve to them, a redirect to one of them, and non-HTTPS schemes | Refused at registration and at delivery (resolved address checked, redirects not followed to internal ranges); no request leaves toward an internal host | FR-1003, NFR-04 |

## 5. Order of work

1. Round 1 (needs DEP-01 and BE-15A): 4.1 and 4.6 P1 (RT-01 to RT-11, RT-60 to RT-69, RT-71 to RT-73); these need only curl, the proxy and the signing helper.
2. Round 2 (needs FE-13 for the full flow): 4.2 and 4.3 P1 (RT-20 to RT-27, RT-31 to RT-35), 4.5 P1 (RT-50 to RT-55), RT-40 to RT-44.
3. Then all P2, then P3.
4. Daily: report blockers (security class) to the Delivery Lead; at the end of each round: the draft /docs/red-team-report.md goes to the architect for triage.

Manual scripts that overlap (TC-036, TC-054 to TC-056, TC-058 to TC-064) stay in /docs/manual-tests.md; this plan re-attempts them adversarially and does not repeat the steps.

## 6. Exit criteria (QA-02)

- Every row in section 4 has a recorded attempt (or a written reason it could not run, for example "needs Phase 3 lockdown").
- /docs/red-team-report.md lists method, outcome, event and proposed fix for each, and an issue exists for every Undetected row.
- The architect has triaged the Undetected methods (accepted residual risk, fix, or Phase 3).
- No open High or security finding. A cross-organisation or candidate-data leak found here blocks the pilot (CLAUDE.md rule 3).

## 7. Open questions for the architect (docs silent)

1. RT-21: should the server require a minimum number of events or chunks per active minute, so that a session with a silent SDK is flagged? Today a silent client is indistinguishable from a clean session except by the gap panel.
2. RT-12, RT-50: are recording gaps and event-sequence holes scored? ADR 0013 lists this as owner question Q6.
3. RT-24: no threshold is documented for a humanised typist (FR-802 names speed outliers and idle-then-complete patterns without numbers).
4. RT-34: mirrored monitors, and a denied Window Management permission: block or log?
5. RT-20: what happens when a model file is blocked after the test started.
6. RT-31: a share of only the second monitor.
7. Rule 2 (faces): may a tester use their own face on staging? Default is no (synthetic faces only). A yes needs the owner's written approval, cited in the report; until then RT-42 and RT-46 use generated footage only.
