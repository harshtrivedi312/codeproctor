# ADR 0015: Waived identity check ("no face match / no identity check")

| Field | Value |
| --- | --- |
| Status | **Proposed** 2026-10-05. The owner accepts or amends. "(owner decision C-xx)" marks what docs/compliance/decisions.md (PR #44) decides; "(architect detail)" marks what this ADR adds; "(DL recommendation)" marks the Delivery Lead's recommendation that the owner has not answered yet. Section 9 lists the owner questions. |
| Author | architecture hub |
| Decides | How C-02 item b ("no face match") and C-19 are built: the accommodation, its schema, shared contract, API, audit, state machine, scoring and reporting effects |
| Serves | FR-305, FR-403, FR-606, FR-105, FR-805, FR-901, FR-1001, FR-1003; BR-12; NFR-05 |
| Builds on | ADR 0002 §2 and §6, ADR 0004 §1, ADR 0005 (weights), ADR 0006 (org scope), ADR 0008 (freeze), ADR 0010 (shared contracts), ADR 0013 5.6 and CS-4 (PR #39, Proposed) |
| Amends (on acceptance) | ADR 0002, ADR 0008, ADR 0010, ADR 0013; database.md; fsd.md FR-305, FR-403, FR-606, §3, §4 |

## 1. Context

- Face matching is required for every candidate. If a candidate refuses, or cannot use the webcam, microphone or ID check, the recruiter handles it case by case through the per-invitation accommodation settings, "for example, disabled detectors or no face match". Recruiter actions on accommodations are audited (owner decision C-02).
- When face matching is waived, the recruiter must record a reason, and reviewers see "identity check waived". The recruiter is advised to check the candidate's ID on a video call before any hiring decision, and records whether that was done. All of it is audited (owner decision C-19).
- C-19 also names the shape of the change:
  > The invitation's accommodation carries the waiver reason. The identity check records a waived state. A "video ID check done: yes/no" field is recorded by the recruiter. All three write audit rows.
- Today the only face-related accommodation is the FACE detector in `disabledDetectors` (`PROCTOR_DETECTORS`, packages/shared). In the SDK it stops in-browser NO_FACE and MULTIPLE_FACES detection and the periodic re-check. ADR 0013 5.6 refuses an `IDENTITY_RECHECK` presign with 409 `DETECTOR_DISABLED` when FACE is disabled. Nothing waives the initial ID, selfie and face match (FR-403), and `identity_check_status` has no value for it.

## 2. Options

| Topic | Option | Verdict |
| --- | --- | --- |
| Settings | **(A) Two settings with distinct meanings:** FACE detector off, and a separate identity-check waiver | **Recommended** (DL recommendation; owner question 1) |
| | (B) One setting: disabling FACE also waives the identity check | Rejected: a candidate who can do a one-off ID and selfie but cannot stay in frame would lose identity checking, and the reverse case cannot be expressed |
| | (C) The waiver always turns FACE off too | Rejected: face presence detection identifies no one and can still be useful; the recruiter can switch FACE off as well when that is wanted |
| Where the waived state lives | **(a) `identity_checks` row with status WAIVED, plus video-check columns on that row** | **Recommended:** one place for identity state, so the VERIFIED gate, review panel and reports read one table, and CHECK constraints guard it |
| | (b) Columns on `sessions` (`identity_waived`, `video_check_*`) | Rejected: identity state split across two tables |
| | (c) Everything in `invitations.accommodations` jsonb, including the video check | Rejected: no database guard, and a check recorded after the test is not an accommodation |

## 3. The two settings (recommended option A)

| Setting | Stored as | What it waives | What still runs |
| --- | --- | --- | --- |
| **FACE detector off** (exists) | `accommodations.disabledDetectors` contains `FACE` | In-browser NO_FACE and MULTIPLE_FACES; the periodic identity re-check, so no FACE_MISMATCH (ADR 0013 5.6) | ID image, selfie, liveness and the initial face match (FR-403); GAZE unless GAZE is also off |
| **No face match / no identity check** (new) | `accommodations.identityCheckWaiver` present | ID image, selfie, liveness, the initial face match, and the re-check, since there is no verified selfie to compare against | In-browser NO_FACE and MULTIPLE_FACES (face detection, no identification, nothing stored) unless FACE is also off; room scan and recordings |

How they interact (the presign refusals are architect detail):

| FACE off | Waiver | ID and selfie step | Initial match | Browser face detection | Re-check presign (`IDENTITY_RECHECK`) |
| --- | --- | --- | --- | --- | --- |
| no | no | yes | yes | yes | allowed |
| yes | no | yes | yes | no | 409 `DETECTOR_DISABLED` (ADR 0013, unchanged) |
| no | yes | no; `ID_IMAGE` and `SELFIE` presign and `POST /candidate/session/identity` get 409 `IDENTITY_CHECK_WAIVED` | no | yes | 409 `IDENTITY_CHECK_WAIVED` |
| yes | yes | no | no | no | 409 `IDENTITY_CHECK_WAIVED` (the waiver is checked first) |

- The waiver does not cover the webcam itself: room scan (FR-404) and the WEBCAM stream are still required. A candidate who cannot use a webcam at all has no accommodation today (owner question 3).
- The GAZE detector uses face landmarks in the browser. For reason `REFUSED_BIOMETRIC_PROCESSING`, the recruiter UI suggests also switching FACE and GAZE off, and the recruiter decides (architect detail; owner question 4).

## 4. Schema (ADR 0008 post-freeze change)

**Accommodation (jsonb, no DDL).** `invitations.accommodations.identityCheckWaiver` (owner decision C-19: the accommodation carries the reason). Shape:

| Key | Type | Rule | Marker |
| --- | --- | --- | --- |
| `reasonCode` | `REFUSED_BIOMETRIC_PROCESSING` \| `CANNOT_USE_WEBCAM` \| `CANNOT_COMPLETE_ID_CHECK` \| `OTHER` | Required. The values follow C-02's three cases; no health category, so the code itself is not health data | owner decision C-19 (reason required); codes: architect detail |
| `reasonNote` | string, 1..500, trimmed | Required when `reasonCode` is `OTHER`, optional otherwise. The UI says not to enter health details | architect detail |

**`identity_checks` (DDL).**

| Change | Definition | Marker |
| --- | --- | --- |
| Enum value | `ALTER TYPE identity_check_status ADD VALUE 'WAIVED'` (appended last; not a rejection, so ADR 0004 §1's rule stands) | owner decision C-19 (waived state); value: architect detail |
| Column | `video_check_done boolean` (NULL = not recorded yet) | owner decision C-19 (yes/no field) |
| Column | `video_check_by uuid REFERENCES users(id)` (NO ACTION) | architect detail |
| Column | `video_check_at timestamptz` | architect detail |
| CHECK `identity_checks_waived_check` | `status <> 'WAIVED' OR (attempt = 1 AND id_image_key IS NULL AND selfie_key IS NULL AND face_match_score IS NULL AND model_id IS NULL AND threshold IS NULL AND review_reason IS NULL AND manual_decision IS NULL)` | architect detail |
| CHECK `identity_checks_video_check_check` | `(video_check_done IS NULL) = (video_check_by IS NULL) AND (video_check_done IS NULL) = (video_check_at IS NULL) AND (video_check_done IS NULL OR status = 'WAIVED')` | architect detail |

The existing reviewed-complete CHECK still holds, because a WAIVED row has no `manual_decision`.

**Migration (architect detail).** Forward-only and additive, in two Prisma migrations, because Postgres refuses to use a new enum value in the same transaction that adds it:
1. `..._identity_check_waived_enum`: the `ALTER TYPE ... ADD VALUE 'WAIVED'` only.
2. `..._identity_check_waiver_columns`: the three nullable columns, the FK and the two CHECKs.

- Existing rows get NULLs and satisfy both CHECKs. No backfill, and no change to existing statuses.
- Older API code keeps working against the new schema. TypeScript `switch` statements on `IdentityCheckStatus` stop compiling until they handle `WAIVED`, which is the intended guard.
- `schema.prisma`: add `WAIVED` to `IdentityCheckStatus` and the three fields. Two relations from `IdentityCheck` to `User` need explicit relation names (for example `IdentityCheckReviewedBy` and `IdentityCheckVideoCheckBy`); this does not change the database.
- Org scope (ADR 0006) is unchanged: `identity_checks` stays scoped through `sessions`.

**ADR 0008 amendment needed.** ADR 0008 §10 requires "a new ADR and a forward-only migration" for any later change. Add a section 11, "Post-freeze deltas", with one row per change above (source ADR 0015). New counts: enums 20 (unchanged; `identity_check_status` gains a value), columns +3, CHECK constraints 12 → 14, FKs with no ON DELETE clause +1, no new tables or indexes. The `schema.prisma` header comment (CHECK list and counts) is updated with it.

## 5. Shared contract (ADR 0010 amendment request)

packages/shared has no accommodations schema yet (ADR 0008 §9 assigns it to ARC-02). Request, for the hub to write after acceptance:

| Name | Kind | Change |
| --- | --- | --- |
| `ACCOMMODATION_DETECTORS`, `AccommodationDetector` | const, type | New: the `PROCTOR_DETECTORS` subset an accommodation may disable (ADR 0013 already asks for it, to exclude `SCREEN_SHARE`) |
| `IDENTITY_WAIVER_REASONS`, `identityWaiverReasonSchema`, `IdentityWaiverReason` | const, zod, type | New: the four `reasonCode` values |
| `identityCheckWaiverSchema`, `IdentityCheckWaiver` | zod, type | New: `{ reasonCode, reasonNote? }` with the `OTHER` refinement |
| `accommodationsSchema`, `Accommodations` | zod, type | New, with `extraTimePct`, `disabledDetectors`, `allowedAssistiveTools`, `notes` (backend.md Step 6) and the optional key **`identityCheckWaiver`** |
| `IDENTITY_CHECK_STATUSES`, `identityCheckStatusSchema`, `IdentityCheckStatus` | const, zod, type | New mirror of the DB enum, including `WAIVED`, for DTOs and the review UI |
| `identityVideoCheckRequestSchema`, `IdentityVideoCheckRequest` | zod, type | New: `{ done: boolean }` |
| `PERMISSIONS` | const | Add `invitation:update` and `identity_video_check:record` |
| `RECRUITER_PERMISSIONS` | const | Add both; SUPER_ADMIN gets them through `STAFF_PERMISSIONS`; REVIEWER gets neither |

## 6. API and audit (paths are proposals; final in api-contract.md, ADR 0012)

| Method and path | Who | Rule |
| --- | --- | --- |
| `POST /tests/:id/invitations` | RECRUITER, SUPER_ADMIN | Single invites may carry `identityCheckWaiver`; the WAIVED row is written in the same transaction. Bulk CSV rejects it as a row error, so each waiver is a case-by-case decision (C-02) |
| `PATCH /invitations/:id/accommodations` | RECRUITER, SUPER_ADMIN (`invitation:update`) | Replaces the accommodations. Setting the waiver inserts the WAIVED row (attempt 1), and removing it deletes the row. Both are allowed only while the session is INVITED, OPENED or CONSENTED **and** no other identity attempt exists. The session row is locked, and `UNIQUE (session_id, attempt)` catches a race with a candidate upload. Otherwise 409 `ACCOMMODATION_LOCKED` |
| `PUT /sessions/:id/identity/video-check` | RECRUITER, SUPER_ADMIN (`identity_video_check:record`) | Body `{ done }`; sets `video_check_*` on the WAIVED row, and may be changed later. 409 `IDENTITY_NOT_WAIVED` otherwise |
| Candidate identity routes and presigns | CANDIDATE | 409 `IDENTITY_CHECK_WAIVED` (section 3) |
| Candidate session data | CANDIDATE | Exposes `identityCheckWaived: boolean` only, never the reason |

- Every staff route checks org scope and returns 404 for another org's ID (ADR 0006). Only staff routes write a WAIVED row or the video-check columns. Candidate-scope code never sets status `WAIVED` or `video_check_*`; ADR 0013 CS-4 should state this for `identity_checks` (architect detail).
- **Who sees the reason (architect detail; owner question 2).** RECRUITER and SUPER_ADMIN see `reasonCode` and `reasonNote`. REVIEWER sees only "Identity check waived" and the video-check status. Each staff read is audited as candidate data (FR-105).

Audit rows (`audit_logs`; metadata holds IDs and action names only, never the reason, per ADR 0001 C-3):

| Action | Actor | Entity | When | Marker |
| --- | --- | --- | --- | --- |
| `INVITATION_ACCOMMODATIONS_UPDATED` | staff user | invitation | Any change to accommodations; metadata lists the changed key names | owner decision C-02 |
| `IDENTITY_CHECK_WAIVED` | staff user | identity_check | Waiver set and WAIVED row written | owner decision C-19 |
| `IDENTITY_CHECK_WAIVER_REMOVED` | staff user | invitation | Waiver removed before VERIFIED | architect detail |
| `IDENTITY_VIDEO_CHECK_DONE` / `IDENTITY_VIDEO_CHECK_NOT_DONE` | staff user | identity_check | Video check recorded or changed | owner decision C-19; names: architect detail |

## 7. State machine, scoring, reporting

| Area | Rule | Marker |
| --- | --- | --- |
| CONSENTED → VERIFIED (ADR 0002 §2) | The identity condition becomes "PASSED, MANUAL_REVIEW or WAIVED". VERIFIED keeps meaning "checks done", not "identity confirmed" (ADR 0002 §6) | architect detail |
| GRADED routing | WAIVED adds no UNDER_REVIEW reason: a reviewer has no images to compare. GRADED → COMPLETED allows "PASSED, confirmed by a reviewer, or WAIVED". Alternative: always route waived sessions to UNDER_REVIEW (owner question 5) | architect detail |
| Verdict gate (ADR 0002 §6) | Does not apply to WAIVED, and a reviewer cannot change WAIVED into REVIEWED. The video check is advice, not a gate, so the verdict and the hiring decision are never blocked by it | owner decision C-19 ("advised"); gate: architect detail |
| Risk (FR-804, ADR 0005) | No re-check, so no FACE_MISMATCH. No IDENTITY_MANUAL_REVIEW. The waiver itself adds weight 0, and no event type is added. NO_FACE and MULTIPLE_FACES are scored as usual unless FACE is off | architect detail |
| Threshold review (ADR 0004 §2) | WAIVED rows are left out of the false-match and false-non-match rates and counted separately | architect detail |
| Report PDF (FR-1001) | "Identity check: waived (accommodation)" and "Video ID check: done / not done / not recorded"; never the reason | architect detail |
| Webhooks and CSV (FR-1003) | `identityCheck: { status: "WAIVED", videoCheck: "DONE" \| "NOT_DONE" \| "NOT_RECORDED" }`; never the reason | architect detail (BE-14 defines the payload) |
| Retention and erasure (ADR 0004) | The WAIVED row has no object keys. Erasure deletes `identity_checks` rows, video check included. At R-4, `reasonNote` is removed and `reasonCode` kept. Clearing all accommodations on erasure is ADR 0004 §9.7 question 3 (PR #48) | architect detail |

**UI text (architect detail):**
- **Reviewer (FE-11):** badge "Identity check waived", subtext "No ID image, selfie or face match. Waived by accommodation." Video line: "Video ID check: Done / Not done / Not recorded yet".
- **Recruiter (FE-05):** the control is labelled "No face match / no identity check" and requires a reason. Advice shown when it is set, and on the session until the check is recorded: "Before any hiring decision, check the candidate's ID on a video call, then record whether you did."
- **Candidate (FE-09):** the identity step is replaced by "No identity check is needed for this test. This was arranged with your recruiter."

**FR-305 wording proposal:**
> **FR-305** Per-candidate accommodations: extra time percentage, disabled detectors, allowed assistive tools, and "no face match / no identity check". Every change to accommodations writes an audit row. With "no face match / no identity check", the recruiter must record a reason; the candidate uploads no ID image or selfie, no face match or identity re-check runs, and reviewers see "Identity check waived". The recruiter is advised to check the candidate's ID on a video call before any hiring decision, and records whether that was done (C-02, C-19). Disabling the FACE detector is a separate setting: it stops in-browser face detection and the identity re-check, but the initial identity check still runs.

Also on acceptance: FR-403 adds "unless waived by accommodation (FR-305)". FR-606: no re-check when FACE is off or the identity check is waived. fsd.md §3 VERIFIED row: "identity passed, sent to manual review, or waived". fsd.md §4 adds the two staff routes.

## 8. Consequences and affected agents

| Agent | Task | What to do after acceptance |
| --- | --- | --- |
| db-engineer | new DB step (Delivery Lead schedules it) | Two migrations (section 4), `schema.prisma` enum value, three fields and named relations, header comment; tests for both CHECKs; one waived session in the seed (optional) |
| backend-engineer | BE-06 | `accommodationsSchema` with the waiver; invite and PATCH rules; WAIVED row lifecycle and lock; bulk CSV rejection; the four audit actions; permission map |
| backend-engineer | BE-07 | VERIFIED gate accepts WAIVED; GRADED routing; candidate DTO `identityCheckWaived`; candidate scope never writes WAIVED |
| integrity-engineer | BE-08 | Identity routes return 409 `IDENTITY_CHECK_WAIVED`; no face-match job for a waived session |
| backend-engineer | BE-09 | `ID_IMAGE`, `SELFIE` and `IDENTITY_RECHECK` presigns refused when waived |
| integrity-engineer | BE-12 | No risk change; test that a waived session gets no FACE_MISMATCH and no penalty; threshold metrics leave WAIVED out |
| backend-engineer | BE-13 | Review bundle identity panel (WAIVED, video status, reason by role); video-check route; verdict gate skips WAIVED |
| backend-engineer | BE-14 | Report, webhook and CSV fields |
| frontend-engineer | FE-05 | Two separate controls, reason, advice text, video-check control on the session view |
| frontend-engineer | FE-09, FE-11 | FE-09 skips the ID and selfie step and passes no re-checker to the SDK; FE-11 shows the badge |
| proctor-sdk-engineer | follow-up | No API change: with no `recheckIdentity` the re-check never starts. Add a test, and document the coupling (followups/proctor-sdk.md) |
| QA | new TCs (QA assigns IDs) | Reason required (OTHER needs a note); waived session reaches VERIFIED with no ID or selfie and presigns get 409; FACE off alone still runs the initial check; lock after the first attempt or VERIFIED; the four audit rows with no reason text; REVIEWER gets no reason; risk unchanged; video check 409 when not waived and 404 across orgs; bulk CSV row error; report and webhook carry WAIVED without the reason |
| hub | on acceptance | database.md DDL and Data rules; fsd.md FR-305, FR-403, FR-606, §3, §4; ADR 0002 §2 and §6; ADR 0008 §11; ADR 0010 shared request; ADR 0013 5.6 (`IDENTITY_CHECK_WAIVED`) and CS-4; api-contract.md |
| Delivery Lead | docs | requirements-trace FR-305; build-plan step for the migration; consent document (C-09) says what changes when the identity check is waived |

## 9. Owner questions

1. **Two settings** (DL recommendation, not yet answered): keep FACE-off and "no face match / no identity check" as separate settings with the meanings in section 3?
2. Should REVIEWER see only "Identity check waived", with the reason limited to RECRUITER and SUPER_ADMIN (proposed)?
3. A candidate who cannot use a webcam at all: the waiver does not cover room scan or webcam recording. Is a "no webcam" accommodation needed? That would be a separate ADR.
4. For reason `REFUSED_BIOMETRIC_PROCESSING`, should the waiver also switch off FACE and GAZE, which run face detection and landmarks in the browser and store nothing? Proposed: the UI suggests it and the recruiter decides. The DPIA may need to say which applies.
5. Should a waived session always go to UNDER_REVIEW (proposed: no, because a reviewer has nothing to compare)?
