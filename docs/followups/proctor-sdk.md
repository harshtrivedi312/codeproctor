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

- (DONE) `config.ts`: stale doc comment on `snapshotMaxWidth`.
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

- SF-A (DONE in PR fe/sdk-sfc) The SF1 test (`vision-monitor.test.ts`, "an abandoned first run cannot tear down a later run") does not reach the race. Run 1's late code now finishes inside `s1.start()` because `stop()` settles the init, so only the `video.play()` wait can resume an old run after a new one has started. Rewrite: abandon run 1 during a test-controlled `play()`, start session 2, release run 1's play, then assert worker B is not terminated, tasks are still 3 and `tick()` samples. Also `workerA.terminated` would be true without the `terminate()` change, so its comment overclaims.
- SF-B `review-fixes.test.ts` (last-seen test): the name says add/confirm but confirm is not asserted (the throttle skips the T+4 min confirm write; the T+6 min system time is set twice). Make `put` wait on a controlled promise and assert last-seen near T+6 min, or drop "confirm" from the name and delete both T+6 lines.
- SF-C (DONE in PR fe/sdk-sfc; `reported` and `failures` are cleared in `stop()` and at the start of `run()`) (silent-pass class, FR-606; no TC covers DETECTOR_UNAVAILABLE; do soon) `vision-monitor.ts`: `this.reported` is not cleared by `stop()`. After `reportStartTimeout` in session 1, a reused instance whose session-2 `startInner` throws skips every task in `reported` and emits no DETECTOR_UNAVAILABLE. Clear `reported` and `failures` in `stop()` or at the start of `run()`.

Nits

- `review-fixes.test.ts` comment says the fake clock keeps ticking; it is frozen (the drift comes from elsewhere, so check before keeping the tolerance).
- `vision-monitor.test.ts`: `.every(...)` passes on an empty array; also assert the `vision-` capability flags exist.
- (Fixed in this commit) the PR #23 numbered list was merged into one line, and the "Round 3" heading lacked a blank line.

## /dev/proctor demo page (apps/web)

- Root `eslint.config.mjs` does not ignore `apps/web/public/dev-proctor-models/**`. After a human downloads the models there, `pnpm --filter @codeproctor/web lint` lints about 170 MB of vendored files (11k errors). CI is unaffected (the dir is gitignored and absent). Hub: add `'apps/web/public/dev-proctor-models/**'` to `globalIgnores`.
- Production CSP has no `'wasm-unsafe-eval'`, so MediaPipe, ONNX and TF.js wasm will not compile in a production build. The dev server works because dev adds `'unsafe-eval'`. Needed before any real candidate run; also `worker-src`/`connect-src` for the real object-storage origin.
- The global `Permissions-Policy` sets `microphone=()`, which blocks the voice detector everywhere. The demo gets a dev-only per-path override in `next.config.ts`; the real candidate test route needs `microphone=(self)`.
- The demo files under `public/dev-proctor-models/` would be served by a production build if present on the build machine; the build step must not fetch them.
- `fetch-models.mjs` now also downloads COCO-SSD lite_mobilenet_v2 (still no SHA-256 pinning).

### Review follow-ups for PR #35 (code-reviewer, not blockers)

Fixed in the PR: COCO manifest path traversal check (`scripts/safe-path.mjs`, tested), usage comment path, `next.config.test.ts` for the Permissions-Policy override. No model binary was ever committed on the branch (`git log --stat origin/main..HEAD -- apps/web/public` is empty).

Should-fix 4. DONE: mock server memory bounds (sessions 20, chunks and batches per session 5000, issued evidence names 1000, heartbeat health JSON size-limited, `/state` gap scan capped at 50 with a total count), and chunk `segment`, `seq`, `bytes` and `durationMs` are validated. Body limits are enforced on Content-Length before reading (events 256 KiB, keystrokes 2 MiB, media PUT 16 MiB, evidence PUT 1 MiB, other JSON 16 KiB). 5. DONE: the evidence PUT requires a name that was presigned, and the media PUT no longer creates session state from an unauthenticated URL. 6. DONE: `mount.ts` `stop()` cancels an in-progress async start (flag checked after each await; a late camera or microphone is released; the screen-share picker answer after stop is released).

Nits

