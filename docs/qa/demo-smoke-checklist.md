# Demo smoke checklist (D-67)

Owner: QA A. Created 2026-10-07 for the demo sprint (Delivery Lead request). The goal is one full
local end-to-end run: **invite, consent, identity, test with runs, recording and events, submit,
reviewer sees it.** This is a smoke check, not a test plan: one candidate, one happy path, plus the
few negative checks that cost almost nothing. The full cases stay in `docs/test-cases.md`; TC ids
below say which one a step touches.

Status of this file: written before the pieces exist. Nothing has been run. The run waits for the
Delivery Lead to say the pieces are on `main`. Where a step depends on something not built yet, the
result is recorded as **Not built** (not Fail) and the owner is named.

## Rules for the run

- Local stack only, synthetic data only (a made-up candidate name, an address on a reserved domain such as `example.test`, generated media, no real face, no real ID). No pilot or production URL, credential or bucket (ADR 0009).
- QA does not start or stop the Docker stack (CLAUDE.md rule 14: Database B does) and does not run the web dev server (rule 15: Frontend does). QA only connects to what is running.
- Local runs of automated checks: at most 2 workers, only suites that were touched (DL-45). This checklist is walked by hand with the browser; the commands in the "Automated pass" section are optional.
- Never paste a token, OTP, invitation link, session key or media key into a report, a PR or chat. Write "OTP read from the sink" and the pass or fail.
- Result per step: **Pass**, **Fail** (write what happened, which owner), **Not built** (write the missing piece), or **Blocked** (an earlier step failed).

## Preconditions (check first; any "no" is reported to the Delivery Lead before the walk)

| #   | Needs                                                                                                                                                                                                              | How to check                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| P-1 | The local stack is up (Postgres, Redis), migrated and seeded by Database B; the API (`pnpm dev:api`) and the web app (`pnpm dev:web`) are running                                                                  | Health route of the API answers 200; the staff login page loads                                                    |
| P-2 | A staff login for each role: SUPER_ADMIN or RECRUITER, and REVIEWER (with TOTP set up if the build requires it, TC-003). The seed prints the staff emails and says the development password lives in the seed config | Log in as each; no credential is copied into this file                                                             |
| P-3 | A way to read the **invitation email and the candidate OTP** locally. `.env.example` has `EMAIL_PROVIDER=noop`, and the compose file has no mail sink. Something must capture the mail (a dev sink or a logged-in-memory outbox) | Send one invitation and find the link and OTP. If there is no way, step D-02 is **Blocked**: owner Backend A       |
| P-4 | Code execution: a Judge0 instance reachable at `JUDGE0_URL` (the compose file does not start one), or a documented local stub. Without it, step D-06 is **Not built**                                              | `POST` a run, or check the Judge0 health                                                                           |
| P-5 | Object storage for recordings: a local S3-compatible target (the storage interface is one for all environments) with a bucket the API can write to. Without it, step D-08 is **Not built**                         | The API boot log says the storage check passed (no secret in the log)                                              |
| P-6 | One published test with one coding question that has sample tests and hidden tests, and one invitation window that is open now                                                                                     | Created by hand in the staff UI at step D-01, or by the seed                                                       |
| P-7 | Chromium with fake media for the candidate: `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream` (a generated test pattern as camera and a tone as microphone), plus screen sharing the whole screen  | The browser shows the camera preview as a test pattern, never a real face                                          |

## The walk

One candidate, in order. Steps use the staff UI for the recruiter and reviewer parts and the
candidate pages for the rest. "API check" lines are for when the UI is not built yet; use the
documented routes only (docs/api-contract.md).

