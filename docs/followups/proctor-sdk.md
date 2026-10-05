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
