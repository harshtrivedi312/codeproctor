# Prompts — Frontend (web app + proctor SDK)

Run these 14 prompts in order; the frontend track can start in parallel with Backend Step 2 by mocking the API from the OpenAPI spec. Steps 6–8 build the proctoring SDK, the core of the anti-cheating system.

## Before you start

- `CLAUDE.md` from the Database tab is in the repo root.
- Until the matching backend step is merged, generate a typed client from the API's OpenAPI spec and mock it with MSW (Mock Service Worker).
- Design direction: calm, clean, and trustworthy for candidates (who are nervous); dense and fast for reviewers.

## Step 1 — Web app foundation

```text
In apps/web set up Next.js (App Router, TypeScript strict) with Tailwind and shadcn/ui, a light and dark theme, and these route groups: (staff) for /admin/*, (candidate) for /t/[token]/*, and (public) for landing and errors.
Add: a typed API client generated from the API OpenAPI spec (openapi-typescript + openapi-fetch), TanStack Query, react-hook-form + zod (schemas imported from packages/shared), an error boundary, a toast system, and MSW mocks for local development.
Add a strict Content Security Policy via middleware (no inline scripts except Next nonces, connect-src limited to the API and the environment's object storage upload endpoint: Cloudflare R2 on staging, AWS S3 on pilot and production).
Verify: `pnpm --filter web build` passes; Lighthouse accessibility 95+ on the empty shell.
```

## Step 2 — Staff authentication screens

```text
Implement staff login per FR-101/FR-102: login form, 2FA enrollment (QR code + manual key + recovery codes download), 2FA verify, locked-account message, logout.
Password reset per FR-107 (D-22): "Forgot password" page that always shows the same confirmation whatever the email; reset page reached from the emailed link that sets a new password (strength rules shown), then sends the user to login, where TOTP is still required for roles that have it. The page exchanges the token once, sets Referrer-Policy: no-referrer, and never stores or logs the token. The same set-password page serves staff invites.
Keep the access token in memory only; refresh silently via the httpOnly cookie endpoint; on refresh failure redirect to login.
Add a useAuth hook exposing user and role, and a <RequireRole> component.
Playwright tests for TC-001, TC-002 (UI message), TC-003, TC-098 (UI).
```

## Step 3 — Staff shell and navigation

```text
Build the staff layout: sidebar (Dashboard, Questions, Tests, Candidates, Review queue, Live, Reports, Settings), top bar with org name and user menu, breadcrumbs. Items hidden by role using the shared permission matrix.
Settings pages for SUPER_ADMIN: users (invite, role, deactivate), retention days, erasure hold while a review or appeal is open (D-19, default on), risk weights and thresholds (FR-804), consent documents (list versions, add a new version, choose the current one; an unapproved text is shown as a placeholder and cannot be used where Legal approval is required, D-17), and the contact shown to candidates who decline consent. Candidate erasure action with its "waiting for review or appeal" state (D-19).
All tables use one DataTable component (sorting, filtering, pagination, empty and loading states).
```

## Step 4 — Question bank UI

```text
Implement FR-201 to FR-205 screens:
- Question list with filters (tag, difficulty, type, status) and search.
- Question editor with tabs: Statement (markdown editor with live preview; Mustache placeholders for variant params), Languages & starter code (Monaco per language), Reference solution, Test cases (editable table: input, expected output, hidden toggle, weight), Variants (params JSON editor with schema validation and rendered preview, plus per-variant input and expected output overrides for each test slot, with a "prefill from reference solution" helper the author must accept, ADR 0007), Answer (MCQ options and key; short-answer canonical answer and accepted variants, D-23), AI reference solutions (add, list and supersede solutions from two assistants for Python, JavaScript and Java; refresh-due badge; never used for grading, D-20), Limits.
- Validate button showing per-variant, per-test results from the API job; Publish enabled only after a passing validation (TC-012) and the AI reference solutions the publish gate requires.
- Version history with read-only view of older versions.
```

## Step 5 — Tests and invitations UI

```text
Implement FR-301 to FR-305 screens:
- Test builder: sections (drag to reorder; explain that sections run in order, each with its optional time limit, and cannot be reopened; limits may not exceed the total duration), add fixed questions or random rules (tag + difficulty + count), duration, proctoring profile selector (STANDARD or STRICT; no LOCKDOWN in this build) with a plain-language explanation of what each profile records, pass score.
- Invite dialog: single candidate or CSV upload with a row validation preview; window start/end; accommodations (extra time %, disabled detectors, allowed assistive tools, notes).
- Candidates page: per-candidate status timeline following the session state machine.
```

