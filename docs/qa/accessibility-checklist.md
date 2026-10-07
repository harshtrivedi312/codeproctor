# Accessibility checklist for candidate screens (TC-092, NFR-06)

Owner: qa-engineer (QA B session). Written 2026-10-05. This is a checklist and a set of manual scripts; the results go in the record template in section 9. It does not change any application code.

Target: WCAG 2.1 level AA on every candidate-facing screen (NFR-06, brd.md section 7, BR-12). TC-092 (P1) says "axe + screen reader on candidate flow: no WCAG 2.1 AA violations". The existing short script "Accessibility with a screen reader" in /docs/manual-tests.md is the entry point; this file is the detailed checklist behind it. Do not duplicate manual-tests.md: where a step already exists there (M-01 steps 2 to 8, M-02, M-03), this file links to it by ID and adds only the accessibility checks.

Out of scope: the invitation, OTP and signed-consent-copy emails (FR-303, C-07, C-31). Add a small check when they are built: plain-text alternative, real headings and link text, no colour-only cues, 4.5:1 contrast, and no token or OTP in the link text read aloud.

Sources: docs/test-cases.md (TC-030, TC-031, TC-032, TC-040, TC-041, TC-046, TC-050, TC-054, TC-055, TC-092, TC-095, TC-096), docs/fsd.md (FR-305, FR-401 to FR-406, FR-502, FR-504, FR-505, FR-601 to FR-604, FR-609, section 3), docs/brd.md (BR-12), docs/compliance/decisions.md (C-02, C-05, C-07, C-19, C-25, C-30, C-34), docs/prompts/frontend.md (Steps 9 and 10), docs/adr/0002 and 0015 (proposed), docs/qa/redteam-plan.md rule 2, and the code on main (apps/web/src/features/candidate-test, packages/qa/e2e/candidate-test.spec.ts), read only to see what automation covers. Where the docs and the code disagree, the docs win and the difference is a defect.

Verification marks used below: "(doc)" means the requirement is written in a doc; "(code)" means I saw it in the code on main and it is only a hint for where to look; "(unverified)" means I could not confirm it from the docs or code and the tester must check it and record what they see.

## 1. State of the product against this checklist (checked 2026-10-06 on main)

| Screen group | Built? | Evidence |
| --- | --- | --- |
| Link entry: `/t/[token]` renders TokenHandoff, which moves the token into memory and replaces the URL with `/t/link`; `/t/start` is the fragment entry (FragmentHandoff, then `/t/link`) | Yes (FE-09) | apps/web/src/app/(candidate)/t/[token]/page.tsx, apps/web/src/app/(candidate)/t/start/page.tsx, apps/web/src/features/candidate-flow/token-handoff.tsx |
| Stepper at `/t/link`: welcome (landing), verify (email OTP), consent (with decline), system check, identity, room scan, phone (QR, STRICT), practice, start, then the test (order from `STEP_IDS` in steps.ts) | Yes (FE-09), wired in `candidate-flow.tsx` with ConsentStep, SystemCheckStep, IdentityStep, RoomScanStep, PhoneStep, PracticeStep, StartStep and TestScreen | apps/web/src/features/candidate-flow/candidate-flow.tsx, apps/web/src/features/candidate-flow/steps.ts; route `/t/link` under apps/web/src/app/(candidate)/t/ |
| Phone side-camera pages (STRICT), run on the phone: `/t/phone` and `/t/phone/enter` | Yes | apps/web/src/app/(candidate)/t/phone/page.tsx, apps/web/src/app/(candidate)/t/phone/enter, apps/web/src/features/candidate-phone |
| Terminal screens: already used, expired, not yet open, blocked (link paused), declined, session ended, service unavailable, invalid link | Yes | apps/web/src/features/candidate-flow/terminal-screens.tsx |
| Test screen (editor, output, timers, overlays, finish section) | Partly. Mocked at `/t/demo/test` (FE-10). After the stepper, Start is disabled outside mock mode: `START_ENABLED = mockingEnabled` (start-step.tsx:21), so on a non-mocked build the Start button is disabled and an info alert "The test cannot be started from this page yet" shows. Run the test-screen checks (4.9, 4.10) on a mocked build or at `/t/demo/test` until Start is connected to the real backend, and do not record them "not built" | apps/web/src/features/candidate-test, apps/web/src/app/(candidate)/t/[token]/test/page.tsx, packages/qa/e2e/candidate-test.spec.ts |
| Submitted screen after the last section ("Your test is submitted", focus on the `h1`, leaves fullscreen) | Yes | `SubmittedPanel` in apps/web/src/features/candidate-test/test-screen.tsx |
| Public error pages (expired, used, forbidden) | Yes | apps/web/src/app/(public)/errors/[kind]/page.tsx |
| Retention and destruction schedule page `/retention` (target of the schedule link until NEXT_PUBLIC_RETENTION_SCHEDULE_URL is set, steps.ts:50); relevant to A11Y-LAND-03 and A11Y-CON-08 | Yes | apps/web/src/app/(candidate)/retention/page.tsx |
| Final checklist before Start (A11Y-STEP-05) | Yes, as a hint from the code: StartStep shows a fixed list of four "done" items, each with a hidden "(done)" label, then a warning alert; the disabled-Start reason is the info alert, not text tied to the button. Check it as a code hint, not as the requirement | apps/web/src/features/candidate-flow/start-step.tsx |

Run every screen that exists, in sections 4.1 to 4.11. Record "not built" in the result record only for a screen or state that is truly missing when you run it (for example the optional demographic form, A11Y-FIN-07, and the appeal screen, A11Y-FIN-08), never "pass" for something you did not see.

## 2. What automation covers and what it does not

Automation today: `packages/qa/e2e/candidate-test.spec.ts` runs `@axe-core/playwright` with tags wcag2a, wcag2aa, wcag21a, wcag21aa on two states of the mocked test screen (the start gate and the running screen), titled TC-092. `apps/web/e2e/axe.ts` is a helper for the staff screens. Component-level vitest-axe tests exist (code) for the test screen: `apps/web/src/features/candidate-test/qa-tc.test.tsx` (TC-092 start gate runs every axe rule; the running-screen test switches the `region` rule off because jsdom has no `main`), `apps/web/src/features/candidate-test/real-test.test.tsx` (runs axe on the gate, running and submitted screens; the submitted screen has jsdom coverage but still needs a real-browser run) and `test-screen.test.tsx` (lock overlay and finish dialog). Since the stepper landed (FE-09) the pre-test screens also have component-level axe tests (code): apps/web/src/features/consent/consent-step.test.tsx, apps/web/src/features/precheck/system-check-step.test.tsx, apps/web/src/features/identity/identity-step.test.tsx, apps/web/src/features/candidate-room/room-scan-step.test.tsx, apps/web/src/features/candidate-practice/practice-step.test.tsx, apps/web/src/features/candidate-phone/phone.test.tsx, apps/web/src/features/candidate-flow/flow.test.tsx and apps/web/src/features/candidate-flow/entry-otp.test.tsx. I did not find a real-browser axe run for the stepper screens (`apps/web/e2e/candidate-handoff.spec.ts` does not use axe). jsdom has no layout or computed colours, so these tests cannot find contrast (1.4.3, 1.4.11), reflow, focus-ring or visibility problems; only a real-browser axe run can. States covered only in jsdom (every stepper screen, lock overlay, finish dialog) still need the real-browser run.

The CI rule: any axe failure fails CI whatever its impact level (`toHaveNoViolations` and the Playwright `toEqual([])` both fail on minor too); the severity table in section 9 applies to manual findings. Every candidate screen and every state with its own DOM (dialog open, error shown, overlay shown, disabled button, results shown) gets a real-browser axe check titled `TC-092 <screen and state> has no WCAG 2.1 AA violations`. The owner of the stepper (frontend, FE-09 follow-up) should add one per step and per failure state. Matrix rows for these are listed in section 10 (QA A owns /docs/test-matrix.md).

What axe finds reliably (about a third of WCAG issues): missing names and roles (4.1.2), label and form association (1.3.1, 3.3.2), contrast of text (1.4.3) where colours are computable, duplicate ids, invalid ARIA, landmark and heading structure basics, image alt presence (1.1.1), scrollable region focus.

What axe cannot find, and so must be manual (sections 5 to 8):

| Area | Why manual | WCAG |
| --- | --- | --- |
| Reading order and focus order, focus visible, focus moves into and back from dialogs | needs a person pressing keys | 1.3.2, 2.4.3, 2.4.7 |
| Keyboard traps and reachability of every action | needs a person | 2.1.1, 2.1.2 |
| Quality of names, labels and alt text; error message wording | axe checks only presence | 1.1.1, 2.4.6, 3.3.1, 3.3.3 |
| Live announcements: what is spoken, when, and how often | needs a screen reader | 4.1.3 |
| Contrast of non-text parts, focus ring, text over video or in canvas, dark theme, Monaco token colours | axe cannot compute these reliably | 1.4.3, 1.4.11 |
| Reflow at 320 CSS px, text spacing, 200 percent zoom | needs a browser at that size | 1.4.4, 1.4.10, 1.4.12 |
| Time limits, extension for accommodations, no hidden timeouts | behaviour over time | 2.2.1 |
| Camera and microphone flows (permission prompts, liveness prompts, meters) | browser UI and hardware | 1.1.1, 1.4.1, 2.5.x, 4.1.3 |
| Media alternatives for any instruction video | not in docs; flagged | 1.2.1 to 1.2.5 |

Automated checks that are not axe (suggested as a FE-09/FE-10 follow-up, owner frontend, QA A to add the tests): a Vitest or Playwright check that the three timer thresholds (timerWarning in timer.ts, 5 minutes, 1 minute, expired) produce exactly one announcement each (one per threshold per timer, plus one time-up alert); a Playwright check that the lock overlay takes focus and returns it; a check at viewport width 320 px that `document.documentElement.scrollWidth <= clientWidth` on each form screen.

## 3. Test environment and data rules

