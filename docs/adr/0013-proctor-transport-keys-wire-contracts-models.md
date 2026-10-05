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
- At VERIFIED → IN_PROGRESS, BE-07 generates a 32-byte master key `M` (CSPRNG) and stores it in `sessions.hmac_key_enc` as `v1:<b64 nonce>:<b64 ciphertext+tag>`, AES-256-GCM under env key `SESSION_KEY_ENC_KEY`, with **AAD = session id**, so a ciphertext copied to another row does not decrypt. The `v1` prefix allows rotating the env key.
- The browser never receives `M`. For each `sessions.auth_epoch` value `e` (ADR 0002 L-2), the batch key is `K_e = HMAC-SHA256(M, UTF-8("codeproctor:batch-key:v1:" + sessionId + ":" + e))`. Derivation is deterministic, so there is no extra storage or schema change.

**Delivery: once per epoch, kept as a non-extractable CryptoKey.**
- `POST /candidate/session/proctor-key` (section 4) returns `K_e` for the token's epoch, **once**. A Redis `SET NX` on `pkey:{sessionId}:{e}` (TTL 24 h) blocks a second issue (409 `KEY_ALREADY_ISSUED`). The frontend calls the route right after the start-test call succeeds and after each OTP resume. Both events create a new key context, so the route always works at those points.
- The SDK imports the key with `extractable: false` and stores the `CryptoKey` object in IndexedDB (`{sessionId}:hmacKey`, with its epoch). A page reload on the same epoch loads it from IndexedDB, so the raw bytes exist in JS only for the moment of import. Chrome and Edge (NFR-07) can structured-clone CryptoKeys into IndexedDB.
- If the key is missing (IndexedDB cleared, response lost), the frontend runs the OTP resume (ADR 0002 L-2), which raises the epoch, and fetches a new key. The clock keeps running.
- The key is never logged, never put in a URL, never written to localStorage and never sent to error tracking. The response carries `Cache-Control: no-store`.

**Rotation and revocation.**
- Each OTP success raises `auth_epoch`. The old device's token dies (ADR 0002), and new batches must be signed with `K_current`.
- After an epoch change, the SDK **re-signs its unsent outbox** with the new key. It stores the exact body, so only the signature changes.
- Ingestion closes at `submitted_at + PROCTOR_INGEST_GRACE_SECONDS` (default 300). A job then sets `hmac_key_enc = NULL` (key destruction). Stored signatures cannot be re-verified afterwards. That is acceptable because they are kept only for idempotency (below). **(architect detail, owner to confirm; ARC-04 delays `analyze-session` by the same grace)**

**Canonical JSON and transport: the SDK's scheme is confirmed.**
- Signed string `S = canonicalJson({ seq, events })` for events, and `canonicalJson({ seq, sessionQuestionId, startedAt, events })` for keystrokes (the ADR 0010 batch shapes, unchanged). Canonical means RFC 8785 (JCS) as the SDK implements it: object keys sorted by UTF-16 code units, no whitespace, ECMAScript number and string serialisation, `undefined` members dropped, non-finite numbers refused, UTF-8 bytes.
- The request body **is** `S` byte for byte. `X-Signature` = lowercase hex HMAC-SHA256(`K_e`, UTF-8 bytes of `S`), exactly 64 characters `[0-9a-f]`. No signature field in the body, no request `Content-Encoding` (415).
- **The server verifies the received bytes, never a re-serialisation.** Canonical form only makes signatures reproducible for other clients and for tests (k6, QA). The server does not check that a body is canonical.

**Verification order (BE-10, both batch routes).** Use a raw-body parser on these two routes only.
1. Authenticate the candidate token, then check the epoch (401).
2. Check state (409 `SESSION_NOT_ACTIVE`): IN_PROGRESS, PAUSED, or SUBMITTED within the grace.
3. Enforce the size limit **while streaming**: 413 above 256 KiB (`MAX_EVENT_BATCH_BODY_BYTES`) for events, 2 MiB (`MAX_KEYSTROKE_BATCH_BODY_BYTES`) for keystrokes.
4. Check the `X-Signature` format, then compare in constant time (`timingSafeEqual`) with `HMAC(K_current, rawBytes)`. On a mismatch:
   - if the signature matches one of the previous 8 epoch keys, return 409 `KEY_EPOCH_STALE` (the SDK re-signs);
   - otherwise return 403 `SIGNATURE_INVALID` (TC-065).
