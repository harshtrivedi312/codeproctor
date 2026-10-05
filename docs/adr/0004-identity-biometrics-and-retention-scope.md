# ADR 0004: Identity checks, face embeddings and retention scope

| Field     | Value                                                                                                                                                                                                                                                      |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status    | **Accepted** 2026-10-01 (D-16): every recommendation as proposed (embeddings: option (a), never stored); amended by D-17 (consent PDF retention), D-18 (threshold test set) and D-19 (erasure). See section 8. Applied to database.md; deltas in ADR 0008. |
| Author    | architect                                                                                                                                                                                                                                                  |
| Decides   | Q-06, Q-11, Q-12, A-02, A-04, A-09 (retention hold, D-08), A-21 items 2 and 4                                                                                                                                                                              |
| Serves    | FR-403, FR-404, FR-606, FR-701, FR-704, FR-904; NFR-05; BR-13; TC-033, TC-034, TC-035, TC-070, TC-072, TC-077, TC-094                                                                                                                                      |
| Builds on | ADR 0001 D-05 (AuraFace with MediaPipe, never an automatic rejection) and the model licence table in ADR 0001 section 12                                                                                                                                   |

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

| Option                                                 | DDL                       | Size                                                                                                                                                                   | Privacy                                                                                                 |
| ------------------------------------------------------ | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **(a) Never persist (accepted)**                       | none                      | 2 KB × concurrent sessions in worker memory (200 sessions = 0.4 MB)                                                                                                    | No biometric template at rest, in backups or in the API. A model swap needs no migration.               |
| (b) Persist the selfie embedding, encrypted            | `face_embeddings` (below) | 2,076 bytes a row (AES-256-GCM: 12-byte nonce + 2,048 + 16-byte tag), stored out of line by TOAST. At most 2 rows a session. 10,000 sessions ≈ 42 MB if never deleted. | Template sits in the database and in 14-day backups. Delete at SUBMITTED, with retention as a backstop. |
| (c) Persist as `real[]` or with the pgvector extension | a vector column           | About 2,072 bytes a row                                                                                                                                                | Adds a vector search we do not need (no search across candidates); pgvector would be a new extension.   |

For (a):

- The worker computes the ID and selfie embeddings when a match job runs, compares them, and stores only the score, `model_id` and `threshold` on the attempt row.
- It keeps the selfie embedding in memory, keyed by session, for the periodic FACE_MISMATCH re-checks (FR-606). On a cache miss or restart it recomputes it from the stored selfie image (one extra inference).
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
- **R-4 At retention**, delete the objects first, then null the keys in one transaction (only `media_chunks` also gets `deleted_at`):
  - `media_chunks.object_key` (all streams, including ROOM_SCAN), plus `deleted_at`;
  - `identity_checks.id_image_key` and `selfie_key`;
  - `proctor_events.evidence_key`;
  - `sessions.report_key` (ADR 0007).
  - Also delete the `keystroke_batches` rows, and the `face_embeddings` rows if §2 option (b) is chosen.
  - Write one audit row per session, with IDs only (ADR 0001 C-3).
- **R-5 Kept** after retention: the session, scores, submissions, event rows without evidence, reviews, appeals, consent records (including the signed consent PDF, D-17) and audit rows.
- **R-6 Erasure on request** (TC-094, NFR-05) is a SUPER_ADMIN action; the endpoint is defined in ARC-02. Amended by D-19, a provisional default that Legal must confirm:
  - The request sets `candidates.erasure_requested_at`.
  - **Hold.** While any of the candidate's sessions is UNDER_REVIEW or APPEALED, or has an OPEN appeal, erasure waits and the candidate is told (email template `erasure-delayed`). A job runs the erasure as soon as the last review or appeal closes. The hold is the org setting `erasure.holdWhileReviewOrAppealOpen` (default true; false erases at once).
  - **Erasure** applies R-4 at once to every session of the candidate, whatever the retention days, and also deletes the signed consent PDFs. It then deletes the candidate's `media_chunks`, `identity_checks`, `proctor_events` (with their `flag_decisions`), `proctor_event_batches` and `keystroke_batches` rows.
  - **Code and answers are erased too (D-19).** Blank `submissions.source_code` and `results` (set to `''` and `'[]'`), and `session_questions.final_code` and `answer`.
  - **Free text about the candidate.** Null `session_reviews.notes` and `appeals.resolution_note`, and set `appeals.reason` to 'Erased'.
  - **Consent record.** Set `consents.signed_name` to 'Erased' and null `ip`, `user_agent` and `pdf_key`.
  - **Session and candidate.** Clear `sessions.device_info`. Anonymize `candidates` in place: email `erased+<id>@invalid`, full_name 'Erased', external_ref NULL, `erased_at` set.
  - **Only anonymized scores remain:** total and per-question scores, risk score and band, and verdicts.
  - **Tension for Legal:** NFR-05 says "deletion on request within 30 days". A review or appeal that stays open longer would hold erasure past 30 days. The hold setting lets Legal choose.
- **R-7 Backups** are kept 14 days (A-31). Erasures made after a backup was taken must be re-applied after a restore, so the list of erased candidate IDs is kept outside the database backup (DB-07, ARC-05).
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
  - _Detail chosen by architect; owner and Legal to confirm:_ the PDF is kept until erasure, not deleted at `retention_days` with the recordings.
- **D-18 test set and fallback.** See section 2. The tuning data never enters the CodeProctor database or its backups.
- **D-19 erasure.** See R-6.
  - _Detail chosen by architect; owner and Legal to confirm:_
    - the hold setting lives in `organizations.settings.erasure.holdWhileReviewOrAppealOpen` (default true);
    - `candidates.erasure_requested_at` records the pending request;
    - the candidate is told by email (`erasure-delayed`);
    - erasure deletes event, identity and media rows, not only their keys, so only anonymized scores remain.
