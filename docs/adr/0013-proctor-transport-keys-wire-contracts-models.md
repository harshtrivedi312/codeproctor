# ADR 0013: Proctor transport: HMAC key lifecycle, wire contracts and model files (ARC-03 part 1)

| Field | Value |
| --- | --- |
| Status | **Proposed** 2026-10-05. The owner accepts or amends. Items marked **(architect detail, owner to confirm)** are not owner decisions; section 9 lists the questions. |
| Author | architecture hub |
| Decides | OI-3 (key lifecycle, canonical JSON, threat model), OI-9 (key layout, segment reassembly rules), the key half of OI-10, the ARC-03 items ADR 0010 "Leaves to", and every "Open for the architecture hub" item in docs/followups/proctor-sdk.md |
| Serves | FR-403, FR-601, FR-604, FR-605, FR-606, FR-607, FR-609, FR-610, FR-701, FR-702, FR-704, FR-801; NFR-01, NFR-02, NFR-04, NFR-05, NFR-08; TC-008, TC-050, TC-056, TC-058, TC-059, TC-063, TC-065, TC-070, TC-072 |
| Builds on | ADR 0001 (TB-1, TB-3, C-4, C-5, ST-1..ST-8, section 12 and F-3), ADR 0002 §3 option (a) and L-2, ADR 0004 (§1, §2, §4, R-4, R-6), ADR 0005 §3, ADR 0010 (not contradicted; proposed amendments in section 7) |
| Leaves to | ARC-03 part 2: candidate token lifetime, storage and binding (OI-4, token half of OI-10, OI-11) and STRICT side-camera device auth. ARC-02 part 2: copying these rows into api-contract.md and fsd.md §4 (PRs #29, #31, #33 are in flight, so the tables live here until then). ARC-04: worker job interface, `analyze-session` delay, worker model lock. ARC-05: bucket settings, CORS, access-log restriction. |

Paths are under `/api/v1`. Errors are RFC 7807 with the `code` extension (ADR 0011 / api-contract.md, PR #31); the `code` values below are new. Once a route is built, the generated OpenAPI becomes its source of truth (ADR 0012, proposed); this ADR remains the record of the rules.

## 1. Context

The SDK (FE-06..FE-08, merged) signs event batches, uploads media and evidence, and re-checks identity against API contracts that only exist as assumptions in its code. BE-07, BE-09, BE-10 and BE-12 cannot start without them. Two open security questions sit underneath: how the per-session key reaches the browser and is rotated, and whether a tampered client can drop a FACE_MISMATCH. The model files also have no storage plan, and one of them (COCO-SSD weights, F-3) has no stated licence.

## 2. HMAC key lifecycle and signed batches (decision 1)

**Key material** (architect detail, owner to confirm the env names).
- At VERIFIED → IN_PROGRESS, BE-07 generates a 32-byte master key `M` (CSPRNG). It stores `M` in `sessions.hmac_key_enc` as `v1:<kid>:<b64 nonce>:<b64 ciphertext+tag>`, encrypted with AES-256-GCM.
  - **AAD = session id**, so a ciphertext copied to another row does not decrypt.
  - `kid` names the wrapping key `SESSION_KEY_ENC_KEY_<kid>`. New rows use `SESSION_KEY_ENC_ACTIVE_KID`, and older kids stay configured until their rows are destroyed. This lets the env key rotate without a migration.
- The browser never receives `M`. For each `sessions.auth_epoch` value `e` (ADR 0002 L-2), the batch key is `K_e = HMAC-SHA256(M, UTF-8("codeproctor:batch-key:v1:" + sessionId + ":" + e))`.
  - `sessionId` is the canonical lowercase UUID with hyphens.
  - `e` is decimal ASCII with no leading zeros.
  - Derivation is deterministic, so there is no extra storage and no schema change.

**Delivery: once per epoch, kept as a non-extractable CryptoKey.**
- `POST /candidate/session/proctor-key` (section 4) returns `K_e` for the token's epoch, **once**.
  - A Redis `SET NX` on `pkey:{sessionId}:{e}` blocks a second issue (409 `KEY_ALREADY_ISSUED`). Its TTL lasts until `deadline_at` + ingest grace + 1 h.
  - **Fail-open risk, recorded.** If Redis loses the marker (flush, failover without persistence), the key can be issued again to whoever holds the token for that epoch. For that window the HMAC is no stronger than the token.
  - A durable marker (for example `sessions.hmac_key_issued_epoch int`) would close the gap. It is a schema change and needs its own ADR, so it is **flagged, not decided** (Q12).
  - The frontend calls the route after the start-test call succeeds and after each OTP resume, because both points start a key context that has not been issued yet.
- The SDK imports the key with `extractable: false` and stores the `CryptoKey` object in IndexedDB as `{sessionId}:hmacKey` together with its epoch. Chrome and Edge (NFR-07) can structured-clone CryptoKeys.
  - A reload on the same epoch loads the key from IndexedDB.
  - **This ADR is the permission OI-10 and the code-reviewer privacy rule (D-07) require for a key in the FR-702 IndexedDB buffer.** No other secret may be stored there; the candidate token stays with ARC-03 part 2.
  - `extractable: false` only stops page JS from reading the bytes. Malware or anyone with access to the browser profile on disk can still recover the key.
- **Purge.** The SDK deletes the key and the outbox at finish, on 409 `SESSION_NOT_ACTIVE`, and on 401 `SESSION_TAKEN_OVER` (section 5.2).
- **Missing key.** The frontend checks IndexedDB first. If the key is absent (IndexedDB cleared, response lost), it runs the OTP resume (ADR 0002 L-2), which raises the epoch, and then fetches a new key. The clock keeps running.
  - The check-then-fetch sequence runs inside a Web Lock (`navigator.locks.request("cp-key:" + sessionId)`), so two tabs cannot each trigger an OTP and thrash the epoch.
- The key is never logged, never put in a URL, never written to localStorage or sessionStorage, and never sent to error tracking. The response carries `Cache-Control: no-store`.

**Rotation and revocation.**
- Each OTP success raises `auth_epoch`, which kills the old device's token (ADR 0002). New batches must be signed with `K_current`.
- **Same device, new epoch.** The SDK re-signs its unsent outbox with the new key. It stores the exact body, so only the signature changes.
- **Different device.** Batches still queued on the old device are lost: its token is dead, and it purges on `SESSION_TAKEN_OVER`. Server-side gap detection (section 5.8) shows the hole to the reviewer.
- **Ingest close.** Ingestion closes at `submitted_at + PROCTOR_INGEST_GRACE_SECONDS` (default 300). A job then sets `hmac_key_enc = NULL` (key destruction) and runs the storage sweep (section 5.7). After that, stored signatures cannot be re-verified, which is acceptable because they serve idempotency only. **(architect detail, owner to confirm; ARC-04 delays `analyze-session` by the same grace.)**
- **Erasure (R-6) of a live session** also nulls `hmac_key_enc` and deletes the `pkey:` markers.

**Canonical JSON and transport: the SDK's scheme is confirmed.**
- Signed string `S = canonicalJson({ seq, events })` for events, and `canonicalJson({ seq, sessionQuestionId, startedAt, events })` for keystrokes (the ADR 0010 batch shapes, unchanged). Canonical means RFC 8785 (JCS) as the SDK implements it: object keys sorted by UTF-16 code units, no whitespace, ECMAScript number and string serialisation, `undefined` members dropped, non-finite numbers refused, UTF-8 bytes.
- The request body **is** `S` byte for byte. `X-Signature` = lowercase hex HMAC-SHA256(`K_e`, UTF-8 bytes of `S`), exactly 64 characters `[0-9a-f]`. No signature field in the body, no request `Content-Encoding` (415).
- **The server verifies the received bytes, never a re-serialisation.** Canonical form only makes signatures reproducible for other clients and for tests (k6, QA). The server does not check that a body is canonical.

**Verification order (BE-10, both batch routes).** Use a raw-body parser on these two routes only.
1. Authenticate the candidate token, then check the epoch (401).
2. Check state (409 `SESSION_NOT_ACTIVE`): IN_PROGRESS, PAUSED, or SUBMITTED within the grace.
3. Enforce the size limit **while streaming**: 413 above 256 KiB (`MAX_EVENT_BATCH_BODY_BYTES`) for events, 2 MiB (`MAX_KEYSTROKE_BATCH_BODY_BYTES`) for keystrokes.
4. Check the `X-Signature` format, then compare in constant time (`timingSafeEqual`) with `HMAC(K_current, rawBytes)`. On a mismatch:
   - if the signature matches one of the previous 8 epoch keys (the **epoch window**), return 409 `KEY_EPOCH_STALE`, and the SDK re-signs;
   - otherwise return 403 `SIGNATURE_INVALID` (TC-065).
5. Decode as strict UTF-8, then `JSON.parse`, then the shared zod schema. Each failure is a 400 `VALIDATION_FAILED` whose errors never echo values.
6. In one transaction, insert the batch row (`proctor_event_batches` or `keystroke_batches`) and its events. On a `(session_id, seq)` conflict, run the duplicate check:
   - (a) If the received signature equals the stored one (constant time), this is a retry: return 200 with `duplicate: true` and store nothing.
   - (b) Otherwise, for each `e` in the epoch window (current and the previous 8), recompute HMAC(`K_e`, rawBytes) and compare it with the stored signature. A match is a re-signed retry: return 200 with `duplicate: true`.
   - (c) Otherwise return 409 `SEQ_CONFLICT` (TC-065).

   Because the keys are derived, no per-batch epoch column is needed.

Derived keys may be cached in process, keyed by `(sessionId, epoch)`, with a 60-second TTL. That avoids an AES decrypt per request (NFR-01).

**Sequence numbers across devices.** `seq` is unique per session, while a new device starts with empty IndexedDB, so a fresh counter would collide with stored batches (409 or silent loss). The `proctor-key` response therefore returns `counters`, and the SDK starts each counter at `max(local, server)`:
- `eventSeqStart` and `keystrokeSeqStart`: the stored maximum + 1;
- per media stream, `nextSeq` and `nextSegment`.

**What the key protects and what it does not (R-04, TB-1).**

| Protects against | Does not protect against |
| --- | --- |
| Forgery or modification of a batch by anyone without the key, including someone who has only the candidate token. The key is issued once per epoch and is non-extractable, so it is more than the token, except while the Redis marker is lost (fail-open, above). | The candidate. The key lives in their browser, so a modified SDK can sign anything, suppress events or fake timestamps. Server re-checks and human review compensate (ADR 0001 §7). |
| Replay: an identical replay is a no-op, a modified replay is rejected (TC-065), a batch from another session fails (per-session key), and keys from older epochs cannot sign new batches | XSS on the candidate origin, which can sign through the live CryptoKey while it runs (it cannot export the key). The strict CSP is the control. |
| Undetected loss: a dropped or suppressed signed batch leaves a hole in `seq` on `proctor_event_batches` or `keystroke_batches`, which the review shows (section 5.8). The loss is detected, not prevented. | Later re-verification of stored rows. Events are stored parsed and stripped (ADR 0010), so the signature only serves idempotency. Evidential integrity comes from the append-only audit log and access control, not from the HMAC. |

## 3. Events before the key exists (decision 2)

Decision: **unsigned, token-authenticated, advisory input, flagged as unsigned**. This confirms ADR 0002 §3 option (a); no key is issued earlier.
- The system-check page runs the SDK's `checkMultiScreen` and `checkVirtualCamera` and sends the result to `POST /candidate/session/system-check` (section 5.4).
- The server stores each MULTI_MONITOR or VIRTUAL_CAMERA finding as a `proctor_events` row with `source = CLIENT` and `batch_seq IS NULL`.
  - That combination is the "unsigned, pre-start" marker. `batch_seq` is already nullable (database.md `proctor_events`), so no schema change is needed; only the column comment and ADR 0005 §3 wording change (section 7).
  - **Invariant test (BE-10):** every CLIENT row written by the batch route has a non-null `batch_seq`, so the system-check route is the only writer of CLIENT rows without one.
  - The review UI labels these rows "System check (unsigned)".
  - `occurred_at` is clamped to `[consents.signed_at, server now]`, because no `started_at` exists yet.
- They are on the timeline but **not scored** by default. A candidate told to unplug a monitor must not carry 20 points for complying. **(owner to confirm, Q3)**
- **Server-side gates (FR-605, TC-056; matches ADR 0002 §2).**
  - CONSENTED → VERIFIED requires a passed system check (no blocking finding), as ADR 0002 §2 requires.
  - The start-test call (VERIFIED → IN_PROGRESS) checks again, and refuses with 409 `SYSTEM_CHECK_BLOCKED` if the latest check has a blocking finding or is older than 15 minutes **(architect detail)**.
  - The gates prove that a check ran; they cannot prove that its result is true.
- **Re-checks.** At IN_PROGRESS the SDK runs the same monitors again inside the signed session, immediately and on `screenschange` and `devicechange`. A clean pre-check followed by a signed MULTI_MONITOR at t≈0 is visible to the reviewer.
  - The server compares the `Sec-CH-UA` brand with the reported browser and records a mismatch in `device_info.systemCheck.uaMismatch` (advisory, never a block).
  - No server-side check can see monitors or camera device names.

## 4. Key route

| Item | Contract |
| --- | --- |
| Route | `POST /candidate/session/proctor-key`, no body |
| Auth | Candidate token; epoch must equal `sessions.auth_epoch`; org scope through the session |
| States | IN_PROGRESS, PAUSED; otherwise 409 `SESSION_NOT_ACTIVE` with extension `status` |
| 200 | `{ alg: "HMAC-SHA256", key: <base64, 32 bytes>, keyEpoch: int, counters: { eventSeqStart, keystrokeSeqStart, media: { SCREEN \| WEBCAM \| AUDIO: { nextSeq, nextSegment } } } }`, `Cache-Control: no-store` |
| Errors | 401; 409 `KEY_ALREADY_ISSUED` (same epoch, already issued: the client re-runs the OTP resume); 409 `SESSION_NOT_ACTIVE`; 429 |
| Limit | 5 per minute per session |

## 5. Wire contracts (decision 3)

### 5.1 Common rules

- **Auth.** `Authorization: Bearer <candidate token>` on every route here. The session and org come from the token, never from the URL or body (section 5.10). A body that names a session id is ignored (stripped).
- **Rate limits.** Per session in Redis (`rl:{route}:{sessionId}`), returning 429 with `Retry-After`. The per-IP candidate throttle (FU-BE-18, 30 per minute per IP) must not apply to these routes: a test centre puts many candidates behind one NAT. **(architect detail)**
- **Body limits.** Non-batch JSON bodies are capped at 16 KiB (413).
- **Never logged** (C-5, R-8): bodies of `/candidate/*`, presigned URLs, object keys, evidence names, signatures, keys.
  - API logs carry session id, route, stream, seq and outcome only.
  - The web app and the SDK never `console.log` a URL; error tracking scrubs breadcrumbs for the storage hosts and `/candidate/session/*` bodies.
  - Bucket access logs, if enabled (ARC-05), are restricted like the media itself.

### 5.2 Batches

| Item | Events | Keystrokes |
| --- | --- | --- |
| Route | `POST /candidate/session/events` | `POST /candidate/session/keystrokes` |
| Headers | `Content-Type: application/json` (415 otherwise), `X-Signature` | same |
| Body | exact signed `S`, ≤ 256 KiB | exact signed `S`, ≤ 2 MiB |
| 200 | `{ seq, duplicate: boolean }` | same |
| Errors | 400 `VALIDATION_FAILED`, 401, 403 `SIGNATURE_INVALID`, 409 `KEY_EPOCH_STALE` / `SEQ_CONFLICT` / `SESSION_NOT_ACTIVE`, 413, 415, 429 | same |
| Limit | 120 per minute per session (an outage flush needs bursts) | 240 per minute |

- **401 codes (all candidate routes).**
  - `TOKEN_EXPIRED`: the token's `exp` has passed.
  - `SESSION_TAKEN_OVER`: the token's epoch is below `sessions.auth_epoch`, because another device passed the OTP.
  - Any other 401 carries no code.
- **SDK mapping.**
  - 2xx: OK.
  - 408, 429, 5xx and network errors: retry with capped backoff.
  - 401 `TOKEN_EXPIRED`: ask the app for a fresh token and retry. After 3 consecutive 401s, stop and raise `reauthRequired`; never retry forever.
  - 401 `SESSION_TAKEN_OVER`: stop, purge the key and outbox, and raise `reauthRequired`. Queued batches on this device are lost.
  - `KEY_EPOCH_STALE`: re-sign, then retry.
  - `SESSION_NOT_ACTIVE`: stop and purge.
  - 400, 403, `SEQ_CONFLICT`, 413, 415: drop the batch and count it in `getQueueStats().rejected`; never silently.
- **Evidence references.** `evidenceKey` in an event is the **session-relative name** returned by evidence presign (`evidence/<ULID>.jpg`), which matches the ADR 0010 regex. The server stores the full key (section 5.7) in `proctor_events.evidence_key`.
  - **Names are single-purpose and single-use.** The Redis hash `evidence:{sessionId}` maps each name to `{ purpose, state: ISSUED | USED }`. Its TTL lasts until `deadline_at` + grace + 1 h.
  - An event may reference only an `EVENT` name in state `ISSUED`, which the reference marks `USED`.
  - An unknown, wrong-purpose or already-used name is dropped from that event (`evidence_key` NULL), and the batch still succeeds.
  - Another session's object can never be referenced, because the prefix comes from the token.
- **Timestamps.** `occurredAt` is clamped to `[sessions.started_at, server now]` (TB-1).

### 5.3 Heartbeat (FR-609; new fsd.md §4 row)

| Item | Contract |
| --- | --- |
| Route | `POST /candidate/session/heartbeat` every 10 s, unsigned |
| Body (optional) | `{ capabilities?: CapabilityFlag[] (≤ 32, only when changed), recorder?: { streams: [{ stream, segment, lastSeq, bufferedChunks, bufferedBytes, droppedChunks, droppedBytes }] }, queue?: { pendingEventBatches, pendingKeystrokeBatches, rejectedBatches } }` |
| 200 | `{ serverTime, status: "IN_PROGRESS" \| "PAUSED", deadlineAt, sectionDeadlineAt \| null, pauseReasons: [] }`, plus a renewed token field if ARC-03 part 2 keeps refresh-by-heartbeat (backend.md Step 7) |
| Errors | 401; 409 `SESSION_NOT_ACTIVE` with `status` (the SDK stops the heartbeat and fires an `ended` event instead of reporting "offline"); 429 |
| Limit | 12 per minute per session |

Server behaviour:
- Each beat sets `last_heartbeat = now()` with one UPDATE by primary key. About 20 writes per second at 200 candidates; target p95 below 50 ms.
- If a DISCONNECTED was logged since the last beat (Redis flag), the beat writes RECONNECTED (SERVER).
- A repeatable job every 15 s writes DISCONNECTED `{ lastHeartbeatAt }` for IN_PROGRESS and PAUSED sessions silent for more than 60 s (FR-609).
  - **Flag for QA and the owner:** TC-063 drops the network for 45 s yet expects DISCONNECTED, while FR-609 sets the threshold at 60 s, so a 45 s drop logs nothing. Either TC-063 uses more than 60 s or FR-609 changes (Q13; QA already noted it in docs/followups/qa.md).
- `recorder` and `queue` go to Redis `rec:{sessionId}`. The final snapshot is copied to `device_info.recorder` at SUBMITTED.
- The proctor push channel (OI-2, Q-20) is not decided here.

### 5.4 System check (pre-start, unsigned; section 3)

| Item | Contract |
| --- | --- |
| Route | `POST /candidate/session/system-check` |
| States | CONSENTED, VERIFIED |
| Body | `{ browser: { brand, majorVersion }, network?: { downlinkKbps, rttMs }, devices: { camera: bool, microphone: bool, screenShare: "MONITOR" \| "OTHER" \| "UNVERIFIABLE" }, findings: [{ type: "MULTI_MONITOR" \| "VIRTUAL_CAMERA", occurredAt, payload }] (0..4; payload validated by the shared payload schema for that type), capabilities: CapabilityFlag[] (≤ 32) }` |
| 200 | `{ passed: bool, blocking: ("MULTI_MONITOR" \| "BROWSER_UNSUPPORTED" \| "SCREEN_SHARE_NOT_MONITOR" \| "DEVICE_MISSING")[] }` |
| Effects | `device_info.systemCheck` holds the latest result with server time; capabilities are merged; findings that differ from the previous check become unsigned event rows |
| Errors | 400, 401, 409 `SESSION_NOT_ACTIVE`, 429 |
| Limit | 10 per minute, 50 per session |

VIRTUAL_CAMERA is logged but does not block (FR-610); MULTI_MONITOR blocks (FR-605).

### 5.5 Media presign and confirm (FR-701, FR-702)

| Item | Presign | Confirm |
| --- | --- | --- |
| Route | `POST /candidate/session/media/presign` | `POST /candidate/session/media/confirm` |
| Body | `{ stream, segment, seq, bytes, contentType, startedAt, durationMs }` | `{ stream, segment, seq }` |
| Rules | `stream` is SCREEN, WEBCAM, AUDIO or ROOM_SCAN; SIDE_CAMERA waits for ARC-03 part 2. `segment` 0..9,999; `seq` 0..99,999,999 (both fit the key padding in 5.7). `contentType` is exactly `video/webm` or `audio/webm`, with no codecs parameter, so the signed header matches. `bytes` 1..16 MiB (AUDIO 4 MiB). `durationMs` 1..60,000. `startedAt` is clamped. Per session, at most `ceil(duration / 10 s) × 1.5 + 50` presigns per stream. | — |
| States | ROOM_SCAN: CONSENTED. Other streams: IN_PROGRESS, PAUSED, or SUBMITTED within the grace. | same |
| 200 | `{ url, method: "PUT", headers: { "Content-Type": ..., "If-None-Match"?: "*" }, expiresAt }`, valid 60 s, with Content-Type and Content-Length signed (ST-2, ST-3); or `{ alreadyUploaded: true }` once confirmed (no new URL is ever issued for a confirmed chunk) | `{ uploaded: true, sizeBytes }`, idempotent |
| Errors | 400; 409 `SEQ_CONFLICT` (seq exists with another segment); 409 `SESSION_NOT_ACTIVE`; 429 | 404 `CHUNK_NOT_PRESIGNED`; 409 `UPLOAD_NOT_FOUND` (HEAD 404: upload again, presigning again if expired); 422 `UPLOAD_MISMATCH` (HEAD size or type differs: the server deletes the object, the row stays pending, the client presigns again) |
| Limit | 60 per minute per stream | same |

- **Rows.** Presign upserts `media_chunks (stream, segment, seq)` as pending. Confirm HEADs the object and checks its size against the declared `bytes`, the stream maximum and the content type. It then sets `uploaded_at` and `size_bytes`, and records the ETag.
- **Upload size and integrity (ADR 0001 ST-3: whether R2 and S3 enforce a signed Content-Length is not verified).** No single control enforces size, so four controls are layered:
  1. **Confirm HEAD** rejects a wrong size or type (422) and deletes the object.
  2. **ETag at confirm.** `media_chunks` has no ETag column, so the ETag is kept in the Redis hash `etag:{sessionId}` until the sweep. If Redis loses it, the sweep falls back to the size check alone. A durable `media_chunks.etag` column would be a schema change needing its own ADR (flagged, Q12).
  3. **`If-None-Match: *` signed on the PUT**, so a second PUT to the same key fails with 412 instead of replacing it.
     - AWS S3 supports conditional writes on PutObject. R2 support and presigned-header behaviour on both stores are **not verified**: the BE-09 spike checks them. Where unsupported, the header is omitted and control 4 alone catches replacement.
     - The SDK treats 412 as "already stored" and goes on to confirm.
  4. **Ingest-close sweep** (section 5.7). It deletes any object whose size or ETag differs from the confirm record, and oversize objects.
  - **Remaining exposure.** Until the sweep runs, a client holding a 60-second URL may store an oversize object or overwrite a confirmed chunk (where control 3 is unavailable). The rate limits and per-session presign caps bound how many URLs exist.
- **Segments (OI-9, ADR 0004 §4).**
  - A recorder restart starts a new segment, and the segment's lowest seq carries the WebM header.
  - The SDK uploads a segment's first chunk first. Its drop-oldest overflow policy must never drop a segment's first chunk: dropping it makes the whole segment unplayable.
  - Playback (FE-11) and the worker (BE-12) concatenate bytes per (stream, segment) in seq order. A missing middle chunk is skipped: decoding resumes at the next cluster. QA tests this with a synthetic hole.
- **Gaps and drops.**
  - Server truth is seq holes in `media_chunks` plus missing trailing chunks (the heartbeat's `lastSeq` above the highest uploaded seq).
  - The SDK's `droppedChunks` and `droppedBytes` arrive through the heartbeat as context.
  - BE-13 shows both in a "Recording gaps" panel. No event type is added; whether gaps should be scored is owner question Q6.

### 5.6 Evidence presign and identity re-check (FR-606; server-written FACE_MISMATCH)

| Item | Evidence presign | Identity re-check |
| --- | --- | --- |
| Route | `POST /candidate/session/evidence/presign` | `POST /candidate/session/identity/recheck` |
| Body | `{ purpose: "EVENT" \| "IDENTITY_RECHECK", contentType: "image/jpeg", bytes: 1..1 MiB }` | `{ evidenceKey: <name issued with purpose IDENTITY_RECHECK>, capturedAt }` |
| States | IN_PROGRESS, PAUSED. Purpose `IDENTITY_RECHECK` is refused with 409 `DETECTOR_DISABLED` when FACE is disabled by accommodation (FR-305) | IN_PROGRESS, PAUSED; 409 `DETECTOR_DISABLED` when FACE is disabled |
| 200 / 202 | 200 `{ url, method: "PUT", headers, evidenceKey: "evidence/<ULID>.jpg", expiresAt }` | **202 `{ accepted: true }`. No match result is returned to the browser.** |
| Errors | 400; 409 `SESSION_NOT_ACTIVE` / `DETECTOR_DISABLED` / `QUOTA_EXCEEDED`; 429 | 400 (unknown, wrong-purpose or already-used name), 409, 429 |
| Limit | 20 per minute. Per session at most 300 `EVENT` names and `duration_minutes + 10` `IDENTITY_RECHECK` names (409 `QUOTA_EXCEEDED`) **(architect detail)** | 1 per 60 s (SDK interval 120 s) |

**Decision: the server writes the re-check outcome itself.**
- **Names.** The re-check accepts only an `IDENTITY_RECHECK` name in state `ISSUED` and marks it `USED` (5.2). The API then enqueues `face-recheck` on the face-match queue, at a lower priority than initial checks.
- **Worker.**
  - It HEADs the frame first and refuses (outcome ERROR) anything over 1 MiB or not `image/jpeg`.
  - It reads the JPEG header and refuses anything over 1920 × 1920 pixels before decoding (decompression-bomb guard).
  - It compares the frame with the selfie of the latest identity attempt (cached embedding, ADR 0004 §2) and returns `{ outcome: MATCH | BELOW_THRESHOLD | NO_FACE | MULTIPLE_FACES | ERROR, score, modelId, threshold }`.
- **Outcome.** On BELOW_THRESHOLD, the API writes FACE_MISMATCH with `source = SERVER`, `occurred_at` = the clamped `capturedAt`, `payload { similarity }` and `evidence_key` = the frame. **Every other outcome deletes the frame at once (NFR-05).**
- **Frames are deleted unless a FACE_MISMATCH references them.** This is what makes the consent premise in Q4 true. Three paths do it:
  - the outcome handler deletes on any outcome other than BELOW_THRESHOLD, including ERROR, and the BullMQ failed-job handler deletes after the last retry;
  - a delayed `evidence-expire` job, enqueued at presign for +10 minutes, deletes the object if its name is still `ISSUED` (never sent to `/identity/recheck`), or is `USED` for a re-check with no FACE_MISMATCH row and no job still running;
  - the ingest-close sweep (5.7) deletes any `IDENTITY_RECHECK` object that no FACE_MISMATCH row references.
  - **Bound:** an unreferenced frame lives at most about 10 minutes. If Redis or the queue is down, it lives until the ingest-close sweep.
- FACE_MISMATCH only adds risk weight. It never changes status and is never a rejection (D-05, ADR 0004).
- A tampered client can stop sending frames but cannot turn a mismatch into a match. Missing re-checks are detectable (Q6).
- The SDK stops emitting client FACE_MISMATCH. The server still accepts it from older clients until ADR 0010 is amended (section 7).
- The initial ID and selfie upload (BE-08) uses the same presign shape with purpose `ID_IMAGE` or `SELFIE`, in state CONSENTED, ≤ 5 MiB; BE-08 pins its route.

### 5.7 Object key layout (all object types; BE-09)

Each environment has its own bucket (D-10, D-11), so keys carry no environment. Keys contain only UUIDs, ULIDs and fixed words: no names, emails or tokens.

| Object | Key | Written by | DB reference |
| --- | --- | --- | --- |
| Media chunk (incl. ROOM_SCAN) | `orgs/{orgId}/sessions/{sessionId}/media/{stream}/{segment:06d}/{seq:08d}.webm` | browser, presigned PUT | `media_chunks.object_key` |
| ID image, selfie | `orgs/{orgId}/sessions/{sessionId}/identity/{attempt}/{id\|selfie}-{ULID}.jpg` | browser | `identity_checks.id_image_key`, `selfie_key` |
| Evidence snapshot, re-check frame | `orgs/{orgId}/sessions/{sessionId}/evidence/{ULID}.jpg` (wire name `evidence/{ULID}.jpg`) | browser | `proctor_events.evidence_key` |
| Report PDF | `orgs/{orgId}/sessions/{sessionId}/reports/{ULID}.pdf` | API | `sessions.report_key` |
| Signed consent PDF | `orgs/{orgId}/consents/{sessionId}/{ULID}.pdf` (**outside** the session prefix, because it is kept until erasure, D-17; this fills in ADR 0004 §8, owner to confirm, Q16) | API | `consents.pdf_key` |
| Live thumbnail (BE-13, if stored) | `orgs/{orgId}/sessions/{sessionId}/live/{ULID}.jpg` | browser | none (transient) |

- **Ingest-close sweep (BE-09).** It runs at `submitted_at` + grace + 60 s, after the last URL has expired, and for sessions that end EXPIRED after uploads. It lists the session prefix with ListObjectsV2 and HEADs each object against the DB:
  - **media:** delete pending objects and any object whose size or ETag differs from the confirm record; for a confirmed row, null `object_key` and set `deleted_at`, which leaves a visible gap;
  - **evidence:** delete objects that no row references (`EVENT` by an event, `IDENTITY_RECHECK` by a FACE_MISMATCH), and any object over 1 MiB or not `image/jpeg`; null the `evidence_key` of a referenced object that fails these checks;
  - **identity images:** delete objects not referenced by `identity_checks`, or over 5 MiB, or not JPEG;
  - **counts** go to `device_info.storageSweep` for the reviewer (counts only, never keys).
- **Retention (R-4)** deletes the whole prefix `orgs/{orgId}/sessions/{sessionId}/` with ListObjectsV2 and DeleteObjects, then nulls the columns. This is the final backstop for orphans.
- **Erasure (R-6)** deletes the session prefix and `orgs/{orgId}/consents/{sessionId}/`.
- **Media chunk keys are deterministic**, so a retried presign targets the pending object. A confirmed chunk is protected by 5.5 controls 3 and 4.
- **Review GET URLs** (15 min, FR-703) always set `response-content-type` to the expected type (`video/webm`, `audio/webm`, `image/jpeg` or `application/pdf`) and `response-content-disposition: attachment`. A file uploaded as HTML can then never render as a page from the storage host. `<video>` and `<img>` ignore the disposition, so playback still works.

### 5.8 Capabilities shape and the screen-share detector value

`sessions.device_info` = `{ systemCheck?, capabilities: CapabilityFlag[], recorder? }`. Erasure clears it (R-6).

| Field | Rule |
| --- | --- |
| `id` | `^[a-z][a-z0-9-]{1,47}$`. Current SDK ids: `multi-screen`, `virtual-camera`, `screen-share`, `screen-share-surface`, `fullscreen`, `devtools`, `clipboard`, `visibility`, `shortcuts`, `voice`, `record-webcam`, `record-audio` (plus `face`, `gaze`, `object` from the vision monitor). Unique per session; the server merges by id. |
| `status` | `SUPPORTED` \| `UNSUPPORTED` \| `DENIED` \| `UNVERIFIABLE` |
| `detail` | optional, ≤ 128 characters, untrusted text, rendered as plain text only |
| `updatedAt` | server time of receipt (set by the server; the client does not send it) |

- **Screen-share detector.** Recommended (proposed amendment to ADR 0010, not done here): add `SCREEN_SHARE` to `PROCTOR_DETECTORS`. When Chrome or Edge do not report `displaySurface`, the SDK emits `DETECTOR_UNAVAILABLE { detector: "SCREEN_SHARE", reason: "UNSUPPORTED" }` as well as the capability flag, so reviewers see it.
- `SCREEN_SHARE` must not be offered as an accommodation (FR-604 makes the full-screen share mandatory), so BE-06 needs an accommodation subset constant.
- Its weight is owner question Q7.
- **Batch-seq holes** (section 2) are shown in the same review panel as the recording gaps.

### 5.9 Fullscreen exit duration (hub decision QA-D-01)

- The SDK emits FULLSCREEN_EXIT **immediately, with no `durationMs`**, and FULLSCREEN_RESTORED carries `durationMs`. The SDK already does this, so it needs no change, and the ADR 0010 payloads are unchanged.
- **The server derives the duration, but it is not tamper-proof.** The client decides when batches are sent, so the receive times are only as honest as the client.
- **Pairing (BE-10).** A RESTORED pairs with the open FULLSCREEN_EXIT that has the latest `occurred_at` not after the RESTORED's `occurred_at`. Pairing goes by `occurred_at`, not arrival order, so out-of-order batches after an outage still pair correctly (TC-063).
  - A RESTORED that arrives before its EXIT is held, and paired when the EXIT arrives, because EXIT ingestion also looks for an unpaired later RESTORED.
- **Duration.** The EXIT row's `duration_ms` is set as follows:
  - normally, the RESTORED row's `created_at` minus the EXIT row's `created_at` (the difference between server receive times);
  - when both rows were received within 1 s of each other (sent together, typically after an outage), the clamped `occurredAt` difference instead. That value is client-reported.
  - The RESTORED row keeps the client `durationMs` as sent, so a reviewer can compare the two rows. No mismatch note is added to any payload: that would change the ADR 0010 v0 payload.
- **Session end.** When the session ends (SUBMITTED, including auto-submit) or expires, SessionStateService closes any still-open FULLSCREEN_EXIT with `duration_ms` = the session end time minus the EXIT row's `created_at`.
- The risk score (BE-12) reads the EXIT row's `duration_ms`.
- TC-050 now reads "FULLSCREEN_EXIT logged immediately; duration filled on restore or at session end" (docs/test-cases.md, edited in this PR).

### 5.10 Candidate-session scope (needed before BE-07)

Org scoping (ADR 0006, C-1) does not stop one candidate from reading another candidate's session in the same org. Every candidate route is therefore scoped to **one session, taken from the token**.

- **Token.** The candidate JWT is signed with its own secret (C-4), separate from the staff secret.
  - The algorithm is pinned to `HS256` on verification; `none` and any other algorithm are rejected.
  - Verification checks `iss: "codeproctor-api"`, `aud: "codeproctor-candidate"` and `exp` **(architect detail)**.
  - The token carries `typ: "candidate"`, `sid` (session id), `oid` (org id) and `epoch`.
  - Lifetime, storage and device binding are left to ARC-03 part 2.
  - Staff tokens are rejected on `/candidate/*` (401), and candidate tokens on staff routes (401). The guard checks `typ` and the secret, not only the role.
- **Guard (BE-07).** `CandidateSessionGuard` runs on every `/candidate/*` route except the OTP exchange.
  - It verifies the token and loads `sessions` by `sid`.
  - It checks that `org_id = oid` (401 on a mismatch) and `auth_epoch = epoch` (401 `SESSION_TAKEN_OVER` when the token's epoch is lower).
  - It then opens a `CandidateContext { sessionId, orgId, epoch, status }` **per unit of work on AsyncLocalStorage**, together with the `OrgContext`. This follows the amended ADR 0001 C-1 (PR #41): not a Nest REQUEST-scoped provider.
- **Rule CS-1.** The session id comes **only** from `CandidateContext`. No candidate route has a `:sessionId` parameter, and session ids in bodies or queries are stripped and ignored.
- **Rule CS-2.** Every other id a candidate sends is resolved **within** the context session, with `session_id = ctx.sessionId` in the same query. An id that does not belong to it returns 404, the same as a cross-org read (TC-008). This covers:
  - `:questionId` on run, draft and submit: a `session_questions.id`, or a question resolved through the session's `session_questions`;
  - `sessionQuestionId` in keystroke batches;
  - section ids;
  - evidence names (5.2, 5.6);
  - identity attempts.
- **Rule CS-3.** Object keys, Redis keys (`rl:`, `pkey:`, `evidence:`, `rec:`), HMAC keys and jobs are built from `ctx.sessionId` and `ctx.orgId`, never from client input.
- **Rule CS-4: enforcement (DB-05 gate; architect detail, owner to confirm).** Two options were considered:
  - (a) Session checks written in the BE-07 and BE-10 services only.
  - (b) The org scope also carries `sessionId` for candidate units of work, and the db-engineer's org-scope Prisma extension (PR #30, ADR 0006) applies it.
  - **Recommended: (b) as the structural control, plus (a) as explicit service-level checks for defence in depth.**
  - **What (b) must cover.** The extension adds the session filter to every operation, not only reads:
    - `find*`, `count`, `aggregate`, `update`, `updateMany`, `delete`, `deleteMany` and the `where` of `upsert` all get the filter;
    - `create`, `createMany` and the create branch of `upsert` take `session_id` from the context, and reject a different value supplied by the caller.
  - **Filter per table:**

    | Table | Filter |
    | --- | --- |
    | `sessions` | `id = ctx.sessionId` (the table is keyed by `id`) |
    | `session_questions`, `session_sections`, `identity_checks`, `media_chunks`, `proctor_event_batches`, `proctor_events`, `keystroke_batches`, `consents` | `session_id = ctx.sessionId` |
    | `submissions` (no `session_id` column; database.md) | relation filter `session_question: { session_id: ctx.sessionId }` on reads, updates and deletes; creates must reference a `session_question_id` already resolved inside the context |

  - **Unique lookups.** `findUnique` and `update` by `id` use Prisma's extended unique `where` (non-unique fields allowed alongside the unique one); `findFirst` is the fallback. BE-07 and DB-05 choose.
  - **No raw SQL** (`$queryRaw`, `$executeRaw`) inside a candidate unit of work; a test enforces it.
  - **Scope nesting (PR #41 §8.4).** A scope only narrows. A nested scope can neither drop `sessionId` nor change it to another value; trying to do either throws.
  - Candidate service methods take `CandidateContext` as a required parameter.
  - A test fails if a candidate unit of work runs a session-path query without the session filter.
- **Rule CS-5: sockets and storage.**
  - Candidate sockets (OI-2, if any) authenticate with the same token and join only the room `session:{sessionId}` taken from it. The server ignores any session id in a socket payload.
  - Every presign route builds the key from the token's org and session (5.7), and confirm refuses any key or (stream, seq) outside the token's session.
- **Tests (BE-07, BE-09, BE-10, QA; a TC-008 sibling, QA assigns the ID).** Use two candidates, A and B, in the **same org**. With B's token, sent with A's question, section, evidence, attempt and media identifiers to every candidate route (read, run, draft, submit, presign, confirm, evidence, re-check, batches):
  - each call returns 404, or succeeds without touching A's data;
  - no presigned URL for A's prefix is ever issued.

  In addition, a staff token on `/candidate/*` returns 401, and a candidate token on staff routes returns 401.

## 6. ML model files (decision 4)

**Decision: a committed lock manifest plus a hash-verified fetch at build and deploy, served same-origin from the web static host. No binaries in git, no LFS.**

`packages/proctor-sdk/models.lock.json` has one entry per served file, including the runtimes (MediaPipe wasm, onnxruntime-web wasm and mjs, vad-web worklet):

```json
{
  "schema": 1,
  "files": [
    {
      "name": "coco-ssd/ssdlite_mobilenet_v2/model.json",
      "component": "OBJECT",
      "source": "https://storage.googleapis.com/tfjs-models/savedmodel/ssdlite_mobilenet_v2/model.json",
      "version": "@tensorflow-models/coco-ssd 2.2.3",
      "sha256": "<64 hex>",
      "bytes": 0,
      "licence": "unverified",
      "licenceUrl": null,
      "flag": "F-3",
      "status": "unverified"
    }
  ]
}
```

- `status` is one of three values:
  - `approved`: the `licence` field holds an SPDX id checked against ADR 0001 §12.
  - `unverified`: the `licence` field is the literal `unverified`.
  - `blocked`: never shipped.
- npm-sourced files use `source: "npm:<pkg>@<version>/<path>"` and are still hashed. Weights and wasm both count.
- Each entry may name a `licenceFile` that is fetched alongside it. A generated `THIRD_PARTY_NOTICES.txt` is served (Apache 2.0 NOTICE; F-5 keeps Silero's LICENSE).
- The COCO-SSD shards listed in `model.json`'s `weightsManifest` each get an entry. This replaces the manual "export lite_mobilenet_v2" step.

Scripts (proctor-sdk owns them; they replace `fetch-models.mjs`):
- `models:fetch <outDir>` reads the lock, downloads or copies each file, and fails on any SHA-256 or size mismatch.
  - It writes to `<outDir>/<lockDigest12>/…`: a versioned, immutable path, which becomes the SDK's `modelBaseUrl`.
  - It copies only the onnxruntime wasm variants the lock lists, not every `.wasm`.
  - It fails on a file over 25 MiB, the Cloudflare Pages per-file limit (not re-verified 2026-10-05; DEP-01 confirms).
- `models:update` is run by a person or agent with network access. It refreshes `sha256`, `bytes` and `version`. The script does not write `licence` or `status`, but that is only a promise of the script; control 2 in the gate-protection table below is what enforces it.

CI and deploy:
- **CI** (`ci.yml`, hub-owned) runs `models:fetch` with a cache keyed on the lock digest and verifies the hashes.
- **CI also fails** if any `*.tflite`, `*.task`, `*.onnx`, `*.wasm` or `apps/web/public/models/**` file is tracked in git. `apps/web/public/models/` goes into `.gitignore`.
- **Serving.** Cloudflare Pages `_headers` sets `/models/proctor/*` to `Cache-Control: public, max-age=31536000, immutable` and `.wasm` to `application/wasm`. The CSP keeps `script-src 'self' 'wasm-unsafe-eval'` with no third-party model CDN.
- **Licence gate (deploy).** `models:licence-gate --env <staging|pilot|production>` behaves as follows:

  | Environment | `blocked` entry | `unverified` entry |
  | --- | --- | --- |
  | staging (synthetic data only) | fails | warning |
  | pilot, production | fails | fails, unless covered by an owner override |

  - **Override format.** A list of `<name>@<sha256>=<decision-id>` entries in the GitHub Environment variable `MODEL_LICENCE_OVERRIDES` of the `pilot` or `production` environment.
    - The override names the exact hash, so swapped weights invalidate it.
    - The gate cross-checks every decision id against the decision log (`docs/status.md` §9, hub-owned). An id that is not there, or not recorded as a licence acceptance for that file, fails the gate.
    - The gate prints which overrides it applied.
- **What actually protects the gate (B1).** Nothing in CLAUDE.md or ADR 0009 stops an agent from setting this variable:
  - agents run with the owner's `gh` login, so `gh variable set --env pilot` works;
  - an Environment's required reviewer gates deployments, not edits to its variables;
  - and in a PR an agent can change `status` in `models.lock.json`, the gate script or the workflow that calls it.

  The gate is therefore only as strong as the following controls, none of which exists yet:

  | # | Control | Kind |
  | --- | --- | --- |
  | 1 | `CODEOWNERS` naming the owner for `packages/proctor-sdk/models.lock.json`, the gate scripts (`packages/proctor-sdk/scripts/**`), `apps/worker/models.lock.json` and `.github/workflows/**`; branch protection on `main` requiring code-owner review | owner action (CODEOWNERS file by the hub, branch protection by the owner) |
  | 2 | CI check: in any PR, a change to `licence` or `status` in a lock file fails unless the PR has the owner's approving review. `models:update` diffs can then only touch `sha256`, `bytes` and `version` | architect detail, owner to confirm |
  | 3 | Override decision ids recorded in the decision log and cross-checked by the gate (above) | architect detail, owner to confirm |
  | 4 | Agent permission settings deny `gh variable *`, `gh secret *` and `gh api */environments/*`. **This is a recommendation only.** The hub does not edit `.claude/` or any settings file: that is an owner decision (CLAUDE.md rule 7) | owner action |

  **Until 1 to 4 exist, the gate is not protected.** It catches mistakes, not a determined change by an agent or contributor. Until then, the owner checks `MODEL_LICENCE_OVERRIDES` and the lock-file diff before each pilot or production deploy.
- **Deploying without the object detector.** The owner can instead deploy with `PROCTOR_EXCLUDE_COMPONENTS=OBJECT`.
  - The fetch skips the OBJECT files.
  - The SDK does not start the object detector and reports capability `object: UNSUPPORTED`, with no DETECTOR_UNAVAILABLE events, so candidates are not penalised for a deployment choice.
  - PHONE_DETECTED and BOOK_DETECTED are then unavailable (TC-059).
- **Swap-out path for F-3.** The object detector already sits behind an adapter in the SDK's inference worker.
  - Candidate replacement: the MediaPipe Object Detector (EfficientDet-Lite0) through the `@mediapipe/tasks-vision` package the SDK already uses. It would remove `@tensorflow-models/coco-ssd` and the four `@tensorflow/tfjs-*` packages.
  - Its weights are reported as Apache 2.0 only by secondary sources (no standalone model card), and it is also trained on COCO. Legal must check it before use (not verified).
  - Excluded: Ultralytics YOLO (AGPL-3.0).
- **Worker models.** ARC-04 adopts the same format in `apps/worker/models.lock.json`. AuraFace's four InsightFace files are listed as `blocked`, which turns F-1 into a failing check.

## 7. Options considered

| Decision | Chosen | Rejected options |
| --- | --- | --- |
| Key delivery | Once per epoch, non-extractable CryptoKey in IndexedDB, derived per epoch | (a) The token can fetch the key at any time: then the HMAC adds nothing over the token. (b) Device-bound keys (WebAuthn or ECDH): stronger, but this is the Phase 3 lockdown attestation. (c) No HMAC: contradicts architecture.md and TC-065. |
| Signature placement | `X-Signature` over the exact body | A `{ payload, sig }` wrapper means a second parse, and the server would sign a re-serialisation (fragile between JS and Python). |
| Replay state | ADR 0005 §3 table plus derived-key duplicate check | Storing a key epoch per batch would need a schema change. |
| Pre-start events | Unsigned, token-authenticated, `batch_seq` NULL marker, server start gate | Issue the key at CONSENTED (ADR 0002 option (b)): no extra assurance, because the key is browser-held either way, and keys would exist for sessions that never start. Drop the pre-check: breaks FR-605. |
| Identity re-check | Frame uploaded through presign, server writes FACE_MISMATCH | Client compares and relays: tamperable, and it would ship a biometric template to the browser (ADR 0004 §2). Worker samples frames from the WEBCAM recording: tamper-resistant but heavy (decoding); an ARC-04 add-on. POST the frame to the API: breaks "heavy media never passes through the API". |
| Key layout | Per-session prefix, consent outside it | Flat random keys indexed only in the DB: orphans survive retention. One bucket per type: more CORS and config per environment. |
| Model files | Lock plus fetch-and-verify, served same-origin | Committed binaries: about 40 MB in history forever, even if Legal rejects F-3. Git LFS: quota and bandwidth costs, still in history. Object storage or CDN behind the same origin: extra infrastructure; kept as the fallback if Pages limits bite. |

**Amendments this ADR needs (none applied here; `packages/shared` unchanged):**
- **ADR 0010:**
  - add FACE_MISMATCH to `SERVER_EVENT_TYPES`, and drop it from `CLIENT_EVENT_TYPES` once the SDK ships;
  - `SCREEN_SHARE` in `PROCTOR_DETECTORS`, plus an accommodation subset;
  - `capabilityFlagSchema` and `deviceInfoSchema`;
  - the `proctor-key` and heartbeat zod shapes;
  - if Q6 is yes, a server reason `NOT_REPORTED` on DETECTOR_UNAVAILABLE, or a `RECORDING_GAP` type;
  - any later fullscreen mismatch field would also go here; 5.9 adds none.
- **FR-606 (owner decision, Q15).** FACE_MISMATCH moves from a browser check every second to a server re-check of a frame every 2 minutes. That is an FR change and new server-side biometric processing during the test.
- **ADR 0004 §8.** The consent PDF key sits outside the session prefix (5.7), which fills in and amends the layout ADR 0004 §8 delegated to ARC-03.
- **ADR 0005 §3 and database.md (`proctor_events.batch_seq`, around line 586).** The comment "NULL for SERVER events" becomes "NULL for SERVER events and unsigned system-check findings". `batch_seq` is already nullable, so there is no schema change.
- **Flagged schema changes (each needs its own ADR, not decided here):** a durable key-issue marker (`sessions.hmac_key_issued_epoch`) and `media_chunks.etag` (Q12).

## 8. Consequences and per-agent changes

- **No schema change.** `batch_seq IS NULL AND source = CLIENT` gains a meaning, and `hmac_key_enc` is nulled at ingest close.
- **Contract changes ripple** to the SDK, BE-07, BE-09, BE-10, BE-12, BE-13, the frontend, QA and deploy.
- **NFR-02 load.** At 200 candidates there are about 120 requests per second for presign and confirm, plus 20 for heartbeats, about 40 for event batches and about 100 for keystroke batches. k6 must cover presign and confirm (TC-090, TC-091). Batching confirms is the first lever if p95 suffers.

| Agent | Must do |
| --- | --- |
| proctor-sdk | Accept a CryptoKey (or base64), persist it non-extractable in IndexedDB, re-sign the outbox on a new epoch or `KEY_EPOCH_STALE`, and seed counters from `proctor-key` (max with local). Map status codes as in 5.2: stop and purge on `SESSION_NOT_ACTIVE` and on 401 `SESSION_TAKEN_OVER`; at most 3 retries on `TOKEN_EXPIRED`, then raise `reauthRequired`; never retry a 401 forever. Add the heartbeat body and its 409 handling. For media: send `startedAt` and `durationMs`, send the `If-None-Match` header when the presign returns it, treat 412 as already stored, handle `alreadyUploaded`, `UPLOAD_MISMATCH` and `UPLOAD_NOT_FOUND`, and never drop a segment's first chunk. Evidence presign gets `purpose`; each name is used once and only for its purpose. Re-check becomes upload plus 202, and client FACE_MISMATCH emission is removed. Add a `runSystemCheck()` helper. Replace `fetch-models.mjs` with lock scripts. Purge the key and outbox at finish. Never log URLs. |
| backend BE-07 | Candidate-session scope first (5.10: pinned HS256 with `iss` and `aud`, `CandidateSessionGuard` on AsyncLocalStorage, CS-1 to CS-5, `SESSION_TAKEN_OVER`, cross-candidate tests); then the master key with AAD and `kid`, epoch derivation, the issue marker with TTL until deadline + grace, system-check gates on CONSENTED → VERIFIED and on start, the `proctor-key` route, system-check route and start gate (TC-056), heartbeat and watchdog, key destruction at ingest close and on erasure |
| db-engineer (DB-05, PR #30) | Let the org-scope context carry an optional `sessionId` for candidate units of work and apply it to every operation, with the per-table filters, create defaults, no raw SQL and narrow-only nesting (5.10 CS-4 option (b)) |
| backend BE-09 | Key layout 5.7; presign and confirm 5.5, with the HEAD check, ETag recording, the `If-None-Match` spike for R2 and S3, and per-session caps; evidence presign 5.6 with single-purpose, single-use names, quotas, the FACE-disabled refusal and the `evidence-expire` job; the ingest-close sweep; review GET URLs with response-type and disposition overrides; prefix deletion in retention and erasure, consent PDF prefix |
| integrity BE-10 | Raw-body verification order (section 2); fullscreen pairing by `occurred_at` and the duration rule (5.9); duplicate check (stored signature first, then the 8-epoch window); invariant test that CLIENT rows from batches have `batch_seq`; error codes, evidence-name resolution, grace window, per-session limits, a `rejected` metric with no body |
| integrity BE-12 | Score from server `duration_ms` only (5.9); `face-recheck` job with the 1 MiB and 1920 × 1920 refusals before decoding, frame deletion on every non-mismatch outcome including failure, and outcome hand-off (API writes the event; OI-1 mechanism in ARC-04), hole-tolerant segment concatenation, worker `models.lock.json` |
| backend BE-11 and BE-13 | SessionStateService (BE-07/BE-11) closes open FULLSCREEN_EXIT rows at session end (5.9). BE-11: the frontend flushes the SDK (bounded) before `/finish`; `analyze-session` is delayed by the grace (with ARC-04). BE-13: review bundle with recording gaps, batch-seq holes, recorder health, the unsigned label and server FACE_MISMATCH evidence |
| frontend | Check IndexedDB first, then call `proctor-key` after start and after OTP resume, inside a Web Lock; when the key is missing or `KEY_ALREADY_ISSUED`, run the OTP resume; handle `reauthRequired`. Build the system-check call. Pages `_headers` and CSP for models. Sentry scrubbing. Review UI labels and gap panel. `/dev/proctor` uses the lock-served path. |
| QA | TC-050 reworded (done in this PR; 5.9); TC-063 45 s against the 60 s FR-609 threshold (Q13); cross-candidate scope tests including presign and confirm (5.10); B2: oversize PUT deleted by confirm or the sweep, re-PUT after confirm blocked (412) or caught by the sweep, review URLs carry the response overrides; B3: re-check presign refused when FACE is disabled, a reused name is rejected, an EVENT name sent to re-check gets 400, a RECHECK name in an event is dropped, an unused frame is deleted within 10 min, a frame whose job failed is deleted, a MATCH frame is deleted, and the sweep removes unreferenced re-check frames; licence gate fails on an override id missing from the decision log; TC-065 (tamper → 403, identical replay → 200 duplicate, same seq with a different body → 409, other-session key → 403); TC-063 with an epoch change mid-outage; TC-070 with a synthetic hole; TC-056 server gate. New TCs: key issued once per epoch, cross-session evidence name dropped, server-written FACE_MISMATCH, prefix retention removes orphans, licence gate fails on unverified without override. k6 signer through `k6/crypto`. |
| deploy (QA track) | `models:fetch` and the licence gate in the DEP-01, DEP-03 and production workflows; protected environments; controls 1 to 4 of section 6 tracked as owner actions; bucket CORS (PUT with Content-Type) per ST-7 |
| hub, on acceptance | fsd.md §4 rows; api-contract.md error codes (after #31 and #33 merge); database.md comments (`batch_seq`, `hmac_key_enc`, `device_info`); architecture.md Security bullet; ADR 0010, 0004 §8 and 0005 §3 amendments; FR-606 wording if Q15 is yes; ADR 0001 OI-3 and OI-9 marked decided; the `ci.yml` model job and the lock licence-diff check; `CODEOWNERS` file |

## 9. Owner questions

**Owner decisions**

1. **Key loss costs an OTP round trip** while the clock runs (IndexedDB cleared, response lost). Accept this, or allow re-issue to any token holder? Re-issue is simpler but makes the HMAC no stronger than the token.
2. **Ingest grace** after SUBMITTED: 300 s for batches and media, with `analyze-session` delayed to match, then key destruction and the storage sweep.
3. **Pre-start unsigned findings**: show them on the timeline but leave them unscored (recommended), or score them?
4. **Re-check frames**: a 640 px JPEG every 2 minutes, kept only when a FACE_MISMATCH references it and deleted otherwise (within about 10 minutes, 5.6). Does the consent document (D-17, Legal) cover this?
5. **Repeated server FACE_MISMATCH**: should, for example, 2 consecutive mismatches route the session to the identity manual-review gate? That needs a schema and shared change.
6. **Missing re-checks, recording gaps, sweep deletions and tamper signals** (`SEQ_CONFLICT`, `SIGNATURE_INVALID`): should the server log events a reviewer sees, and should they carry risk weight? Either needs an ADR 0010 amendment.
7. **`SCREEN_SHARE` detector value**: add it (recommended), decide its weight, and confirm it is never an accommodation.
8. **COCO-SSD (F-3) for the pilot**: (a) an override after Legal review (B-05), (b) deploy without object detection, or (c) a swap after a licence check.
9. **Gate protection (section 6, controls 1 to 4)**: add `CODEOWNERS` and branch protection requiring your review; add deny rules for `gh variable`, `gh secret` and `gh api …/environments` to the agents' permission settings (your change under CLAUDE.md rule 7). Until then the gate is not protected.
10. **Per-IP throttle on candidate routes**: replace the per-IP throttle (FU-BE-18) with per-session limits on the routes in this ADR (recommended, for test centres behind NAT), or keep both?
11. **Serving models from Cloudflare Pages** (25 MiB per-file limit, same origin as the app), with object storage behind the same origin kept as the fallback?
12. **Flagged schema changes**: approve separate ADRs for a durable key-issue marker and `media_chunks.etag`, or accept the Redis fail-open risks described in sections 2 and 5.5?
13. **TC-063 against FR-609**: the test drops the network for 45 s but expects DISCONNECTED, which FR-609 logs only after 60 s. Change the test duration (recommended) or the FR?
14. **The fullscreen duration** after an outage (5.9) uses the client-reported `occurredAt` difference. Accept that, knowing it is client-influenced?
15. **FR-606 change**: FACE_MISMATCH moves from a browser check every second to a server re-check every 2 minutes, which is new server-side biometric processing.
16. **Consent PDF outside the session prefix** (5.7), amending ADR 0004 §8.

**Architect details to confirm**

17. Names and limits: `SESSION_KEY_ENC_KEY_<kid>`, `PROCTOR_INGEST_GRACE_SECONDS`, per-route limits and quotas, 16 MiB per chunk, 1 MiB and 1920 × 1920 per image, the 15-minute freshness of the system check, JWT `iss` and `aud`.
18. Candidate-session enforcement (5.10 CS-4): the Prisma extension with `sessionId` (b) plus service checks (a).