1. Staging or a local build only. Never pilot or production, never real credentials (ADR 0009, CLAUDE.md). Test-screen checks (4.9, 4.10) need a mocked build or `/t/demo/test` until Start is connected to the real backend (section 1). Do not start or stop the local Docker stack or the web dev server unless you are the session that owns it (CLAUDE.md rules 14 and 15); use staging or a build you were given.
2. Synthetic data only. Candidate mailbox: a dedicated test mailbox on a test domain that the tester controls, never a personal address. The consent full legal name is a synthetic name, never the tester's own: the signed consent record and PDF are kept for 3 years even after erasure (C-17). Faces: generated (rendered or AI-generated) footage only, played through a virtual camera, never a real person and not the tester's own face (red-team plan rule 2; the owner decision on own-face use is FU-QAB-02 and is still open, so the default is no). ID documents: specimen or generated images only, never a real ID. Audio: generated or TTS only. If a physical webcam is used, point it at an empty scene or feed it generated video (FU-QAB-06 item 1). Room scan (A11Y-ROOM-01): use a virtual camera with generated footage only; if a physical webcam is used, scan an empty room with no people, no documents and no screens showing names. STRICT phone side camera (A11Y-QR-01, A11Y-QR-02): the phone is a physical camera streaming to staging; point it at an empty wall or cover the lens, never at a person. If the phone page captures audio, nobody speaks near the phone, and no screen reader speaks from the phone (TalkBack or VoiceOver on the phone page: use headphones or mute speech and check the transcript or caption only). Staff and recruiter accounts on staging use a synthetic name and a test mailbox, never a real person's details (A11Y-DEC-03 shows the recruiter's name and email; A11Y-TIM-03 uses the recruiter's invitation form).
   Live voice is also recorded data. While the test screen (or any screen after consent) is open, the microphone is recorded (FR-607, FR-701), so no tester speaks live on a recorded screen and no real voice is captured. Rules: (a) live voice commands and live dictation are allowed only on screens before consent is signed, where nothing is recorded (TC-030: the consent and decline screens; check the Network tab shows no media request); switch the browser microphone to the virtual device first, and stop live speech (pause Voice Control or Voice Access) as soon as Sign is activated; (b) on recorded screens, either route the browser microphone to a virtual device carrying generated audio while the OS voice engine listens on a separate input carrying TTS audio, or drive the commands with TTS audio played into the OS voice input; (c) screen-reader speech must not reach the recorded microphone: use headphones. The speakers-versus-headphones run in A11Y-LOCK-06 does not use the room: it routes the system audio output into the browser's virtual microphone through a loopback (for example BlackHole or VB-Cable), and the physical microphone is never selected in the browser in any run. Before a whole-screen share (FR-604 records the entire monitor), turn on Do Not Disturb, close personal apps and notifications, and use a clean OS account or VM (red-team plan rule 2). Expect FR-610 virtual-camera events in both the with-AT and the without-AT runs, because the generated face comes through a virtual camera; compare the two runs for events other than that one. Limit of that comparison: in-browser ML detectors do not start after Start in `/t/link` (the CSP has no WebAssembly allowance; start-step.tsx:12-16, FU-FEB-10, FU-FEB-44), so the with-AT versus without-AT detector-event comparison cannot cover ML detectors until that lands.
3. Assistive-technology users: if a person who uses a screen reader or switch daily takes part as a tester, they test with synthetic data like everyone else and sign the volunteer consent form (C-11, C-20) only if it covers their participation. Whether the form covers usability testing is not stated in the docs (unverified); ask the hub before inviting outside testers.
4. Never write an OTP, token, presigned URL, object key or recording URL in a record, a defect or a screenshot (manual-tests.md section 0). Crop or blur the URL bar, and avoid reading the URL bar aloud or on screen while sharing. Close the NVDA speech viewer or move it off the shared monitor, and do the same with the VoiceOver Caption Panel (save the transcript after the share ends). Screen-reader transcripts must not contain a token either: read the transcript before saving it.
5. Clean-up: delete the test session through the admin deletion flow (TC-094) afterwards. The signed consent record stays until 3 years after signing (C-17); that is expected.
6. Record for every run: date, commit or build, browser and version, OS, assistive tech and version (for example NVDA 2026.x, VoiceOver on macOS 26), viewport, theme (light, dark), pass or fail per check, defect ids.

Test matrix for screen readers (one full pass of sections 5 to 8 per combination; P1 combinations first):

| Priority | Combination | Notes |
| --- | --- | --- |
| P1 | NVDA + Chrome (Windows) | The product supports Chromium (NFR-07, TC-031), so Chrome and Edge are the real candidate browsers. |
| P1 | VoiceOver + Safari (macOS) | Safari is not a supported browser for STANDARD and STRICT (FR-402, NFR-07; TC-031 is the Firefox case of the same block), so a VoiceOver candidate must be able to read the pre-test screens and the unsupported-browser block message, and then continue in Chrome. Check that the block message in Safari is itself accessible (A11Y-SYS-08). Run the test screen with VoiceOver + Chrome as well. |
| P2 | NVDA + Firefox | Firefox is blocked for STANDARD tests (TC-031); only the block message and the consent and decline screens are in scope, in case consent can be read before the browser check (unverified: the order of the browser check and the consent screen is not fixed in the FSD). |
| P2 | VoiceOver + Chrome (macOS) | |
| Optional | JAWS + Chrome (Windows) | Licensed software; run if available; record version. Not a gate. |
| Optional | Windows forced colours, Narrator, TalkBack on Android | Only if time allows. Mobile is outside the supported browsers (NFR-07), so TalkBack applies only to the invitation email link and the STRICT QR phone page (section 4.7), which runs on a phone. |

Keyboard-only runs need no AT and are run first on every screen (section 5).

## 4. Screen-by-screen checklist

Reading the tables: "Check" is a pass/fail statement. "Auto" says whether axe or an existing test covers it (Y = axe finds it, P = axe finds part, N = manual only). IDs are `A11Y-<screen>-<n>` so defects can cite them. Everything in sections 4.x also needs the common checks in section 4.0.

### 4.0 Common checks (every screen and state)

| ID | WCAG | Check | Auto |
| --- | --- | --- | --- |
| A11Y-C-01 | 2.4.2, 3.1.1 | The page has a unique, meaningful title that changes per step, and `lang` is set on the document. | Y (lang), N (title wording) |
| A11Y-C-02 | 1.3.1, 2.4.1, 2.4.6 (a skip link is best practice) | One `main` landmark, one `h1` that names the screen, headings in order without skipping for layout, a skip link or equivalent where there is repeated chrome. | P |
| A11Y-C-03 | 2.4.3 | When a step changes (route or in-page), focus moves to the new `h1` or the new step container, and the change is announced; focus is never left on a removed element or on the document body. | N |
| A11Y-C-04 | 2.4.7, 1.4.11 | Every interactive element shows a visible focus indicator with at least 3:1 contrast against the background, in light and dark themes. | N |
| A11Y-C-05 | 1.4.3 | Text contrast at least 4.5:1 (3:1 for 18 pt or 14 pt bold and larger), including the warning, destructive and muted text colours, placeholder text, disabled-looking text that is still informative, and text over any video or canvas. | P |
| A11Y-C-06 | 1.4.11 | Borders of inputs, checkbox boxes, radio dots, the progress or level meter and icons that carry meaning have at least 3:1 contrast. | N |
| A11Y-C-07 | 1.4.1 | Colour is never the only signal (error, success, warning, pass/fail of a sample test, level meter). An icon with a text name or the word is also present. | N |
| A11Y-C-08 | 1.4.4, 1.4.10 | At 200 percent browser zoom and at a 320 CSS px wide viewport (equals 400 percent zoom on a 1280 px screen) the page reflows to one column: no horizontal scroll (except the code editor and data tables, which may scroll in two directions per the 1.4.10 exception for code), nothing cut off, nothing overlapping, all actions still reachable. | N |
| A11Y-C-09 | 1.4.12 | With text spacing overridden (line height 1.5, paragraph spacing 2x, letter spacing 0.12 em, word spacing 0.16 em; use a bookmarklet or the "Text Spacing" extension) no text is clipped or overlapped and no control disappears. | N |
| A11Y-C-10 | 1.4.13 | Anything shown on hover or focus (tooltips, help popovers) can be dismissed with Esc, stays visible while the pointer is over it, and does not hide other content. | N |
| A11Y-C-11 | 2.5.3, 4.1.2 | The accessible name of every control contains its visible label text, so voice-control users can say what they see. | P |
| A11Y-C-12 | none at AA 2.1 (2.5.8 is WCAG 2.2) | Touch target size is not an AA 2.1 criterion. Record controls smaller than 24 CSS px as a nit only (the QR phone page of STRICT runs on a phone). | N |
| A11Y-C-13 | 3.2.1, 3.2.2 | Receiving focus or changing a field value never starts navigation, a submit or a recording by itself. | N |
| A11Y-C-14 | 2.3.1 | Nothing flashes more than three times a second (liveness prompts, level meter, warning overlay). | N |
| A11Y-C-15 | 1.3.4, 1.4.4 | The page works in portrait and landscape; text can be enlarged to 200 percent without loss. | N |
| A11Y-C-16 | 4.1.2 | Icon-only buttons have an accessible name; decorative icons are `aria-hidden`; no control has the role `button` on a non-focusable element. | Y |
| A11Y-C-17 | 3.3.4 (AA) | Actions that submit a legal or irreversible result (sign consent, decline, finish section, finish test) can be confirmed, reviewed or corrected before they take effect, or show a clear confirmation step. | N |

### 4.1 Landing page, rules and "what is recorded" (FR-401, step 1 of the stepper)

Information only; no device access (frontend.md Step 9.1).