5. Decode as strict UTF-8, then `JSON.parse`, then the shared zod schema. Each failure is a 400 `VALIDATION_FAILED` whose errors never echo values.
6. In one transaction, insert the batch row (`proctor_event_batches` or `keystroke_batches`) and its events. On a `(session_id, seq)` conflict, recompute HMAC(`K_e`, rawBytes) for each `e` from 0 to current and compare with the stored signature:
   - a match is a retry (or a re-signed retry), so return 200 with `duplicate: true` and store nothing;
   - otherwise return 409 `SEQ_CONFLICT` (TC-065).

   Because the keys are derived, this check needs no per-batch epoch column.

Derived keys may be cached in process, keyed by `(sessionId, epoch)`, with a 60-second TTL. That avoids an AES decrypt per request (NFR-01).

**Sequence numbers across devices.** `seq` is unique per session, while a new device starts with empty IndexedDB, so a fresh counter would collide with stored batches (409 or silent loss). The `proctor-key` response therefore returns `counters`, and the SDK starts each counter at `max(local, server)`:
- `eventSeqStart` and `keystrokeSeqStart`: the stored maximum + 1;
- per media stream, `nextSeq` and `nextSegment`.

**What the key protects and what it does not (R-04, TB-1).**

| Protects against | Does not protect against |
| --- | --- |
| Forgery or modification of a batch by anyone without the key, including someone who has only the candidate token. The key is issued once per epoch and is non-extractable, which is what makes it more than the token. | The candidate. The key lives in their browser, so a modified SDK can sign anything, suppress events or fake timestamps. Server re-checks and human review compensate (ADR 0001 §7). |
| Replay: an identical replay is a no-op, a modified replay is rejected (TC-065), a batch from another session fails (per-session key), and keys from older epochs cannot sign new batches | XSS on the candidate origin, which can sign through the live CryptoKey while it runs (it cannot export the key). The strict CSP is the control. |
| Silent loss of signed batches goes unnoticed: holes in `seq` on `proctor_event_batches` and `keystroke_batches` become visible (section 5.8) | Later re-verification of stored rows. Events are stored parsed and stripped (ADR 0010), so the signature only serves idempotency. Evidential integrity comes from the append-only audit log and access control, not from the HMAC. |

## 3. Events before the key exists (decision 2)

Decision: **unsigned, token-authenticated, advisory input, flagged as unsigned**. This confirms ADR 0002 §3 option (a); no key is issued earlier.
- The system-check page runs the SDK's `checkMultiScreen` and `checkVirtualCamera` and sends the result to `POST /candidate/session/system-check` (section 5.4).
- The server stores each MULTI_MONITOR or VIRTUAL_CAMERA finding as a `proctor_events` row with `source = CLIENT` and `batch_seq IS NULL`. That combination is the "unsigned, pre-start" marker; today `batch_seq IS NULL` occurs only with `source = SERVER`, so no schema change is needed. The review UI labels these rows "System check (unsigned)".
- They are on the timeline but **not scored** by default. A candidate told to unplug a monitor must not carry 20 points for complying. **(owner to confirm, Q3)**
- **Server-side gate (FR-605, TC-056).** The start-test call refuses with 409 `SYSTEM_CHECK_BLOCKED` unless the latest system check has no blocking finding. The gate proves that the check ran; it cannot prove that the result is true.
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

- **SDK mapping.**
  - 2xx: OK.
  - 401, 408, 429, 5xx and network errors: retry.
  - `KEY_EPOCH_STALE`: re-sign, then retry.
  - `SESSION_NOT_ACTIVE`: stop and purge.
  - 400, 403, `SEQ_CONFLICT`, 413, 415: drop the batch and count it in `getQueueStats().rejected`; never silently.
