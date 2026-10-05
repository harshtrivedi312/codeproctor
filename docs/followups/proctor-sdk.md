# Proctor SDK follow-ups

Non-blocking findings and open questions. Only blockers stop a merge.

## Step 6 (browser lock and event pipeline)

### Open for the architecture hub (ARC-03)

1. Canonical JSON and HMAC transport are not decided. The SDK signs `canonicalJson({ seq, events })` (sorted keys, no whitespace, UTF-8) with HMAC-SHA256, sends the exact signed string as the request body and the hex signature in `X-Signature`. The API must verify the received string, not a re-serialisation. Confirm or replace in ARC-03.
2. `POST /candidate/session/heartbeat` is not in fsd.md section 4; the SDK path is configurable. Add it to the API table.
3. `sessions.device_info.capabilities` shape is still open. The SDK exposes `getCapabilities()` as `{ id, status: SUPPORTED | UNSUPPORTED | DENIED | UNVERIFIABLE, detail? }[]`.
4. Pre-start checks (ADR 0002 section 3: MULTI_MONITOR and VIRTUAL_CAMERA travel unsigned in the system-check call) are not wired: the SDK only signs in-session batches. The system check can reuse `checkMultiScreen` and `checkVirtualCamera` and send the result itself.
5. `PROCTOR_DETECTORS` has no entry for screen share or fullscreen. When a browser does not report `displaySurface` the SDK emits only a capability flag (`screen-share-surface: UNVERIFIABLE`), not an event. If reviewers should see this, add a detector value.

### Should-fix

