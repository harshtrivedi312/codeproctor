# @codeproctor/proctor-sdk

Framework-agnostic browser SDK for CodeProctor (signed event and keystroke batches, heartbeat, recording, detectors). Wire contracts: ADR 0013.

## OTP resume / key rotation

Contract between the app and the SDK (hub ruling, ADR 0013 sections 2 and 5.2). Frontend owns the app side.

1. Before the app starts an OTP resume it calls `session.stop()`. The queues stay persisted in IndexedDB, nothing is purged, the heartbeat stops.
2. After the OTP the app starts a NEW `ProctorSession` with the new token and the NEW key (`hmacKeyBase64`); `session.setKey(newKeyBase64)` is then a no-op safety step, and it is the way to hand over a key that arrives later (it also clears a `signing-key` hold). The SDK signs both outboxes again from the stored bodies (same bodies, same seqs, new signatures); the server accepts a re-signed retry as a duplicate. `setKey` also lifts a 401 hold. `session.resume()` lifts the hold after a plain token refresh.
3. After `stop()` the SDK accepts no new evidence until a new session starts. Whatever the page produces during the OTP (typing, focus, paste) is lost by design; the heartbeat gap shows the resume window.
4. `SESSION_TAKEN_OVER` is terminal whenever the SDK did not get a prior `stop()`: both outboxes are purged, the session ends (`ended` event), `onReauthRequired('SESSION_TAKEN_OVER')` runs once. There is no time-window heuristic. A different device never resumes anything: its key and epoch are dead.
5. If the app forgot `stop()` and an old-token batch got the 401, nothing is recoverable on the SDK side. The unsent batches are purged and counted: `getQueueStats().lostBatches` and `getKeystrokeStats().lostBatches` (there is no `dropped` stat; `lostBatches` is the counter), the `ended` event payload `lostBatches` and the `batches-lost` capability flag.
6. A heartbeat `SESSION_NOT_ACTIVE` only stops the heartbeat and fires `ended`; the queues keep sending during the post-submit grace. A batch-route `SESSION_NOT_ACTIVE` (after the grace) purges.
7. After 3 consecutive 401 the queues stop (batches stay persisted) and `onReauthRequired` runs once; refresh the token and call `session.resume()`.

## Signing key and counters (proctor-key flow)

The host app owns the token and calls the route; the SDK helper only needs a `getToken()` callback.

```ts
const keys = new ProctorKeyProvider({ baseUrl, sessionId, getToken: () => token });
const result = await keys.ensureKey(tokenEpoch); // IndexedDB first (this epoch only), else POST /candidate/session/proctor-key
const { counters } = result;
await session.start({ sessionId, signingKey: result, keyProvider: keys /* ... */ });
pipeline.seedCounters(counters?.media ?? {}); // media streams continue at max(local, server)
```

- `ensureKey()` returns the key stored for this session (`<sessionId>:hmacKey`, non-extractable CryptoKey with its epoch) without a network call; `fetchKey()` always asks (after an OTP resume the epoch is new). The server issues a key once per epoch, so concurrent fetches share one request. Pass the token epoch to `ensureKey(epoch)` so a key of another epoch is not reused.
- 409 `KEY_ALREADY_ISSUED` is final: `onKeyUnavailable('ALREADY_ISSUED')` runs and the app starts the OTP resume (a new epoch). 429, 503, network errors and timeouts back off (Retry-After wins) for a few attempts, then `ProctorKeyError('UNAVAILABLE')`. A request that timed out may still have been served; the next call then answers KEY_ALREADY_ISSUED and the OTP resume is the way out.
- Counters: `eventSeqStart` and `keystrokeSeqStart` raise the event and keystroke sequences to max(local, server) before anything is cut (also through `setKey(key, epoch, counters)` later); media counters go to `pipeline.seedCounters`. A new device therefore no longer restarts at 0. The server counter only raises the sequence: when IndexedDB and the localStorage backup are both unreadable the time-seeded high fallback still applies (holes, no collisions) and the `event-seq` flag is raised.
- The helper takes the Web Lock `cp-key:<sessionId>` itself (when `navigator.locks` exists) around each attempt, not around the backoff, and gives up after `lockTimeoutMs` (a frozen tab holding it ends as `UNAVAILABLE`). Web Locks are not re-entrant: if the app already holds `cp-key:<sessionId>` for its check-then-OTP-resume sequence it must pass `{ lock: 'none' }` per call (`ensureKey(epoch, { lock: 'none' })`, `fetchKey(epoch, { lock: 'none' })`). The option is per call, not per helper, so the session's own fetches after KEY_EPOCH_STALE (the helper as `keyProvider`) always take the lock. A key another tab stored meanwhile (of the expected epoch) is used instead of a second POST (a second POST would get KEY_ALREADY_ISSUED and force an OTP resume that kills the other tab's epoch).
- Only a non-extractable HMAC-SHA-256 signing key is stored, accepted by `start`/`setKey`, or adopted from a provider. If IndexedDB refuses it the session raises `idb: UNSUPPORTED` (every reload then costs an OTP resume).
- `finish()` and the end of a session (taken over, session not active) delete the stored key with the data; `stop()` keeps it for the reload. The retention sweep never touches a live session: its mark is refreshed by the heartbeat, also during a long outage.
- The helper never stores or logs the token; errors carry a kind and a problem code only. As pull alias `keyProvider: keys` lets the session fetch the key itself after KEY_EPOCH_STALE; the session also calls `keys.forget()` when it purges, so the helper's store is cleaned, a request waiting for the lock is cancelled before its POST, and an in-flight request stores nothing afterwards. A helper with its own store (not the session's `store` / `keyStore`) is purged only through `keyProvider`.
- After a purge (finish, taken over, session over) `session.setKey()` does nothing: call `stop()` and start a new session.

