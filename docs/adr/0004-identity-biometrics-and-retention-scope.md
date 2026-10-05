# ADR 0004: Identity checks, face embeddings and retention scope

| Field | Value |
| --- | --- |
| Status | **Accepted** 2026-10-01 (D-16): every recommendation as proposed (embeddings: option (a), never stored); amended by D-17 (consent PDF retention), D-18 (threshold test set) and D-19 (erasure). See section 8. Applied to database.md; deltas in ADR 0008. **Amendment proposed 2026-10-05, for the owner to accept:** section 9 applies the owner's compliance decisions C-04, C-06, C-17 and C-18 (docs/compliance/decisions.md, PR #44) to R-5, R-6 and section 8. Not yet applied to database.md or fsd.md (section 9.6). |
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
  - *Proposed amendment (section 9.2):* consent records leave this list. They get their own 3-year clock (R-9) and are then deleted.
- **R-6 Erasure on request** (TC-094, NFR-05) is a SUPER_ADMIN action; the endpoint is defined in ARC-02. Amended by D-19, a provisional default that Legal must confirm. *Proposed amendment (section 9.3):* confirmed by C-06; the consent-PDF and consent-record bullets below are replaced by C-17.
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
  - *Detail chosen by architect; owner and Legal to confirm:* the PDF is kept until erasure, not deleted at `retention_days` with the recordings.
  - *Proposed amendment (section 9.2, 9.3):* replaced by C-04 and C-17. The PDF and the record are kept 3 years after signing, through an erasure request, and then deleted.
- **D-18 test set and fallback.** See section 2. The tuning data never enters the CodeProctor database or its backups.
- **D-19 erasure.** See R-6.
  - *Detail chosen by architect; owner and Legal to confirm:*
    - the hold setting lives in `organizations.settings.erasure.holdWhileReviewOrAppealOpen` (default true);
    - `candidates.erasure_requested_at` records the pending request;
    - the candidate is told by email (`erasure-delayed`);
    - erasure deletes event, identity and media rows, not only their keys, so only anonymized scores remain.

## 9. Proposed amendment 2026-10-05: consent clock and erasure (C-04, C-06, C-17, C-18)

**Status: Proposed. The owner accepts or amends.** Source: the owner's compliance decisions in docs/compliance/decisions.md (PR #44). "(owner decision C-xx)" marks what that file decides; "(architect detail)" marks what this ADR adds and the owner must confirm. Serves FR-401, FR-704, NFR-05, TC-072, TC-094.

### 9.1 What stays as it is

| Item | Rule | Marker |
| --- | --- | --- |
| Media and biometric images | Recordings, ID images, selfies, identity re-check frames and keystroke data are deleted 90 days after the test (configurable). R-1 to R-4 already do this with `organizations.retention_days` (default 90). | owner decision C-04 |
| Re-check frames kept on a mismatch | They are evidence objects, deleted under R-4. In ADR 0013's key layout (PR #39) the sealed frame sits under the session prefix, so R-4's prefix deletion covers it. | owner decision C-04; layout: architect detail |
| Face embeddings | Never stored. Computed in memory for each comparison and discarded; periodic re-checks recompute from the stored selfie. Section 2 option (a) stands; option (b) and the conditional `face_embeddings` clause in R-4 are closed. | owner decision C-18 |
| Biometric cap | Not changed here. Whether ID images, selfies and re-check frames are capped at 90 days whatever `retention_days` (7..730) says is decisions.md OQ-5, still open. R-3 keeps applying `retention_days` to them. | open (OQ-5) |

### 9.2 New rule R-9: consent records get their own 3-year clock

R-5 no longer lists consent records. They are kept 3 years to prove consent, then deleted (owner decision C-04).

| Item | Rule | Marker |
| --- | --- | --- |
| What the record is | Document version, signed name, timestamp, IP, user agent and signed PDF: `consents.consent_text_id` (the version), `signed_name`, `signed_at`, `ip`, `user_agent`, `pdf_key` and the PDF object. | owner decision C-04, C-17; column mapping: architect detail |
| Clock | 3 years after signing, then deleted. The anchor is `consents.signed_at`; eligible when `signed_at + interval '3 years' <= now()`. | owner decision C-04, C-17; anchor: architect detail |
| Who sets the period | A system constant, not an org setting. C-04 makes only the 90-day period configurable. | architect detail |
| How it is deleted | In the daily retention job (DB-06): delete the objects under `orgs/{orgId}/consents/{sessionId}/` first, then delete the `consents` row, and write one `audit_logs` row per consent with IDs only (ADR 0001 C-3), as R-4 does. | architect detail |
| Hold | A consent is not deleted while its own session is on the R-2 hold (UNDER_REVIEW, APPEALED, or an OPEN appeal). There is no litigation-hold mechanism (owner question 1). | architect detail |
| Declined consents | A declined record holds `declined_at`, `ip` and `user_agent`, with no name and no PDF. C-04 names only signed records. Proposed: the same 3-year clock from `declined_at` (owner question 2). | architect detail |
| Index | None for the pilot: one row per session, so the daily scan is small. An index on the anchor needs an ADR 0008 delta if it is ever added. | architect detail |
| Backups (R-7) | A restore can bring back a consent deleted in the 14 days before it. The next daily run deletes it again, because its anchor is still past. | architect detail |
| Invariant | After R-9 runs, a session past CONSENTED can have no `consents` row. Code and tests must not assume one exists for terminal sessions older than 3 years. | architect detail |

### 9.3 R-6 erasure: confirmed, and the consent proof is kept