- **Evidence references.** `evidenceKey` in an event is the **session-relative name** returned by evidence presign (`evidence/<ULID>.jpg`). It matches the ADR 0010 regex.
  - The server stores the full key (section 5.7) in `proctor_events.evidence_key`.
  - A name that was not issued to this session (Redis set `evidence:{sessionId}`) is dropped from that event (`evidence_key` NULL), and the batch still succeeds.
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
- A repeatable job every 15 s writes DISCONNECTED `{ lastHeartbeatAt }` for IN_PROGRESS and PAUSED sessions silent for more than 60 s.
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
| Rules | `stream` is SCREEN, WEBCAM, AUDIO or ROOM_SCAN; SIDE_CAMERA waits for ARC-03 part 2. `contentType` is exactly `video/webm` or `audio/webm`, with no codecs parameter, so the signed header matches. `bytes` ≥ 1 and ≤ 16 MiB (AUDIO 4 MiB). `durationMs` 1..60,000. `startedAt` is clamped. | — |
| States | ROOM_SCAN: CONSENTED. Other streams: IN_PROGRESS, PAUSED, or SUBMITTED within the grace. | same |
| 200 | `{ url, method: "PUT", headers: { "Content-Type": ... }, expiresAt }`, valid 60 s, Content-Type and Content-Length signed (ST-2, ST-3); or `{ alreadyUploaded: true }` | `{ uploaded: true, sizeBytes }`, idempotent |
| Errors | 400; 409 `SEQ_CONFLICT` (seq exists with another segment); 409 `SESSION_NOT_ACTIVE`; 429 | 404 `CHUNK_NOT_PRESIGNED`; 409 `UPLOAD_NOT_FOUND` (HEAD 404: upload again, presigning again if expired); 422 `UPLOAD_MISMATCH` (HEAD size or type differs: the server deletes the object, the row stays pending, the client presigns again) |
| Limit | 60 per minute per stream | same |

- **Rows.** Presign upserts `media_chunks (stream, segment, seq)` as pending. Confirm HEADs the object, then sets `uploaded_at` and `size_bytes`.
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
| States | IN_PROGRESS, PAUSED | IN_PROGRESS, PAUSED; 409 `DETECTOR_DISABLED` when FACE is disabled by accommodation (FR-305) |
| 200 / 202 | 200 `{ url, method: "PUT", headers, evidenceKey: "evidence/<ULID>.jpg", expiresAt }` | **202 `{ accepted: true }`. No match result is returned to the browser.** |
| Errors | 400, 409 `SESSION_NOT_ACTIVE`, 429 | 400 (unknown or wrong-purpose name), 409, 429 |
| Limit | 20 per minute | 1 per 60 s (SDK interval 120 s) |

**Decision: the server writes the re-check outcome itself.**
- The API enqueues `face-recheck` on the face-match queue, at a lower priority than initial checks. The worker HEADs and reads the frame, compares it with the selfie of the latest identity attempt (cached embedding, ADR 0004 §2), and returns `{ outcome: MATCH | BELOW_THRESHOLD | NO_FACE | MULTIPLE_FACES | ERROR, score, modelId, threshold }`.
- On BELOW_THRESHOLD, the API writes FACE_MISMATCH with `source = SERVER`, `occurred_at` = the clamped `capturedAt`, `payload { similarity }` and `evidence_key` = the frame. Any other outcome deletes the frame at once (NFR-05).
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
| Signed consent PDF | `orgs/{orgId}/consents/{sessionId}/{ULID}.pdf` (**outside** the session prefix, because it is kept until erasure, D-17) | API | `consents.pdf_key` |
| Live thumbnail (BE-13, if stored) | `orgs/{orgId}/sessions/{sessionId}/live/{ULID}.jpg` | browser | none (transient) |

