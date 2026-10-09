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
const { key, epoch, counters } = await keys.ensureKey(); // IndexedDB first, else POST /candidate/session/proctor-key
await session.start({ sessionId, signingKey: { key, epoch, counters } /* ... */ });
pipeline.seedCounters(counters?.media ?? {}); // media streams continue at max(local, server)
```

- `ensureKey()` returns the key stored for this session (`<sessionId>:hmacKey`, non-extractable CryptoKey with its epoch) without a network call; `fetchKey()` always asks (after an OTP resume the epoch is new). The server issues a key once per epoch, so concurrent fetches share one request. Pass the token epoch to `ensureKey(epoch)` so a key of another epoch is not reused.
- 409 `KEY_ALREADY_ISSUED` is final: `onKeyUnavailable('ALREADY_ISSUED')` runs and the app starts the OTP resume (a new epoch). 429, 503, network errors and timeouts back off (Retry-After wins) for a few attempts, then `ProctorKeyError('UNAVAILABLE')`. A request that timed out may still have been served; the next call then answers KEY_ALREADY_ISSUED and the OTP resume is the way out.
- Counters: `eventSeqStart` and `keystrokeSeqStart` raise the event and keystroke sequences to max(local, server) before anything is cut (also through `setKey(key, epoch, counters)` later); media counters go to `pipeline.seedCounters`. A new device therefore no longer restarts at 0. The time-seeded fallback and the localStorage backup only apply when no server counter was given.
- `finish()` and the end of a session (taken over, session not active) delete the stored key with the data; `stop()` keeps it for the reload. The retention sweep never touches a live session: its mark is refreshed by the heartbeat, also during a long outage.
- The helper never stores or logs the token; errors carry a kind and a problem code only. As pull alias `keyProvider: keys` lets the session fetch the key itself after KEY_EPOCH_STALE.