- **Confirmed.** The erasure hold is approved as proposed: "Erasure completes within 30 days of the request, or within 30 days after an open review or appeal closes, whichever is later." The candidate is told about any delay. Code is erased too; only anonymised scores remain (owner decision C-06). R-6 is no longer provisional, and NFR-05 takes this wording.
- **Changed.** After an erasure request, the minimal consent proof is kept until its 3-year limit, to defend legal claims. The proof is the signed consent record only: version, name, timestamp, IP, user agent and signed PDF. Everything else is erased at once (owner decision C-17).

R-6 bullets, before and after:

| R-6 bullet | Before (D-19) | After (C-17) |
| --- | --- | --- |
| Erasure | Applies R-4 at once to every session of the candidate, and also deletes the signed consent PDFs | Applies R-4 at once to every session of the candidate (the session prefix). It does **not** delete the consent PDFs; R-9 deletes them at 3 years |
| Consent record | Set `signed_name` to 'Erased' and null `ip`, `user_agent` and `pdf_key` | Removed. The record is left as it is until R-9 deletes it |
| What remains | Only anonymized scores | Anonymized scores, plus the consent proof until its 3-year date |

Every other R-6 bullet (hold, code and answers, free text, `device_info`, candidate anonymization) is unchanged.

Architect details for the owner to confirm:
- **Access after erasure.** The consent record and PDF of an erased candidate do not appear in the review workspace, reports, CSV exports or webhooks. Only SUPER_ADMIN can read them, for a legal claim, and each read writes an audit row (FR-105).
- **Telling the candidate.** C-17 puts the rule in the consent document and the retention schedule. In addition, the erasure confirmation email says the consent record is kept until its 3-year date and then deleted.
- **Linkability.** The anonymized candidate row stays linked to the kept consent record through session and invitation. That is what C-17 keeps: the record carries the signed name anyway.
- **Gap found, not from C-17.** R-6's "free text about the candidate" does not cover `invitations.accommodations` (its `notes` field can hold health information). Proposed: erasure sets `invitations.accommodations` to `'{}'` (owner question 3).

### 9.4 Consistency with ADR 0013 (PR #39, Proposed)

- **Key layout agrees.** ADR 0013 5.7 puts the consent PDF at `orgs/{orgId}/consents/{sessionId}/{ULID}.pdf`, outside the session prefix. R-4 and erasure delete the session prefix; the consent prefix now outlives both and is deleted by R-9. So the layout is still right, for a stronger reason.
- **Two ADR 0013 lines must change** (hub, in PR #39 or at its acceptance):
  - 5.7 table, consent PDF row: "kept until erasure, D-17" becomes "kept 3 years after signing, through erasure (C-04, C-17)".
  - 5.7 bullet "Erasure (R-6) deletes the session prefix and `orgs/{orgId}/consents/{sessionId}/`" becomes "Erasure (R-6) deletes the session prefix. R-9 deletes `orgs/{orgId}/consents/{sessionId}/` 3 years after signing."
- ADR 0013 owner question 16 (consent PDF outside the session prefix) is then answered by this amendment.
- CS-4 (candidate-session allowlist on `consents`) is unaffected.

### 9.5 Consistency with database.md (main)

No DDL change. Three Data rules lines conflict and must change on acceptance:
- Retention job, *Kept.*: "The consent record and its signed PDF are kept as proof of consent until erasure."
- Erasure: "delete all stored objects, including the consent PDF".
- Erasure: "set `consents.signed_name` to 'Erased' and null its `ip`, `user_agent` and `pdf_key`".

### 9.6 What else must change (not edited in this PR)

| # | Where | Change | Owner |
| --- | --- | --- | --- |
| 1 | database.md Data rules | The three lines in 9.5; add R-9 (consent clock) and the 9.3 access rule; comment on `consents.pdf_key`: "kept 3 years after signing (R-9)" | hub, on acceptance |
| 2 | fsd.md FR-401 | Add: the signed consent record is kept 3 years after signing, then deleted, also after an erasure request (C-04, C-17) | hub, on acceptance |
| 3 | fsd.md FR-704 | Add: consent records follow their own 3-year clock (R-9) | hub, on acceptance |
| 4 | fsd.md NFR-05 | Take the C-06 wording; drop "Provisional (D-19, Legal to confirm)" | hub, on acceptance |
| 5 | test-cases.md TC-094 | Expected result keeps the consent record and PDF; remove "provisional, Legal to confirm" | hub, with QA |
| 6 | New TC (QA assigns the ID) | Consent record and PDF deleted 3 years after `signed_at` (clock advanced), with an audit row; not deleted while its session is on hold | QA |
| 7 | prompts/database.md Step 6 | RetentionService adds R-9; CandidateErasureService no longer deletes consent PDFs or blanks the consent record | hub, on acceptance |
| 8 | DB-06 | Implement R-9 and the amended R-6, with tests for TC-072, TC-094 and item 6 | db-engineer |
| 9 | BE-09 storage | Erasure deletes only the session prefix; R-9 deletes the consent prefix | backend-engineer |
| 10 | BE-06 email templates | Erasure confirmation sentence (9.3, architect detail) | backend-engineer |
| 11 | FE-03 erase action | Confirmation text says the consent record stays until its 3-year date | frontend-engineer |
| 12 | ADR 0013 5.7 | The two lines in 9.4 | hub (PR #39) |
| 13 | retention-schedule.md, consent-document.md | Already say this (C-17, PR #44). Note: the draft schedule also states a 90-day biometric cap, which is still open (OQ-5) | Delivery Lead |

### 9.7 Owner questions

1. Is a litigation hold needed (a way to stop R-9 deleting a consent record while a claim is pending)?
2. Declined consent records: the same 3-year clock from `declined_at` (proposed), or the 90-day retention with the session?
3. Erasure clears `invitations.accommodations` (proposed), which can hold health information?