- **Retention (R-4)** deletes the whole prefix `orgs/{orgId}/sessions/{sessionId}/` with ListObjectsV2 and DeleteObjects, then nulls the columns. That also removes orphans: never-confirmed chunks, frames whose job failed, unreferenced evidence.
- **Erasure (R-6)** deletes the session prefix and `orgs/{orgId}/consents/{sessionId}/`.
- **Media chunk keys are deterministic**, so a retried presign overwrites the pending object. Once an object is confirmed, presign returns `alreadyUploaded`.

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

- The SDK emits FULLSCREEN_EXIT **immediately, with no `durationMs`**. FULLSCREEN_RESTORED carries `durationMs`. The SDK already does this, so it needs no change, and the ADR 0010 payloads are unchanged.
- **The server is authoritative.**
  - On FULLSCREEN_RESTORED, BE-10 finds the session's latest FULLSCREEN_EXIT row whose `duration_ms` is NULL. It sets `duration_ms` = the RESTORED row's `created_at` minus the EXIT row's `created_at` (the delta between server receive times). The client `durationMs` is only a cross-check: when the two differ by more than 10 s **(architect detail)**, the row keeps the server value and the difference is recorded in the RESTORED row's stored payload metadata for the reviewer.
  - When the session ends (SUBMITTED, including auto-submit) or expires, SessionStateService closes any still-open FULLSCREEN_EXIT with `duration_ms` = session end time minus the EXIT row's `created_at`.
- **Edge case (owner or hub to confirm).** After an outage, both rows can arrive in one batch or long after the event, so the receive-time delta understates the real duration. In that case (both rows received within 1 s of each other), BE-10 uses the clamped `occurredAt` delta instead.
- The risk score (BE-12) reads `duration_ms` from the row and never the client value.
- QA rewords TC-050 to "FULLSCREEN_EXIT logged immediately; duration filled in on restore or at session end".

### 5.10 Candidate-session scope (needed before BE-07)

Org scoping (ADR 0006, C-1) does not stop one candidate from reading another candidate's session in the same org. Every candidate route is therefore scoped to **one session, taken from the token**.

- **Token.** The candidate JWT is signed with its own secret (C-4), separate from the staff secret. It carries `typ: "candidate"`, `sid` (session id), `oid` (org id) and `epoch`.
  - Lifetime, storage and device binding are left to ARC-03 part 2.
  - Staff tokens are rejected on `/candidate/*` (401), and candidate tokens on staff routes (401). The guard checks `typ` and the secret, not only the role.
- **Guard (BE-07).** `CandidateSessionGuard` runs on every `/candidate/*` route except the OTP exchange.
  - It verifies the token and loads `sessions` by `sid`.
  - It checks that `org_id = oid` and `auth_epoch = epoch`; a mismatch is 401.
  - It then sets a request-scoped `CandidateContext { sessionId, orgId, epoch, status }` and the `OrgContext` (ADR 0006).
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
  - (b) The org scope also carries `sessionId` for candidate units of work. The db-engineer's org-scope Prisma extension (PR #30, ADR 0006) then adds `session_id = ctx.sessionId` to every read of a table on the session path (`sessions`, `session_questions`, `session_sections`, `submissions`, `identity_checks`, `media_chunks`, `proctor_event_batches`, `proctor_events`, `keystroke_batches`, `consents`).
  - **Recommended: (b) as the structural control, plus (a) as explicit service-level checks for defence in depth.**
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
- `models:update` is run by a person or agent with network access. It refreshes `sha256`, `bytes` and `version`, and never changes `licence` or `status`; those are edited by hand in a reviewed PR.

