# ADR 0004: Identity checks, face embeddings and retention scope

| Field | Value |
| --- | --- |
| Status | **Accepted** 2026-10-01 (D-16): every recommendation as proposed (embeddings: option (a), never stored); amended by D-17 (consent PDF retention), D-18 (threshold test set) and D-19 (erasure). See section 8. Applied to database.md; deltas in ADR 0008. **Amendment proposed 2026-10-05, for the owner to accept:** section 9 applies the owner's compliance decisions C-04, C-06, C-17, C-18, C-26 and C-27 (docs/compliance/decisions.md, PR #44) to section 2, R-3 to R-7 and section 8. Not yet applied to database.md or fsd.md (section 9.9). |
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
  - *Proposed amendment (section 9.2, C-27):* face images (ID image, selfie, sealed mismatch frames) are eligible at anchor + LEAST(`retention_days`, 90 days).
- **R-4 At retention**, delete the objects first, then null the keys in one transaction (only `media_chunks` also gets `deleted_at`):
  - `media_chunks.object_key` (all streams, including ROOM_SCAN), plus `deleted_at`;
  - `identity_checks.id_image_key` and `selfie_key`;
  - `proctor_events.evidence_key`;
  - `sessions.report_key` (ADR 0007). *Proposed amendment (section 9.4, C-26):* the report moves to the 1-year results clock (R-10).
  - Also delete the `keystroke_batches` rows, and the `face_embeddings` rows if §2 option (b) is chosen.
  - Write one audit row per session, with IDs only (ADR 0001 C-3).
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

## 9. Proposed amendment 2026-10-05: retention clocks and erasure (C-04, C-06, C-17, C-18, C-26, C-27)

**Status: Proposed. The owner accepts or amends.** Source: the owner's compliance decisions in docs/compliance/decisions.md (PR #44).
- "(owner decision C-xx)" marks what that file decides.
- "(architect detail)" marks what this ADR adds, for the owner to confirm.
- "(flag for owner/Legal advice, not verified by the architect)" marks legal points the architect raises but has not verified.

Serves FR-401, FR-704, NFR-05, TC-072, TC-094.

### 9.1 Embeddings (C-18)

- Face embeddings are never stored. They are computed in memory for each comparison and discarded, and periodic re-checks recompute from the stored selfie (owner decision C-18). Section 2 option (a) stands. Option (b) and the conditional `face_embeddings` clause in R-4 are closed.
- **Per-session cache (architect detail; owner to confirm that C-18 allows it).** Section 2 keeps the selfie embedding in the worker's memory for the re-checks. Its lifetime:
  - process memory only: never Redis, BullMQ job payloads or results, disk, or logs;
  - evicted when the session reaches SUBMITTED or EXPIRED, or at ingest close (ADR 0013), whichever comes first;
  - TTL backstop: `deadline_at` plus the ingest grace, so a lost eviction cannot keep it longer;
  - a restart or a miss recomputes it from the stored selfie.

### 9.2 Media and face images (C-04, C-27)

| Item | Clock | Marker |
| --- | --- | --- |
| Recordings (all streams, ROOM_SCAN included), evidence snapshots of `EVENT` purpose, keystroke data | anchor + `retention_days` (default 90, range 7..730), under R-3 and R-4 | owner decision C-04 |
| **Face images:** the ID image, the selfie, and identity re-check frames kept on a mismatch (the sealed FACE_MISMATCH evidence) | anchor + **LEAST(`retention_days`, 90 days)**. `retention_days` may shorten this but never extend it past 90 days | owner decision C-27 |
| How | R-4 runs in two tiers. At anchor + LEAST(`retention_days`, 90) it deletes the identity objects and the FACE_MISMATCH evidence, and nulls `identity_checks.id_image_key`, `selfie_key` and those `proctor_events.evidence_key` values. At anchor + `retention_days` it does the rest. It is idempotent because it selects rows whose keys are still set. No DDL | architect detail |

