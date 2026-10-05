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