CI and deploy:
- **CI** (`ci.yml`, hub-owned) runs `models:fetch` with a cache keyed on the lock digest and verifies the hashes.
- **CI also fails** if any `*.tflite`, `*.task`, `*.onnx`, `*.wasm` or `apps/web/public/models/**` file is tracked in git. `apps/web/public/models/` goes into `.gitignore`.
- **Serving.** Cloudflare Pages `_headers` sets `/models/proctor/*` to `Cache-Control: public, max-age=31536000, immutable` and `.wasm` to `application/wasm`. The CSP keeps `script-src 'self' 'wasm-unsafe-eval'` with no third-party model CDN.
- **Licence gate (deploy).** `models:licence-gate --env <staging|pilot|production>` behaves as follows:

  | Environment | `blocked` entry | `unverified` entry |
  | --- | --- | --- |
  | staging (synthetic data only) | fails | warning |
  | pilot, production | fails | fails, unless covered by an owner override |

  - An override is the GitHub **Environment** variable `MODEL_LICENCE_OVERRIDES` on the protected `pilot` or `production` environment, whose required reviewer is the owner. Its value is a list of `<name>@<sha256>=<decision-id>` entries, for example `…=D-28+B-05`.
  - The override names the exact hash, so swapped weights invalidate it.
  - The gate prints which overrides it applied.
  - Agents cannot set environment variables (CLAUDE.md, ADR 0009), so only the owner can record one.
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

**Proposed ADR 0010 amendments (not applied; `packages/shared` unchanged):**
- add FACE_MISMATCH to `SERVER_EVENT_TYPES`, and drop it from `CLIENT_EVENT_TYPES` once the SDK ships;
- `SCREEN_SHARE` in `PROCTOR_DETECTORS`, plus an accommodation subset;
- `capabilityFlagSchema` and `deviceInfoSchema`;
- the `proctor-key` and heartbeat zod shapes;
- if Q6 is yes, a server reason `NOT_REPORTED` on DETECTOR_UNAVAILABLE, or a `RECORDING_GAP` type.

## 8. Consequences and per-agent changes

- **No schema change.** `batch_seq IS NULL AND source = CLIENT` gains a meaning, and `hmac_key_enc` is nulled at ingest close.
- **Contract changes ripple** to the SDK, BE-07, BE-09, BE-10, BE-12, BE-13, the frontend, QA and deploy.
- **NFR-02 load.** At 200 candidates there are about 120 requests per second for presign and confirm, plus 20 for heartbeats, about 40 for event batches and about 100 for keystroke batches. k6 must cover presign and confirm (TC-090, TC-091). Batching confirms is the first lever if p95 suffers.