## Step 6 — Proctor SDK: browser lock and event pipeline

```text
In packages/proctor-sdk (framework-agnostic TypeScript) implement FR-601 to FR-605, FR-609 and FR-610:
- ProctorSession class: start(config), stop(), on(event), with detectors as plug-ins.
- Monitors: fullscreen (requestFullscreen + fullscreenchange), visibility and focus/blur with durations, paste/copy/cut/drop/contextmenu blocking inside a given root element, keyboard shortcut blocking where browsers allow (F12, Ctrl+Shift+I/J/C, Ctrl+U), devtools-open heuristic, multiple-screen check via window.getScreenDetails when available (fallback: screen.isExtended), virtual camera check by device label (OBS, ManyCam, etc.), screen share via getDisplayMedia requiring displaySurface === 'monitor' and watching the track's ended event.
- EventQueue: batches every 5 s or 100 events, signs with the session HMAC key using Web Crypto (HMAC-SHA256), includes a monotonic sequence, retries with backoff, persists unsent batches in IndexedDB.
- Heartbeat every 10 s.
- Every monitor emits typed events from packages/shared/events.ts.
Unit tests with Vitest + jsdom where possible; a demo page in apps/web at /dev/proctor to try each monitor manually.
```

## Step 7 — Proctor SDK: recording pipeline

```text
Implement FR-701 and FR-702 in the SDK:
- Recorders for SCREEN, WEBCAM and AUDIO using MediaRecorder (webm, VP8/Opus, modest bitrates to save storage: e.g. screen at a low frame rate such as 5 fps, webcam 640x360).
- 10-second chunks; for each chunk request a presigned URL, PUT to object storage, confirm; on failure store in IndexedDB (cap 200 MB) and retry with exponential backoff; resume after reload.
- Upload queue with concurrency 2 and back-pressure so uploads never block the editor.
- Expose recorder health (bytes pending, last successful upload) to the UI.
Test TC-063 manually with DevTools offline mode and document the results in the PR.
```

## Step 8 — Proctor SDK: in-browser AI detectors

```text
Implement FR-606 and FR-607 detectors running in a Web Worker (or OffscreenCanvas where supported) so the editor stays smooth:
- Face: MediaPipe Tasks Vision FaceDetector every 1 s → NO_FACE (over 5 s continuous), MULTIPLE_FACES.
- Gaze: MediaPipe FaceLandmarker iris/head-pose estimate → GAZE_AWAY when looking away over 5 s.
- Objects: TensorFlow.js COCO-SSD every 2 s → PHONE_DETECTED (cell phone), BOOK_DETECTED; confidence thresholds configurable.
- Identity re-check: every 2 minutes send a selfie frame for FACE_MISMATCH checking via the API.
- Audio: voice activity detection in the browser (e.g. @ricky0123/vad-web, Silero-based) → SPEECH_DETECTED with duration.
- For each HIGH event, capture a JPEG snapshot, upload via presigned URL, attach evidenceKey.
- Respect accommodations: disabled detectors never run.
- Load models from self-hosted static files, not third-party CDNs at test time.
Add a calibration screen in /dev/proctor showing live detector output. Tests for thresholds and debouncing logic with recorded fixture data.
```

## Step 9 — Candidate pre-test flow

```text
Implement FR-401 to FR-406 as a stepper under /t/[token]:
1. Welcome + rules + what is recorded + retention period (information only; no device access).
2. Email OTP (OPENED, fsd.md section 3).
3. Consent document (FR-401, D-17): show the full 2-3 page document from GET /candidate/session/consent in an accessible scroll container with its version. The Sign control stays disabled until the candidate has scrolled to the end; the candidate then types their full legal name and signs (POST /candidate/session/consent/sign; the server sets the time). Afterwards show "A copy has been emailed to you" (CONSENTED). A clearly visible Decline action posts /candidate/session/consent/decline and shows a calm page with the organization's contact for alternatives or accommodations; nothing else happens (DECLINED). No camera, microphone or screen access before the document is signed (TC-030, TC-095, TC-096). Keyboard and screen-reader users must be able to reach the end and sign. If the document is a Legal placeholder, show the placeholder banner exactly as served.
4. System check: browser (block non-Chromium for STANDARD/STRICT, TC-031), camera, mic with level meter, screen share test, network speed, single monitor.
5. Identity: ID photo capture (with framing guide) and selfie with liveness prompts (blink, turn head left/right) using FaceLandmarker; show result or "sent for manual review".
6. Room scan: guided 360° recording (15 s) plus desk view.
7. STRICT only: QR code linking a phone page that streams a side camera via the same recorder.
8. Practice question (untimed, not scored).
9. Final checklist and Start (enters fullscreen, starts all recorders and detectors).
Clear, calm copy; every failure has a fix-it hint; WCAG 2.1 AA.
Resuming (ADR 0002): reopening the link mid-test asks for the email OTP again unless the session token is still valid; a wrong OTP shows the cooldown seconds and never locks the candidate out once the test has started (D-21). A declined session shows the declined page; a finished session shows "Already used".
Playwright tests for TC-030, TC-031, TC-032, TC-095 and TC-096 (UI side).
```