- DONE: missing dev token is 401 (comment and code agree); stricter full-key regex for the PUT route; capability list in `mount.ts` uses `textContent`; test names carry FR/TC/NFR ids; content-type check is `/^application\/json(\s*;|$)/i`.
- Open: `identity/recheck` does not validate `capturedAt` as ISO 8601 (any string is accepted); the evidence PUT does not check Content-Type, size against the presigned `bytes` or repeat count (a name can be PUT many times); the evidence key is derived with `path.indexOf('evidence/')` slicing, replace with the capture group of the key regex.
- Open: the `/dev/proctor` chunk still compiles into production bundles (the route 404s at runtime). Consider a prebuild guard that fails the build if `public/dev-proctor-models` exists, and excluding the route from production builds.
- Open: root `eslint.config.mjs` `globalIgnores` for `apps/web/public/dev-proctor-models/**` was added by main (#37); nothing left here.

## /dev/proctor mocks aligned with ADR 0013 (Proposed, PR #39), provisional

The mock handlers and the demo's injected adapters (`packages/proctor-sdk/src/demo/mount.ts`) follow the wire tables of ADR 0013 sections 2 to 5. SDK core is unchanged. Deferred SDK changes, to do only after the owner accepts ADR 0013:

- `POST /candidate/session/proctor-key` flow: per-epoch key, non-extractable `CryptoKey` in IndexedDB, re-sign the outbox on a new epoch or `KEY_EPOCH_STALE`, counters seeded from the response. The mock still uses one demo key and base64 in the bundle.
- RFC 7807 `code` mapping in `createFetchTransport` and `createFetchMediaApi` (today they map by status only; 409 and 422 mean different things by code). The demo's media adapter reads `code` itself.
- Heartbeat body from SDK core (recorder and queue health) plus 409 `SESSION_NOT_ACTIVE` handling. The demo wraps the transport; per-stream `segment` and `lastSeq` are not exposed by `RecorderHealth`, so the demo sends 0 for them.
- Media presign fields: `startedAt`, `durationMs`, exact `video/webm` or `audio/webm` content type (SDK sends `video/webm;codecs=vp8`), `alreadyUploaded`, `UPLOAD_MISMATCH` and `UPLOAD_NOT_FOUND` retry, never drop a segment's first chunk. Open question for the hub: the ADR makes `seq` unique per stream (`SEQ_CONFLICT` when the same seq exists in another segment) but the SDK restarts `seq` at 0 in every segment; the demo adapter sends `segment * 100000 + seq`.
- Evidence presign `purpose` and `evidenceKey` (relative `evidence/<ULID>.jpg`); identity re-check as frame upload plus 202; SDK core must stop emitting client FACE_MISMATCH (the demo adapter reports `matched: true` to stop the relay).
- `runSystemCheck()` and `POST /candidate/session/system-check`; SCREEN_SHARE detector value; `models:fetch` and `models:update` with `models.lock.json`.
- Not modelled in the mock: key epochs, SESSION_NOT_ACTIVE, rate limits other than identity (1 per 60 s), org prefixes (fixed `demo`).

## Review round 2 for PR #35 (code-reviewer, not blockers; docs only)

Should-fix

- SF1 `api/_lib/handler.ts` `tooLarge`: a chunked upload without Content-Length passes (`Number(null)` is 0) and is fully buffered by `arrayBuffer()` or `json()`. Add a `readCapped(req, max)` helper that reads `req.body` with a reader and answers 413 once the limit is passed.
- SF2 `api/media/put/[...key]/route.ts` reads the body before checking the chunk was presigned. Do the lookup first and answer 403 without reading.

Nits

- `mount.test.ts`: add cases for stop() during a delayed `recordAudio` `getUserMedia` (microphone released) and stop() while the screen-share picker is open (late tracks stopped). Note that the existing "no microphone request" assertion would pass even without the stopped checks; `cam.stop` is the real catch.
- `pipeline.recordScreen` can call `begin('SCREEN')` after `pipeline.stop()` if stop lands during `applyConstraints` or `nextSegment` (`mount.ts` screen-share handler): check `stopped` after `recordScreen` and call `pipeline.stopStream('SCREEN')`.
- `api/state/route.ts` GET still creates sessions via `sessionState(id)`; use `existingSession` and return an empty summary.
- `withSession` returns 413 before 401; check auth first.

## Identity re-check constants (owner decision C-08; PR fe/sdk-identity-constants)

Done: `IDENTITY_FRAME_WIDTH_PX = 640` and `IDENTITY_RECHECK_INTERVAL_MS = 120_000` are named constants and the defaults (`snapshotMaxWidth`, `identityIntervalMs`); tests assert width, size scaling and one re-check per 120 s. Gaps: the capture only scales down, so a webcam narrower than 640 px gives a narrower frame (the recorder asks for 640x360, so this is the normal width); a real-browser capture was not measured here; the ADR 0013 limit is 1 re-check per 60 s and the `/dev/proctor` demo uses 61 s so it shows one soon. The FACE/identity coupling (C-25) is unchanged and waits for ADRs 0013 and 0015.

- There is no TC for the identity re-check (QA to add one for the 640 px / 120 s behaviour). `snapshotMaxWidth` also sizes HIGH-event evidence snapshots; if the config ever becomes per-org, add a separate `identityFrameWidthPx`.

## Should-fix round (PR fe/sdk-should-fix)

Done (with tests): S2 `EventQueue.finish()` no longer calls `retryNow()` every 50 ms (at most once a second, so about one request per second in a 5xx outage), waits for an in-flight send at the deadline before counting `lostBatches`, never re-arms a retry after it returned, and `ProctorSession.finish()` raises `finish-pending` (stay online) and `finish-lost` capability signals; S3 EventQueue survives IndexedDB failures (open failure and write failure fall back to memory, the flush chain is never rejected, capability `event-storage`); S4 an `error` event after ready is one strike (three terminate), and after a frame timeout back-pressure stays until the worker answers late, declared dead if it never does within another timeout; S5 `attachStream` only retries when the monitor was down for a missing stream, not after model failures; S6 UploadQueue probes IndexedDB again every 30 s while degraded and leaves memory-only mode (`recording-storage` goes back to SUPPORTED; a write failure is UNVERIFIABLE, an open failure UNSUPPORTED); SF3 `attachStream` bounds `video.play()`; SF4 `VoiceMonitor.attachStream` calls are serialised and the speech rules (held-back speech) survive a swap; SF5 a hanging `stop()` after a start timeout is bounded to 5 s; N2 `reportStartTimeout` does not re-emit for reported tasks; N3 device-loss `stopStream` failure no longer hides the signal; N6 a stopped `VoiceMonitor` can be started again; `memoryBytes()` is a running counter; unreachable SPEECH_DETECTED case removed.

Still open (not in this PR): proctor-key route, per-epoch key, models.lock.json and SHA pinning, C-25 accommodation split (held for ADR 0013 and 0015); `makeRoom` can exceed the 200 MB cap by in-flight chunks; reject non-https presigned URLs; object confidence carries the threshold on a window miss; evidence snapshot types configurable; a HIGH event waiting for its evidence upload is dropped if the session stops meanwhile; identity re-check coupling note; N4, N5, N7; `VoiceMonitor` `handle.start()` is not under the init timeout; `sweep.ts` assumes session ids contain no `:`; keystroke queue purge (no keystroke queue exists yet); the demo does not call `attachStream`/`onDeviceLost`.

## PR #70 review round (fe/sdk-should-fix)

Fixed here: B1 (the event sequence counter is written on every cut even while degraded, backed up in localStorage, recovery probe like the upload queue; an unreadable counter with no backup seeds the sequence above any plausible earlier value, seconds since 2026-01-01, and raises an `event-seq` capability, so the sequence gets holes; two reuse paths remain, see S-D below), B2 (one live VAD: start and attach run through one queue, generation and token guards, stale callbacks ignored), S5 (`down` state: FAILED on every failure path, reset in `stop()`), S7 (FATAL drops the memory counter), S8 (SF5 test waits for the detector's start with real ticks and uses configurable 50 ms bounds), S9 (`vi.useRealTimers()` after each test). Not fixable before #64 merges: S6 (keep `reported`/`failures` clears at the top of `run()` and in `stop()` and reset `down` there once #64 is in main; merge order #64 then #70).

Filed (not fixed)

- S1 `EventQueue.finish()` initial flush is unbounded because the fetch transport has no timeout: bound with `Promise.race` against the deadline while keeping the in-flight-sign guarantee, and test the settle loop.
- S2 the "normal backoff" comment in `finish()` is inaccurate: `retryNow()` resets `attempt` to 0 and 429 `Retry-After` is ignored.
- S3 the in-memory event outbox has no size cap: add a cap, a `droppedBatches` counter in `stats()` and a flag.
- S4 the session-level flags `event-storage`, `event-seq`, `finish-pending`, `finish-lost` bypass `getCapabilities()`: route through the `ctx.setCapability` path; ADR 0013 names the flag `idb: UNSUPPORTED`; `finish-pending` should also count `pendingEvents`.
- S10 vacuous assertions in `vision-monitor.test.ts` (held-back speech case, a `toBeDefined`, and the "attachStream retries only" test's trailing checks).
- Nits: JSDoc on `degrade()` belongs on `start()`; `upload-queue.ts` "Called once" wording; the recovery flag says SUPPORTED while memory-only chunks remain; `inference-client` `onDead` doc; `enqueue`/`flush` after `finish()` still persist; a bounded voice `destroy()` and mid-segment speech lost on a stream swap; `session.ts` a `stop()` that hangs more than 5 s leaves a late-starting detector alive.

## PR #70 review round 2 (fe/sdk-should-fix)

Fixed: S-A (stale callbacks asserted to report nothing, the live set exactly one event, stop() flushes nothing extra), S-B (an abandoned voice `begin()` returns quietly from the failure handler and a throwing `destroy()` is contained; test: rejecting createVad then stop and restart emits no DETECTOR_UNAVAILABLE), S-C (seed floor 10 000 000 plus seconds since 2026-01-01, clamped below 2^31, so a device clock before 2026 is still high), S-E (backup is `{ seq, seenAt }`, other sessions' entries older than `staleAfterMs` are swept on start), S-F (the finish test waits for `sendBatch` instead of sleeping), N1 (only safe integers in [0, 2^31) are accepted as a stored counter or backup), N2 (comment says every reused seq is rejected, ADR 0013: dropped and counted rejected).

Should-fix (tied to ADR 0013 counters)

- S-D "never reused" overstated: two reuse paths stay unflagged until ADR 0013 counters exist. (1) Every counter write failed in the previous page load while IndexedDB reads work on reload: the sequence restarts at 0. (2) Resuming on a new device always restarts at 0 (FR-106, D-21): fixed by `proctor-key` `counters.eventSeqStart`, `max(local, server)`. Raised from nit to should-fix.
- S-E exception to confirm with the hub: the sequence backup uses `localStorage` (`codeproctor:eventseq:<sessionId>`, a pseudonymous id and an integer, no candidate data).

Nits (filed)

- N3 `signHex` failure is swallowed in `cutAll` with no `droppedBatches` count.
- N4 `VoiceMonitor`: a hung `destroy()` or `handle.start()` now also blocks a later `start()` (it shares the queue); `start()` with no stream does not destroy an existing handle or bump the token.
- N5 the `over = {}` parameter in `should-fix.test.ts` should be `Partial<EventQueueOptions>`.
- N6 `UploadQueue` `memory.set` on an existing key double-counts bytes.
- N7 `EventQueue.finished` is never reset in `start()`: document the queue as single-use.
- N8 a vacuous `expect(worker).toBeDefined()` in the attach test.

## Keystroke recording (PR fe/sdk-keystrokes; FR-608, FR-802, TC-062)
Shipped: `KeystrokeRecorder` (`session.keystrokes`), `KeystrokeQueue`, `editsFromMonaco`, `sendKeystrokeBatch` in `createFetchTransport`. The event queue is now a thin subclass of a generic `BatchQueue`; the keystroke queue reuses all of it (signing, IndexedDB outbox, backoff, finish and stop-in-flight guarantees, the #70 sequence-safety work with its own counter `nextKeystrokeSeq` and backup `codeproctor:keystrokeseq:`). The two streams share the IndexedDB store: event batches are keyed `<sid>:<seq>`, keystroke batches `<sid>:ks:<seq>`, and each queue loads and deletes only its own keys.

Public API (small and stable)
- `session.keystrokes: KeystrokeRecorder | null` (null before `start()` or when the transport has no `sendKeystrokeBatch`; the `keystrokes` capability says UNSUPPORTED then).
- `reset(sessionQuestionId, language, text): boolean` (RESET: load, restore after reload, reset to starter, language switch, switching question), `recordChange({ offset, deleteLength, text })`, `recordChanges(EditorChange[])`, `recordCursor(offset, selectionLength?)`, `recordSelection(startOffset, endOffset)`, `stats()`.
- `editsFromMonaco(e.changes)` converts a Monaco `onDidChangeModelContent` event (descending offsets) without importing monaco. The app converts cursor positions with `model.getOffsetAt`.
- Transport: `sendKeystrokeBatch(batch)` next to `sendBatch` (injectable; ADR 0013 Proposed keeps `X-Signature` over the exact body).

Open
- RESET over 100 000 characters: ADR 0010 and the schema give RESET a 100 000-character limit and no truncation or chunking rule. The recorder refuses it (returns false), reports `TEXT_TOO_LONG` through the `keystroke-unrepresentable` capability (reason only, never text) and skips edits of that question until a shorter reset. Same for an EDIT with offset, length or text over 100 000. This matches the 100 000-character source limit for runs; if longer models must be supported the schema needs a chunked RESET. Needs a hub decision.
- The app must call `reset()` whenever it sets the model (first load, restore from a draft, reload, language switch, question switch) and must call `recordChange` for every model change in order; a missed change makes replay diverge silently. `/dev/proctor` uses a textarea with a prefix/suffix diff as a stand-in.
- Timestamps use the client clock (made non-decreasing); the server clamps `startedAt`. Cursor moves within 250 ms of each other are coalesced; edits never are.
- A batch holds one question only, so a quick switch back and forth creates several small batches; fine for replay.
- The demo mock shows keystroke batches in the shared accepted/duplicate counts (no separate panel row).
- Multiple tabs of one session would each write their own keystroke sequence; not handled (same as events).
- ADR 0013 server counters (`keystrokeSeqStart`) will replace the local counter and backup for a new device; until then the cross-device restart-at-0 caveat of the event queue applies to keystrokes too.

### Keystroke review round 1 (PR fe/sdk-keystrokes)
Fixed: B1 (finish() closes the queue: nothing is accepted, cut or persisted afterwards, pending items count as lost, a batch mid-signing at close is not stored; `KeystrokeRecorder.close()` is called by `stop()` and `finish()`; the demo removes its listeners; `finish()` also deletes `<sid>:ks:` keys of an earlier load even without a keystroke queue; both queues are finished in parallel), B2 (keepalive decided on UTF-8 bytes with 32 KiB headroom, one retry without keepalive on a TypeError), S1 (U+0000 and lone surrogates are `UNSTORABLE_TEXT` and stop that question until a clean reset; the demo diff never splits a surrogate pair; a refused keystroke batch raises `keystroke-rejected`), S2 (only the schema fields are signed, items are rebuilt from the parsed result), S3 (`INVALID` reason), S4, S5, S6, and the cheap nits (degrade() comment, generic backup doc, no `flushIntervalMs: undefined` override, `atMs` bounded to years 0000-9999, Monaco tie-break by longer deletion, EOL note, imports from batch-queue).

Filed
- `sweepStaleSessions` runs twice per session start (once per queue); harmless, could be done once by the session.
- `keystrokes.test.ts` imports the API's `signature.ts` directly (`apps/api/src/proctor-events/signature`): a deliberate coupling to test the real verification path; replace with a shared fixture if the API file moves.
- A 409 `KEY_EPOCH_STALE` still maps to REJECTED (the batch is dropped) in both transports; ADR 0013 says re-sign and retry. Deferred until ADR 0013 is accepted; the same applies to `SESSION_NOT_ACTIVE`.
## Media alignment with ADR 0013 5.5 (PR fe/sdk-media-align; FR-701, FR-702, TC-063, TC-070)

Done

- Seq is unique per (session, stream) across segments (hub answer, matches the built `proctor-key` counters): per-stream `MediaCounters` persisted in IndexedDB under `<sid>:media:<STREAM>` before a chunk is stored, lifted from chunks still waiting and from `pipeline.seedCounters()` (server `counters.media`, `max(local, server)`). A recorder restart or reload no longer reuses seq 0, which used to give 409 `SEQ_CONFLICT` and a dropped segment. The app's old seeding of `<sid>:segment:<STREAM>` (last segment used) is still read.
- Presign sends the bare `video/webm` or `audio/webm` (never the recorder's codecs string), `startedAt` and `durationMs` per chunk (measured from the recorder); the PUT sends exactly the headers the presign returned; `alreadyUploaded` skips PUT and confirm; 412 on the conditional PUT goes to confirm.
- Quota-aware: presign lazily, one chunk right before its PUT, the URL cached and reused for retries until 5 s before it expires; nothing is presigned while the connection is down (probe via `probe`, or one chunk as the probe; the browser `online` event ends the quiet period); 429 PRESIGN_QUOTA_EXCEEDED holds that stream for Retry-After and keeps the chunk.
- Errors by RFC 7807 `code` first (SESSION_NOT_ACTIVE stops uploading, keeps the chunks and raises `recording-ended` plus `onEnded`; CHUNK_NOT_PRESIGNED and UPLOAD_MISMATCH re-presign; UPLOAD_NOT_FOUND re-uploads; SEQ_CONFLICT and 4xx are FATAL), per-request AbortController timeouts (presign and confirm 15 s, PUT 30 s).
- The first chunk of each segment is never dropped: not by the 200 MB drop-oldest, not by a FATAL answer (kept, flagged `recording-blocked`, retried every 5 min). If only protected chunks remain, an ordinary incoming chunk is dropped and counted, an incoming first chunk is admitted above the cap and flagged (`recording-buffer`).
- `/dev/proctor` mock: PRESIGN_QUOTA_EXCEEDED after 140 presigns per stream (repeats count, a confirmed chunk is free), `If-None-Match: *` with 412 on a second PUT, segments up to 9999, the demo uses the real `createFetchMediaApi` (no seq bridge).

For Frontend (apps/web `candidate-test/proctor/media-api.ts`, not touched here)

- The SDK types stay compatible with your bridge (`ChunkRef` new fields are optional, `PresignedPut.headers` and `expiresAtMs` optional, `alreadyUploaded` is a flag on `PresignedPut`; `MediaApiError` kinds are a superset). You can drop the `segment * 100000 + seq` bridge and the `ALREADY_UPLOADED_URL` marker and use `createFetchMediaApi` with the real `seq`; seed the pipeline with `pipeline.seedCounters(counters.media)` instead of writing `<sid>:segment:<STREAM>`.
- Keep FU-FEB-36's guard in mind: the SDK queue now implements it itself. `alreadyUploaded` is believed only for chunks the queue got a URL for or restored from IndexedDB in `start()` (and only when their stream is not held); for any other chunk, and for a 409 `SEQ_CONFLICT`, it is an identity collision (flag `recording-seq-conflict`, health `seqConflicts` and per stream). The stream is HELD: no presign, no drop, no guessed seq. The hold is persisted (`<sid>:held:<STREAM>`, a segment number, no media) before it is flagged, so a reload re-holds instead of trusting the restored chunks. The live recorder keeps recording into the held segment (bounded by the 200 MB cap; overflow is dropped and counted). The hold ends only when you call `pipeline.seedCounters(counters.media)` with counters from the server (a new-epoch `proctor-key` answer after an OTP resume): the held chunks are dropped and COUNTED (`staleIdentityLosses`, flag `recording-stale-identity`) and the recorder restarts into a fresh segment whose seqs continue from the seeded `nextSeq`. If you keep your own `presigned` set, it is now redundant but harmless.

Open

- `probe` is not wired to the session heartbeat yet (heartbeat PR); until then one chunk is let through as the probe.
- Transport hardening still has to purge or drain on `recording-ended` (the queue only stops and keeps the chunks).
- The cap (`presignCap`) is cumulative per stream and session on the server; a very long session or many restarts can exhaust it. The SDK only waits (Retry-After), it cannot get more.
- A new device restarts local counters at 0 until `seedCounters` is called with the `proctor-key` answer.

### Review round 1 for PR #366 (media alignment)

Fixed: B1 (alreadyUploaded trusted only for URL-given or restored chunks, else collision with a fresh seq or a counted drop; first chunk kept), B2 (first-chunk overflow above the cap bounded to 16 MiB per stream, then the segment is lost, counted and flagged `recording-segment-lost`), B3 (after SESSION_NOT_ACTIVE the pipeline stops all recorders and the queue refuses and counts new chunks, nothing is written to IndexedDB), S1 (timeout covers the response body), S2 (probe timeout 15 s), S3 (PUT status 0 is offline), S4 (`recording-quota` flag, the online event no longer clears a quota hold), S5 tests, S6 (finish docstring), S7 (unknown streams in `seedCounters` ignored, counters persisted on seed).

Filed

- S8 legacy 6-part chunk keys from an earlier SDK version load with `first: false` (their segment's first chunk loses the protection).
- Nits: `schedule()` ignores an earlier target than the one already set; an IndexedDB read error in `upload()` removes the chunk from `pending` without a counted drop; the queue is single-use (document); a presign expiry should be `min(expiresAt, receivedAt + 60 s)` against client clock skew; read a `retryAfterSeconds` body field when the header is absent; a test comment says `0,1,2,3` for five chunks; `vi.unstubAllGlobals()` in afterEach of `media-align.test.ts`; a hard-coded stream list remains in the dev mock (`STREAMS`); the mock clamps segments at 9999 like the server.

### Review rounds 2 and 3 for PR #366 (collision handling, shrunk)

Done: BL-2 (every `record*` returns before asking for consent or a device once the session ended or `stop()`/`finish()` began; a prompt answered later releases the device; `begin()` re-checks after its awaits), BL-3 to BL-6 by construction (a collision never stops a recorder or touches a device; `releaseAll()` releases the union of recorders and owned devices on end, `stop()` and `finish()`; a `closing` flag is set first in `stop()`/`finish()`; nothing is written to IndexedDB after `purge()`, including the hold marker; the hold is persisted, restored chunks of a held stream are never trusted). The automatic group move, the live-recorder restart on collision and the `resyncCounters` hook were removed (BL-7, BL-8 gone with them).
Later improvement, once the hub's counters-only read is accepted by the owner (`GET .../proctor-counters`, or `nextSeq`/`nextSegment` on the 409 SEQ_CONFLICT body): move a held group into a fresh segment with contiguous seqs from the server's `nextSeq` and the header chunk lowest, instead of dropping it when the app calls `seedCounters`. Conditions from the hub: never reuse a seq that exists server-side, re-keyed presigns count against the quota, every re-key and stale-identity loss is counted and flagged. Do not build before it is accepted.
Open

- Heartbeat wiring of the per-stream counts (`seqConflictsByStream`, `staleIdentityLossesByStream`, `heldStreams`) comes with the heartbeat PR (S-4).
- Chunks confirmed under stale numbers before the collision are not recoverable; they are not counted because the SDK cannot know them.
- A held stream keeps buffering new chunks until the cap; with a long hold the oldest ordinary chunks are dropped and counted, first chunks are protected up to the 16 MiB overflow.

### Review round 4 for PR #366 (filed)

Fixed: S1 (`releaseHeld` skips chunks a purge already counted; `ended`/`closing` re-checked right before it), S3 (a recorder map entry is deleted only if it is still the one that was stopped; `stopStream` also forgets the source; a restart needs a live track and no other recorder), S5 (the held recorders stop FIRST, then the counters are seeded, then the held chunks are dropped, then the recorder restarts: a real recorder's final chunk takes its old number and is dropped with the held ones), S6 tests (seeding with no hold drops nothing, no recorder after stop/finish/ended, seed racing with finish counts once).
Filed, not fixed

- S2 an upload that was in flight on a held stream when `releaseHeld` ran can re-hold the stream afterwards (needs a per-stream "released stale" set).
- S4 `seedCounters` before `pipeline.start()` has completed never releases a hold restored from IndexedDB: call `seedCounters` after `await pipeline.start()` (tell Frontend).
- S7 a hold drops ALL pending chunks of the stream, including older segments that may be fine; a later group move (after the counters-only read) should drop only what it must.
- N1 `finish()` waits the full `drainTimeoutMs` when only held chunks remain.
- N2 a restored hold counts `seqConflicts` again on every reload; the heartbeat PR must not add the counts across loads.
- N3 theoretical hold-marker write after a purge (the check is before the awaited put).
- apps/web conflict: `candidate-test/proctor/lifecycle.test.tsx:386` expects a recorder to start and store a late chunk after `stop()`. The pipeline now starts nothing once `stop()` or `finish()` began (stop = page leave, no UI and no owner for a late recorder); Frontend must flip that assertion (no WEBCAM chunk key, keep the device-released and no-presign assertions).

### Queued for the heartbeat PR: capability flag ids (FU-FEB-65, ADR 0013 5.3/5.8)
- Ids must match `^[a-z][a-z0-9-]{1,47}$`, detail at most 128 characters, counts and reasons only, never keystroke text or code. A changed flag goes out on the first heartbeat after the event and is kept for the session (5-minute resend).
- `keystroke-unrepresentable`: UNVERIFIABLE once any change could not be encoded; detail "N changes".
- `keystroke-rejected`: UNVERIFIABLE when a batch was dropped after a 400 or a 409 SEQ_CONFLICT; detail is the count.
- `keystroke-seq-reset`: UNVERIFIABLE when the keystroke counter was resynced or seeded high; the keystroke queue's current `event-seq`-style flag maps to this id.
- `idb`: the ADR's name for our `event-storage` and `recording-storage` flags; map or rename.
- #345 emits `keystrokes`, `keystroke-unrepresentable`, `keystroke-rejected` today; add `keystroke-seq-reset`.
- Add a conformity test over every flag id the SDK can emit (regex and detail length).

## Transport hardening (PR fe/sdk-transport-hardening; FR-601, FR-609, FR-701, TC-063, TC-065)

Done

- Every `createFetchTransport` call (event batch, keystroke batch, heartbeat) has an AbortController plus a race against a timer, and the timer is cleared only after the body is read (batch 20 s, heartbeat 8 s, both configurable). A fetch that ignores the abort signal is bounded too. `finish()` and the queue head can no longer hang on one request.
- Errors map by RFC 7807 `code` first, then status (`classifyAnswer`). `SendResult` is now the old strings or a `SendOutcome` object: RETRY with `retryAfterMs` (429, 503 BUSY, Retry-After seconds or date, capped at 5 min), REJECTED with `code` (SEQ_CONFLICT, SIGNATURE_INVALID, 400, 403, 413, 415: dropped and counted), KEY_STALE, KEY_UNAVAILABLE, ENDED (SESSION_NOT_ACTIVE or TAKEN_OVER), AUTH (401). Plain strings still work, so the web app's own transport needs no change.
- `BatchQueue` (events and keystrokes): the queue remembers (in memory) which key each unsent batch was signed with. On KEY_EPOCH_STALE a batch signed with an older or unknown key (loaded from IndexedDB) is just signed again with the key the queue already has, without asking anyone (the server issues a key once per epoch). Only a batch signed with the CURRENT key that is itself stale asks `onKeyStale(currentKey)` (timeout 10 s, a hung provider is a transient failure); a fresh key re-signs every unsent batch from its stored body (same body, same seq, re-persisted) and retries at once. No provider or a null answer holds and keeps the batches and raises `onKeyUnavailable` once; a provider that keeps returning a stale key stops after 3 rounds (the counter resets when a batch is acknowledged). A cut that was mid-signing when the key changed signs again before it joins the outbox. Session side (ADR 0013 names): `session.setKey(base64)` (both queues re-sign and resume), config `onKeyStale()` (raised when no newer key is available), `keyProvider.getKey()` as a pull alias; one refresh serves both queues. Epoch storage and counter seeding of `setKey(key, epoch, counters)` come with the proctor-key PR.
- ENDED from a BATCH route (SESSION_NOT_ACTIVE after the grace) or SESSION_TAKEN_OVER from any source: the queue stops, drops pending items, purges its stored batches at once (FR-702), refuses new items and calls `onEnded(reason)` once; the lost batches are counted in `lostBatches`, in the `ended` event payload and in a `batches-lost` flag, so the loss is not silent without `finish()`. The session fires `ended` once, stops the heartbeat, closes the keystroke recorder and ends the other queue; TAKEN_OVER also raises `onReauthRequired('SESSION_TAKEN_OVER')`. A HEARTBEAT SESSION_NOT_ACTIVE only stops the heartbeat and fires `ended`: the batch routes keep accepting during the post-submit grace, so the queues keep draining. After `stop()` a late answer purges nothing (the kept outbox belongs to the next load).
- 401: after `finish()` began, TOKEN_EXPIRED is a lost tail (no retry, counted, purged; relies on the invariant token TTL / 2 >= ingestion grace 300 s). While live, `authLostAfter` (default 3) consecutive 401 STOP the queue (ADR 0013 5.2, never retry forever): no timer, batches stay persisted, `onReauthRequired(reason)` once. Online events, flushes and finish() do not clear the hold; `session.resume()` (queue `resume()`) does, after the app refreshed the token. Retry-After is binding for retryNow, flush, online and finish nudges.
- Flags: `signing-key` (held, no key), `event-rejected` and `keystroke-rejected` now carry counts only.

Open

- The heartbeat PR must map these flag ids to the ADR names (`keystroke-seq-reset`, `idb`, ...), see the heartbeat note above.
- `SESSION_NOT_ACTIVE`/`TAKEN_OVER` stop the SDK senders only. The app must call `session.stop()` (or `finish()`), stop the recording pipeline (`recording-ended` is raised by the media API errors) and show the end screen on the `ended` event.
- Media PUT timeouts live in `UploadQueue` (#366); the evidence PUT (`uploadEvidence`) is bounded by a race but its fetch is not aborted.
- The web app's own transport (`candidate-test/proctor/transport.ts`) still maps by status; it should switch to `classifyAnswer` or return the same outcomes (Frontend's file).
- The provider can be asked up to 3 times in a hold episode (the counter resets when a batch is acknowledged); the session shares one in-flight refresh and hands an already refreshed key to the other queue.
- Names versus ADR 0013: the SDK uses `setKey(base64)` (no epoch or counters yet), `onKeyStale`, `onReauthRequired` as in the ADR; `keyProvider.getKey()` (pull) and the `ended` event are additions for the hub to confirm. `loadStoredKey` and `onToken` are not built.
- Nits filed: `lostBatches` adds pending item counts to batch counts; an OK answer that arrives after the end is still counted as lost; the TAKEN_OVER heartbeat/batch tests use the code, the server answers it with 401.
- OTP resume (hub ruling S-7, documented in `packages/proctor-sdk/README.md`): the app calls `stop()` before the OTP, then a new session plus `setKey(newKey)`; same-device resume without `stop()` is TAKEN_OVER and terminal (outboxes purged, counted in `lostBatches`, the `ended` payload and the `batches-lost` flag). For Frontend B: `setKey()` also lifts the 401 hold, `resume()` does too; `onReauthRequired` runs once per episode (reset by `setKey`/`resume`). The recorder (media pipeline) snapshot has no equivalent loss counter for batches; if wanted, add to the pipeline health in the heartbeat PR.
- Nits filed: `lostAtEnd` / `lostBatches` / `batches-lost` count pending items as batches; several 401 / Retry-After tests use real-timer sleeps of 150 to 250 ms (prefer `vi.waitFor` on a call-count plateau).

- Round 3 fixes in #385: nothing is written after a purge (a put that raced `endSession` is deleted again, a batch mid-cut counts in `lostBatches` at once), `onReauthRequired('SESSION_TAKEN_OVER')` always fires once (separate from the 401 episode), the queues get `keyProviderTimeoutMs`, three provider failures of any kind hold, a stopped queue's running drain raises no hook, `setKey()` resets the `signing-key` flag. Not tested: that `keyProviderTimeoutMs` reaches the queues (plain pass-through).

## proctor-key flow (PR fe/sdk-proctor-key; FR-601, FR-609, TC-063, TC-065, NFR-04)
Done: `ProctorKeyProvider` (`ensureKey`, `fetchKey`, `loadStoredKey`, `getKey` pull alias; only a `getToken()` callback; non-extractable CryptoKey in IndexedDB as `<sid>:hmacKey` with its epoch; single-flight; backoff with Retry-After; timeouts; KEY_ALREADY_ISSUED is final with `onKeyUnavailable`), `KeyStore` seam with `IdbKeyStore` (fake-indexeddb clones CryptoKey in the tests; a browser that cannot would fall back to a store adapter), `ProctorSession.start({ signingKey })`, `setKey(key, epoch?, counters?)`, static `ProctorSession.loadStoredKey(sessionId)` (epoch only), key purge at finish and at TAKEN_OVER / batch-route SESSION_NOT_ACTIVE, event and keystroke counters at max(local, server) before the first cut (`BatchQueue` option `initialSeq` and `seedSeq()`), heartbeat refreshes the retention mark so the sweep cannot remove a live session's key during a long outage. The caveat "resuming on a new device restarts at 0" is closed when the helper is used (the localStorage backup and the time seed remain a fallback; the server counter only raises). #385 leftovers: `ended` counts both queues (re-entrancy guard), purge-race tests, `signing-key` SUPPORTED only when neither queue is held, nits.

For Frontend B
- `apps/web/src/features/candidate-test/proctor/controller.ts` fetches `proctor-key` and seeds the counters itself (`seedCounters` there). Replace it with `ProctorKeyProvider.ensureKey(epoch)` and `session.start({ signingKey })`, call the helper inside a Web Lock after start and after each OTP resume, `pipeline.seedCounters(counters.media)`, `onKeyUnavailable('ALREADY_ISSUED')` runs the OTP resume. The SDK stores only the key; the token stays in the app.

Open
- The helper cannot know the token epoch (it never parses the token): the app passes it to `ensureKey(epoch)`; without it a stored key of an older epoch would be reused until KEY_EPOCH_STALE fixes it (the queue then asks the provider).
- Web Locks around the key call belong to the app (ADR 0013 section 2); the helper only single-flights within one page.
- Counters are applied once per key response; a hole is left where the server counter jumps ahead of a local unsent batch, and a local unsent batch below the server counter would collide (409 SEQ_CONFLICT, dropped and counted).
- Review round 1 of #389: the key is never written after a purge (`keyPurged` before the delete in `finish()` and TAKEN_OVER / SESSION_NOT_ACTIVE, a second delete after the queues closed, `ProctorKeyProvider.forget()` bumps a generation so in-flight requests store nothing, the session calls `keyProvider.forget()`, `keyStore` config option), only a non-extractable HMAC-SHA-256 sign key is accepted by `start`, `setKey`, the store and provider adoption, the fetch runs in the `cp-key:<sid>` Web Lock and reuses a key another tab stored, the time seed still applies when counters are unreadable, `idb: UNSUPPORTED` flag name per ADR, seeds are capped at 2^31 - 2, getToken() throwing is final.
- Not done: the Web Lock only covers the helper's fetch; the app's check-then-OTP-resume sequence needs the same lock name in the app (Frontend B). `keyProvider.sessionId` is compared only at start().