| ID | WCAG | Check | Auto |
| --- | --- | --- | --- |
| A11Y-LAND-01 | 1.3.1, 2.4.6 | The rules, the list of what is recorded (screen, webcam, microphone, keystrokes) and the retention period are real headings and lists, not images or a styled paragraph. | P |
| A11Y-LAND-02 | 1.1.1 | Any illustration has alt text or is marked decorative; no information is only in an image. | Y (presence) |
| A11Y-LAND-03 | 2.4.4 (2.4.9 is AAA) | The retention-schedule link (C-05) has a name that says where it goes ("Retention and destruction schedule"), not "click here"; it opens by keyboard. Until NEXT_PUBLIC_RETENTION_SCHEDULE_URL is set the link goes to the `/retention` page (code); check that page too. | P |
| A11Y-LAND-04 | 3.1.5 is AAA | Plain language is the product goal ("clear, calm copy", frontend.md Step 9) but not an AA criterion. Record reading difficulty as a nit. | N |
| A11Y-LAND-05 | 2.2.1 | The invitation window (FR-303) is stated in text; if the page can expire on its own (invitation EXPIRED, errors/expired), it does not expire while the candidate is reading without a warning (see A11Y-ERR-02). | N |

### 4.2 Email OTP (OPENED; FR-106, TC-007, TC-097)

| ID | WCAG | Check | Auto |
| --- | --- | --- | --- |
| A11Y-OTP-01 | 1.3.1, 3.3.2, 4.1.2 | One visible label for the code field ("Email code"), programmatically tied to the input. If the design uses six boxes, they are grouped (`fieldset` and `legend`, or a single input with `autocomplete="one-time-code"`) and each box has a name like "Digit 1 of 6". | Y (label), N (grouping) |
| A11Y-OTP-02 | best practice (1.3.5 covers personal data fields, not one-time codes) | The field has `autocomplete="one-time-code"` and `inputmode="numeric"`; paste of the full code works (the paste block, FR-603, applies only inside the test). | N |
| A11Y-OTP-03 | 3.3.1, 3.3.3, 4.1.3 | A wrong code shows a text error that names the field, says what to do, is linked with `aria-describedby` and `aria-invalid`, is announced once without moving focus away from the field, and does not reveal the code. | N |
| A11Y-OTP-04 | 3.3.1, 4.1.3, 2.2.1 | The cooldown after a wrong code during a test (D-21, TC-097, "cooldown seconds") is shown as text; the countdown is announced at the start and the end only, not every second; the control re-enables and the end of the cooldown is announced. | N |
| A11Y-OTP-05 | 2.2.1 | The code expires after 10 minutes (doc: ADR 0003, `otp:{invitationId}` TTL 10 minutes; ADR 0002 D-21 repeats the 10-minute OTP expiry and the 30 s cooldown). The expiry is stated in text, and a "send a new code" action is keyboard reachable before and after expiry. No message vanishes on its own in under a suggested 5 seconds. The 30 s cooldown is still marked "owner to confirm" in ADR 0002 (D-21), so treat the value as provisional. | N |
| A11Y-OTP-06 | 3.3.1 | The 30-minute link block after 5 wrong codes (TC-007) is explained in text with what to do next (contact the recruiter, whose contact is shown; unverified that the contact is shown on this screen). | N |
| A11Y-OTP-07 | 3.3.8 is WCAG 2.2, not required | Accessible authentication is a 2.2 criterion; record only. The OTP can be pasted, which is the helpful behaviour. | N |

### 4.3 Consent document and the 18+ confirmation (FR-401, TC-030, TC-095, C-05, C-07, C-30)

Functional steps are in manual-tests.md M-01. Add these checks while running M-01.

| ID | WCAG | Check | Auto |
| --- | --- | --- | --- |
| A11Y-CON-01 | 1.3.1, 2.4.6 | The 2 to 3 page document has a heading structure (`h1` for the screen, `h2` for each section), lists as lists, and the document version and any Legal placeholder banner are text read before the body ("exactly as served", frontend.md Step 9.3). | P |
| A11Y-CON-02 | 2.1.1, 2.4.3 | The scroll container is keyboard-operable: it is focusable (`tabindex="0"`), has an accessible name ("Consent document, version X"), and scrolls with Arrow, Page Down, Space and End. The tester can reach the end using only the keyboard. | Y (scrollable-region-focusable), N (reach the end) |
| A11Y-CON-03 | 2.1.1, 4.1.2 | Sign is disabled until the end is reached (TC-095). The disabled state is exposed (`disabled` or `aria-disabled`) and there is a text hint next to it: "Scroll to the end of the document to sign". A screen-reader user is told when it becomes enabled (a polite status message such as "You have reached the end. You can now sign."). Note the risk: screen readers in browse mode do not scroll the container the way sighted users do; verify with NVDA browse mode and VoiceOver that moving the virtual cursor through the document to the last paragraph counts as "reached the end" (FR-401 says "scrolls to the end"; frontend.md Step 9.3 says keyboard and screen-reader users must be able to reach the end and sign). Blocker outcome (whatever the implementation): a screen-reader user who has read the whole document, with NVDA browse mode or VoiceOver, cannot enable Sign. | N |
| A11Y-CON-04 | 1.3.1, 3.3.2 | The 18+ confirmation (C-30) is a native checkbox with a visible label ("I confirm I am 18 years old or older"), not ticked by default, required (`required` or `aria-required`), and separate from the other controls. The explicit biometric consent (C-02, C-09) is separate from the rest if it is a separate control; each has its own label. | Y (label) |
| A11Y-CON-05 | 3.3.2, 1.3.5 | The full-legal-name field has a visible label, hint text ("Type your full legal name"), `autocomplete="name"`, and a programmatic link to the hint. | Y (label) |
| A11Y-CON-06 | 3.3.1, 3.3.3, 4.1.3 | Missing 18+ (M-01 step 4): the message names the missing confirmation, is in text, is linked with `aria-describedby`, is announced, and focus moves to the checkbox (M-01 says focus moves to it). Missing name and name too short behave the same. An error summary, if used, links to each field. | N |
| A11Y-CON-07 | 3.3.4, 3.2.2 | Signing does nothing until the candidate activates Sign. After success the page says "A copy has been emailed to you" in a status message that is announced, and focus lands on the next step heading. | N |
| A11Y-CON-08 | 2.4.4 | The retention schedule link (C-05) is announced as a link with a clear name and opens without losing the candidate's place (new tab is announced as such, or the same tab keeps the typed name when the candidate returns). Until NEXT_PUBLIC_RETENTION_SCHEDULE_URL is set the target is the `/retention` page (code). | N |
| A11Y-CON-09 | 1.4.4, 1.4.10, 1.4.12 | Document text reflows at 320 px and with the text-spacing override; the scroll container does not become so small at 400 percent zoom that only one line is visible (check the container height). | N |
| A11Y-CON-10 | 2.4.3 | A logical focus order, for example: heading, document, 18+ checkbox, name field, Sign, Decline. Decline is reachable by keyboard and is not hidden by a layout that places it only after a long scroll. | N |
| A11Y-CON-11 | 3.1.5 (AAA), 3.1.3 (AAA) | Legal text is the owner's wording (C-09 plain language). Reading level is not an AA criterion; record only. | N |
| A11Y-CON-12 | 2.2.1 | There is no inactivity timeout on the consent screen while the candidate reads. If the session token expires while reading (unverified), the candidate is warned and can continue (A11Y-ERR-02). | N |

### 4.4 Decline path (TC-096, C-02, M-02)

| ID | WCAG | Check | Auto |
| --- | --- | --- | --- |
| A11Y-DEC-01 | 2.4.7, 2.1.1 | Decline is a real button or link with a visible presentation (not hidden in small grey text; equal weight with Sign is a consent-design point, not a WCAG criterion), reachable by keyboard from the document without scrolling. | N |
| A11Y-DEC-02 | 3.3.4, 4.1.2 | If a confirmation step is shown (M-02 step 2), it is a dialog (`role="dialog"` or `alertdialog`) with a name, focus moves into it, Esc closes it without declining, focus is trapped inside while open and returns to Decline on close, and the default focused button is the safe one. | N |
| A11Y-DEC-03 | 1.3.1, 4.1.3 | The declined page has an `h1`, says in text that the session ended with nothing recorded, and shows the recruiter's name and email (C-02) as text. The email is a real `mailto:` link whose text is the address. Focus moves to the `h1` on arrival. | P |
| A11Y-DEC-04 | 1.4.3, 1.4.1 | The page does not use a warning or error colour as the only sign it is final; the tone check ("calm", frontend.md Step 9.3) is a content nit. | N |
| A11Y-DEC-05 | 3.3.2, best practice | There is a text route to ask for an accommodation or an alternative (C-02), not only a phone number or an image. | N |
| A11Y-DEC-06 | 3.2.2 | Reopening the invite link (M-02 step 5) shows the declined page with the same headings and focus behaviour. | N |

### 4.5 System check (FR-402, TC-031, TC-032)

Covers browser, camera, microphone with level meter, screen-share test, network speed and single monitor (frontend.md Step 9.4).

