# Brief ARC-01: Schema readiness review (architect gate before DB-02)

| Field | Value |
| --- | --- |
| Task ID | ARC-01 |
| Owner | architect |
| Branch | `arch/adr-schema-gaps` (needs the initial commit on main, blocker B-01) |
| Size | L (widened 2026-10-01, D-03 and D-08) |
| Depends on | Nothing to start drafting. Finalizing needs human answers (Phase B below). |
| Runs in parallel with | DB-01, QA-01A |
| Unblocks | DB-02 (schema), ARC-02 (shared contracts), ARC-03 (security model) |
| Reviewer | Human approves each ADR; code-reviewer reads the final doc changes |
| Related | /docs/adr/0001-overall-architecture.md (Accepted, decisions D-01..D-09 in section 11); /docs/adr/review-2026-09-30-plan-and-schema.md |

## 1. Goal

CLAUDE.md says the docs are the source of truth and database.md's reference DDL is what the Prisma schema must match exactly. The PM found places where the DDL cannot support something the FSD, the test cases or the build prompts require. You decide nothing silently. For each gap, write an ADR with options and a recommendation, get the human's decision, then update database.md only for approved changes and hand the db-engineer a written schema freeze list. DB-02 does not start until that list exists.

On 2026-10-01 the owner widened this task (D-03, D-08). It now also covers the architect's review findings that touch the schema, the pause and resume policy (Q-23, Q-24), and a retention hold during review and appeals (A-09). The variant model (A-01) and per-section timing (A-03) change core tables, so decide them first.

## 2. Read first (in this order)

1. /CLAUDE.md
2. /docs/database.md (all: ERD, table reference, reference DDL, Data rules)
3. /docs/fsd.md: section 2 M1 (FR-101..FR-106), M3 (FR-303, FR-305), M4 (FR-401..FR-406), M7 (FR-704), M8 (FR-801..FR-805); section 3 (session state machine); section 5 (NFR-04, NFR-05)
4. /docs/architecture.md: Candidate session sequence, Proctoring data flow, Security architecture
5. /docs/prompts/database.md: Steps 2, 3, 5, 6
6. /docs/prompts/backend.md: Steps 2, 7, 8, 10, 12, 13, 14
7. /docs/prompts/frontend.md: Steps 3, 8, 9, 11
8. /docs/test-cases.md: TC-005, TC-007, TC-008, TC-022, TC-033, TC-036, TC-045, TC-053, TC-063, TC-072, TC-075, TC-094
9. /docs/status.md section 6 group A (Q-01..Q-17), Q-23 and Q-24 in group C, section 9 (decision log), and /docs/build-plan.md task ARC-01
10. /docs/adr/0001-overall-architecture.md (Accepted) and /docs/adr/review-2026-09-30-plan-and-schema.md sections 2, 4 and 5
11. /docs/fsd.md FR-203, FR-301, FR-303, FR-505, FR-609, FR-904 and /docs/test-cases.md TC-012, TC-021, TC-024, TC-048, TC-050, TC-065, TC-079 (added with the wider scope)

Verify every gap yourself against the quoted doc lines. If the PM's reading is wrong, say so in the ADR.

## 3. Scope

