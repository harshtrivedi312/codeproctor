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
