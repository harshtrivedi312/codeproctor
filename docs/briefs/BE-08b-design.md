# BE-08b design notes: identity API (apps/api/src/identity)

Status: **design notes by Integrity B (identity), 2026-10-05 (revised after review). Not an ADR; nothing here changes a contract.** Built against ADR 0004 sections 1 and 2, ADR 0013 (3.3, 5.6, 5.7, 5.10, CS-4.4, CS-4.7), ADR 0014 (3.3, 3.4, 4.2, 5.3, 6.2 to 6.5) and ADR 0015 (sections 2, 3, 6, 7), owner decisions C-02, C-08, C-18, C-19, C-25, C-34, and the merged worker half (BE-08a, `apps/worker`). Read the ADRs first; where this note and an ADR differ, the ADR wins. Facts about `apps/api` come from the draft BE-07 PR (#98, `backend-cand/be-07-session`) and may change when it merges.

## 1. What is built and what is not

Worker half, merged: `POST /v1/face/match`, `/v1/face/recheck`, `/v1/face/evict`, `GET /v1/ready`, HMAC signing, fetch guard, model lock. BE-08b is the API half:

- `WorkerClient` (signing, response verification, runtime validation, timeouts, `WORKER_BUSY` handling).
- Routes: `POST /candidate/session/identity`, `GET /candidate/session/identity` (status), and `POST /candidate/session/identity/recheck` (ADR 0013 5.6; the evidence presign for purpose `IDENTITY_RECHECK` is BE-09's).
- Two BullMQ processors: `face-match` and `face-recheck` (ADR 0014 3.3).
- Reviewer actions on `identity_checks` (manual decision) are BE-13; the waiver itself is BE-06 (invitation accommodations). BE-08b only reads them. `GET .../identity` and its `canRetry` field are not in any ADR contract yet: record them in api-contract.md (ADR 0012).

## 2. Dependencies, in the order they unblock work

| Needs | From | What BE-08b uses |
| --- | --- | --- |
| BE-07 (#98) | `CandidateSessionGuard`, `CandidateContext`, `SessionStateService`, `session-write-gate`, `ObjectStoragePort`, `session-jobs.service.ts` (the queue setup to copy, not fork), `apps/api/src/media/storage-keys.ts` (`identityUploadKey`, `identitySealedKey`) | session identity for every route; the CONSENTED to VERIFIED transition |
| `SessionJobProcessor`, `runAsSessionJob`, `withLiveSession`, `guardLive`, `lockForAccommodation` (ADR 0013, ADR 0004 9.5, ADR 0015 section 6) | **not in the BE-07 code seen** (its jobs use `runInOrg`). Owner: BE-07/BE-10 per ADR 0013 section 11; **confirm before coding**. Interim: write through `SessionStateService` and the org-scoped client, with the same re-checks inside the write transaction | the processors' step 1 and step 4 below |
| `verify-session` | ADR 0013 section 3.3 and CS-4.7 assign it to BE-07; **not in the BE-07 code seen** | the face-match outcome and failed-job handlers enqueue it |
| BE-09 | `StorageService`: single-use names (5.2 state machine), presign for `ID_IMAGE` and `SELFIE` (<= 5 MiB, state CONSENTED), HEAD, CopyObject to `sealed/`, `presignGetForWorker(key, ttl)` (60 s for face) | everything that touches an image. **Until BE-09 lands, build against an interface** (`IdentityMedia`: `sealPair(names) -> {idKey, selfieKey}`, `presignForWorker(key) -> url`, `deleteOriginals(names)`, `deleteSealed(key)`), because owner question Q3 (can the worker read `sealed/` by presigned GET, ADR 0014 5.1) is still open |
| Events (BE-10) | the SERVER-event writer (FACE_MISMATCH, IDENTITY_MANUAL_REVIEW) | outcome handlers write events and status only through it |
| ADR 0015 migrations | `identity_check_status` gains `WAIVED`; `video_check_*` columns | the waived row. `prisma/schema.prisma` on main had no `WAIVED` when this was written: check before coding |

**Reading the waiver.** In candidate scope `invitations.accommodations` is not readable (ADR 0013 CS-4.4). The `WAIVED` identity row is authoritative (ADR 0015 section 2): on candidate routes use the row or `AccommodationsService.projection()` (`identityCheckWaived`, derived from the row, and `disabledDetectors`). Processors in SERVICE scope may read both.

## 3. Routes and rules

Job ids use `_`, never `:` (BullMQ restriction, as in BE-07's `session-jobs.service.ts`; the ADR's `face-match:{sid}:{attempt}` becomes `face-match_{sid}_{attempt}`, `face-recheck_{name}`). Job ids never reach the worker, the logs or an alert (3.3).

**`POST /candidate/session/identity`** (ADR 0013 5.6, 5.7). Body: `{ idImageName, selfieName, livenessConfirmed }`. Never object keys from the client; keys derive from the single-use names issued to this session.
1. Guards: `CandidateSessionGuard`, candidate role, org scope from the token. State must be CONSENTED.
2. **Waiver first.** If the identity check is waived (the `WAIVED` row): 409 `IDENTITY_CHECK_WAIVED`, no worker call (ADR 0015 section 3 table; C-02, C-19), **even when the POST is a repeat**: a `WAIVED` row is attempt 1, so the idempotency step below must never answer 202 for it. `ID_IMAGE` and `SELFIE` presigns refuse the same way (BE-09 owns that refusal; add a test here too). **Race rule (ADR 0015 section 6, N3):** images may already be uploaded for these names. The handler that answers 409 first resolves the body's names to this session's issued `ID_IMAGE`/`SELFIE` names (purpose and session checked; anything else is ignored), marks them `EXPIRED`, and **deletes the originals itself** (it does not wait for the ingest-close sweep), plus any sealed copy it already made.
3. **Existing row (idempotency).** If a non-`WAIVED` row for this attempt already exists, return it (202) before validating the names: a repeated POST would otherwise hit "name already USED" (400).
4. **"Face detectors off" does NOT stop the initial match** (ADR 0015 section 3): it runs with `cacheSelfie: false`, so nothing is kept for re-checks (ADR 0014 5.3).
5. Attempt number: 1, or 2 only when attempt 1 is `LOW_CONFIDENCE` (ADR 0004 section 1, `UNIQUE (session_id, attempt)`). A third attempt: 409 `IDENTITY_ATTEMPTS_EXHAUSTED` (a new problem code: add it with the others, ADR 0011/0012).
6. Seal both images in the ADR 0013 5.6 order, **in phases across both names** so a bad second image never leaves a sealed first one with no row: (a) HEAD both originals (<= 5 MiB, `image/jpeg`; missing gives 409 `UPLOAD_NOT_FOUND` with the names left `ISSUED`; over size or not JPEG gives 400, that name becomes `EXPIRED` and its original is deleted); (b) CopyObject both to `identity/{attempt}/sealed/...` (failure gives 503 with `Retry-After`, every partial copy deleted); (c) compare-and-set both names `ISSUED -> USED` (a failed CAS: delete the sealed copies and go to the concurrent-POST rule below); (d) delete both originals. On any later failure delete the sealed copies already made.
7. Insert the `identity_checks` row (`PENDING`, `liveness_passed` as reported, keys). **A unique violation on `(session_id, attempt)` is not a 500.** Read the conflicting row outside the aborted transaction: if it is `WAIVED` the answer is 409 `IDENTITY_CHECK_WAIVED` and the sealed copies and originals are deleted (N3); if a concurrent identical POST created it, delete this request's copies and return that row (202). The same applies when step 6(c) loses its name compare-and-set to a concurrent identical POST: re-read for a row that references these names and return it, otherwise answer 400.
8. After commit, enqueue `face-match` with ids only and return 202 `{ attempt, status: "PENDING" }`. The job id is the idempotency key (CS-4.7).
9. `livenessConfirmed` is client-reported (R-05): it is stored and passed to the worker. A failed or missing liveness never rejects anyone: on attempt 1 it gives `LOW_CONFIDENCE` and a retry, on attempt 2 manual review (ADR 0004 section 1).

**`GET /candidate/session/identity`**: the latest row's `{ attempt, status }` only, plus `canRetry` when attempt 1 is `LOW_CONFIDENCE`. **Never** the score, threshold, model id or review reason to the candidate (NFR-05). The frontend polls this and copes with a 20 s or longer match (ADR 0014 section 11). A `WAIVED` row returns `status: "WAIVED"` without the reason.

**`POST /candidate/session/identity/recheck`** (ADR 0013 5.6). Body `{ evidenceKey, capturedAt }`; 202 `{ accepted: true }` with no result. Refusals (the order is a local choice except that the 429 comes first so a refused flood costs nothing): 429 over 1 per 60 s; 409 `SESSION_NOT_ACTIVE` (not IN_PROGRESS/PAUSED); 409 `IDENTITY_CHECK_WAIVED` (waiver); 409 `DETECTOR_DISABLED` (FACE in `disabledDetectors`; **owner decision C-34: either setting refuses the re-check**, and with both set the waiver code wins, ADR 0015 table row 4); 400 for an unknown, wrong-purpose or used name. **On a 409 `IDENTITY_CHECK_WAIVED` or `DETECTOR_DISABLED` the handler marks the raced name `EXPIRED` and deletes the frame original at once** (the same N3 reasoning for a biometric frame; do not wait for `evidence-expire`). Then the 5.6 steps: HEAD the original (missing: 409 `UPLOAD_NOT_FOUND`, name stays `ISSUED`; over 1 MiB or not JPEG: 400, name `EXPIRED`, original deleted), CopyObject to `evidence/sealed/` (failure: 503 with `Retry-After`, partial copy deleted, name stays `ISSUED`), compare-and-set `ISSUED -> USED{sealedKey}` (failure: delete the sealed copy, 400), delete the original, enqueue `face-recheck`. `capturedAt` is validated at the route (ISO time, not in the future beyond the skew allowance, not before the session started) and kept on the USED name record, which extends BE-09's record: list it as a BE-09 dependency (job payloads carry ids only).

## 4. Processors (ADR 0014 3.3, 3.4, 5.2, 5.3, 6.2 to 6.5)

Both are `SessionJobProcessor` jobs: payload `{ orgId, sessionId, attempt?, evidenceName? }` only. The worker request id is a fresh ULID per call, never the job id (the `face-recheck` job id contains an evidence name, which is never logged).

**Scope sequence:** step 1 read (`runAsSessionJob`), step 3 worker call with no transaction, step 4 write (`withLiveSession`); no corpus scope.
- **Step 1 stops, before any presign,** if the session is ERASED **or has a pending erasure fence (`erasure_requested_at` or `erased_at` set)**, has `RETENTION_FACE_DONE`, or the face images are already nulled (C-27, C-35). **Immediately before each presign and worker call, re-read the status and the fence** (one indexed read, ADR 0014 3.4 step 3) and stop on either: an erasure requested after step 1 must not still send biometric images to the worker. `face-recheck` deletes its sealed frame on every stop, **including an ERASED result from `withLiveSession` at step 4** (ADR 0014 5.3). `face-match` also refuses a waived session (ADR 0014 5.3), although the unique index mostly prevents it.
- `face-recheck` re-reads the waiver and `disabledDetectors` at step 1: either set means no worker call, the frame is deleted, outcome logged `SKIPPED` (C-34, ADR 0014 5.3).
- **Step 4 repeats that check.** The worker call can take up to 15 s, so inside `withLiveSession`, after `guardLive`, the outcome handler **re-reads the accommodations and the WAIVED row** (ADR 0015 section 7). If FACE was switched off, or the check waived, meanwhile, it **writes no FACE_MISMATCH**; the frame is deleted after commit. QA case: "FACE switched off while a re-check job is queued or in flight writes nothing".
- Presign `idImageUrl`/`selfieUrl`/`frameUrl` right before the call (60 s), so a re-delay never sends an expired URL. `cacheSelfie: false` always (ADR 0014 6.3, C-18: the API never sees an embedding).

**Mapping a face result to `identity_checks`** (ADR 0014 6.2, never a rejection):

| Worker response | Attempt 1 | Attempt 2 |
| --- | --- | --- |
| `MATCH` | `PASSED` | `PASSED` |
| `MANUAL_REVIEW` with BELOW_THRESHOLD, NO_FACE, MULTIPLE_FACES or LIVENESS_NOT_CONFIRMED | `LOW_CONFIDENCE` (candidate retries once) | `MANUAL_REVIEW` (candidate continues, ADR 0002 section 6) |
| `MANUAL_REVIEW` with MATCH_ERROR (including a worker timeout or an exhausted job) | `MANUAL_REVIEW` at once, no retry asked | same |

Store `face_match_score`, `model_id`, `threshold`, `review_reason` from the response (the threshold in force when scored). Writing `MANUAL_REVIEW` also writes the SERVER event `IDENTITY_MANUAL_REVIEW` in the same transaction. A `MANUAL_REVIEW` whose `reason` is null or unknown fails runtime validation and is treated as `MATCH_ERROR`.

**`verify-session`.** The identity gate is "PASSED, MANUAL_REVIEW or WAIVED" (ADR 0015 section 7), so the outcome handler (and the failed-job handler) enqueues `verify-session`, **after commit**, on **`PASSED` and on `MANUAL_REVIEW`**, never on `LOW_CONFIDENCE` (the candidate retries). The identity routes themselves do not enqueue it, except that the waiver path is BE-06's. Use the CS-4.7 scheme (fresh suffix from `INCR vs:{sid}`, debounce mode with `replace: true`), not a fixed id. CONSENTED to VERIFIED is a compare-and-set in `SessionStateService` and never waits on a human.

**Every `face-match` job must resolve the row.** Exhausted retries, an `UnrecoverableError` (a signed 400 or an unsigned 401), a bad response signature or a failed response validation would otherwise leave the row `PENDING` and the candidate stuck. The failed-job handler writes `MANUAL_REVIEW` / `MATCH_ERROR` with the `IDENTITY_MANUAL_REVIEW` event (ADR 0004 section 1, D-05: the candidate continues), **through `withLiveSession`/`guardLive` as a compare-and-set `where { sessionId, attempt, status: PENDING }`** so it never overwrites a row that resolved meanwhile, and **enqueues `verify-session` after commit exactly as the outcome handler does** (otherwise the candidate stays in CONSENTED). Cap the `WORKER_BUSY` re-delays for `face-match` too (ADR 0014 bounds only `face-recheck`, at 5 minutes waiting); after the cap, the same `MANUAL_REVIEW` path.

`face-recheck` outcome: `BELOW_THRESHOLD` writes FACE_MISMATCH (SERVER, `payload { similarity }`, `occurred_at` = the clamped `capturedAt` (5.6), `evidence_key` = the sealed key); **every other outcome deletes the sealed frame at once** (NFR-05, C-08). `ERROR` and `MATCH` write nothing. FACE_MISMATCH only adds risk weight; it never changes status.

**Retries** (ADR 0014 6.5): `face-match` 2 attempts, fixed 2 s. `face-recheck` 3 attempts, exponential from 5 s, dropped after 5 minutes waiting; the failed-job handler deletes the sealed frame.

## 5. `WorkerClient`

Signs `"CP-WORKER-V1\n" + kid + "\n" + METHOD + "\n" + path + "\n" + timestamp + "\n" + nonce + "\n" + hex(SHA-256(body))` with HMAC-SHA256 (key from `WORKER_HMAC_KEY`, id from `WORKER_HMAC_KEY_ID`). Wire details the worker enforces (`apps/worker/src/worker/signing.py`):
- The path is the **percent-decoded** path the worker's ASGI server sees; no query string.
- The signature is **base64url without padding**; the nonce is 16 random bytes as 22 unpadded base64url characters; the timestamp is ASCII digits in whole seconds (within 60 s of the worker's clock).
- Hash and send **exactly the same serialised bytes**; send no `Content-Encoding`; the body limit is 16 KiB on the face routes.
- Verify the response signature (`CP-WORKER-V1-RESP` over kid, the request nonce, status and body hash) before trusting the body, and validate responses at runtime (enums, bounds), stripping unknown fields.

**Which responses to trust (ADR 0014 6.4).** Only an **unsigned 401** is accepted as genuine, and it is `UnrecoverableError` plus an alert (key or clock misconfiguration). Every other **unsigned** response is a retryable failure plus an alert: the worker sends several before it can sign (400 for a query string, a bad Content-Length or a Content-Encoding; 413; 503 `WORKER_NOT_CONFIGURED`). Say "a **signed** 400 is `UnrecoverableError`", and honour `WORKER_BUSY` and its `Retry-After` **only on a verified signed response**, so an unsigned 503 cannot stall jobs.

**Timeouts.** Client timeouts: match 20 s, re-check 15 s (ADR 0014 6.2). The worker downloads the two images one after the other with a per-object deadline (8 s on main today, 5.5 s once follow-up PR #117 merges, plus connect and inference), so a no-cache re-check (two downloads) can take more than 16 s plus inference on main today, which is over the 15 s client timeout. **The re-check route needs #117 (5.5 s) merged first, or the ADR timeout must be amended**; size both against the benchmark. Never log bodies, URLs, scores, keys, signatures or the four `X-CP-*` headers.

## 6. Tests to ship (names carry FR/TC ids)

TC-033 (below threshold: retry once, then manual review; worker down gives `MANUAL_REVIEW`, candidate continues). TC-034 (liveness not confirmed only ever gives review; docs/test-cases.md words it "liveness check fails", so ask QA to align the wording with ADR 0004 section 1). Plus:
- waived check: 409, no worker call, originals deleted, **also on a repeat POST** (never 202 for a `WAIVED` row); waiver winning the unique-index race gives 409 (not 500) and leaves no sealed copy; a concurrent identical POST returns the existing row;
- FACE off: the initial match runs with `cacheSelfie: false`; the re-check route refuses with `DETECTOR_DISABLED`; either setting skips the job and deletes the frame; **FACE switched off while a re-check is in flight writes no FACE_MISMATCH** (the step 4 re-read);
- erasure requested between step 1 and the call: no presign, no call, and `face-recheck` deletes its frame; a failed job resolves the row once, enqueues `verify-session`, and never overwrites a resolved row; a missing second image leaves no sealed first image; a refused re-check (waived or FACE off) deletes the raced frame at once; no third attempt (409 `IDENTITY_ATTEMPTS_EXHAUSTED`); org scope (another org's session is not found); the candidate response never carries a score or reason; `RETENTION_FACE_DONE` stops before any presign; ERASED during the call writes nothing;
- `MANUAL_REVIEW` and `PASSED` enqueue `verify-session`, `LOW_CONFIDENCE` does not; exhausted retries, a signed 400, an unsigned 401, a bad response signature and a capped `WORKER_BUSY` all end in `MANUAL_REVIEW` for `face-match`;
- sealed frame deleted on every non-mismatch outcome and after the last failed retry; an unsigned 503 or 413 is retried and alerted, never honoured for `Retry-After`; log scan with sentinels finds no URL, key, score or evidence name.

## 7. Open points that can change this note

- **Q3** (`sealed/` reads by presigned GET vs worker credentials): hidden behind `IdentityMedia`.
- **Selfie cache** (ADR 0004 question 1): off; if the owner allows it, `cacheSelfie`/`cacheExpiresAt` and the evict call are already built in the worker.
- **ADR 0014** is still Proposed; **ADR 0015** `WAIVED` enum and `video_check_*` columns must be on main first.
- **Unsigned pre-authentication errors** (FU-INB-09, hub): the ADR's "only an unsigned 401 is genuine" is in tension with the 413 row; this note follows the stricter reading.
- **Capacity**: the embedding benchmark (FU-INB-16) needs about 4.0 embeddings per second at 200 candidates with no cache; one thread gives 3.6. BullMQ concurrency for `face` is 4 in the ADR; size against the benchmark before DEP-03.
- **P-13** (landmarker download) blocks any real end-to-end face test.
