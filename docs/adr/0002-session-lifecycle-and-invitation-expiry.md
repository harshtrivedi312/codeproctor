# ADR 0002: Session lifecycle, section timing, pause and resume

| Field | Value |
| --- | --- |
| Status | **Accepted** 2026-10-01 (D-16): A-03 option (a); every other recommendation as proposed; amended by D-17 (consent declined), D-21 (OTP during a test) and D-23 (manual scoring routing). See section 9. Applied to database.md; deltas in ADR 0008. |
| Author | architect |
| Decides | **A-03 per-section timing**, Q-01, Q-02 (column only), Q-23, Q-24, A-06 |
| Serves | FR-301, FR-303, FR-305, FR-403, FR-505, FR-601, FR-604, FR-609, FR-903, FR-904; NFR-08; TC-021, TC-022, TC-024, TC-033, TC-036, TC-045, TC-046, TC-047, TC-050, TC-055, TC-063, TC-079, TC-080 |
| Hands off | Candidate token storage, HMAC key delivery and reload recovery: ARC-03. GRADED ordering (Q-22): ARC-04. |

DDL deltas are written against the reference DDL in database.md. No migration exists yet, so DB-02 applies them directly. This ADR is longer than one page because it carries A-03 and the pause and resume policy (D-03, D-08).

## 1. Per-section timing (A-03): accepted option (a)

**Context.** FR-301 asks for "per-section time limits" and FR-505 makes the server timer the source of truth. `test_sections.time_limit_min` exists, but a session stores one `deadline_at` only, and `session_questions` has no link to the test question or section it came from. Section limits could only be enforced in the browser.

| Option | DDL delta | Effect |
| --- | --- | --- |
| **(a) Server-enforced sequential sections (accepted, D-16)** | `session_questions` add `test_question_id uuid NOT NULL REFERENCES test_questions(id)`. New table `session_sections` (below). | The server enforces each section's deadline. Sections run in order and do not reopen. |
| (b) Defer section limits | `session_questions` add `test_question_id uuid NOT NULL REFERENCES test_questions(id)` only. | Only the total duration is enforced. FE-05 hides `time_limit_min` and BE-06 rejects it. FR-301 is narrowed (owner amends fsd.md). |
| (c) As (a), stored as `sessions.section_deadlines jsonb` | One jsonb column instead of the table | Same behaviour as (a), but no foreign key and no row lock per section. Not recommended. |

```sql
CREATE TABLE session_sections (
  session_id     uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  section_id     uuid NOT NULL REFERENCES test_sections(id),
  position       int  NOT NULL,
  time_limit_ms  bigint,          -- after accommodations; NULL = no own limit, shares the session time
  started_at     timestamptz,
  deadline_at    timestamptz,     -- never later than sessions.deadline_at
  ended_at       timestamptz,
  PRIMARY KEY (session_id, section_id),
  UNIQUE (session_id, position)
);
```

Rules for (a), testable in BE-06, BE-07, BE-10 and BE-11:
- **S-1** Sections run in `position` order. Inside the open section the candidate moves freely between its questions. "Finish section" is final, and earlier sections never reopen.
- **S-2** At VERIFIED → IN_PROGRESS the server writes one `session_sections` row per section and opens position 1.
- **S-3** Section limit = `time_limit_min` × (1 + extraTimePct / 100), the same factor as the total. TC-024: +50% turns a 60-minute test into 90 minutes and a 20-minute section into 30.
- **S-4** The open section's `deadline_at` = min(`started_at` + `time_limit_ms` + proctor-pause credit, `sessions.deadline_at`). A section with no limit runs until the session deadline or until the candidate finishes it.
- **S-5** Run, draft, submit and answer calls for a question outside the open section return 409. When a section deadline passes, a job submits that section's latest saved code (as auto-submit does for the session), closes the section and opens the next. The end of the last section submits the session.
- **S-6** BE-06 rejects a test whose section limits add up to more than `duration_minutes`.
- **S-7** Proctor-pause credit (section 5) extends the open section and the session by the same amount.

