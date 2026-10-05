# Integrity follow-ups

Non-blocking findings. Only blockers stop a merge.

## Analysis worker (PRs #20, #27)

### Needs a decision or a change outside apps/worker
1. **Doc location.** The role brief wants `/docs/integrity-config.md` and `/docs/red-team-report.md`; the worker session may only edit `apps/worker`. Both are seeded in `apps/worker/INTEGRITY-CONFIG.md` (sections 1-4 config, 5 false positives, 6 known bypasses). Architecture hub: move or split.
2. **Accommodation keys.** `PROCTOR_DETECTORS` in events.ts has only browser detectors. The worker disables analyzers by event type (`disabledEventTypes`: PASTE_BURST, TYPING_ANOMALY, IDLE_THEN_COMPLETE, CODE_SIMILARITY, AI_LIKENESS, SPEECH_DETECTED, MULTIPLE_VOICES). FR-305 / BE-06 must map candidate accommodations onto event types; confirm.
3. **OrgSettings shape.** ADR 0007 section 6 says `OrgSettings` lives in packages/shared but it is not there yet. `IntegrityConfig` accepts camelCase or snake_case; BE-12 must adapt `organizations.settings.risk` and `.integrity` into it.
4. **Payload extras.** `matchedLines` (CODE_SIMILARITY, AI_LIKENESS) and `Finding.details` (interval stats, pitch ratio) are not in the zod payload schemas, which strip unknown keys. If reviewers should see them, extend events.ts (ARC-02) or store them in `evidence`.
5. **TYPING_ANOMALY metric** is a free label (`interval_cv_low`, `speed_outlier`, `deletion_ratio_low`, joined by `+`); an enum in events.ts would be safer (also noted for architecture follow-ups).
6. **UTF-16 offsets.** keystroke.ts offsets are UTF-16 code units; the worker replays on Python code points. Differs only for astral characters; a UTF-16 aware replay is needed if TC-062 must hold for emoji.
7. **Python CI.** No CI job runs ruff, mypy or pytest for apps/worker, and `apps/worker/package.json` only compiles. Add a job (CI config is hub-owned).

### Should-fix inside the worker
- **Peer comparison scale (NFR-01/02).** O(n^2) over a question's submissions (about 1.2 s for 150 and 4.5 s for 300 large submissions). Precompute fingerprints once and add an inverted index on fingerprint hashes before any corpus over a few thousand; the routes are synchronous and block the event loop on large corpora. (AI references and the starter ignore set are already prepared once per request.)
- **Silero ONNX backend** input names (`input`, `state`, `sr`, 64-sample context) follow the v5 interface and are untested against the real v6.2.3 file; run the opt-in test with `SILERO_VAD_MODEL_PATH` before BE-12.
- Audio chunk download, decoding and resampling to 16 kHz are not built (BE-12).
- **Mirror drift from keystroke.ts.** `sessionQuestionId` should be validated as a UUID and `startedAt` should be timezone-aware (AwareDatetime); the batch text caps are already mirrored. Extend `test_contracts.py` accordingly.
- **`app.py` input limits.** Cap total request size (put a body limit at the proxy), per-field code lengths on keystroke text, and the number of events in `/risk`.
- `sample_rate` and `frame_samples` are org-overridable in `VadConfig` but the Silero backend needs 16000/512; make them constants or validate.
- `X-Internal-Token` / `WORKER_INTERNAL_TOKEN` is provisional pending the architect decision on API-to-worker auth (ADR 0001 TB-6, OI-1, Q-21). Document the env var in the deploy env template once decided.
- `compare` confidence `size_factor` uses raw token counts including starter code (should use non-ignored size).
- A stray unterminated `/*` hides the rest of the file from similarity, which a candidate could use to evade; consider falling back to line-based comment stripping.
- `prepare_ai_context` builds starter ignore sets for every language passed, not only those present in the references; the route could limit them. A `ParamSpec` wrapper for the call-counting monkeypatches in `test_app.py` would remove the `type: ignore`.
- Starlette TestClient emits a deprecation warning about httpx.
- Nits: `/risk` response drops the breakdown; `/docs` and `/openapi.json` are open; 422 responses echo input (candidate code); camelCase vs snake_case in route bodies; peer cap is applied one-sided; `deleted_chars` stat counts replaced text; `speaker_min_voiced_ms // 4` is a magic number; `test_contracts.py` has a hard-coded language set and a module-wide skipif that could hide drift.

### MUST-FIX BEFORE PILOT: recall on questions with a large starter template (FR-803)
Ignoring every starter k-gram (with identifiers normalized to ID) also ignores generic code patterns that occur in a large scaffold, and the `minFingerprints` gate then skips comparison when the candidate wrote little. Measured on synthetic data (`tests/test_similarity_large_starter.py`, 60 seeded pairs per row, scaffold about 780 tokens, 3 TODO sites; copies are light renaming/reformatting, independents use different fill-ins from the same statement pool):

| candidate-written code | peer recall | peer FP | AI recall | AI FP |
| --- | --- | --- | --- | --- |
| 3 sites x 2 statements | 100% | 0% | 100% | 0% |
| 3 sites x 1 statement | 98% | 0% | 98% | 0% |
| 1 site x 2 statements | 97% | 2% | 97% | 2% |
| 1 site x 1 statement | 48% | 3% | 48% | 0% |

With a single short fill-in, MORE THAN HALF of genuine copies are missed. Not a bug in the current design (the gate is deliberate to avoid false alarms from the scaffold), but unacceptable recall for questions with large templates. Options to decide before the pilot: compare the candidate's diff against the starter (token-level diff, then fingerprint only the changed regions with a lower k), lower `minFingerprints`/`k` for the changed region, or require authors to keep starter code small. Floors in the test sit about one pair under the measured values; do not loosen them. Proposal for the hub: `docs/followups/integrity-starter-diff-proposal.md` (diff each submission against the starter and fingerprint only the changed regions).

