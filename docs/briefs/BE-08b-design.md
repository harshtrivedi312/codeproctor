# BE-08b design notes: identity API (apps/api/src/identity)

Status: **design notes by Integrity B (identity), 2026-10-06. Not an ADR; nothing here changes a contract.** Built against ADR 0004 section 1 and 2, ADR 0013 (5.6, 5.7, 5.10, 3.3), ADR 0014 (3.3, 5.3, 6.2, 6.5) and ADR 0015 (3, 6), owner decisions C-02, C-18, C-19, C-25, C-34, and the merged worker half (BE-08a, `apps/worker`). Read the ADRs first; where this note and an ADR differ, the ADR wins. Facts below about `apps/api` come from the draft BE-07 PR (#98, `backend-cand/be-07-session`) and may change when it merges.

## 1. What is built and what is not

Worker half, merged: `POST /v1/face/match`, `/v1/face/recheck`, `/v1/face/evict`, `GET /v1/ready`, HMAC signing, fetch guard, model lock. BE-08b is the API half:

- `WorkerClient` (signing, response verification, runtime validation, timeouts, `WORKER_BUSY` handling).
- Routes: `POST /candidate/session/identity`, `GET /candidate/session/identity` (status), and the re-check route in ADR 0013 5.6 (`POST /candidate/session/identity/recheck`; the evidence presign for purpose `IDENTITY_RECHECK` is BE-09's).
- Two BullMQ processors: `face-match` and `face-recheck` (ADR 0014 3.3).
- Reviewer actions on `identity_checks` (manual decision) are BE-13; the waiver itself is BE-06 (invitation accommodations). BE-08b only reads them.

## 2. Dependencies, in the order they unblock work

| Needs | From | What BE-08b uses |
| --- | --- | --- |
| BE-07 (#98) | `CandidateSessionGuard`, `CandidateContext`, `SessionStateService`, `session-write-gate`, `ObjectStoragePort`, queue plumbing (`session-jobs.service.ts`) | session identity for every route; the CONSENTED to VERIFIED transition; the existing queue setup to copy, not to fork |
| BE-09 | `StorageService`: single-use names (5.2 state machine), presign for `ID_IMAGE` and `SELFIE` (<= 5 MiB, state CONSENTED), HEAD, CopyObject to `sealed/`, `presignGetForWorker(key, ttl)` (60 s for face) | everything that touches an image. **Until BE-09 lands, build against an interface** (`IdentityMedia`: `sealPair(names) -> {idKey, selfieKey}`, `presignForWorker(key) -> url`, `deleteSealed(key)`), because owner question Q3 (can the worker read `sealed/` by presigned GET, ADR 0014 5.1) is still open |
| BE-10 / events | the SERVER-event writer (FACE_MISMATCH, IDENTITY_MANUAL_REVIEW) in `withLiveSession`, and `SessionJobProcessor` | the outcome handlers write events and status only through it |
| ADR 0015 migrations | `identity_check_status` gains `WAIVED`; `video_check_*` columns | the waived row; check the Prisma enum before coding (`prisma/schema.prisma` on main had no `WAIVED` when this was written) |

## 3. Routes and rules

**`POST /candidate/session/identity`** (ADR 0013 3.3, 5.6, 5.7). Body: `{ idImageName, selfieName, livenessConfirmed }`. Never object keys from the client; keys derive from the single-use names issued to this session.
1. Guards: `CandidateSessionGuard`, role check (candidate), org scope from the token. State must be CONSENTED.
2. **Waiver first.** If the identity check is waived (`accommodations.identityCheckWaiver` or a `WAIVED` row): 409 `IDENTITY_CHECK_WAIVED`, no images touched, no worker call (ADR 0015 section 3 table; C-02, C-19). `ID_IMAGE` and `SELFIE` presigns refuse the same way (BE-09 owns that refusal; add a test here too).
3. **"Face detectors off" does NOT stop the initial match** (ADR 0015 section 3): the match runs, with `cacheSelfie: false`, so nothing is kept for re-checks (ADR 0014 5.3).
4. Attempt number: 1, or 2 only when attempt 1 is `LOW_CONFIDENCE` (ADR 0004 section 1, `UNIQUE (session_id, attempt)`). A third attempt: 409.
5. Seal both images (copy to `identity/{attempt}/sealed/...`, mark names USED, delete originals) in the ADR 0013 5.6 order, then insert the `identity_checks` row (`PENDING`, `liveness_passed` as reported, keys) and enqueue `face-match` with ids only. Return 202 with `{ attempt, status: "PENDING" }`. Job id `face-match:{sessionId}:{attempt}` is the idempotency key (CS-4.7); a duplicate POST for the same attempt returns the existing row.
6. `livenessConfirmed` is client-reported (R-05): it is stored, passed to the worker, and can only lead to manual review, never to a rejection.

**`GET /candidate/session/identity`**: the latest row's `{ attempt, status }` only, plus a retry hint (`canRetry`) when attempt 1 is `LOW_CONFIDENCE`. **Never** the score, threshold, model id or review reason to the candidate (NFR-05; the frontend polls this and copes with a 20 s or longer match, ADR 0014 section 11). A `WAIVED` row returns `status: "WAIVED"` without the reason.

**`POST /candidate/session/identity/recheck`** (ADR 0013 5.6): 202 `{ accepted: true }` with no result. Refusals, in this order: 409 `SESSION_NOT_ACTIVE` (not IN_PROGRESS/PAUSED), 409 `IDENTITY_CHECK_WAIVED` (waiver), 409 `DETECTOR_DISABLED` (FACE in `disabledDetectors`; **owner decision C-34: either setting refuses the re-check**), 400 for an unknown, wrong-purpose or used name, 429 over 1 per 60 s. The frame is sealed, then `face-recheck:{name}` is enqueued (ADR 0014 3.3).

## 4. Processors (ADR 0014 3.3, 5.2, 5.3, 6.2 to 6.5)

Both are `SessionJobProcessor` jobs: payload `{ orgId, sessionId, attempt? , evidenceName? }` only. A request id for the worker is a fresh ULID per call, never the job id (the `face-recheck` job id contains an evidence name, which is never logged).

**Step 1 (read, `runAsSessionJob`)**, then **step 3 (worker call, no transaction)**, then **step 4 (`withLiveSession` write)**; `face-match` and `face-recheck` use no corpus scope (ADR 0014 3.4).
- Stop before any presign if the session is ERASED, has `RETENTION_FACE_DONE`, or the face images are already nulled (C-27, C-35). `face-recheck` deletes its sealed frame on every stop.
- `face-recheck` re-reads the accommodations and the identity row at step 1: with the waiver or FACE off it calls no worker, deletes the frame, logs outcome `SKIPPED` (C-34, ADR 0014 5.3).
- Presign `idImageUrl`/`selfieUrl` right before the call (60 s), so a re-delay on `WORKER_BUSY` never sends an expired URL.
- `cacheSelfie: false` always (ADR 0014 6.3, C-18: embeddings never stored; the API never sees one).

**Mapping a face result to `identity_checks`** (ADR 0014 6.2, never a rejection):

| Worker response | Attempt 1 | Attempt 2 |
| --- | --- | --- |
| `MATCH` | `PASSED` | `PASSED` |
| `MANUAL_REVIEW` with BELOW_THRESHOLD, NO_FACE, MULTIPLE_FACES or LIVENESS_NOT_CONFIRMED | `LOW_CONFIDENCE` (candidate retries once) | `MANUAL_REVIEW` (candidate continues, ADR 0002 section 6) |
| `MANUAL_REVIEW` with MATCH_ERROR (including worker timeout or exhausted job) | `MANUAL_REVIEW` at once, no retry asked | same |

Store `face_match_score`, `model_id`, `threshold`, `review_reason` from the response (the threshold in force when scored). Writing `MANUAL_REVIEW` also writes the SERVER event `IDENTITY_MANUAL_REVIEW` in the same transaction. Passing the check enqueues `verify-session` (CONSENTED to VERIFIED is a compare-and-set in `SessionStateService`, ADR 0013 section 3.3), and the transition never waits on a human.

`face-recheck` outcome: `BELOW_THRESHOLD` writes FACE_MISMATCH (SERVER, `payload { similarity }`, `evidence_key` = the sealed key); **every other outcome deletes the sealed frame at once** (NFR-05, C-08). `ERROR` and `MATCH` write nothing. FACE_MISMATCH only adds risk weight; it never changes status.

**Retries** (ADR 0014 6.5): `face-match` 2 attempts, fixed 2 s; after the last, `MATCH_ERROR` becomes `MANUAL_REVIEW`. `face-recheck` 3 attempts, exponential from 5 s, dropped after 5 minutes waiting; the failed-job handler deletes the sealed frame. `WORKER_BUSY` (503 with Retry-After) re-delays without using an attempt (`moveToDelayed` plus `DelayedError`). A 400 or an unsigned 401 from the worker is `UnrecoverableError` plus an alert (key or clock misconfiguration).

## 5. `WorkerClient`

Signs `"CP-WORKER-V1\n" + kid + "\n" + METHOD + "\n" + path + "\n" + timestamp + "\n" + nonce + "\n" + hex(SHA-256(body))` with HMAC-SHA256 (key from `WORKER_HMAC_KEY`, id from `WORKER_HMAC_KEY_ID`); path is the **percent-decoded** path the worker's ASGI server sees; no query string; nonce 16 random bytes base64url; timestamp in whole seconds. Verifies the response signature (`CP-WORKER-V1-RESP`, over kid, the request nonce, status and body hash) before trusting the body; a bad or wrong-kid signature on a signed response is a retryable failure plus an alert; an **unsigned 401** is not retryable. Validates responses at runtime (enums, bounds), stripping unknown fields. Timeouts: match 20 s, re-check 15 s (the worker downloads within 5.5 s per image). Never logs bodies, URLs, scores, keys, signatures or the four `X-CP-*` headers.

## 6. Tests to ship (names carry FR/TC ids)

TC-033 (below threshold: retry once, then manual review; worker down gives `MANUAL_REVIEW`, candidate continues), TC-034 (liveness not confirmed only ever gives review), plus: waived check gives 409 and no worker call; FACE off still runs the initial match with `cacheSelfie: false` and refuses the re-check; either setting refuses the re-check route and skips the job and deletes the frame; no third attempt; duplicate POST is idempotent; org scope (another org's session is not found); candidate response never carries score or reason; `RETENTION_FACE_DONE` stops before any presign; ERASED during the call writes nothing; sealed frame deleted on every non-mismatch outcome and after the last failed retry; response signature failure is retried and alerted; an unsigned 401 is not retried; log scan with sentinels finds no URL, key, score or evidence name.

## 7. Open points that can change this note

- **Q3** (`sealed/` reads by presigned GET vs worker credentials): hidden behind `IdentityMedia`.
- **Selfie cache** (ADR 0004 question 1): off; if the owner allows it, `cacheSelfie`/`cacheExpiresAt` and the evict call are already built in the worker.
- **ADR 0014** is still Proposed; **ADR 0015** `WAIVED` enum and `video_check_*` columns must be on main first.
- **Capacity**: the embedding benchmark (FU-INB-16) needs about 4.0 embeddings per second at 200 candidates with no cache; one thread gives 3.6. BullMQ concurrency for `face` is 4 in the ADR; size against the benchmark before DEP-03.
- **P-13** (landmarker download) blocks any real end-to-end face test.