**If the owner says no.** With (b), FR-301's per-section limits are not delivered and fsd.md FR-301 must be amended. With neither option, the server cannot tell which section or test question a served question came from, so `test_question_id` is recommended in every case.

**Consequence.** `session_questions.test_question_id` has no ON DELETE clause, so a test's sections and questions cannot be deleted once a session uses them. BE-06 must copy or archive a test that has sessions instead of editing it in place.

## 2. State machine (Q-01, A-06)

fsd.md §3 has states with no way in or out. This is the proposed full map; ARC-02 copies it into the shared transition map.

| From | To | When |
| --- | --- | --- |
| INVITED | OPENED | Link opened inside the window and email OTP passed |
| INVITED, OPENED, CONSENTED, VERIFIED | EXPIRED | `window_end` passed before start. An expiry job runs every 5 minutes, and the check also runs when the link is opened (TC-022). |
| OPENED | CONSENTED | Consent document signed (D-17) |
| OPENED | DECLINED | Consent document declined (D-17). Terminal: no device access, no recording. |
| CONSENTED | VERIFIED | System check passed, identity attempts finished (PASSED or MANUAL_REVIEW, section 6), room scan uploaded, STRICT side camera connected |
| VERIFIED | IN_PROGRESS | Candidate starts. Sets `started_at`, `deadline_at`, sections, questions and variants, the HMAC key and `invitations.used_at`. |
| IN_PROGRESS | PAUSED | A pause reason is added (section 5) |
| PAUSED | IN_PROGRESS | The last pause reason is cleared |
| IN_PROGRESS, PAUSED | SUBMITTED | Finish, end of the last section, or deadline (auto-submit, TC-046) |
| SUBMITTED | GRADED | Grading and analysis done (order decided in ARC-04, Q-22) |
| GRADED | UNDER_REVIEW | Band MEDIUM or HIGH (FR-805), or identity not confirmed (section 6), or a short answer awaits manual scoring (D-23) |
| GRADED | COMPLETED | Band LOW, identity PASSED or confirmed by a reviewer, and nothing awaits manual scoring |
| UNDER_REVIEW | COMPLETED | Verdict set |
| COMPLETED | APPEALED | Appeal filed within 7 days of a VIOLATION verdict (FR-904) |
| APPEALED | COMPLETED | Appeal resolved (section 7) |

DISCONNECTED, FOCUS_LOST and TAB_SWITCH are events, not states.

**Q-01 options.** (a) **Accepted:** create the session row together with the invitation, in status INVITED. There is one status source and SessionStateService stays its only writer. DDL: `sessions.status` default changes from `'OPENED'` to `'INVITED'`; BE-06 creates the session through SessionStateService. (b) Keep creating the session when the link is opened and add `invitations.status`. That gives two status sources, and TC-022 has to read the invitation.

## 3. HMAC key column (Q-02, schema part)

- (a) **Accepted:** `sessions.hmac_key_enc text` becomes nullable. The key is created at VERIFIED → IN_PROGRESS, as backend.md Step 7 and architecture.md say. Pre-start checks (MULTI_MONITOR, VIRTUAL_CAMERA) travel unsigned in the system-check call, authenticated by the candidate token.
- (b) Nullable, and the key is created at CONSENTED so pre-start events are signed too. This differs from Step 7 and architecture.md.

With either option, delivery and reload recovery are decided in ARC-03.

## 4. Single-use link and resume (Q-23)

DDL: `sessions` add `auth_epoch int NOT NULL DEFAULT 0`.

- **L-1** `invitations.used_at` is set in the VERIFIED → IN_PROGRESS transaction, not when the link is opened. Before that, the link can be reopened inside the window, and each visit asks for the email OTP.
- **L-2** IN_PROGRESS or PAUSED: opening the link resumes the same session.
  - A request with a valid candidate token whose epoch matches resumes without OTP (a page reload).
  - Otherwise the email OTP is asked again (new browser or device, TC-045).
  - Each OTP success increments `auth_epoch`, so a token on any other device stops working: one active device.
  - The clock keeps running during the OTP step (FR-609).
