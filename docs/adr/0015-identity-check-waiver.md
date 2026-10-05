# ADR 0015: Waived identity check ("no identity check")

| Field | Value |
| --- | --- |
| Status | **Proposed** 2026-10-05; revised after review round 1. The owner accepts or amends. "(owner decision C-xx)" marks what docs/compliance/decisions.md (PR #44) decides; "(architect detail)" marks what this ADR adds and the owner must confirm. Section 9 lists the owner questions. |
| Author | architecture hub |
| Decides | How C-02 ("no face match"), C-19 and C-25 are built: the two accommodation settings, schema, shared contract, API, audit, state machine, scoring and reporting |
| Serves | FR-305, FR-403, FR-606, FR-105, FR-805, FR-901, FR-1001, FR-1003; BR-12; NFR-05 |
| Builds on | ADR 0002 §2 and §6, ADR 0004 §1, §2 and §5, ADR 0005 (weights), ADR 0006 (org scope), ADR 0008 (freeze), ADR 0010 (shared contracts), ADR 0013 5.6, 5.7 and CS-4.4 (PR #39) |
| Amends (on acceptance) | ADR 0002 §2 and §6; ADR 0004 §2 (threshold metrics) and §5 (R-4, R-5); ADR 0008 (new §11); ADR 0010 (shared request, section 5); ADR 0013 5.6 and CS-4.4; database.md; fsd.md FR-305, FR-403, FR-606, §3, §4 |

## 1. Context

- Face matching is required for every candidate. If a candidate refuses, or cannot use the webcam, microphone or ID check, the recruiter handles it case by case through the per-invitation accommodation settings, "for example, disabled detectors or no face match". Recruiter actions on accommodations are audited (owner decision C-02).
- When face matching is waived, the recruiter must record a reason, and reviewers see "identity check waived". The recruiter is advised to check the candidate's ID on a video call before any hiring decision, and records whether that was done. All of it is audited (owner decision C-19). C-19 also names the shape of the change, word for word:
  > The invitation's accommodation carries the waiver reason. The identity check records a waived state. A "video ID check done: yes/no" field is recorded by the recruiter. All three write audit rows.
- There are two separate accommodation settings with distinct meanings: "no identity check" (the verification step is waived; C-19 applies) and "face detectors off" (the in-browser and server face detectors are off during the test) (owner decision C-25).
- A person reviews every session, and GRADED always goes to UNDER_REVIEW (owner decision C-28).

## 2. Options for where the waived state lives

| Option | Verdict |
| --- | --- |
| **(a) An `identity_checks` row with status WAIVED, plus the video-check columns on that row** | **Chosen (architect detail):** identity state stays in one table, and CHECK constraints guard it |
| (b) Columns on `sessions` (`identity_waived`, `video_check_*`) | Rejected: identity state would be split across two tables |
| (c) Everything in `invitations.accommodations` jsonb, the video check included | Rejected: no database guard, and a check recorded after the test is not an accommodation |

**The WAIVED row is authoritative (architect detail).** The VERIFIED gate, the presign refusals, routing, the review panel and reports all read the `identity_checks` row. `accommodations.identityCheckWaiver` is the recruiter's input and holds the reason. Both are written in one transaction. A consistency test asserts that the key is present exactly when a WAIVED row exists.

## 3. The two settings (owner decision C-25)

| Setting | Stored as | What is off | What still runs |
| --- | --- | --- | --- |
| **Face detectors off** | `accommodations.disabledDetectors` contains `FACE` | In-browser NO_FACE and MULTIPLE_FACES; the server identity re-check, so no FACE_MISMATCH (ADR 0013 5.6) | ID image, selfie, liveness and the initial face match (FR-403); GAZE unless it is also off |
| **No identity check** | `accommodations.identityCheckWaiver` present | ID image, selfie, liveness and the initial face match. The re-check also stops, because there is no verified selfie | Room scan, recordings (WEBCAM and AUDIO streams), and every detector not disabled |

How they interact (refusal codes: architect detail):

| FACE off | Waiver | ID and selfie step | Initial match | Browser face detection | Re-check presign (`IDENTITY_RECHECK`) |
| --- | --- | --- | --- | --- | --- |
| no | no | yes | yes | yes | allowed |
| yes | no | yes | yes | no | 409 `DETECTOR_DISABLED` (ADR 0013, unchanged) |
| no | yes | no: `ID_IMAGE` and `SELFIE` presigns and `POST /candidate/session/identity` get 409 `IDENTITY_CHECK_WAIVED` | no | yes | 409 `IDENTITY_CHECK_WAIVED` |
| yes | yes | no | no | no | 409 `IDENTITY_CHECK_WAIVED` (the waiver is checked first) |

**A refusal of biometric processing switches the face detectors off by default (architect detail; owner question OQ-15).** With reason `REFUSED_BIOMETRIC_PROCESSING`, the server adds `FACE` and `GAZE` to `disabledDetectors` when it sets the waiver. FACE covers browser face detection; GAZE uses face landmarks, which are face geometry (brd.md §7).
- The recruiter may switch either back on. That change is audited as `INVITATION_ACCOMMODATIONS_UPDATED`.
- If either is on, the candidate text names exactly what still runs: "Your webcam is still recorded, and the browser checks that a face is present [and where you are looking]. No face matching or identity check runs."
- decisions.md OQ-15 suggests turning off every face-based detector with no override. The DPIA should record which applies.

## 4. Schema (ADR 0008 post-freeze change)

**Accommodation (jsonb, no DDL).** `invitations.accommodations.identityCheckWaiver` carries the reason (owner decision C-19).

| Key | Type | Rule | Marker |
| --- | --- | --- | --- |
| `reasonCode` | `REFUSED_BIOMETRIC_PROCESSING` \| `CANNOT_COMPLETE_ID_CHECK` \| `OTHER` | Required. `CANNOT_USE_WEBCAM` is left out because the waiver still needs the webcam (owner question OQ-14) | reason required: owner decision C-19; codes: architect detail |
| `reasonNote` | string, 1..500, trimmed, control characters stripped | Allowed and required **only** when `reasonCode` is `OTHER`. The UI says not to enter health details | architect detail |

**`identity_checks` (DDL).**

| Change | Definition | Marker |
| --- | --- | --- |
| Enum value | `ALTER TYPE identity_check_status ADD VALUE 'WAIVED'`, appended last. It is not a rejection, so ADR 0004 §1 stands | waived state: owner decision C-19; value: architect detail |
| Column | `video_check_done boolean` (NULL = not recorded yet) | owner decision C-19 (yes/no field) |
| Column | `video_check_by uuid REFERENCES users(id)` (NO ACTION) | architect detail |
| Column | `video_check_at timestamptz` | architect detail |
| CHECK `identity_checks_waived_check` | `status <> 'WAIVED' OR (attempt = 1 AND id_image_key IS NULL AND selfie_key IS NULL AND face_match_score IS NULL AND model_id IS NULL AND threshold IS NULL AND liveness_passed IS NULL AND review_reason IS NULL AND manual_decision IS NULL AND reviewed_by IS NULL AND reviewed_at IS NULL AND review_note IS NULL)` | architect detail |
| CHECK `identity_checks_video_check_check` | `(video_check_done IS NULL) = (video_check_by IS NULL) AND (video_check_done IS NULL) = (video_check_at IS NULL) AND (video_check_done IS NULL OR status = 'WAIVED')` | architect detail |

The existing reviewed-complete CHECK still holds, because a WAIVED row has no `manual_decision`.

**Migration (architect detail).** Forward-only and additive, in two migrations, because Postgres refuses to use a new enum value in the transaction that adds it.
- The db-engineer runs `prisma migrate dev --create-only` locally and splits the generated SQL by hand:
  1. `..._identity_check_waived_enum`: only the `ALTER TYPE ... ADD VALUE 'WAIVED'`;
  2. `..._identity_check_waiver_columns`: the three nullable columns, the FK and the two CHECKs.
- In `schema.prisma`, `WAIVED` goes last in `IdentityCheckStatus`. The two relations from `IdentityCheck` to `User` need explicit names (for example `IdentityCheckReviewedBy` and `IdentityCheckVideoCheckBy`); the database does not change.
- Existing rows get NULLs and satisfy both CHECKs, so there is no backfill. TypeScript `switch` statements on `IdentityCheckStatus` stop compiling until they handle `WAIVED`, which is the intended guard.
- Org scope (ADR 0006) does not change.

**ADR 0008 amendment needed.** ADR 0008 §10 requires "a new ADR and a forward-only migration". Add §11, "Post-freeze deltas", with one row per change above (source: ADR 0015). Counts: enums stay at 20 (one gains a value); +3 columns; CHECK constraints go from 12 to 14; +1 FK with no ON DELETE clause; no new tables or indexes. The `schema.prisma` header comment (CHECK list and counts) is updated with it.

## 5. Shared contract (ADR 0010 amendment request)

| Name | Kind | Change |
| --- | --- | --- |
| `ACCOMMODATION_DETECTORS`, `AccommodationDetector` | const, type | New: the `PROCTOR_DETECTORS` subset an accommodation may disable (ADR 0013 asks for it too) |
| `IDENTITY_WAIVER_REASONS`, `identityWaiverReasonSchema`, `IdentityWaiverReason` | const, zod, type | New: the three `reasonCode` values |
| `identityCheckWaiverSchema`, `IdentityCheckWaiver` | zod, type | New: `{ reasonCode, reasonNote? }`, where `reasonNote` is allowed and required only for `OTHER` |
| `accommodationsSchema`, `Accommodations` | zod, type | New: `extraTimePct`, `disabledDetectors`, `allowedAssistiveTools`, `notes` (backend.md Step 6), plus the optional key **`identityCheckWaiver`** |
| `candidateAccommodationsSchema`, `CandidateAccommodations` | zod, type | New: the candidate projection `{ extraTimePct, disabledDetectors, allowedAssistiveTools, identityCheckWaived: boolean }` (ADR 0013 CS-4.4) |
| `IDENTITY_CHECK_STATUSES`, `identityCheckStatusSchema`, `IdentityCheckStatus` | const, zod, type | New: a mirror of the DB enum, with `WAIVED` |
| `identityVideoCheckRequestSchema`, `IdentityVideoCheckRequest` | zod, type | New: `{ done: boolean }` |
| `webhookIdentityCheckSchema`, `WebhookIdentityCheck` | zod, type | New: `{ status, videoCheck: "DONE" \| "NOT_DONE" \| "NOT_RECORDED" }` for webhooks and CSV (BE-14) |
| `PERMISSIONS` | const | Add `invitation_accommodations:read`, `invitation_accommodations:update` and `identity_video_check:record` |
| `RECRUITER_PERMISSIONS` | const | Add all three. SUPER_ADMIN gets them through `STAFF_PERMISSIONS`. REVIEWER and AUTHOR get none |
| Problem codes | const | `IDENTITY_CHECK_WAIVED`, `ACCOMMODATION_LOCKED`, `IDENTITY_NOT_WAIVED`: in packages/shared if ADR 0011 and ADR 0012 keep problem codes there, otherwise in api-contract.md |

## 6. API, access and audit

All paths are proposals; the final shape goes in api-contract.md (ADR 0012). Every row is an architect detail unless it is marked otherwise.

| Method and path | Who | Rule |
| --- | --- | --- |
| `POST /tests/:id/invitations` | RECRUITER (C-02); SUPER_ADMIN too | A single invite may carry `identityCheckWaiver`, and the WAIVED row is written in the same transaction. Bulk CSV rejects it as a row error, so each waiver is a case-by-case decision |
| `GET /invitations/:id/accommodations` | RECRUITER, SUPER_ADMIN (`invitation_accommodations:read`) | Returns the accommodations with the reason, plus the video-check status. The read is audited (FR-105) |
| `PATCH /invitations/:id/accommodations` | RECRUITER, SUPER_ADMIN (`invitation_accommodations:update`) | Body: the whole accommodations object (replace). See the waiver rules below |
| `PUT /sessions/:id/identity/video-check` | RECRUITER, SUPER_ADMIN (`identity_video_check:record`) | Body `{ done }`. Allowed in any session state while a WAIVED row exists, and it may be changed later. Otherwise 409 `IDENTITY_NOT_WAIVED`. Returns 404 after the row is gone (erasure or R-10). The service sets `video_check_by` from the authenticated user only, never from the body |
| Candidate identity routes and presigns | CANDIDATE | 409 `IDENTITY_CHECK_WAIVED` (section 3) |

**Waiver rules on PATCH:**
- The lock applies only to the `identityCheckWaiver` key. Other keys follow BE-06's rules.
- An unchanged waiver (deep-equal) passes through.
- Setting the waiver inserts the WAIVED row, and removing it deletes the row. Both are allowed only while the session is INVITED, OPENED or CONSENTED **and** no identity attempt exists. Otherwise the request gets 409 `ACCOMMODATION_LOCKED`.
- While the waiver is set it cannot be changed. To change the reason, remove the waiver and add it again, both before the lock.
- Removing the waiver also deletes any video check already recorded on the row; the removal is audited.
- The route locks the session row. `UNIQUE (session_id, attempt)` catches a race with a candidate upload.
- An object uploaded through a presign issued just before the waiver is deleted by ADR 0013's ingest-close sweep (identity images not referenced by `identity_checks`) and, as the final backstop, by R-4's prefix delete.

**Why the lock exists:** a waiver must not be used to wipe out a failed or low-confidence match. Once an attempt exists, the existing path applies: attempt 2, then MANUAL_REVIEW, and the candidate is never blocked (ADR 0004 §1). A candidate who cannot complete the ID check after starting takes that path. Because C-02 says "case by case", whether that is enough is owner question 4.

**Candidate scope (blocker fix; ADR 0013 CS-4.4).**
- `invitations.accommodations` is not in the CANDIDATE read allowlist. A column allowlist cannot project single jsonb keys.
- The candidate gets only `AccommodationsService.projection()`: `{ extraTimePct, disabledDetectors, allowedAssistiveTools, identityCheckWaived }`. It never gets `reasonCode`, `reasonNote` or `notes`. ADR 0013 round 6 (PR #39) already makes this change.
- Required test: no candidate-scope read returns `reasonCode`, `reasonNote` or `notes`.
- CS-4.4's `identity_checks` write list (`attempt`, `id_image_key`, `selfie_key`, `liveness_passed`) already stops candidate scope from writing `status`. So only the staff routes write WAIVED or `video_check_*`.

**Review bundle (architect detail; owner question OQ-13).** The bundle DTO is an allowlist projection by role. REVIEWER gets the status (the "Identity check waived" badge) and the video-check status, not the reason. RECRUITER and SUPER_ADMIN get the reason through the GET route above. AUTHOR gets nothing.

**Rate limits (architect detail).** Per staff user: PATCH accommodations 30 a minute, PUT video-check 30 a minute, GET accommodations 120 a minute (NFR-04).

**Audit rows.** `audit_logs` metadata holds IDs and action names only, never the reason (ADR 0001 C-3).

| Action | Actor | Entity | When | Marker |
| --- | --- | --- | --- | --- |
| `INVITATION_ACCOMMODATIONS_UPDATED` | staff user | invitation | Any change to accommodations, including the default FACE and GAZE switch-off and any switch back on. Metadata lists the changed key names | owner decision C-02; name: architect detail |
| `IDENTITY_CHECK_WAIVED` | staff user | identity_check | The waiver is set and the WAIVED row is written | owner decision C-19; name: architect detail |
| `IDENTITY_CHECK_WAIVER_REMOVED` | staff user | invitation | The waiver is removed before the lock. Metadata includes the deleted row's `identityCheckId` | architect detail |
| `IDENTITY_VIDEO_CHECK_DONE` / `IDENTITY_VIDEO_CHECK_NOT_DONE` | staff user | identity_check | The video check is recorded or changed | owner decision C-19; names: architect detail |

## 7. State machine, scoring, reporting

| Area | Rule | Marker |
| --- | --- | --- |
| CONSENTED → VERIFIED (ADR 0002 §2) | The identity condition becomes "PASSED, MANUAL_REVIEW or WAIVED". VERIFIED still means "checks done", not "identity confirmed" (ADR 0002 §6). Gate invariant: if a WAIVED row exists, it is the only identity row. Otherwise the gate refuses and raises an alert | architect detail |
| GRADED → UNDER_REVIEW | Always, as for every session (owner decision C-28). A waived session shows the "Identity check waived" badge in review. ADR 0002's "COMPLETED with identity PASSED or reviewer-confirmed" path no longer exists under C-28 | owner decision C-28 |
| Verdict gate (ADR 0002 §6) | Does not apply to WAIVED: there are no images to compare, and a reviewer cannot change WAIVED into REVIEWED. The video check is advice, not a gate | "advised": owner decision C-19; gate: architect detail |
| Risk (FR-804, ADR 0005) | No re-check, so no FACE_MISMATCH and no IDENTITY_MANUAL_REVIEW. The waiver adds weight 0, and no event type is added. NO_FACE and MULTIPLE_FACES are scored as usual unless FACE is off | architect detail |
| Threshold review (ADR 0004 §2) | WAIVED rows are left out of the false-match and false-non-match rates and counted separately | architect detail |
| Report PDF, webhooks, CSV (FR-1001, FR-1003) | Outside the recruiter view: "Identity check waived" and the video-check status (`webhookIdentityCheckSchema`); never the reason and never "accommodation", because accommodation status is health-adjacent (owner question 5). Results reach recruiters, exports and webhooks only after the verdict (C-28) | owner decision C-28; wording: architect detail |
| Retention and erasure (ADR 0004 §5) | The WAIVED row has no object keys. Erasure and R-10 (PR #48) delete `identity_checks` rows, the video check included. At R-4, `reasonNote` is removed and `reasonCode` is kept. Clearing all accommodations on erasure is OQ-12 | architect detail |

**UI text (architect detail):**
- **Reviewer (FE-11):** badge "Identity check waived", with the subtext "No ID image, selfie or face match." Video line: "Video ID check: Done / Not done / Not recorded yet".
- **Recruiter (FE-05):** the control is labelled "No identity check" and needs a reason. It sits apart from "Face detectors off". This advice appears when the waiver is set, and stays on the session until the video check is recorded: "Before any hiring decision, check the candidate's ID on a video call, then record whether you did."
- **Candidate (FE-09):** the identity step is replaced by "No identity check is needed for this test. This was arranged with your recruiter." If any face detector is still on, this is followed by the sentence in section 3. The age confirmation (C-30) and the consent step do not change.

**FR-305 wording proposal:**
> **FR-305** Per-candidate accommodations: extra time percentage, disabled detectors ("face detectors off" among them), allowed assistive tools, and "no identity check". Every change to accommodations writes an audit row. With "no identity check", the recruiter must record a reason; the candidate uploads no ID image or selfie, no face match or identity re-check runs, and reviewers see "Identity check waived". The recruiter is advised to check the candidate's ID on a video call before any hiring decision, and records whether that was done (C-02, C-19, C-25). "Face detectors off" stops the in-browser and server face detectors during the test, but the initial identity check still runs.

Also on acceptance:
- FR-403 adds "unless waived by accommodation (FR-305)".
- FR-606: no re-check when face detectors are off or the identity check is waived.
- fsd.md §3 VERIFIED row: "identity passed, sent to manual review, or waived".
- fsd.md §4 adds the three staff routes.

## 8. Consequences and affected agents

| Agent | Task | What to do after acceptance |
| --- | --- | --- |
| db-engineer | new DB step (the Delivery Lead schedules it) | The two migrations (section 4, `--create-only`, split by hand); `schema.prisma` with `WAIVED` last, the three fields and the named relations; the header comment; tests for both CHECKs; optionally, one waived session in the seed |
| backend-engineer | BE-06 | `accommodationsSchema` with the waiver; invite, GET and PATCH rules and lock; the REFUSED_BIOMETRIC_PROCESSING default; bulk CSV rejection; the audit actions; permission map; rate limits |
| backend-engineer | BE-07 | VERIFIED gate accepts WAIVED, with the invariant; `AccommodationsService.projection()` (CS-4.4); a test that the candidate scope never reads the reason |
| integrity-engineer | BE-08 | Identity routes return 409 `IDENTITY_CHECK_WAIVED`, and no face-match job runs. Tests: an identity upload is refused when a WAIVED row exists, so no attempt-2 row can sit next to a WAIVED attempt-1 row |
| backend-engineer | BE-09 | Refuse `ID_IMAGE`, `SELFIE` and `IDENTITY_RECHECK` presigns when waived; add `IDENTITY_CHECK_WAIVED` to the 5.6 error list |
| integrity-engineer | BE-12 | No risk change. Test that a waived session gets no FACE_MISMATCH and no penalty. Threshold metrics leave WAIVED out |
| backend-engineer | BE-13 | Review bundle allowlist projection by role; the video-check route (`video_check_by` from the session user); no verdict gate for WAIVED |
| backend-engineer | BE-14 | Report, webhook and CSV fields, "Identity check waived" wording, results only after the verdict |
| frontend-engineer | FE-05 | Two separate controls, reason, advice text, the default FACE and GAZE switch-off shown and editable, and the video-check control |
| frontend-engineer | FE-09, FE-11 | FE-09 skips the ID and selfie step, shows the candidate text, and passes no re-checker to the SDK. FE-11 shows the badge |
| proctor-sdk-engineer | follow-up | No API change: with no `recheckIdentity`, the re-check never starts. Add a test and document the coupling |
| QA | new TCs (QA assigns the IDs) | Reason rules (`OTHER` only, with a note); a waived session reaches VERIFIED with no ID or selfie, its presigns get 409, and it goes to UNDER_REVIEW with the badge; face detectors off alone still runs the initial check; REFUSED_BIOMETRIC_PROCESSING defaults FACE and GAZE off; lock after the first attempt or VERIFIED, and an unchanged waiver passes; audit rows carry no reason text; the candidate scope and REVIEWER get no reason; risk unchanged; video check 409 when not waived, 404 across orgs and after erasure; bulk CSV row error; report and webhook carry "Identity check waived" without the reason; key-and-row consistency |
| hub | on acceptance | database.md DDL and Data rules; fsd.md FR-305, FR-403, FR-606, §3, §4; ADR 0002 §2 and §6; ADR 0004 §2 and §5 (R-4 removes `reasonNote`; R-5); ADR 0008 §11; ADR 0010 (section 5); ADR 0013 5.6 error list and CS-4.4 (the projection is already in round 6); api-contract.md |
| Delivery Lead | docs | requirements-trace FR-305; build-plan step for the migration; the consent document says what changes when the identity check is waived; the DPIA (OQ-15) |

## 9. Owner questions

Decided since the first draft: two separate settings (C-25); every session reviewed (C-28).

1. **OQ-13:** should the reason be hidden from REVIEWER, with only RECRUITER and SUPER_ADMIN seeing it (proposed)?
2. **OQ-14, widened:** a candidate who cannot use the webcam **or the microphone**. The waiver still needs room scan, the WEBCAM stream and the AUDIO stream. Is a separate "no webcam" or "no microphone" accommodation needed (a separate ADR)?
3. **OQ-15:** with REFUSED_BIOMETRIC_PROCESSING, FACE and GAZE are off by default and the recruiter may switch them back on (proposed). Or should they always be off, with no override (decisions.md's suggestion)? The DPIA records the answer.
4. **Lock (new):** once an identity attempt exists, the waiver is refused and the candidate follows attempt 2, then MANUAL_REVIEW. Given C-02's "case by case", is that enough?
5. **Report wording (new):** outside the recruiter view, "Identity check waived" without "accommodation" (proposed)?