| Step | Do                                                                                                                                                                                       | Expected                                                                                                                                                                   | TC / FR                  | Owner if it fails                |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | -------------------------------- |
| D-01 | Staff: log in as the recruiter; create (or pick) a test with the coding question; set a window that is open now                                                                           | The test shows as PUBLISHED with the question and its sample tests; the hidden tests are not shown to the candidate side                                                    | TC-001, TC-010, TC-011   | Frontend (UI), Backend B (API)   |
| D-02 | Staff: invite one synthetic candidate (reserved-domain address)                                                                                                                           | The invitation exists (INVITED); one email is captured with a link; the link carries the token in the fragment (not in a query string sent to a server log)                  | TC-021, TC-107, FR-303   | Backend A (mail), Frontend (link) |
| D-03 | Candidate: open the link; request the code; enter the OTP from the sink                                                                                                                   | The link page asks for the code; a wrong code is refused (try one wrong, then the right one); the right one opens the session; the session is OPENED                         | TC-007, FR-106           | Backend B                        |
| D-04 | Candidate: read the consent text, tick the age confirmation (18+), type the synthetic name, sign. Before signing, look at the browser's network tab                                       | Nothing records before signing: no camera or microphone prompt, no upload, no event batch (TC-030). After signing, the session is CONSENTED and the consent record exists   | TC-030, TC-095, FR-401   | Frontend, Backend B              |
| D-05 | Candidate: system check (browser, camera, microphone, whole-screen share); identity step (if the invitation waives it, confirm the page says so); room scan                               | A supported browser passes; the camera shows the fake pattern; sharing "window only" is refused (TC-054); identity is either checked (match) or waived with text; room scan stores a clip; Start enables only when all required steps pass (TC-035) | TC-031, TC-035, TC-054, FR-402..405 | Frontend, Integrity B, Backend B |
| D-06 | Candidate: Start the test. Write a correct solution; click Run; click Run again within 2 s                                                                                                | The first Run returns sample results in under 5 s (TC-040); the second within 2 s is refused with a message (TC-041). The timer counts down from the server deadline          | TC-040, TC-041, TC-047   | Backend B, Frontend              |
| D-07 | Candidate: type, wait 10 s, reload the page, re-enter through the link (the session is in progress, so no new OTP is needed)                                                               | The code is restored to within 10 s of the last edit                                                                                                                       | TC-045, FR-504           | Backend B, Frontend              |
| D-08 | Candidate: cause events on purpose, then check them. (a) press Esc to leave fullscreen and return; (b) switch to another window for about 8 s and back; (c) paste text into the editor     | (a) editor locks, the overlay shows, FULLSCREEN_EXIT is logged; (b) FOCUS_LOST/TAB_SWITCH logged with a duration of about 8 s; (c) nothing is pasted and PASTE_ATTEMPT is logged. Recording chunks keep uploading (no gap over 10 s in a short run) | TC-050, TC-051, TC-052, TC-070 | Proctor SDK, Integrity B, Backend B |
| D-09 | Candidate: Submit (finish early), or let the timer reach zero in a short test                                                                                                              | The latest code is graded: sample and hidden tests run, the question score follows the weights (TC-048), the session is SUBMITTED, a second use of the link shows "Already used" (TC-021) | TC-046, TC-048, TC-021   | Backend B                        |
| D-10 | Staff: log in as the reviewer; open the review queue; open the session                                                                                                                    | The session is listed (every session is reviewed, C-28); the review opens only for the reviewer's own organisation (try the other organisation's id by hand: expect 404, TC-008) | TC-076, TC-008, TC-006   | Frontend, Backend B              |
| D-11 | Reviewer: look at the timeline and the recording; click an event in the timeline; open the keystroke replay; read the risk band                                                           | The events from D-08 are in the timeline with their types; clicking one seeks the video (TC-077); the replay reproduces the final code exactly (TC-062); a risk score and band show | TC-062, TC-075, TC-077   | Frontend, Integrity B            |
| D-12 | Reviewer: record a verdict (leave one flag undecided first, then decide it)                                                                                                               | Completing the review is blocked while a HIGH flag is undecided and allowed after (TC-078); the audit log has rows for opening the session and for the verdict (TC-006)       | TC-078, TC-006           | Backend B, Frontend              |
| D-13 | Clean-up check: nothing real was used; delete the synthetic candidate if the build has the admin deletion flow                                                                            | The deletion removes the candidate's objects and keys it (TC-072/TC-094) or is recorded as Not built                                                                       | TC-094                   | Backend B                        |

## What counts as the demo being ready

All of D-01 to D-12 Pass, with D-13 allowed to be Not built. A single Fail in D-02 to D-09 means
the candidate cannot get through, so the demo cannot show a full run. A Fail or Not built at D-08
(events) or D-11 (timeline, replay) means the demo has no proof of the proctoring half: report it
as the most important gap.

## Report format (to the Delivery Lead, one message)

One line per step: `D-nn Pass | Fail <what, owner> | Not built <missing piece, owner> | Blocked`,
then up to five lines of anything else that surprised the walk (slow steps, confusing messages,
anything that looked unsafe). No tokens, OTPs, links, keys or personal data in the message.

## Automated pass (optional, same rules)

When the pieces are on `main`, these existing suites exercise the same ground without a browser;
run them only if they were touched, with at most 2 workers:

- API happy path and negatives: the integration suites for the candidate session (`apps/api/test/integration/tc-003*.int.test.ts`, the candidate routes in `be03-routes.ts`).
- Seeder against the running API: `node packages/qa/k6/seed/seed.mjs --count 1 --stop-at CONSENTED` with the environment variables of `packages/qa/k6/seed/README.md` (local API, a mail sink for the link and OTP). It stops at the system check until those routes exist (named "not available on main yet" error).