| ID | WCAG | Check | Auto |
| --- | --- | --- | --- |
| A11Y-SYS-01 | 1.3.1, 4.1.2 | Each check is a list item or table row with its name, its status as text ("Passed", "Failed", "Not checked yet") and its icon marked decorative. The status of each row is reachable by a screen reader without the icon. | P |
| A11Y-SYS-02 | 4.1.3 | When a check finishes, the result is announced through a polite status region ("Camera: passed"). Results arriving together are announced as one message or in order, not as a flood. Focus does not jump. | N |
| A11Y-SYS-03 | 3.3.1, 3.3.3 | Each failure has a text reason and a fix-it hint (frontend.md Step 9: "every failure has a fix-it hint"): camera denied (TC-032: "Cannot proceed; help text shown"), microphone denied, screen share set to window (TC-054), no camera found, second monitor found (FR-605), slow network. The hint names the browser setting to change in words, not only a screenshot, and has a "Check again" button. | N |
| A11Y-SYS-04 | 1.3.3, 1.1.1 | Any hint image has a text equivalent. Hints do not rely on position ("click the icon on the left"), colour or shape alone. | N |
| A11Y-SYS-05 | 2.4.3, 4.1.2 | When the browser shows its own permission prompt (camera, microphone, screen picker), the page does not steal focus back, and the candidate is told before the prompt appears what it will ask for and what to choose ("In the next window, choose Entire screen, then Share"). Verify with NVDA and VoiceOver that the prompt is reachable (it is browser UI; record whether the screen reader reads it and whether the keyboard operates it). The screen picker of Chromium is keyboard operable but its announcement varies (unverified). | N |
| A11Y-SYS-06 | 1.1.1, 1.4.1, 4.1.3 | Microphone level meter: has a text alternative that changes ("Microphone level: good", "too quiet", "no sound") announced politely and rarely (when the state changes, not on every frame). A sighted-only moving bar fails. A candidate who cannot speak or cannot hear must not be blocked: the doc does not define how to handle a candidate with no usable microphone beyond C-02 (refusal or inability goes to the recruiter). Flag as OQ-A11Y-3. | N |
| A11Y-SYS-07 | 1.1.1 | The camera preview (a `video` element) has an accessible name ("Your camera preview"), is muted, does not autoplay sound, and has no keyboard trap. The preview does not need captions (it is live self-view with no prerecorded media). | P |
| A11Y-SYS-08 | 3.3.1 | Unsupported browser block (TC-031): the message is visible text, names the supported browsers, includes a link to download or a copyable address, and is announced on load. It is readable in Firefox and Safari themselves (they are the browsers it appears in). | N |
| A11Y-SYS-09 | 2.2.1 | The network speed test and each check can be run again; none has an auto-expiry. A check that takes longer than a suggested 20 seconds shows progress text ("Still checking... 20 s") that is announced once. | N |
| A11Y-SYS-10 | 2.1.1 | Every check can be run, re-run and skipped-with-explanation (if allowed) by keyboard. The continue button is disabled until required checks pass, with a text reason. | N |

### 4.6 Identity capture: ID image, selfie, liveness, waived variant (FR-403, TC-033, TC-034, C-19, C-25, C-34, M-03)

Frontend.md Step 9.5: ID photo capture with a framing guide, selfie with liveness prompts (blink, turn head left or right) using FaceLandmarker, result or "sent for manual review". These steps depend on the camera and on sight, so they carry the highest accessibility risk in the pre-test flow. The FSD says a failed or low-confidence match gets one retry and then goes to manual review and never blocks the test (FR-403), which gives a fallback for the match, but it is not stated for the capture itself (see OQ-A11Y-1).

