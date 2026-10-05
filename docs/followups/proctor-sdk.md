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