- **L-3** SUBMITTED or later: "Already used" page. No OTP is sent and no session is created (TC-021).
- **L-4** EXPIRED, or `window_end` passed before start: "Expired" page (TC-022). `window_end` does not apply once the test has started. DECLINED: a page that says consent was declined and shows the org's contact for alternatives or accommodations (D-17, TC-096).
- **L-5 (amended by D-21).** Before the test starts (INVITED to VERIFIED), 5 wrong OTPs block the link for 30 minutes and notify the recruiter (TC-007). Once the session is IN_PROGRESS or PAUSED there is no lockout. Each wrong OTP:
  - logs a SERVER event RESUME_OTP_FAILED (ADR 0005);
  - alerts the proctor on /live;
  - allows a retry after a 30-second cooldown (TC-097).

Alternatives: always ask for the OTP on resume, even on reload (no `auth_epoch`; simpler, but every reload costs the candidate time). Or never ask on resume (the link alone; a forwarded link could take over a running test).

## 5. Pause and resume policy (Q-24)

DDL: new enum `pause_reason AS ENUM ('FULLSCREEN_EXIT','SCREEN_SHARE_STOPPED','SIDE_CAMERA_LOST','PROCTOR')`. `sessions` add `pause_reasons pause_reason[] NOT NULL DEFAULT '{}'` and `proctor_paused_at timestamptz`. `paused_ms` holds credited time only.

| Option | Clock during candidate-caused pauses | Can a candidate gain time? |
| --- | --- | --- |
| **(a) Only proctor pauses stop the clock (accepted)** | Runs | No |
| (b) Credit candidate-caused pauses up to an org cap (for example 2 minutes per session) | Stops until the cap | A little |
| (c) Credit every pause (backend.md Step 10 as written) | Stops | Yes: stop sharing, look things up off the recording, re-share, lose no time |

Rules for (a):
- **P-1** The session is PAUSED while `pause_reasons` is not empty.
  - Fullscreen exit and share stop add their reason (FR-601, FR-604), and the matching resume event removes it.
  - SIDE_CAMERA_LOST applies to STRICT only (TC-036).
  - PROCTOR comes from the /live pause and resume actions (FR-903).
- **P-2** Candidate-caused reasons lock the editor but do not stop the clock: `deadline_at` and `paused_ms` do not change (FR-505, FR-609).
- **P-3** A proctor pause stops the clock. On proctor resume, the credit (now − `proctor_paused_at`) is added to `paused_ms`, `deadline_at` and the open section's deadline (TC-079). Total credit per session is capped by the org setting `maxProctorPauseMinutes` (default 30); past the cap the clock runs.
- **P-4** Auto-submit at `deadline_at` also applies in PAUSED (fsd.md §3), except while a PROCTOR pause under the cap is active.
- **P-5** Focus lost and tab switch show an overlay only and change no state (A-06). DISCONNECTED is an event, and the clock runs.

backend.md Step 10 ("Paused time is added to paused_ms and extends deadline_at") must be amended if (a) or (b) is chosen.

## 6. Identity-pending path: never an automatic rejection

A failed or low-confidence face match, or a match that could not run, never blocks or rejects a candidate (D-05; brd.md §5 and §7). The identity statuses are in ADR 0004.

- (a) **Accepted: the candidate continues.**
  - After the one retry (ADR 0004), the identity check goes to MANUAL_REVIEW and CONSENTED → VERIFIED proceeds.
  - The server logs IDENTITY_MANUAL_REVIEW (HIGH severity, risk weight 0, ADR 0005).
  - At GRADED the session goes to UNDER_REVIEW whatever its band, and the verdict cannot be set until a reviewer records the identity decision (same gate as TC-078).
  - This extends fsd.md §3's UNDER_REVIEW entry ("Risk MEDIUM/HIGH"); the owner must approve the wording.
