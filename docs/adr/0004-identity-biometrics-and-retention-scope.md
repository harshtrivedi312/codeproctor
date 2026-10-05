# ADR 0004: Identity checks, face embeddings and retention scope

| Field | Value |
| --- | --- |
| Status | **Accepted** 2026-10-01 (D-16): every recommendation as proposed (embeddings: option (a), never stored); amended by D-17 (consent PDF retention), D-18 (threshold test set) and D-19 (erasure). See section 8. Applied to database.md; deltas in ADR 0008. **Amendment proposed 2026-10-05, for the owner to accept:** section 9 applies the owner's compliance decisions C-04, C-06, C-17, C-18, C-26, C-27 and C-35 (docs/compliance/decisions.md, PR #44) to section 2, R-3 to R-7 and section 8. Not yet applied to database.md or fsd.md (section 9.9). |
| Author | architect |
| Decides | Q-06, Q-11, Q-12, A-02, A-04, A-09 (retention hold, D-08), A-21 items 2 and 4 |
| Serves | FR-403, FR-404, FR-606, FR-701, FR-704, FR-904; NFR-05; BR-13; TC-033, TC-034, TC-035, TC-070, TC-072, TC-077, TC-094 |
| Builds on | ADR 0001 D-05 (AuraFace with MediaPipe, never an automatic rejection) and the model licence table in ADR 0001 section 12 |

Face embeddings and face-geometry data are biometric identifiers under laws such as Illinois BIPA (brd.md §7). This ADR keeps as little of them as the features need.

## 1. Identity check status and manual review (Q-12, A-21 item 4)

Each attempt is one row. New enums, and the `identity_checks` columns that replace `status text`:

```sql
CREATE TYPE identity_check_status    AS ENUM ('PENDING','PASSED','LOW_CONFIDENCE','MANUAL_REVIEW','REVIEWED');
CREATE TYPE identity_review_reason   AS ENUM ('BELOW_THRESHOLD','NO_FACE','MULTIPLE_FACES','LIVENESS_NOT_CONFIRMED','MATCH_ERROR');
CREATE TYPE identity_manual_decision AS ENUM ('MATCH','NO_MATCH','INCONCLUSIVE');

-- identity_checks: replace status text with these; drop room_scan_key (section 3)
status           identity_check_status NOT NULL DEFAULT 'PENDING',
attempt          smallint NOT NULL DEFAULT 1 CHECK (attempt BETWEEN 1 AND 2),
model_id         text,            -- for example 'auraface-v1:a7933ea5'; scores stay readable after a model swap
threshold        numeric(5,4),    -- threshold in force when this attempt was scored
review_reason    identity_review_reason,
manual_decision  identity_manual_decision,
reviewed_by      uuid REFERENCES users(id),
reviewed_at      timestamptz,
review_note      text,
UNIQUE (session_id, attempt),
CHECK ((status = 'REVIEWED') = (manual_decision IS NOT NULL AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL))
```

Flow (TC-033):
- Attempt 1 PASSED: done.
- Attempt 1 LOW_CONFIDENCE (any `review_reason`): the candidate retries once, with tips such as lighting and framing.
- Attempt 2 LOW_CONFIDENCE: status MANUAL_REVIEW, and the candidate continues (ADR 0002 §6).
- MATCH_ERROR (worker down or timed out): MANUAL_REVIEW at once, with no retry asked of the candidate.
- **The type has no REJECTED or FAILED value, so the schema cannot record an automatic rejection.**
- A REVIEWER (or SUPER_ADMIN) compares the ID image, the selfie and webcam footage in the review workspace and records a decision. NO_MATCH is a human finding that feeds the human verdict.
- Liveness stays client-reported (R-05). A failed liveness prompt can only lead to manual review.

Alternative: keep `status text` and define the values in packages/shared only. That leaves no database guard.

## 2. Face embeddings (Q-06)

Verified on 2026-10-01 from the ONNX graph of AuraFace `glintr100.onnx` (SHA-256 `a7933ea5…`): the input is float32 [N, 3, 112, 112] and the output is float32 [1, 512]. **One embedding is 512 × 4 bytes = 2,048 bytes.**

| Option | DDL | Size | Privacy |
| --- | --- | --- | --- |
| **(a) Never persist (accepted)** | none | 2 KB × concurrent sessions in worker memory (200 sessions = 0.4 MB) | No biometric template at rest, in backups or in the API. A model swap needs no migration. |
| (b) Persist the selfie embedding, encrypted | `face_embeddings` (below) | 2,076 bytes a row (AES-256-GCM: 12-byte nonce + 2,048 + 16-byte tag), stored out of line by TOAST. At most 2 rows a session. 10,000 sessions ≈ 42 MB if never deleted. | Template sits in the database and in 14-day backups. Delete at SUBMITTED, with retention as a backstop. |
| (c) Persist as `real[]` or with the pgvector extension | a vector column | About 2,072 bytes a row | Adds a vector search we do not need (no search across candidates); pgvector would be a new extension. |

For (a):
- The worker computes the ID and selfie embeddings when a match job runs, compares them, and stores only the score, `model_id` and `threshold` on the attempt row.
- It keeps the selfie embedding in memory, keyed by session, for the periodic FACE_MISMATCH re-checks (FR-606). On a cache miss or restart it recomputes it from the stored selfie image (one extra inference).
  - *Proposed amendment (section 9.1):* the cache lifetime is bounded (process memory only, evicted at session end, TTL backstop); the owner confirms that C-18 allows it.
- ID embeddings are never kept.