## Heartbeat and health (ADR 0013 section 5.3)

- Every 10 s `POST /candidate/session/heartbeat` with an optional body `{ capabilities?, recorder?, queue? }`.
  - `capabilities`: only flags that changed since the last acknowledged beat (at most 32, worst first), and the full set every 5 minutes. Ids match `^[a-z][a-z0-9-]{1,47}$`, details are cut to 128 characters, counts and reasons only. Flags raised by the app (for example the pipeline's `onCapability`) go through `session.reportCapability(flag)`; the pipeline's `recording-storage` is folded into the single `idb` flag together with the event, keystroke and key parts.
  - `recorder`: from `getHealth: () => ({ recorder: pipeline.heartbeatHealth() })`: per stream segment, last seq, buffered and dropped chunks and bytes, plus conflict, stale-identity and held counts.
  - `queue`: pending event and keystroke batches and rejected batches.
- Answer: the server state goes to `onHeartbeat`; a renewed token goes to `onToken` and is never stored or logged by the SDK. 409 SESSION_NOT_ACTIVE stops the heartbeat and fires `ended` (the queues keep draining during the grace). Three consecutive 401 stop the heartbeat and call `onReauthRequired` once; `session.resume()` or `setKey()` beat again. A 401 is "reachable", not offline.
- `session.probe()` is the reachability probe for the recording pipeline: `new RecordingPipeline({ probe: () => session.probe() })`. A fresh acknowledged beat answers true at once, otherwise one beat is sent now.

## System check before the start (ADR 0013 section 5.4; FR-604, FR-605, FR-610)

```ts
// 1. Before the start (no session, no key yet), on a user gesture:
const outcome = await requestScreenShare(() => assertConsent()); // asks for the whole screen once
// 2. The system check. A missing share is NOT "unverified": surfaceOf() gives null and
//    runSystemCheck throws SystemCheckError('NO_SCREEN_SHARE') without sending anything.
const { passed, blocking } = await runSystemCheck({
  baseUrl,
  getToken: () => token,
  // MONITOR, OTHER (a window or tab: the gate blocks), UNVERIFIABLE (shared, but the browser does
  // not report the surface) or null (no share obtained)
  screenShare: surfaceOf(outcome),
});
// 3. After the session started, hand the SAME stream to the monitor: the candidate is not asked twice.
screenShareMonitor.adopt(outcome);
```

The APP owns the pre-start stream until `adopt()`: if the system check is blocked or fails, or the candidate leaves before the start, call `releaseScreenShare(outcome)` so the screen is not captured any longer. `adopt()` refuses a share that already ended (lock stays, the app asks again).

If the app keeps its own pre-check share (as the precheck step does), it passes its own enum
(`MONITOR`, `OTHER`, `UNVERIFIABLE`) and keeps the stream for `adopt()` the same way.

- A pure function: it only looks (no camera, microphone or screen prompt; `getScreenDetails()` is used only when the window-management permission is already granted, otherwise `screen.isExtended`; each browser step is cut after 3 s and reported UNVERIFIABLE) and posts `POST /candidate/session/system-check` with the candidate token. No key exists yet, so there is no HMAC. `collectSystemCheck()` builds the same body without a request for the app's own pre-flight screen.
- Body: browser brand and major version, network downlink/rtt when the browser reports them, `devices` as booleans plus the screen-share surface enum, MULTI_MONITOR and VIRTUAL_CAMERA findings, and capability flags (`multi-screen`, `virtual-camera`, `camera-permission`, `microphone-permission`, `screen-share`, `screen-share-surface`, `media-recorder` WebM VP8/Opus, `fullscreen-api`, `idb`, `web-crypto`). A check the browser cannot make is UNSUPPORTED or UNVERIFIABLE, never a pass.
- Privacy: device labels and ids are never sent; the only label is the one of a camera that matched a virtual-camera name (the VIRTUAL_CAMERA payload carries `deviceLabel`). Errors carry a kind and a problem code only.
- Answers: 200 `{ passed, blocking }`; 400 `REJECTED`, 401 `UNAUTHENTICATED`, 409 SESSION_NOT_ACTIVE `NOT_ACTIVE` are final; 408, 429, 5xx (503 BUSY) retry with Retry-After, then `UNAVAILABLE` (a `SystemCheckError`). The start gate answers 409 `SYSTEM_CHECK_BLOCKED` when the latest check is missing, stale or not passed.
- After the start the same checks repeat inside signed batches: `MultiScreenMonitor` and `VirtualCameraMonitor` emit MULTI_MONITOR and VIRTUAL_CAMERA events through the session.