In scope: /docs/adr/*.md, /docs/database.md (only after human approval of the matching ADR).

Out of scope: prisma/, apps/*, packages/shared, /docs/fsd.md and /docs/test-cases.md (report conflicts; do not edit), /docs/prompts/*.md (list needed amendments for a human), API contract and security behavior questions (Q-18..Q-28 belong to ARC-02, ARC-03, ARC-04), except Q-23 and Q-24, which moved here (D-08). Token binding, HMAC key storage in the browser and canonical JSON stay in ARC-03. No new dependencies or services.

## 4. Questions in scope (from /docs/status.md)

| Q | Gap |
| --- | --- |
| Q-01 | INVITED and EXPIRED have no representation (no session row before link open, no invitation status, no expiry job); TC-022 |
| Q-02 | `sessions.hmac_key_enc` NOT NULL at OPENED versus Step 7 generating the key at IN_PROGRESS and returning it once (reload problem) |
| Q-03 | No storage for hashed 2FA recovery codes |
| Q-04 | No storage for candidate OTP, attempt count, 30 min link block; no recruiter notification template (TC-007) |
| Q-05 | No family id for refresh-token family revocation (TC-005) |
| Q-06 | No storage for face embeddings; retention does not cover them |
| Q-07 | No storage or source for AI-generated reference solutions (FR-803) |
| Q-08 | `event_type` enum missing SIDE_CAMERA disconnect, drop attempt, extension interference, resume events, idle-then-complete, capability flags |
| Q-09 | No default severity per event type and no default risk weights (Step 12 says they are in FR-804; they are not) |
| Q-10 | Org scoping of tables without `org_id` (sessions, submissions, events); Step 5 extension only filters tables that have `org_id`; TC-008 |
| Q-11 | Retention scope (evidence_key JPEGs, report PDFs, embeddings, keystrokes) and "older than" timestamp; erasure entry point |
| Q-12 | `identity_checks.status` values, manual approval fields and workflow, client-reported liveness |
| Q-13 | Practice question data model (FR-406) |
| Q-14 | MCQ and short-answer answering and scoring (FR-205, TC-014) |
| Q-15 | `app_user` role creation, credentials and migration role on managed Postgres |
| Q-16 | Org settings storage and consent version source (frontend Step 3 versus backend Step 7 "config") |
| Q-17 | ERD versus DDL naming (`totp_secret` vs `totp_secret_enc`); Data rules wording about `audit_logs` |
| Q-23 | Single-use link (FR-303, TC-021) versus reopening mid-test (TC-045, TC-063, FR-609): when `used_at` is set, whether OTP is asked again (moved from ARC-03, D-08) |
| Q-24 | Paused time extends `deadline_at` (backend.md Step 10) versus server time continuing (FR-505, FR-609): which events pause, whether paused time is added back, and a cap (moved from ARC-03, D-08) |

### Review findings in scope (D-03; review section 5 routing)

| Finding | Gap | Decide first? |
| --- | --- | --- |
| A-01 | Variant-specific test data has no storage (FR-203, TC-012) | **Yes, before anything else** |
| A-03 | No per-section timing on a session; `session_questions` has no link to its section (FR-301, FR-505, TC-024) | **Yes, before anything else** |
| A-02 | `media_chunks.object_key` NOT NULL but retention nulls it (TC-072) | |
| A-04 | Recording segments and restart grouping, if a column is chosen | |
| A-06 | State machine gaps: APPEALED row, CONSENTED/VERIFIED expiry, identity pending, focus lost, appeal verdict storage | |
| A-07 | Cross-tenant foreign keys (NFR-04, TC-008) | |
| A-09 | Retention hold: anchor on the later of `submitted_at` and the final verdict or appeal resolution; skip UNDER_REVIEW, APPEALED and open appeals (FR-904) | |
| A-10 | Durable replay state for event batches (TC-065) | |
| A-11 | Staff invites, webhook endpoints and deliveries, report PDF keys, validation results, allowed assistive tools | |
| A-21 items 2 and 4 | Room scan stored in two places; free-text enum columns | |
| A-22 | Indexes on foreign-key columns | |
| A-23 | Score formula: points versus weights (TC-048) | |

## 5. Deliverables

### Phase A: draft (no human input needed)

1. Write ADRs in /docs/adr/ (each under one page: context, at least two options, recommendation, consequences, FR/NFR/TC IDs served, modules and agents affected, `Status: Proposed`):
   - `0002-session-lifecycle-and-invitation-expiry.md` (Q-01, Q-02, Q-23, Q-24, A-06, A-03 session side). Includes the pause and resume policy: which events pause the session, whether paused time is added to `deadline_at`, a per-session cap, and when a reopened link needs OTP again.
   - `0003-credential-and-otp-storage.md` (Q-03, Q-04, Q-05, A-11 item 1)
   - `0004-identity-biometrics-and-retention-scope.md` (Q-06, Q-11, Q-12, A-02, A-04 if a column is chosen, A-09 retention hold, A-21 items 2 and 4)
   - `0005-integrity-event-taxonomy-and-defaults.md` (Q-07 storage only, Q-08, Q-09, A-10)
   - `0006-org-scoping-and-db-roles.md` (Q-10, Q-15, A-07)
   - `0007-content-and-settings-model-gaps.md` (Q-13, Q-14, Q-16, A-01, A-03 test side, A-11 items 2 to 5, A-23)

   Send the A-01 and A-03 options to the human first, ahead of the other ADRs, so the core tables can be settled early.
   Each option states the exact DDL delta (table, column, type, constraint) or says "no schema change". Prefer the simplest option that meets the NFRs; do not add a service or paid dependency.
2. Hand the PM a short decision list: each question, your recommendation, and what breaks if the human says no.

### Phase B: after the human approves (per ADR)

3. Set each approved ADR to `Status: Accepted`. Update /docs/database.md in the same change: ERD, table reference (and the "24 tables" count if it changes), reference DDL, Data rules. Fix Q-17 hygiene items. Update only approved items.
4. Write `/docs/adr/0008-schema-freeze-list.md`: the exact approved deltas for DB-02 and DB-03 (or "No schema change: use database.md as written"). Include enum additions and the A-22 indexes.
5. List amendments needed in /docs/prompts/database.md (for example Step 2 counts, Step 4 seed content) for a human to apply. Do not edit the prompts.
6. For questions that turn out to need contract or security behavior (not schema), note the hand-off to ARC-02 or ARC-03 in the ADR.

## 6. FR and TC IDs to reference

FR-104, FR-105, FR-106, FR-203, FR-205, FR-301, FR-303, FR-403, FR-404, FR-406, FR-505, FR-609, FR-704, FR-801, FR-803, FR-804, FR-904, NFR-04, NFR-05; TC-005, TC-007, TC-008, TC-012, TC-021, TC-022, TC-024, TC-033, TC-036, TC-045, TC-048, TC-050, TC-053, TC-063, TC-065, TC-072, TC-075, TC-079, TC-094. No tests are written in this task.

## 7. Acceptance criteria (definition of done)

- Every question Q-01..Q-17, Q-23, Q-24 and every review finding in section 4 is either Accepted with a recorded delta, Accepted as "no change", or explicitly deferred with the human's name and reason.
- A-01 and A-03 are decided before the freeze list is drafted.
- The pause and resume policy and the retention hold are written as rules that BE-07, BE-10 and DB-06 can test.
- database.md, the ADRs and the freeze list agree with each other (row counts, enum values, constraints).
- No file outside /docs changed; nothing silently diverges from the docs.
- The freeze list is self-sufficient: the db-engineer can write prisma/schema.prisma and the migrations from database.md plus the list alone.
- Output format followed: Decision summary (3 to 5 lines), Files changed, Agents affected and what they must do next, Open questions for the human.

## 8. Suggested commits

- `docs(adr): propose schema gap decisions 0002-0007`
- `docs(db): apply accepted schema decisions to database.md`
- `docs(adr): add schema freeze list 0008`

## 9. Blocking open questions

All of Q-01..Q-17, Q-23, Q-24 and the review findings in section 4 are the content of this task. Phase B blocks on the human. If the human answers "as written" for everything, the freeze list says so and DB-02 proceeds with the DDL as is.