- **Owner to confirm (architect detail).** C-27 names only the ID image, the selfie and the mismatch frames. Evidence snapshots (for example MULTIPLE_FACES) and webcam recordings also show the face, yet they still follow `retention_days`, up to 730 days. Retention-schedule drafting note 4 (PR #44) reads C-27 the same way. Is that intended?
- **Hold versus cap (architect detail).** The 90 days count from the anchor. An open review or appeal keeps the anchor NULL (R-2), so face images stay while it is open. That is the existing hold, not the org setting.

### 9.3 Consent records: rule R-9 (C-04, C-17)

Signed consent records are kept 3 years to prove consent, then deleted (owner decision C-04). They leave R-5.

| Item | Rule | Marker |
| --- | --- | --- |
| What the record is | Document version, signed name, timestamp, IP, user agent and signed PDF: `consents.consent_text_id`, `signed_name`, `signed_at`, `ip`, `user_agent`, `pdf_key` and the PDF object. Future consent-row fields follow the same clock, including the C-30 age confirmation | owner decision C-04, C-17, C-30; mapping: architect detail |
| Clock | Deleted 3 years after signing. The anchor is `consents.signed_at`; a record is eligible when `signed_at + interval '3 years' <= now()` | owner decision C-04, C-17; anchor: architect detail |
| Declined consents | Provisional: the same 3 years from `declined_at`, so no consent row is kept without a limit. Open owner question **OQ-11** | architect detail |
| Period setting | A system constant, not an org setting | architect detail |
| How | The daily retention job deletes the objects under `orgs/{orgId}/consents/{sessionId}/`, then the `consents` row, and writes one audit row with IDs only (ADR 0001 C-3) | architect detail |
| Skip | Not deleted while its own session is UNDER_REVIEW or APPEALED, or has an OPEN appeal. A session stuck in a non-terminal state does not block R-9. For the anchor-based clocks, the expiry job and the deadline auto-submit are the backstop that moves every session to a terminal state | architect detail |
| Legal hold | None today. Open owner question **OQ-10** (9.8) | open |
| Index | None for the pilot. A partial index on the anchor is a later optimisation, and it needs an ADR 0008 delta | architect detail |
| Idempotent | Anchored on `signed_at`, so the next daily run deletes again any expired row that a restore brought back (9.7) | architect detail |

**The consent row must outlive the results (architect detail).** `consents.session_id` is `ON DELETE CASCADE` (database.md). If the 1-year results clock (9.4) deleted `sessions` rows, the consent proof would die at 1 year, not 3.
- Rule: **no retention, results or erasure job deletes `sessions` rows.** R-10 clears the result data and keeps the session row, which then holds no personal data.
- Rejected alternative: detach the consent (`ON DELETE SET NULL` on a nullable `session_id`). It is a schema change, and it loses the session link used to find the consent prefix.

### 9.4 Results: rule R-10 (C-26)

Results (scores, verdicts, reviewer notes, reports) are kept 1 year after the test, then deleted, leaving only anonymised statistics. Recordings and other session media stay at 90 days, and consent records at 3 years (owner decision C-26).

| Item | Rule | Marker |
| --- | --- | --- |
| Anchor | `retention_anchor_at`, the same anchor as R-3, so an open review or appeal holds it. Eligible at anchor + 1 year | architect detail |
| Report PDF | Moves from R-4 to R-10. The report object and `sessions.report_key` are deleted at 1 year, not at `retention_days` | owner decision C-26 (reports are results); mechanism: architect detail |
| What R-10 deletes | The R-6 erasure steps for that session, except the consent: delete event, batch, identity, media and keystroke rows; blank code and answers; null reviewer notes and appeal text; clear `device_info`; delete the report; set `invitations.accommodations` to `'{}'` | architect detail |
| What remains | The `sessions` row (status, timestamps, `total_score`, `risk_band`), per-question scores, and the verdict without notes. Once none of a candidate's sessions still has results, the `candidates` row is anonymised as in R-6 | owner decision C-26 ("anonymised statistics"); fields: architect detail |
| Pseudonymised | While a consent record exists (up to 3 years after signing), it still links a name to the session and its scores (9.5) | architect detail |
| Legal hold | None today (OQ-10). Without one, R-10 can delete records that must be kept while a charge is pending (9.8) | open |

### 9.5 Erasure: R-6 confirmed and amended (C-06, C-17)

- **Confirmed.** "Erasure completes within 30 days of the request, or within 30 days after an open review or appeal closes, whichever is later." The candidate is told about any delay. Code is erased too; only anonymised scores remain (owner decision C-06). R-6 is no longer provisional, and the "Tension for Legal" bullet is removed.
- **Changed.** After an erasure request, the minimal consent proof is kept until its 3-year limit, to defend legal claims. The proof is the signed consent record only: version, name, timestamp, IP, user agent and signed PDF. Everything else is erased at once (owner decision C-17).

| R-6 bullet | Before (D-19) | After (C-17) |
| --- | --- | --- |
| Erasure | Applies R-4 at once and also deletes the signed consent PDFs | Applies R-4 at once (the session prefix). Does **not** delete the consent PDFs; R-9 deletes them |
| Consent record | Set `signed_name` to 'Erased'; null `ip`, `user_agent`, `pdf_key` | Removed. The record stays as it is until R-9 |
| What remains | "Only anonymized scores" | Scores, **pseudonymised until the consent proof is deleted**, then anonymised |

**Re-identification (architect detail).** The kept consent record (name, IP, user agent, PDF) stays joined to `session_id`, and through it to the scores. For up to 3 years after signing, the data is pseudonymised, not anonymised. Controls:
- After erasure, only SUPER_ADMIN can read the consent record and PDF, and every read writes an audit row (FR-105).
- For an erased candidate, `signed_name`, `ip`, `user_agent` and the PDF never appear in the review workspace, recruiter views, CSV exports, reports or webhooks.
- decisions.md OQ-1 suggested keeping the PDF "in restricted storage". That stays optional: a separate bucket, or a prefix policy that only the SUPER_ADMIN path can read (ARC-05).
- ADR 0013's actor and column allowlists (CS-4) must match: no CANDIDATE or SERVICE path reads the `consents` row of an erased candidate (follow-up).
- **Owner item, because it changes published text.** The C-06 wording "only anonymised scores remain" and retention-schedule.md's "We keep only anonymised scores, which can no longer be linked to you" are untrue while the proof exists. Proposed wording: "scores remain, pseudonymised until the consent proof is deleted, then anonymised". retention-schedule.md also says IP and browser details are "removed if you ask us to delete your data", but the consent proof keeps both.

**Telling the candidate (architect detail).** A new email template, `erasure-completed`, is sent when erasure runs. It says the signed consent record (version, name, time, IP, browser, PDF) is kept until its 3-year date to defend legal claims, and is then deleted. `erasure-delayed` stays for the hold.

**Accommodations (open owner question OQ-12).** R-6's "free text about the candidate" does not cover `invitations.accommodations`, whose `notes` can hold health information. Proposed: erasure sets it to `'{}'`, as R-10 does.

### 9.6 Consistency with ADR 0013 (PR #39)

- **The key layout agrees.** The consent PDF sits at `orgs/{orgId}/consents/{sessionId}/{ULID}.pdf`, outside the session prefix, and now outlives R-4, R-10 and erasure.
- **These parts conflict with C-17** and must change with #39 or before it merges (follow-ups):
  - 5.7 table, consent PDF row: "kept until erasure, D-17" becomes "kept 3 years after signing, through erasure (C-04, C-17)";
  - 5.7 bullet "Erasure (R-6) deletes the session prefix and `orgs/{orgId}/consents/{sessionId}/`" becomes "Erasure deletes the session prefix; R-9 deletes the consent prefix";
  - section 8, backend BE-09 row: "prefix deletion in retention and erasure, consent PDF prefix" becomes "consent PDF prefix deleted by R-9 only";
  - CS-4 allowlists: add the erased-candidate consent rule from 9.5.

### 9.7 Backups (R-7)

- A restore re-applies the erasures recorded after the backup. Re-applied erasure follows C-17 and keeps the consent proof (architect detail).
- R-9 and R-10 are anchored and idempotent. Rows that a restore brings back after their deletion date are deleted again on the next daily run (architect detail).

### 9.8 Legal flags (flag for owner/Legal advice, not verified by the architect)

1. **BIPA limitation period.** The Illinois Supreme Court (Tims v. Black Horse Carriers, 2023) applies a 5-year limitation period to all BIPA claims. A 3-year consent clock would delete the written release while a claim can still be brought. Options: 5 years for the consent proof only, or the legal hold (OQ-10).
2. **Records during a charge.** Without a hold, R-9 and R-10 can delete records that 29 CFR 1602.14 requires to be kept while a charge is pending (OQ-10).
3. **DPIA.** Record the 3-year rationale (GDPR Art. 17(3)(e), legal claims) in the DPIA.
4. **Response time.** A hold can push the erasure response past GDPR Art. 12(3)'s one month; the candidate must be told.
5. **CCPA.** The legal-claims exception covers keeping the proof, as long as it is disclosed.

### 9.9 What else must change (not edited in this PR)

| # | Where | Change | Owner |
| --- | --- | --- | --- |
| 1 | database.md Data rules, retention *Eligible* | No cap today. Add LEAST(`retention_days`, 90) for face images (C-27) | hub, on acceptance |
| 2 | database.md Data rules, retention *Kept* | "kept as proof of consent until erasure" conflicts with C-04. Replace it with R-9 and R-10 | hub |
| 3 | database.md Data rules, erasure | "delete all stored objects, including the consent PDF" conflicts with C-17 | hub |
| 4 | database.md Data rules, erasure | "set `consents.signed_name` to 'Erased' and null its `ip`, `user_agent` and `pdf_key`" conflicts with C-17. Also add the 9.5 access rule, the no-session-delete rule (9.3) and a comment on `pdf_key` | hub |
| 5 | fsd.md FR-704 | Add the 90-day face-image cap (C-27), the 3-year consent clock (C-04) and the 1-year results clock (C-26) | hub |
| 6 | fsd.md NFR-05 | Take the C-06 wording and drop "Provisional (D-19, Legal to confirm)" | hub |
| 7 | fsd.md FR-401 | The consent record is kept 3 years after signing, also after erasure (C-17) | hub |
| 8 | test-cases.md TC-072, TC-094 | TC-072 adds the 90-day cap with `retention_days` > 90. TC-094 keeps the consent proof and drops "provisional, Legal to confirm". QA adds TCs for R-9, R-10 and access to the kept proof | hub, QA |
| 9 | prompts/database.md Step 6 | RetentionService: two-tier R-4, R-9 and R-10. CandidateErasureService keeps the consent proof | hub |
| 10 | DB-06 | Implement 9.2 to 9.5 and 9.7, with tests | db-engineer |
| 11 | BE-06 email | New template `erasure-completed` (9.5) | backend-engineer |
| 12 | BE-09 storage | Two-tier deletion; the report under R-10; the consent prefix under R-9 only | backend-engineer |
| 13 | BE-08 and the worker | Embedding cache lifetime (9.1) | integrity-engineer |
| 14 | BE-13, BE-14 | Never return an erased candidate's consent fields in review, export or webhook paths | backend-engineer |
| 15 | FE-03 | The erase confirmation mentions the kept consent proof | frontend-engineer |
| 16 | ADR 0013 | The items in 9.6, with #39 or before it merges | hub |
| 17 | retention-schedule.md, consent document | Pseudonymisation wording, the IP and browser row (9.5), and the C-27 scope (9.2) | Delivery Lead drafts, owner approves |
| 18 | DPIA | The 3-year rationale and the legal flags (9.8) | Delivery Lead |

### 9.10 Open owner questions (recorded in decisions.md)

- **OQ-10** Legal hold: should a SUPER_ADMIN hold per candidate pause R-4, R-9 and R-10? See flags 1 and 2 in 9.8.
- **OQ-11** Declined consents: 3 years from `declined_at`, as provisionally proposed here?
- **OQ-12** Should erasure clear `invitations.accommodations`, as proposed?

Also for the owner, from the architect details above: the per-session embedding cache under C-18 (9.1); whether C-27 should also cover evidence snapshots and webcam recordings (9.2); and the pseudonymisation wording in published text (9.5).

