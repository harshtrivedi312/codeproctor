# ADR 0015: Waived identity check ("no identity check")

| Field | Value |
| --- | --- |
| Status | **Proposed** 2026-10-05; revised after review rounds 1 and 2. The owner accepts or amends. "(owner decision C-xx)" marks what docs/compliance/decisions.md (PR #44) decides. "(DL decision under C-25)" marks the Delivery Lead's ruling on how C-25 applies. "(architect detail)" marks what this ADR adds, which the owner must confirm. Section 9 lists the owner questions. |
| Author | architecture hub |
| Decides | How C-02 ("no face match"), C-19 and C-25 are built: the two accommodation settings, schema, shared contract, API, locking, audit, state machine, scoring and reporting |
| Serves | FR-305, FR-403, FR-606, FR-105, FR-805, FR-901, FR-1001, FR-1003; BR-12; NFR-05 |
| Builds on | ADR 0002 §2 and §6, ADR 0004 §1, §2 and §5 (and §9, PR #48), ADR 0005 (weights), ADR 0006 (org scope, §8.5), ADR 0008 (freeze), ADR 0010 (shared contracts), ADR 0013 5.6, 5.7, CS-4.4 and `verify-session` (PR #39) |
| Amends (on acceptance) | ADR 0002 §2 and §6; ADR 0004 §2 (threshold metrics) and §5 (R-4, R-5, R-6); ADR 0008 (new §11); ADR 0010 (section 5 request); ADR 0013 5.6 (refusal codes) and CS-4.4; database.md; fsd.md FR-305, FR-403, FR-606, §3, §4 |

## 1. Context

- Face matching is required for every candidate. If a candidate refuses, or cannot use the webcam, microphone or ID check, the recruiter handles it case by case through the per-invitation accommodation settings, "for example, disabled detectors or no face match". Recruiter actions on accommodations are audited (owner decision C-02).
- When face matching is waived, the recruiter must record a reason, and reviewers see "identity check waived". The recruiter is advised to check the candidate's ID on a video call before any hiring decision, and records whether that was done. All of it is audited (owner decision C-19). C-19 also names the shape of the change, quoted word for word:
  > The invitation's accommodation carries the waiver reason. The identity check records a waived state. A "video ID check done: yes/no" field is recorded by the recruiter. All three write audit rows.
- There are two separate accommodation settings with distinct meanings: "no identity check" (the verification step is waived, and C-19 applies) and "face detectors off" (the in-browser and server face detectors are off during the test) (owner decision C-25).
- Biometrics rest on explicit consent (owner decisions C-02, C-29). A person reviews every session, and GRADED always goes to UNDER_REVIEW (owner decision C-28).
- **Today the SDK couples the two settings:** disabling the FACE detector also disables the identity re-check. That cannot satisfy C-25. The identity re-check is therefore part of identity verification and is governed by "no identity check", not by the FACE detector (DL decision under C-25). ADR 0013 round 7 changes its `DETECTOR_DISABLED` refusal to match.

## 2. Options for where the waived state lives

| Option | Verdict |
| --- | --- |
| **(a) An `identity_checks` row with status WAIVED, plus the video-check columns on that row** | **Chosen (architect detail):** identity state stays in one table, and CHECK constraints guard it |
| (b) Columns on `sessions` (`identity_waived`, `video_check_*`) | Rejected: identity state would be split across two tables |
| (c) Everything in `invitations.accommodations` jsonb, the video check included | Rejected: no database guard, and a check recorded after the test is not an accommodation |

**The WAIVED row is authoritative (architect detail).** The VERIFIED gate, presign refusals, routing, the review panel and reports all read the `identity_checks` row. `accommodations.identityCheckWaiver` is the recruiter's input and carries the reason. Both are written in one transaction.

The consistency invariant is: the waiver key is present exactly when a WAIVED row exists. It is tested, and it holds only for sessions that are neither erased nor past R-10, because those steps delete the row and reduce the key (section 7).

## 3. The two settings (owner decision C-25)

| Setting | Stored as | What is off | What still runs |
| --- | --- | --- | --- |
| **Face detectors off** | `accommodations.disabledDetectors` contains `FACE` | In-browser NO_FACE and MULTIPLE_FACES, plus any server-side face-presence analysis (none exists today) | ID image, selfie, liveness, the initial face match **and the periodic identity re-check** (DL decision under C-25); GAZE unless it is also off |
| **No identity check** | `accommodations.identityCheckWaiver` present | ID image, selfie, liveness, the initial face match and the identity re-check (no FACE_MISMATCH) | Room scan, recordings (WEBCAM and AUDIO), and every detector not disabled |

How the two settings interact (refusal codes are architect detail):

| FACE off | Waiver | ID and selfie step | Initial match | Browser face detection | Re-check (`IDENTITY_RECHECK` presign and `/identity/recheck`) |
| --- | --- | --- | --- | --- | --- |
| no | no | yes | yes | yes | runs |
| yes | no | yes | yes | no | **runs**; not refused |
| no | yes | no: `ID_IMAGE` and `SELFIE` presigns and `POST /candidate/session/identity` get 409 `IDENTITY_CHECK_WAIVED` | no | yes | 409 `IDENTITY_CHECK_WAIVED` |
| yes | yes | no | no | no | 409 `IDENTITY_CHECK_WAIVED` |

- ADR 0013 5.6 no longer refuses a re-check with `DETECTOR_DISABLED` when FACE is off (round 7).
- The SDK must capture re-check frames independently of the FACE detector. Today `vision-monitor.ts` runs the re-check only when the face task is loaded.

**Refusing biometric processing switches off every face-based detector (architect detail; owner question OQ-15).** When `reasonCode` is `REFUSED_BIOMETRIC_PROCESSING`, the server adds `FACE` and `GAZE` to `disabledDetectors` as it sets the waiver. GAZE uses face landmarks, which count as face geometry: a "scan of face geometry" is a biometric identifier under BIPA 740 ILCS 14/10 (flag for owner/Legal advice, not verified by the architect; the DPIA records it).
- **Re-enabling is narrow.** While the reason is `REFUSED_BIOMETRIC_PROCESSING`, `FACE` or `GAZE` may be removed from `disabledDetectors` only while the session is INVITED or OPENED, before the candidate sees the consent document or the identity-step text. The request must also carry the explicit body flag `confirmFaceDetectorsOn: true`, and it writes the distinct audit action `BIOMETRIC_REFUSAL_DETECTORS_REENABLED`. Otherwise the server returns 409 `ACCOMMODATION_LOCKED`.
- If either detector is on, the candidate text names exactly what still runs (section 7).
- decisions.md OQ-15 suggests "always off, no override". The override above is the open owner choice; the default is the more private option.
- **Removing the waiver keeps FACE and GAZE disabled.** The recruiter removes them explicitly, under the rule above, with an audit row (architect detail).

## 4. Schema (ADR 0008 post-freeze change)

**Accommodation (jsonb, no DDL).** `invitations.accommodations.identityCheckWaiver` carries the reason (owner decision C-19).

| Key | Type | Rule | Marker |
| --- | --- | --- | --- |
| `reasonCode` | `REFUSED_BIOMETRIC_PROCESSING` \| `CANNOT_COMPLETE_ID_CHECK` \| `OTHER` | Required. There is no `CANNOT_USE_WEBCAM`, because the waiver still needs the webcam (OQ-14) | reason required: owner decision C-19; codes: architect detail |
| `reasonNote` | string, 1..500, trimmed, control characters stripped | Allowed and required **only** when `reasonCode` is `OTHER`. The UI says not to enter health details | architect detail |

**`identity_checks` (DDL).**

| Change | Definition | Marker |
| --- | --- | --- |
| Enum value | `ALTER TYPE identity_check_status ADD VALUE 'WAIVED'`, appended last. It is not a rejection, so ADR 0004 §1 stands | waived state: owner decision C-19; value: architect detail |
| Column | `video_check_done boolean` (NULL = not recorded yet) | owner decision C-19 |
| Column | `video_check_by uuid REFERENCES users(id)` (NO ACTION). It is not org-composite: the service guarantees the user is in the same org, as it does for `reviewed_by` | architect detail |
| Column | `video_check_at timestamptz` | architect detail |
| CHECK `identity_checks_waived_check` | `status <> 'WAIVED' OR (attempt = 1 AND id_image_key IS NULL AND selfie_key IS NULL AND face_match_score IS NULL AND model_id IS NULL AND threshold IS NULL AND liveness_passed IS NULL AND review_reason IS NULL AND manual_decision IS NULL AND reviewed_by IS NULL AND reviewed_at IS NULL AND review_note IS NULL)` | architect detail |
| CHECK `identity_checks_video_check_check` | `(video_check_done IS NULL) = (video_check_by IS NULL) AND (video_check_done IS NULL) = (video_check_at IS NULL) AND (video_check_done IS NULL OR status = 'WAIVED')` | architect detail |

**Migration (architect detail).** Forward-only and additive, in two migrations, because Postgres refuses to use a new enum value in the transaction that adds it.
- The db-engineer runs `prisma migrate dev --create-only` locally and splits the output by hand:
  1. `..._identity_check_waived_enum`: only the `ALTER TYPE`;
  2. `..._identity_check_waiver_columns`: the columns and the FK, plus the two CHECKs, added by hand (Prisma cannot express them).
- **If `migrate dev` proposes a reset because of drift, stop and ask the human (ADR 0009).**
- `schema.prisma` changes:
  - `WAIVED` goes last in `IdentityCheckStatus`.
  - Name both relations from `IdentityCheck` to `User` (for example `IdentityCheckReviewedBy` and `IdentityCheckVideoCheckBy`).
  - Add a second back-relation field on `User` (for example `videoCheckedIdentityChecks IdentityCheck[]`) next to `reviewedIdentityChecks`.
  - Update the header comment: columns 294 → 297, FKs 58 → 59, CHECKs 12 → 14, with the two new CHECKs listed.
- Existing rows get NULLs and satisfy both CHECKs, so no backfill is needed. `switch` statements on `IdentityCheckStatus` stop compiling until they handle `WAIVED`.

**ADR 0008 amendment needed.** ADR 0008 §10 requires "a new ADR and a forward-only migration". Add §11, "Post-freeze deltas", with one row per change above. Counts: enums stay at 20 (one gains a value); columns +3; CHECK constraints 12 → 14; FKs 58 → 59, the new one with no ON DELETE clause; no new tables or indexes.

## 5. Shared contract (ADR 0010 amendment request)

| Name | Kind | Change |
| --- | --- | --- |
| `ACCOMMODATION_DETECTORS`, `AccommodationDetector` | const, type | New: the `PROCTOR_DETECTORS` subset an accommodation may disable |
| `IDENTITY_WAIVER_REASONS`, `identityWaiverReasonSchema`, `IdentityWaiverReason` | const, zod, type | New: the three `reasonCode` values |
| `identityCheckWaiverSchema`, `IdentityCheckWaiver` | zod, type | New: `{ reasonCode, reasonNote? }`, with `reasonNote` only for `OTHER` |
| `accommodationsSchema`, `Accommodations` | zod, type | New: `extraTimePct`, `disabledDetectors`, `allowedAssistiveTools`, `notes` (backend.md Step 6), plus the optional `identityCheckWaiver` |
| `accommodationsPatchSchema` | zod | New: the PATCH body, `{ accommodations, confirmFaceDetectorsOn?: true }` |
| `candidateAccommodationsSchema`, `CandidateAccommodations` | zod, type | New: the candidate projection `{ extraTimePct, disabledDetectors, allowedAssistiveTools, identityCheckWaived }` (ADR 0013 CS-4.4) |
| `invitationAccommodationsResponseSchema` | zod | New: the audited GET response, `{ accommodations, identityCheck: { status, videoCheck: "DONE" \| "NOT_DONE" \| "NOT_RECORDED", videoCheckAt } \| null }` |
| `reviewIdentityProjectionSchema` | zod | New: what REVIEWER gets in the review bundle, `{ status, attempt, videoCheck }`, with no reason |
| `IDENTITY_CHECK_STATUSES`, `identityCheckStatusSchema`, `IdentityCheckStatus` | const, zod, type | New: a mirror of the DB enum, with `WAIVED` |
| `identityVideoCheckRequestSchema` | zod | New: `{ done: boolean }` |
| `webhookIdentityCheckSchema`, `WebhookIdentityCheck` | zod, type | New: `{ status, videoCheck }` for webhooks and CSV (BE-14) |
| `PERMISSIONS`, `RECRUITER_PERMISSIONS` | const | Add `invitation_accommodations:read`, `invitation_accommodations:update` and `identity_video_check:record`. SUPER_ADMIN gets them through `STAFF_PERMISSIONS`; REVIEWER and AUTHOR get none |
| Problem codes | const | `IDENTITY_CHECK_WAIVED`, `ACCOMMODATION_LOCKED`, `IDENTITY_NOT_WAIVED` (and 412 `PRECONDITION_FAILED`), wherever ADR 0011 and 0012 keep problem codes |

## 6. API, locking, access and audit

Paths are proposals; the final shape goes in api-contract.md (ADR 0012). Everything in this section is an architect detail unless marked otherwise.

| Method and path | Who | Rule |
| --- | --- | --- |
| `POST /tests/:id/invitations` | `invitation:create`, **plus `invitation_accommodations:update` when the body carries `accommodations`** | A single invite may carry `identityCheckWaiver`. At invite time it writes, in the same transaction: the invitation and session, the WAIVED row, `INVITATION_ACCOMMODATIONS_UPDATED`, `IDENTITY_CHECK_WAIVED`, and for REFUSED_BIOMETRIC_PROCESSING the FACE and GAZE switch-off (in the same accommodations row). Bulk CSV rejects a waiver as a row error |
| `GET /invitations/:id/accommodations` | `invitation_accommodations:read` (RECRUITER, SUPER_ADMIN) | `invitationAccommodationsResponseSchema`. This is the **only** path that returns the reason. It writes `INVITATION_ACCOMMODATIONS_READ` (FR-105). Returns an `ETag` |
| `PATCH /invitations/:id/accommodations` | `invitation_accommodations:update` | Replace semantics. **Requires `If-Match`** with the ETag, which is a hash of the stored jsonb (no schema change). A mismatch gets 412. Rules below |
| `PUT /sessions/:id/identity/video-check` | `identity_video_check:record` | Body `{ done }`. Allowed in any session state while a WAIVED row exists, and may be changed later. Otherwise 409 `IDENTITY_NOT_WAIVED`. Returns 404 once the row is gone (erasure, R-10). `video_check_by` comes only from the authenticated user |
| Candidate identity routes and presigns | CANDIDATE | 409 `IDENTITY_CHECK_WAIVED` (section 3) |

RECRUITER may waive (owner decision C-02). SUPER_ADMIN may as well (architect detail).

**Waiver rules on PATCH:**
- The lock below applies only to the `identityCheckWaiver` key and to the FACE and GAZE rule in section 3. An unchanged waiver (deep-equal) passes through.
- **Setting** the waiver is allowed in INVITED, OPENED or CONSENTED while no identity attempt exists. It inserts the WAIVED row. If the gate runs concurrently it reads no identity row and refuses, and the next `verify-session` run sees the WAIVED row.
- **Removing** the waiver is allowed **only in INVITED or OPENED**. It deletes the WAIVED row, together with any video check recorded on it. It cannot race `verify-session`, which acts only in CONSENTED.
- While the waiver is set it cannot be changed: remove it and add it again, within these windows. Otherwise 409 `ACCOMMODATION_LOCKED`.
- **Lock mechanism.** Every PATCH transaction first runs `SessionStateService.lockForAccommodation(sessionId)`, which is a raw `SELECT status FROM sessions WHERE id = $1 AND org_id = $2 FOR UPDATE`.
  - ADR 0006 §8.5 refuses raw SQL only in `sessionId` scopes; this is a staff `runInOrg` scope.
  - The state rules are checked on the locked status.
  - Each `SessionStateService.transition()` (OPENED → CONSENTED, CONSENTED → VERIFIED) is a compare-and-set `UPDATE`. That `UPDATE` waits on the row lock and re-evaluates its `status =` condition after the PATCH commits. So a removal either commits before the candidate reaches CONSENTED, or it is refused.
  - `UNIQUE (session_id, attempt)` also catches a race with a candidate upload.
- **Gate rule.** CONSENTED → VERIFIED refuses when no identity row exists (no PASSED, MANUAL_REVIEW or WAIVED) and raises an alert. It also refuses if a WAIVED row exists alongside any other attempt.
- **Orphans.** An object uploaded through a presign issued just before the waiver is deleted by ADR 0013's ingest-close sweep (identity images not referenced by `identity_checks`) and, as the final backstop, by the R-4 deletion.

**Why the lock exists:** a waiver must not wipe out a failed or low-confidence match. Once an attempt exists, the existing path applies: attempt 2, then MANUAL_REVIEW, and the candidate is never blocked (ADR 0004 §1). A candidate who cannot complete the ID check after starting goes down that path (owner question 4, because C-02 says "case by case").

**Candidate scope (ADR 0013 CS-4.4).**
- `invitations.accommodations` is not in the CANDIDATE read allowlist; a column allowlist cannot project jsonb keys.
- The candidate gets only `AccommodationsService.projection()` (ADR 0013 round 6).
- Test: no candidate-scope read returns `reasonCode`, `reasonNote` or `notes`.
- CS-4.4's `identity_checks` write list already keeps candidate scope away from `status` and `video_check_*`.

**Staff DTOs.** Every staff response except the audited GET excludes `identityCheckWaiver.reasonCode`, `reasonNote` and `notes` through an allowlist DTO, with a test. That covers invitation lists, session detail, the recruiter CSV and the review bundle. In the review bundle, REVIEWER gets `reviewIdentityProjectionSchema` (the "Identity check waived" badge and the video-check status) and AUTHOR gets nothing (owner question OQ-13).

**Rate limits.** Per staff user: PATCH accommodations 30 a minute, PUT video-check 30 a minute, GET accommodations 120 a minute (NFR-04).

**Audit rows.** Each audit row is written **in the same transaction** as the change it records. `audit_logs` metadata holds IDs and action names only, never the reason (ADR 0001 C-3).

| Action | Entity | When | Marker |
| --- | --- | --- | --- |
| `INVITATION_ACCOMMODATIONS_UPDATED` | invitation | Any change to accommodations, including the automatic FACE and GAZE switch-off. Metadata lists the changed key names | owner decision C-02; name: architect detail |
| `BIOMETRIC_REFUSAL_DETECTORS_REENABLED` | invitation | FACE or GAZE switched back on under REFUSED_BIOMETRIC_PROCESSING (INVITED or OPENED only) | architect detail |
| `IDENTITY_CHECK_WAIVED` | identity_check | The waiver is set and the WAIVED row is written | owner decision C-19 |
| `IDENTITY_CHECK_WAIVER_REMOVED` | invitation | The waiver is removed; metadata holds the deleted row's `identityCheckId` | architect detail |
| `IDENTITY_VIDEO_CHECK_DONE` / `IDENTITY_VIDEO_CHECK_NOT_DONE` | identity_check | The video check is recorded or changed | owner decision C-19 |
| `INVITATION_ACCOMMODATIONS_READ` | invitation | The audited GET | FR-105 |

## 7. State machine, scoring, reporting, retention

| Area | Rule | Marker |
| --- | --- | --- |
| CONSENTED → VERIFIED (ADR 0002 §2) | The identity condition becomes "PASSED, MANUAL_REVIEW or WAIVED", under the gate rule in section 6. VERIFIED keeps its meaning of "checks done" (ADR 0002 §6) | architect detail |
| GRADED → UNDER_REVIEW | Always, as for every session (owner decision C-28), with the "Identity check waived" badge | owner decision C-28 |
| Verdict gate (ADR 0002 §6) | Does not apply to WAIVED; a reviewer cannot change WAIVED into REVIEWED. The video check is advice, not a gate | "advised": owner decision C-19; gate: architect detail |
| Risk (FR-804, ADR 0005) | No re-check for a waived session, so no FACE_MISMATCH and no IDENTITY_MANUAL_REVIEW. The waiver adds weight 0, and no event type is added. With FACE off but no waiver, the re-check still runs and scores as usual | architect detail; re-check rule: DL decision under C-25 |
| Threshold review (ADR 0004 §2) | WAIVED rows are left out of false-match and false-non-match rates and counted separately | architect detail |
| Report PDF, webhooks, CSV (FR-1001, FR-1003) | "Identity check waived" and the video-check status, never "accommodation". **The reason never appears in the PDF, webhooks or CSV, whoever receives them**; it is available only through the audited GET. Results go out only after the verdict (C-28) | owner decision C-28; wording: architect detail; owner question 5 |
| Erasure and R-10 (ADR 0004 §9, PR #48) | Delete the `identity_checks` row, including the video check. In `invitations.accommodations`, `identityCheckWaiver` is replaced by `identityCheckWaived: true` (no reason), or the whole object is cleared if OQ-12 is answered yes. At R-4 (`retention_days`), `reasonNote` is removed | architect detail |

**UI text (architect detail):**
- **Reviewer (FE-11):** badge "Identity check waived", with the subtext "No ID image, selfie or face match." Video line: "Video ID check: Done / Not done / Not recorded yet".
- **Recruiter (FE-05):** the control is labelled "No identity check", needs a reason, and sits apart from "Face detectors off". This advice is shown when the waiver is set, and on the session until the check is recorded: "Before any hiring decision, check the candidate's ID on a video call, then record whether you did." For REFUSED_BIOMETRIC_PROCESSING the UI shows FACE and GAZE as off. Turning either back on needs a confirmation, and only before consent.
- **Candidate (FE-09):** the identity step is replaced by "No identity check is needed for this test. This was arranged with your recruiter." If FACE or GAZE is still on, the text continues: "Your webcam is still recorded, and the browser checks that a face is present [and where you are looking]. No face matching or identity check runs."

**FR-305 wording proposal:**
> **FR-305** Per-candidate accommodations: extra time percentage, disabled detectors ("face detectors off" among them), allowed assistive tools, and "no identity check". Every change to accommodations writes an audit row. With "no identity check", the recruiter must record a reason; the candidate uploads no ID image or selfie, no face match or identity re-check runs, and reviewers see "Identity check waived". The recruiter is advised to check the candidate's ID on a video call before any hiring decision, and records whether that was done (C-02, C-19, C-25). "Face detectors off" stops the in-browser and server face detectors during the test; the identity check and its periodic re-check still run.

Also on acceptance:
- FR-403 adds "unless waived by accommodation (FR-305)".
- FR-606: the re-check does not run when the identity check is waived. Disabling FACE does not stop it.
- fsd.md §3 VERIFIED row becomes "identity passed, sent to manual review, or waived".
- fsd.md §4 adds the staff routes.

**Dependency before the pilot (Delivery Lead and owner).** A REFUSED_BIOMETRIC_PROCESSING candidate still signs the same consent version, which includes explicit biometric consent. The signed record then misstates what the candidate consented to. One of these is needed: a consent variant for waived candidates, or the consent record and PDF noting that biometric consent was not given. Both depend on the consent document (C-09) and the age confirmation (C-30), which stays unchanged.

## 8. Consequences and affected agents

| Agent | Task | What to do after acceptance |
| --- | --- | --- |
| db-engineer | new DB step (the Delivery Lead schedules it) | Section 4 migrations (`--create-only`, split by hand, CHECKs by hand, stop on any reset prompt); `schema.prisma` (enum, fields, named relations, the `User` back-relation, header counts); CHECK tests |
| backend-engineer | BE-06 | Schemas; invite permission rule and invite-time audit; GET with ETag and audit; PATCH with If-Match, windows, lock helper and the FACE and GAZE rule; staff allowlist DTOs; audit in the same transaction; rate limits |
| backend-engineer | BE-07 | `lockForAccommodation`; gate rule and alert; `verify-session` re-checks under the transition compare-and-set; `AccommodationsService.projection()` and its test |
| integrity-engineer | BE-08 | Identity routes return 409 `IDENTITY_CHECK_WAIVED`, and no match job runs. Test: an upload is refused while a WAIVED row exists, so no attempt-2 row can sit next to a WAIVED attempt-1 |
| backend-engineer | BE-09 | Refuse `ID_IMAGE`, `SELFIE` and `IDENTITY_RECHECK` presigns when waived, and no longer refuse a re-check because FACE is off (ADR 0013 5.6) |
| integrity-engineer | BE-12 | No risk change; tests for a waived session and for a FACE-off session that is still re-checked; threshold metrics leave WAIVED out |
| backend-engineer | BE-13, BE-14 | Review projection by role; video-check route; no verdict gate for WAIVED; report, webhook and CSV wording with no reason |
| frontend-engineer | FE-05, FE-09, FE-11 | Two controls, the reason, advice, the FACE and GAZE display and confirmation, the video-check control, ETag handling; candidate text; badge |
| proctor-sdk-engineer | follow-up | **Decouple the re-check from the FACE detector**: capture re-check frames when the app passes `recheckIdentity`, whether or not the face task is loaded. With no `recheckIdentity` (waived), the re-check never starts. Tests for both |
| QA | new TCs (QA assigns IDs) | Reason rules; waived session reaches VERIFIED and UNDER_REVIEW with the badge, and its presigns get 409; FACE off alone still runs the initial check and the re-check; REFUSED_BIOMETRIC_PROCESSING defaults FACE and GAZE off, and re-enabling is refused after OPENED; **race: a PATCH removal concurrent with OPENED → CONSENTED and with `verify-session` never yields VERIFIED with no identity row**; gate refuses with no identity row; If-Match 412; invite permission rule; same-transaction audit rows with no reason text; staff DTOs, candidate scope and REVIEWER get no reason; video check 409, 404 across orgs and after erasure; bulk CSV row error; report, webhook and CSV carry no reason; invariant scoped to live sessions |
| hub | on acceptance | database.md; fsd.md FR-305, FR-403, FR-606, §3, §4; ADR 0002 §2 and §6; ADR 0004 §2 and §5 (R-4 `reasonNote`; erasure and R-10 waiver reduction); ADR 0008 §11; ADR 0010 (section 5); ADR 0013 5.6 (refusal codes, round 7) and CS-4.4; api-contract.md |
| Delivery Lead | docs | requirements-trace FR-305; build-plan migration step; the consent dependency (section 7); DPIA on OQ-15 and the GAZE classification |

## 9. Owner questions

Already decided since the first draft: two settings (C-25); every session is reviewed (C-28); the re-check belongs to identity verification (DL decision under C-25).

1. **OQ-13:** hide the reason from REVIEWER, so only RECRUITER and SUPER_ADMIN see it (proposed)?
2. **OQ-14, widened:** what about a candidate who cannot use the webcam **or the microphone**? The waiver still needs room scan and the WEBCAM and AUDIO streams. Is a separate accommodation needed (a separate ADR)?
3. **OQ-15:** with REFUSED_BIOMETRIC_PROCESSING, FACE and GAZE are off. Should the narrow override before consent (proposed) be allowed, or should they always be off with no override (decisions.md's suggestion)?
4. **Lock:** once an identity attempt exists, the waiver is refused and the candidate takes attempt 2 and then MANUAL_REVIEW. Given C-02's "case by case", is that enough?
5. **Report wording:** "Identity check waived", without "accommodation", outside the recruiter view (proposed)?
6. **Consent variant (section 7):** a waived-candidate consent version, or a note on the consent record?
