# ADR 0013: Proctor transport: HMAC key lifecycle, wire contracts and model files (ARC-03 part 1)

| Field | Value |
| --- | --- |
| Status | **Accepted 2026-10-06 (D-54):** the owner accepted it in the Delivery Lead's session (the Delivery Lead records the decision in docs/status.md); it was Proposed on 2026-10-05 (C-23, docs/compliance/decisions.md, PR #44). The BE-07 interim exception of section 5.10 is **approved under P-24** (time-boxed, ending before the pilot). **Depends on:** PR #41 (ADR 0006 section 8), PR #44 (C-10, C-17, C-25, C-33, C-34, C-35 in docs/compliance/decisions.md) and PR #48 (ADR 0004 R-9, consent clock) (the hub's security reviews are done). Items marked **(architect detail, owner to confirm)** are not owner decisions; section 9 lists the questions. Amended by D-56 (2026-10-06): the owner approved the STAFF proctor pause, resume and message SERVER-event exception of section 5 (CS-4.7) and the 503 BUSY wording for lock contention (DL-37), at head f690e59 of PR #214. |
| Author | architecture hub |
| Decides | OI-3 (key lifecycle, canonical JSON, threat model), OI-9 (key layout, segment reassembly rules), the key half of OI-10, the ARC-03 items ADR 0010 "Leaves to", and every "Open for the architecture hub" item in docs/followups/proctor-sdk.md |
| Serves | FR-403, FR-601, FR-604, FR-605, FR-606, FR-607, FR-609, FR-610, FR-701, FR-702, FR-704, FR-801; NFR-01, NFR-02, NFR-04, NFR-05, NFR-08; TC-008, TC-050, TC-056, TC-058, TC-059, TC-063, TC-065, TC-070, TC-072 |
| Builds on | ADR 0001 (TB-1, TB-3, C-4, C-5, ST-1..ST-8, section 12 and F-3), ADR 0002 §3 option (a) and L-2, ADR 0004 (§1, §2, §4, R-4, R-6), ADR 0005 §3, ADR 0006 (section 8 as amended in PR #41), ADR 0007 §5, ADR 0010 (not contradicted; proposed amendments in section 7); C-17 and C-25 (PR #44) and proposed ADR 0004 §9 (PR #48), both unmerged |
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
  - A Redis `SET NX` on `pkey:{sessionId}:{e}` blocks a second issue (409 `KEY_ALREADY_ISSUED`). Its TTL lasts until `deadline_at` + ingest grace + 1 h. When `deadline_at` is extended (proctor-pause credit, ADR 0002 P-3), the marker's TTL is set again (`EXPIRE`), and so are the TTLs of `evidence:` and `etag:`.
  - **Fail-open risk, recorded.** If Redis loses the marker (flush, failover without persistence), the key can be issued again to whoever holds the token for that epoch. For that window the HMAC is no stronger than the token.
  - A durable marker (for example `sessions.hmac_key_issued_epoch int`) would close the gap. It is a schema change and needs its own ADR, so it is **flagged, not decided** (Q12).
  - The frontend calls the route after the start-test call succeeds and after each OTP resume, because both points start a key context that has not been issued yet.
- The SDK imports the key with `extractable: false` and stores the `CryptoKey` object in IndexedDB as `{sessionId}:hmacKey` together with its epoch. Chrome and Edge (NFR-07) can structured-clone CryptoKeys.
  - A reload on the same epoch loads the key from IndexedDB.
  - **This ADR is the permission OI-10 and the code-reviewer privacy rule (D-07) require for a key in the FR-702 IndexedDB buffer.** No other secret may be stored there; the candidate token stays with ARC-03 part 2.
  - `extractable: false` only stops page JS from reading the bytes. Malware or anyone with access to the browser profile on disk can still recover the key.
- **Who calls what (decided).** The **host app** (frontend) calls `proctor-key` and runs the OTP resume and the token refresh. The SDK cannot do any of those. The app hands the key to the SDK through hooks:
  - `ProctorSession.setKey(key, epoch, counters)`: the SDK imports the key non-extractable, stores it, re-signs its outbox and seeds counters.
  - `ProctorSession.loadStoredKey(sessionId)`: returns `{ epoch } | null` from IndexedDB.
  - `onKeyStale`: raised on `KEY_EPOCH_STALE` when the SDK has no newer key.
  - `onReauthRequired`: raised on `SESSION_TAKEN_OVER` or repeated `TOKEN_EXPIRED`.
  - `onToken`: passes a renewed token from the heartbeat to the app.

  The SDK stores only the key and its own outbox, never the token.
- **Intended consequence.** A device that sees `KEY_EPOCH_STALE` but did not do the OTP resume cannot refetch the key, because `proctor-key` answers `KEY_ALREADY_ISSUED` for that epoch. The candidate must pass the OTP again. In practice that device's token is usually already dead, so the 401 `SESSION_TAKEN_OVER` comes first.
- **Purge.**
  - **At finish:** the SDK deletes the key once the outbox is drained, or at the end of the post-finish grace window. Unsent outbox items still queued then are dropped and counted.
  - **On 409 `SESSION_NOT_ACTIVE` and on 401 `SESSION_TAKEN_OVER`:** the SDK purges immediately.
  - **Stale sweep at `ProctorSession` start:** it deletes keys and outboxes of any other session, and anything older than 24 h.
  - **Never** the live session's key during a long outage.
  - Delete-at-finish is required for shared test-centre machines.
  - With IndexedDB unavailable, the key cannot persist, so **every reload costs an OTP**. The SDK reports capability `idb: UNSUPPORTED`.
- **Missing key.** The frontend checks IndexedDB first. If the key is absent (IndexedDB cleared, response lost), it runs the OTP resume (ADR 0002 L-2), which raises the epoch, and then fetches a new key. The clock keeps running.
  - The check-then-fetch sequence runs inside a Web Lock (`navigator.locks.request("cp-key:" + sessionId)`), so two tabs cannot each trigger an OTP and thrash the epoch.
- The key is never logged, never put in a URL, never written to localStorage or sessionStorage, and never sent to error tracking. The response carries `Cache-Control: no-store`.

**Rotation and revocation.**
- Each OTP success raises `auth_epoch`, which kills the old device's token (ADR 0002). New batches must be signed with `K_current`.
- **Same device, new epoch.** The SDK re-signs its unsent outbox with the new key. It stores the exact body, so only the signature changes.
- **Different device.** Batches still queued on the old device are lost: its token is dead, and it purges on `SESSION_TAKEN_OVER`. Server-side gap detection (section 5.8) shows the hole to the reviewer.
- **Ingest close.** Ingestion closes at `submitted_at + PROCTOR_INGEST_GRACE_SECONDS` (default 300). The same close, with the same grace, runs for every other terminal exit ADR 0002 allows from IN_PROGRESS or PAUSED, measured from that transition's server time (today SUBMITTED by finish, last section or auto-submit). All of these go through one named method, `SessionStateService.closeIngest(sessionId, reason)`, which any terminated or invalidated status added later must also call. EXPIRED sessions never received a key (EXPIRED applies only before start), but still get the storage sweep. **An ERASED session (5.7) gets no grace.** The epoch bump at the fence already makes every candidate request answer 401, so ingestion is closed at the fence time and the key is destroyed at once. The close job then sets `hmac_key_enc = NULL` (key destruction), tells the worker to evict the session's in-memory selfie embedding (ADR 0004 §2, C-18), and runs the storage sweep (section 5.7). After that, stored signatures cannot be re-verified, which is acceptable because they serve idempotency only. **(architect detail, owner to confirm; ARC-04 delays `analyze-session` by the same grace.)**
- **Erasure (R-6) of a live session** also nulls `hmac_key_enc` and deletes the session's Redis keys: `pkey:`, `qview:`, `evidence:`, `etag:`, `rec:`, `submits:`, `rl:submit:`, `lock:device-info:`, `devinfo-resync:` and the `verify-session` counter `vs:`. It also evicts the worker's in-memory selfie embedding for the session (ADR 0004 §2, C-18), as ingest close does.

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

Counters arrive only with the key, once per epoch. That is enough:
- a same-device reload keeps its IndexedDB counters;
- a lost IndexedDB also loses the key, which forces an OTP and so a fresh `proctor-key` with counters.

**Media `seq` is unique per stream across segments (decided).** This follows ADR 0004 §4, accepted, and the DB `UNIQUE (session_id, stream, seq)`.
- The SDK currently restarts `seq` at 0 for each segment (`recorder.ts`). It must instead continue one per-stream counter, persisted in IndexedDB and seeded from `counters.media`. This is SDK work.
- The object key carries both segment and seq (5.7) for listing and reassembly, but seq alone identifies a chunk.

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
| States | IN_PROGRESS, PAUSED; otherwise 409 `SESSION_NOT_ACTIVE` with extension `sessionStatus` |
| 200 | `{ alg: "HMAC-SHA256", key: <base64, 32 bytes>, keyEpoch: int, counters: { eventSeqStart, keystrokeSeqStart, media: { SCREEN \| WEBCAM \| AUDIO: { nextSeq, nextSegment } } } }`, `Cache-Control: no-store` |
| Errors | 401; 409 `KEY_ALREADY_ISSUED` (same epoch, already issued: the client re-runs the OTP resume); 409 `SESSION_NOT_ACTIVE`; 429 |
| Limit | 5 per minute per session |

## 5. Wire contracts (decision 3)

### 5.1 Common rules

- **Auth.** `Authorization: Bearer <candidate token>` on every route here. The session and org come from the token, never from the URL or body (section 5.10). A body that names a session id is ignored (stripped).
- **Problem `code`.** Clients branch on the RFC 7807 `code` (`SEQ_CONFLICT`, `UPLOAD_NOT_FOUND`, `UPLOAD_MISMATCH`, `KEY_EPOCH_STALE`, …), never on the status alone or on `detail`.
- **Rate limits.** Per session in Redis (`rl:{route}:{sessionId}`), returning 429 with `Retry-After`. Limits are token buckets sized for **catch-up after an outage**: a 10-minute backlog must drain within about 5 minutes. On 429 the SDK waits `Retry-After` and never drops. After `SESSION_NOT_ACTIVE` (the grace has passed), the remaining backlog is dropped and counted (section 2, Purge). The per-IP candidate throttle (FU-BE-18, 30 per minute per IP) must not apply to these routes: a test centre puts many candidates behind one NAT. **(architect detail)**
- **Body limits.** Non-batch JSON bodies are capped at 16 KiB (413).
- **Never logged** (C-5, R-8): request **and response** bodies of `/candidate/*` (the heartbeat and `proctor-key` responses carry a token or a key; both send `Cache-Control: no-store`), presigned URLs, object keys, evidence names, signatures, keys.
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
  - **Names are single-purpose and single-use.** The Redis hash `evidence:{sessionId}` maps each name to `{ purpose, state: ISSUED | RESERVED | USED | EXPIRED, seq? }`. Every state change is one atomic compare-and-set (a Lua script). Its TTL lasts until `deadline_at` + grace + 1 h.
  - An event may reference only an `EVENT` name. Before the Postgres batch transaction, BE-10 reserves it: ISSUED → RESERVED{seq}.
    - If the transaction rolls back, the reservation is released (RESERVED{seq} → ISSUED).
    - After commit, the name moves to USED{seq}.
    - A name that is already RESERVED or USED by the same seq is accepted again, so a retried batch keeps its evidence.
    - Two concurrent batches with different seqs cannot both reserve the same name; the loser's event is stored with `evidence_key` NULL.
    - If the process dies between commit and USED, the RESERVED{seq} entry still matches that committed seq, and the sweep treats it as referenced.
  - ISSUED → EXPIRED (5.6) is the same compare-and-set, so a name can never be both expired and used.
  - An unknown, wrong-purpose or already-used name is dropped from that event (`evidence_key` NULL), and the batch still succeeds.
  - Another session's object can never be referenced, because the prefix comes from the token.
- **Timestamps.** `occurredAt` is clamped to `[sessions.started_at, server now]` (TB-1).

### 5.3 Heartbeat (FR-609; new fsd.md §4 row)

| Item | Contract |
| --- | --- |
| Route | `POST /candidate/session/heartbeat` every 10 s, unsigned |
| Body (optional; the SDK fills it from a `getHealth()` provider wired to the recorder and the queues) | `{ capabilities?: CapabilityFlag[] (≤ 32, only when changed), recorder?: { streams: [{ stream, segment, lastSeq, bufferedChunks, bufferedBytes, droppedChunks, droppedBytes }] }, queue?: { pendingEventBatches, pendingKeystrokeBatches, rejectedBatches } }` |
| 200 | `Cache-Control: no-store`. `{ serverTime, status: "IN_PROGRESS" \| "PAUSED", deadlineAt, sectionDeadlineAt \| null, pauseReasons: [] }`, plus optional `sessionToken` and `sessionTokenExpiresAt`, present only when the server renews the candidate token (backend.md Step 7; lifetime in ARC-03 part 2). The SDK passes them to the app through `onToken` and never stores them |
| Errors | 401; 409 `SESSION_NOT_ACTIVE` with `sessionStatus` (the SDK stops the heartbeat and fires an `ended` event instead of reporting "offline"); 429 |
| Limit | 12 per minute per session |

Server behaviour:
- Each beat sets `last_heartbeat = now()` with one UPDATE by primary key. About 20 writes per second at 200 candidates; target p95 below 50 ms.
- If a DISCONNECTED was logged since the last beat (Redis flag), the beat enqueues a `server-event` session job that writes RECONNECTED (SERVER), because candidate scope cannot write SERVER rows (CS-4.4).
- A repeatable discovery job every 15 s, under `BACKGROUND_JOB`, finds IN_PROGRESS and PAUSED sessions silent for more than 60 s. It only enqueues one SERVICE job per session. Each job is a separate BullMQ worker callback: `SessionJobProcessor` asserts that no scope is active, then enters `runAsSessionJob` and writes DISCONNECTED `{ lastHeartbeatAt }` (FR-609, CS-4.7).
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
| Rules | `stream` is SCREEN, WEBCAM, AUDIO or ROOM_SCAN; SIDE_CAMERA waits for ARC-03 part 2. `segment` 0..9,999; `seq` 0..99,999,999 (both fit the key padding in 5.7). `contentType` is exactly `video/webm` or `audio/webm`, with no codecs parameter, so the signed header matches. The recorder's `video/webm;codecs=vp8,opus` is normalised by the SDK to its essence (the part before `;`, lowercased). The PUT sends that bare value as an explicit `Content-Type` header, never `blob.type`. `bytes` 1..16 MiB (AUDIO 4 MiB). `durationMs` 1..60,000. `startedAt` is clamped. Per session, at most `ceil(duration / 10 s) × 1.5 + 50` presigns per stream. | — |
| States | ROOM_SCAN: CONSENTED. Other streams: IN_PROGRESS, PAUSED, or SUBMITTED within the grace. | same |
| 200 | `{ url, method: "PUT", headers: { "Content-Type": ..., "If-None-Match"?: "*" }, expiresAt }`, valid 60 s, with Content-Type and Content-Length signed (ST-2, ST-3); or `{ alreadyUploaded: true }` with **no `url`** (a union in the schema) once confirmed; no new URL is ever issued for a confirmed chunk | `{ uploaded: true, sizeBytes }`, idempotent |
| Errors | 400; 409 `SEQ_CONFLICT` (this stream's seq already exists with another segment); 409 `SESSION_NOT_ACTIVE`; 429 | 404 `CHUNK_NOT_PRESIGNED`; 409 `UPLOAD_NOT_FOUND` (HEAD 404: upload again, presigning again if expired); 422 `UPLOAD_MISMATCH` (HEAD size or type differs: the server deletes the object, the row stays pending, the client presigns again) |
| Limit | 60 per minute per stream | same |

- **Rows.** Presign upserts `media_chunks (stream, segment, seq)` as pending. Confirm HEADs the object and checks its size against the declared `bytes`, the stream maximum and the content type. It then sets `uploaded_at` and `size_bytes`, and records the ETag.
- **Upload size and integrity (ADR 0001 ST-3: whether R2 and S3 enforce a signed Content-Length is not verified).** No single control enforces size, so four controls are layered:
  1. **Confirm HEAD** rejects a wrong size or type (422) and deletes the object.
  2. **ETag at confirm.** `media_chunks` has no ETag column, so the ETag is kept in the Redis hash `etag:{sessionId}` until the sweep. If Redis loses it, the sweep falls back to the size check alone. A durable `media_chunks.etag` column would be a schema change needing its own ADR (flagged, Q12).
  3. **`If-None-Match: *` signed on the PUT**, so a second PUT to the same key fails with 412 instead of replacing it.
     - AWS S3 supports conditional writes on PutObject. R2 support and presigned-header behaviour on both stores are **not verified**. The BE-09 spike checks them, together with R2 support for the `response-content-type` and `response-content-disposition` overrides on presigned GET. Where unsupported, the header is omitted and control 4 alone catches replacement.
     - The SDK treats 412 as "already stored" and goes on to confirm.
  4. **Ingest-close sweep** (section 5.7, with a margin and a second pass). It deletes any object whose size or ETag differs from the confirm record, and oversize objects.
  - **Remaining exposure.** Until the sweep runs, a client holding a 60-second URL may store an oversize object or overwrite a confirmed chunk (where control 3 is unavailable). The rate limits and per-session presign caps bound how many URLs exist.
- **Segments (OI-9, ADR 0004 §4).**
  - A recorder restart starts a new segment, and the segment's lowest seq carries the WebM header.
  - The SDK uploads a segment's first chunk first. Losing that chunk makes the whole segment unplayable, so it is **protected** in the 200 MB buffer (FR-702):
    - `makeRoom` never evicts a protected chunk;
    - when only protected chunks remain and the cap is reached, the SDK drops the **incoming** non-first chunk and counts it;
    - an incoming first chunk may exceed the cap by at most 16 MiB per stream; beyond that it too is dropped, the segment is lost, and the loss is reported.
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
| States | IN_PROGRESS, PAUSED. Purpose `IDENTITY_RECHECK` is refused (owner decision C-34) with 409 `IDENTITY_CHECK_WAIVED` when the identity check is waived, or with 409 `DETECTOR_DISABLED` when "face detectors off" is set | IN_PROGRESS, PAUSED; the same two refusals |
| 200 / 202 | 200 `{ url, method: "PUT", headers, evidenceKey: "evidence/<ULID>.jpg", expiresAt }` | **202 `{ accepted: true }`. No match result is returned to the browser.** |
| Errors | 400; 409 `SESSION_NOT_ACTIVE` / `IDENTITY_CHECK_WAIVED` / `DETECTOR_DISABLED` / `QUOTA_EXCEEDED`; 429 | 400 (unknown, wrong-purpose or already-used name), 409, 429 |
| Limit | 20 per minute. Per session at most 300 `EVENT` names and `duration_minutes + 10` `IDENTITY_RECHECK` names (409 `QUOTA_EXCEEDED`) **(architect detail)** | 1 per 60 s (SDK interval 120 s) |

**Decision: the server writes the re-check outcome itself.**
- **Which setting stops the re-check: decided by owner decision C-34.** The re-check is refused when **either** "no identity check" (the waiver) **or** "face detectors off" is set. "Face detectors off" covers the in-browser and the server face detectors (C-25), and the re-check is the only server face processing during the test. A refusal of biometric processing waives the check and switches off every face-based detector (OQ-15, ADR 0015). ADR 0015's interaction table follows C-34.
- **Names.** The re-check accepts only an `IDENTITY_RECHECK` name in state `ISSUED` and marks it `USED` with the same compare-and-set (5.2).
- **Sealed copy (decided).** The re-check route runs these steps in order:
  1. HEAD the original. Missing (PUT still in flight) gives 409 `UPLOAD_NOT_FOUND`, and the name stays `ISSUED` so the client can retry. Over 1 MiB or not `image/jpeg` gives 400; the name moves to `EXPIRED` and the original is deleted.
  2. CopyObject to `…/evidence/sealed/{ULID}.jpg` in the same bucket. On failure the route answers 503 with `Retry-After`, the name stays `ISSUED`, and the partial copy (if any) is deleted.
  3. Compare-and-set the name `ISSUED → USED{sealedKey}`. If that fails (a concurrent request), delete the sealed copy and answer 400.
  4. Delete the original.
  5. Enqueue `face-recheck` with the sealed key.
  - No presigned URL is ever issued under `sealed/`. The worker reads the sealed copy, and FACE_MISMATCH references it.
  - A client re-PUT to the original key within the URL's 60-second life therefore cannot swap the frame behind a verdict.
  - `If-None-Match: *` is also signed on evidence PUTs where supported (5.5, control 3).
  - EVENT evidence is not sealed: the client authored that event, so swapping its own snapshot within 60 s is no different from taking another one.
- The API then enqueues `face-recheck` on the face-match queue, at a lower priority than initial checks.
- **Worker.**
  - It HEADs the frame first and refuses (outcome ERROR) anything over 1 MiB or not `image/jpeg`.
  - It reads the JPEG header and refuses anything over 1920 × 1920 pixels before decoding (decompression-bomb guard).
  - It compares the frame with the selfie of the latest identity attempt (cached embedding, ADR 0004 §2) and returns `{ outcome: MATCH | BELOW_THRESHOLD | NO_FACE | MULTIPLE_FACES | ERROR, score, modelId, threshold }`.
- **Outcome.** On BELOW_THRESHOLD, the API writes FACE_MISMATCH with `source = SERVER`, `occurred_at` = the clamped `capturedAt`, `payload { similarity }` and `evidence_key` = the sealed copy. **Every other outcome deletes the frame at once (NFR-05).**
- **Frames are deleted unless a FACE_MISMATCH references them.** This is what makes the consent premise in Q4 true. Three paths do it:
  - the outcome handler deletes the **sealed** key on any outcome other than BELOW_THRESHOLD, including ERROR, and the BullMQ failed-job handler deletes the sealed key after the last retry;
  - a delayed `evidence-expire` job, enqueued at presign for +10 minutes and **only for `IDENTITY_RECHECK` names** (an `EVENT` name may wait in an outbox through a long outage; the sweep handles unreferenced EVENT objects):
    - a name still `ISSUED` is marked `EXPIRED` and its object deleted, and a late `/identity/recheck` with it gets 400;
    - a name `USED` with no FACE_MISMATCH row and no job running has its **sealed** object (and the original, if still present) deleted;
    - if the `face-recheck` job is still running, the expire job re-enqueues itself for +10 minutes, at most 3 times; after that the sweep is the backstop;
  - the ingest-close sweep (5.7) deletes any `IDENTITY_RECHECK` object that no FACE_MISMATCH row references.
  - **Bound:** an unreferenced frame lives until its re-check outcome, or at most about 10 minutes if it is never re-checked. A slow job extends that by up to 30 minutes. If Redis or the queue is down, it lives until the ingest-close sweep, and retention is the final backstop. Q4 uses this bound.
- FACE_MISMATCH only adds risk weight. It never changes status and is never a rejection (D-05, ADR 0004).
- A tampered client can stop sending frames but cannot turn a mismatch into a match. Missing re-checks are detectable (Q6).
- The SDK stops emitting client FACE_MISMATCH. The server still accepts it from older clients until ADR 0010 is amended (section 7).
- The initial ID and selfie upload (BE-08) uses the same presign shape with purpose `ID_IMAGE` or `SELFIE`, in state CONSENTED, ≤ 5 MiB; BE-08 pins its route. These images could be re-PUT within the 60-second URL life, so BE-08 seals them the same way (copy to `identity/{attempt}/sealed/…` on `POST /candidate/session/identity`, then delete the original) and signs `If-None-Match: *` where supported.

### 5.7 Object key layout (all object types; BE-09)

Each environment has its own bucket (D-10, D-11), so keys carry no environment. Keys contain only UUIDs, ULIDs and fixed words: no names, emails or tokens.

| Object | Key | Written by | DB reference |
| --- | --- | --- | --- |
| Media chunk (incl. ROOM_SCAN) | `orgs/{orgId}/sessions/{sessionId}/media/{stream}/{segment:06d}/{seq:08d}.webm` | browser, presigned PUT | `media_chunks.object_key` |
| ID image, selfie (upload) | `orgs/{orgId}/sessions/{sessionId}/identity/{attempt}/{id\|selfie}-{ULID}.jpg` | browser, presigned PUT; deleted once sealed | none |
| Sealed ID image, selfie | `orgs/{orgId}/sessions/{sessionId}/identity/{attempt}/sealed/{id\|selfie}-{ULID}.jpg` | API (CopyObject); never presigned | `identity_checks.id_image_key`, `selfie_key` point to the sealed copies (face tier, C-27) |
| Evidence snapshot, re-check frame | `orgs/{orgId}/sessions/{sessionId}/evidence/{ULID}.jpg` (wire name `evidence/{ULID}.jpg`) | browser | `proctor_events.evidence_key` (EVENT) |
| Sealed re-check frame | `orgs/{orgId}/sessions/{sessionId}/evidence/sealed/{ULID}.jpg` | API (CopyObject); never presigned for PUT | `proctor_events.evidence_key` (FACE_MISMATCH; face tier, C-27) |
| Report PDF | `orgs/{orgId}/sessions/{sessionId}/reports/{ULID}.pdf` | API | `sessions.report_key` (kept 1 year after the anchor, C-26; R-10) |
| Signed consent PDF | `orgs/{orgId}/consents/{sessionId}/{ULID}.pdf` (**outside** the session prefix, because the consent proof keeps its own 3-year clock from `signed_at`, **through an erasure request**: C-17 and C-04, proposed ADR 0004 R-9 in PR #48; this fills in ADR 0004 §8) | API | `consents.pdf_key` |
| Live thumbnail (BE-13, if stored) | `orgs/{orgId}/sessions/{sessionId}/live/{ULID}.jpg` | browser | none (transient) |

- **Ingest-close sweep (BE-09).** S3 authenticates a request when it starts, so a 16 MiB PUT can finish after its URL expires. The sweep therefore allows a margin:
  - **Main pass** at ingest close + `STORAGE_SWEEP_MARGIN_SECONDS` (default 600), with a **second pass** 1 hour later.
  - **Sessions with no `submitted_at`** (EXPIRED or abandoned after a ROOM_SCAN or identity upload) are swept by the expiry job at EXPIRED + margin.
  - **A lost delayed job** is caught by a daily job, which re-enqueues sweeps for sessions that are terminal and past their margin with no `device_info.storageSweep.completedAt`. Retention (R-4) is the final backstop.
  - Each pass lists the session prefix with ListObjectsV2 and HEADs each object against the DB:
  - **media:** delete pending objects and any object whose size or ETag differs from the confirm record; for a confirmed row, null `object_key` and set `deleted_at`, which leaves a visible gap. Retention also sets `deleted_at`, so the reviewer gap panel uses the counts in `device_info.storageSweep` (per stream and seq range) to tell a sweep rejection from a retention deletion;
  - **evidence:** delete objects that no row references (`EVENT` by an event, `IDENTITY_RECHECK`: the sealed key, by a FACE_MISMATCH; originals are always deleted), and any object over 1 MiB or not `image/jpeg`; null the `evidence_key` of a referenced object that fails these checks;
  - **identity images:** delete objects not referenced by `identity_checks`, or over 5 MiB, or not JPEG;
  - **counts** go to `device_info.storageSweep` for the reviewer (counts only, never keys).
- **Retention is tiered, not one prefix operation** (C-26, C-27; proposed ADR 0004 section 9, PR #48). Each tier lists its prefix with ListObjectsV2, deletes with DeleteObjects, then nulls the columns:

  | Tier | When | Deletes | Nulls |
  | --- | --- | --- | --- |
  | Face (C-27) | **face clock** = COALESCE(`submitted_at`, latest capture, terminal transition time, `sessions.created_at`), as ADR 0004 section 9 defines it. *Latest capture* is the newest `identity_checks.created_at` or the `occurred_at` of the newest FACE_MISMATCH event. The *terminal transition time* is the **first** terminal transition: expiry, decline or the erasure fence. A session that expired and was later erased uses its expiry time. **Source:** for a session that was never submitted, `sessions.retention_anchor_at`, which the state machine stamps at its first terminal status (COMPLETED, EXPIRED or DECLINED; for a never-submitted session, in practice expiry or decline) and the erasure fence keeps or sets; never `updated_at` (ADR 0004 9.2). The tier deletes at face clock + LEAST(`retention_days`, 90). **No review hold applies** (C-35), and a shorter `retention_days` shortens it (C-27) | `identity/**` and `evidence/sealed/**` | `identity_checks.id_image_key`, `selfie_key`; `proctor_events.evidence_key` of FACE_MISMATCH rows |
  | Media (R-4) | anchor + `retention_days` | everything under `orgs/{orgId}/sessions/{sessionId}/` **except `reports/`** (also the final backstop for orphans) | the R-4 columns except `sessions.report_key` |
  | Results (R-10, C-26) | anchor + 1 year | the **whole** session prefix, `reports/` included, with its own whole-prefix verification. R-10 does **not** wait for the face or media markers (ADR 0004 section 9); it is the backstop for every earlier tier | `sessions.report_key`; R-10 also deletes the `submissions` rows (proposed ADR 0004 section 9) |

  - **Tiers are selected by session, not by database keys.** A session is visited by a tier when it is eligible for that tier and has no completion marker for it.
  - **Completion markers (as ADR 0004 9.2, PR #48).** The marker is the per-session audit row `RETENTION_FACE_DONE`, `RETENTION_MEDIA_DONE` or `RETENTION_RESULTS_DONE`.
    - It is written last, in the transaction that nulls the columns. It is written **only after** all three of these hold:
      - every ListObjectsV2 page of the tier's prefixes has been listed;
      - DeleteObjects returned no per-key `Errors`;
      - a fresh listing of the tier's prefixes comes back empty.

      Otherwise the tier aborts and retries the next day. R-9 deletes a `consents` row only after the same check on `orgs/{orgId}/consents/{sessionId}/`.
    - Only `RetentionService` may write these actions. A writer allow-list test enforces that, because any other audit writer could forge a marker and so skip a deletion.
    - The `NOT EXISTS` selection needs an index on `audit_logs (action, entity_id)` for NFR-01 and NFR-02. That is an ADR 0008 delta and needs its own owner approval.
    - The prefix listing then finds every object, including those with no DB reference:
      - `live/` thumbnails;
      - `identity/**/sealed/` frames the sweep missed after their key was nulled;
      - media of a session whose `media_chunks` rows R-10 already deleted.
  - **Nothing in this ADR reads `submissions` after the results clock.** Grading, review and the sweep all run long before it. A job decides that a session is past R-10 **only from the `RETENTION_RESULTS_DONE` marker**, never from missing rows. A fresh session with no work has zero `submissions` and must still be graded (score 0).

- **Erasure (R-6)**, as proposed in ADR 0004 section 9 (PR #48):
  - **Fence first (ADR 0004 section 9; ADR 0002 and ADR 0008 amendments).** Every session of the candidate that is not on an erasure hold is fenced, terminal ones included (COMPLETED, EXPIRED, DECLINED):
    - `auth_epoch` is bumped, which kills the candidate token;
    - `SessionStateService.closeIngest` moves the session to the new terminal status **`ERASED`**, which has **no transition out**, and keeps an existing `retention_anchor_at`, else sets it to the fence time (ADR 0004 step 3).

    The fence never starts grading, `analyze-session`, webhooks or review routing.
  - **`SessionStateService.guardLive(tx, sessionId)`: the per-session write lock.** It is a thin wrapper (Backend B) over the lock core in `apps/api/src/database/session-locks.ts` (Database A, built in #208) and has exactly two callers (FU-DB-67): `SessionJobProcessor.withLiveSession` (SERVICE) and one named STAFF method inside `SessionStateService`, `proctorResume` (the proctor-resume transition, ADR 0002 P-3; FU-DB-67 pins exactly this one call in the `SessionStateService` file besides the `SessionJobProcessor` one), which writes `session_sections.deadline_at` and must stop at ERASED instead of crediting a section on an erased session. Both run under the `SessionStateService` grant. The lock cores have **one allow-list each**, and everything not named throws at run time (CANDIDATE scope, system scope, any future scope kind; fail closed, grant or no grant), while the one case a run-time check cannot tell apart, an actor-less `runInOrg` that is not an erasure, R-4 or R-10 call site, is enforced statically by FU-DB-67 (the call sites are pinned to those job files) and not at run time: `guardLive` passes for SERVICE (`runAsSessionJob`, through `withLiveSession`) and STAFF (`runAsUser`, `proctorResume` only); `lockAnySession` passes for SERVICE (`runAsSessionJob`, through `withAnySession`) only; `lockForAccommodation` passes for STAFF (`runAsUser`: the accommodations PATCH, redact-note and the video-check PUT), and for the session-less **org job scope** (`runInOrg(orgId)`, the scope that holds the ADR 0004 per-candidate advisory lock, which is refused in any `sessionId` scope) at the call sites of the erasure, R-4 and R-10 jobs, pinned by FU-DB-67 to `retention.repository.ts` (`casAccommodations`) and the erasure job files. R-4 has no SERVICE caller and none may be added. The target session must belong to the organisation (the scoped status read finds no row for a session of another organisation, and that empty read throws; the accommodations PATCH maps it to 404; an ordinary 0-row result of the same-value update is retried as above); the database primitives may be imported only by `SessionStateService` and its tests. `withAnySession` does not call `guardLive`: it takes the same `sessions` row lock through a separate ERASED-ignoring lock, `SessionStateService.lockAnySession` (a thin Backend B wrapper over the `lockAnySession` core in session-locks.ts, same shape as `lockForAccommodation`, called only from `SessionJobProcessor.withAnySession`) and does not stop on ERASED (the same text goes into ADR 0006 section 8.5).
    - **The check is part of `guardLive` itself, so a caller cannot forget it.** It reads the status, then runs the model-API `sessions.updateMany({ where: { id, status: <status read>, NOT: { status: 'ERASED' } }, data: { status: <same status> } })` under the SessionStateService grant. Writing the status to its current value takes the row lock.
    - **Staff resume (`proctorResume`).** On `ERASED` it writes nothing, resets no Redis TTL, emits nothing to /live and writes no audit row, and the route answers 409 `SESSION_ERASED`. Exhausted retries, a lock timeout (55P03) and a deadlock (40P01) answer 503 with `Retry-After`, never 500 (the global `ProblemFilter` applies the same 503 to every route, DL-37, api-contract section 8; ADR 0015 keeps 409 only for its state conflicts); the staff transaction uses a Prisma interactive-transaction `timeout` of 5 s (architect detail), because the SERVICE pool's `lock_timeout` does not apply to it.
    - **Result.** `guardLive` returns `LIVE` when 1 row is updated. When the read status is ERASED, or 0 rows are updated and a re-read finds ERASED, it returns `ERASED` and writes nothing; the caller writes nothing either. A SERVICE writer that **starts after the fence** therefore writes nothing. If 0 rows are updated for any other change, it re-reads and retries: 3 tries, then one ERASED-only re-read, then it fails for the job's own retry. A lock timeout (SQLSTATE 55P03) or a deadlock (40P01) is not swallowed: `SessionJobProcessor` maps both to a BullMQ retry, never to a response to a candidate.
    - **Structural, not a list.** `SessionJobProcessor` provides the only write-transaction wrapper for session jobs, `withLiveSession(sid, fn)`: guardLive first, then `fn` only when `LIVE`. Session jobs get no other transaction API. The writer list below is documentation, not the control: every `close-section` variant, the session auto-submit, `start-session`, `grade-session`, `analyze-session`, the `face-recheck` outcome handler, `server-event`, the `disconnected` watchdog job, report generation and webhooks.
    - **Erasure-compatible jobs** must still run on an ERASED session, so they use a separate entry, `withAnySession(sid, fn)`. That entry locks `sessions` the same way but does not stop on ERASED. It is limited to: ingest close and key destruction, both sweep passes, `evidence-expire`, the erasure re-run (its accommodations step excepted: that step runs in the org job scope, ADR 0015 6(b)), and the consent-PDF job (the consent record is kept, C-17). Both entries are FU-DB-67 call-site entries.
    - **Webhooks:** `withLiveSession`, then build the payload from `CandidateProjection.forViewer()`, commit, then POST. The small window after the commit is accepted; the job also re-checks the status just before sending.
    - A plain status read inside the transaction is not enough: under READ COMMITTED a fence that commits just after the read would not be seen. `guardLive` takes the row lock, so the fence and the writer serialise.
    - **Every SessionStateService transition** (VERIFIED → IN_PROGRESS in `start-session`, → SUBMITTED, SUBMITTED → GRADED, the proctor resume) is an `updateMany` compare-and-set on the from-status. None of them can overwrite ERASED.
    - **Lock order.** `sessions` is locked first, per the ADR 0015 lock order. A writer that touches several sessions (`analyze-session`, the fence for several sessions of one candidate) works one session per transaction, or locks them in ascending id order. **Candidate transactions** that touch `sessions` must not lock another row first: the batch route calls `transition()` before the pairing `UPDATE` of a FULLSCREEN_EXIT row whenever the batch changes `pause_reasons`, so `transition()`'s own compare-and-set `UPDATE`, under the `SessionStateService` grant, is the first contended lock (a batch that only pairs, and changes no pause reason, never touches `sessions`). Otherwise a candidate holding a paired EXIT row would wait on `sessions` while the session auto-submit holds `sessions` and waits on that row (a 40P01 deadlock). The candidate-side answer to a lock timeout (55P03) or deadlock (40P01) is 503 with `Retry-After`, and the SDK resends from its FR-702 buffer. This is an ordering rule only; candidate scope never calls `guardLive`, `lockAnySession` or `lockForAccommodation`. Inserts with a foreign key take `FOR KEY SHARE`, which does not conflict with `guardLive`'s `NO KEY UPDATE`.
    - **Timeouts.** SERVICE session jobs use a dedicated pool whose `pg` options set `lock_timeout=1000` and `statement_timeout=10000`. Setting them per transaction would need `SET LOCAL`, which is raw SQL and refused in session scopes.
    - **Short transactions.** After `guardLive`, the transaction stays short, with no external calls (Judge0, the worker, HTTP) while the lock is held. External work runs before the transaction and its results are written under the lock.
    - **One exception (as in ADR 0004):** a single bounded object write (one PUT or CopyObject of a known small size) may run inside the transaction. That is the only S3 call allowed under the lock.
    - **Objects under the session prefix.** A SERVICE writer that writes an S3 object there (the sealed copy or a report; the consent PDF is outside the prefix) writes it inside the `withLiveSession` transaction, using that single bounded write, or deletes its own object when `guardLive` returns `ERASED`. An erased session therefore gains no new object.
  - **Job skips are keyed on the session's ERASED status**, never on the candidate's `erasure_requested_at`. During an erasure hold, the candidate's other sessions keep being graded and recovered until they are fenced. Sessions with `RETENTION_RESULTS_DONE` are skipped too.
  - **Then delete.** Erasure deletes the whole session prefix, `reports/` included, and nulls `report_key`.
  - **Re-run.** At **fence time + 60 s** (the URL life) **+ `STORAGE_SWEEP_MARGIN_SECONDS`**, erasure runs again: the prefix delete with the same verification, and the idempotent **database** erasure steps (ADR 0004 step 7). That covers late candidate-scope commits. Candidate transactions on the main pool (batch ingest) carry a Prisma `$transaction` timeout of 10 s, so every in-flight candidate transaction has committed or aborted before the re-run. A late PUT from a URL issued before the fence is deleted by that re-run, or at the latest by R-10.
  - **No markers.** Erasure **never** writes `RETENTION_*_DONE` markers, so the anchor-driven tiers remain the backstop. `orgs/{orgId}/consents/{sessionId}/` is kept until its 3-year limit (C-17) and is deleted by the R-9 consent job (proposed ADR 0004 section 9.3, PR #48), objects first, then the row.
- **Media chunk keys are deterministic**, so a retried presign targets the pending object. A confirmed chunk is protected by 5.5 controls 3 and 4.
- **Review GET URLs** (15 min, FR-703) always set `response-content-type` to the expected type (`video/webm`, `audio/webm`, `image/jpeg` or `application/pdf`) and `response-content-disposition: attachment`. A file uploaded as HTML can then never render as a page from the storage host. `<video>` and `<img>` ignore the disposition, so playback still works.

- **Rollout gate for the erasure fence (security).** No ERASED fence and no erasure job is enabled until every legacy raw-transaction session job (`candidate/session-jobs.service.ts` and any other writer that opens its own transaction) has been migrated to `SessionJobProcessor`, because a writer outside `withLiveSession` and `withAnySession` would not stop at the fence. BE-07, BE-09 and BE-11 record the migration, and the feature that turns erasure on checks it.
- **Names of the sweep jobs.** `sweep-1` and `sweep-2` are the job names of the two sweep passes of this section (both run on ERASED sessions through `withAnySession`).

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
- **Guard (BE-07), matching ADR 0006 section 8.4 (PR #41).** `CandidateSessionGuard` runs on every `/candidate/*` route except the three pre-JWT routes: invitation-link resolve, OTP send and OTP verify (the exchange). Only those three use `AUTH_BOOTSTRAP`, because no session JWT exists yet. Routes behind the guard use no system scope.
  - **Candidate-facts pre-read (DL-31, FU-DB-185; architect detail, DL-31 interim pick, owner accepts under P-15).** The narrower variant (only `invitations` read in org scope, `sessions.invitation_id` read inside CANDIDATE scope under a grant) was considered and not chosen: its granted read would be a candidate-scope query before the facts are set, and leaving and re-entering a candidate scope is forbidden (CS-4.1, ADR 0006 8.5). The candidate facts cannot be loaded inside CANDIDATE scope: `invitations` is filtered there by `ctx.invitationId` (CS-4.3), which is not set yet. So, after verifying the JWT, the guard first reads them in a plain `runInOrg(oid)`, entered from no scope with the verified `oid`:
    - the session's `invitation_id` (`sessions` with `id = sid`, `select: { invitationId: true }` only);
    - then that invitation's `candidate_id` and `test_id` (`select: { candidateId: true, testId: true }` only).

    These are two column-only selects, never `accommodations` and never a full row. The `runInOrg` callback returns these three ids and exits **before** `runAsCandidate(oid, sid)` is entered; it is never nested (CS-4.1). This is the only non-CANDIDATE read on the routes behind the guard, and it is a FU-DB-67 `runInOrg` call site.
  - A missing session, a session in another org (the org filter finds nothing), or a missing invitation answers 401, all three with the same problem body and code, so the response does not tell them apart. No cross-org read ever happens.
  - The guard then enters the narrowed scope straight from the verified claims with `runAsCandidate(oid, sid)` (CS-4). Its **first** action there is `setCandidateFacts({ candidateId, invitationId, testId })`, before any other candidate-scope query. This order is enforced by the extension, not only by a test: until the facts are set, every CANDIDATE query on any model throws (CS-4.4, "Candidate facts").
  - Inside that scope it loads `sessions` with `id = sid` (default columns, CS-4.4) and checks `auth_epoch` against the token's `epoch`, answering 401 `SESSION_TAKEN_OVER` when the token's is lower.
  - The `CandidateContext { sessionId, orgId, epoch, status }` lives **per unit of work on AsyncLocalStorage** (ADR 0001 C-1 as amended in PR #41), not in a Nest REQUEST-scoped provider.
- **Rule CS-1.** The session id comes **only** from `CandidateContext`. No candidate route has a `:sessionId` parameter, and session ids in bodies or queries are stripped and ignored.
- **Rule CS-2.** Every other id a candidate sends is resolved **within** the context session. An id that does not belong to it returns 404, the same as a cross-org read (TC-008). This covers:
  - `:questionId` on run, draft and submit: a `session_questions.id`, or a question resolved through the session's `session_questions` (there is no submission poll route, CS-4.6 and 5.11);
  - `sessionQuestionId` in keystroke batches;
  - section ids;
  - evidence names (5.2, 5.6);
  - identity attempts, and the ID and selfie images: `POST /candidate/session/identity` takes single-use `ID_IMAGE` and `SELFIE` names issued to this session (5.6, the same state machine as 5.2), never a client-sent object key. The server derives `id_image_key` and `selfie_key` from the names.
  - **Question reads are limited to the open section** (ADR 0002 S-1, S-5; FR-301): see CS-4.6.
- **Rule CS-3.** Object keys (including identity image keys), Redis keys (`rl:`, `rl:submit:`, `pkey:`, `evidence:`, `rec:`, `qview:`, `etag:`, `submits:`, `lock:device-info:`, `devinfo-resync:`, `vs:`), HMAC keys and job payloads are built from `ctx.sessionId` and `ctx.orgId`, never from client input.
- **Rule CS-4: actor model and enforcement (DB-05 gate; architect detail, owner to confirm).** This ADR is the one place that defines the actor model, and ADR 0006 section 8.4 references it (requests at the end of section 7). Section 5.10 depends on PR #41 merging first.
  - **Options.** (a) Session checks written in the services only. (b) Session-carrying scopes enforced by the org-scope Prisma extension (PR #30). **Recommended: (b) as the structural control, plus (a) as service-level checks for defence in depth.**

#### CS-4.1 Actors

The entry function sets the actor; callers cannot pass it in, so it cannot be forged.

| Entry | Actor | Entered by | Allowed from | Rules |
| --- | --- | --- | --- | --- |
| `runAsCandidate(oid, sid)` | `CANDIDATE` | `CandidateSessionGuard` only | no scope | CS-4.3 to CS-4.6 |
| `runAsSessionJob(oid, sid)` | `SERVICE` | `SessionJobProcessor` (the one session-job base class), from the job payload; target loaded in scope and the job dropped on a mismatch (ADR 0006 job rules) | **no scope only** (any system scope, `BACKGROUND_JOB` included, is refused; `SessionJobProcessor` detaches first with `detachForSessionJob`) | ADR 0006 org filter on every model, plus the session filter on session-path models (CS-4.2). No allowlist and no column limits. |

- **Inherited context.** BullMQ workers are built at module init, outside any scope, and each session job runs in its own worker callback. Before `runAsSessionJob`, `SessionJobProcessor` calls `orgContext.detachForSessionJob(fn)` (ADR 0006 section 8.4, PR #41). `runAsSessionJob` is then entered from no scope only.
  - `detachForSessionJob` **asserts an empty store, then runs `fn` in a fresh empty store**.
  - It throws if anything is present: any scope (STAFF, plain org, SERVICE, CANDIDATE or system; **the `BACKGROUND_JOB` allowance is dropped**), a `runRawSql` hatch, or a grant.
  - Grants cannot exist outside a scope.
  - Only the `SessionJobProcessor` base class may call it.
  - A test asserts that a discovery processor cannot invoke a session handler inline: session handlers run only from the BullMQ worker callback.
  - The AsyncLocalStorage instance and the grant API are private to `org-context.ts`. `exit`, `enterWith` and `disable` are covered by the FU-DB-67 call-site test.
- **Nesting.**
  - `runInOrg(oid)` with the same org keeps both the session and the actor (ADR 0006: "S stays").
  - A call that would drop or change `sessionId` is refused, as are `runAsUser`, `runSystem` and entering the other actor.
- **Cross-session work** (similarity in `analyze-session`, dashboards, retention selection) runs in plain `runInOrg(orgId)` with no session, under the ADR 0006 job rules.
- **SERVICE is defence in depth only.** Its session filter covers top-level queries; nested reads in SERVICE scope are reviewed under ADR 0006 rule (i), as 0006 leaves them.

#### CS-4.2 Session filter (both actors)

| Model | Row filter (mechanism) |
| --- | --- |
| `sessions` | `id = ctx.sessionId` (direct) |
| `session_questions`, `session_sections`, `identity_checks`, `media_chunks`, `proctor_event_batches`, `proctor_events`, `keystroke_batches`, `consents` | `session_id = ctx.sessionId` (direct) |
| `submissions` (no `session_id`) | `sessionQuestion: { sessionId }` (injected relation filter) |

Operations covered:
- **Filtered:** `findUnique`, `findUniqueOrThrow`, `findFirst`, `findFirstOrThrow`, `findMany`, `count`, `aggregate`, `groupBy`, `update`, `updateMany`, `updateManyAndReturn`, `delete`, `deleteMany` and the `where` of `upsert`.
- **Creates** (`create`, `createMany`, `createManyAndReturn` and the create branch of `upsert`) take the session from the context, and throw on a different value. `submissions` and `keystroke_batches` reference a `session_question_id`, which the context cannot check. The extension therefore runs one scoped primary-key existence check on `session_questions` (`id = session_question_id`, under the session filter) and throws on a miss. CS-2 in the service layer and the cross-candidate tests (5.10) back it up. Grading is safe either way: ~~a planted row cannot match `created_at = ended_at`~~ (superseded by FU-BEB-89: Prisma sets `created_at` at millisecond precision, so a row can match only by hitting the same millisecond; see the BE-11 details in 5.11).
- **Unknown operations** throw.
- **Session keys are immutable** in both actors: an `update`, `updateMany` or upsert-update whose data changes `session_id` or any `session_question_id` on a session-path model throws. This mirrors the scalar `orgId` rule in ADR 0006 section 8.2, because SERVICE has no column limits.
- `findUnique` by `id` uses Prisma's extended unique `where`.
- **Raw SQL is refused in any scope carrying `sessionId`** (ADR 0006 section 8.5, PR #41). Session jobs (risk scoring, reports, per-session deletion) therefore use the query API.

#### CS-4.3 CANDIDATE: model allowlist, deny by default

Any model not listed throws. Within one org, the org filter alone would expose other candidates, invitations (accommodations, which are health-adjacent), reviews, flag decisions, appeals, webhooks and hidden content.

| Model | Access | Row filter (mechanism) |
| --- | --- | --- |
| session-path models (CS-4.2) | per CS-4.4 | CS-4.2, plus the extra row filters in CS-4.4 |
| `organizations` | read | `id = ctx.orgId` (direct) |
| `candidates` | read | `id = ctx.candidateId` (context value loaded by the guard's org-scope pre-read from the session's invitation, 5.10) |
| `invitations` | read | `id = ctx.invitationId` (context value) |
| `tests` | read | `id = ctx.testId` (context value) |
| `consent_texts` | read, only under the `ConsentService` grant | `id IN grant.ids`. The grant carries the two ids, `organizations.current_consent_text_id` and this session's `consents.consent_text_id`. The extension ANDs the filter itself and throws when the grant has no ids. |
| `test_sections` | read | `sessionSections: { some: { sessionId } }` (injected relation filter) |
| `questions` | read | `versions: { some: { sessionQuestions: { some: { sessionId } } } }` (injected relation filter) |
| `test_questions` | read, columns `id` and `section_id` only, and only under the `SectionGateService` grant | `id IN grant.ids`. The grant carries the single `test_question_id` read in step 1. The extension ANDs the filter itself, never trusting a caller's `where`, and throws when the grant has no ids. |

- **Read-only means every write operation throws.**
- **Context-value filters fail closed.** The `candidates`, `invitations` and `tests` filters use `ctx.candidateId`, `ctx.invitationId` and `ctx.testId`. If a value is missing, the extension throws instead of passing `undefined` to Prisma, and every CANDIDATE query throws until the guard has set the facts (CS-4.4, "Candidate facts").
- **Question content is not on the allowlist.** That covers `question_versions`, `question_variants`, `test_cases` and `variant_test_cases` (CS-4.6). `test_questions` is readable only as (`id`, `section_id`), for the section gate.
- **Shape without content (N6).** `questions (id, type)` and `test_sections` stay readable for every section of the session. They reveal how many questions of each type there are and the section titles and limits, which the candidate sees in the test outline anyway; no statement, code, sample or key is in them.

#### CS-4.4 CANDIDATE: column allowlists for reads and writes

- Reading any other column throws. The default select is narrowed with `omit`, so a new column stays hidden until it is listed.
- The read list also governs `where`, `orderBy`, `distinct`, `groupBy.by`, `_count`, `_sum`, `_avg`, `_min` and `_max`. A filter or sort on a hidden column (for example a JSON-path `where`) throws, so it cannot act as a boolean oracle.
- Writing any other column throws.
- **Explicit-only** columns are excluded from the default select. They are enforced **at runtime**: the extension refuses them unless a matching grant is active. A lint rule is an extra check, not the control.
- **Grant spec** (identical text in ADR 0006 section 8.4):
  - A grant is `withGrant({ model, columns, ids }, fn)`, and **`ids` is mandatory**. It unlocks exactly those columns, on that model only, and only for rows whose id is in `ids`. The extension ANDs `id IN ids` itself. An empty `ids` throws. **For a create grant** there is no `where` to filter: `ids` then constrain the checked parent key (the extension checks that the create's `session_id` is in `ids`), and nothing else is filtered.
  - **Lifetime: the grant object carries an `active` flag**, set to false in a `finally` when `fn` settles. The extension refuses any query under an inactive grant. AsyncLocalStorage keeps the store alive in async work started inside `fn` and not awaited (a promise, `setTimeout`, an emitter or a stream callback), so the flag is what ends the grant. A test checks that a detached query run after `fn` resolves throws.
  - A grant can be entered only inside a scope, so none can exist outside one. Grants never widen the model allowlist or the row filters.
  - **`ids` are never request input.** They are resolved through CS-2 within the session or taken from the context. SectionGateService's step-1 id comes from the URL only after CS-2 has resolved it.
- **The grant API is private** to `org-context.ts` (ADR 0006 is adding it). The only grant sites, and therefore the FU-DB-67 call-site entries, are:

  | Grant site | Model | Columns | ids |
  | --- | --- | --- | --- |
  | `SessionStateService.transition()` | `sessions` | `status`, `pause_reasons`, `submitted_at` | `[ctx.sessionId]` |
  | `KeyService` | `sessions` | `hmac_key_enc` | `[ctx.sessionId]` |
  | `DeviceInfoService` | `sessions` | `device_info` | `[ctx.sessionId]` |
  | `StorageService` | `media_chunks` | `object_key` | ids of the chunk rows resolved through CS-2 for the (stream, seq) in hand |
  | `OrgSettingsService` | `organizations` | `settings` | `[ctx.orgId]` |
  | `TestSettingsService` | `tests` | `settings` | `[ctx.testId]` |
  | `AccommodationsService` (projection only) | `invitations` | `accommodations` | `[ctx.invitationId]` |
  | `SectionGateService`, step 1 | `session_questions` | `test_question_id` | `[sessionQuestionId resolved through CS-2]` |
  | `SectionGateService`, step 2 | `test_questions` | `id`, `section_id` | `[test_question_id from step 1]` |
  | `ConsentService` | `consent_texts` | `id`, `version`, `body_md`, `legal_approved_at` | `[current_consent_text_id, this session's consents.consent_text_id]` |
  | `ConsentService` (create) | `consents` | create only: `signed_name`, `signed_at`, `declined_at`, `ip`, `user_agent`, plus the two checked keys `session_id` and `consent_text_id` (see the `consents` row of the model table) | `[ctx.sessionId]` |
  - `CandidateSessionGuard` has **no grant** (DL-31): it reads `sessions.invitation_id` in its org-scope pre-read (5.10), outside CANDIDATE scope, so `invitation_id` is not readable in CANDIDATE scope at all.
- **Candidate facts.** `ctx.candidateId`, `ctx.invitationId` and `ctx.testId` drive injected filters. They are set by one private setter in `org-context.ts` (`setCandidateFacts`), which only `CandidateSessionGuard` may call, once per scope, as the first action in the scope before any other query; afterwards they are immutable.
  - **Fail closed while unset (security).** In CANDIDATE scope the extension throws on **any** query on **any** model while the candidate facts are unset. An injected filter whose context value is missing fails closed (throws) and is never passed to Prisma as `undefined`, which Prisma would drop from the `where`, returning every candidate, invitation or test in the org. `setCandidateFacts` throws if called a second time in the scope or with any id missing or empty.
  - The values come from the guard's `runInOrg(oid)` pre-read (5.10). The setter and that `runInOrg` call are FU-DB-67 call-site entries in both ADRs.

| Model | Read | Write | Extra row filter |
| --- | --- | --- | --- |
| `sessions` | `id`, `status`, `started_at`, `deadline_at`, `pause_reasons`, `paused_ms`, `proctor_paused_at`, `submitted_at`, `auth_epoch` (`paused_ms` and `proctor_paused_at` feed `effectiveDeadline`). Explicit-only: `hmac_key_enc` (KeyService), `device_info` (DeviceInfoService). Not readable: `invitation_id` (read only by the guard's org-scope pre-read, 5.10) | `last_heartbeat`; `device_info` only through DeviceInfoService (grant, below); `status`, `pause_reasons`, `submitted_at` only under the SessionStateService grant (CS-4.4a) | — |
| `session_sections` | all columns | none. Writers: the SERVICE jobs `close-section` and `start-session` (`started_at`, `deadline_at`, `ended_at`), and the proctor-resume transition (ADR 0002 P-3), which runs in a **staff** route, not a SERVICE job, and adds the open section's credit to its `deadline_at` after `guardLive` locks `sessions` | — |
| `session_questions` | `id`, `session_id`, `position`, `points`, `final_code`, `final_language`, `answer`. Explicit-only: `test_question_id` (`SectionGateService.sectionOf`) | `final_code`, `final_language`, `answer` | — |
| `submissions` | `id`, `session_question_id`, `kind`, `language`, `created_at`; plus `results`, `passed`, `total` under the extra filter | create only: `session_question_id`, `kind` (`RUN` or `SUBMIT`), `language`, `source_code`; and `results`, `passed`, `total` on `RUN` rows | **Mechanism:** whenever `results`, `passed` or `total` appears anywhere in `select`, `where`, `orderBy`, `groupBy` or an aggregate, the extension ANDs `kind: 'RUN'` into the query, so `count({ where: { kind: 'SUBMIT', passed: N } })` returns 0. **`score` is never readable.** |
| `identity_checks` | `id`, `attempt`, `status`, `created_at` | create only: `attempt`, `id_image_key`, `selfie_key`, `liveness_passed` | — |
| `media_chunks` | `id`, `stream`, `segment`, `seq`, `size_bytes`, `uploaded_at`. Explicit-only: `object_key` (StorageService) | `stream`, `segment`, `seq`, `started_at`, `duration_ms`, `size_bytes`, `uploaded_at`, `object_key` | — |
| `proctor_event_batches`, `keystroke_batches` | `seq`, `signature`, `event_count` / `started_at` | create only | — |
| `proctor_events` | `id`, `type`, `occurred_at`, `duration_ms`, `batch_seq`, `created_at` | create: `type`, `occurred_at`, `duration_ms`, `confidence`, `payload`, `evidence_key`, `batch_seq`, `severity` (assigned server-side), and `source` must be `CLIENT`. Update: `duration_ms` only (5.9 pairing) | **`source = 'CLIENT'` only**, which hides every SERVER event (FACE_MISMATCH with its similarity and sealed key, RESUME_OTP_FAILED, IDENTITY_MANUAL_REVIEW, analytics). Section 5.6 "no match result to the browser" therefore holds at the data layer. |
| `consents` | `id`, `consent_text_id`, `signed_at`, `declined_at` | **Create only, and only under the `ConsentService` grant (item 9, 2026-10-06; architect detail, owner accepts under P-15):** `signed_name`, `signed_at`, `declined_at`, `ip`, `user_agent` (times are server time: the DTO never accepts them). No update, delete or upsert in candidate scope. Sign and decline are one create each (the row does not exist before, because `consent_text_id` is NOT NULL). Write-once is `UNIQUE(session_id)` plus the CHECKs: a second create fails with P2002 (409). **The create carries `session_id` and `consent_text_id`, set by `ConsentService` (server code, never the body), because Prisma's unchecked create input requires them; the extension verifies them and throws on a mismatch:** `session_id` must equal `ctx.sessionId` (and be in the grant's `ids`), and `consent_text_id` must equal `organizations.current_consent_text_id` for `ctx.orgId`. The extension runs the candidate-facts check first, then one read that selects only `current_consent_text_id` with `where id = ctx.orgId` (on the factory client, so it is not inside the caller's transaction, FU-DB-192); a null value or a mismatch throws, and `ConsentService` answers 409 `CONSENT_TEXT_CHANGED` when the text changed (the candidate reloads it), or a 5xx configuration fault when the organisation has no current text. `ConsentService` reads the current text under the `consent_texts` grant, compares its `version` with the one the candidate saw (sent in the sign body) and, in pilot and production, refuses a text whose `legal_approved_at` is NULL (database.md), then passes that text's id. The extension's own check closes the race in which an admin publishes a new text in between, so a consent proof (C-17) never names a text other than the one checked. Exactly one of `signed_at` and `declined_at` is set (DB CHECK), `signed_name` is required with `signed_at`. `signed_name`, `ip` and `user_agent` are never readable back in candidate scope, and the row the create returns omits them. The create and `SessionStateService.transition()` (OPENED to CONSENTED or DECLINED) run one after the other in the transaction, not nested. `pdf_key`, `pdf_generated_at` and `copy_emailed_at` are written only by the consent-PDF job (a SERVICE session job: `runAsSessionJob`, through `withAnySession` in `SessionJobProcessor`; these are job-layer wrappers over the database layer's `runAsSessionJob` and its `sessions` row lock (`withLiveSession` uses `guardLive`; `withAnySession` does not, because this job must run on an ERASED session), not a new database mode). The stamp source and the writable columns change by amendment if ADR 0015 question 7 chooses a waived-candidate consent variant, or when C-30 adds an age-confirmation field. `ip` and `user_agent` are also recorded on a decline, which goes beyond FR-401's signed-case list; ADR 0004 OQ-11 treats declined rows as provisional | — |
| `organizations` | `id`, `name`, `retention_days`, `current_consent_text_id`. Explicit-only: `settings` (OrgSettingsService) | — | — |
| `candidates` | `id`, `full_name`, `email` | — | — |
| `invitations` | `id`, `test_id`, `candidate_id`, `window_start`, `window_end`, `used_at`. **Not `accommodations`:** it is explicit-only for `AccommodationsService.projection()`, which returns only `{ extraTimePct, disabledDetectors, allowedAssistiveTools, identityCheckWaived }`, never `reasonCode`, `reasonNote` or `notes` (PR #49) | — | — |
| `tests` | `id`, `name`, `description`, `duration_minutes`, `profile`. Explicit-only: `settings` (TestSettingsService) | — | — |
| `consent_texts` | `id`, `version`, `body_md`, `legal_approved_at` | — | — |
| `test_sections` | `id`, `title`, `position`, `time_limit_min` | — | — |
| `questions` | `id`, `type` | — | — |

- **SERVER events** come only from SERVICE scope: the outcome handlers, the watchdog and `server-event` jobs (CS-4.7). A candidate route that needs one (RECONNECTED on a heartbeat) enqueues a job. **The one exception is the STAFF proctor actions of FR-903, pause, resume and message:** they write the SERVER events `PROCTOR_PAUSE`, `PROCTOR_RESUME` and `PROCTOR_MESSAGE` (LOW, weight 0, ADR 0005) from STAFF scope, in the same transaction as the state change (`proctorResume` after `guardLive`, 5.7; pause through the `transition()` compare-and-set, which is its only lock, because ADR 0006 allows exactly one STAFF caller of `guardLive`). The payload `{ proctorUserId }` is the authenticated staff user's id taken from the request context, never from input. `session_id` is the session loaded or locked in scope by the same transaction (ADR 0006 rule (i)), never the route's `:sessionId` unchecked: a session of another organisation is a 404 before any write. The event is written only when the state change really updated the row (the compare-and-set returned 1 row, or `guardLive` returned `LIVE`), and is rolled back otherwise, so a pause racing the erasure fence writes nothing on an ERASED session. `PROCTOR_MESSAGE` changes no state, so it has no compare-and-set to lean on: it is written only after a scoped status read, in the same transaction, finds a live session (not ERASED and not terminal). The payload's `message` is the one field taken from staff input, validated by the shared zod schema (`MAX_PROCTOR_MESSAGE_LENGTH`); `proctorUserId` still comes from the context.
- **CS-4.4a Status changes.** CANDIDATE scope writes status columns only through `SessionStateService.transition()`. That method enters an AsyncLocalStorage grant for the state columns; without the grant the extension refuses them (runtime, not lint only). In CANDIDATE scope the method allows only these:

  | Transition or change | Candidate route |
  | --- | --- |
  | OPENED → CONSENTED | consent sign |
  | OPENED → DECLINED | consent decline |
  | IN_PROGRESS or PAUSED → SUBMITTED | finish |
  | (none: the section-finish route only enqueues `close-section`, see 5.11) | section finish |
  | add or remove `FULLSCREEN_EXIT`, `SCREEN_SHARE_STOPPED`, `SIDE_CAMERA_LOST` in `pause_reasons` | event batches (ADR 0002 P-1) |

  - **A candidate scope can never add or remove the `PROCTOR` pause reason.** The method refuses any change that touches it, and refuses every other transition.
  - `transition()` recomputes the status from `pause_reasons` (ADR 0002 P-1). Removing a candidate reason therefore never moves PAUSED → IN_PROGRESS while `PROCTOR` remains.
  - **Finishing during a PROCTOR pause.** ADR 0002 P-4 allows IN_PROGRESS or PAUSED → SUBMITTED, and nothing forbids a candidate finish while paused. Confirmed: finish is allowed, and the proctor-pause credit stops at SUBMITTED.
  - PROCTOR pause reasons are added and removed by the STAFF /live pause and resume routes (FR-903); the resume goes through `SessionStateService.guardLive` (5.7, `proctorResume`).
  - The others run in SERVICE scope:
    - CONSENTED → VERIFIED: a `verify-session` job, enqueued by the system-check, identity and room-scan routes. The transition is a compare-and-set (`updateMany where status = 'CONSENTED'`).
    - VERIFIED → IN_PROGRESS: `start-session`;
    - deadline auto-submit, grading and review transitions: their jobs.
  - INVITED → OPENED and the EXPIRED check on link resolve run before the JWT exists, under `AUTH_BOOTSTRAP` (ADR 0006 section 8.4).
- **`device_info` writers.** Heartbeat capabilities, the system check and the sweep all write through `DeviceInfoService`. It reads the column under its grant, merges in memory and writes back, holding a Redis lock `lock:device-info:{sid}`, because raw `jsonb_set` is refused in session scopes:
  - The lock is `SET NX PX 2000` with a random token. It is released by a Lua compare-and-delete on that token.
  - **Fencing.** The write is a conditional `updateMany` whose `where` includes the `device_info` value that was read. 0 rows updated means another writer got in, so the service re-reads and retries. A slow write past the 2 s lock therefore cannot overwrite a newer value.
  - **After 3 failed attempts** it skips the update and never writes unlocked. A skip sets `devinfo-resync:{sid}`.
    - The next heartbeat response then carries `resyncCapabilities: true`, and the SDK resends its full capability list.
    - The SDK also resends the full list every 5 minutes, so a capability change sent only once is never lost.
  - **First write.** `device_info` is `NOT NULL DEFAULT '{}'` (database.md), so the first write fences on equality with `{}`, not on NULL. After an erasure clears it, the value is `{}` again.
  - The system-check route is the exception: it answers 503 with `Retry-After`, because `device_info.systemCheck` feeds both security gates (CONSENTED → VERIFIED and start).
- **Settings reaching the browser.** `CandidateOrgSettingsView` sends only the detector thresholds and `consentDeclineContact`. Risk points, caps, bands, weights, erasure and `aiReferences` keys never leave the server. `CandidateTestSettingsView` is deny-by-default until BE-06 defines the `tests.settings` keys. BE-10 reads severity overrides server-side through OrgSettingsService.
- **`submissions.results` shape (pinned).** For `SUBMIT` rows (written by `grade-session`), the shape is `{ testCaseId, passed, status, timeMs, memoryKb }[]`, with no stdin, stdout, expected output or variant data, so even a serialiser bug cannot leak case data. `RUN` rows hold sample results only.

#### CS-4.5 CANDIDATE: all six relation vectors refused

A Prisma query extension sees only the top-level model, so CS-4 refuses all six vectors listed in ADR 0006 section 8.4 (PR #41):

| # | Vector | Enforcement |
| --- | --- | --- |
| 1 | relation fields in `include` | the extension throws |
| 2 | relation fields in `select` | the extension throws |
| 3 | relation filters in `where` (`some`, `every`, `none`, `is`, `isNot`) | the extension throws |
| 4 | relation fields in `orderBy` | the extension throws |
| 5 | relation `_count` | the extension throws |
| 6 | the fluent API (`findUnique(…).questionVersion()`, which Prisma runs on the parent model with an internal data path) | the extension throws when the call carries a relation data path. Whether a query extension can see that path in Prisma 7 is **not verified**, so a lint rule also bans fluent relation calls across **all of `apps/api`**, because candidate-scope code also runs in shared services (SessionStateService, KeyService, StorageService, OrgSettingsService, DeviceInfoService, the guard). A test asserts the fluent access below fails. **If that test cannot pass on Prisma 7, the CANDIDATE client is a wrapper that exposes no fluent methods** |

- **Every nested relation write per ADR 0006 section 8.2 also throws**, at every depth and on both sides of a relation: `create`, `createMany`, `connect`, `connectOrCreate`, `update`, `updateMany`, `upsert`, `delete`, `deleteMany`, `set` and `disconnect`.
- Only the filters the extension injects itself (CS-4.2, CS-4.3) may use relations. Services load each model separately.
- Walking every depth instead is kept for after the pilot.

#### CS-4.6 Question content: a candidate-safe projection, no schema change

The candidate needs these and nothing more:
- the rendered statement and starter code (Mustache placeholders filled with variant params, which never leave the API: ADR 0001 F3);
- MCQ options **without** the key (options and key share `answer_spec`, ADR 0007 §5);
- the sample tests.

All of it comes from one projection:
- `render-question` is a session job (SERVICE, jobId `render-question_{sid}_{sessionQuestionId}`; BullMQ custom job ids cannot contain `:`, so the `name:{id}` jobIds in this ADR use `_` as the separator). It reads `question_versions`, `question_variants`, `test_cases`, `variant_test_cases` and `answer_spec`, and returns `{ sessionQuestionId, type, title, statementMd, languages, limits, starterCode, samples: [{ input, expectedOutput }], mcq?: { multiple, options: [{ id, text }] } }`.
  - The zod schema is `.strict()`, so no extra field can slip through.
  - MCQ option ids are opaque per session: `opt_` + the first 10 base32 characters of `HMAC(QUESTION_OPTION_ID_SECRET, sessionId + ":" + optionId)`. `grade-session` recomputes the mapping, so nothing is stored.
  - Options keep the author's order, so neither ids nor positions are derived from the key.
- **Open section only (ADR 0002 S-1, S-5; FR-301).** The rule applies to every question route:
  - read: `GET /candidate/questions/:sessionQuestionId`;
  - Run;
  - draft and answer: `PUT …/draft`, including MCQ and short-answer `answer` autosave;
  - submit.

  Each one serves or accepts a question only if it belongs to the **open section** (its `session_sections` row has `started_at` set and `ended_at` NULL). Otherwise it answers 409 `SECTION_NOT_OPEN`.
- **Data path (decided, option (a)).** `SectionGateService.sectionOf(sessionQuestionId)` resolves the section from the database on every call, under its own grant:
  1. it reads `session_questions.test_question_id` (explicit-only);
  2. it reads `test_questions (id, section_id)` with the injected `id IN` filter;
  3. it reads the matching `session_sections` row.

  If any step finds nothing, the answer is 409 `SECTION_NOT_OPEN`: the gate **fails closed**. It never relies on Redis, so a flush cannot open it.
- **Server time decides "open" (FR-505, ADR 0002 S-4 and S-5).** It does not wait for a job to set `ended_at`. `sectionOf` also requires all of these:
  - the session status is IN_PROGRESS or PAUSED; otherwise 409 `SESSION_NOT_ACTIVE`;
  - `now() < effectiveDeadline(section)` and `now() < effectiveDeadline(session)`; otherwise 409 `SECTION_NOT_OPEN`, even if the close job has not run yet.
  - **`effectiveDeadline(x)`** (one function, ADR 0002 P-3 and P-4; TC-079) = `x.deadline_at + activeCredit`, where:
    - for the **session**: `activeCredit` = `min(now − proctor_paused_at, max(0, cap − paused_ms))` while a `PROCTOR` pause is active, else 0;
    - for a **section**, only its own pause time counts (ADR 0002 S-4): `base = max(proctor_paused_at, section.started_at)`, and `activeCredit = min(max(0, now − base), max(0, cap − paused_ms − (base − proctor_paused_at)))`. A section opened during a pause therefore gets no credit for the pause time before it opened;
    - the proctor-resume write (P-3) adds the same per-section amount to the open section's `deadline_at`. This needs an ADR 0002 P-3 note (section 7);
    - a section with no own limit (S-4) stores `effectiveDeadline(session)` as evaluated when it opened (5.11 step 5), and `effectiveDeadline(section)` builds on that stored value;
    - `cap` = `maxProctorPauseMinutes` in ms.

    P-3 adds the credit to `deadline_at` only on resume, so during a pause the raw deadline is stale. The gate, the heartbeat's `deadlineAt` and `sectionDeadlineAt`, the section deadline job and the session auto-submit job all use this function. A reload during a pause therefore still shows the section open.
  - for writes (Run, draft, answer, submit), no active `PROCTOR`, `SCREEN_SHARE_STOPPED` or `SIDE_CAMERA_LOST` pause reason; otherwise 409 `SESSION_PAUSED` (enforces ADR 0002 P-2 on the server; Delivery Lead decision DL-17). Reads stay allowed.
    - `PROCTOR`: the pause is credited on resume (ADR 0002 P-3), so editing during it would be free time.
    - `SCREEN_SHARE_STOPPED` and `SIDE_CAMERA_LOST`: the server learns these only from client-signed events. The refusal therefore holds for an **unmodified** client. Against a modified client that never sends them, the control is recording-gap detection (5.5, 5.8).
    - `FULLSCREEN_EXIT` stays client-enforced and logged. The server's pause state lags behind this frequent, accessibility-sensitive event, so refusing on it would reject legitimate autosaves.
    - **SDK and frontend:** autosave must not drop a draft on 409 `SESSION_PAUSED`. The client keeps the unsaved draft and retries after resume, so no code is lost.
    - **Section-finish during a PROCTOR pause (owner question Q21, candidate-facing).** Recommended: refuse section-finish with 409 `SESSION_PAUSED` during a PROCTOR pause, and when `close-section` (deadline variant, past the cap) runs while PAUSED with PROCTOR, defer opening the next section until resume. Until the owner answers, the per-section credit formula above already prevents over-credit.
    - **At finish**, the frontend retries a pending save before calling `/finish`. If the session is still paused, the unsaved draft from the last autosave interval (at most 10 s) can be lost. Auto-submit at the deadline has the same small window. Both are documented, accepted gaps.
  - **Clock.** `now()` here is the **API process clock**, NTP-synced. A readiness alarm fires on skew above 1 s between API replicas and the worker hosts.
- **In-flight writes.** `close-section` for a deadline runs 5 s after the deadline.
  - The question write routes (Run, draft, answer, submit) and the heartbeat (aligned with ADR 0004) use a dedicated candidate-write client. Under Prisma 7 with `@prisma/adapter-pg` (ADR 0009), URL parameters such as `pool_timeout` and `connection_limit` are ignored, so the settings go into the `pg` pool config passed to `PrismaPg`: `max` (small), `connectionTimeoutMillis: 2000` and `options: '-c statement_timeout=3000'`. The client factory's signature widens to accept that config; the BE-07 spike confirms it, and ADR 0006 gets the same fix. Its `max` plus the main pool's stays under Postgres `max_connections` with headroom (NFR-02). Batch ingest uses the main pool: a 2 MiB keystroke insert cut off at 3 s would otherwise be retried on 5xx forever. That needs no raw SQL, which is refused in session scopes; `SET LOCAL` is not used. The client built on that pool carries the same org-scope extension, and the FU-DB-67 importer test covers it (ADR 0006 section 8.10 gets a matching line).
  - The bound is **best-effort**. A write that is admitted before the deadline but commits after the close is not graded, because only the close snapshot is graded (5.11).
  - Finished sections are refused by default. Whether a candidate may re-read finished sections is owner question Q19.
  - Each route resolves the id through CS-2 and runs `sectionOf` **before** any cache lookup, enqueue or write.
  - `start-session` builds the projections for section 1 only. Opening the next section (`close-section`, 5.11) enqueues that section's `render-question` jobs.
- They are cached in Redis as `qview:{sessionId}:{sessionQuestionId}`, with TTL until `deadline_at` + grace (re-set on extension).
- On a cache miss, the candidate route enqueues the job and waits up to 5 s; on timeout it answers 503 with `Retry-After`.
- Run (sample tests only) uses the cached samples.
- **Hidden-content rule (TC-011):** these never reach the candidate scope or a projection: hidden test cases and their variant overrides, `reference_solution`, `validation_report`, the MCQ correct option ids and the short-answer accepted answers.
- **Minimal alternative (owner decision, Q18):** a candidate-safe snapshot column (for example `session_questions.prompt jsonb`, written by `start-session`) survives a Redis flush. It is a schema change under ADR 0008, so it is not chosen for the pilot.

#### CS-4.7 Jobs (actor, jobId for dedupe)

| Job | Actor | jobId |
| --- | --- | --- |
| `start-session` (assign questions, sections, key, projections, VERIFIED → IN_PROGRESS); the route waits up to 10 s, else 503 with `Retry-After`; idempotent | SERVICE | `start-session_{sid}` |
| `render-question` | SERVICE | `render-question_{sid}_{sessionQuestionId}` |
| `verify-session` (CONSENTED → VERIFIED when all checks are done; compare-and-set) | SERVICE | `verify-session_{sid}_{n}`, where `n` comes from Redis `INCR vs:{sid}` (TTL 24 h). Debounced (see below), so a burst of room-scan confirms (up to 60 per minute) produces one run |
| `close-section`, deadline variant (enqueued for the section deadline + 5 s; re-checks and re-delays, 5.11); `removeOnComplete` and `removeOnFail: true` | SERVICE | `close-section_{sid}_{sectionId}_deadline_{deadlineEpochMs}` |
| `auto-submit` (session deadline + 5 s; same re-check and re-delay, 5.11); `removeOnComplete` and `removeOnFail: true` | SERVICE | `auto-submit_{sid}_{deadlineEpochMs}` |
| `close-section`, finish variant (section-finish button) | SERVICE | `close-section_{sid}_{sectionId}_finish` |
| `close-section`, final variant (flow child on SUBMITTED, delayed 5 s) | SERVICE | `close-section_{sid}_{sectionId}_final` |
| `grading-reconciler` (repeatable discovery every 5 min under `BACKGROUND_JOB`) | system discovery that only enqueues | none (repeatable) |
| `grade-session` (hidden tests through Judge0, MCQ and short-answer scoring per ADR 0007 §5, D-23) | SERVICE | `grade-session_{sid}` |
| `analyze-session` | org scope (cross-session similarity); per-session writes through SessionStateService with `guardLive`. ERASED sessions are never comparison sources, and a CODE_SIMILARITY payload about another candidate's session carries `matchedSessionId` only, never the matched code | `analyze-session_{sid}` |
| ingest close (key destruction, sweep pass 1) and sweep pass 2 | SERVICE | `ingest-close_{sid}`, `sweep-2_{sid}` |
| consent PDF | SERVICE | `consent-pdf_{sid}` |
| `face-recheck` (worker) and its outcome handler | SERVICE | `face-recheck_{name}` |
| `evidence-expire` | SERVICE | `evidence-expire_{name}_{attempt}` |
| `server-event` (RECONNECTED and similar) | SERVICE | `server-event_{sid}_{type}_{heartbeatAt}` |
| disconnect watchdog: discovery under `BACKGROUND_JOB` enqueues one SERVICE job per silent session; that job (no scope → `runAsSessionJob`) writes DISCONNECTED | discovery: system; per session: SERVICE | `disconnected_{sid}_{lastHeartbeat}` |

- BullMQ `returnvalue` and `failedReason` never carry case data, stdout, keys, URLs or answer keys.
- `render-question`'s return value is the candidate-safe projection by construction.
- **Fixed jobIds and lost re-runs (S2).** BullMQ keeps completed jobs by default and ignores an enqueue whose id already exists, including one that is still active. A fixed id is therefore used only where one run is final.
  - `verify-session`: each enqueue gets a fresh suffix. Deduplication runs in **debounce mode** (`deduplication: { id: 'verify-session:{sid}', ttl: 5000, extend: true, replace: true }`, 2 s delay), so the enqueue that completes the conditions replaces the pending one rather than being dropped. The job also re-checks every condition at the end, and re-enqueues itself if any changed during the run.
  - `ingest-close` and `consent-pdf`: one run is final; the jobs are idempotent and set `removeOnFail`, so a failed run can be enqueued again.
  - `close-section`: three variants with distinct ids (table), so a pending deadline job, a finish click and the final flow child never collide. All are idempotent through the compare-and-set in 5.11. An active deadline job cannot be removed on SUBMITTED, so it relies on the status checks in 5.11 instead.
  - `analyze-session`: it must re-run when late data arrives, so it uses `removeOnComplete` with a re-enqueue on that late data.
- `grade-session` and the final `close-section` children use `removeOnComplete: true` and `removeOnFail: true`, so a reconciler re-add is never ignored.
- `removeOnComplete` and `removeOnFail` are set explicitly on `close-section`, `verify-session`, `analyze-session`, `start-session`, `render-question`, `grade-session`, `face-recheck` and `server-event`.
- **Spike (BE-07), delayed jobs:** re-delaying from inside a job needs `job.moveToDelayed(timestamp, token)` with the job's token, followed by `throw new DelayedError()`, because a normal return completes or fails the job. Confirm this on the BullMQ version in use.
- **Spike (BE-07), jobIds:** BullMQ does not accept `:` in custom jobIds (found in #206), so every `name:{id}` jobId in this ADR uses `_` as the separator; the same pattern in ADR 0006 section 8.9 follows it.

#### CS-4.8 Tests (DB-05, BE-07; TC IDs assigned by QA, tracked in docs/followups/qa.md)

- Iterate every Prisma DMMF model: each one not on the CS-4.3 allowlist throws in CANDIDATE scope.
- One test per relation vector (CS-4.5), including fluent and `include` access from `sessionQuestion` to `questionVersion` and its `testCases`, and an `include` from `session` to other candidates.
- Column tests:
  - every hidden column throws on select, `where`, `orderBy` and `groupBy`;
  - the default select omits them;
  - a write to a non-listed column (`sessions.status` with no SessionStateService grant, asserted as the **runtime** refusal, `sessions.auth_epoch`, `session_questions.score`, `identity_checks.manual_decision`, a `proctor_events` row with `source = SERVER`) throws.
- `proctor_events` reads never return SERVER rows. `submissions.score` and `SUBMIT` results are never readable.
- Injected filters: one test per CS-4.3 row.
- STAFF-scope `proctor_events` writes: only `proctorPause`, `proctorResume` and `proctorMessage` create `proctor_events` in STAFF scope (a call-site test like FU-DB-67); `proctorUserId` equals the authenticated user even when the body or query carries another one; a cross-organisation `:sessionId` is a 404 before any write; the event is rolled back when the state change updates 0 rows; the candidate read still never returns these rows (`source = 'CLIENT'` only).
- Consent create: a `consents` create outside the `ConsentService` grant throws; a create after the grant's `fn` has settled throws; a create with a `session_id` other than the context's, a `consent_text_id` other than the organisation's current text, or either of them missing throws; a create that writes `pdf_key`, `pdf_generated_at` or `copy_emailed_at` throws; an update, a delete, an upsert and a second create for the same session all fail; a create throws when `current_consent_text_id` is null; the row a create returns omits `signed_name`, `ip` and `user_agent`, and a create with `select: { signedName: true }` throws; a new text published between `ConsentService`'s read and the create gives 409 `CONSENT_TEXT_CHANGED`.
- Actor crossing and raw SQL refusal.
- Guard pre-read (5.10, DL-31): it selects only `sessions.invitation_id` and `invitations (candidate_id, test_id)`, never `accommodations`; its `runInOrg` callback has returned before `runAsCandidate` is entered; `setCandidateFacts` runs before any other candidate-scope query; a CANDIDATE query on any model before `setCandidateFacts` throws; an injected filter with a missing context value throws rather than being dropped; `setCandidateFacts` called twice or with a missing id throws; the three 401 cases return the same body and code; a missing or other-org session answers 401; `sessions.invitation_id` throws when read in CANDIDATE scope.
- **Rule CS-5: sockets and storage.**
  - Candidate sockets (OI-2, if any) authenticate with the same token and join only the room `session:{sessionId}` taken from it. The server ignores any session id in a socket payload.
  - Every presign route builds the key from the token's org and session (5.7), and confirm refuses any key or (stream, seq) outside the token's session.
- **Tests (BE-07, BE-09, BE-10, QA; a TC-008 sibling, QA assigns the ID).** Use two candidates, A and B, in the **same org**. With B's token, sent with A's question, section, evidence, attempt and media identifiers to every candidate route (read, run, draft, submit, presign, confirm, evidence, re-check, batches):
  - each call returns 404, or succeeds without touching A's data;
  - no presigned URL for A's prefix is ever issued.

  In addition, a staff token on `/candidate/*` returns 401, and a candidate token on staff routes returns 401.

#### Interim exception for BE-07 (P-24, approved 2026-10-06, D-54; time-boxed, ends before the pilot)

BE-07 (#98) diverges from CS-4 as follows. This records what the owner approved in `docs/status.md` P-24 on 2026-10-06 (D-54): a time-boxed exception, ending when BE-07 conforms and in any case before the pilot (B-05). If a divergence below is not removed by then, it is not covered by this approval.

1. **Org-scope reads and writes (`asOrg`) beyond the guard's DL-31 pre-read:** status transitions, the HMAC key, `device_info`, consent texts, test content (question versions and test cases), audit rows and row creates. In org scope there is no CS-4.2 session filter, no CS-4.3 model allowlist and no CS-4.4 column allowlist, so if a service slips, other candidates' rows in the same org and `invitations.accommodations` are reachable.
2. **Candidate scope is entered once per service step, not once in the guard.** `runAsCandidate` and `setCandidateFacts` are called from one file, `apps/api/src/candidate/candidate-scope.ts`, as the first statement of each scope: a new FU-DB-67 call site, in place of the guard file, which contradicts CS-4.1 and CS-4.4 ("only `CandidateSessionGuard`") for the duration of the exception. The facts come only from the guard's verified pre-read, never from the request.
3. **VERIFIED to IN_PROGRESS** (`test/start`: question assignment, question content reads, HMAC key) runs in the candidate request in org scope, not in a start-session SERVICE job.
4. **Consent sign and decline run in org scope without the CS-4.4 `ConsentService` create grant** (item 9, CS-4 PR 2), and status writes go through `SessionStateService.transition()`, enforced in code only and not at runtime by the extension (CS-4.4a).

**Controls that exist:** the verified token supplies the org and session; the guard returns 401 for a missing or other-org session; every candidate-scope call uses an explicit select; a handler with no scope fails closed; staging holds synthetic data only; #98 adds a same-org cross-candidate test (a second session in the same org is unreachable with candidate A's token, TC-008 style) **before it merges**.

**Time box:** the exception ends only when BE-07 conforms (scope entered only in the guard, a start-session SERVICE job, the CS-4.4a and item 9 grants), tracked by FU-BEB-15, FU-BEB-66 and one follow-up per divergence. CS-4 PRs 2 and 3 landing is not enough on its own. Hard limit: before the pilot (B-05).

**Gate B-3 covers every client-supplied selector.** While services run in org scope (1), a slip in resolving any id the client sends has no session filter behind it. FU-BEB-15 and FU-BEB-66 therefore close before any BE-09, BE-10 or BE-11 route that takes a client-supplied selector merges, and the gate counts **all** of them: `:questionId`, `sessionQuestionId`, the section `position` of `section/finish`, evidence names, and media (stream, seq). The routes built on #98 resolve each of them only inside CANDIDATE scope under the CS-2 and CS-4.2 filters, or they wait for the gate. The approval does not extend beyond the time box above.

### 5.11 Submit and grading (keeps ADR 0007 §5)

- **`POST /candidate/answers/:questionId/submit`** stores a `SUBMIT` row with the code and language and returns **200 `{ accepted: true, submissionId }`. Nothing else is returned**: no per-test result, weight or score. Hidden tests and answers therefore cannot be used as an oracle.
- **Limits** (architect detail), checked atomically **before** any insert:
  - Redis `SET NX PX 10000` on `rl:submit:{sid}` gives one submit per 10 s per session; on failure, 429 with `Retry-After`.
  - Redis `INCR submits:{sid}:{sqid}` returns the new count. Above 20, the route `DECR`s and answers 409 `SUBMIT_LIMIT_REACHED`. If the insert fails after the `INCR`, the route also `DECR`s.
- **What is graded (consistent with ADR 0002 S-5 and backend.md Step 11).** Candidate scope cannot read `submissions.source_code`, so closing a section is a SERVICE job, `close-section`. **It is the only writer of `session_sections.ended_at`.**
  - **Who enqueues it:**
    - the section-finish route (finish variant): `POST /candidate/session/section/finish` with `{ position }`, the section's position within the token's own session, never an id. It is enqueue-only and idempotent: the open section enqueues the close, an already closing or closed section is a 202 no-op, a section that has not opened yet is 409 `SECTION_NOT_OPEN`, an unknown position is 404; a missing or invalid body is 400; the success body is `{ accepted: true }`. **Preconditions:** the session is IN_PROGRESS or PAUSED (409 `SESSION_NOT_ACTIVE` otherwise; whether a PROCTOR pause answers 409 `SESSION_PAUSED` is Q21, pending); "open" means `started_at` is set and `ended_at IS NULL`, so a section past its deadline that is not closed yet still gets the 202 close, not a 409. A delayed retry therefore cannot finish the next section after the close opened it (P-25 resolved, P-30 for the FSD row, ADR 0002 S-1 and S-4);
    - the section deadline (deadline variant);
    - `/finish` and the session-deadline auto-submit, through the SUBMITTED flow (final variant).

    The route only enqueues; it writes no section column.
  - **One transaction, one timestamp (two values for a deadline-variant close: see the BE-11 details), compare-and-set first.** `close-section` takes a single app-clock timestamp `T`, then in one transaction:
    0. `guardLive` (the transaction's first statement).
    1. **Claim:** `updateMany({ where: { sessionId, sectionId, endedAt: null, startedAt: { not: null } }, data: { endedAt: T } })`. If 0 rows are updated, another variant already closed the section; the job aborts as a no-op (but see "post-commit work" below).
    2. Read `session_questions.final_code` and `final_language` for the section.
    3. **Always** insert one `SUBMIT` snapshot row per coding question of the section, **including a question whose saved source is empty** (`source_code` = `final_code` if non-null, else `''` and never NULL, because the column is NOT NULL; `language` = `final_language` if non-null, else `allowed_languages[0]` of the session question's pinned `question_version_id`), with `created_at = T`, exempt from the cap. A CODING version always has at least one allowed language (publish validation enforces it; there is no database CHECK), so an empty list is a bug and the close fails loudly rather than inserting NULL, which would roll the claim back and retry forever. Writing the empty row too is what lets "no matching snapshot" mean a bug and nothing else (2026-10-06, FU-BEB-102).
    4. **Last section:** if no section k+1 exists and the variant is finish or deadline, move the session to SUBMITTED with an `updateMany` compare-and-set from IN_PROGRESS or PAUSED (ADR 0002 S-5: "the end of the last section submits the session"). That starts the SUBMITTED flow.
    5. **Open the next section** (finish and deadline variants only; **the final variant never opens a section**): `updateMany({ where: { sessionId, position: k + 1, startedAt: null, session: { status: { in: ['IN_PROGRESS', 'PAUSED'] } } }, data: { startedAt: T, deadlineAt } })`. Here `deadlineAt = min(T + L, effectiveDeadline(session) evaluated at T)` for a section with limit `L`, and `effectiveDeadline(session)@T` for a section with no limit. (When the close runs after the section's deadline `D`, `ended_at` and the snapshot `created_at` are `D` and this step uses the job's own time `N` in place of `T`: see the BE-11 details below.) The stored `sessions.deadline_at` is stale during a pause (P-3 credits it only on resume), so it is never used directly. Check: pause before open (p = 10, open at 15, resume at 20, cap 30) gives R + 5 + 5 = R + 10, matching the session; cap exhausted at 40 gives R + 30 + 0 = R + 30, matching the session.

    `updateMany` compare-and-set is the only concurrency tool here: Prisma has no `FOR UPDATE`, and raw SQL is refused in session scopes. Two variants racing therefore produce exactly one close, one snapshot set and at most one opening of the next section. SERVICE scope has no column limits, so `created_at` and `ended_at` are set by the job and never left to a database default.
  - **Post-commit work.** After the commit, or on the no-op path, the job enqueues the next section's deadline job only if section k+1 actually opened (in the skip case below `deadline_at` is NULL and nothing is enqueued) and its `render-question` jobs, with deterministic jobIds. A retry that finds the section already closed still enqueues them, so a failed enqueue is never lost.
  - **Between the click and the commit**, the section stays open under the gate. Writes that commit before step 2's read are in `final_code` and are snapshotted (a write that commits between the claim and the read is snapshotted too, which is harmless), or they commit after it and are not graded.
  - **Graded row: the close snapshot, identified by its timestamp.** For each coding question, `grade-session` grades the `SUBMIT` row whose `created_at` equals that question's `session_sections.ended_at`. Both are the same value, written by the same transaction (the app-clock `T`, or the section's effective deadline `D` for a deadline-variant close).
    - ~~Candidate rows can never match: they cannot write `created_at` (CS-4.4) and get the database's `now()` at microsecond precision.~~ **Superseded by FU-BEB-89 (see the BE-11 details below):** Prisma sets `created_at` in the API at millisecond precision, so a candidate row can match `T` only by hitting the same millisecond.
    - **More than one match:** `grade-session` fails loudly and alerts.
    - **No match:** for a coding question whose section has `started_at` set (every such section has `ended_at`, checked at the start of `grade-session`), a missing snapshot is always a bug, because the close writes one for every coding question, an empty source included: `grade-session` alerts and fails rather than silently scoring 0, and a late write can never cause it. Questions of sections that never started (an early `/finish` or the session-deadline auto-submit never opens them) have no snapshot and no `ended_at`; they score 0 without a snapshot lookup.
    - **Precision.** `created_at` is `timestamptz(6)`. ~~Candidate rows get the database default `now()` (transaction start, microseconds), while `T` is a JS millisecond value. A mismatch is possible only in theory, and it surfaces as a loud failure, never as a wrong grade.~~ **Superseded by FU-BEB-89:** candidate rows get a millisecond `created_at` from the API; a same-millisecond collision gives two matches, which fails loudly and never produces a wrong grade. ~~A test checks that the candidate insert leaves `created_at` to the database default and that Prisma does not fill it.~~ **Superseded by FU-BEB-89:** that test cannot pass; replace it with the interim (more than one match fails loudly) and the SNAPSHOT decision (P-28).
    - **MCQ and short answers** are graded from `session_questions.answer` at SUBMITTED, with no per-section snapshot. An in-flight answer write that commits after its section has closed is therefore still graded, while coding is not. This asymmetry is documented and accepted.
    - No schema change. The alternative, a `submission_kind` value `SNAPSHOT`, is an ADR 0008 delta and an owner decision (Q22; the hub now recommends it, P-28).
    - The candidate submit route writes its `SUBMIT` row and `final_code`/`final_language` in **one transaction**, so "has saved code" never lags behind a submit.
  - **Deadline variant (ADR 0002 P-3 and P-4; TC-079).** It is enqueued for `effectiveDeadline(section)` + 5 s. When it runs:
    - it starts its transaction with `guardLive` and returns as a no-op unless the session is IN_PROGRESS or PAUSED;
    - while a `PROCTOR` pause under the cap is active, it re-delays to `min(proctor_paused_at + remaining cap, now + 30 s)`. That time is always in the future, so the job never spins;
    - once the cap is exhausted the clock runs again (P-3), and when the section is due it closes even while PAUSED (P-4). An active pause cannot block closing or grading forever, because the cap bounds it;
    - if the section is otherwise not yet due (an extended deadline), it re-delays to the new `effectiveDeadline` + 5 s.
  - **Session auto-submit** at `effectiveDeadline(session)` follows the same re-check and re-delay rule (P-4).
  - **Ordering on SUBMITTED.** SessionStateService adds a BullMQ flow:
    - `grade-session` is the parent. Its children are the final-variant `close-section` for every **started** section without `ended_at`, each delayed 5 s so in-flight saves from the last seconds land first.
    - Children have 5 attempts with exponential backoff and `failParentOnFailure: true`. A failed parent is not retried by its own attempts; only the reconciler recovers it.
    - `grade-session` checks at start that every started section has `ended_at`, and fails if not. Questions of sections that never opened score 0.
    - `grade-session` runs Judge0 **outside** any transaction. Then one transaction:
      1. `guardLive`;
      2. `updateMany` status SUBMITTED → GRADED;
      3. writes the scores only if that changed exactly 1 row, and throws to roll back on 0. A second run therefore no-ops.
  - **Grading reconciler.** A repeatable discovery job every 5 minutes, under `BACKGROUND_JOB`, re-creates work for three cases:
    - **SUBMITTED** sessions older than 10 minutes that are not graded: it re-creates the flow;
    - **IN_PROGRESS or PAUSED** sessions whose open section is past `effectiveDeadline` + 2 minutes with `ended_at` NULL: it enqueues the deadline variant;
    - **IN_PROGRESS or PAUSED** sessions past `effectiveDeadline(session)` + 2 minutes, including those with no open section left: it enqueues `auto-submit`.

    It skips any session whose `grade-session` job is active, waiting, waiting-children or delayed. It also skips sessions in status ERASED and sessions with `RETENTION_RESULTS_DONE` (5.7). The skip is keyed on the session, so during an erasure hold a second SUBMITTED session of the same candidate is still recovered. Sessions stuck longer than 1 hour raise the alert proposed in ADR 0004 9.4.
  - A coding question whose snapshot has an empty source scores 0 without a Judge0 run. A session with no work at all is graded with score 0; it is never skipped.
  - The review UI labels the graded snapshot and shows when `final_code` is newer than it.
- MCQ and short answers are not submitted. `session_questions.answer` is autosaved through the draft route and final at SUBMITTED (ADR 0007 §5).
- **Grading.** `grade-session` (SERVICE) runs after the session is SUBMITTED, as ADR 0007 §5 and backend.md Step 11 already say ("On SUBMITTED, enqueue grade-session"). It covers hidden tests through Judge0 with the variant data, MCQ by key, and short answers by normalised match or MANUAL_PENDING (D-23).
- **Run** (sample tests, FR-502, one per 5 s) still returns sample results.
- **What the candidate sees after the test** (score, pass/fail or nothing) is an owner decision (Q17). No FR authorises showing scores or hidden results today, so the default is a "submitted" page only.

#### Architect details for BE-11 (2026-10-06; owner decisions are marked)

- **Accepted deviations from the text above, as architect detail,** on these conditions: (a) no BullMQ close-section flow, (b) one grading-sweep job and (d) no `render-question` jobs are acceptable if the open-section gate refuses every write after a section's deadline at request time (so FR-301's server-enforced deadline never depends on job timing), the graded snapshot equals the saved state at the deadline, and questions are rendered lazily and deterministically from the session's fixed variant assignment, identical on every read. (c), dropping the section-finish route, was declined (P-25 resolved: the route is built). **Timing, to be stated by BE-11 in `docs/followups/backend.md` and kept within these bounds:** a close performed by the sweep records the section's effective deadline (not the sweep's own time) as `ended_at` and as the snapshot `created_at`, so the graded-row match holds, while the next section opens at the job's own time `N` (see the next bullet), so a sweep interval or an outage never costs the candidate section time beyond what the fixed session deadline already limits (an outage that eats into the session deadline is an operational incident handled by staff extension); who runs the final-variant close of every started section at SUBMITTED, and which delayed jobs (deadline, auto-submit) remain, is stated by BE-11; the "+2 minutes", "10 minutes" and "every 5 minutes" figures above are restated for the 15 s sweep and may only get shorter.
- **Opening the next section after a deadline close (FU-BEB-112, architect detail favouring the candidate).** The deadline-variant close sets `ended_at` and the snapshot `created_at` to the section's effective deadline `D` (needed for the graded-row match), but opens section k+1 at the job's own time `N`: `started_at = N`, `deadlineAt = min(N + L, effectiveDeadline(session)@N)` (or `effectiveDeadline(session)@N` when the section has no limit), and it skips the opening when `effectiveDeadline(session)@N <= N` (never the stored `sessions.deadline_at`, which is stale during a pause), leaving the session auto-submit to end the session (or moving the session to SUBMITTED directly, as step 4 does). `D` is computed as `effectiveDeadline(section)` inside the close transaction after `guardLive`, so a concurrent P-3 resume is serialised; a close of a past-due section by the finish variant records its own `T`, not `D`, and the graded-row match still holds because the same transaction writes both. If the owner accepts the Q21 recommendation, opening at `N` while a PROCTOR pause is past the cap is deferred to the resume. Until `N` the heartbeat returns section k's past `sectionDeadlineAt` and a read of k+1 returns 409 `SECTION_NOT_OPEN`: the frontend shows a "next section opening" state and retries (docs/followups/frontend.md). Setting k+1's `started_at` to `D` would charge the candidate the gap between `D` and the commit, during which nothing is readable or writable (k is closed at the gate and k+1 has no `started_at`), and after a worker or Redis outage longer than `L` it would open k+1 already past its deadline, so the candidate would lose the whole section through no fault of their own. The candidate gains nothing from the gap, because the session deadline is fixed.
- **Further requirements found in review (FU-BEB-112).** (1) A deadline job that finds its section not yet due (an extended deadline) re-delays itself to the new effective deadline + 5 s, as above; the 15 s sweep is the backstop, not the mechanism. (2) The **grading** sweep and `grade-session` skip ERASED (not the ingest sweep passes of 5.7, which must still run on ERASED through `withAnySession`) sessions and `RETENTION_RESULTS_DONE`, and every write transaction of these jobs starts with `guardLive` (5.7); without them an erased session can be written to. (3) Late-write detection is built in `grade-session` as described below.
- **Grading timing.** `grade-session` runs flow-less with a 5 s start delay (so in-flight saves land first), and the grading-sweep reconciler runs every 15 s. The reconciler still skips a session whose `grade-session` job is active, waiting or delayed, skips ERASED sessions and `RETENTION_RESULTS_DONE`, and alerts on sessions stuck longer than 1 hour.
- **Late write after the close claim (FU-BEB-86, FU-BEB-102; owner decision P-27, recommended, pending).** `grade-session` always grades the snapshot, never `final_code`, so a write that commits after the close cannot change a grade, make it fail or leave a session stuck, including an autosave that lands during the Judge0 run. "Late" is informational only: inside the grading transaction it re-reads `final_code` and `final_language` for each coding question and compares them with the snapshot **normalised exactly as the close normalised them** (`coalesce(final_code, '')` against `source_code`; the language is compared only when `final_code` is non-null, or `coalesce(final_language, allowed_languages[0])` is compared with `language`), so an untouched question never produces a flag; if they differ, it records the flag and continues. Never failing is the interim default pending P-27, not decided policy. Recommendation for the flag: a SERVER event `LATE_WRITE_AFTER_SECTION_CLOSE` (LOW, weight 0, payload `{ sessionQuestionId, sectionPosition }`, never code). Until the event exists in `packages/shared`, the flag is a job audit row of the same name (`actor_id` null, `ip` null, `entity_type` `session_question`, `entity_id` the `sessionQuestionId`, `org_id` set, `metadata { system: true, sessionId, sessionQuestionId }` with ids only; api-contract section 3), written inside the grading transaction so a rolled-back second run leaves no duplicate plus a structured warning with ids only. It does **not** use `session_questions.scoring_note`, which the reviewer's note shares. No row lock is needed: the flag is not authoritative, and a write after the re-read simply goes unflagged because the grade is the snapshot either way.
- **Identifying the graded row (FU-BEB-89; owner decision P-28).** Prisma sets `created_at` at millisecond precision, so "database `now()` in microseconds" does not hold for candidate rows. Recommendation: add `SNAPSHOT` to `submission_kind` (an ADR 0008 delta, Database A). Interim: more than one match fails loudly and alerts (never a wrong grade). Because the close now writes a snapshot for every coding question, a candidate row that lands in the same millisecond as `T` always gives **two** matches, which fails loudly and never chooses the candidate's row. The residual impact is a stalled `grade-session` and an alert (it never changes a grade or exposes data). A sweep close uses the section's effective deadline as `T`, which the candidate can see in the heartbeat's `deadlineAt`, so a submit timed at the deadline could provoke it on their own grading: until P-28 lands the two-match case needs a runbook entry (manual resolution), and P-28 should land before the pilot.
- **Routing.** `grade-session` leaves the session GRADED; `route-session` (ADR 0014 D5, Proposed; an architect detail) moves it to UNDER_REVIEW after analysis finishes or is abandoned (status.md Q-22, which is not this ADR's Q22), so the review queue never opens before the findings exist. C-28 is unchanged.
- **What the candidate sees (Q17; owner decision P-29, recommendation).** Candidate routes return every status from SUBMITTED onward (GRADED, UNDER_REVIEW, APPEALED, COMPLETED) as `SUBMITTED`; EXPIRED and DECLINED are shown as they are; how ERASED appears to a candidate is not defined here (the erasure fence ends the session, ADR 0004 section 9.5; BE-07 and BE-09 answer 401 or 409 for it, to be stated in api-contract).

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

Scripts (proctor-sdk owns them; they replace `fetch-models.mjs`). The SDK's `scripts/lock.mjs` (hash, verify and update, in this `files[]` shape, preserving hand-edited `licence` and `status`; on the SDK branch, not yet on main) is the starting implementation. It moves under `scripts/models/` so CODEOWNERS covers it (control 1).
- `models:fetch <outDir>` reads the lock, downloads or copies each file, and fails on any SHA-256 or size mismatch.
  - It writes to `<outDir>/<lockDigest12>/<name>`. The lock `name` is the served relative path (for example `coco-ssd/ssdlite_mobilenet_v2/model.json`).
    - SDK work: `resolveModelUrls` maps components to these lock names instead of the flat layout it assumes today.
    - `modelBaseUrl` becomes `/models/proctor/<lockDigest12>`, injected by the web build (`NEXT_PUBLIC_PROCTOR_MODEL_BASE`) from the lock digest.
  - **One model directory in every environment, including dev:** `apps/web/public/models/proctor/`. The dev-only `apps/web/public/dev-proctor-models/`, ignored on main by PR #37, is retired. `/dev/proctor` uses the same fetch and path, and the frontend removes the old ignore entries once nothing uses them.
  - It copies only the onnxruntime wasm variants the lock lists, not every `.wasm`.
  - **Variant (decided).** Serve only the plain `ort-wasm-simd-threaded.wasm` (about 14 MB) and its `.mjs`. Voice activity detection needs the wasm execution provider only, not WebGPU.
    - The jsep (about 28 MB) and asyncify (about 27 MB) variants exceed the limit and are not served.
    - The SDK configures vad-web to load the wasm-only onnxruntime entry (`onnxruntime-web/wasm`) and confirms in a real browser which file it requests. Which variant vad-web loads today is unconfirmed.
    - If vad-web cannot be made to use the plain variant, the fallback is serving models from object storage behind the same origin (section 7), not raising the limit, which is a platform limit.
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
  | pilot, production | fails | fails, unless every file of that model is listed in the accepted-risk list below |

  - **Accepted-risk list (D-28, C-10).** The gate reads exactly one list: a fenced block tagged `licence-acceptances` in `docs/status.md` section 9, the owner's decision log, which the Delivery Lead maintains (section 9b is the Delivery Lead's own log). Pilot and production deploys **fail if the block is missing or appears more than once**; on main today it does not exist yet. Each line is `<decision-id> <model> <file-name>@<sha256>`.
    - A model counts as one named model, but **every file of it must be listed**. COCO-SSD's `model.json` and each weight shard appear on separate lines under the one model.
    - The gate fails if any file of an `unverified` model is missing, if a hash differs, or if the decision id is not a row of section 9.
    - **Requested entry** (Delivery Lead): D-28, as extended by C-10, listing AuraFace `glintr100.onnx` (worker lock) and COCO-SSD `ssdlite_mobilenet_v2` (`model.json` plus every shard, proctor-sdk lock), with exact hashes taken from the lock files once they exist.
    - Every other file without a verified licence still fails.
    - The gate prints the entries it applied. There is no GitHub Environment variable override any more.
- **What actually protects the gate.** Agents run with the owner's `gh` login, which is a repository admin. In a PR an agent can change `status` in a lock file, the accepted-risk list in `docs/status.md`, the gate script or the workflow that calls it.

  The gate is therefore only as strong as the following controls, none of which exists yet:

  | # | Control | Kind |
  | --- | --- | --- |
  | 0 | **Separate agent identity.** Agents run under **a separate bot account (or a GitHub App)**, with a token issued for that account and **never a token of the owner's account**. A fine-grained PAT on the owner's account still acts as the owner. The identity gets **Write, not Admin**, and with no Variables, Secrets, Environments or Administration permission. The owner's `gh` login is not available in agent sessions. **Every other control depends on this one.** | recommended; **not adopted** (C-33, relayed by the Delivery Lead, pending the owner's own confirmation) |
  | 1 | `CODEOWNERS` naming the owner for `packages/proctor-sdk/models.lock.json`, `apps/worker/models.lock.json`, `packages/proctor-sdk/package.json` (it defines the `models:licence-gate` script, and `"models:licence-gate": "true"` would neutralise the gate), the gate itself (self-contained under `packages/proctor-sdk/scripts/models/**`, importing nothing outside that folder, so CODEOWNERS covers all of it), the future worker gate (`apps/worker/scripts/models/**` and `apps/worker/pyproject.toml`), `.github/workflows/**`, `.github/CODEOWNERS`, `docs/status.md` (the Delivery Lead's decision log, which control 3 reads), and every file that can neutralise the gate at install or run time: root `package.json`, `pnpm-workspace.yaml`, `.npmrc`, `.pnpmfile.cjs`, `patches/**` and `pnpm-lock.yaml`. Branch protection or a ruleset on `main` requires code-owner review, with **bypass disallowed / "include administrators" on** | owner action (the hub drafts the CODEOWNERS file; the owner sets the protection) |
  | 1b | **Deployment branch policy** on the `pilot` and `production` Environments: `main` only. A workflow pushed to another branch must not be able to target them, because CODEOWNERS applies only at merge | owner action |
  | 2 | CI check: a PR that changes `licence` or `status` in a lock file fails unless the PR has the owner's approving review. It re-runs on `pull_request_review` events as well as on pushes. **It only works if control 1 covers `.github/workflows/**` and cannot be bypassed**, since otherwise the check can be edited away in the same PR. `models:update` diffs can then only touch `sha256`, `bytes` and `version` | architect detail, owner to confirm |
  | 3 | The accepted-risk list lives only in `docs/status.md` section 9 (under control 1), and the gate cross-checks it against the lock hashes | decided (D-28, C-10); mechanism: architect detail |
  | 4 | Deny patterns in the agents' permission settings: `gh variable *`, `gh secret *`, `gh api */environments*`, `gh auth token`, `gh api */branches/*/protection*`, `gh api */rulesets*`, `gh pr merge --admin*`. **Best effort only.** Bash deny patterns match command text, so an agent with the token can call the REST API through `curl` or another spelling. Recommendation only: the hub does not edit `.claude/` or any settings file (its own operating rules; agent configuration is the owner's decision) | owner action |

  **Plain statement.** While agents use the owner's `gh` login, which is a repository admin, controls 1 to 4 do not stop an agent:
  - the admin can edit or delete branch protection and rulesets (`gh api -X PUT|DELETE repos/{o}/{r}/branches/main/protection`, `…/rulesets`);
  - it can merge with `gh pr merge --admin`;
  - it can read the token (`gh auth token`) and call the API with `curl`, which bypasses any `gh` deny pattern;
  - required code-owner review cannot tell the owner and an agent apart on one account. And because an author cannot approve their own PR, the owner would routinely need admin bypass, which defeats control 1.

  **Until control 0 exists, the gate is not protected.** It catches mistakes, not a determined change.

  **If control 0 is not adopted (C-33): accepted risk (status.md R-20).**
  - CODEOWNERS, branch protection, rulesets and the deployment branch policy (controls 1, 1b, 2) can all be bypassed with the shared admin login. They still catch accidental changes.
  - The remaining controls are:
    - the C-33 merge comment on every PR ("Merged by <session name> session after review and green CI"), for traceability;
    - the owner checking the lock-file diff, the `docs/status.md` accepted-risk list and the gate workflow before each pilot or production deploy.
  - The licence gate, the CODEOWNERS file and the CI check are still built. They are cheap, and they become real controls if control 0 is adopted later.
- **Deploying without the object detector.** The owner can instead deploy with `PROCTOR_EXCLUDE_COMPONENTS=OBJECT`. This needs SDK support: an `excludeComponents` option that never starts the detector and emits no DETECTOR_UNAVAILABLE.
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
- **ADR 0004 §8.** The consent PDF key sits outside the session prefix (5.7), which fills in and amends the layout ADR 0004 §8 delegated to ARC-03. The accepted sentence "retention keeps it with the consent record (R-5), and erasure deletes it (R-6)" is amended: the PDF is kept through erasure until its 3-year limit. This depends on C-17 (PR #44) and ADR 0004 R-9 (PR #48), neither merged yet.
- **ADR 0005 §3 and database.md (`proctor_events.batch_seq`, around line 586).** The comment "NULL for SERVER events" becomes "NULL for SERVER events and unsigned system-check findings". `batch_seq` is already nullable, so there is no schema change.
- **ADR 0006 section 8.4 (PR #41), requested:**
  - reference the actor model in 5.10 CS-4 instead of defining session scopes itself;
  - split the `runInOrg(A, { sessionId })` rows into `runAsCandidate(oid, sid)` (guard only, from no scope) and `runAsSessionJob(oid, sid)` (`SessionJobProcessor` only, entered from no scope only, after `detachForSessionJob`, which itself throws in any scope, system scopes included, and while a raw-SQL hatch is open);
  - add rows refusing CANDIDATE → SERVICE, SERVICE → CANDIDATE, and `runSystem` from either;
  - keep "Org A with S → `runInOrg(A)`: S stays", and state that the actor stays too;
  - no new system reason is needed: start-test, `render-question` and grading are session jobs;
  - name the candidate `AUTH_BOOTSTRAP` routes as the three pre-JWT routes: link resolve, OTP send, OTP verify;
  - the six relation vectors: point to ADR 0013 CS-4.5 as the CANDIDATE enforcement (all refused, with the fluent API also linted);
  - state that SERVICE scope's session filter is top-level only, and nested reads stay under rule (i) review (defence in depth);
  - the disconnect watchdog runs as `BACKGROUND_JOB` discovery that enqueues per-session SERVICE jobs; the discovery job only enqueues; each session job runs in its own worker callback, and `runAsSessionJob` is entered from no scope only (ADR 0006 section 8.4).
- **ADR 0002 S-4 (note).** A section opened at `T` stores `min(T + L, effectiveDeadline(session)@T)`, or `effectiveDeadline(session)@T` when it has no own limit, never the stale `sessions.deadline_at` (5.11).
- **ADR 0002 P-3 (note).** The resume credit for the open section counts only that section's own pause time (`base = max(proctor_paused_at, section.started_at)`, 5.10 CS-4.6), and the resume write locks `sessions` with `guardLive` first.
- **ADR 0002 P-2 (note).** The editor lock for `SCREEN_SHARE_STOPPED` and `SIDE_CAMERA_LOST` (and `PROCTOR`) is also enforced on the server: writes get 409 `SESSION_PAUSED` (DL-17, 5.10 CS-4.6). `FULLSCREEN_EXIT` stays client-side.
- **FR-502 and backend.md Step 11.** "Submit runs hidden tests" becomes "Submit records the final code; hidden tests run in `grade-session` after SUBMITTED". The submit response carries no results (5.11). FR-502 is an owner decision (Q17).
- **backend.md Step 7:**
  - the key is delivered by `proctor-key`, not in the start response;
  - start-test runs as the awaited `start-session` job;
  - the heartbeat writes DISCONNECTED and RECONNECTED through session jobs;
  - candidate routes write no audit rows.
- **Judge0 data (ARC-04, BE-11 follow-up).** Judge0 CE keeps submissions, including source code and hidden-case stdin, in its own database. Nothing yet covers their retention or erasure. The follow-up is to delete each submission after grading, or disable persistence; which Judge0 flags do this is **not verified**. Owner and Legal question Q23.
- **Flagged schema changes (each needs its own ADR, not decided here):** a durable key-issue marker (`sessions.hmac_key_issued_epoch`) and `media_chunks.etag` (Q12).

## 8. Consequences and per-agent changes

- **No schema change in this ADR.** `batch_seq IS NULL AND source = CLIENT` gains a meaning, and `hmac_key_enc` is nulled at ingest close. The `ERASED` status it relies on is an enum delta owned by ADR 0004 section 9.5 and ADR 0008.
- **Contract changes ripple** to the SDK, BE-07, BE-09, BE-10, BE-12, BE-13, the frontend, QA and deploy.
- **NFR-02 load.** At 200 candidates there are about 120 requests per second for presign and confirm, plus 20 for heartbeats, about 40 for event batches and about 100 for keystroke batches. k6 must cover presign and confirm (TC-090, TC-091). Batching confirms is the first lever if p95 suffers.

| Agent | Must do |
| --- | --- |
| proctor-sdk | Autosave keeps the draft on 409 `SESSION_PAUSED` and retries after resume (DL-17). Key hooks `setKey`, `loadStoredKey`, `onKeyStale`, `onReauthRequired` and `onToken` (section 2; the app fetches the key, the SDK stores it non-extractable), outbox re-sign, counter seeding, purge rules and the stale sweep; status mapping by problem `code` (5.1, 5.2), with no endless 401 retries. Heartbeat: a `getHealth()` provider and 409 handling. Media: one per-stream `seq` across segments (replacing the per-segment restart in `recorder.ts`), `startedAt` and `durationMs`, `contentType` normalised to its essence, `If-None-Match` and 412, the `alreadyUploaded` union with no URL, and protected first chunks with the cap rule (5.5). Evidence `purpose` and single-use names; re-check as upload plus 202, with client FACE_MISMATCH removed. New: `runSystemCheck()`, a ROOM_SCAN recording stream, the `excludeComponents` option. Models: `scripts/lock.mjs` under `scripts/models/`, `resolveModelUrls` on lock names with the versioned base, the plain onnxruntime variant confirmed in a browser. Never log URLs. |
| backend BE-07 | Open-section gate (CS-4.6) on read, Run, draft, answer and submit, with the status, both deadlines, the pause write refusal, the API clock and the skew alarm; `withGrant` specs; consent `consent_text_id` set server-side; the candidate-facts setter; `SessionStateService.transition()` with the CS-4.4a list and runtime grant; `verify-session`; DeviceInfoService with its lock; AccommodationsService projection; the BullMQ jobId spike; candidate-session scope first (5.10: pinned HS256 with `iss` and `aud`, `CandidateSessionGuard` on AsyncLocalStorage, CS-1 to CS-5, `SESSION_TAKEN_OVER`, cross-candidate tests); then the master key with AAD and `kid`, epoch derivation, the issue marker with TTL until deadline + grace, system-check gates on CONSENTED → VERIFIED and on start, the `proctor-key` route, system-check route and start gate (TC-056), heartbeat and watchdog, key destruction at ingest close and on erasure |
| db-engineer (DB-05, PR #30) | Implement `runAsCandidate` and `runAsSessionJob` with a non-forgeable actor, and `detachForSessionJob` used only by `SessionJobProcessor`; the CS-4.3 allowlist with its injected filters; the CS-4.4 read and write column allowlists, also applied to `where`, `orderBy`, `distinct`, `groupBy.by` and aggregates, with explicit-only columns; refusal of all six relation vectors and nested writes (CS-4.5, with the fluent-API lint); the session filter for both actors on every operation (Prisma 7 operations included), raw SQL refused in a `sessionId` scope, and the actor-crossing refusals. Tests as listed in 5.10 CS-4, including the DMMF sweep. |
| backend BE-09 | Key layout 5.7; presign and confirm 5.5, with the HEAD check, ETag recording, the `If-None-Match` spike for R2 and S3, and per-session caps; evidence presign 5.6 with single-purpose, single-use names, quotas, the re-check refusals per C-34 (409 `IDENTITY_CHECK_WAIVED` or `DETECTOR_DISABLED` when either setting is on) and the `evidence-expire` job; the ingest-close sweep; review GET URLs with response-type and disposition overrides; tiered retention (face tier `identity/**` and `evidence/sealed/**` at face clock + LEAST(`retention_days`, 90), where face clock = COALESCE(`submitted_at`, the latest capture, the terminal transition time, `created_at`), with no review hold (C-27, C-35, ADR 0004 section 9); R-4 session prefix except `reports/`; R-10 the whole session prefix and `report_key` at anchor + 1 year, C-26; each marker written only after a complete listing, no DeleteObjects errors and an empty re-listing, by `RetentionService` only), erasure that fences every non-held session first (terminal ones included) to ERASED, deletes the whole prefix including the report, re-runs both the prefix delete and the database erasure steps at fence + 60 s + `STORAGE_SWEEP_MARGIN_SECONDS`, and writes no markers; the consent PDF prefix outside it, kept through erasure until its 3-year limit and deleted by the R-9 job (C-17) |
| integrity BE-10 | Raw-body verification order (section 2); fullscreen pairing by `occurred_at` and the duration rule (5.9); duplicate check (stored signature first, then the 8-epoch window); invariant test that CLIENT rows from batches have `batch_seq`; error codes, evidence-name resolution, grace window, per-session limits, a `rejected` metric with no body |
| integrity BE-12 | Score from server `duration_ms` only (5.9); the `face-recheck` outcome handler as a SERVICE job that writes FACE_MISMATCH with the sealed key; `face-recheck` job with the 1 MiB and 1920 × 1920 refusals before decoding, frame deletion on every non-mismatch outcome including failure, and outcome hand-off (API writes the event; OI-1 mechanism in ARC-04), hole-tolerant segment concatenation, worker `models.lock.json` |
| backend BE-11 and BE-13 | `close-section` with compare-and-set claim and next-section opening, the snapshot always written and the only graded row, and three variants (the deadline one using `effectiveDeadline` with the pause-aware re-delay); the session auto-submit using the same rule; the `grade-session` flow with `failParentOnFailure` and the GRADED compare-and-set (BE-11 builds it flow-less with a 5 s delay and a 15 s grading sweep, no `render-question` jobs: see the "Architect details for BE-11" block in 5.11); the reconciler for SUBMITTED and overdue live sessions, with its skips; the marker-based R-10 check (5.11, 5.7); submit per 5.11 (`{ accepted, submissionId }` only, with the limits); `grade-session` as a SERVICE session job after SUBMITTED, writing the pinned `SUBMIT` results shape; `render-question` and its projection cache (CS-4.6); jobs and jobIds per CS-4.7; `SessionStateService.closeIngest` and the close of open FULLSCREEN_EXIT rows at session end (5.9). BE-11: the frontend flushes the SDK (bounded) before `/finish`; `analyze-session` (org scope, cross-session) is delayed by the grace (with ARC-04). BE-13: the review UI labels `identity_checks.liveness_passed` as client-reported and advisory (database.md); review bundle with recording gaps, batch-seq holes, recorder health, the unsigned label and server FACE_MISMATCH evidence. |
| frontend | Editor autosave keeps the draft on 409 `SESSION_PAUSED` and retries after resume; it retries a pending save before `/finish` (DL-17). Own the key fetch and the OTP and token refresh, passing results to the SDK hooks (section 2). Inject `NEXT_PUBLIC_PROCTOR_MODEL_BASE`; retire `public/dev-proctor-models/` in favour of `public/models/proctor/`. Check IndexedDB first, then call `proctor-key` after start and after OTP resume, inside a Web Lock; when the key is missing or `KEY_ALREADY_ISSUED`, run the OTP resume; handle `reauthRequired`. Build the system-check call. Pages `_headers` and CSP for models. Sentry scrubbing. Review UI labels and gap panel. `/dev/proctor` uses the lock-served path. |
| QA | DL-17: an unmodified client cannot keep editing with the screen share or side camera stopped (409 `SESSION_PAUSED`); against a modified client, recording-gap detection applies, while FULLSCREEN_EXIT does not block autosave, and the draft survives a 409 and is saved after resume. TC-050 reworded (done in this PR; 5.9). Follow-through: rewrite the SDK test `TC-050 KNOWN DEFECT QA-D-01` (`it.fails` in `packages/proctor-sdk/src/qa/qa-tc.test.ts`) as plain tests (EXIT has no `durationMs`, RESTORED has one); add a BE-10 API-level test of the server-filled `duration_ms`, including the close at session end; remove TC-050 from the known-defect list in `docs/test-matrix.md` (line 15). Then: TC-063 45 s against the 60 s FR-609 threshold (Q13); cross-candidate scope tests including presign and confirm (5.10); B2: oversize PUT deleted by confirm or the sweep, re-PUT after confirm blocked (412) or caught by the sweep, review URLs carry the response overrides; B3: re-check presign and re-check refused with 409 `IDENTITY_CHECK_WAIVED` or `DETECTOR_DISABLED` when either the waiver or "face detectors off" is set (C-34), the re-check route's HEAD/copy/compare-and-set order and its failure cases, a re-PUT to the original key after a FACE_MISMATCH cannot change the sealed evidence, concurrent batches cannot both take one evidence name, a reused name is rejected, an EVENT name sent to re-check gets 400, a RECHECK name in an event is dropped, an unused frame is deleted within 10 min, a frame whose job failed is deleted, a MATCH frame is deleted, and the sweep removes unreferenced re-check frames; licence gate fails when a file of an unverified model is missing from the D-28 list in docs/status.md or its hash differs; submit returns only `{ accepted, submissionId }` and enforces its atomic limits; a later-section read, Run, draft, answer and submit must each answer 409 `SECTION_NOT_OPEN`, and an unresolvable section fails closed with a flushed Redis; a candidate-scope route can never add or remove the PROCTOR pause reason; no candidate-scope read ever returns `reasonCode`, `reasonNote` or `notes` from accommodations; identity uses names, never client keys; a SERVER FACE_MISMATCH is never visible through any candidate route; the CS-4.8 suite (tracked in docs/followups/qa.md with an owner); TC-065 (tamper → 403, identical replay → 200 duplicate, same seq with a different body → 409, other-session key → 403); TC-063 with an epoch change mid-outage; TC-070 with a synthetic hole; TC-056 server gate. New TCs: key issued once per epoch, cross-session evidence name dropped, server-written FACE_MISMATCH, prefix retention removes orphans, licence gate fails on any other unverified file. k6 signer through `k6/crypto`. |
| deploy (QA track) | `models:fetch` and the licence gate in the DEP-01, DEP-03 and production workflows; protected environments; controls 0 to 4 (with 1b) of section 6 tracked as owner actions; bucket CORS (PUT with Content-Type) per ST-7 |
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
8. **COCO-SSD (F-3) for the pilot. Answered by C-10:** object detection stays on as an accepted risk. The gate admits exactly the pinned files listed under D-28 in `docs/status.md` (section 6).
9. **Gate protection (section 6, controls 0 to 4).** All of these are owner decisions. Control 0 is **not adopted** by C-33, pending your own confirmation; the accepted-risk paragraph in section 6 applies.
   - a separate bot account (or a GitHub App) for agents, with a token issued for that account and never a token of your account, holding Write, not Admin, and no Variables, Secrets, Environments or Administration permission;
   - branch protection or rulesets on `main` with bypass disallowed and administrators included;
   - a deployment branch policy (`main` only) on `pilot` and `production`;
   - `CODEOWNERS` covering both lock files, `packages/proctor-sdk/package.json`, the self-contained gate folders, `.github/workflows/**`, `.github/CODEOWNERS` and `docs/status.md`;
   - the best-effort deny patterns of control 4 in the agents' permission settings (the owner changes those, not the hub).

   Until a separate identity exists, even controls 1 to 4 do not stop an agent that uses your credentials. CODEOWNERS and branch protection alone can be bypassed with the shared admin login.
10. **Per-IP throttle on candidate routes**: replace the per-IP throttle (FU-BE-18) with per-session limits on the routes in this ADR (recommended, for test centres behind NAT), or keep both?
11. **Serving models from Cloudflare Pages** (25 MiB per-file limit, same origin as the app), with object storage behind the same origin kept as the fallback?
12. **Flagged schema changes**: approve separate ADRs for a durable key-issue marker and `media_chunks.etag`, or accept the Redis fail-open risks described in sections 2 and 5.5?
13. **TC-063 against FR-609**: the test drops the network for 45 s but expects DISCONNECTED, which FR-609 logs only after 60 s. Change the test duration (recommended) or the FR?
14. **The fullscreen duration** after an outage (5.9) uses the client-reported `occurredAt` difference. Accept that, knowing it is client-influenced?
15. **FR-606 change**: FACE_MISMATCH moves from a browser check every second to a server re-check every 2 minutes, which is new server-side biometric processing.
16. **Consent PDF outside the session prefix** (5.7), amending ADR 0004 §8. The 3-year retention, kept through erasure, is decided by C-17; only the layout is asked here.
17. **What the candidate sees after the test, and FR-502.** The submit response now carries no results (5.11), and hidden tests are graded after SUBMITTED. After the test, should the candidate see nothing beyond "submitted" (the default), a score, or pass/fail? Should FR-502's "Submit runs hidden tests" be reworded to match?
18. **Candidate-safe question snapshot.** Keep the Redis projection for the pilot (recommended, no schema change), or add a `session_questions.prompt jsonb` snapshot column through an ADR 0008 schema change?
19. **Reading finished sections.** May a candidate re-read the questions of a finished section? The default refuses with 409 `SECTION_NOT_OPEN` (CS-4.6).
20. **Retention clocks against C-26 (5.7; confirm against PR #48). The face tier is decided by C-35.**
   - (a) **Media tier.** C-26 says recordings and other session media stay 90 days, but the media tier uses `retention_days` (7..730). Should it be fixed at 90?
   - (b) **EVENT evidence frames** (`evidence/*.jpg`, webcam stills) are in the media tier, though OQ-5 listed face evidence frames. Should they move to the face tier?
   - (c) **Results clock.** C-26 says "1 year after the test"; the ADR uses the anchor. Confirm which.
21. **Section-finish during a PROCTOR pause (candidate-facing; 5.10 CS-4.6).** Recommended: refuse section-finish with 409 `SESSION_PAUSED` during a PROCTOR pause, and defer opening the next section until resume when a close runs while PAUSED with PROCTOR.
22. **Snapshot marker (5.11).** Keep identifying the graded snapshot by `created_at = ended_at` (no schema change; the interim), or add a `submission_kind` value `SNAPSHOT` (an ADR 0008 delta)? **Recommendation updated 2026-10-06 (P-28, FU-BEB-89): add `SNAPSHOT`**, because Prisma sets `created_at` at millisecond precision.
23. **Judge0 retention (section 7).** Judge0 CE stores candidate source code and hidden-test stdin in its own database. Should it be deleted after grading (recommended) or kept with the results tier (1 year, C-26)? Erasure must reach it either way. This is also a Legal question.

**Architect details to confirm**

24. Names and limits: `SESSION_KEY_ENC_KEY_<kid>`, `PROCTOR_INGEST_GRACE_SECONDS`, per-route limits and quotas, 16 MiB per chunk, 1 MiB and 1920 × 1920 per image, the 15-minute freshness of the system check, JWT `iss` and `aud`.
25. Candidate-session enforcement (5.10 CS-4): the actor model, the CANDIDATE model and column allowlists, all six relation vectors refused, the `render-question` projection, and start-test as an awaited session job.
26. The onnxruntime variant: the plain wasm only, with object storage as the fallback if vad-web needs jsep (section 6).
27. Media `seq` per stream across segments, following ADR 0004 (the SDK changes, not the schema).