1. The /dev/proctor page in apps/web is not built (task scope was packages/proctor-sdk only). `mountProctorDemo(container)` is exported from the SDK; the web page is a thin client component that calls it in an effect.
2. No real-browser run yet: the compatibility table and CPU numbers come from the demo page in Chrome and Edge and must be filled in by a human with a desktop browser (jsdom cannot measure CPU or fullscreen).
3. Events not yet cut into a batch when the tab is killed are lost; `pagehide` triggers a best-effort flush (async signing may not finish).
4. A window or devtools heuristic can false-positive with a large browser toolbar or unusual zoom; the 160 px threshold is not tuned.
5. The 401 response keeps the batch (token refresh is the app's job). A permanently invalid token retries forever with capped backoff.

### Nits

- `IdbStore` opens one connection per instance; share one instance per page.

### Review follow-ups (code-reviewer)

- Step 6 event-batch store needs the same end-of-session purge as recordings: unsent signed batches (`eventBatches`, `meta` `nextEventSeq`) stay in IndexedDB after the session ends. Add `EventQueue.finish()` that drains with a bound then `deletePrefix`.

## Step 7 (recording pipeline)

### Open for the architecture hub (ARC-03, backend Step 11)

1. Media API wire format is assumed: `POST /candidate/session/media/presign` with `{ stream, segment, seq, bytes, contentType }` returns `{ url, headers? }`; `POST /candidate/session/media/confirm` with `{ stream, segment, seq }`. fsd.md section 4 lists presign only; confirm path is configurable. Confirm or replace.
2. With `MediaRecorder.start(10000)` only the first chunk of a segment has the webm header; chunks must be concatenated in seq order within a segment. A new segment starts on every recorder restart (reload, re-share). The worker and review player (TC-070, TC-077) must handle this.
3. Overflow policy past 200 MB is drop-oldest and the SDK reports `droppedChunks` and `droppedBytes` in `RecorderHealth`. The API has no way to hear about gaps today; consider sending a DETECTOR_UNAVAILABLE-like event or a health field.

### Should-fix

1. TC-063 with DevTools offline mode is not run here (no browser). Covered by a simulated 60 s outage in `recording.test.ts`; the manual run still has to be done by a human and noted in the PR.
2. The demo does not yet record; wire `RecordingPipeline` into `mountProctorDemo` when the web page exists.
3. `RecordingPipeline.recordScreen` does not watch the screen track; the caller should call `stopStream('SCREEN')` on SCREEN_SHARE_STOPPED and `recordScreen` again on resume.
4. Chunks are written to IndexedDB as ArrayBuffer (not Blob) for Safari and structured-clone portability; this costs one copy per 10 s chunk.

## Step 8 (in-browser AI detectors)

### Needs the architecture hub or a human

1. Model files are not committed. `packages/proctor-sdk/scripts/fetch-models.mjs <outDir>` downloads the two MediaPipe models and copies the MediaPipe wasm and vad-web assets; the web app must serve them (for example `apps/web/public/models/proctor`, `modelBaseUrl` `/models/proctor`). COCO-SSD weights (`coco-ssd/model.json` plus shards) are not handled by the script: someone with network access must export `lite_mobilenet_v2` to that folder. Decide where the binaries live (git LFS, release asset or build step).
2. Dependencies were added to packages/proctor-sdk: `@mediapipe/tasks-vision`, `@tensorflow-models/coco-ssd`, `@tensorflow/tfjs-core`, `-converter`, `-backend-webgl`, `-backend-cpu`, `@ricky0123/vad-web`. The umbrella `@tensorflow/tfjs` was avoided on purpose: it pulls in `core-js`, whose postinstall makes `pnpm install` fail with ERR_PNPM_IGNORED_BUILDS unless `core-js: false` is added to `allowBuilds` in pnpm-workspace.yaml (hub-owned).
3. API contracts still assumed: evidence presign (`{ contentType, bytes }` returns `{ url, key, headers? }`), identity re-check (frame in, `{ matched, similarity? }` out; fsd.md section 4 only has the one-shot `/identity` upload), and the evidence key layout (the SDK uses whatever key the API returns).
4. MULTIPLE_VOICES is server-written only (`SERVER_EVENT_TYPES` plus the audio re-check in backend Step 13); the browser VAD cannot count speakers, so it only emits SPEECH_DETECTED.

### Should-fix

1. No real-browser run: the worker adapters (`worker/inference.worker.ts`, `createVadWebFactory`) are type-checked against the libraries but not executed here (no browser, no model files). A human must run the calibration panel on Chrome and Edge and record worker CPU and the false-alarm rate. Thresholds in `DEFAULT_AI_CONFIG` are starting values, not tuned (gaze pitch limits especially: looking down at the keyboard must not trigger).
2. `mountCalibrationPanel` and `mountProctorDemo` exist, but the apps/web `/dev/proctor` page does not (out of scope for this run).
3. Inference is one frame in flight; on slow devices frames are skipped and counted (`getStats().skippedFrames`). Add a UI hint if the skip rate stays high.
4. The vad-web ONNX runtime runs on the main thread plus an AudioWorklet, not in the inference worker; its CPU is covered by the main-thread metrics only.
5. `FACE_MISMATCH` re-check sends a 640 px JPEG every 2 minutes; confirm with the privacy review that this selfie traffic is covered by the consent document (D-17, ADR 0004).

### Review follow-ups for PR #23 (code-reviewer)

- Fixed in this PR: worker init always answers `ready`; `InferenceClient.init` times out (30 s) and terminates the worker; heartbeat and page listeners start before detectors; `VisionMonitor.start` reports DETECTOR_UNAVAILABLE (MODEL_LOAD_FAILED) when it fails, including a cross-origin model base; vad-web gets no-op `pauseStream` and pass-through `resumeStream`; fetch-models copies onnxruntime-web wasm and mjs into `vad/`.
- Still open: a hanging non-vision detector (custom plug-in) still delays later detectors because `start` is awaited in order; consider a per-detector start timeout in `ProctorSession`.
- The reviewer's other should-fix and nit items were not forwarded to me in full; the coordinator should paste them here.

### Review follow-ups for PR #21 (code-reviewer, not blockers)

Should-fix

1. `recorder.ts` (sink error is swallowed) and `upload-queue.ts` `add()`: if the IndexedDB put fails (quota, unavailable), the chunk vanishes without being counted in `droppedChunks`; if IndexedDB cannot open, the whole recording is lost with no signal. This conflicts with TC-070 ("never silently skip"). Count these as drops, raise a degraded or capability flag, and consider an in-memory upload fallback.
2. `pipeline.ts` `begin()`: device loss is not surfaced. No `onEnded` is passed, webcam and audio tracks are not watched for `ended`, and a MediaRecorder error stops silently. Emit a signal to the UI and allow a restart as a new segment.
3. `upload-queue.ts` `start()` loads only this session's prefix, so stale chunks from other sessions stay in IndexedDB forever. Sweep them, or those past the retention period.

Nits

- `makeRoom` can exceed the 200 MB cap by the in-flight chunks; event batches are not counted in the cap.
- `media-api.ts`: consider rejecting non-https presigned URLs.
- Per-detector start timeout: `ProctorSession.start` awaits detectors in order, so a hanging custom plug-in delays later ones. Add a per-detector start timeout (also noted in the PR #23 section).

### Review follow-ups for PR #23 (code-reviewer, not blockers)

Should-fix

4. `vision-monitor.ts` reads the webcam stream only once in `start()`. If `pipeline.recordWebcam()` runs after `session.start()`, vision stays PERMISSION_DENIED. Add `attachStream()`, or document and assert the order.
5. `rules.ts` `SpeechRules`: the cooldown drops whole segments within 10 s of the last event, so speech is under-reported. Merge suppressed segments into the next event's duration.
6. `scripts/fetch-models.mjs`: downloads have no SHA-256 pinning.
7. `identity.ts` and `vision-monitor.ts`: FACE_MISMATCH is relayed by the client, so a tampered client can drop it. Raise with the architect whether the re-check endpoint should write it server-side (not a contract violation; ADR 0010 lists it as a client type).

Nits

- `config.ts`: stale doc comment on `snapshotMaxWidth`.
- `vision-monitor.ts`: unreachable `SPEECH_DETECTED` case in `emitRuleEvent`; remove.
- `rules.ts`: object confidence falls back to the threshold on a window miss; carry the max score seen instead.
- `evidence.ts`: snapshots follow default severities, so org overrides are ignored; make the type list configurable.
- `vision-monitor.ts`: a HIGH event waiting up to 3 s on the evidence upload is dropped if the session stops meanwhile.
- `vision-monitor.ts`: the identity re-check only runs when FACE is enabled; document the coupling to accommodations.
- Test names in `vision-monitor.test.ts` and `rules.test.ts` use FR-606; use TC-057 (NO_FACE), TC-058 (MULTIPLE_FACES with snapshot), TC-059 (phone with snapshot).
- Per-detector start timeout in `ProctorSession` (see the PR #21 nits).

### Additional review follow-ups for PR #23 (code-reviewer, not blockers)

- `vision-monitor.ts` `start()` catch: tasks already SUPPORTED are dropped without DETECTOR_UNAVAILABLE because of the `!tasks.has` condition. Drop that condition and reset the capability flag.
- `inference-client.ts` `onerror` after `ready` keeps a dead worker, so `analyze()` hangs silently. Terminate it and emit RUNTIME_ERROR, or add a per-frame timeout.
- `voice-monitor.ts`: `MicVAD.new` has no init timeout (same hang risk as the worker init).
- `core/event-queue.ts` `stop()`: unsent event and keystroke batches stay in IndexedDB after the session ends; needs the FR-702 purge (see the Step 6 note).

## QA-D-01 (TC-050): closed, by design

FULLSCREEN_EXIT carries no duration from the SDK; FULLSCREEN_RESTORED carries the time away. Hub decision: the API fills `duration_ms` on the open FULLSCREEN_EXIT when FULLSCREEN_RESTORED arrives, or at session end; this goes to BE-10/BE-12 and ADR 0013. `qa-tc.test.ts` now asserts the two behaviours (EXIT immediate and without `durationMs`, RESTORED with the time away) instead of the expected-failure test. Not edited here: `docs/test-cases.md`, `docs/test-matrix.md`, `docs/followups/qa.md` and `packages/qa/src/p1-gate.ts` still mention QA-D-01 (QA-owned).

## Status of review should-fix items (PR fe/sdk-review-followups)

Done (with tests):

- PR #21 (1): IndexedDB put or open failure is counted or buffered in memory (32 MiB cap, drops counted), `storageDegraded` and `memoryBytes` in `RecorderHealth`, capability `recording-storage`.
- PR #21 (2): track `ended` and MediaRecorder `error` flush the stream and call `onDeviceLost({ stream, reason })` plus a capability flag; calling `recordWebcam`, `recordAudio` or `recordScreen` again starts a new segment.
- PR #21 (3): `sweepStaleSessions` on queue start deletes chunks, event batches and meta of other sessions last seen over 24 h ago (`staleAfterMs`); data without a mark gets a grace period.
- PR #23 (4): `VisionMonitor.attachStream()` for a webcam stream that arrives after `start()`.
- PR #23 (5): SpeechRules merges cooldown-suppressed speech into the next event; a timer and `stop()` flush it.
- Reviewer non-blockers: start-failure now reports tasks that were already SUPPORTED; a worker error after ready terminates it and emits RUNTIME_ERROR; frames get a 10 s timeout and three in a row kill the worker; MicVAD init timeout (30 s); per-detector start timeout in `ProctorSession` (`detectorStartTimeoutMs`, 45 s); `EventQueue.finish()` and `ProctorSession.finish()` purge the event-batch store but keep the sequence counter (FR-702). Test names for NO_FACE, MULTIPLE_FACES and phone use TC-057, TC-058, TC-059.

Partly done:

- PR #23 (6) SHA-256 pinning: `scripts/lock.mjs` (hash, verify, update, keeps hand-edited licence and status) is in the shape proposed by ADR 0013 section 6, with tests. It is not wired into `fetch-models.mjs` yet, and `models.lock.json` is not generated, because the PR #35 branch changes `fetch-models.mjs` (COCO download, safe path check). Wire it after #35 merges, as the `models:fetch` / `models:update` scripts. COCO-SSD licence stays `unverified` (ADR 0013 F-3).
- Per-detector start timeout only emits DETECTOR_UNAVAILABLE for detectors that declare an `accommodationId`.
- Keystroke batch purge: there is no keystroke queue in the SDK yet; it must reuse `finish()` when it exists.

Left as filed: PR #21 nits (cap with in-flight chunks, https-only presign URLs), PR #23 (7) FACE_MISMATCH relay (hub: server-side in ADR 0013, no SDK change until accepted), evidence key org overrides, 3 s evidence wait lost on stop, identity/FACE coupling note, config.ts comment, unreachable SPEECH_DETECTED case, object confidence carry.

## Deferred until ADR 0013 (Proposed) is accepted

`POST /candidate/session/proctor-key` flow (per-epoch non-extractable key in IndexedDB, re-sign outbox on KEY_EPOCH_STALE, counters seeding), RFC 7807 `code` mapping in the transports, heartbeat body and 409 handling, `runSystemCheck()`, media presign fields (`startedAt`, `durationMs`, exact `video/webm` content type, `alreadyUploaded`, UPLOAD_MISMATCH/UPLOAD_NOT_FOUND retry, never drop a segment's first chunk), evidence presign `purpose` and relative names, identity re-check as upload plus 202 (stop emitting FACE_MISMATCH), SCREEN_SHARE detector value, `models:fetch`/`models:update` replacing `fetch-models.mjs`. No SDK-core change for any of these in this PR.

## Review round 2 on PR #43

Fixed (with tests): finish() keeps `nextEventSeq` (a reload after finish continues at seq N+1, not 0); recording works with a broken IndexedDB (in-memory segment counter, guarded meta delete); a detector abandoned by the start timeout is reported, stopped best-effort, removed from the started list, silenced (per-detector context) and a late `VisionMonitor.startInner` exits without timers or workers (generation guard, `video.play()` bounded to 5 s, `reportStartTimeout`); a live session's last-seen mark is refreshed at most once a minute from batch cuts and chunk writes, so a quiet live session is not swept; S1: `VisionMonitor.attachStream()` swaps the video source on a running monitor and `VoiceMonitor.attachStream()` restarts the VAD on a new stream (the demo does not wire `onDeviceLost` to these yet). Nits done: StartTimeoutError doc order, `Buffer.byteLength` in the lock test, `vi.restoreAllMocks` after tests.
Not done: S2 to S7 of the reviewer list were not forwarded to me in text; paste them here to be filed. The `/dev/proctor` demo does not call the new `attachStream()` methods or `onDeviceLost` yet.
Note: `session.finish()` after `stop()` of another instance is not supported; call one or the other.

## Remaining review items for PR #43 (code-reviewer round 2, not fixed here)

Should-fix

- S2 `EventQueue.finish()`: the drain loop calls `retryNow()` every 50 ms, bypassing the backoff (about 300 requests in 15 s during 5xx or 429); use the normal backoff or a floor of at least 1 s. `lostBatches` over-counts a batch that is in flight at the deadline and later acks. A late RETRY re-arms `retryTimer` (see `scheduleRetry`) after `finish()` cleared it. `ProctorSession.finish()` returns only `lostBatches`; also fire a connection or capability signal so the UI can tell the candidate to stay online before data is discarded.
- S3 `EventQueue` has no IndexedDB failure handling (existing code): a failing `put` in `cutAll` rejects `this.chain`, so every later `flush()` chains onto the rejected promise and the queue is dead for the session; `start()` throws if IndexedDB cannot open, so `ProctorSession.start` fails. Needs an in-memory fallback like the upload queue.
- S4 `inference-client`: any `error` event after ready terminates the worker permanently, but uncaught handler exceptions fire `error` without the worker being dead; count one strike like a timeout. After a frame timeout `inFlight` is cleared while the worker is still busy, so back-pressure is lost (bounded by the three-strike rule).
- S5 `VisionMonitor.attachStream` re-runs the full model load whenever the client is null and tasks are empty, including after MODEL_LOAD_FAILED or UNSUPPORTED, so every device-loss restart re-emits DETECTOR_UNAVAILABLE. Track why the monitor is down and only retry for a missing stream.
- S6 `UploadQueue` never retries IndexedDB once degraded: a transient quota error leaves the rest of the session memory-only with the 32 MiB cap. Retry periodically or after a successful purge. Consider UNVERIFIABLE rather than UNSUPPORTED for WRITE_FAILED (`pipeline.ts` capability `recording-storage`).
- S7 tests: the B1 to B4 tests are added; keep `afterEach(vi.restoreAllMocks)` and `useRealTimers` in every test file that spies or uses fake timers.

Nits

- `rules.ts`: a merged SPEECH_DETECTED has `occurredAt` at the start of the first held segment and `durationMs` as summed speaking time, not the wall-clock span; document it.
- `voice-monitor.ts`: `handle.start()` is not under the init timeout.
- `upload-queue.ts`: `memoryBytes()` is O(n) per add; keep a running counter.
- `sweep.ts`: `sessionOfKey` assumes session ids contain no `:`; assert or document it. A future keystroke queue must not use a `${sid}:ks` session id.
- Sweep tests carry FR-702 only; add the TC id if one exists.
- The `/dev/proctor` demo does not call `attachStream()` or `onDeviceLost` yet.

## Decision needed: flush timer window (TC-065 flake, confirmed cause)

Observation (confirmed): the fired flush-timer callback in `event-queue.ts` never resets `flushTimer`. An event enqueued while a flush is on the chain (after the timer fired, before `cutAll()` ran) gets no new timer and joins the earlier batch, so 3 pastes can produce 2 batches instead of 3. No event is lost or delivered out of order (proved in PR #47); only the batch count differs. Decision for the Delivery Lead or hub: should a late event open a new 5 s window (reset `flushTimer = null` when the timer fires, and start a timer after a cut if events remain), or is joining the earlier batch acceptable? Not changed in PR #47 on purpose.

## Round 3 review items for PR #43 (filed, not fixed)
Fixed in this round: SF1 (an abandoned vision start only touches its own client; `InferenceClient.terminate()` settles a pending init at once; test: start times out, same instance restarted in a new session, new run intact), SF2 (last-seen test now checks the written time), N1 (finish() comments and test name say the counter is kept).

Should-fix
- SF3 `VisionMonitor.attachStream` on a running monitor calls `video.play()` unbounded (start bounds it to 5 s).
- SF4 `VoiceMonitor.attachStream`: concurrent calls can overlap, a VAD created by an abandoned call can leak, and held-back speech rules are replaced by the new `SpeechRules` (speech held by the cooldown is lost on a stream swap).
- SF5 `d.stop()` after a detector start timeout is unbounded; a detector whose `stop()` hangs blocks `ProctorSession.start`.

Nits
- N2 `reportStartTimeout` re-emits DETECTOR_UNAVAILABLE for tasks that were already reported.
- N3 missing `.catch` on the `stopStream().then(...)` chain in `pipeline.ts` device loss.
- N4 single-entry `describe.each` in `stop-inflight.test.ts` style tests; use a plain `describe`.
- N5 make the 5 s `video.play()` bound configurable.
- N6 `VoiceMonitor.stopped` is never reset, so a monitor instance cannot be started again after `stop()`.
- N7 the MultiScreen permission prompt can stay open longer than the 45 s start timeout and is then reported as RUNTIME_ERROR although the user is just deciding.
- N8 (from the earlier list) kept under "Remaining review items".

Owner decisions to respect (C-25, C-32)
- C-25: "face detectors off" is its own accommodation setting, separate from "no identity check". Today the SDK has one `FACE` detector id (`PROCTOR_DETECTORS`) and `VisionMonitor` only starts the identity re-check when the `face` task is enabled, so disabling FACE also disables the re-check. Gap: the accommodation model needs a separate flag (and `IdentityScheduler` needs its own enable switch) before this is correct; and with the ADR 0013 server-side re-check, the server (409 `DETECTOR_DISABLED`) must follow the same separation. Not changed yet.
- C-32: no Sentry or third-party error tracker in the SDK. The SDK currently reports nothing outside the event pipeline. If it ever reports errors it must go through the app's error reporter to our API, scrubbed (no URLs, keys, tokens, object names).

## Round 4 review items for PR #43 (filed, not fixed; docs only)
Should-fix
- SF-A The SF1 test (`vision-monitor.test.ts`, "an abandoned first run cannot tear down a later run") does not reach the race. Run 1's late code now finishes inside `s1.start()` because `stop()` settles the init, so only the `video.play()` wait can resume an old run after a new one has started. Rewrite: abandon run 1 during a test-controlled `play()`, start session 2, release run 1's play, then assert worker B is not terminated, tasks are still 3 and `tick()` samples. Also `workerA.terminated` would be true without the `terminate()` change, so its comment overclaims.
- SF-B `review-fixes.test.ts` (last-seen test): the name says add/confirm but confirm is not asserted (the throttle skips the T+4 min confirm write; the T+6 min system time is set twice). Make `put` wait on a controlled promise and assert last-seen near T+6 min, or drop "confirm" from the name and delete both T+6 lines.
- SF-C (silent-pass class, FR-606, TC-070; do soon) `vision-monitor.ts`: `this.reported` is not cleared by `stop()`. After `reportStartTimeout` in session 1, a reused instance whose session-2 `startInner` throws skips every task in `reported` and emits no DETECTOR_UNAVAILABLE. Clear `reported` and `failures` in `stop()` or at the start of `run()`.

Nits
- `review-fixes.test.ts` comment says the fake clock keeps ticking; it is frozen (the drift comes from elsewhere, so check before keeping the tolerance).
- `vision-monitor.test.ts`: `.every(...)` passes on an empty array; also assert the `vision-` capability flags exist.
- (Fixed in this commit) the PR #23 numbered list was merged into one line, and the "Round 3" heading lacked a blank line.