```sql
CREATE TABLE face_embeddings (            -- only if option (b) is chosen
  identity_check_id uuid PRIMARY KEY REFERENCES identity_checks(id) ON DELETE CASCADE,
  model_id   text NOT NULL,
  dim        smallint NOT NULL CHECK (dim > 0),
  vector_enc bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

Option (a) is accepted. backend.md Step 8's lines "expose the embedding of the selfie" and "Delete embeddings with the session" were amended in Phase B to match.

**Face-matching interface (D-05).** The worker exposes `detect_and_align(image) → faces`, `embed(aligned_face) → vector`, `compare(a, b) → score` and `model_id`.
- MediaPipe finds the face and the landmarks used to align it to the 112×112 crop.
- AuraFace produces the embedding.
- Swapping the model changes `model_id` and needs a new threshold; no data migration.
- The threshold is system configuration, not an org setting.

**Threshold criteria (owner, 2026-10-01).**
- **Pilot entry:** the threshold is tuned on a demographically diverse test set before any real candidate is face-matched.
- **Pilot exit:** before production, review the pilot's false-match and false-non-match rates and how many identity checks went to manual review. Break these down across groups where that can lawfully be done, and adjust the threshold if needed.
- Both are listed in build-plan.md DEP-02. `model_id` and `threshold` on each attempt make the exit review possible.
- **Test set (D-18).** The set comes from internal volunteers, each of whom signs a separate short consent that covers only this purpose.
  - Demographic data is self-reported and optional. It is stored apart from the volunteers' face images, outside the CodeProctor database, and deleted after tuning.
  - **Fallback:** buy a licensed dataset whose licence allows commercial use and biometric processing. Check it against section 12 of ADR 0001 before use.
  - The volunteer consent form and the lawful basis for the per-group breakdown are Legal items and pilot entry blockers.
  - The tuning work is proposed as PA-08 (status.md section 8).

## 3. Room scan in one place (A-21 item 2)

- (a) **Accepted:** the room scan is a `media_chunks` stream `'ROOM_SCAN'`, so it uses the same presign, playback and retention as the other streams. Drop `identity_checks.room_scan_key`. VERIFIED requires at least one uploaded ROOM_SCAN chunk (TC-035).
- (b) Keep `room_scan_key` and drop `'ROOM_SCAN'` from `media_stream`. The 15-second clip then needs its own single-object upload path.

## 4. Recording segments and deletion (A-02, A-04)

**Accepted `media_chunks` delta:**
- `object_key text` becomes nullable.
- Add `deleted_at timestamptz`.
- Add `segment int NOT NULL DEFAULT 0`.

How segments work:
- `seq` stays monotonic per stream across segments, so `UNIQUE (session_id, stream, seq)` still holds.
- A new segment starts whenever a recorder restarts, for example after a reload or a re-started screen share. Its lowest `seq` carries the WebM header.
- Playback (FE-11) and the worker (BE-12) join chunks per (stream, segment) in `seq` order. The SDK uploads each segment's first chunk first (FE-07).

Alternatives:
- Delete the rows instead of nulling the keys. This amends TC-072 and the Data rules, and loses the chunk timeline.
- Restart the recorder for every chunk. Small gaps, more CPU.
- Remux on the server after SUBMITTED (worker with ffmpeg). This can be added later on top of the recommendation.

## 5. Retention scope, clock and hold (Q-11, A-09)

DDL:
- `sessions` add `retention_anchor_at timestamptz`, plus `CREATE INDEX ON sessions (retention_anchor_at) WHERE retention_anchor_at IS NOT NULL`.
- `candidates` add `erased_at timestamptz`.

Rules, testable in DB-06, BE-09 and BE-13:
- **R-1 Anchor.** SessionStateService sets `retention_anchor_at` when a session becomes COMPLETED, EXPIRED or DECLINED (D-17; DECLINED: the decline time).
  - COMPLETED: the latest of `submitted_at`, the verdict time and, for a VIOLATION verdict, verdict time + 7 days (the FR-904 appeal window).
  - APPEALED sets it back to NULL. Resolving the appeal sets it to the appeal's `resolved_at`.
  - EXPIRED: the expiry time.
- **R-2 Hold.** A NULL anchor is never eligible. That covers every session that is not COMPLETED or EXPIRED, every UNDER_REVIEW or APPEALED session, and every session with an OPEN appeal. The job also re-checks those states.
- **R-3 Eligible** when anchor + `organizations.retention_days` ≤ now. TC-072 sets 7 days and advances the clock.
  - *Proposed amendment (section 9.2, C-27, C-35):* face images (ID image, selfie, sealed mismatch frames) do not use the anchor. They are eligible at face clock + LEAST(`retention_days`, 90 days), where the face clock starts at capture or submission, whatever any review hold says.
- **R-4 At retention**, delete the objects first, then null the keys in one transaction (only `media_chunks` also gets `deleted_at`):
  - `media_chunks.object_key` (all streams, including ROOM_SCAN), plus `deleted_at`;
  - `identity_checks.id_image_key` and `selfie_key`;
  - `proctor_events.evidence_key`;
  - `sessions.report_key` (ADR 0007). *Proposed amendment (section 9.4, C-26):* the report moves to the 1-year results clock (R-10).
  - Also delete the `keystroke_batches` rows, and the `face_embeddings` rows if §2 option (b) is chosen.
  - Write one audit row per session, with IDs only (ADR 0001 C-3). *Proposed amendment (section 9.2):* that row **is** the `RETENTION_MEDIA_DONE` completion marker, not an extra row.
- **R-5 Kept** after retention: the session, scores, submissions, event rows without evidence, reviews, appeals, consent records (including the signed consent PDF, D-17) and audit rows.
  - *Proposed amendment (sections 9.3 and 9.4):* nothing here is kept indefinitely any more. Consent records get a 3-year clock (R-9, C-04). Results get a 1-year clock and then only anonymised statistics remain (R-10, C-26). Audit rows (IDs only) are unchanged.
- **R-6 Erasure on request** (TC-094, NFR-05) is a SUPER_ADMIN action; the endpoint is defined in ARC-02. Amended by D-19, a provisional default that Legal must confirm. *Proposed amendment (section 9.5):* confirmed by C-06; the struck bullets below are replaced by C-17.
  - The request sets `candidates.erasure_requested_at`.
  - **Hold.** While any of the candidate's sessions is UNDER_REVIEW or APPEALED, or has an OPEN appeal, erasure waits and the candidate is told (email template `erasure-delayed`). A job runs the erasure as soon as the last review or appeal closes. The hold is the org setting `erasure.holdWhileReviewOrAppealOpen` (default true; false erases at once).
  - **Erasure** applies R-4 at once to every session of the candidate, whatever the retention days~~, and also deletes the signed consent PDFs~~ (C-17: the consent PDFs are kept until R-9). It then deletes the candidate's `media_chunks`, `identity_checks`, `proctor_events` (with their `flag_decisions`), `proctor_event_batches` and `keystroke_batches` rows.
  - **Code and answers are erased too (D-19).** Blank `submissions.source_code` and `results` (set to `''` and `'[]'`), and `session_questions.final_code` and `answer`.
  - **Free text about the candidate.** Null `session_reviews.notes` and `appeals.resolution_note`, and set `appeals.reason` to 'Erased'.
  - ~~**Consent record.** Set `consents.signed_name` to 'Erased' and null `ip`, `user_agent` and `pdf_key`.~~ Replaced by C-17: the consent record is left as it is until R-9 (section 9.5).
  - **Session and candidate.** Clear `sessions.device_info`. Anonymize `candidates` in place: email `erased+<id>@invalid`, full_name 'Erased', external_ref NULL, `erased_at` set.
  - ~~**Only anonymized scores remain:**~~ **Scores remain, pseudonymised until the consent proof is deleted (section 9.5):** total and per-question scores, risk score and band, and verdicts.
  - ~~**Tension for Legal:** NFR-05 says "deletion on request within 30 days". A review or appeal that stays open longer would hold erasure past 30 days. The hold setting lets Legal choose.~~ Settled by C-06 (section 9.5).
- **R-7 Backups** are kept 14 days (A-31). Erasures made after a backup was taken must be re-applied after a restore, so the list of erased candidate IDs is kept outside the database backup (DB-07, ARC-05). *Proposed amendment (section 9.7):* re-applied erasure follows C-17 (keeps the consent proof).
- **R-8** Object keys are never logged (ADR 0001 C-5).

Alternative: no anchor column, with eligibility computed by joins in the RetentionService query. No DDL, but slower, and all the hold logic sits in one query that is harder to test.

## 6. Free-text enum columns (A-21 item 4)

- `proctor_events.source text` becomes enum `event_source AS ENUM ('CLIENT','SERVER')`.
- `sessions.client_kind text` becomes enum `client_kind AS ENUM ('WEB')`. Later values are added with `ALTER TYPE ... ADD VALUE`.
- `identity_checks.status`: see section 1.

Alternative: keep text and define the values in packages/shared only.

## 7. Consequences and affected agents

- **Accepted delta:** 5 enums (3 identity, `event_source`, `client_kind`); changes to `identity_checks`, `media_chunks`, `sessions` (`retention_anchor_at`), `candidates` (`erasure_requested_at`, `erased_at`) and `proctor_events` (`source` type). No new tables.
- **integrity-engineer:** BE-08 implements the flow in §1, the face-matching interface, model pinning and no stored embeddings. PA-08 (if approved) runs the threshold tuning.
- **backend-engineer:** BE-06 adds the `erasure-delayed` template. BE-09 adds segments, `deleted_at` and the report key to retention. BE-13 adds identity decisions and the verdict gate.
- **db-engineer:** DB-06 implements R-1..R-8, the erasure hold and its setting. DB-07 keeps the erasure list outside backups.
- **frontend-engineer:** FE-09 shows "sent for manual review" and records the room scan through the recorder. FE-11 adds the identity panel. FE-03 adds the erase action and the erasure-hold setting.
- **proctor-sdk-engineer:** FE-07 adds the segment counter and first-chunk priority.
- **Doc amendments (applied in Phase B):** database prompt Step 6, backend.md Steps 8 and 9, database.md Data rules, fsd.md FR-704 and NFR-05, test-cases.md TC-094.

## 8. Amendments after acceptance (D-17, D-18, D-19)

- **D-17 consent PDF.** The signed consent PDF lives in object storage under the session (ARC-03 sets the key layout), referenced by `consents.pdf_key`.
  - It is proof of consent, so retention keeps it with the consent record (R-5), and erasure deletes it (R-6).
  - *Detail chosen by architect; owner and Legal to confirm:* the PDF is kept until erasure, not deleted at `retention_days` with the recordings.
  - *Proposed amendment (sections 9.3 and 9.5):* replaced by C-04 and C-17. The PDF and the record are kept 3 years after signing, through an erasure request, and then deleted.
- **D-18 test set and fallback.** See section 2. The tuning data never enters the CodeProctor database or its backups.
- **D-19 erasure.** See R-6.
  - *Detail chosen by architect; owner and Legal to confirm:*
    - the hold setting lives in `organizations.settings.erasure.holdWhileReviewOrAppealOpen` (default true);
    - `candidates.erasure_requested_at` records the pending request;
    - the candidate is told by email (`erasure-delayed`);
    - erasure deletes event, identity and media rows, not only their keys, so only anonymized scores remain.

## 9. Proposed amendment 2026-10-05: retention clocks and erasure (C-04, C-06, C-17, C-18, C-26, C-27, C-35)

**Status: Proposed. The owner accepts or amends.** Source: the owner's compliance decisions in docs/compliance/decisions.md (PR #44).
- "(owner decision C-xx)" marks what that file decides.
- "(architect detail)" marks what this ADR adds, for the owner to confirm.
- "(flag for owner/Legal advice, not verified by the architect)" marks legal points the architect raises but has not verified.

**Acceptance gate.** Accept this amendment only together with an ADR 0013 (PR #39) whose object-deletion rules match 9.6.

Serves FR-401, FR-704, NFR-05, TC-072, TC-094.

### 9.1 Embeddings (C-18)

- Face embeddings are never stored. They are computed in memory for each comparison and then discarded. Periodic re-checks recompute them from the stored selfie (owner decision C-18). Section 2 option (a) stands. Option (b) and the conditional `face_embeddings` clause in R-4 are closed.
- **Per-session cache (architect detail; owner to confirm that C-18 allows it).** Section 2 keeps the selfie embedding in the worker's memory for the re-checks. Its lifetime is bounded:
  - It lives in process memory only. It never goes to Redis, BullMQ job payloads or results, disk, or logs.
  - It is evicted at the first of: SUBMITTED, EXPIRED or DECLINED; ingest close (ADR 0013); or erasure of a live session (ADR 0013 also destroys the HMAC key then).
  - A TTL backstop of `deadline_at` plus the ingest grace means a lost eviction cannot keep it longer.
  - After a restart or a cache miss, the worker recomputes it from the stored selfie.

### 9.2 Media and face images (C-04, C-27)

| Item | Clock | Marker |
| --- | --- | --- |
| Recordings (all streams, ROOM_SCAN included), evidence snapshots of `EVENT` purpose, keystroke data | anchor + `retention_days` (default 90, range 7..730), under R-3 and R-4 | owner decision C-04 |
| **Face images:** ID image, selfie, and identity re-check frames kept on a mismatch (the sealed FACE_MISMATCH evidence) | **face clock + LEAST(`retention_days`, 90 days)**. The face clock starts at capture or submission, **whatever any review hold or the organisation's retention setting says**: not the anchor. `retention_days` may shorten this but never extend it past 90 days | owner decisions C-27, C-35 |
| Report PDF | Not on this clock: it moves to R-10 (9.4) | owner decision C-26 |

**Object-level deletion (architect detail).** No tier deletes the whole prefix any more. Keys follow ADR 0013 5.7, which is aligned with this section (PR #39 head 75de77c).

| Tier | When | Deletes objects | Then, in one transaction |
| --- | --- | --- | --- |
| Face | face clock + LEAST(`retention_days`, 90); no hold | Everything listed under `orgs/{orgId}/sessions/{sessionId}/identity/` and `.../evidence/sealed/` | Null `identity_checks.id_image_key` and `selfie_key`, and `proctor_events.evidence_key` where `type = 'FACE_MISMATCH'`; the `RETENTION_FACE_DONE` marker |
| Main (R-4) | anchor + `retention_days` | Everything listed under the session prefix **except `reports/`** (media, evidence, identity leftovers, `live/` thumbnails). This tier is the final backstop for orphans | As R-4 today, but without `sessions.report_key`; delete `keystroke_batches`; the `RETENTION_MEDIA_DONE` marker (this is R-4's audit row) |
| Results (R-10) | anchor + 1 year | First the face and main tiers, if they have not completed. Then **everything listed under the whole session prefix**, `reports/` included. This one listing per session per lifetime is the backstop for every earlier marker | Null `sessions.report_key`; the 9.4 data steps; the `RETENTION_RESULTS_DONE` marker |

- **The face clock (architect detail on C-35).** The face clock is `COALESCE(sessions.submitted_at, latest capture)`. Latest capture is the newest `identity_checks.created_at`, or the `occurred_at` of the newest FACE_MISMATCH event, for a session that never reached submission (for example EXPIRED after the identity step, or abandoned). Submission comes after every capture, so this is at most the test length past capture. The face tier does **not** wait for R-2: it also runs on sessions that are UNDER_REVIEW or APPEALED. If a review or appeal is still open at 90 days, the reviewer loses the face images; the review panel shows "face images deleted (90-day limit)".
- **Selection is by session, not by key.** Each tier picks the sessions that are eligible on its own clock (the face clock for the face tier, the anchor for the others) and have no completion marker for it. It then **always lists its prefix** with ListObjectsV2, deletes with DeleteObjects, and nulls the columns. This reaches objects that have no DB key: `live/` thumbnails, identity or sealed frames the ingest sweep missed (their key is already NULL), and recordings whose `media_chunks` rows are gone.
- **The completion marker is the per-tier audit row:** action `RETENTION_FACE_DONE`, `RETENTION_MEDIA_DONE` or `RETENTION_RESULTS_DONE`, with the session as the entity.
- **A marker is written only after the deletion is verified.** `audit_logs` is append-only, so a wrong marker can never be withdrawn. All three conditions must hold:
  1. every page has been listed (ListObjectsV2 until `IsTruncated` is false);
  2. every DeleteObjects call returned an empty `Errors` array;
  3. a fresh listing of the tier's prefixes comes back empty.

  If any condition fails, the tier writes no marker and no column changes, raises a warning, and runs again the next day. After 3 failed days in a row it raises an alert. The marker is then written in the same transaction that nulls the columns. A crash before the marker only means the tier runs again; DeleteObjects on keys that are already gone is harmless.
- **Only RetentionService writes markers.** The three actions live in one constant, `RETENTION_MARKER_ACTIONS`. A lint rule and a test fail if any other writer uses them, including the `@Audited` decorator and erasure (9.5). An unrelated audit row can therefore never suppress a deletion.
- **Index (ADR 0008 delta).** The daily "eligible and no marker" check is a `NOT EXISTS` against an append-only table. `audit_logs` has only `(org_id, created_at DESC)`, and `entity_id` is text. Add the partial index `CREATE INDEX ON audit_logs (action, entity_id) WHERE action IN ('RETENTION_FACE_DONE','RETENTION_MEDIA_DONE','RETENTION_RESULTS_DONE')`. It is small, and it keeps the job within NFR-01 and NFR-02 headroom. This is the only DDL in this amendment.
- The marker also stops R-10 from rescanning every session older than a year every day.
- When `retention_days` ≤ 90, the face and main tiers run together. R-10 always runs any tier that has no marker yet first, so it never deletes rows that a later tier still needs to find objects.
- **Owner to confirm (architect detail).** C-27 names the ID image, the selfie and the mismatch frames only. Evidence snapshots (for example MULTIPLE_FACES) and webcam recordings also show the face, but they still follow `retention_days`, up to 730 days. Retention-schedule drafting note 4 (PR #44) reads C-27 the same way. Is that intended?
- **Applied: C-35.** The cap runs from capture or submission, whatever any review hold says. retention-schedule.md's "never more than 90 days" is therefore accurate for face images. The other clocks still count from the anchor (9.4; owner question 3).

### 9.3 Consent records: rule R-9 (C-04, C-17)

Signed consent records are kept 3 years to prove consent, then deleted (owner decision C-04). They are no longer in R-5.

| Item | Rule | Marker |
| --- | --- | --- |
| What the record is | Document version, signed name, timestamp, IP, user agent and signed PDF. In columns: `consents.consent_text_id`, `signed_name`, `signed_at`, `ip`, `user_agent`, `pdf_key`, plus the PDF object. Future consent-row fields follow the same clock, including the C-30 age confirmation | owner decision C-04, C-17, C-30; mapping: architect detail |
| Clock | Deleted 3 years after signing. The anchor is `consents.signed_at`; the record is eligible when `signed_at + interval '3 years' <= now()` | owner decision C-04, C-17; anchor: architect detail |
| Declined consents | Provisional: the same 3 years from `declined_at`, so no consent row is kept without a limit. Open owner question **OQ-11** | architect detail |
| Who sets the period | A system constant, not an org setting | architect detail |
| How | The daily retention job deletes the objects under `orgs/{orgId}/consents/{sessionId}/`. It deletes the `consents` row (its only pointer to the prefix) **only after the same verification as the tiers in 9.2**: every page listed, no DeleteObjects `Errors`, and a fresh listing that comes back empty. Otherwise it keeps the row and retries the next day. It writes one audit row with IDs only (ADR 0001 C-3) | architect detail |
| Skip | Not deleted while its own session is UNDER_REVIEW or APPEALED, or has an OPEN appeal. A session stuck in a non-terminal state does not block R-9. For the anchor-based clocks, the expiry job and the deadline auto-submit move every session to a terminal state | architect detail |
| Legal hold | None today. Open owner question **OQ-10** (9.8) | open |
| Index | None on `consents` for the pilot. A partial index on the anchor is a later optimisation, and it would need an ADR 0008 delta | architect detail |
| Idempotent | Anchored on `signed_at`, so a restore that brings back an expired row is fixed on the next daily run (9.7) | architect detail |

**Order of the clocks (architect detail; next to OQ-10).** R-9 counts from `signed_at`, and R-10 counts from the anchor. If a review or appeal held the anchor for more than 2 years, R-9 would delete the consent proof before R-10 deletes the results, and data would then be held without proof of consent. A legal hold (OQ-10) is the way to handle this. Without one, the skip rule above keeps the proof only while the review or appeal is still open.

**The consent row must outlive the results (architect detail).** `consents.session_id` is `ON DELETE CASCADE` (database.md). If R-10 deleted `sessions` rows, the consent proof would end at 1 year, not 3.
- Rule: no retention, results or erasure job deletes `sessions` rows. R-10 clears the result data and keeps the row. No delete path for sessions exists today; only the TC-006 audit test runs `DELETE FROM`.
- **Enforced in the database, as for `audit_logs`:** `REVOKE DELETE, TRUNCATE ON sessions FROM app_user`. This is an ADR 0006 §7.2 grants delta and an ADR 0008 delta, added in a migration. `TRUNCATE` is never granted today (database.md); revoking it anyway is belt and braces.
- **The REVOKE can be silently undone.** The `audit_append_only` migration grants with `GRANT ... ON ALL TABLES` plus default privileges, and a later migration that repeats that pattern re-grants DELETE. So the DB-06 test also asserts `has_table_privilege('app_user', 'sessions', 'DELETE') = false`, and the same for `TRUNCATE`.
- DB-06 test (QA assigns the TC ID): deleting a session as `app_user` is refused, and the consent row survives. Test teardown and seed cleanup that delete sessions run as the migration owner, never as `app_user`.
- The rejected alternative is to detach the consent (`ON DELETE SET NULL` on a nullable `session_id`). It is a schema change, and it loses the link to the session used to find the consent prefix.

### 9.4 Results: rule R-10 (C-26)

Results (scores, verdicts, reviewer notes, reports) are kept 1 year after the test, then deleted, leaving only anonymised statistics. Recordings and other session media stay at 90 days, and consent records at 3 years (owner decision C-26).

| Item | Rule | Marker |
| --- | --- | --- |
| Anchor | `retention_anchor_at`, the same anchor as R-3, so an open review or appeal holds it. Eligible at anchor + 1 year | architect detail |
| Report PDF | Moves from R-4 to R-10. The report objects (`reports/**`) are deleted and `sessions.report_key` is nulled at 1 year | owner decision C-26 (reports are results); mechanism: architect detail |
| Content deleted | The R-6 erasure steps for that session, except the consent (R-9 handles it): delete event, batch, identity, media and keystroke rows; **delete the `submissions` rows** (they hold `score`, `passed` and `total` as well as code; nothing references them, and the keystroke batches are already gone); blank code and answers; null `session_reviews.notes`, `session_questions.scoring_note` and the appeal text; clear `device_info`; delete the report. Setting `invitations.accommodations` to `'{}'` is under **OQ-12**: that field also holds C-19 waiver reasons (ADR 0015) | architect detail |
| Scores deleted | **Recommended option (a), with no schema change:** null `sessions.total_score`, `risk_score` and `risk_band`, `session_questions.score` and `session_reviews.verdict`; delete the `submissions` rows (above) and the `appeals` row (its CHECK ties `new_verdict` to its status) | architect detail |
| After nulling | Appeal creation refuses a review whose verdict is NULL or whose window has passed, measured from `session_reviews.completed_at`. Once the `appeals` row is gone, the database no longer enforces one appeal per review, so this check does it. BE-13 and dashboards derive "results purged" from the `RETENTION_RESULTS_DONE` marker, **not** from a NULL verdict, because an auto-cleared or older session can have no verdict from day one (fsd.md §3: "verdict set or auto-clean"). A job that finds no `submissions` rows must not treat the session as purged either: MCQ-only sessions have none | architect detail |
| What remains | The `sessions` row (status, timestamps, test through the invitation) and the audit rows (IDs only). Statistics are counts, such as invitations, completions and per-test volumes. Dashboards (FR-1002) compute score and pass-rate statistics only from sessions still inside their year | owner decision C-26 ("anonymised statistics"); fields: architect detail |
| Candidate row | Once no session of the candidate still has results, the `candidates` row is anonymised as in R-6, and `erased_at` is set. R-10's anonymisation sends no email. A session stuck in a non-terminal state would block this. The expiry job (not started by `window_end`) and the deadline auto-submit cover INVITED to PAUSED, but a session stuck in SUBMITTED or GRADED (a failed job) stays there. Proposed: the daily job alerts on any session still non-terminal 30 days after `window_end`. It also alerts on any session UNDER_REVIEW or APPEALED for more than 60 days, because those hold the anchor, and with it face images past 90 days and results past 1 year | architect detail |
| Concurrency with erasure | R-10 does not anonymise a candidate with a pending `erasure_requested_at` (and `erased_at` NULL); erasure does that, and sends the C-06 notice. R-10 and erasure both take a per-candidate transaction advisory lock (`pg_advisory_xact_lock` on the candidate id; raw SQL in job scope, ADR 0006 §8.5) | architect detail |
| Legal hold | None today (OQ-10). Without one, R-10 can delete records that must be kept while a charge is pending (9.8) | open |

**Why scores are nulled (architect detail; owner to confirm).** `sessions.invitation_id` and `invitations.candidate_id` are NOT NULL. If R-10 kept per-session scores and verdicts, and anonymised the candidate only once none of the candidate's sessions still had results, then a candidate tested every year would keep old verdicts linked to their real name and email indefinitely. That contradicts C-26 and the retention schedule. Options considered:
- **(a) Recommended:** null the scores and the verdict, and delete the submissions, at R-10 for every session. This is uniform, needs no DDL, and leaves no pseudonymised scores behind (`session_questions.score`, and `submissions.score`, `passed` and `total`). A narrower variant nulls them only when the candidate is not anonymised in the same run; it keeps more statistics but behaves differently for multi-session candidates.
- (b) An aggregate statistics table, written before nulling (for example per test and month: count, mean score, band counts). It keeps richer statistics but is an ADR 0008 delta.
- (c) Re-point the session to a per-org anonymous placeholder candidate. That has to work through the composite FKs `(invitation_id, org_id)` and `(candidate_id, org_id)`, and re-pointing invitations rewrites history.

**Owner item: the multi-session case** described above.

**Org settings above one year (architect detail; owner to confirm).** R-10 runs the R-6 content steps at anchor + 1 year, so a `retention_days` of 366..730 never takes effect for media. Should the database.md range become 7..365 (a CHECK change, ADR 0008 delta), or should R-10 leave media to R-4? Proposed: 7..365.

### 9.5 Erasure: R-6 confirmed and amended (C-06, C-17)

- **Confirmed.** "Erasure completes within 30 days of the request, or within 30 days after an open review or appeal closes, whichever is later." The candidate is told about any delay. Code is erased too; only anonymised scores remain (owner decision C-06). R-6 is no longer provisional. The "Tension for Legal" bullet is removed.
- **Changed.** After an erasure request, the minimal consent proof is kept until its 3-year limit, to defend legal claims. The proof is the signed consent record only: version, name, timestamp, IP, user agent and signed PDF. Everything else is erased at once (owner decision C-17).

| R-6 bullet | Before (D-19) | After (C-17) |
| --- | --- | --- |
| Erasure | Applies R-4 at once and also deletes the signed consent PDFs | Deletes and verifies the **whole session prefix** at once (`reports/` included) and nulls the keys, `sessions.report_key` included: the report carries the name, scores and reviewer notes. **It never writes `RETENTION_*_DONE` markers**, so the anchor-driven tiers and R-10 remain the backstop. It does **not** delete the consent PDFs; R-9 deletes them |
| Free text | Null `session_reviews.notes` and `appeals.resolution_note`; set `appeals.reason` to 'Erased' | The same, plus null `session_questions.scoring_note` |
| Consent record | Set `signed_name` to 'Erased'; null `ip`, `user_agent`, `pdf_key` | Removed. The record stays as it is until R-9 |
| What remains | "Only anonymized scores" | Scores, **pseudonymised until the consent proof is deleted**, then anonymised |

**Erasure of a live or recent session (architect detail).** The erasure hold covers only UNDER_REVIEW, APPEALED and open appeals. Erasure can therefore run on a session that is IN_PROGRESS, or inside the ingest margin, where a 16 MiB PUT can complete after its URL expires.
1. **Fence first.** For a non-terminal session, bump `sessions.auth_epoch`, which invalidates the candidate token (ADR 0013), and move the session through `SessionStateService` to a terminal state:
   - before start (INVITED to VERIFIED): to EXPIRED;
   - IN_PROGRESS or PAUSED: to SUBMITTED with ingest closed. Grading, analysis and review routing skip sessions whose candidate has `erasure_requested_at` set.

   No further drafts, presigns, submissions or events are accepted. This is an ADR 0002 amendment: an "erased" path out of the live states.
2. **Delete** as in the table above.
3. **Re-run** the prefix delete after ingest close plus `STORAGE_SWEEP_MARGIN_SECONDS`, as a delayed job, with the same verification. Objects that land late are removed.
4. **QA TC:** erasure during IN_PROGRESS with a late PUT. Afterwards no object remains, the candidate token gets 401, and no row is written after "erasure complete".

**Who counts as erased (architect detail).** The rules below apply to any candidate whose `candidates.erased_at` IS NOT NULL. R-10's candidate anonymisation also sets `erased_at`, so candidates anonymised by R-10 are covered too.

**Re-identification (architect detail).** The kept consent record (name, IP, user agent, PDF) stays joined to `session_id`. For up to 3 years after signing, the session is therefore pseudonymised, not anonymised. Controls:
- After erasure, only SUPER_ADMIN can read the consent record and PDF, and every read writes an audit row (FR-105).
- For an erased candidate, `signed_name`, `ip`, `user_agent` and the PDF never appear in the review workspace, recruiter views, CSV exports, reports or webhooks.
- **System carve-out.** The R-9 deletion job and the R-7 erasure re-application read only ids and keys (`id`, `session_id`, `signed_at`, `declined_at`, `pdf_key`), never `signed_name`, `ip` or `user_agent`. ADR 0013 CS-4.1 gives SERVICE scope no column allowlist, so this rule is enforced in the service layer: one `ConsentRetentionRepository` with a fixed `select`. A static or lint check fails, outside that repository and the SUPER_ADMIN legal-claim path, on any `consent` read **without an explicit `select`** (Prisma returns every scalar column by default), on any `include` or relation load of `consent` (for example `session.findX({ include: { consent: true } })`), on any `select` of `signedName`, `ip` or `userAgent`, and on raw SQL that touches `consents`. CANDIDATE scope already excludes these columns (ADR 0013 CS-4.4), so ADR 0013 needs no change for this.
- decisions.md OQ-1 suggested the PDF "in restricted storage". That remains optional: a separate bucket or prefix policy that only the SUPER_ADMIN path can read (ARC-05).
- **Owner item (it changes published text).** The C-06 wording "only anonymised scores remain" and retention-schedule.md ("We keep only anonymised scores, which can no longer be linked to you") are untrue while the proof exists. Proposed wording: "scores remain, pseudonymised until the consent proof is deleted, then anonymised". retention-schedule.md also says IP and browser details are "removed if you ask us to delete your data", but the consent proof keeps them.

**Telling the candidate (architect detail).** A new email template, `erasure-completed`, says that the signed consent record (version, name, time, IP, browser, PDF) is kept until its 3-year date to defend legal claims, and then deleted. Ordering in the erasure run:
1. Erase everything except the `candidates` row's name and email.
2. Unless an `ERASURE_EMAIL_SENT` audit row already exists for this request, enqueue the email.
   - **Payload: the candidate id only**, never the address. The worker reads the address from the still-intact row, so Redis (and its AOF or RDB snapshots) never holds it.
   - **Erasure request id, with no DDL:** `{candidateId}_{epoch seconds of erasure_requested_at}`. Job id: `erasure-completed_{candidateId}_{epoch}`, using `_` because the `:` jobId spike in ADR 0013 is still open.
   - BullMQ's fixed id deduplicates only while the job record exists, so the worker also checks for an `ERASURE_EMAIL_SENT` row before sending. A crash after completion and removal therefore never sends twice.
   - Retries use backoff.
3. The worker writes an audit row with IDs only: `ERASURE_EMAIL_SENT`, or `ERASURE_EMAIL_FAILED` after the final attempt. A failure raises an alert.
4. **Only then is the `candidates` row anonymised** (`erased+<id>@invalid`). After SENT, this happens at once. After FAILED, it waits until a SUPER_ADMIN records that the candidate was told another way (audited), or until the C-06 deadline (30 days from the request, or from the close of the hold), whichever comes first. The address is therefore available to whoever has to reach the candidate.

The address is never logged. R-10's own anonymisation sends no email. `erasure-delayed` remains for the hold.

**Accommodations (OQ-12).** R-6's "free text about the candidate" does not cover `invitations.accommodations`. Its `notes` field, and the C-19 waiver reason (ADR 0015), can hold health-adjacent information. Proposed, matching OQ-12's suggested answer ("keeping only which settings were used"): erasure and R-10 remove `notes` and the waiver reason (ADR 0015 reduces the waiver to `identityCheckWaived: true`) and keep the setting flags (`extraTimePct`, `disabledDetectors`, `allowedAssistiveTools`). Audit rows keep the record of changes, with IDs only.

### 9.6 Required ADR 0013 changes (PR #39); this amendment's acceptance depends on them

ADR 0013 5.7 was aligned at PR #39 head 75de77c: tiers selected by session with completion markers, R-4 excluding `reports/`, R-10 running the earlier tiers first and deleting `submissions`, and erasure deleting `reports/`. Round 4 adds the items marked **new** below, which ADR 0013 must take up. The acceptance gate stays: the two ADRs are accepted together. The rules ADR 0013 must keep:
- **R-4 at `retention_days`:** delete the session prefix **except `reports/`**.
- **Face tier at face clock + LEAST(`retention_days`, 90), with no hold (C-35):** delete `identity/**` and `evidence/sealed/**`, and null the identity keys and the FACE_MISMATCH `evidence_key`.
- **R-10 at anchor + 1 year:** **new:** list and delete the whole session prefix, not only `reports/`, and null `report_key`. Erasure deletes the whole session prefix at once.
- **Selection:** by session, with per-tier completion markers, always listing the prefix (9.2).
- **New:** a marker is written only after verified deletion (every page listed, no `Errors`, fresh listing empty); `RETENTION_MARKER_ACTIONS` is reserved to RetentionService; erasure never writes markers, fences a live session, and re-runs after ingest close plus the margin (9.5).
- **New:** the wording "a job finding no `submissions` rows treats the session as past its results clock" is unsafe, because MCQ-only sessions have none. Key on the `RETENTION_RESULTS_DONE` marker instead.
- **The BE-09 row in section 8:** the same rules.
- **The cite for R-9:** section 9.3 (done).
- **CS-4:** no change is needed. CANDIDATE scope already excludes `signed_name`, `ip` and `user_agent`, and the SERVICE carve-out is enforced in the service layer (9.5).

### 9.7 Backups (R-7)

- A restore re-applies the erasures recorded after the backup. Re-applied erasure follows C-17: it keeps the consent proof (architect detail).
- R-9, R-10 and both R-4 tiers are anchored and idempotent. A restore brings back rows and markers as they were at backup time; objects already deleted stay deleted. Restored rows have no marker for tiers that completed after the backup, so the next daily run finds and deletes them again (architect detail).
- **Object versioning (follow-up for ARC-05).** If S3 versioning is turned on (OI-5 is open), deleted face images, reports and consent PDFs survive as noncurrent versions, which breaks C-27 and R-9. ARC-05 must either delete every version or set a noncurrent-version lifecycle rule much shorter than the caps (for example 1 day).

### 9.8 Legal flags (flag for owner/Legal advice, not verified by the architect)

1. **BIPA limitation period.** The Illinois Supreme Court (Tims v. Black Horse Carriers, 2023) applies a 5-year limitation period to all BIPA claims. A 3-year consent clock deletes the written release while a claim can still be brought. Options: keep the consent proof (only) for 5 years, or use the legal hold (OQ-10).
2. **Records during a charge.** Without a hold, R-9 and R-10 can delete records that 29 CFR 1602.14 requires to be kept while a charge is pending (OQ-10).
3. **DPIA.** Record the 3-year rationale (GDPR Art. 17(3)(e), legal claims) in the DPIA.
4. **Response time.** A hold can push the erasure response past the one month in GDPR Art. 12(3). The candidate must be told.
5. **CCPA.** The legal-claims exception covers keeping the proof, if it is disclosed.

### 9.9 What else must change (not edited in this PR)

| # | Where | Change | Owner |
| --- | --- | --- | --- |
| 1 | database.md Data rules, retention *Eligible* | No cap today. Add the face clock with LEAST(`retention_days`, 90) and no hold (C-27, C-35), and the object tiers (9.2) | hub, on acceptance |
| 2 | database.md Data rules, retention *Kept* | "kept as proof of consent until erasure" conflicts with C-04. Replace with R-9 and R-10 | hub |
| 3 | database.md Data rules, erasure | "delete all stored objects, including the consent PDF" conflicts with C-17 | hub |
| 4 | database.md Data rules, erasure | "set `consents.signed_name` to 'Erased' and null its `ip`, `user_agent` and `pdf_key`" conflicts with C-17. Also add the 9.5 access rule and carve-out, the no-session-delete rule and the REVOKE (9.3), `scoring_note`, the report deletion, and a comment on `pdf_key`. Also the `retention_days` range question (9.4) | hub |
| 5 | fsd.md FR-704 | Add the 90-day face-image cap (C-27), the 3-year consent clock (C-04) and the 1-year results clock (C-26) | hub |
| 6 | fsd.md NFR-05 | Take the C-06 wording; drop "Provisional (D-19, Legal to confirm)" | hub |
| 7 | fsd.md FR-401 | Consent record kept 3 years after signing, through erasure (C-17) | hub |
| 8 | test-cases.md TC-072, TC-094 | TC-072 adds the 90-day cap with `retention_days` > 90 and keeps `reports/` at R-4. TC-094 keeps the consent proof, deletes the report and drops "provisional, Legal to confirm". QA adds TCs for R-9, R-10 (a multi-session candidate: no `session_questions.score`, `submissions` or verdict left on the older session), erasure during IN_PROGRESS with a late PUT, a failed DeleteObjects leaving no marker, tier selection by session (orphans in `live/`, missed identity frames, missing media rows), the session-delete refusal, access to the kept proof, and the email ordering | hub, QA |
| 9 | prompts/database.md Step 6 | RetentionService: the tiers, R-9, R-10. CandidateErasureService: keeps the proof and deletes the report | hub |
| 10 | DB-06 | Implement 9.2 to 9.5 and 9.7; the `REVOKE DELETE, TRUNCATE ON sessions` migration (ADR 0006 §7.2 and ADR 0008 deltas), with its test and the `has_table_privilege` assertion; per-tier markers written only after verified deletion; the partial index on `audit_logs` (ADR 0008 delta); `RETENTION_MARKER_ACTIONS` reserved, with a lint and a test; the advisory lock between R-10 and erasure | db-engineer |
| 11 | BE-06 email | New template `erasure-completed`: id-only payload, `_` job id, SENT check before enqueue and in the worker, anonymise only after SENT, or after FAILED plus a recorded notice or the deadline (9.5) | backend-engineer |
| 12 | BE-09 storage | The object tiers in 9.2 and 9.6; R-9 alone deletes the consent prefix | backend-engineer |
| 13 | BE-08 and the worker | Embedding cache lifetime (9.1) | integrity-engineer |
| 14 | BE-13, BE-14 | No consent fields of erased candidates in review, export or webhook paths; dashboards and BE-13 derive "results purged" from the `RETENTION_RESULTS_DONE` marker, not from a NULL verdict; appeal creation refuses a NULL verdict or an expired window | backend-engineer |
| 15 | FE-03 | Erase confirmation mentions the kept consent proof | frontend-engineer |
| 16 | ADR 0013 (PR #39) | Every item in 9.6, before this amendment is accepted | hub |
| 17 | retention-schedule.md, consent document | Pseudonymisation wording; the IP and browser row; the C-27 scope; the results row's "1 year after the test", which counts from the anchor (9.4); the face-image "never more than 90 days" is accurate under C-35 | Delivery Lead drafts, owner approves |
| 18 | DPIA | 3-year rationale and the legal flags (9.8) | Delivery Lead |
| 19 | ARC-05 | Object versioning (9.7); Redis snapshot retention for email payloads (9.5) | hub |

### 9.10 Open owner questions

Recorded in decisions.md:
- **OQ-10** Legal hold: a SUPER_ADMIN hold per candidate that pauses R-4, R-9 and R-10? See flags 1 and 2 in 9.8, and the clock-order note in 9.3.
- **OQ-11** Declined consents: 3 years from `declined_at` (provisional here)?
- **OQ-12** Erasure and R-10 set `invitations.accommodations` to `'{}'` (proposed)?

From the architect details above:
1. Does C-18 allow the per-session embedding cache (9.1)?
2. Should C-27 also cover evidence snapshots and webcam recordings (9.2)?
3. The 1-year results clock (C-26 says "1 year after the test") and the recording tier both count from the anchor, so an open review or appeal extends them. Change the published text, or count from `submitted_at` (9.2, 9.4)? (The face tier is settled by C-35.)
4. R-10 nulls scores and verdicts for every session; the multi-session case (9.4)?
5. Should `retention_days` become 7..365 (9.4)?
6. The pseudonymisation wording in published texts (9.5).
