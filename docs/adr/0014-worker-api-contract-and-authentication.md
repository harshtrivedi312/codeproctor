# ADR 0014: Worker to API contract and worker authentication (ARC-04)

| Field | Value |
| --- | --- |
| Status | **Proposed** 2026-10-05. The owner accepts or amends. "(owner decision C-xx / D-xx)" marks what docs/compliance/decisions.md or status.md already decides. "(architect detail)" marks what this ADR adds, for the owner to confirm. "(not verified)" marks facts the architect could not check. Section 12 lists the owner questions. |
| Author | architecture hub |
| Decides | ADR 0001 OI-1 (Q-21, Q-22) and TB-6; the worker half of OI-8 (face-matching integration, model pinning, use of AI reference solutions); the ARC-04 items ADR 0013 "Leaves to" (worker job interface, `analyze-session` delay, worker model lock) |
| Serves | FR-305, FR-403, FR-606, FR-607, FR-802, FR-803, FR-804, FR-805; NFR-01, NFR-02, NFR-03, NFR-04, NFR-05, NFR-09; TC-033, TC-061, TC-073, TC-074, TC-075, TC-076 |
| Builds on | ADR 0001 (TB-6, C-5, C-7, C-9, ST-1..ST-8, section 12), ADR 0004 (sections 1, 2, 9.1, 9.5), ADR 0005 (sections 1, 2, 4), ADR 0006 section 8 (PR #41), ADR 0010, ADR 0013 (5.6, 5.7, 5.10 CS-4, 5.11, 6) as revised by PR #68 (`withLiveSession`, `withAnySession`), ADR 0015 (PR #49, C-25 and C-34 refusals) |
| Depends on | PR #68 (ADR 0013 rounds 9 to 12) and PR #41 (ADR 0006 section 8), both unmerged when this was written. The hub confirms this ADR against them after they merge. ADR 0015 is on main (Proposed), so 0014 is the next free number. Code read: `apps/worker` on main, PR #59 (`integrity/face-match-worker`). ADR 0013 line numbers cited below are main at b569003 |

## 1. Context

`apps/worker` exists on main as a FastAPI app with three routes (`/analyze/keystrokes`, `/analyze/similarity`, `/risk`) behind a provisional static header `X-Internal-Token`. PR #59 adds the face-matching module (AuraFace `glintr100.onnx` and MediaPipe, never a rejection) with no route. Nothing defines who consumes the BullMQ jobs, how results become database rows, how the worker reads media, or how it is authenticated (Q-21). The docs also disagree on when GRADED happens (Q-22: fsd.md §3 says "hidden tests and risk score done"; ADR 0013 5.11 moves to GRADED when grading completes). Meanwhile, ADR 0013 and ADR 0006 §8 made the API's `SessionJobProcessor`, `runAsSessionJob` and `withLiveSession` the only way to write session data. Those are Node constructs: the Python worker cannot use them.

## 2. Decisions at a glance

| # | Decision | Marker |
| --- | --- | --- |
| D1 | **The API owns every queue.** All BullMQ jobs are consumed by API processors (`SessionJobProcessor`). The worker is a **stateless internal HTTP compute service**. The API calls the worker; the worker never calls the API and connects to no database, no Redis and no queue | architect detail |
| D2 | **Request signing.** Each API-to-worker request is HMAC-SHA256 signed (key id, timestamp, nonce, body hash), and each worker response is signed back. Per-environment keys, rotated with two active key ids. The worker runs on a private network with no inbound internet access, and its only egress is the object store. Plain HTTP is allowed **only** on a single-host Docker `internal: true` network; TLS (mTLS recommended) is **required** before any API-to-worker traffic crosses a host or VPC boundary (4.4) | architect detail |
| D3 | **Least privilege for media.** The worker gets **presigned GET URLs** for the exact objects one call needs (60 s for face calls, 5 minutes for analysis). It holds no S3 credentials. It never writes objects. It fetches only URLs on the configured object-store allow-list, with no redirects (4.5). Reading sealed objects this way **depends on owner question 3** (5.1) | architect detail |
| D4 | **Writes only through the API.** Results come back in the HTTP response, and the API writes them in `withLiveSession` (actor SERVICE, `runAsSessionJob`, `guardLive`). The worker has no database credentials | architect detail; `guardLive` and `withLiveSession`: ADR 0013 (C-23) |
| D5 | **Q-22.** SUBMITTED → GRADED when grading is done (as ADR 0013 5.11). GRADED → UNDER_REVIEW once analysis has finished or has been abandoned, **always** to UNDER_REVIEW | GRADED always goes to UNDER_REVIEW: owner decision C-28; ordering: architect detail |
| D6 | **Contracts.** Versioned `/v1/` routes with camelCase JSON and RFC 7807 errors. The worker's generated OpenAPI is the source of truth (as ADR 0012 does for the API). Section 6 defines the routes | architect detail |
| D7 | **Model lock.** `apps/worker/models.lock.json` uses the ADR 0013 §6 format. The four InsightFace files are `blocked`, and AuraFace passes only through the D-28 acceptance list. The worker refuses to start on any unlisted or blocked model file | lock format: ADR 0013; AuraFace acceptance: owner decision C-10 / D-28; F-1 rule: D-16 |

## 3. Transport: who calls whom (D1, D5)

### 3.1 Options

| Option | For | Against |
| --- | --- | --- |
| (a) Python worker consumes BullMQ (Python client) and writes the DB itself | No HTTP hop | A second schema consumer with no Prisma org-scope extension, no `runAsSessionJob`, no `guardLive` (ADR 0006 §8, ADR 0013 CS-4). BullMQ Python supports only a subset of features (ADR 0001 §8, verified). Two places to get erasure right |
| (b) Python worker consumes BullMQ and posts results to an internal API route | No DB access from Python | The API needs an inbound service-auth route, and the worker needs Redis credentials. Two queue implementations; job state is split across two runtimes. Results cross Redis or HTTP twice |
| **(c) API processors consume BullMQ and call the worker over HTTP (chosen)** | One queue runtime, one writer, and every write sits behind `withLiveSession`. The worker needs no credentials except the HMAC key. Idempotency, retries and the ERASED stop live in one place. The existing worker routes already have this shape | One synchronous HTTP call per piece of work; long calls need timeouts and bounded windows (6.6) |
| (d) Worker pulls work from an API "lease" endpoint | Natural back-pressure | Needs an inbound API route with service auth, and reinvents the queue |

### 3.2 Who does what

| Concern | Owner |
| --- | --- |
| Enqueue, dedupe (jobIds per ADR 0013 CS-4.7), retries, delays, flows | API (BullMQ, Node) |
| Read session data, the corpus and AI reference solutions; issue presigned GETs | API processor, in scope (3.4) |
| Compute: face detection, embedding and comparison; VAD; keystroke analytics; similarity; risk score | Worker (pure functions of the request; with the default `cacheSelfie: false` nothing is kept between calls, 6.3) |
| Write `identity_checks`, SERVER `proctor_events`, `sessions.risk_score` and `risk_band`, status transitions | API, in `withLiveSession` and `SessionStateService` |
| The selfie embedding cache | **Off by default** (C-18; ADR 0004 question 1 open). If the owner allows it: worker process memory only (ADR 0004 §2 and 9.1) |

The BullMQ consumers run in the API process today (ADR 0001 §2). Production may run them as a second process from the same image (architect detail).

### 3.3 Jobs that call the worker

| Job (jobId) | Actor and entry | Worker calls | Writes (under `withLiveSession`) |
| --- | --- | --- | --- |
| `face-match` (`face-match:{sid}:{attempt}`) **new CS-4.7 row** | SERVICE session job | `POST /v1/face/match` | `identity_checks` status, score, `model_id`, `threshold`, `review_reason`; IDENTITY_MANUAL_REVIEW (SERVER) when it goes to MANUAL_REVIEW |
| `face-recheck` (`face-recheck:{name}`), ADR 0013 5.6 | SERVICE session job. ADR 0013 lists the worker job and its outcome handler separately; here they become **one** API processor (call, then write) | `POST /v1/face/recheck` | FACE_MISMATCH (SERVER) on BELOW_THRESHOLD; otherwise it deletes the sealed frame (ADR 0013) |
| `analyze-session` (`analyze-session:{sid}`) | SERVICE session job with one `runInOrg(orgId)` read phase (3.4) | `/v1/analyze/keystrokes`, `/v1/analyze/similarity`, `/v1/analyze/vad`, `/v1/risk` | SERVER findings; `risk_score`, `risk_band`; `device_info.analysis` (6.7) |
| `route-session` (`route-session:{sid}`) **new** | SERVICE session job | none | GRADED → UNDER_REVIEW through `SessionStateService` |
| ingest close and erasure (ADR 0013 2, 5.7) | existing (`withAnySession`) | `POST /v1/face/evict`, best effort, never blocking | none |

**Payloads carry ids only (architect detail):** `{ orgId, sessionId, attempt? , evidenceName? }`. They never carry code, URLs, object keys or results. ADR 0013 5.6 step 5 enqueues `face-recheck` "with the sealed key". That becomes the evidence **name**, and the processor rebuilds the key from the payload's org and session (CS-3). BullMQ `returnvalue` is empty, and `failedReason` is a fixed code (ADR 0013 CS-4.7).

**Job ids never reach the worker or the logs (architect detail).** The `face-recheck` jobId contains the evidence name, and ADR 0013 line 145 says evidence names are never logged. So `X-Request-Id` on a worker call is a fresh random ULID per call, never the jobId or anything derived from it. The API logs that ULID next to the job **type** and attempt number only. It never logs the jobId of `face-recheck` or `evidence-expire`.

### 3.4 Scope sequence inside one processor

ADR 0006 §8.4 lets a scope only narrow, and a plain org scope can never narrow into a session scope. `analyze-session` needs a cross-session read (the similarity corpus) and a session write. So the processor runs **sequential, non-nested** scopes from the empty store that `detachForSessionJob` gives it (architect detail):

1. **Pre-check** in `runAsSessionJob(oid, sid)` (read only): stop if the session is ERASED or has `RETENTION_RESULTS_DONE`; load the accommodations projection, the org settings and the session's own data (keystroke batches, events, graded snapshots, AUDIO chunk rows).
2. **Corpus read** in `runInOrg(oid)`: other sessions' graded snapshots, plus `ai_reference_solutions` (AI-2). This is a new FU-DB-67 call site; it is the only reader of `ai_reference_solutions` outside the author API (AI-3). **Corpus filter (all must hold; architect detail, the last item pending owner question 5):**
   - same org (the scope) and same `question_version_id`;
   - session status is not ERASED, and the candidate has no erasure fence pending (`erasure_requested_at` NULL and `erased_at` NULL);
   - no `RETENTION_RESULTS_DONE` marker for the session;
   - not a session of the same candidate.
3. **Worker calls** with no scope and no transaction (ADR 0013: no external call while the lock is held). **Immediately before each call** the processor re-reads the status (one indexed read) and stops on ERASED or a pending erasure fence. Step 1 alone is not enough: an erasure that lands after step 1 would otherwise still send keystrokes, code and event types to the worker. The worker keeps nothing (section 8), and the window is one call long; this residual is accepted.
4. **Write** in `withLiveSession(sid, fn)`. On `ERASED` it writes nothing and drops the results from memory.

`face-match` and `face-recheck` use steps 1, 3 and 4 only. Their step 1 also stops, **before any presign**, when the session has a `RETENTION_FACE_DONE` marker or the face images are already nulled (owner decisions C-27, C-35): the face tier has run, so no face image may be read again.

**What another session contributes.** A CODE_SIMILARITY finding carries `matchedSessionId` only. It never carries the other session's code, now or later: if `excerpt`, `matchedLines` or `details` are added to the payload (ADR 0010 amendment, section 10), they describe the analysed session's own code only.

### 3.5 Q-22: the SUBMITTED flow and GRADED (D5)

| Option | Effect |
| --- | --- |
| (a) GRADED only after grading **and** analysis (fsd.md §3 literally) | ADR 0013's grading idempotency (the SUBMITTED → GRADED compare-and-set) needs another guard, and GRADED waits for the ingest grace |
| **(b) GRADED = automated grading done; analysis then lets `route-session` move GRADED → UNDER_REVIEW (chosen)** | Keeps ADR 0013 5.11 unchanged. C-28 means routing no longer depends on the band, so no reviewer ever sees a session before its analysis has finished or been abandoned |
| (c) Analysis before grading | Delays grading by the ingest grace for no gain |

The flow SessionStateService creates on SUBMITTED (it extends ADR 0013 5.11):

```text
route-session:{sid}                       parent; runs when both children are done
 |- grade-session:{sid}                   failParentOnFailure: true (ADR 0013 rules unchanged)
 |    |- close-section:{sid}:{id}:final   (ADR 0013)
 |- analyze-session:{sid}                 delay = PROCTOR_INGEST_GRACE_SECONDS + 30 s;
                                          ignoreDependencyOnFailure: true
```

- **Delay.** `analyze-session` starts 30 s after ingest close (ADR 0013 Q2), so the event, keystroke and media sets are final (architect detail).
- **Abandoned analysis.** After its last attempt fails, BullMQ ignores the child and `route-session` still runs. The session reaches UNDER_REVIEW with `risk_band` NULL, which means "analysis unavailable": full review path, ranked first in the queue (architect detail).
- **`route-session`** checks that the status is GRADED, then makes the GRADED → UNDER_REVIEW compare-and-set. It **never** moves a session to COMPLETED (owner decision C-28).
- **Reconciler (ADR 0013 5.11), new cases.** A GRADED session older than 30 minutes with no active `route-session` **and no `analyze-session` that is waiting, delayed (including a `WORKER_BUSY` re-delay) or active** gets `route-session` again. So a reconciler-made route never runs while analysis is still writing its chunks (5.2). An UNDER_REVIEW session with `risk_band` NULL, no verdict and analysis not running gets `analyze-session` again, at most once per hour for 24 hours. A late result then appears in the review bundle.
- **Fallback if nested flows misbehave (BullMQ spike, below):** `analyze-session` re-delays itself until the status is GRADED, then routes, and its failed-job handler enqueues `route-session`.
- **Docs to change (on acceptance):** fsd.md §3 GRADED becomes "Automated grading done; integrity analysis may still be running". The ADR 0002 rows become SUBMITTED → GRADED "grading done" and GRADED → UNDER_REVIEW "analysis finished or abandoned (always, C-28)"; the GRADED → COMPLETED row is removed (C-28).
- **Spike (BE-11; not verified on the version in use):** nested flows with `ignoreDependencyOnFailure` together with `failParentOnFailure`. The option exists (BullMQ docs, read 2026-10-05).

## 4. Worker authentication and network isolation (D2)

### 4.1 Options (Q-21)

| Option | Replay | Body integrity | Rotation | Operations | Verdict |
| --- | --- | --- | --- | --- | --- |
| Static shared secret header (today's `X-Internal-Token`) | Replayable forever once seen | None | Coordinated restart | Trivial | Rejected: a captured header is a permanent credential |
| **HMAC-signed requests and responses, per-environment keys with key ids (chosen)** | Bounded by a 60 s window plus a nonce cache | Body hash signed, both directions | Two key ids accepted, no downtime | Two env vars per side | **Chosen for local, staging and pilot** |
| mTLS on the private network | Channel-level | Channel-level | Needs a CA, issuance and renewal | Certificate tooling on one VM | Recommended **in addition** once API and worker run on separate hosts (owner question 2) |
| Short-lived JWT issued by the API (asymmetric) | `exp` and `jti` | Not bound to the body unless a hash claim is added | Key pair rotation | JWT libraries on both sides | Rejected: more moving parts than HMAC. Its one advantage (the worker could not mint tokens) does not matter, because nothing accepts tokens from the worker |

### 4.2 Signing scheme (architect detail)

| Item | Rule |
| --- | --- |
| Request headers | `X-CP-Key-Id`, `X-CP-Timestamp` (Unix seconds), `X-CP-Nonce` (16 random bytes, base64url), `X-CP-Signature` |
| Request string to sign | `"CP-WORKER-V1\n" + kid + "\n" + METHOD + "\n" + path + "\n" + timestamp + "\n" + nonce + "\n" + hex(SHA-256(raw body))`. The key id is inside the signed string. Any request with a query string is refused (400), so the path is the whole target |
| Signature | base64url(HMAC-SHA256(key, string)), compared in constant time |
| Worker checks, in order | 1. Body size against the route limit (before reading it all). 2. Known key id. 3. \|now − timestamp\| ≤ 60 s. 4. Nonce **looked up** in this process's cache: seen means refuse. 5. Signature over the **raw** bytes. 6. Only after the signature verifies, the nonce is **recorded**, so unauthenticated traffic cannot fill the cache. 7. Then parse. Any failure in 2 to 5: 401 `WORKER_AUTH_FAILED` with no detail, **unsigned** (the worker cannot know the caller holds the key) |
| Nonce cache | Entries live 120 s (twice the window). It is sized for the peak signed-request rate × 120 s with a 4× margin (about 20,000 entries at the 6.6 rates). Entries are **never evicted early**: when it is full, the worker answers 503 `WORKER_BUSY` (fail closed) and raises an alert |
| Response | The worker signs every response it sends after step 5, with the **same kid** the request used, and echoes it in `X-CP-Key-Id`. The string is `"CP-WORKER-V1-RESP\n" + kid + "\n" + request nonce + "\n" + status + "\n" + hex(SHA-256(body))`, carried in `X-CP-Signature`. This stops a host on the private network from forging a MATCH |
| API handling | A signed response with a bad signature or the wrong kid is a retryable failure plus an alert (possible tampering). An **unsigned 401** is **not retryable** (`UnrecoverableError`) and raises an alert, because it means a key or clock misconfiguration that retries cannot fix (6.4) |
| Replay across processes | Each process has its own nonce cache, so a replay inside the 60 s window to another process is possible. It is harmless: every route is a pure computation or an idempotent cache operation, and a replayed response is useless without the API's open request |
| Clock | Server clocks are NTP-synced. ADR 0013 already alarms on skew above 1 s between API and worker hosts |
| Routes covered | Every route except `GET /health`. `/docs`, `/redoc` and `/openapi.json` are disabled outside local development |

### 4.3 Key lifecycle (architect detail. D-38 covers database credentials only; this ADR applies the same placement to the HMAC keys)

| Item | Rule |
| --- | --- |
| Key | 32 random bytes per environment (local, staging, pilot, production), never shared between environments |
| Variables | API: `WORKER_BASE_URL`, `WORKER_HMAC_KEY_ID`, `WORKER_HMAC_KEY`. Worker: `WORKER_HMAC_KEYS` = `kid:base64,kid:base64` (at most 2; keys under 32 bytes are refused at startup). `WORKER_INTERNAL_TOKEN` is removed |
| Where keys live | Staging, pilot and production: GitHub Environment secrets and the servers only, never on developer machines or in agent sessions (the D-38 / ADR 0009 rule for database credentials, extended here to these keys). Local: a key each developer generates into `.env` (synthetic data only) |
| Rotation | Every 90 days, on suspected exposure, and when someone with server access leaves. Steps: add the new kid to the worker's list and deploy the worker; switch the API's signing kid and deploy the API; after 24 hours remove the old kid. The DEP-01 runbook has the steps |
| Scope | The key authenticates API → worker only. The API exposes no route that accepts it |
| Never logged | Keys, signatures and the four headers are on the redaction lists of both apps (ADR 0001 C-5), and a test asserts it |
| No worker key | The worker refuses to serve signed routes (503) rather than run open, as today |

### 4.4 Network isolation (architect detail; DEP-01 and DEP-03 build it; ARC-05 confirms; not verified)

| Rule | How |
| --- | --- |
| Private only | Compose network `worker-internal` with `internal: true`. Only `api` and `worker` join it. The worker publishes no port and is never behind Caddy |
| Encryption in transit | Plain HTTP is allowed **only** while API and worker share one host on that `internal: true` network, where traffic never leaves the host. **Before any API-to-worker traffic crosses a host or VPC boundary, TLS is required** (mTLS recommended; server TLS plus the HMAC scheme is the minimum). The request bodies carry candidate code, keystrokes and presigned URLs. This is a DEP-02 go-live check. Whether it is mTLS or server TLS stays owner question 2 |
| No inbound internet | Follows from the above. Security groups allow nothing inbound to the worker |
| Egress to the object store only | The worker also joins an `egress` network. Pilot and production: a host firewall rule (DOCKER-USER chain) allows only the S3 endpoint (VPC gateway endpoint ranges) and DNS. Staging (R2, synthetic data only): best effort |
| No other credentials | The worker environment holds no `DATABASE_URL`, Redis URL, S3 keys, email or webhook secrets. A config test fails if any appear |
| Hardened container | Non-root user, read-only root filesystem, small `tmpfs` for `/tmp`, no Linux capabilities, CPU and memory limits, core dumps off (memory can hold images and embeddings) |
| Models at build time | Model files are baked into the image (section 7), so there is no runtime egress to Hugging Face or any CDN |

### 4.5 Outbound fetch guard (SSRF; architect detail)

URLs reach the worker inside signed bodies, but the worker still treats them as untrusted. A bug or a compromised API host must not turn the worker into a proxy.

| Rule | Detail |
| --- | --- |
| Allow-list | The worker fetches only `https` URLs (plain `http` only when `WORKER_ENV=local`, for a local S3-compatible store) whose scheme, host and port exactly match `WORKER_OBJECT_STORE_ORIGINS` (the S3 or R2 API endpoint of that environment, ST-7). The URL must name the configured bucket: in the host for virtual-hosted style, or as the first path segment for path style (ST-1). Anything else gives 400 `VALIDATION_FAILED` and an alert |
| No redirects | Redirects are not followed. A 3xx counts as `MEDIA_UNAVAILABLE` |
| Expiry | The worker reads `X-Amz-Date` and `X-Amz-Expires` and refuses a URL that has expired or whose lifetime is longer than the route allows (face 60 s, analysis 300 s) |
| Resolution | Names are resolved with the normal resolver; the egress firewall (4.4) is the network-level backstop against internal targets |
| Lifetime | Face calls get **60 s** URLs, because the call takes under 20 s. Analysis calls get **300 s**, because a VAD window downloads up to 91 objects |

## 5. Media access and writes (D3, D4)

### 5.1 How the worker reads media

| Option | For | Against |
| --- | --- | --- |
| **Presigned GET per object, issued by the API for one call (chosen)** | Least privilege: the worker can read only what this call needs, for 60 s (face) or 5 minutes (analysis). No S3 credentials in the worker. After erasure or retention the object is gone, so the GET fails (`MEDIA_UNAVAILABLE`) | URLs are bearer secrets inside the request body (never logged, C-5). Presigning is local computation, so it costs no S3 call |
| Read-only S3 credentials (an IAM role scoped by prefix) | The worker can list and read by itself | Every org and session readable at any time; `sealed/` readable; more IAM on R2 and S3 (ST-1); a second access path to secure |
| The API streams bytes in the request | No storage access from the worker | Breaks "heavy media never passes through the API" (architecture.md) |

Rules (architect detail):
- `StorageService.presignGetForWorker(key, ttl)` (BE-09): a GET of 60 s (face) or 300 s (analysis) with the ADR 0013 response-type and disposition overrides. It refuses any key outside `orgs/{ctx.orgId}/sessions/{ctx.sessionId}/` of the job's own scope (CS-3).
- **Sealed objects: conditional on owner question 3.** Every face call reads a sealed object: the sealed ID image and selfie (ADR 0013 5.7 table, line 302: "never presigned") and the sealed re-check frame (line 304: "never presigned for PUT"). ADR 0013 5.6 (line 271) says "No presigned URL is ever issued under `sealed/`". The review workspace must also show sealed ID images and selfies (ADR 0004 §1), so the intent appears to be uploads, but the text says otherwise.
  - **If the owner answers question 3 with (a), recommended:** ADR 0013 lines 271 and 302 are amended to "no presigned **PUT** under `sealed/`; presigned GET only to staff review (15 minutes) and to the worker (60 s)". The worker and `presignGetForWorker` then read `sealed/` as described here.
  - **If (b):** the worker gets read-only S3 credentials limited to `orgs/*/sessions/*/identity/*/sealed/*` and `orgs/*/sessions/*/evidence/sealed/*`, takes keys instead of URLs on the face routes only, and the 4.5 guard checks key prefixes instead of URLs. Analysis stays on presigned GETs.
  - Until the answer, BE-08 builds against an interface that hides which of the two is used.
- The worker streams each download and stops at the route's byte cap. It never writes objects.

### 5.2 How results are written

- **No direct database writes by the worker: confirmed.** It has no credentials (4.4).
- **Actor and scope.** API processors write as SERVICE through `SessionJobProcessor.withLiveSession` (`runAsSessionJob` and `guardLive`, ADR 0013 as revised in PR #68). The worker call happens before the transaction. Transactions stay short: at most 500 rows each, and each one starts with `guardLive` again (ADR 0004 9.5).
- **Chunk order (architect detail).**
  1. **First transaction:** in replace mode (below), delete the earlier analysis rows, then insert the first chunk of findings.
  2. **Middle transactions:** insert the next chunks.
  3. **Final transaction:** insert the last chunk, run the event-id check (below), and write `risk_score`, `risk_band` and `device_info.analysis`. Risk and the analysis status therefore appear only once every finding is in, and they appear together.

  If the job dies between chunks, its retry starts over. In replace mode the first transaction deletes the partial rows; in insert-only mode the duplicate check skips them. `route-session` cannot run between chunks: as a flow parent it waits for the child, and the reconciler skips sessions whose analysis is waiting, delayed or active (3.5).
- **The worker's ids are never write targets.** Rows go to `ctx.sessionId` only. A returned `sessionQuestionId` must be one the API sent for this session, and a `matchedSessionId` must be in the corpus the API sent. Anything else is dropped and counted. Session keys stay immutable (CS-4.2).
- **SERVER events** get `source = SERVER`, `batch_seq` NULL, server-assigned severity (ADR 0005 §2 plus org overrides), occurred-at clamped to `[started_at, submitted_at + grace]`, and payloads parsed with `parseEventPayload` (ADR 0010). Fields outside the v0 payloads (`matchedLines`, `details`, `excerpt`) are dropped until ADR 0010 is amended (integrity follow-up 4).
- **Re-runs are idempotent (architect detail).** While the session is SUBMITTED or GRADED, nobody has decided a flag yet, so a run **replaces** the session's SERVER rows of the seven analysis types (PASTE_BURST, TYPING_ANOMALY, IDLE_THEN_COMPLETE, CODE_SIMILARITY, AI_LIKENESS, and SERVER-source SPEECH_DETECTED and MULTIPLE_VOICES). From UNDER_REVIEW on, a run only **inserts** findings that are not already present (same type, source, `occurred_at`, `duration_ms` and payload), and never deletes.
- **Risk is consistent with the events it scored.** Before calling `/v1/risk`, the processor reads the newest `proctor_events.id` of the session among rows **not** written by this analysis (it excludes the SERVER rows of the seven analysis types). The final transaction reads the same value again. If it changed (for example, a last FACE_MISMATCH arrived), that transaction aborts and the job retries.
- **Score and band.** The worker returns an integer score and the band computed from that integer, so `risk_score` and `risk_band` always agree (BE-12 changes `risk.py`).

### 5.3 ERASED, waivers and in-flight work

| Case | Behaviour |
| --- | --- |
| Erasure fence while a call is in flight | The worker finishes (it has no cancel route). `withLiveSession` returns `ERASED` and nothing is written. `face-recheck` also deletes its sealed frame. Erasure itself calls `/v1/face/evict` |
| Erasure before the call | Step 1 stops the job. If it slips through, the presigned GET fails because erasure deleted the prefix |
| Waiver or "face detectors off" set or turned on mid-test | `face-recheck` re-reads the accommodations projection and the identity row at step 1. With either set, it calls no worker, deletes the frame and logs outcome `SKIPPED` (owner decision C-34). `face-match` refuses a waived session (ADR 0015) |
| "Face detectors off" with the identity check required | The initial match runs (ADR 0015 table) with `cacheSelfie: false`, so nothing is kept for re-checks (C-34) |
| Worker restart | Nothing is lost by default, because nothing is cached (6.3). If the owner allows the cache, the next re-check primes it again from the sealed selfie (ADR 0004 §2) |
| Face images already deleted (`RETENTION_FACE_DONE`, C-27, C-35) | Step 1 stops `face-match` and `face-recheck` before any presign (3.4); `face-recheck` deletes its frame |

## 6. Contracts (D6)

### 6.1 Common rules

- Base URL `WORKER_BASE_URL`: plain HTTP only on the single-host `worker-internal` network, TLS required across hosts (4.4). JSON in camelCase. The worker rejects unknown request fields.
- **Response validation in the API is tolerant of additions:** unknown response fields are **stripped, not rejected**, so a newer worker can be deployed before an older API. Missing required fields, wrong enums, out-of-range numbers and oversized arrays are rejected (retryable failure plus an alert). Removing or renaming a field needs a new `/v2` route.
- Errors are `application/problem+json` with `code`. **A 400 never echoes input:** FastAPI's default validation handler is replaced by one that returns field paths and fixed codes only.
- `X-Request-Id` is a random ULID per call (3.3), never the jobId. Both sides log it.
- Presigned URLs are issued right before each call, so a `WORKER_BUSY` re-delay never sends an expired 60 s URL.
- Every 200 response carries `workerVersion` and `lockDigest` (the first 12 hex characters of the SHA-256 of `models.lock.json`), so results can be traced.
- `config` is the org's `settings.integrity` and `settings.risk`, mapped into `IntegrityConfig` by the API. `disabledEventTypes` comes from the accommodations (FR-305; integrity follow-up 2). Face settings are system configuration from `FACE_*` env and are never sent (ADR 0004 §2; PR #59).
- The worker's OpenAPI document is committed as `apps/worker/openapi.json` with a CI drift check. The API generates its client types from it and still validates every response at runtime (enums, bounds, array caps).

### 6.2 Routes

| Route | Request body | 200 response | Limits and timeout (API side) |
| --- | --- | --- | --- |
| `GET /health` (unsigned) | none | `{ status: "ok" }` | For Docker and uptime checks only; no versions |
| `GET /v1/ready` | none | `{ ready, workerVersion, lockDigest, models: [{ component, modelId }] }`, or 503 `MODEL_UNAVAILABLE` | The API checks it at startup and every 60 s |
| `POST /v1/face/match` (FR-403, TC-033) | `{ sessionId, attempt: 1..2, idImageUrl, selfieUrl, livenessConfirmed: boolean, cacheSelfie: boolean (default and pilot value **false**, 6.3), cacheExpiresAt?: ISO (required only when `cacheSelfie` is true) }` | `{ decision: MATCH \| MANUAL_REVIEW, reason: identity_review_reason \| null, detail: code \| null, score: number \| null, modelId, threshold }` | Body 16 KiB. Each image ≤ 5 MiB, JPEG, ≤ 25 MP. Timeout 20 s |
| `POST /v1/face/recheck` (FR-606, C-08) | `{ sessionId, frameUrl, selfieUrl, cacheSelfie: boolean (default **false**), cacheExpiresAt?: ISO }` | `{ outcome: MATCH \| BELOW_THRESHOLD \| NO_FACE \| MULTIPLE_FACES \| ERROR, score \| null, modelId, threshold, cache: HIT \| MISS \| OFF }` | Body 16 KiB. Frame ≤ 1 MiB, JPEG, ≤ 1920 × 1920 read from the JPEG header before decoding (ADR 0013 5.6). With `cacheSelfie: false` the worker fetches the selfie, computes **both** embeddings, compares them and discards both: it never reads or fills the cache (`cache: OFF`). With `true`, `selfieUrl` is fetched only on a miss. Timeout 15 s |
| `POST /v1/face/evict` | `{ sessionId }` | 204, always (idempotent) | Timeout 2 s, best effort |
| `POST /v1/analyze/keystrokes` (FR-802, TC-073) | `{ sessionQuestionId, batches: KeystrokeBatch[1..5000] (ADR 0010 shape), config }` | `{ sessionQuestionId, findings: Finding[], finalTextLength }` | Body 16 MiB. One call per session question. Timeout 30 s |
| `POST /v1/analyze/similarity` (FR-803, TC-074) | `{ target: { sessionId, sessionQuestionId, language, code }, corpus: [{ sessionId, language, code }] (≤ 500), aiReferences: [{ id, language, code, isVariantMatch }] (≤ 100), starterCode: { [language]: code }, config }` | `{ findings: Finding[] }` for the **target only**; each cites `matchedSessionId` (from the corpus) or `aiReferenceSolutionId`, never both | Body 16 MiB. The API trims the corpus by recency to fit. Target-versus-corpus is O(n), replacing today's all-pairs. Timeout 60 s |
| `POST /v1/analyze/vad` (FR-607, TC-061) | `{ sessionId, segment, windowStartMs (epoch ms), header: { seq, url }, chunks: [{ seq, url, offsetMs }] (≤ 90, in seq order), config }` | `{ findings: Finding[] (SPEECH_DETECTED, MULTIPLE_VOICES), decodedMs, missingSeqs: int[] }` | Body 2 MiB. One window is at most 15 minutes of one AUDIO segment, plus that segment's header chunk (ADR 0004 §4). A missing chunk is skipped (ADR 0013 5.5). Timeout 120 s |
| `POST /v1/risk` (FR-804, FR-805, TC-075, TC-076) | `{ events: [{ type, source, durationMs? }] (≤ 100,000), identityReviewPending, shortAnswerPending, config }` | `{ score: int 0..100, band, reviewPath: fast \| full, queueRank, reasons: string[] }` | Body 8 MiB. Timeout 10 s. The API stores only `score` and `band`; BE-13 derives the path and rank when reading (C-28) |

`Finding` = `{ type, occurredAtMs (epoch ms), durationMs, confidence 0..1, payload, excerpt?, details? }`, as `events.py` on main. Keystroke times come from the client clock (`startedAt` + `t`), and VAD times from `windowStartMs`, which comes from client-reported `media_chunks.started_at`. Both are clamped by the API, and the review UI labels them as client-timed.

**Mapping a face result to `identity_checks` (ADR 0004 §1; D-05, never a rejection):** MATCH gives PASSED. MANUAL_REVIEW on attempt 1 with BELOW_THRESHOLD, NO_FACE, MULTIPLE_FACES or LIVENESS_NOT_CONFIRMED gives LOW_CONFIDENCE (the candidate retries once). On attempt 2 it gives MANUAL_REVIEW. MATCH_ERROR (including a worker timeout or an exhausted job) gives MANUAL_REVIEW at once. The re-check outcome maps PR #59's result as: decision MATCH gives MATCH; the reasons BELOW_THRESHOLD, NO_FACE and MULTIPLE_FACES map to themselves; anything else gives ERROR.

### 6.3 Selfie embeddings and the optional cache (ADR 0004 §2, 9.1; owner decision C-18)

**Default (in force now): no cache.** C-18 says embeddings "are computed in memory for each comparison and discarded", and that periodic re-checks "recompute from the stored selfie". Whether a per-session cache is allowed is ADR 0004 owner question 1, which is still open. So until the owner answers it:
- The API sends `cacheSelfie: false` on every `/v1/face/match` and `/v1/face/recheck` call.
- The worker builds each embedding for one comparison and drops it before responding. Nothing is kept between calls. PR #59's `SelfieCache` stays unused, and `prime_selfie` is never called.
- **Cost:** two embeddings per re-check (frame and selfie), and the selfie is downloaded each time. About 1.7 re-checks per second at 200 candidates (6.6) means about 3.4 AuraFace inferences per second. The BE-08 benchmark must measure exactly this load.
- `/v1/face/evict` is still built and called; with no cache it does nothing.

**Only if the owner allows the cache (ADR 0004 question 1 answered yes); architect detail:**
- The cache lives in process memory only, as an LRU of at most `FACE_SELFIE_CACHE_MAX_SESSIONS` entries. It is filled only when `cacheSelfie` is true.
- Each entry expires at the `cacheExpiresAt` the API sends: `min(effectiveDeadline(session) + grace, now + 4 h)`. That is the TTL backstop of ADR 0004 9.1. `/v1/face/evict` is the fast path. Because the TTL bounds the cache even if an evict reaches another process, eviction stays correct with several processes.
- The pilot then runs one worker process per container, with parallelism from onnxruntime threads and a bounded thread pool, so the cache and evict are coherent. Scaling out needs session-affine routing.
- Turning the cache on is a configuration change in the API (`FACE_SELFIE_CACHE_ENABLED`), made only after the owner's answer is recorded. It changes what is held in memory, so it is not "nothing else changes": the consent text, the DPIA and retention-schedule.md must describe the in-memory per-session cache before it is enabled.

### 6.4 Error codes

| Status and `code` | Meaning | API handling |
| --- | --- | --- |
| 400 `VALIDATION_FAILED` | Body failed the schema (no input echoed) | Not retryable (`UnrecoverableError`); alert, because it is an API bug |
| 401 `WORKER_AUTH_FAILED` (unsigned) | Signature, key id, timestamp or nonce | Not retryable (`UnrecoverableError`); alert (key or clock configuration). This is the only unsigned response the API accepts as genuine; any other unsigned or wrongly signed response is a retryable failure plus an alert (4.2) |
| 503 `WORKER_BUSY` (nonce cache full) | The nonce cache is full (4.2) | As `WORKER_BUSY` below, plus an alert |
| 413 `PAYLOAD_TOO_LARGE` | Over the route cap | Not retryable; the API should have trimmed |
| 422 `MEDIA_UNAVAILABLE` | A presigned GET returned 403 or 404 (erased, retained or swept) | That piece is skipped and recorded in `device_info.analysis` |
| 422 `MEDIA_INVALID` | Over the byte cap, wrong type or not decodable | As above |
| 503 `WORKER_BUSY` with `Retry-After` | The route's concurrency semaphore is full | Re-delay without using an attempt (`moveToDelayed` plus `DelayedError`; ADR 0013 spike) |
| 503 `MODEL_UNAVAILABLE` | A model failed its hash check or did not load | Retryable; alert. Face routes instead return 200 MANUAL_REVIEW / MATCH_ERROR (PR #59), so a candidate is never blocked |
| 500 `INTERNAL` | Anything else, with a fixed code | Retryable with backoff |

Face routes never answer `MEDIA_*`: an unreadable image becomes MANUAL_REVIEW with MATCH_ERROR (D-05).

### 6.5 Retries and attempts (architect detail)

| Job | Attempts and backoff | After the last attempt |
| --- | --- | --- |
| `face-match` | 2; fixed 2 s | MATCH_ERROR gives MANUAL_REVIEW; the candidate continues (ADR 0004 §1) |
| `face-recheck` | 3; exponential from 5 s. A job that has waited more than 5 minutes is dropped (re-checks can be shed) | Delete the sealed frame (ADR 0013); the reviewer sees a missing re-check (ADR 0013 Q6) |
| `analyze-session` | 4; exponential from 60 s (about 7 minutes in total, not counting `WORKER_BUSY` delays) | Ignored by the flow; `route-session` runs; risk "unavailable"; the reconciler retries hourly for 24 hours |
| `route-session` | 5; exponential from 10 s | The reconciler re-adds it |

### 6.6 Back-pressure and capacity (NFR-02: 200 concurrent candidates)

| Load at 200 candidates | Rate | Control |
| --- | --- | --- |
| Re-checks (one frame every 120 s, C-08; route limit 1 per 60 s) | About 1.7 per second, sustained | `face` queue, re-check priority 10 |
| Initial face matches (test starts bunched) | About 200 in 10 minutes | Same queue, priority 1 (ADR 0001 C-7) |
| Analysis (common end time) | 200 sessions | `analyze` queue. **Target: every session analysed within 30 minutes of the last submission** (architect detail; owner question 4) |

- API BullMQ concurrency: `face` 4, `analyze` 2 (architect detail; tune in BE-15B).
- Worker semaphores: face 4, analysis 2. Calls beyond them get `WORKER_BUSY` straight away; the worker never queues internally.
- Budget: reserve 2 vCPU and 3 GiB of memory for the worker on the pilot host. A VAD window peaks at about 60 MB of float32 samples.
- **Not verified:** AuraFace and Silero CPU times on the ARC-05 instance type. BE-08 and BE-12 benchmark them before DEP-03. BE-08 benchmarks the **no-cache default**: two detections and two embeddings per re-check (about 3.4 embeddings per second at 200 candidates) on top of the initial matches.

### 6.7 `device_info.analysis` (architect detail; needs the ADR 0010 `deviceInfoSchema` amendment that ADR 0013 already requests)

`{ status: COMPLETE | PARTIAL | UNAVAILABLE, pieces: { keystrokes, similarity, vad, risk: OK | SKIPPED_DISABLED | MEDIA_UNAVAILABLE | FAILED }, workerVersion, lockDigest, modelIds, completedAt }`. It holds counts and codes only, never keys or URLs. It is written by DeviceInfoService in the same `withLiveSession` transaction, and erasure clears it (R-6).

## 7. Model pinning and licence (D7)

`apps/worker/models.lock.json` uses the ADR 0013 §6 format. ADR 0013 control 1 already puts it under CODEOWNERS.

| `name` | Component | SHA-256 and bytes | Licence | `status` |
| --- | --- | --- | --- | --- |
| `auraface-v1/glintr100.onnx` | FACE_EMBED | `a7933ea5…5c60`, 260,694,151 (ADR 0001 §12.2) | Apache 2.0; training-data provenance not verifiable (F-2) | `unverified`, flag F-2. It passes the pilot and production gate **only** through its `D-28` line in the `licence-acceptances` block (owner decision C-10 / D-28) |
| `mediapipe/face_landmarker.task` | FACE_LANDMARK | `64184e22…c9ff`, 3,758,596 | Apache 2.0 (F-4: awareness only) | `approved` |
| `silero-vad/silero_vad.onnx` (v6.2.3) | VAD | `1a153a22…88e3`, 2,327,524 | MIT; `licenceFile` LICENSE kept (F-5) | `approved` |
| `scrfd_10g_bnkps.onnx`, `2d106det.onnx`, `1k3d68.onnx`, `genderage.onnx` | none | Recorded by `models:update` from the pinned AuraFace revision | InsightFace, non-commercial | **`blocked`** (F-1, D-16) |

- **Sources** name an immutable revision (a Hugging Face commit or a release tag), never `main` or "latest". Developer downloads of AuraFace follow owner decision C-22. The pilot image is built in CI under C-10.
- **Build.** A worker `models:fetch` (under `apps/worker/scripts/models/**`) downloads only the `approved` and `unverified` entries, verifies them and bakes them into `/models` (read-only). The licence gate (ADR 0013 §6) also reads this lock.
- **Image test (F-1).** CI fails if the image holds any `*.onnx`, `*.tflite` or `*.task` file not in the lock, or any file whose hash matches a `blocked` entry, so a renamed copy is caught too.
- **Startup check.** The worker hashes every file under `/models` against the lock (PR #59 already reads each file once and hashes the same bytes it loads). It refuses to start on an unlisted or blocked file. If an approved file is missing, `/v1/ready` reports not ready and an alert fires.
- **Python packages.** Exact pins with hashes (a `pip-compile --generate-hashes` or `uv` lock), covered by CODEOWNERS like `pyproject.toml`.
- **Audio decoding (not verified; owner question 6).** Decoding WebM/Opus needs FFmpeg (for example PyAV). Standard PyAV wheels reportedly bundle GPL components (x264, x265); an LGPL-only build or a Debian FFmpeg are the alternatives. Secondary sources only. BE-12 adds a row to ADR 0001 §12 before merging.

## 8. Failure modes, observability and data protection

| Failure | Behaviour | Alert (CloudWatch, owner decision C-32) |
| --- | --- | --- |
| Worker down | `face-match`: MANUAL_REVIEW, the candidate continues. Re-checks shed; the reviewer sees the gap. Analysis retries, then routes with risk "unavailable" | `/health` failing for 2 minutes; `/v1/ready` false |
| Model hash mismatch | Worker not ready; face routes answer MANUAL_REVIEW / MATCH_ERROR | Startup failure alarm |
| Poison job (ids missing, or session not in org) | Dropped by `SessionJobProcessor` (ADR 0006 job rules), counted | Count above 0 in 5 minutes |
| Worker 400 or 401 | Not retryable; job fails | Any occurrence |
| Slow worker | Semaphores and `WORKER_BUSY`; the queue absorbs it | `face` queue wait p95 above 30 s; analysis backlog above 30 minutes |
| Redis down | No jobs run; ADR 0013's sweeps and retention are the backstops | Existing Redis alarm |
| Sessions UNDER_REVIEW with risk "unavailable" | Full review path, ranked first | Count above 0 |

**What the worker may log:** the random request ULID, route, status, duration, outcome code, counts, `modelId`, and `sessionId` as the correlation key (ADR 0001 C-9). **What the API logs about a worker call:** that ULID, the job type and attempt number, never the jobId (3.3). **Never, on either side:** bodies, URLs, object keys, evidence names, jobIds that contain them, code or excerpts, keystroke text, images, embeddings, face scores, signatures or keys (ADR 0001 C-5; ADR 0013 line 145). A test feeds sentinel values through every route and job, including an evidence name inside a `face-recheck` jobId and a presigned URL, and scans the captured logs of both apps. The worker writes nothing to disk. Redis payloads carry ids only (3.3).

## 9. Options considered (summary)

| Decision | Chosen | Rejected |
| --- | --- | --- |
| Transport | API processors call a stateless worker over HTTP | Python BullMQ consumer writing the DB; Python consumer posting results back; worker lease endpoint (3.1) |
| Authentication | HMAC-signed requests and responses with rotating key ids, on a private network; TLS required across hosts | Static token; mTLS alone (recommended on top once traffic crosses hosts); API-issued JWT (4.1) |
| Media access | Presigned GET per call | Worker S3 credentials; streaming through the API (5.1) |
| GRADED | Grading done, then routing after analysis | GRADED after both; analysis before grading (3.5) |
| Contract source | Worker OpenAPI, committed, plus runtime validation in the API | Hand-written zod in `packages/shared` (the web app never uses this contract) |

## 10. Amendments this ADR needs (none applied here)

| Document | Change |
| --- | --- |
| ADR 0001 | TB-6 and OI-1 decided; the worker half of OI-8 decided. In the section 3 diagram the worker has no Redis edge, reads object storage by presigned GET, and is called by the API. Component row for apps/worker: "called by the API over signed HTTP; holds no credentials except the HMAC key". F6: routing always to UNDER_REVIEW (C-28) |
| ADR 0002 | SUBMITTED → GRADED "grading done"; GRADED → UNDER_REVIEW "analysis finished or abandoned"; remove GRADED → COMPLETED (C-28) |
| ADR 0013 | CS-4.7 rows for `face-match` and `route-session`. The `guardLive` writer list (line 350 on main; the `withLiveSession` list in PR #68) gains `face-match` and `route-session`, and notes that the `face-recheck` worker call and its outcome handler are now one processor. `analyze-session` is a session job with one `runInOrg` read phase (3.4). 5.6 enqueues the evidence name, not the key. 5.6 "the worker HEADs the frame" becomes the 6.2 streaming cap plus the JPEG header check. **Only if owner question 3 is answered (a):** lines 271 and 302 become "no presigned PUT under `sealed/`" (5.1). 5.11 flow tree and reconciler cases (3.5). "Tells the worker to evict" means `POST /v1/face/evict`. `analyze-session` delay = grace + 30 s. The worker lock (section 7) |
| ADR 0006 §8.5 | FU-DB-67 call sites: the `runInOrg` phase in `AnalyzeSessionProcessor` |
| ADR 0010 | `deviceInfoSchema.analysis` (6.7); optionally `matchedLines` and `details` in the CODE_SIMILARITY, AI_LIKENESS and TYPING_ANOMALY payloads (integrity follow-up 4) |
| fsd.md, architecture.md, backend.md | fsd.md §3 GRADED wording. architecture.md: Components ("Analysis worker" adds face match, called by the API) and the sequence diagram (the API calls the worker; the worker writes nothing). backend.md Step 8 ("a job consumer" becomes "the API `face-match` processor calls `/v1/face/match`") and Step 12 ("write risk_score ... move to UNDER_REVIEW or COMPLETED" becomes the API writes, always UNDER_REVIEW) |
| `.env.example`, deploy templates | Replace `WORKER_INTERNAL_TOKEN` with the variables in 4.3 |

## 11. Agents affected and what they do next

| Agent (task) | Must do |
| --- | --- |
| integrity (BE-08; PR #59 open) | `WorkerClient` in `apps/api` (signing, response verification, runtime validation, timeouts, mapping of `WORKER_BUSY`); `face-match` and `face-recheck` processors (5.3, 6.2 mapping); worker `/v1/face/*` routes on `FaceMatcher.match`, `prime_selfie`, `recheck` and `end_session`; signing middleware; **align PR #59 with 6.2:** per-role caps (ID and selfie ≤ 5 MiB JPEG; frame ≤ 1 MiB JPEG ≤ 1920 × 1920 checked before decoding; PR #59 allows 10 MiB and PNG); `cacheSelfie: false` as the default, with compute-and-discard on both face routes and the cache path built but switched off (6.3); stop on `RETENTION_FACE_DONE` before presigning (3.4); the 4.2 nonce rules and 4.5 fetch guard; a random request ULID, never the jobId (3.3); `models.lock.json`, startup check and image test; the benchmark in 6.6 |
| integrity (BE-12) | `AnalyzeSessionProcessor` (3.4, 5.2), including the corpus filter, the status re-read right before each worker call, and the chunk order; routes moved to `/v1` with camelCase; `/v1/analyze/vad` with windowed decoding (decoder licence row first); similarity as target versus corpus; integer risk score with its band; disabled docs routes; a 400 that never echoes; `device_info.analysis`; remove `X-Internal-Token` |
| backend (BE-11) | The SUBMITTED flow tree with `route-session` (3.5) and the nested-flow spike; `route-session` processor; reconciler cases |
| backend (BE-09) | `presignGetForWorker` (60 s for face, 300 s for analysis, prefix check). `sealed/` GET **only if owner question 3 is answered (a)**; until then the face path stays behind an interface (5.1). `.env` and Compose variables for the worker key and `WORKER_OBJECT_STORE_ORIGINS` |
| backend (BE-07) | Ingest close and erasure call `/v1/face/evict` (best effort, through `WorkerClient`) |
| backend (BE-13) | Risk "unavailable" (NULL band): full path, ranked first; analysis panel; client-timed labels on findings |
| db-engineer (DB-05 follow-up) | Add the FU-DB-67 call-site entries (10, ADR 0006 row) |
| deploy (DEP-01, DEP-03; QA track) | Worker service per 4.4 (internal network, no ports, hardened container, egress rule); per-environment HMAC secrets in GitHub Environments; rotation runbook; worker image build with `models:fetch` and the gate; CloudWatch alarms in section 8 |
| deploy (DEP-02) | Go-live checklist: **TLS (mTLS recommended) on every API-to-worker path that crosses a host or VPC; plain HTTP only on a single-host `internal: true` network**; a rotation rehearsed, egress verified, alarms fired once, image test green, CPU benchmarks recorded |
| qa | TCs (QA assigns ids): tampered body, old timestamp, unknown or removed kid, a query string all give 401 or 400; a replayed nonce gives 401; a request with a bad signature does not use up a nonce slot; a full nonce cache gives 503; a forged or wrong-kid response is rejected; a URL outside the object-store allow-list, a redirect or an expired URL is refused; **an ERASED or erasure-fenced session, and a session with `RETENTION_RESULTS_DONE`, never appear in a similarity corpus, and a CODE_SIMILARITY payload never holds another session's code**; `face-match` and `face-recheck` stop on `RETENTION_FACE_DONE` with no presign; with `cacheSelfie: false` nothing is kept between calls; worker down gives MANUAL_REVIEW (TC-033) and analysis "unavailable" then UNDER_REVIEW (TC-076 with C-28); ERASED during analysis writes nothing; FACE off mid-test skips the re-check and deletes the frame; a `matchedSessionId` outside the corpus is dropped; log scan finds no sentinel; the image has no extra ONNX files; the worker environment has no database, Redis or S3 variables |
| frontend (FE-09, FE-11) | FE-09: identity status polling copes with a 20 s or longer match. FE-11: analysis panel and the "analysis unavailable" state |
| hub, on acceptance | Section 10; mark ADR 0001 OI-1 and OI-8 decided |

## 12. Owner questions

1. **Q-22 (D5).** GRADED means "automated grading done", and routing to UNDER_REVIEW waits for analysis to finish or be abandoned. This changes the fsd.md §3 wording. Accept (recommended), or keep GRADED waiting for both?
2. **Authentication and transport security (D2).** HMAC-signed requests and responses for the pilot, with rotation every 90 days. TLS is required once traffic crosses a host or VPC (decided here as a go-live check); is that **mTLS** (recommended) or server TLS plus the HMAC scheme?
3. **`sealed/` reads (5.1).** (a) Amend ADR 0013 lines 271 and 302 to "no presigned PUT under `sealed/`", so the worker and the review UI read sealed images through short presigned GETs (recommended); or (b) give the worker read-only S3 credentials limited to the `sealed/` prefixes?
4. **Analysis service level.** Every session analysed within 30 minutes of the last submission at 200 candidates; after about 7 minutes of failed attempts, a session is routed with risk "unavailable" (full review, first in the queue) and analysis is retried hourly for 24 hours. Accept?
5. **Similarity scope.** Compare within the same org only; exclude the same candidate's other sessions; put findings only on the session being analysed (an earlier session is not flagged afterwards). Accept?
6. **Audio decoder licence.** PyAV standard wheels may bundle GPL codecs (not verified). Prefer an LGPL-only build or a distribution FFmpeg, verified by BE-12 before merge?
7. **Selfie cache (this is ADR 0004 owner question 1).** Does C-18 allow a per-session, in-memory selfie embedding cache with a TTL? **Until you answer, the cache is off**: every re-check computes and discards two embeddings (6.3). If you allow it, the consent text, the DPIA and the retention schedule must describe it before it is turned on.
8. **Shedding re-checks.** Drop a re-check job that has waited more than 5 minutes (the reviewer sees the gap) rather than let it pile up?
9. **Egress control on one VM.** Accept a host firewall rule as the pilot control (best effort on staging, which holds synthetic data only), or add an egress proxy (a new service, needing its own ADR)?

### Verification status (2026-10-05)

| Item | Status |
| --- | --- |
| Worker routes, `X-Internal-Token`, limits and `Finding` shape on main; no BullMQ and no worker service in `apps/api` or Compose today | Verified (code read) |
| PR #59 `FaceMatcher` API, 10 MiB and PNG limits, LRU cache, no route | Verified (branch read) |
| `withLiveSession` and `withAnySession` (PR #68); ADR 0006 §8 scope rules (PR #41) | Verified (branches read) |
| BullMQ `ignoreDependencyOnFailure` exists | Verified (docs.bullmq.io, 2026-10-05). Its behaviour in nested flows on the version in use is **not verified** (spike) |
| PyAV wheel licensing | **Not verified** (secondary sources) |
| CPU times for AuraFace and Silero; WebM window decoding with the header chunk; per-container egress filtering; CloudWatch alarm mechanics | **Not verified** (BE-08, BE-12, DEP-01, DEP-03) |