### Other nits folded in
- Per-request preparation (NFR-01/02): done in PR #32 (starter ignore set and AI references are prepared once per request).

## Face-match worker module (branch integrity/face-match-worker)
- **INT-01 tuning.** `face.matchThreshold` 0.75 is a placeholder; tune on the diverse test set before any real candidate is face-matched (ADR 0004, D-18). Record per-group false match / false non-match for the pilot-exit review.
- **Real-model checks are manual.** `AURAFACE_MODEL_PATH` test is skipped by default (P-07 parked). The MediaPipe adapter logic (index mapping, locking, file verification) is unit-tested with a fake landmarker factory; only `_mediapipe_factory` (the real library call) is untested; the `mediapipe==0.10.21` pin was not installed or verified here. Run both once models are approved; check the landmark indices (33/133, 362/263, 1, 61/291) and the AuraFace input name/shape against the real file.
- **Landmarker reports no per-face score**, so `minDetectionConfidence` does not apply to it; consider the full Face Detector alongside, or accept this (ADR 0001 12.2 notes on card-sized faces).
- **Alignment is numpy**, not OpenCV (ADR 0001 lists OpenCV for the warp). Correct and tested, but slower than cv2; swap if profiling needs it.
- **Pillow limits are global** (`Image.MAX_IMAGE_PIXELS` is set per call); fine for a single-config worker, revisit with concurrent differing configs.
- **ARC-04** owns the API-to-worker contract and auth; no route was added (app.py untouched). The integration should call `FaceMatcher.match` / `recheck` / `end_session` and handle `ModelLoadError` via `review_for_model_error`.
- **Threshold ownership is decided by ADR 0004 section 2 / ADR 0007:** system configuration, not an org setting. `FaceConfig` is outside `IntegrityConfig` and loads from `FACE_*` env; the API must not pass an org value.
- **F-1 deploy check (N9).** Add a deploy-time check that the worker image contains no ONNX files other than `glintr100.onnx` (and `silero_vad.onnx`), so no InsightFace model (scrfd, 2d106det, 1k3d68, genderage) can be loaded by accident. `.gitignore` now blocks `*.onnx`, `*.task`, `*.tflite` in apps/worker.
- **Landmark size proxy.** The ID ghost-portrait rule uses the landmark bounding-box extent as face size; replace with the detector box if the detector exposes one.

## From ARC-02 review of PR #16 (code-reviewer)

- **[BE-12 / worker, FR-802] RESET can bypass paste-burst detection.** A client can send a RESET whose text is a finished solution ("restore after reload") and typing-speed or paste-burst analytics will not see it. The worker or API should compare RESET text with server-known state (starter code or the last saved draft) and, on a mismatch, emit evidence (PASTE_BURST or a new signal), never a verdict automatically.

## From ARC-02 review of PR #19 (code-reviewer)

- **[BE-10, security, must do in BE-10] Body limit on POST /candidate/session/keystrokes.** Set a per-route limit of `MAX_KEYSTROKE_BATCH_BODY_BYTES` (2 MiB; the NestJS/Express default of 100 KB would reject valid large batches). Apply it before the HMAC check and before parsing, measure the decompressed size (backend.md Step 10 allows HTTP compression; a zip bomb must not get past it), and add a test for the 413 response. Same for the events route (`MAX_EVENT_BATCH_BODY_BYTES`).

## Review routing after C-28 (branch integrity/risk-human-review)
- **BE-12 / BE-13 must consume the new fields.** `route_for_review` and `POST /risk` now return `needs_review` (always true), `review_path` (`fast` or `full`), `queue_rank` and `review_reasons`; the review queue should sort with `order_review_queue` semantics (band rank, score desc, older first, session id). GRADED always goes to UNDER_REVIEW; the API must not branch on `needs_review` being false.
- **Assumption to confirm (hub):** pending identity review or manual short-answer scoring forces the `full` path (the docs only say "fast path for LOW band"). Open owner decision: should MEDIUM ever be allowed on the fast path, and should `fastReviewBands` be org-overridable or system-only? (Validation allows only `LOW` or empty until then.) Also and whether LOW sessions with a pending hold should rank above plain LOW in the queue (today the queue rank is band-based only).
- **Docs that still describe auto-clear (flag for the hub; not edited here):** `docs/fsd.md` FR-805 and the state machine (§3), `docs/adr/0002-session-lifecycle-and-invitation-expiry.md` (GRADED to UNDER_REVIEW only for MEDIUM/HIGH, and COMPLETED for LOW), `docs/adr/0001-overall-architecture.md` F6 ("UNDER_REVIEW (MEDIUM or HIGH) or COMPLETED"), `docs/requirements-trace.md` FR-805, `docs/test-matrix.md` TC-076 row ("LOW does not" route to review), and `docs/compliance/decisions.md`: C-14's note about LOW auto-clear and the OQ-8 row, whose "Answered by C-28" cell still reads "Keep auto-clear for LOW, and disclose it".
- `packages/shared` has no routing mirror today, so no change was needed there; if the API contract exposes `reviewPath` or `queueRank` later, mirror them in events.ts or a new schema (ARC).
- **Non-finite scores.** `calculate_risk` only sums finite configured points, so a NaN or inf score cannot occur today; if weights or points ever come from untrusted input, `risk_band_for_score` and `queue_sort_key` (which negates the score) would misbehave on NaN. Config validation should reject non-finite weights and points (currently `ge=0.0` still admits `inf`).