| Agent | Must do |
| --- | --- |
| proctor-sdk | Accept a CryptoKey (or base64), persist it non-extractable in IndexedDB, re-sign the outbox on a new epoch or `KEY_EPOCH_STALE`, and seed counters from `proctor-key` (max with local). Map status codes as in 5.2, and stop on `SESSION_NOT_ACTIVE`. Add the heartbeat body and its 409 handling. For media: send `startedAt` and `durationMs`, handle `alreadyUploaded`, `UPLOAD_MISMATCH` and `UPLOAD_NOT_FOUND`, and never drop a segment's first chunk. Evidence presign gets `purpose` and uses the relative name. Re-check becomes upload plus 202, and client FACE_MISMATCH emission is removed. Add a `runSystemCheck()` helper. Replace `fetch-models.mjs` with lock scripts. Purge the key and outbox at finish. Never log URLs. |
| backend BE-07 | Candidate-session scope (5.10: token claims, `CandidateSessionGuard`, CS-1..CS-4, cross-candidate tests) before any other candidate route; master key, AAD, epoch derivation, the `proctor-key` route, system-check route and start gate (TC-056), heartbeat and watchdog, key destruction at ingest close |
| db-engineer (DB-05, PR #30) | Let the org-scope context carry an optional `sessionId` for candidate units of work, and AND it into session-path reads (5.10 CS-4 option (b)) |
| backend BE-09 | Key layout 5.7, presign and confirm 5.5, evidence presign 5.6 and the Redis name set, prefix deletion in retention and erasure, consent PDF prefix |
| integrity BE-10 | Raw-body verification order (section 2), fullscreen duration fill-in on FULLSCREEN_RESTORED (5.9), duplicate check across epochs, error codes, evidence-name resolution, grace window, per-session limits, a `rejected` metric with no body |
| integrity BE-12 | Score from server `duration_ms` only (5.9); `face-recheck` job and outcome hand-off (API writes the event; OI-1 mechanism in ARC-04), hole-tolerant segment concatenation, worker `models.lock.json` |
| backend BE-11 and BE-13 | SessionStateService (BE-07/BE-11) closes open FULLSCREEN_EXIT rows at session end (5.9). BE-11: the frontend flushes the SDK (bounded) before `/finish`; `analyze-session` is delayed by the grace (with ARC-04). BE-13: review bundle with recording gaps, batch-seq holes, recorder health, the unsigned label and server FACE_MISMATCH evidence |
| frontend | Call `proctor-key` after start and after OTP resume; when the key is missing or `KEY_ALREADY_ISSUED`, run the OTP resume. Build the system-check call. Pages `_headers` and CSP for models. Sentry scrubbing. Review UI labels and gap panel. `/dev/proctor` uses the lock-served path. |
| QA | TC-050 reworded (5.9); cross-candidate scope tests (5.10); TC-065 (tamper → 403, identical replay → 200 duplicate, same seq with a different body → 409, other-session key → 403); TC-063 with an epoch change mid-outage; TC-070 with a synthetic hole; TC-056 server gate. New TCs: key issued once per epoch, cross-session evidence name dropped, server-written FACE_MISMATCH, prefix retention removes orphans, licence gate fails on unverified without override. k6 signer through `k6/crypto`. |
| deploy (QA track) | `models:fetch` and the licence gate in the DEP-01, DEP-03 and production workflows; protected environments with the owner as required reviewer; bucket CORS (PUT with Content-Type) per ST-7 |
| hub, on acceptance | fsd.md §4 rows; api-contract.md error codes (after #31 and #33 merge); database.md comments (`batch_seq`, `hmac_key_enc`, `device_info`); architecture.md Security bullet; ADR 0010 amendment; ADR 0001 OI-3 and OI-9 marked decided; the `ci.yml` model job |

## 9. Owner questions

1. **Key loss costs an OTP round trip** while the clock runs (IndexedDB cleared, response lost). Accept this, or allow re-issue to any token holder? Re-issue is simpler but makes the HMAC no stronger than the token.
2. **Ingest grace** after SUBMITTED: 300 s for batches and media, with `analyze-session` delayed to match, and the key destroyed at the end (architect detail).
3. **Pre-start unsigned findings**: show them on the timeline but leave them unscored (recommended), or score them?
4. **Re-check frames**: a 640 px JPEG every 2 minutes, kept only on a mismatch and deleted otherwise. Does the consent document (D-17, Legal) cover this?
5. **Repeated server FACE_MISMATCH**: should, for example, 2 consecutive mismatches route the session to the identity manual-review gate? That needs a schema and shared change, because `identity_checks.attempt` is limited to 1..2.
6. **Missing re-checks, recording gaps and tamper signals** (`SEQ_CONFLICT`, `SIGNATURE_INVALID`): should the server log an event a reviewer sees? Should it carry risk weight? Either needs an ADR 0010 amendment.
7. **`SCREEN_SHARE` detector value**: add it (recommended), what weight should its DETECTOR_UNAVAILABLE carry, and confirm it is never an accommodation.
8. **COCO-SSD (F-3) for the pilot**: (a) an owner override after Legal review (B-05), (b) deploy without object detection, or (c) a swap after a licence check. And confirm that only you set `MODEL_LICENCE_OVERRIDES`.
9. **Env names and limits** (`SESSION_KEY_ENC_KEY`, `PROCTOR_INGEST_GRACE_SECONDS`, per-route limits, 16 MiB per chunk, 1 MiB per image) are architect details to confirm.
10. **Fullscreen duration edge case (5.9)**: after an outage, should the clamped `occurredAt` delta replace the receive-time delta, and is 10 s the right cross-check tolerance? This refines hub decision QA-D-01.
11. **Candidate-session enforcement (5.10 CS-4)**: use the Prisma extension with `sessionId` (b) as the structural control, plus service checks (a), as recommended (architect detail)?
