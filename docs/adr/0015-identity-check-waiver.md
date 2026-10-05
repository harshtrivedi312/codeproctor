# ADR 0015: Waived identity check ("no identity check")

| Field | Value |
| --- | --- |
| Status | **Proposed** 2026-10-05; revised after review rounds 1 to 4 and owner decision C-34. The owner accepts or amends. "(owner decision C-xx)" marks what docs/compliance/decisions.md (PR #44) decides. "(architect detail)" marks what this ADR adds, which the owner must confirm. Section 9 lists the owner questions. |
| Author | architecture hub |
| Decides | How C-02 ("no face match"), C-19 and C-25 are built: the two accommodation settings, schema, shared contract, API, locking, audit, state machine, scoring and reporting |
| Serves | FR-305, FR-403, FR-606, FR-105, FR-805, FR-901, FR-1001, FR-1003; BR-12; NFR-05 |
| Builds on | ADR 0002 §2 and §6, ADR 0004 §1, §2 and §5 (and §9, PR #48), ADR 0005 (weights), ADR 0006 (org scope; §8, Proposed, PR #41: §8.1, §8.2, §8.5), ADR 0008 (freeze), ADR 0010 (shared contracts), ADR 0013 5.6, 5.7, CS-4.4 and `verify-session` (PR #39) |
| Amends (on acceptance) | ADR 0002 §2 and §6; ADR 0006 §8.1 (staff rule (i) references 12 → 13); ADR 0004 §2 (threshold metrics) and §5 (R-4, R-5, R-6); ADR 0008 (new §11); ADR 0010 (section 5 request); ADR 0013 5.6 (refusal codes) and CS-4.4; database.md; fsd.md FR-305, FR-403, FR-606, §3, §4 |

## 1. Context

- Face matching is required for every candidate. If a candidate refuses, or cannot use the webcam, microphone or ID check, the recruiter handles it case by case through the per-invitation accommodation settings, "for example, disabled detectors or no face match". Recruiter actions on accommodations are audited (owner decision C-02).
- When face matching is waived, the recruiter must record a reason, and reviewers see "identity check waived". The recruiter is advised to check the candidate's ID on a video call before any hiring decision, and records whether that was done. All of it is audited (owner decision C-19). C-19 also names the shape of the change, quoted word for word:
  > The invitation's accommodation carries the waiver reason. The identity check records a waived state. A "video ID check done: yes/no" field is recorded by the recruiter. All three write audit rows.
- There are two separate accommodation settings with distinct meanings: "no identity check" (the verification step is waived, and C-19 applies) and "face detectors off" (the in-browser and server face detectors are off during the test) (owner decision C-25).
- Biometrics rest on explicit consent (owner decisions C-02, C-29). A person reviews every session, and GRADED always goes to UNDER_REVIEW (owner decision C-28).
- **The re-check is server face processing.** The periodic identity re-check compares a webcam frame with the selfie on the server every 2 minutes. The server identity re-check is refused when **either** "no identity check" **or** "face detectors off" is set; this follows C-25's wording that "face detectors off" turns off the in-browser and server face processing, including the re-check (owner decision C-34, answering OQ-16 and ADR 0013 Q20). A candidate with FACE off, for example because of a facial difference, is never face-matched during the test and collects no FACE_MISMATCH.

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
| **Face detectors off** | `accommodations.disabledDetectors` contains `FACE` | In-browser NO_FACE and MULTIPLE_FACES, and the server identity re-check, which is server face processing (owner decision C-34) | ID image, selfie, liveness and the initial face match; GAZE unless it is also off |
| **No identity check** | `accommodations.identityCheckWaiver` present | ID image, selfie, liveness, the initial face match and the identity re-check (no FACE_MISMATCH) | Room scan, recordings (WEBCAM and AUDIO), and every detector not disabled |

How the two settings interact (refusal codes are architect detail):

| FACE off | Waiver | ID and selfie step | Initial match | Browser face detection | Re-check (`IDENTITY_RECHECK` presign and `/identity/recheck`) |
| --- | --- | --- | --- | --- | --- |
| no | no | yes | yes | yes | runs |
| yes | no | yes | yes | no | 409 `DETECTOR_DISABLED` (owner decision C-34) |
| no | yes | no: `ID_IMAGE` and `SELFIE` presigns and `POST /candidate/session/identity` get 409 `IDENTITY_CHECK_WAIVED` | no | yes | 409 `IDENTITY_CHECK_WAIVED` |
| yes | yes | no | no | no | 409 `IDENTITY_CHECK_WAIVED` |

- ADR 0013 5.6 refuses the re-check with `DETECTOR_DISABLED` when FACE is off, and with `IDENTITY_CHECK_WAIVED` when the identity check is waived (C-34).
- In the SDK, the re-check runs only when the face task is loaded and the app passes `recheckIdentity`. That matches C-34; the coupling stays.

**Refusing biometric processing switches off every face-based detector (architect detail; owner question OQ-15).** When `reasonCode` is `REFUSED_BIOMETRIC_PROCESSING`, the server adds `FACE` and `GAZE` to `disabledDetectors` as it sets the waiver. GAZE uses face landmarks, which count as face geometry: a "scan of face geometry" is a biometric identifier under BIPA 740 ILCS 14/10 (flag for owner/Legal advice, not verified by the architect; the DPIA records it).
- **Re-enabling is narrow.** While the reason is `REFUSED_BIOMETRIC_PROCESSING`, `FACE` or `GAZE` may be removed from `disabledDetectors` only while the session is INVITED, before the candidate has passed the OTP (in OPENED the candidate may already be reading the consent document). The request must also carry the explicit body flag `confirmFaceDetectorsOn: true`, and it writes the distinct audit action `ACCOMMODATION_LOCKED_DETECTORS_REENABLED`. Otherwise the server returns 409 `ACCOMMODATION_LOCKED`.
- If either detector is on, the candidate text names exactly what still runs (section 7).
- decisions.md OQ-15 suggests "always off, no override". The override above is the open owner choice; the default is the more private option.
- **Removing the waiver** under REFUSED_BIOMETRIC_PROCESSING is allowed only in INVITED, with `confirmBiometricWaiverRemoval: true` (section 6). FACE and GAZE stay disabled: the recruiter removes them explicitly, under the rule above, with an audit row (architect detail).

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
| Existing CHECK `identity_checks_check` | `(status = 'REVIEWED') = (...)` already allows WAIVED, because a WAIVED row is not REVIEWED and has a NULL `manual_decision` | no change |
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

**Org-scope relation map (ADR 0006 §8.1).** `identity_checks.video_check_by` is a staff rule (i) reference. db-engineer adds it to `FK_CLASSES` and `RULE_I_REFERENCES` in `org-scope-relations.ts` (RULE_I 25 → 26, total 58 → 59), and ADR 0006 §8.1's list of staff references grows from 12 to 13.

**ADR 0008 amendment needed.** ADR 0008 §10 requires "a new ADR and a forward-only migration". Add §11, "Post-freeze deltas", with one row per change above. Counts: enums stay at 20 (one gains a value); columns +3; CHECK constraints 12 → 14; FKs 58 → 59, the new one with no ON DELETE clause; no new tables or indexes.

## 5. Shared contract (ADR 0010 amendment request)

| Name | Kind | Change |
| --- | --- | --- |
| `ACCOMMODATION_DETECTORS`, `AccommodationDetector` | const, type | New: the `PROCTOR_DETECTORS` subset an accommodation may disable |
| `IDENTITY_WAIVER_REASONS`, `identityWaiverReasonSchema`, `IdentityWaiverReason` | const, zod, type | New: the three `reasonCode` values |
| `identityCheckWaiverSchema`, `IdentityCheckWaiver` | zod, type | New, **write schema**: `{ reasonCode, reasonNote? }`, with `reasonNote` allowed and required only for `OTHER` |
| `storedIdentityCheckWaiverSchema` | zod | New, **lenient read schema** for stored rows: `{ reasonCode, reasonNote?, reasonNoteRemoved?: true }`. After R-4 removes the note, `OTHER` comes with `reasonNoteRemoved: true` and no note. GET, deep-equal and PATCH validation of the stored value use this schema |
| `accommodationsSchema`, `Accommodations` | zod, type | New, stored shape: `extraTimePct`, `disabledDetectors`, `allowedAssistiveTools`, `notes` (backend.md Step 6), the optional `identityCheckWaiver` (lenient), and the **server-only** `identityCheckWaived?: true`, which is set at erasure and R-10 |
| `accommodationsPatchSchema` | zod | New, the PATCH body: `{ accommodations, confirmFaceDetectorsOn?: true, confirmBiometricWaiverRemoval?: true }`. Inside `accommodations`, `identityCheckWaiver` is optional (omitted = unchanged) or `null` (remove), and the server-only `identityCheckWaived` is rejected |
| `candidateAccommodationsSchema`, `CandidateAccommodations` | zod, type | New: the candidate projection `{ extraTimePct, disabledDetectors, allowedAssistiveTools, identityCheckWaived }` (ADR 0013 CS-4.4) |
| `invitationAccommodationsResponseSchema` | zod | New: the audited GET response, `{ accommodations, identityCheck: { status, videoCheck: "DONE" \| "NOT_DONE" \| "NOT_RECORDED", videoCheckAt } \| null }` |
| `reviewIdentityProjectionSchema` | zod | New: what REVIEWER gets in the review bundle, `{ status, attempt, videoCheck }`, with no reason |
| `IDENTITY_CHECK_STATUSES`, `identityCheckStatusSchema`, `IdentityCheckStatus` | const, zod, type | New: a mirror of the DB enum, with `WAIVED` |
| `identityVideoCheckRequestSchema` | zod | New: `{ done: boolean }` |
| `webhookIdentityCheckSchema`, `WebhookIdentityCheck` | zod, type | New: `{ status, videoCheck }` for webhooks and CSV (BE-14) |
| `PERMISSIONS`, `RECRUITER_PERMISSIONS` | const | Add `invitation_accommodations:read`, `invitation_accommodations:update` and `identity_video_check:record`. SUPER_ADMIN gets them through `STAFF_PERMISSIONS`; REVIEWER and AUTHOR get none |
| Problem codes | const | `IDENTITY_CHECK_WAIVED`, `ACCOMMODATION_LOCKED`, `IDENTITY_NOT_WAIVED` (and 412 `PRECONDITION_FAILED`, 428 `PRECONDITION_REQUIRED`), wherever ADR 0011 and 0012 keep problem codes |

## 6. API, locking, access and audit

Paths are proposals; the final shape goes in api-contract.md (ADR 0012). Everything in this section is an architect detail unless it is marked otherwise.

| Method and path | Who | Rule |
| --- | --- | --- |
| `POST /tests/:id/invitations` | `invitation:create`, **plus `invitation_accommodations:update` when the body carries `accommodations`** | A single invite may carry `identityCheckWaiver`. The writes and audit rows are listed under "Write shape" below. After commit, the route enqueues `verify-session` with ADR 0013's deduplicated job id. Bulk CSV rejects a waiver as a row error |
| `GET /invitations/:id/accommodations` | `invitation_accommodations:read` (RECRUITER, SUPER_ADMIN) | Returns `invitationAccommodationsResponseSchema`. This is the **only** path that returns the reason. It writes `INVITATION_ACCOMMODATIONS_READ` (FR-105) and **fails closed**: if the audit insert fails, the response is 500 with no body. It returns an `ETag`. Response headers: `Cache-Control: no-store, private` |
| `PATCH /invitations/:id/accommodations` | `invitation_accommodations:update` | Body `accommodationsPatchSchema`. **Requires `If-Match`**, otherwise 428; a mismatch returns 412. `Cache-Control: no-store, private`. The rules are listed below |
| `PUT /sessions/:id/identity/video-check` | `identity_video_check:record` | Body `{ done }`. Allowed in any session state while a WAIVED row exists, and the value may be changed later. After loading the session in scope, it writes with `updateMany({ where: { sessionId, status: 'WAIVED' } })`; if 0 rows change (no row, or a racing removal), it returns 409 `IDENTITY_NOT_WAIVED`, never a silent 200. After erasure or R-10: 404. `video_check_by` comes only from the authenticated user |
| Candidate identity routes and presigns | CANDIDATE | 409 `IDENTITY_CHECK_WAIVED` (section 3) |

RECRUITER may waive (owner decision C-02). SUPER_ADMIN may as well (architect detail).

**PATCH semantics (blocker fix).**
- The order of checks is fixed: permission, then the org-scoped load (404 for another org's invitation), then `If-Match`.
- **The `identityCheckWaiver` key is never removed by omission.** Omitting the key means "unchanged". Removal needs an explicit `identityCheckWaiver: null`. Every other key uses replace semantics.
- **Removal under REFUSED_BIOMETRIC_PROCESSING** also needs `confirmBiometricWaiverRemoval: true`; without it the request gets 409 `ACCOMMODATION_LOCKED`. Removing the waiver turns the ID image, selfie, face match and re-check back on, so it is the most biometric-invasive change and the most guarded.
- The server-only key `identityCheckWaived` (section 7) is rejected if a client sends it. PATCH returns 409 `ACCOMMODATION_LOCKED` once the session is erased or past R-10.
- **A no-op PATCH** (deep-equal result) still writes `INVITATION_ACCOMMODATIONS_UPDATED` with `changedKeys: []`. A guessed body with a matching ETag therefore always leaves an audit row. Resending a stored waiver that is deep-equal to the current value (compared under the lenient stored schema) is such a no-op, not a "change" that gets 409.
- **Which reason governs (S8).** The locked-detector and removal-confirm rules are evaluated against the **stored** `reasonCode`, read under the lock. A PATCH that both removes the waiver and re-enables FACE or GAZE needs both flags and writes both audit actions. Once the waiver is gone, changes to FACE and GAZE are ordinary accommodation changes. That is a deliberate choice: the protection is tied to the stored refusal.
- **Feature flag, enforced on the server (S2).** While the flag `accommodations.biometricRefusalReason` is off, the server rejects `reasonCode: REFUSED_BIOMETRIC_PROCESSING` on **both** `POST /tests/:id/invitations` and the PATCH, with 422 `REASON_NOT_ENABLED`. The flag is global (system config), not per org. A UI-only flag does not satisfy the hard gate. Stored rows stay readable, and removal stays allowed, after the flag is turned off.

**Windows.**

| Change | Allowed in | Otherwise |
| --- | --- | --- |
| Set the waiver | INVITED, OPENED or CONSENTED, while no identity attempt exists | 409 `ACCOMMODATION_LOCKED` |
| Remove the waiver (`null`, plus the confirm flag under REFUSED_BIOMETRIC_PROCESSING) | **INVITED only** | 409 `ACCOMMODATION_LOCKED` |
| Re-enable FACE or GAZE under REFUSED_BIOMETRIC_PROCESSING (`confirmFaceDetectorsOn: true`) | **INVITED only** | 409 `ACCOMMODATION_LOCKED` |
| Change a set waiver | Never. Remove it and set it again, both within the windows | 409 `ACCOMMODATION_LOCKED` |
| **Redact the reason note** (`POST /invitations/:id/accommodations/redact-note`) | Any state before erasure | 409 `ACCOMMODATION_LOCKED` after erasure or R-10 |

- OPENED is excluded because a candidate in OPENED has passed the OTP and may already be reading the consent document (fsd.md §3; consent is signed from OPENED, ADR 0013 CS-4.4a). That reason only matters under REFUSED_BIOMETRIC_PROCESSING; the owner may allow removal in OPENED for the other reasons (question 4).
- **Recovering from a mistaken waiver after INVITED.** Revoke the invitation and send a new one; both steps are audited. This is the documented path.
- **Redacting the reason note (B2).** Health data typed into `reasonNote` can be removed at any time before erasure (GDPR Art. 5(1)(c) and Art. 16).
  - The operation sets `reasonNoteRemoved: true` and drops the note, which is the same marker R-4 uses.
  - It leaves `reasonCode`, the WAIVED row and the gate untouched, so there is no race.
  - It uses the same lock, `If-Match` and permission (`invitation_accommodations:update`) as the PATCH.
  - It writes `IDENTITY_CHECK_WAIVER_NOTE_REDACTED`, with no text.
- **The candidate client re-reads the projection (S4).** Removal is INVITED-only, so a stale copy can no longer skip the identity step. The live risk is the reverse: a waiver set in CONSENTED after the client last read the projection. The client would then show the identity step, and its uploads would get 409. So:
  - the client fetches `AccommodationsService.projection()` again once the session is CONSENTED;
  - **a 409 `IDENTITY_CHECK_WAIVED` from any identity presign or route makes the client re-read the projection and show the waived text.**
- **Under REFUSED_BIOMETRIC_PROCESSING (N3),** an ID image or selfie that was uploaded in a race is deleted by the handler that answers 409. It does not wait for the ingest-close sweep.
- Removing the waiver also deletes a video check recorded on the row before the test. The audit rows remain. The recruiter UI says so.

**Lock mechanism (dependency: ADR 0006 §8, Proposed, PR #41).**
- Scope: STAFF (`runAsUser`, entered by the interceptor). The whole PATCH runs in one **interactive transaction** at **READ COMMITTED**. REPEATABLE READ or SERIALIZABLE would turn the transitions' compare-and-set into serialization errors.
- **Spike first (architect detail, not verified).** db-engineer confirms that the org-scope extension's raw-SQL hatch check and the AsyncLocalStorage scope both apply to `tx.$queryRaw` on the interactive-transaction client.
- The first statement on the transaction client is `SessionStateService.lockForAccommodation(tx, sessionId)`.
- **Chosen: raw SQL under ADR 0006 §8.5's hatch.**
  - `runRawSql('accommodation-lock', ...)` wraps only this single statement, so the hatch does not carry into nested scopes.
  - The statement is a tagged `$queryRaw` (never `$queryRawUnsafe`): `` SELECT status FROM sessions WHERE id = ${sessionId} AND org_id = ${orgId} FOR NO KEY UPDATE ``. The SQL filters `org_id` itself.
  - **`FOR NO KEY UPDATE`, not `FOR UPDATE`.** Plain `FOR UPDATE` conflicts with the `FOR KEY SHARE` lock that every child-table FK insert takes (`media_chunks`, `proctor_events`, `identity_checks`), so a mid-test PATCH such as extra time would stall all ingest. `FOR NO KEY UPDATE` still serialises against the transitions' `UPDATE`s, which take the same lock mode.
  - The call site is listed in FU-DB-67.
  - The row lock is held until the writes commit.
- **Alternative considered:** a no-op `tx.session.updateMany({ where: { id, orgId }, data: { ... } })` also takes the row lock, with no raw SQL. It is not chosen: with empty `data`, Prisma may not issue an UPDATE (not verified), and writing a real column just to lock is misleading. db-engineer may switch to it if a spike shows Prisma emits the UPDATE.
- The state rules are checked on the locked status. Each `SessionStateService.transition()` is a compare-and-set `UPDATE ... WHERE status = <expected>`, which waits on the row lock and re-evaluates after the PATCH commits.
- **Lock order: `sessions` first, everywhere.** The PATCH locks `sessions` and then updates `invitations`. Every other path that writes both rows must do the same. In particular, start-session (VERIFIED → IN_PROGRESS, which sets `invitations.used_at`) and link resolution update the session row before the invitation. Deadlock (40P01) and serialisation failure (40001) are retried once; after that they map to 409 `ACCOMMODATION_LOCKED`, never 500.

**Write shape (ADR 0006 §8.2: no nested writes, rule (i)).** Every write is a separate top-level scoped call on the transaction client.
- **Invite:**
  1. `invitations.create`;
  2. `sessions.create` with `invitationId` as a scalar (the composite key is written as scalars only);
  3. `identityChecks.create({ data: { sessionId, attempt: 1, status: 'WAIVED' } })` with a scalar `sessionId`;
  4. `auditLogs.create` for each row: `INVITATION_ACCOMMODATIONS_UPDATED` and `IDENTITY_CHECK_WAIVED`.

  The FACE and GAZE switch-off for REFUSED_BIOMETRIC_PROCESSING is part of the same `accommodations` value written in step 1.
- **PATCH:**
  1. the lock statement (which loads the session in scope);
  2. `invitations.update` of the jsonb;
  3. one of `identityChecks.create` or `identityChecks.deleteMany({ where: { sessionId, status: 'WAIVED' } })`. Filtering on `status: 'WAIVED'` means removal can never delete a real attempt;
  4. `auditLogs.create`.
- `identity_checks` is a path model with no `org_id`. The session must therefore be loaded in scope (the locked row) before any `identity_checks` create or delete.
- **Audit atomicity.** Every audit row is written in the same transaction as its change.
- **Unique violations on `(session_id, attempt)`:**
  - the PATCH loses the race: 409 `ACCOMMODATION_LOCKED`, and the whole transaction, audit rows included, rolls back;
  - the candidate upload loses: 409 `IDENTITY_CHECK_WAIVED`, never a 500.
- **Trigger (S1).** A waiver set in CONSENTED has no identity route to enqueue `verify-session`, so after commit both the PATCH and the invite path enqueue it.
  - A deduplicated job id would not work. A room-scan job can read the state just before the PATCH commits; the PATCH's enqueue then lands inside the dedup TTL and is dropped, the first job refuses silently, and the session is stuck.
  - The accommodations path therefore enqueues with **debounce or replace mode**, aligned with ADR 0013 round 9, which moves `verify-session` to debounce mode. If that mode is unavailable, it uses a fresh job id that bypasses deduplication.
  - A failed enqueue (Redis down) raises an alert. The daily job also re-enqueues `verify-session` for any session that has sat in CONSENTED with a WAIVED row for more than 10 minutes.
- **Only the accommodations path writes WAIVED.** Test: no SERVICE-scope writer (the match job, the outcome handlers, `verify-session`) can set `status = 'WAIVED'`.

**Gate rule.** CONSENTED → VERIFIED refuses **silently** when no identity row exists. That is the ordinary state before the identity step, and `verify-session` is also enqueued by the system-check and room-scan routes. It refuses **and alerts** only on an inconsistency:
- the waiver key is present but no WAIVED row exists;
- a WAIVED row exists beside another attempt.

**Orphans.** An object uploaded through a presign issued just before the waiver is deleted by ADR 0013's ingest-close sweep, which removes identity images not referenced by `identity_checks`. The R-4 deletion is the final backstop.

**Why the lock exists.** A waiver must not wipe out a failed or low-confidence match. Once an attempt exists, the existing path applies: attempt 2, then MANUAL_REVIEW, and the candidate is never blocked (ADR 0004 §1). This is owner question 4, because C-02 says "case by case".

**ETag (not an oracle).**
- The ETag is `HMAC-SHA256(k, invitationId || canonical jsonb)`, truncated, base64url-encoded, and sent as a **strong, quoted** ETag (`"..."`). `k` is derived with HKDF from a vault secret under the dedicated label `codeproctor/accommodations-etag/v1`, and is shared with no other HMAC use. Rotating the key makes outstanding ETags fail with 412, so the client re-reads. Without the key, a caller cannot check a guessed body.
- The no-op audit row above covers the remaining probe, where a PATCH sends a guessed body together with a valid ETag.
- `ETag` and `If-Match` values are never logged.

**Candidate scope (ADR 0013 CS-4.4).**
- `invitations.accommodations` is not in the CANDIDATE read allowlist.
- The candidate gets only `AccommodationsService.projection()`. Its `identityCheckWaived` is **derived from the WAIVED row**, which is authoritative, not from the jsonb key.
- Test: no candidate-scope read returns `reasonCode`, `reasonNote` or `notes`.

**Staff DTOs.**
- Every staff response except the audited GET excludes the reason and `notes`, through an allowlist DTO, and a test checks it. This covers invitation lists, session detail, the recruiter CSV and the review bundle.
- REVIEWER gets `reviewIdentityProjectionSchema`. AUTHOR gets nothing (OQ-13).

**Logging.**
- The request and body loggers redact `accommodations.notes`, `accommodations.identityCheckWaiver.reasonNote` and `accommodations.identityCheckWaiver.reasonCode` (pino `redact` paths), with a test. These values are health-adjacent (CLAUDE.md logging rule).
- `ETag` and `If-Match` are never logged.
- **Validation errors never echo values (S7).** For the accommodations DTOs, zod and class-validator errors report the path and a code, never the received value (an enum mismatch or a too-long note would otherwise echo it into problem+json and logs).
- Redact paths cover `req.body` for **both** `POST /tests/:id/invitations` and the PATCH, plus any response-body logging of the GET.
- Test: a 400 for a bad `reasonNote` contains no part of the note, in the response or the logs.

**Rate limits.** Per staff user: PATCH accommodations 30 a minute, PUT video-check 30 a minute, GET accommodations 120 a minute (NFR-04).

**Audit rows.** Every audit row is written in the same transaction as its change. Metadata holds IDs and action names only (ADR 0001 C-3). The action names are neutral.

**Reason inference (S6).** `ACCOMMODATION_LOCKED_DETECTORS_REENABLED`, and a removal that needed `confirmBiometricWaiverRemoval`, occur only under REFUSED_BIOMETRIC_PROCESSING, so they reveal the reason class. Audit rows for invitation accommodations (every action in this table except the video-check rows) are therefore readable only by holders of `invitation_accommodations:read`. The confirm flag is not recorded in metadata.

| Action | Entity | When | Marker |
| --- | --- | --- | --- |
| `INVITATION_ACCOMMODATIONS_UPDATED` | invitation | Any PATCH, a no-op included (`changedKeys` lists key names) | owner decision C-02; name: architect detail |
| `ACCOMMODATION_LOCKED_DETECTORS_REENABLED` | invitation | FACE or GAZE switched back on under the locked-detector rule (INVITED only) | architect detail |
| `IDENTITY_CHECK_WAIVED` | identity_check | Waiver set and WAIVED row written | owner decision C-19 |
| `IDENTITY_CHECK_WAIVER_REMOVED` | invitation | Waiver removed (INVITED only); metadata holds the deleted row's `identityCheckId` | architect detail |
| `IDENTITY_CHECK_WAIVER_NOTE_REDACTED` | invitation | Reason note redacted; no text | architect detail |
| `IDENTITY_VIDEO_CHECK_DONE` / `IDENTITY_VIDEO_CHECK_NOT_DONE` | identity_check | Video check recorded or changed | owner decision C-19 |
| `INVITATION_ACCOMMODATIONS_READ` | invitation | The audited GET (fails closed) | FR-105 |

## 7. State machine, scoring, reporting, retention

| Area | Rule | Marker |
| --- | --- | --- |
| CONSENTED → VERIFIED (ADR 0002 §2) | The identity condition becomes "PASSED, MANUAL_REVIEW or WAIVED", under the gate rule in section 6. VERIFIED keeps its meaning of "checks done" (ADR 0002 §6) | architect detail |
| GRADED → UNDER_REVIEW | Always, as for every session (owner decision C-28), with the "Identity check waived" badge | owner decision C-28 |
| Verdict gate (ADR 0002 §6) | Does not apply to WAIVED; a reviewer cannot change WAIVED into REVIEWED. The video check is advice, not a gate | "advised": owner decision C-19; gate: architect detail |
| Risk (FR-804, ADR 0005) | No re-check for a waived session, so no FACE_MISMATCH and no IDENTITY_MANUAL_REVIEW. The waiver adds weight 0, and no event type is added. With FACE off but no waiver, the re-check is also refused, so there is no FACE_MISMATCH | architect detail; re-check: owner decision C-34 |
| Threshold review (ADR 0004 §2) | WAIVED rows are left out of false-match and false-non-match rates and counted separately | architect detail |
| Report PDF, webhooks, CSV (FR-1001, FR-1003) | "Identity check waived" and the video-check status, never "accommodation". **The reason never appears in the PDF, webhooks or CSV, whoever receives them**; it is available only through the audited GET. Results go out only after the verdict (C-28) | owner decision C-28; wording: architect detail; owner question 5 |
| Erasure and R-10 (ADR 0004 §9, PR #48) | Delete the `identity_checks` row, including the video check. In `invitations.accommodations`, `identityCheckWaiver` is replaced by `identityCheckWaived: true` (no reason), or the whole object is cleared if OQ-12 is answered yes. At R-4 (`retention_days`), `reasonNote` is removed and `reasonNoteRemoved: true` is set. Replace semantics never drop `identityCheckWaived` | architect detail |
| Consent dependency (hard gate) | See below | architect detail |

**UI text (architect detail):**
- **Reviewer (FE-11):** badge "Identity check waived", with the subtext "No ID image, selfie or face match." Video line: "Video ID check: Done / Not done / Not recorded yet".
- **Recruiter (FE-05):** the control is labelled "No identity check", needs a reason, and sits apart from "Face detectors off". This advice is shown when the waiver is set, and on the session until the check is recorded: "Before any hiring decision, check the candidate's ID on a video call, then record whether you did." For REFUSED_BIOMETRIC_PROCESSING the UI shows FACE and GAZE as off. Turning either back on, or removing the waiver, needs a confirmation, and is only possible in INVITED. Removing the waiver also deletes any video check recorded before the test; the audit rows remain.
- **Candidate (FE-09):** the identity step is replaced by "No identity check is needed for this test. This was arranged with your recruiter." If FACE or GAZE is still on, the text continues: "Your webcam is still recorded, and the browser checks that a face is present [and where you are looking]. No face matching or identity check runs."

**FR-305 wording proposal:**
> **FR-305** Per-candidate accommodations: extra time percentage, disabled detectors ("face detectors off" among them), allowed assistive tools, and "no identity check". Every change to accommodations writes an audit row. With "no identity check", the recruiter must record a reason; the candidate uploads no ID image or selfie, no face match or identity re-check runs, and reviewers see "Identity check waived". The recruiter is advised to check the candidate's ID on a video call before any hiring decision, and records whether that was done (C-02, C-19, C-25). "Face detectors off" stops the in-browser and server face detectors during the test, including the periodic identity re-check (C-34); the initial identity check still runs.

Also on acceptance:
- FR-403 adds "unless waived by accommodation (FR-305)".
- FR-606: the re-check does not run when the identity check is waived or the FACE detector is off (C-34).
- fsd.md §3 VERIFIED row becomes "identity passed, sent to manual review, or waived".
- fsd.md §4 adds the staff routes.

**Dependency before the pilot: a hard gate (Delivery Lead and owner).** A REFUSED_BIOMETRIC_PROCESSING candidate still signs the same consent version, which includes explicit biometric consent. The signed record then misstates what the candidate consented to. One of these is needed: a consent variant for waived candidates, or the consent record and PDF noting that biometric consent was not given. Both depend on the consent document (C-09) and the age confirmation (C-30), which stays unchanged. **Gate:** `REFUSED_BIOMETRIC_PROCESSING` cannot be selected until one of them ships. It sits behind the feature flag `accommodations.biometricRefusalReason` (off by default), which is also a build-plan exit criterion. The owner chooses between the variant and the note (question 6).

## 8. Consequences and affected agents

| Agent | Task | What to do after acceptance |
| --- | --- | --- |
| db-engineer | new DB step (the Delivery Lead schedules it) | The spike on `tx.$queryRaw` with the raw-SQL hatch and AsyncLocalStorage; section 4 migrations (`--create-only`, split by hand, CHECKs by hand, stop on any reset prompt); `schema.prisma` (enum, fields, named relations, the `User` back-relation, header counts); `org-scope-relations.ts` (`video_check_by` as rule (i): RULE_I 25 → 26, total 58 → 59); CHECK tests |
| backend-engineer | BE-06 | Schemas (write and lenient read); server-side feature-flag check (422) on invite and PATCH; the redact-note operation; stored-reason evaluation for combined PATCHes; lock order sessions first and 40P01/40001 handling; `FOR NO KEY UPDATE`; debounce-mode enqueue with an alert on failure; non-echoing validation errors; audit-read restriction; invite permission rule and write shape (top-level scoped calls, scalar ids, no nested writes); GET with HMAC ETag, `no-store` and a fail-closed audit; PATCH with check order, If-Match (428 and 412), omitted-key and `null` semantics, confirm flags, INVITED-only removal and re-enable, the `runRawSql` lock in a READ COMMITTED interactive transaction, `deleteMany` filtered on WAIVED, no-op audit, unique-violation mapping, and enqueueing `verify-session` after commit; staff allowlist DTOs; pino redact paths; rate limits; the feature flag |
| backend-engineer | BE-07 | `lockForAccommodation` (FU-DB-67 call site; spike on `tx.$queryRaw` and the hatch); start-session and link resolution lock `sessions` before `invitations`; gate rule (silent refusal, alert only on an inconsistency); `verify-session` re-checks under the transition compare-and-set; `AccommodationsService.projection()` deriving `identityCheckWaived` from the WAIVED row, and its test; a test that no SERVICE writer sets WAIVED |
| integrity-engineer | BE-08 | Identity routes return 409 `IDENTITY_CHECK_WAIVED`, and no match job runs. Test: an upload is refused while a WAIVED row exists, so no attempt-2 row can sit next to a WAIVED attempt-1 |
| backend-engineer | BE-09 | Refuse `ID_IMAGE`, `SELFIE` and `IDENTITY_RECHECK` presigns when waived (409 `IDENTITY_CHECK_WAIVED`), and `IDENTITY_RECHECK` when FACE is off (409 `DETECTOR_DISABLED`; C-34, ADR 0013 5.6). Delete a raced upload on the 409 under REFUSED_BIOMETRIC_PROCESSING |
| integrity-engineer | BE-12 | No risk change; tests that a waived session and a FACE-off session (C-34) both get no re-check and no FACE_MISMATCH; threshold metrics leave WAIVED out |
| backend-engineer | BE-13, BE-14 | Review projection by role; video-check route; no verdict gate for WAIVED; report, webhook and CSV wording with no reason |
| frontend-engineer | FE-05, FE-09, FE-11 | Two controls, the reason, advice, the FACE and GAZE display and confirmations, the video-check control, ETag and If-Match handling, and the waiver key sent only when it changes; candidate text from a projection fetched fresh after CONSENTED, and again on a 409 `IDENTITY_CHECK_WAIVED`; the redact-note action; badge |
| proctor-sdk-engineer | follow-up | C-34: keep the current coupling. The re-check runs only when the face task is loaded and `recheckIdentity` is passed; the app passes none when the check is waived or FACE is off. Tests for both. |
| QA | new TCs (QA assigns IDs) | Reason rules; waived session reaches VERIFIED and UNDER_REVIEW with the badge, and its presigns get 409; FACE off alone still runs the initial check, and the re-check gets 409 `DETECTOR_DISABLED` (C-34); REFUSED_BIOMETRIC_PROCESSING defaults FACE and GAZE off, and re-enabling or removing is refused after INVITED, and removal needs the confirm flag; **PATCH without the key keeps the waiver**; the If-Match probe (a guessed body with an ETag always leaves an audit row, and the ETag is keyed); a waiver set in CONSENTED enqueues `verify-session` and reaches VERIFIED; unique-violation mapping (409, not 500); log redaction of notes and the reason; the lenient read after R-4 note removal; the audited GET fails closed; **the redact-note operation** works in any state before erasure and leaves the gate untouched; **the flag rejects REFUSED_BIOMETRIC_PROCESSING with 422 on both routes**; **a waiver set in CONSENTED after room scan still reaches VERIFIED, even when another `verify-session` job ran just before** (enqueue not swallowed); a client that gets 409 `IDENTITY_CHECK_WAIVED` re-reads the projection; a mid-test PATCH does not block ingest (`FOR NO KEY UPDATE`); no deadlock between the PATCH and start-session; a 400 for a bad note echoes nothing; a video check racing a removal gets 409; a combined PATCH needs both flags; the audit rows that reveal the reason are hidden from REVIEWER; **race: a PATCH removal concurrent with INVITED → OPENED, OPENED → CONSENTED and `verify-session` never yields VERIFIED with no identity row**; the gate refuses silently with no identity row, and alerts on an inconsistency; If-Match 412; invite permission rule; same-transaction audit rows with no reason text; staff DTOs, candidate scope and REVIEWER get no reason; video check 409, 404 across orgs and after erasure; bulk CSV row error; report, webhook and CSV carry no reason; invariant scoped to live sessions |
| hub | on acceptance | database.md; ADR 0006 §8.1 list (12 → 13 staff references); fsd.md FR-305, FR-403, FR-606, §3, §4; ADR 0002 §2 and §6; ADR 0004 §2 and §5 (R-4 `reasonNote`; erasure and R-10 waiver reduction); ADR 0008 §11; ADR 0010 (section 5); ADR 0013 5.6 (refusal codes, round 7) and CS-4.4; api-contract.md |
| Delivery Lead | docs | requirements-trace FR-305; build-plan migration step; the consent dependency (section 7); DPIA on OQ-15 and the GAZE classification |

## 9. Owner questions

Decided since the first draft: two settings (C-25); every session is reviewed (C-28); the re-check is refused when either setting is on (C-34, which answers OQ-16). Process note: on acceptance this ADR also needs the ADR 0008 §11 amendment and a database.md update; neither is in this PR.


1. **OQ-13:** hide the reason from REVIEWER, so only RECRUITER and SUPER_ADMIN see it (proposed)? Even then, a REVIEWER who sees "waived" with FACE and GAZE off can infer the refusal reason.
2. **OQ-14, widened:** what about a candidate who cannot use the webcam **or the microphone**? The waiver still needs room scan and the WEBCAM and AUDIO streams. Is a separate accommodation needed (a separate ADR)?
3. **OQ-15:** with REFUSED_BIOMETRIC_PROCESSING, FACE and GAZE are off. Should the narrow override (INVITED only, proposed) be allowed, or should they always be off with no override (decisions.md's suggestion)? This also covers **removing the waiver** under REFUSED_BIOMETRIC_PROCESSING (proposed: INVITED only, with an explicit confirmation).
4. **Lock and recovery:** once an identity attempt exists, the waiver is refused and the candidate takes attempt 2 and then MANUAL_REVIEW. Given C-02's "case by case", is that enough? A mistaken waiver after INVITED is recovered by revoking and re-inviting (audited). Should removal also be allowed in OPENED for `OTHER` and `CANNOT_COMPLETE_ID_CHECK`? The consent-based exclusion only matters under REFUSED_BIOMETRIC_PROCESSING, and the CONSENTED re-read covers the gate.
5. **Report wording:** "Identity check waived", without "accommodation", outside the recruiter view (proposed)?
6. **Consent variant (section 7):** a waived-candidate consent version, or a note on the consent record?