## Step 10 — Candidate test screen

```text
Implement FR-501 to FR-506 UI:
- Layout: question panel (markdown), Monaco editor (language selector, reset to starter code), output panel (sample test results, stdout, errors), question navigator limited to the open section, server-synced countdown timers for the test and the open section, and a "Finish section" action with a clear warning that the section cannot be reopened (ADR 0002).
- MCQ and short-answer questions: answer controls autosaved like code; never show whether a short answer matched.
- Monaco configured with AI suggestions off, quick suggestions limited to language keywords, paste disabled (editor.onDidPaste revert + SDK block), drag-drop disabled; every change captured for keystroke batches (FR-608).
- Autosave every 10 s with a visible saved indicator; Run with cooldown; Submit per question; Finish test with confirmation.
- Lock overlays: fullscreen exit, screen share stopped, side camera lost (STRICT), focus lost, proctor pause — the editor is read-only until resolved. Only the proctor pause stops the timer; the other overlays say that time keeps running (ADR 0002).
- Proctor message toast from the live channel.
- Warning counter shown to the candidate ("This was recorded") to deter repeat behavior.
Playwright tests for TC-040, TC-041, TC-046, TC-050, TC-051, TC-052.
```

## Step 11 — Review workspace

```text
Implement FR-901 and FR-902:
- Review queue with risk band badges and filters.
- Session review page: synchronized players for screen, webcam and side camera (one master clock), an events timeline under the video (colored by severity, click to seek), a keystroke replay panel (reconstructs the editor from keystroke batches with play/pause and 1x–16x speed, highlighting PASTE_BURST moments), code diffs between runs, test results, identity images.
- Flag panel: confirm/dismiss with note per event; identity panel (ID image, selfie and webcam frames side by side, decision MATCH / NO_MATCH / INCONCLUSIVE with note) when the identity check awaits manual review; manual scoring panel for short answers awaiting a human (answer, accepted answers, mark correct or incorrect with note, D-23); verdict form enabled only when all HIGH flags are decided, the identity decision is recorded and every short answer is scored.
- Everything keyboard-navigable (j/k next/previous flag, space play/pause).
Tests: TC-062, TC-077, TC-078, TC-099 (UI side).
```

## Step 12 — Live proctoring

```text
Implement FR-903: a /admin/live grid of active sessions (candidate name, test, time left, latest webcam thumbnail refreshed every 10 s, live event feed). Cards turn amber/red on MEDIUM/HIGH events. Click opens a side panel with the event log and actions: send message, pause, resume. Uses the Socket.IO /live gateway with automatic reconnect.
Test: TC-079.
```

## Step 13 — Dashboard, reports and polish

```text
Implement FR-1001 and FR-1002: dashboard cards and charts (Recharts) for invitations, completion, pass rate, flag rate by type; candidate report download; CSV export.
Then do a full accessibility pass (axe in Playwright on every page, keyboard-only walkthrough of the candidate flow, screen-reader labels) to pass TC-092, and add an end-to-end Playwright suite covering a whole candidate journey against the seeded staging data.
```

## Step 14 — Lockdown desktop client (Phase 3)

```text
Implement FR-1101 to FR-1103 in apps/lockdown (Electron + electron-builder, Windows and macOS):
- Loads the candidate portal URL in a kiosk-mode BrowserWindow; blocks new windows, navigation off the allowed origin, devtools, and OS shortcuts where the OS allows.
- Before and during the test, scans running processes against a configurable deny list (remote desktop tools, screen recorders, VM guest tools, known AI desktop apps) and reports PROHIBITED_PROCESS; detects VM environments.
- Clears the clipboard at start and blocks clipboard reads.
- Attestation: the app holds a build-time signing key; it signs a server challenge so the API accepts LOCKDOWN sessions only from genuine builds.
- Code-signed installers via GitHub Actions.
Document the limitations honestly in /docs/lockdown.md: a determined user with admin rights or a second device can still bypass parts of this.
```