| ID | WCAG | Check | Auto |
| --- | --- | --- | --- |
| A11Y-ID-01 | 1.1.1, 1.3.3 | The framing guide (an overlay on the camera preview) has a text equivalent: "Hold the front of your ID inside the frame. Make sure all four corners and the text are visible." The same guidance is given as text beside the preview, not only as an outline drawn on the video. | N |
| A11Y-ID-02 | 4.1.3, 1.3.3, 1.4.1 | Live framing feedback ("move closer", "too dark", "hold still", "ID detected") is given as text in a polite status region and not only by colour change of the guide (green or red frame). The region is rate limited (suggested value, not in the docs: a message changes at most about every 2 seconds; the same message is not repeated). | N |
| A11Y-ID-03 | 2.1.1, 2.5.1, 2.5.2 | Capture is started and confirmed with a button (keyboard and pointer), not a gesture, not by timer alone. For the ID photo, the candidate can use a file upload of a photo taken with their own device camera or phone (a blind candidate often takes photos with the phone's own assisted camera). Any ID image uploaded this way (including from a phone) is a specimen or generated ID image only, never a real ID (section 3 rule 2). Whether upload is allowed is not in the docs: the FSD says "photo of government ID" and "live selfie" only (OQ-A11Y-1). Record what the build does. | N |
| A11Y-ID-04 | 3.3.1, 3.3.3 | Retake and "use this photo" are buttons with names. After capture, the result of the quality check is text, and the candidate may retake as many times as needed; the one retry in FR-403 is for the match, not for retakes (unverified: confirm in the build). | N |
| A11Y-ID-05 | 1.3.3, 1.4.1, 2.2.1 | Liveness prompts (blink, turn head left/right): each prompt is shown as large text and is read aloud by the screen reader in a polite status message ("Please turn your head to the left"), with a countdown or time allowance in text. The candidate is not rushed: each prompt allows enough time (the docs give no number: OQ-A11Y-2). The prompt does not rely on an arrow icon alone. | N |
| A11Y-ID-06 | 2.2.1, 2.2.2 | A prompt that times out gives a retry without ending the session or the test, and the failure routes to manual review (FR-403, D-05) with text saying so ("sent for manual review"). The candidate who cannot perform a prompt (for example cannot turn the head, or blinks involuntarily) is not blocked and is told the next step. Verify no dead end exists: after the retry the stepper moves on. | N |
| A11Y-ID-07 | 2.3.1, 2.2.2 (2.3.3 is AAA) | No flashing and no fast motion in the prompt animation; any animation can be paused or is shorter than 5 seconds. Respect `prefers-reduced-motion`. | N |
| A11Y-ID-08 | 4.1.3 | The result ("Your photo matched", "Sent for manual review", "We could not check; a person will look at it") is announced once in a status region; the match score is not read out; text does not say "failed" in a way that suggests rejection (the system never rejects, C-14). | N |
| A11Y-ID-09 | 1.3.1, 2.4.3 | Focus order inside the step: instruction, preview, capture button, retake, continue. Focus is placed on the heading when the step opens and on the result when the result appears. | N |
| A11Y-ID-10 | 3.3.2, 1.3.1 | Waived variant (C-19, C-25, M-03 Part 2): the ID and selfie steps are skipped or shown as "not required for you"; the page says in text what still runs (system check, room scan, recordings) and what does not (ID photo, selfie, re-check). The accommodation reason is recorded by the recruiter (C-19) and may hold health information (OQ-13): it must never appear in the candidate's page, page source, candidate-facing API responses or announcements. Any appearance is a blocker (candidate data, CLAUDE.md, Working in parallel, rule 3). The step is absent from the stepper progress or named "Skipped", consistently for every AT. The stepper progress count ("Step N of M") is still correct. | N |
| A11Y-ID-11 | 3.3.4 | Privacy notice for the ID image ("never used for other purposes", FR-403) is visible text before capture, and the camera is not opened until the candidate activates the capture button (C-02 and consent ordering). | N |
| A11Y-ID-12 | 2.1.1 | The camera permission prompt for this step (if it is the first camera use) follows A11Y-SYS-05. | N |

### 4.7 Room scan, QR code (STRICT) and practice question (FR-404, FR-405, FR-406)

The task list names the stepper; these three steps belong to it (frontend.md Step 9.6 to 9.8), so they are included.

| ID | WCAG | Check | Auto |
| --- | --- | --- | --- |
| A11Y-ROOM-01 | 1.3.3, 2.2.1, 4.1.3 | The guided 15-second 360-degree scan (frontend.md Step 9.6) gives its instructions as text, announces start, halfway and end in a status region, shows elapsed time as text, and offers a retry. A candidate who cannot rotate the camera (wheelchair, fixed desk, low vision) has a documented alternative path through the recruiter (C-02); the docs do not define it (OQ-A11Y-1). Use a virtual camera with generated footage, or scan an empty room (section 3 rule 2). | N |
| A11Y-ROOM-02 | 1.1.1 | Illustrations of the movement have text alternatives. | Y (presence) |
| A11Y-QR-01 | 1.1.1, 1.3.3 | The QR code (STRICT only) has an alternative: the same link as copyable text, or a "send me a link by email" action, with a name that says what it is. A QR code alone fails for a blind candidate. The phone page, which runs on a phone, passes A11Y-C-01 to C-16 on a mobile browser and with TalkBack or VoiceOver on iOS (optional). Whether a link alternative exists is not in the docs (OQ-A11Y-4). The phone camera and audio follow section 3 rule 2 (empty wall or covered lens; no speech near the phone; no phone screen reader speech). | N |
| A11Y-QR-02 | 4.1.3 | The "phone connected" state is announced when the side camera connects or drops, and a lost side camera is explained in text (TC-036). The phone camera and audio follow section 3 rule 2 (empty wall or covered lens; no speech near the phone; no phone screen reader speech). | N |
| A11Y-PRA-01 | 1.3.1, 2.1.2 | The practice question is the same editor and is subject to every check in 4.8; it says in text that it is untimed and not scored. | N |

### 4.8 Pre-test stepper and final checklist (frontend.md Step 9; FR-401 to FR-406)

| ID | WCAG | Check | Auto |
| --- | --- | --- | --- |
| A11Y-STEP-01 | 1.3.1, 4.1.2 | The progress indicator is an ordered list (or `nav aria-label="Progress"`), the current step has `aria-current="step"`, each step name is text, and completed, current and upcoming states are text, not only colour. The count is correct when steps are skipped (waived identity, no STRICT step). | P |
| A11Y-STEP-02 | 2.4.3, 2.1.1 | Steps that are not yet allowed are not reachable by Tab or are announced as unavailable. Back and Next work by keyboard; the browser Back button does not break the flow or skip consent (consent cannot be skipped by URL, TC-030). | N |
| A11Y-STEP-03 | 4.1.3, 2.4.3 | On step change the new `h1` receives focus (A11Y-C-03) and the step name and number are announced ("Step N of M: System check"). | N |
| A11Y-STEP-04 | 3.3.1, 3.3.3 | Every step that can fail shows its error at the step, not on a later page, with the fix-it hint (see 4.5, 4.6). | N |
| A11Y-STEP-05 | 3.3.4, 2.1.1 | The final checklist (frontend.md Step 9.9) is a list of text items with status, the Start button states what it will do ("Start the test: enters fullscreen and starts recording") and is disabled with a text reason while an item is open (TC-035: Start disabled until the room scan is done). Code hint: the page shows a fixed list of four items each with a hidden "(done)" label, and the disabled-Start reason is an info alert, not text tied to the button (use `aria-describedby` or similar is the doc-side expectation; record what you see). | N |
| A11Y-STEP-06 | 2.2.1 | No step has a time limit other than the ones in the FSD (the room scan duration and liveness prompts); the invitation window and any session-token expiry are stated; a candidate who pauses between steps is not logged out without a warning. Unverified: the docs do not say how long a candidate may take between steps (OQ-A11Y-5). | N |
| A11Y-STEP-07 | 2.4.8 (AAA, record only) | The candidate can tell where they are (progress) and what is next. | N |
| A11Y-STEP-08 | 1.4.10 | At 320 px the stepper collapses without hiding the current step name. | N |

### 4.9 Coding test screen (FR-501 to FR-506, FR-601 to FR-604, TC-040, TC-041, TC-046, TC-050)

Layout (code, mocked at `/t/demo/test`): a header with the test title, section, two timers, a saved indicator, a warnings pill and a theme toggle; a question panel (statement, sample tests, MCQ options); an editor with Run; an output panel; a section navigator; a Finish section dialog. All of it is hints from the code; the requirement is the doc text.

Monaco and the editor

| ID | WCAG | Check | Auto |
| --- | --- | --- | --- |
| A11Y-ED-01 | 2.1.2 | No keyboard trap in the editor. Tab inserts an indent (the page says so). The documented way out (page text: "press Ctrl+M, then Tab") works on the tester's OS. On macOS, Monaco's toggle may be Ctrl+Shift+M (unverified; check the current Monaco docs for the build's version); if the on-page text is wrong for that OS it is a should-fix, and if there is no way out at all it is a blocker (A11Y-ED-02). | N |
| A11Y-ED-02 | 2.1.2 | Starting in the editor with the keyboard only, the candidate can reach Run, Reset, the question navigator and Finish section, and from those return to the editor. If the escape key combination is intercepted by the proctoring layer (FR-603 blocks "common devtools shortcuts" and logs SHORTCUT_BLOCKED), it still works and is not logged as a violation: pressing Ctrl+M and Tab produces no event of kind SHORTCUT_BLOCKED, FOCUS_LOST or PASTE_ATTEMPT. Also check that F1/Alt+F1 (screen-reader help) is not blocked by the shortcut blocker (unverified which keys the SDK blocks; the list is in packages/proctor-sdk, not in the docs). | N |
| A11Y-ED-03 | 4.1.2, 1.3.1 | The editor has an accessible name ("Your answer" / the code editor's `ariaLabel`), a role (textbox with multiline), and tells the screen reader the language. The language selector is a labelled select. | P |
| A11Y-ED-04 | 1.3.1, 4.1.3 | Screen-reader mode. Monaco's `accessibilitySupport: 'auto'` (code) relies on platform detection; in a browser, detection often fails. Check: with NVDA and VoiceOver running, can the candidate read the code line by line, hear the line content as the cursor moves, and hear selection? Is there a visible way to switch the editor to screen-reader-optimised mode and is it keyboard reachable and announced? Record whether Monaco switched on its own, and what the help dialog (Alt+F1 in standalone Monaco; unverified for this build) says. If a screen-reader user cannot read their own code reliably, it is a blocker (the candidate cannot complete the test). BR-12 requires screen-reader support as an accommodation (docs/brd.md:71), and FR-305 lists "allowed assistive tools" without defining them (OQ-A11Y-6). | N |
| A11Y-ED-05 | 2.4.7, 1.4.11 | The editor cursor, selection, line numbers, bracket matches and syntax token colours meet 4.5:1 (text) and 3:1 (the cursor and selection) in the theme used (`codeproctor-dark` in code). The Monaco theme is a fixed dark theme while the page has a light/dark toggle: check both do not leave low-contrast text in the editor chrome, the loading text and the read-only state. | N |
| A11Y-ED-06 | 1.4.4, 1.4.10, 1.4.12 | At 200 percent the editor font scales (browser zoom); at 320 px the editor and Run are still reachable. A way to increase the editor font independent of browser zoom is not required at AA, but note whether one exists. | N |
| A11Y-ED-07 | 2.1.1 | Autocomplete limited to language keywords (FR-501): the suggestion list is operable by keyboard and the selected item is announced. Quick suggestions do not open on every keystroke for a screen-reader user in a way that interrupts reading (record the behaviour). | N |
| A11Y-ED-08 | 1.3.1, 3.3.2 | Read-only state (locked editor after a fullscreen exit): exposed as read-only (`aria-readonly` or Monaco's own state); announced on lock and on unlock. | N |
| A11Y-ED-09 | 2.1.1 | Pasting, drag and drop and the context menu are blocked (FR-603, code `contextmenu: false`). Check the blocks do not stop assistive technology that inserts text: dictation (Windows Voice Access, macOS Dictation, Dragon), on-screen keyboards and switch/word-prediction software. For each, type a short function. Live dictation is spoken audio and the microphone is recorded on this screen, so it follows section 3 rule 2: feed the dictation engine TTS or generated audio on a separate input (never the tester's own voice), keep the browser microphone on the generated-audio virtual device, and use headphones. Use the on-screen keyboard and switch software with no voice at all. If it works, and the editor logs a PASTE_ATTEMPT or PASTE_BURST (red-team RT-23 lists "the browser's accessibility dictation" as a way text can land in the editor and be flagged), record it: this is a conflict between the integrity design and BR-12, not a defect in either alone, so file it as an open question to the hub (OQ-A11Y-7) and tell the reviewer-facing doc owners that dictation can look like a paste burst. | N |

Panels, focus order and landmarks

| ID | WCAG | Check | Auto |
| --- | --- | --- | --- |
| A11Y-TS-01 | 1.3.1, 2.4.1, 2.4.6 | One `h1` (the test title, code), landmarks for the header, the question region, the editor section and the output (code: regions labelled "Question statement", "Your answer", "Output"). Each region has a unique name. A screen-reader user can jump between them by landmark or region key. | P |
| A11Y-TS-02 | 1.3.2, 2.4.3 | Focus and reading order is: header (timers, saved status, warnings), question navigator, statement, sample tests, answer controls or editor, Run/Submit, output. It follows the visual order in both the wide layout and the 320 px layout. | N |
| A11Y-TS-03 | 2.4.4, 4.1.2 | Section navigator: the current question has `aria-current`; each button name includes the question number or title; a question changed by keyboard moves focus to the new question heading and announces it. | P |
| A11Y-TS-04 | 2.1.1, 2.4.3 | Scrollable regions (statement, output) are focusable and scroll with the keyboard (code has `tabindex=0` with an axe note). | Y |
| A11Y-TS-05 | 1.3.1, 3.3.2 | MCQ options are a `fieldset` with a `legend` (code: "Answer options" as `sr-only`; the visible question text is the better legend, check the group name read by the SR includes the question). Short-answer fields have a visible label. | P |
| A11Y-TS-06 | 1.4.4, 1.4.10 | At 320 px width the layout stacks into one column; no horizontal scroll except the editor; the timers stay visible or reachable at the top. | N |
| A11Y-TS-07 | 1.4.1 | Sample-test results show pass or fail by icon plus text ("Passed" / "Failed") and not green and red alone. | N |
| A11Y-TS-08 | 1.1.1 | The statement (rendered markdown) keeps alt text for images, table headers for tables, and code blocks readable by a screen reader. Problem statements are authored by staff: authoring guidance for alt text is a gap (OQ-A11Y-8). | P |

Run, Submit and results announcements

| ID | WCAG | Check | Auto |
| --- | --- | --- | --- |
| A11Y-RUN-01 | 4.1.3 | When Run finishes (FR-502, TC-040: "Sample results shown in under 5 s"), the output panel (code: `aria-live="polite"`) announces a short summary ("2 of 3 sample tests passed") and not the whole output. Compile errors and runtime errors are announced (`role="alert"`) once. The summary is not announced twice. Focus stays in the editor or on Run. | N |
| A11Y-RUN-02 | 4.1.3, 3.3.1 | While running, the Run button is exposed as busy (name changes to "Running..." or `aria-busy`) and the SR is told "Running" once. | N |
| A11Y-RUN-03 | 3.3.1, 4.1.3, 2.2.1 | Run rate limit (FR-502, TC-041: 1 per 5 s): the message "Wait N seconds" is text and is announced once when the click is refused (not each second); the button is `aria-disabled` and still focusable (code uses `aria-disabled`); when the wait ends the SR is told it can run again, or it is not told at all (no spam). A candidate who pressed Run three times (TC-041) is not left unsure whether the run started. | N |
| A11Y-RUN-04 | 2.1.1 | Run and Submit have keyboard shortcuts (if any) that are listed in text and do not collide with a screen reader's keys (Ctrl+Enter is common; check NVDA, JAWS, VoiceOver). | N |
| A11Y-RUN-05 | 4.1.3, 3.3.4 | Submit (per question) and hidden tests: the candidate is told the submission was received (without hidden-test results, which are not shown, FR-502 and FR-506); a status message is announced. No result text that depends on colour only. | N |
| A11Y-RUN-06 | 4.1.3 | Autosave (FR-504, every 10 seconds): routine "Saved at hh:mm" changes are not live (code comment says only a failed save is announced). Verify no announcement every 10 s. A failed autosave is announced as an alert and says what to do. | N |
| A11Y-RUN-07 | 4.1.3 | Output in long runs (stdout up to some limit): the live region does not read tens of lines; a very long stdout is available by navigating into the region, not pushed to the reader. | N |

Timer and time limits

| ID | WCAG | Check | Auto |
| --- | --- | --- | --- |
| A11Y-TIM-01 | 4.1.3, 2.2.1 | Timer announcements: the visible countdown (`role="timer"`) is not a live region (implicit `aria-live` off) and is never announced each second. The only spoken messages are at five minutes and one minute left for the section and for the test (code: `timerWarning` thresholds), and one alert at time up. Pass criterion: one announcement per threshold per timer (five minutes, one minute) plus one time-up alert; count them in the transcript. Known risk to verify: the code joins the section and test messages into one polite region (test-screen.tsx, `announcement`), so when the section window and the test window overlap (for example the last section, or a section of 5 minutes or less inside a test with 5 minutes or less left) an already-spoken section message may be spoken again when the test message appears. Check this case on purpose: a single repeat is a should-fix; repeats that make the page unusable with a screen reader are a blocker. Both timers crossing together produce two short sentences, not an interruption of typing. | N |
| A11Y-TIM-02 | 4.1.3 | The announcements are polite and do not move focus or interrupt the SR reading the editor. If NVDA or VoiceOver cuts off the line being read, record it as should-fix, not blocker. | N |
| A11Y-TIM-03 | 2.2.1 | Time limit adjustment for accommodations. A candidate must be able to get more time: FR-305 and FR-301 provide per-candidate extra time as a percentage that scales the total and the section limits (ADR 0002). Check, as the recruiter, that the extra time can be set before the invite is opened (invitation form) and that, as the candidate, the timers show the extended time from the start. Check the candidate is told, in text, how much time they have at the start and that it includes the extension. The WCAG 2.2.1 exceptions for real-time events and essential time limits (a timed assessment is essential) are why there is no turn-off, but the criterion still expects extension where possible; extra time by percentage is the mechanism. What is not in the docs: whether extra time can be added during the test (a candidate who finds mid-test that they need more time), and the largest percentage (OQ-A11Y-9). | N |
| A11Y-TIM-04 | 2.2.1 | Server timer is the source of truth (FR-505, TC-047). Check that client clock changes, a reduced-motion setting or a background tab do not change the displayed time away from the server value by more than a second after the next sync. | N |
| A11Y-TIM-05 | 2.2.1 (best practice) | Any time warning text can be read again: the remaining time is available on demand (the timer element is focusable or reachable in browse mode, and the SR can read "Section time left 14:05" at any moment). | N |
| A11Y-TIM-06 | 3.3.1 | "Time is up" message (code: alert banner "Your latest saved work is submitted automatically") is announced once, and the final state (SUBMITTED, TC-046) is reachable and readable afterwards. | N |
| A11Y-TIM-07 | 2.2.1 | If the clock cannot be checked with the server, the page pauses the editor and shows an alert with a "try again" button and says time is not affected (code). Check it is announced, focusable, and that the pause does not remove typed text. The server timer keeps running (FR-505, FR-609, ADR 0002), so "your time is not affected" must be true: confirm against the staff view that time kept running or was not lost, as the docs define, and file a defect if the text is wrong. | N |

Fullscreen, proctoring warnings and re-entry (FR-601, FR-604, FR-609; TC-050, TC-054, TC-055)

| ID | WCAG | Check | Auto |
| --- | --- | --- | --- |
| A11Y-LOCK-01 | 4.1.2, 4.1.3, 2.4.3 | Lock overlays (fullscreen exit, share stopped, side camera lost, focus lost, proctor pause; frontend.md Step 10) open as an alert dialog (code: `role="alertdialog"` for the fullscreen overlay; the existing e2e asserts it). On open: the title and the description are read, focus moves inside to the "Re-enter fullscreen" button, background content is inert. | Y (role, e2e), N (focus) |
| A11Y-LOCK-02 | 2.1.2 | The overlay is the only intended keyboard "trap" (manual-tests.md step 1): Tab cycles inside the overlay, Esc does not dismiss it (code blocks it), and the Re-enter button is focusable and can be activated with Enter and Space. The browser requires a user gesture to enter fullscreen; check that Enter/Space on the button counts as one (it does in Chromium; record per browser). If the keyboard cannot re-enter fullscreen, it is a blocker. | N |
| A11Y-LOCK-03 | 2.4.3 | After re-entry, focus returns to the editor (or to where it was), not to the top of the page, and the unlock is announced ("Editor unlocked"). | N |
| A11Y-LOCK-04 | 3.3.1, 4.1.3, 1.4.1 | The text says what happened, that the editor is paused, that time keeps running (code says so; it must match ADR 0002: only a proctor pause stops the clock), that it was recorded and the warning count. A screen reader hears the count (code: "Warnings so far: N"). The pill in the header (warnings count) is not a live region and is not announced every time unless the overlay is shown. | N |
| A11Y-LOCK-05 | 2.2.1 | Screen share stopped (TC-055) and the re-share flow: the overlay says what to choose in the browser picker (entire screen, TC-054), has a text fix-it hint, and the picker prompt is reachable by keyboard (A11Y-SYS-05). Window-only share rejection shows an error that is announced. | N |
| A11Y-LOCK-06 | 2.1.1 | Fullscreen and assistive tools: fullscreen is mandatory (FR-601). Check that a screen magnifier (Windows Magnifier, macOS Zoom), NVDA's or VoiceOver's own windows, and the "allowed assistive tools" of FR-305 do not themselves cause FULLSCREEN_EXIT, FOCUS_LOST or TAB_SWITCH events that count as warnings. Run NVDA and VoiceOver (including their speech viewer or caption panel) through a 5-minute test and compare the events with a run without AT (expect FR-610 virtual-camera events in both). Also run once with the screen reader output on speakers and once on headphones, and compare the audio events (SPEECH_DETECTED, MULTIPLE_VOICES, FR-607). In the speakers run, route the system audio output into the browser's virtual microphone through a loopback (for example BlackHole or VB-Cable); the physical microphone is NEVER selected in the browser, so the room is never recorded. Speech from the reader picked up by the microphone must not count against the candidate, and a candidate who cannot wear headphones (hearing aids, implants) must not be flagged for that. Any AT-caused warning is an issue to log with the owner (integrity) and the open question OQ-A11Y-10 (does FR-305 "allowed assistive tools" cover this, and how does the reviewer know?). If AT causes a lock the candidate cannot recover from by keyboard, it is a blocker. | N |
| A11Y-LOCK-07 | 4.1.3 | Proctor message toast (live channel; frontend.md Step 10) is announced politely, stays at least a suggested 5 seconds or until dismissed with a keyboard-reachable control (2.2.1; 2.2.3 is AAA), and does not take focus away from the editor. | N |
| A11Y-LOCK-08 | 4.1.3 | Reconnect (FR-609, TC-063): "connection lost, time continues" and "reconnected" are announced once each, not repeated each heartbeat (10 s). | N |
| A11Y-LOCK-09 | 4.1.2 | Notices about recording (camera/mic indicator in the page) have text. The recording status is not only a red dot. | N |

### 4.10 Submit, finish and section completion (FR-301, FR-505, FR-506; ADR 0002)

| ID | WCAG | Check | Auto |
| --- | --- | --- | --- |
| A11Y-FIN-01 | 4.1.2, 3.3.4, 2.4.3 | "Finish section" opens a dialog (code: `DialogTitle` and `DialogDescription`) that says it cannot be reopened. Focus moves in, Esc and "Keep working" close it, focus returns to the Finish button. The default focus is not the destructive button, or a screen reader user hears the warning text before the focused button name (verify). | N |
| A11Y-FIN-02 | 3.3.1, 4.1.3 | When the server cannot be reached the dialog shows an error (code: `role="alert"` plus "Try again") that is announced and keeps focus in the dialog; the section stays open. | N |
| A11Y-FIN-03 | 4.1.3, 2.4.3 | After finishing a section, the status message "The X section is finished and cannot be reopened" (code: `role="status"` fixed box) is announced, and focus moves to "Continue to the next section" or the next heading; the status box does not cover the editor or Finish at 320 px or 200 percent zoom (it is `fixed` at the bottom). | N |
| A11Y-FIN-04 | 3.3.4 | "Finish test" has a confirmation that states the effect and the time left, and the final screen says the test is submitted and what happens next (every session is reviewed by a person, C-28; the candidate sees no result: do not announce a score). | N |
| A11Y-FIN-05 | 1.3.1, 2.4.2 | The final page has an `h1`, a unique title and is the end of the flow: no editor remains focusable; recording stops; the candidate is told the recording has ended and fullscreen can be left (announced). Fullscreen exit after finish does not show the fullscreen warning overlay. | N |
| A11Y-FIN-06 | 3.3.4, 4.1.3 | Auto-submit at time zero (TC-046): the SR is told the work was submitted; focus is not left in a now-closed editor. | N |
| A11Y-FIN-07 | 1.3.1 | The optional demographic form (C-13, FAIR-01, not built) is a separate form with its own consent, a labelled "Prefer not to say" in every group, and does not delay or block the test result. Run when built (manual-tests.md M-06 step 1). | N |
| A11Y-FIN-08 | 4.1.3 | The "appeal" path (FR-904, TC-080) is not a candidate-test screen in this build; add its checks when the screen exists (unverified whether it is in scope for TC-092). | N |

### 4.11 Error, timeout and terminal states

Existing pages: public errors (expired, used, forbidden; apps/web/src/app/(public)/errors) and the candidate terminal screens in apps/web/src/features/candidate-flow/terminal-screens.tsx (already used, expired, not yet open, blocked, declined, session ended, service unavailable, invalid link). The submitted screen is `SubmittedPanel` in test-screen.tsx (4.10). Run each. The global error boundary, the 404 page and the root error page exist (apps/web/src/app/error.tsx, global-error.tsx, not-found.tsx); run them too. Only the rate-limit page is unverified (not found in apps/web/src/app).

| ID | WCAG | Check | Auto |
| --- | --- | --- | --- |
| A11Y-ERR-01 | 1.3.1, 2.4.2, 3.3.1 | Each terminal page has an `h1`, a unique title, a plain explanation, the next step (contact the recruiter or the test's contact), and focus on the heading on load. | P |
| A11Y-ERR-02 | 2.2.1, 3.3.1, 4.1.3 | Session timeouts: if the candidate token or the OTP session can expire while the candidate is on a screen (unverified in the docs), a warning appears before expiry, is announced, and the candidate can extend or re-authenticate without losing typed text. During a test, a token expiry never discards code (TC-045 autosave covers the data; this checks the message and the focus). | N |
| A11Y-ERR-03 | 4.1.3 | Network failures (offline, 5xx) show a text message in an alert region once, with a retry button; they do not repeat. | N |
| A11Y-ERR-04 | 3.3.1 | 429 or lock pages say how many seconds to wait (see A11Y-OTP-04, A11Y-RUN-03). | N |
| A11Y-ERR-05 | 1.4.3, 1.4.1 | Error pages meet contrast; red text is accompanied by a word or icon with a text name. | P |
| A11Y-ERR-06 | 2.1.1 | The error boundary pages (apps/web/src/app/error.tsx, global-error.tsx) and the 404 page (not-found.tsx), which exist, have a reachable "Try again" (error pages) and a way to contact the recruiter; the page is announced. The rate-limit page is unverified. | N |
| A11Y-ERR-07 | 3.3.1 | Messages never include a token, OTP, presigned URL or object key (CLAUDE.md). A screen-reader transcript or a page-source check finds none. | N |
| A11Y-ERR-08 | 2.2.1 | "Link expired" (errors/expired) states that the window has closed and gives the way to ask for a new link; for a candidate who needed more time because of an accommodation, the same page gives the accommodation route (C-02). | N |

## 5. Manual script: keyboard only (run on every screen first)

Needs: Chrome (current) and Edge on Windows or macOS, no mouse and no trackpad (unplug it or do not touch it), every screen in section 4 that exists. Also run once with the OS "Full keyboard access" on macOS (System Settings, Keyboard) so buttons and selects are reachable.

1. Load the screen. Press Tab once. Expected: a skip link or the first control gets a visible focus ring (A11Y-C-04). Press Tab through the whole page. Expected: order matches the visual and reading order; nothing is skipped; nothing hidden receives focus.
2. Press Shift+Tab back to the start. Expected: reverse order, no trap.
3. For each button, link and field, operate it: Enter and Space for buttons, Space for checkboxes, arrows for radios and selects, Enter for links. Expected: every action available to a mouse user is available.
4. Open each dialog (decline confirm, finish section, finish test, fullscreen overlay). Expected: focus moves in, Tab stays in, Esc closes (except the fullscreen overlay and other lock overlays, where Esc must not close it but Re-enter is focusable), focus returns to the opener.
5. Consent screen: reach the end of the document with Arrow, Page Down, Space or End; tick the 18+ box with Space; type the synthetic name (section 3 rule 2; never your own); Tab to Sign; Enter. Expected: success with no mouse. Then repeat to Decline.
6. Editor: click nothing. Tab into the editor, type three lines of code, press Tab (an indent is inserted), press Ctrl+M (macOS: try Ctrl+Shift+M if Ctrl+M does nothing) then Tab. Expected: focus leaves the editor to the next control (A11Y-ED-01). Shift+Tab back in.
7. From the editor reach Run, press Enter. Expected: results; Tab to the output panel and scroll it with arrow keys (A11Y-TS-04).
8. Press Esc to leave fullscreen (or use the demo's simulate button). Expected: the overlay appears, focus is on Re-enter, Enter re-enters fullscreen, focus returns to the editor (A11Y-LOCK-01 to 03).
9. Reach Finish section; open the dialog; cancel; reopen; confirm. Expected: see A11Y-FIN-01 to 03.
10. Record the screen, the step number, the key pressed and the result of any failure, with the WCAG criterion.

Pass: every control reachable, visible focus, no trap other than the lock overlay (which has a focusable Re-enter button).

## 6. Manual script: NVDA with Chrome (and Firefox), Windows

Needs: NVDA current release, Chrome, a speech viewer on (NVDA menu, Tools, Speech viewer) to save the transcript. Reset NVDA settings or note any non-default setting (browse mode auto focus mode, report of dynamic content changes).

1. Start NVDA. Open the first available candidate screen. Press Insert+Down (say all) and listen. Expected: page title, `h1`, any placeholder banner, and the content, in reading order.
2. Press H, 1 to 6, D (landmarks) and K (links), B (buttons), F (form fields). Expected: headings in order; landmarks `main` and labelled regions; links have names that make sense out of context.
3. Consent: in browse mode move through the document with the Down arrow to the last paragraph; do not scroll with the mouse. Expected: Sign becomes enabled and the SR says so (A11Y-CON-03). Then Tab to the 18+ box. Expected: "I confirm I am 18 years old or older, checkbox, not checked, required" (the exact words differ). Type the synthetic name (never your own); leave 18+ unticked; activate Sign. Expected: the error is spoken once and focus is on the checkbox (A11Y-CON-06).
4. Decline: Expected announcements per A11Y-DEC-02 and 03. The declined page is announced with the recruiter's name and email.
5. System check: trigger each check. Expected per A11Y-SYS-02: one polite message per result. Deny the camera at the browser prompt. Expected: a fix-it message is announced (A11Y-SYS-03).
6. Identity: reach the selfie step. Expected: the instruction is spoken, then each liveness prompt once (A11Y-ID-05), then the result (A11Y-ID-08).
7. Test screen: Expected on load: test title (`h1`), section text, two timers with names ("Section time left, 14:05"), saved status. Press Tab to the editor. Expected: its name and role are spoken (A11Y-ED-03). Type two lines and use Up and Down. Expected: each line is read. Use NVDA+Ctrl+Space to switch to focus mode if NVDA did not switch itself, and record this. Press Alt+F1 in the editor and record what is spoken or displayed (A11Y-ED-04).
8. Press Run (Enter on the button). Expected: "Running" once, then one summary line (A11Y-RUN-01/02). Press Run again within 5 seconds. Expected: one message about waiting (A11Y-RUN-03), no repetition each second.
9. Leave the test running. Let the section timer cross five minutes, one minute and zero (use a short test, or the demo with the clock sped up, never by changing the OS clock; the server timer is the source of truth, TC-047). Expected: exactly "Five minutes left in this section.", "One minute left in this section." and the time-up alert (A11Y-TIM-01). Count the timer messages in the speech viewer.
10. Wait 60 seconds typing nothing. Expected: no autosave announcements (A11Y-RUN-06).
11. Exit fullscreen. Expected: the alert dialog name and description are read ("You left fullscreen... Your time keeps running"), focus on Re-enter. Activate it. Expected: the editor is described as editable again (A11Y-LOCK-01 to 03).
12. Finish section: Expected: the dialog title and its description before the buttons; after confirming, the status message "section is finished and cannot be reopened" (A11Y-FIN-01/03).
13. Save the transcript, remove anything resembling a token or code, and attach it to the result record.

Firefox pass: steps 1 to 4 only (consent and decline) plus the unsupported-browser block message (TC-031, A11Y-SYS-08).

## 7. Manual script: VoiceOver with Safari (and Chrome), macOS

Needs: VoiceOver on (Cmd+F5), Safari current, then Chrome. Use the VoiceOver Utility "Verbosity" defaults and note changes. Use the Caption Panel (VO+Shift+F10 or in VoiceOver Utility, Visuals) to save text.

1. Safari: open the invite link. Expected: the browser check shows a block message for a STANDARD test (TC-031). Read it with VO+A (read all). Expected: clear text with the supported browsers and what to do. This is the Safari-only part of the flow.
2. Switch to Chrome with VoiceOver on. Use the Web Rotor (VO+U) to list headings, landmarks, links, form controls. Expected: the same structure as section 6 step 2.
3. Consent in Chrome: use VO+arrows to read to the end of the document; use VO+Shift+Down to interact with the scroll area if needed. Expected: Sign becomes enabled and is announced or findable (A11Y-CON-03). Note whether VoiceOver's reading counts as reaching the end; this is the highest-risk check on this screen.
4. 18+ box: Expected: checkbox state spoken on VO+Space. Error cases as section 6 step 3.
5. Decline and declined page as in section 6 step 4.
6. Test screen in Chrome: interact with the editor (VO+Shift+Down), type, move by line. Expected: lines are read. Open the Accessibility help (Alt+F1) and record. Check Ctrl+Shift+M for the Tab-focus toggle if Ctrl+M does not work (A11Y-ED-01).
7. Run, timers, lock overlay, finish section: as section 6 steps 8 to 12. Expected: the same announcements, in VoiceOver's wording.
8. macOS Full Screen: with VoiceOver, exit and re-enter fullscreen with the on-page button (A11Y-LOCK-02). Record whether VoiceOver focus stays on the page after fullscreen.
9. Optional JAWS (Windows, Chrome): repeat sections 6 steps 3, 7, 8, 9 and 11; JAWS uses virtual cursor and forms mode; record version.

## 8. Manual script: zoom, reflow, spacing, contrast, voice control

1. 200 percent zoom (Ctrl +, five steps from 100 percent) at 1280 px: each screen shows no clipped text, no overlapping, all controls reachable (A11Y-C-08).
2. 320 CSS px width: set the DevTools device to a 320 px width, or zoom to 400 percent at 1280 px. Expected: single column; no horizontal scroll on form screens; the editor may scroll sideways; the timers and the Run button remain reachable; the fixed status box (A11Y-FIN-03) does not cover controls.
3. Text spacing (A11Y-C-09): apply the spacing override. Expected: no loss.
4. Colour: use a contrast checker on text, focus ring, input borders and the level meter in light and dark themes (A11Y-C-05, C-06). Use the browser's forced-colors emulation in DevTools; the focus ring, checkbox and button borders stay visible.
5. Voice control (Windows Voice Access or macOS Voice Control). Never speak live on a recorded screen (section 3 rule 2). Live speech: only on the consent and decline screens, before consent is signed (nothing is recorded, TC-030). First switch the browser microphone to the virtual device, and pause Voice Control or Voice Access as soon as Sign is activated: say "click Decline" (on a scratch session) and "click Sign". On the recorded screens (test screen, system check, identity): play the commands as TTS audio into the OS voice input (a separate virtual input or a loopback, not the microphone the browser records), with the browser microphone on a virtual device carrying generated audio, and use headphones. Commands: "click Run", "click Re-enter fullscreen". Expected: each is activated by its visible label (A11Y-C-11).
6. Reduced motion: set the OS reduce-motion option; liveness prompt animations and the level meter respect it (A11Y-ID-07).

## 9. Defect severity and result record

### 9.1 Severity mapping

Review rule (CLAUDE.md, Working in parallel, rule 2): only blockers stop a merge or a pilot; should-fix and nits go to the owner track's follow-up file. Rule 3: weaknesses in authentication, authorization, session handling, cryptography or access to candidate data are always blockers.

| Severity | Definition | Examples | Handling |
| --- | --- | --- | --- |
| Blocker (P1) | A candidate with the assistive technology in section 3 cannot give or refuse consent, cannot decline, cannot get past a pre-test step, cannot read or write their code, cannot Run or Submit, cannot recover from a lock overlay, or loses work or time because of the problem. Also: an accessibility feature that leaks candidate data or a token (rule 3). | Sign never enables for a screen-reader user (A11Y-CON-03); the 18+ box has no label; Decline not reachable by keyboard; liveness has no route that continues (A11Y-ID-06); editor keyboard trap with no way out (A11Y-ED-01/02); Re-enter fullscreen not operable by keyboard (A11Y-LOCK-02); AT causes an unrecoverable lock (A11Y-LOCK-06); timer chatter every second that makes the page unusable with a screen reader (A11Y-TIM-01); a manual finding that blocks the task, for example contrast so low that text cannot be read (any axe failure fails CI separately, section 2); the waiver reason or any token appearing in the candidate page, page source or announcements (A11Y-ID-10). | Blocks the PR that introduces it, and the pilot gate (TC-092 is P1). File with the FR, TC and C IDs and the criterion. |
| Should-fix (P2) | The candidate can complete the flow but with real difficulty, or a criterion at AA fails without stopping the flow. | Focus ring or text contrast below the threshold that still lets the text be read; error not linked with `aria-describedby`; announcement repeated twice; link name unclear; zoom clipping that still allows the action; wrong on-page hint for the Tab-focus key on one OS; extra announcements that interrupt reading. | Owner follow-up file (docs/followups/<track>.md) in the PR that finds it, with the criterion. Proposal for the Delivery Lead (no source in the docs): a pilot launch with open should-fix items needs a written note from the Delivery Lead. |
| Nit (P3) | Not a WCAG 2.1 AA failure: AAA, WCAG 2.2-only, wording, reading level, tooltip text, tiny touch target on desktop. | Reading level; touch target under 24 px; heading wording. | Follow-up file. |

Rule of thumb: ask "if a candidate who relies on this input hit it during a timed, proctored test, would they be unable to finish or unable to say no?" If yes, blocker.

Owner agents: pre-test stepper screens and test screen markup, focus and live regions: frontend-engineer. Event handling for AT-caused warnings, SDK shortcut blocking, fullscreen logic: proctor-sdk and integrity (the owners in the matrix). Consent text and its structure: the Delivery Lead (C-09). Extra time and accommodation settings: backend-engineer. Docs gaps: architecture hub.

### 9.2 Result record template

Copy one block per run. Keep it in the PR description or the test-matrix evidence; never include a token, OTP, URL with a key, or real personal data.

```text
Run id:            A11Y-<yyyymmdd>-<n>
Tester:            <name> (not the author of the feature)
Date / time:       <>
Build:             <commit sha> on <staging | local build>
Environment:       OS <> / browser <version> / viewport <> / theme <light|dark> / zoom <>
Assistive tech:    <NVDA x.y | VoiceOver macOS x | JAWS x | keyboard only | none> + speech viewer saved <yes|no>
Data:              synthetic only <yes>  generated face source <>  ID source <specimen>
Screen:            <consent | decline | system check | identity | room scan | QR | practice | stepper | test | finish | error>
State:             <default | error | disabled | dialog open | locked | waived-identity | extra-time>
Automation:        axe run <pass|fail|not run>  violations <ids>
Checks:
  A11Y-<id>   pass | fail | n/a | not built   WCAG <sc>   note <what was heard or seen>
  ...
Announcements heard (timer test): 5-min section <n>  1-min section <n>  5-min test <n>  1-min test <n>  time-up <n>  other <n>
Defects:           <id>  severity <blocker|should-fix|nit>  criterion <>  FR/TC/C <>  owner <agent>  steps / expected / actual
Result:            pass | pass with should-fix | fail (blocker)
Clean-up done:    <session deleted through TC-094 flow yes|no>
```

The TC-092 matrix row stays "Partial pass" until every screen in section 4 has a passing record for the P1 combinations in section 3 and axe passes for all of them; QA A sets the row status from the records.

## 10. Test matrix rows to add (QA A; QA B does not edit /docs/test-matrix.md)

TC-092 is one case in the docs; this file splits it into the following evidence rows. QA A decides the final form.

| Proposed row | Level | Notes |
| --- | --- | --- |
| TC-092 (existing) | e2e (axe, partial) plus manual | Add "manual: docs/qa/accessibility-checklist.md" to the location column. |
| TC-092 consent and decline screens, axe | e2e | Stepper is built (FE-09); real-browser run needed: default, error, dialog open. |
| TC-092 system check, identity (including waived), room scan, QR, practice, final checklist, axe | e2e | Each state with its own DOM. |
| TC-092 test screen states: lock overlay, finish dialog, time-up banner, error banner, output with results, MCQ, locked editor, axe | e2e | Today only start gate and running state. |
| TC-092 timer announcements | unit or e2e | Threshold count (A11Y-TIM-01). |
| TC-092 reflow at 320 px | e2e | No horizontal scroll on form screens. |
| TC-092 keyboard-only script | manual | Section 5. |
| TC-092 NVDA script | manual | Section 6. |
| TC-092 VoiceOver script | manual | Section 7. |
| TC-092 zoom, spacing, contrast, voice control | manual | Section 8. |

Follow-up entries for the hub and owners are in docs/followups/qa.md (FU-QAB-10).

## 11. Open questions and doc gaps (not invented here)

| ID | Question or gap | Why it matters | Suggested owner |
| --- | --- | --- | --- |
| OQ-A11Y-1 | The docs give no accessibility alternative for the camera-dependent steps: ID photo (file upload from the candidate's own phone?), selfie liveness (blink, turn head), the 360-degree room scan. C-02 sends refusals and inability to the recruiter, and C-25 and ADR 0015 (proposed) define "no identity check" and "face detectors off", but nothing says the candidate can request these themselves from the screen, or that the screen offers a clear route to "I can't do this step". | A candidate with a motor or vision disability could hit a dead end (blocker) | architecture hub, Delivery Lead (C-02 follow-through) |
| OQ-A11Y-2 | Time allowed per liveness prompt and per retry is not specified. | WCAG 2.2.1; the prompt may be impossible for some | integrity / frontend |
| OQ-A11Y-3 | No rule for a candidate who cannot use a microphone (deaf or speech-impaired users may still be recorded; a mic is only an input to FR-607). FR-402 requires the microphone check; C-02 mentions a candidate who "cannot use the microphone". | Same dead-end risk | Delivery Lead, hub |
| OQ-A11Y-4 | The STRICT QR link has no stated text alternative. | A blind candidate cannot scan a QR code | frontend |
| OQ-A11Y-5 | Pre-test inactivity timeout and candidate session-token lifetime are not found in the docs I read (ADR 0002 covers the invitation window and the OTP block; the OTP expiry is documented as 10 minutes in ADR 0003 and ADR 0002 D-21). | WCAG 2.2.1 needs a warning and extension for adjustable limits | backend / hub |
| OQ-A11Y-6 | FR-305 says "allowed assistive tools" but does not list them or say how the integrity layer treats them. BR-12 says "screen-reader support". Which tools are expected (NVDA, VoiceOver, JAWS, magnifiers, dictation, switch devices)? | Defines what this checklist must accept as allowed | Delivery Lead, hub |
| OQ-A11Y-7 | Paste, drop and context-menu blocking (FR-603) and the PASTE_BURST analysis may flag assistive input (dictation, on-screen keyboards, text-expansion for motor disabilities; the red-team plan RT-23 already lists "accessibility dictation" as a bypass). How do reviewers tell the difference, and is there an accommodation switch (a per-candidate "assistive input" allowance that changes the flag but never removes it)? | Fairness: BR-12, C-14 (flags only; a human decides) | integrity, hub |
| OQ-A11Y-8 | Authoring guidance and a publish check for question statements (alt text for images, table headers, no information in colour). | Problem statements are staff content shown to candidates | frontend (authoring screens), hub |
| OQ-A11Y-9 | Extra time: maximum percentage, whether it can be added during the test, and whether a candidate can request it from the screen. FR-305 and ADR 0002 only say it scales section limits by the same percentage. | WCAG 2.2.1 time extension | backend, hub |
| OQ-A11Y-10 | Do assistive technologies (a screen magnifier, a screen reader's own windows, a switch controller) cause FULLSCREEN_EXIT, FOCUS_LOST or TAB_SWITCH events, and how are they distinguished in review? Not known; the checks in A11Y-LOCK-06 find out, including whether a screen reader's speech through speakers raises audio events (SPEECH_DETECTED, MULTIPLE_VOICES) and how a reviewer tells it apart. | A disabled candidate must not accrue warnings for using the tools the org allowed | integrity |
| OQ-A11Y-11 | Whether outside assistive-technology users may take part as testers under the volunteer consent form (C-11, C-20). | Tester recruitment | Delivery Lead |
| OQ-A11Y-12 | Unclear whether the browser check (TC-031) runs before the consent document. If it does, a Safari or Firefox VoiceOver or NVDA user cannot read consent in their own browser; if the consent comes first they can. | Which combination reads which screen | frontend, hub |
| OQ-A11Y-13 | The wording on screen is not fixed by the FSD for most flows (manual-tests.md, compliance section intro). Announcements in the scripts are written as meaning, not as exact strings; testers record the text heard. | Expected results are tolerant | frontend |
| OQ-A11Y-14 | Scope of TC-092: "candidate flow" in the docs; NFR-06 also names "staff screens". This checklist covers the candidate screens only, as asked; staff screens (review page with video and timeline, live view, question editor) need their own checklist. | Gap | QA A / hub |

Not verified (could not confirm from docs or code): the exact Monaco shortcut for Tab-focus mode per OS; whether standalone Monaco opens an accessibility help dialog with Alt+F1 in this build; which keys the proctor SDK blocks; the Chromium behaviour of the screen picker with each screen reader; the order of the browser check and consent screens; the existence of a rate-limit page (the declined, already used and submitted screens exist: terminal-screens.tsx, SubmittedPanel).