- (b) Hold the session at CONSENTED until a reviewer approves. This is not an automatic rejection either, but the candidate waits for a human inside the test window, so a low model score becomes a block in practice.

VERIFIED then means "checks done", as fsd.md §3 says ("System check, ID and room scan done"). It does not mean "identity confirmed".

## 7. Appeal outcome (A-06)

- (a) **Accepted:** `appeals` add `new_verdict verdict`, `UNIQUE (session_review_id)` (one appeal per review) and `CHECK ((status = 'OVERTURNED') = (new_verdict IS NOT NULL))`. The original verdict stays in `session_reviews`. The effective verdict is `new_verdict` when the appeal is overturned. The different-reviewer rule (TC-080) is a service check.
- (b) Drop UNIQUE on `session_reviews.session_id` and add `kind ('INITIAL','APPEAL')`. This is heavier, and `flag_decisions` (UNIQUE per event) still cannot hold a second opinion.

## 8. Consequences and affected agents

- **Accepted delta:** 1 table (`session_sections`), 1 enum (`pause_reason`), `session_status` + 'DECLINED' (D-17), `sessions` (status default, nullable `hmac_key_enc`, `auth_epoch`, `pause_reasons`, `proctor_paused_at`), `session_questions.test_question_id`, and 3 changes to `appeals`.
- **db-engineer:** DB-02 and DB-03 apply the delta. DB-04 seeds sessions in INVITED and later states.
- **backend-engineer:** BE-06 creates INVITED sessions, runs the expiry job and checks S-6. BE-07 builds the transition map, L-1..L-5 and sections. BE-11 enforces S-5 and auto-submits per section. BE-13 applies the proctor-pause credit and appeals.
- **integrity-engineer:** BE-10 applies the pause reasons (P-1..P-5).
- **proctor-sdk-engineer:** FE-06 emits the resume events (ADR 0005).
- **frontend-engineer:** FE-05 explains sequential sections. FE-09 handles resume and "sent for manual review". FE-10 shows the section timer, "finish section" and overlays. FE-11 records the identity decision before the verdict. FE-12 adds pause and resume.
- **architect:** ARC-02 builds the transition map. ARC-03 decides token storage and key delivery for L-2.
- **Doc amendments (applied in Phase B, 2026-10-01):** backend.md Step 7 (session created with the invitation; meaning of `used_at`; consent document; OTP rules) and Step 10 (paused time); fsd.md §3 (APPEALED row, EXPIRED entries, UNDER_REVIEW entry, DECLINED).

## 9. Amendments after acceptance (D-17, D-21, D-23)

- **D-17 consent declined.** Declining the consent document moves OPENED → DECLINED.
  - DECLINED is terminal: no device access, no recording, no HMAC key. `invitations.used_at` stays NULL.
  - SessionStateService sets `retention_anchor_at` at the decline (ADR 0004 R-1).
  - Reopening the link shows the declined page with the contact (L-4). A recruiter who agrees an alternative sends a new invitation.
  - *Detail chosen by architect; owner to confirm:* a new terminal status `DECLINED`, rather than reusing EXPIRED or leaving the session in OPENED.
- **D-17 sign before CONSENTED.** CONSENTED means the consent document is signed (ADR 0007 §6). Resuming the same session does not ask for a new signature; every new session does.
- **D-21 OTP during a test.** L-5 above.
  - *Detail chosen by architect; owner to confirm:* the event type is `RESUME_OTP_FAILED` (SERVER, MEDIUM, risk weight 0, always pushed to /live); the cooldown is 30 seconds; there is no attempt limit while the test runs, because the cooldown and the 10-minute OTP expiry bound guessing.
- **D-23 manual scoring.** A session with a short answer in `scoring = 'MANUAL_PENDING'` goes to UNDER_REVIEW at GRADED (section 2), and the verdict cannot be set until every such answer is scored.
  - *Detail chosen by architect; owner to confirm:* manual scoring happens in the review workspace (REVIEWER or SUPER_ADMIN), and `total_score` is computed when the last answer is scored.
