# Integrity configuration, false-positive risks and known bypasses

Lives in apps/worker until the architecture hub moves it to `/docs/integrity-config.md` (the worker
session may only edit `apps/worker`). Sections 5 and 6 are the seed of `/docs/red-team-report.md`.

Rule for every detector: it produces **evidence** (timestamp, duration, confidence, excerpt),
never a verdict. A human decides. All values are defaults; an organization overrides any of them
in `IntegrityConfig` (camelCase or snake_case keys, partial overrides allowed, unknown keys rejected).
Starting values; tune in the pilot (R-06).

## 1. Keystroke analytics (FR-802, TC-073) `keystrokes.*`

| Key | Default | Meaning |
| --- | --- | --- |
| burstMinChars | 80 | PASTE_BURST when MORE than this many chars are inserted... |
| burstWindowMs | 1000 | ...within this window (FR-802) |
| undoMemoryMs / undoMinChars | 120000 / 20 | Re-inserting text deleted within this memory (undo/redo) is not counted |
| regularityMinSamples | 40 | Intervals needed before a typing run is judged |
| regularityMaxCv | 0.12 | TYPING_ANOMALY `interval_cv_low` when std/mean of single-char intervals is below this |
| runGapMs | 1500 | A longer pause ends a typing run |
| speedMaxMedianIntervalMs | 40 | TYPING_ANOMALY `speed_outlier` when the median interval is below this (over 25 chars/s) |
| keyRepeatMinRun | 5 | Identical char repeated this many times: intervals inside it are ignored |
| maxTypingFindingsPerQuestion | 3 | Cap on typing findings per question |
| deletionRatioEnabled | false | Flag `deletion_ratio_low` (deleted/inserted <= deletionRatioMax=0.005, >= 500 chars). Ratio is always computed in stats |
| idleMs | 300000 | IDLE_THEN_COMPLETE: no editor event (cursor moves count) for this long... |
| completeMinChars / completeWindowMs | 200 / 30000 | ...then this many chars inserted within this window |

Confidence (0-1): PASTE_BURST 0.5 at the threshold rising to 1.0 at 4x. TYPING_ANOMALY
0.4-0.9 by how far below the limit. IDLE_THEN_COMPLETE 0.4-0.7, +0.2 if idle is over twice the limit.
Deletion ratio is fixed at 0.3.

Not counted as insertions: RESET events (reload restore, language switch), whitespace-only
reformatting (format document), re-insertion of text deleted in the last `undoMemoryMs`.

## 2. Code similarity (FR-803, TC-074) `similarity.*`

| Key | Default | Meaning |
| --- | --- | --- |
| k / window | 5 / 4 | Winnowing k-gram and window (guarantees any shared run of 8 tokens is found) |
| minTokens | 40 | Shorter normalized code is not compared |
| minFingerprints | 12 | Distinct fingerprints left after ignoring starter code and idioms; fewer means no comparison |
| peerThreshold | 0.80 | CODE_SIMILARITY (containment: shared fingerprints / smaller set) |
| aiThreshold | 0.85 | AI_LIKENESS against ai_reference_solutions (best row only) |
| commonFingerprintShare / commonMinCorpus | 0.5 / 5 | Fingerprints in over half of a corpus of >= 5 are idioms, ignored |
| maxPeerMatches | 3 | Peer findings per session |

MUST-FIX BEFORE PILOT: every starter k-gram is ignored, and identifiers normalize to ID, so generic code patterns in a large starter template are ignored too. With a large scaffold and one short fill-in, only about 48% of genuine copies are detected (measured; see docs/followups/integrity.md and tests/test_similarity_large_starter.py).

Starter code (if passed) is ignored. Findings carry `matchedLines` (inclusive line ranges, pairs of
start/end) in the candidate's own code. Confidence = similarity x a size factor (0.5 at minTokens
to 1.0 at 4x). Peer matches cite `matchedSessionId`, AI matches `aiReferenceSolutionId`, never both.

Known limit: an unterminated `/*` comment hides the rest of the file from similarity (it is read as one comment), so a candidate could evade comparison by adding one. Logged in docs/followups/integrity.md.

## 3. Voice activity (FR-607 server re-check, TC-061) `vad.*`

| Key | Default | Meaning |
| --- | --- | --- |
| speechThreshold | 0.5 | Silero probability to count a frame as speech |
| minSpeechMs / mergeGapMs | 250 / 500 | Drop shorter segments, merge gaps shorter than this |
| minEventMs | 2000 | SPEECH_DETECTED only for merged segments at least this long |
| speakerPitchRatio | 1.3 | Pitch groups must differ by this ratio for MULTIPLE_VOICES |
| speakerMinClusterMs / speakerMinVoicedMs | 3000 / 1000 | Speech needed in each pitch group / per segment |
| speakerMaxConfidence | 0.6 | Cap: pitch is weak speaker evidence |

Model: Silero VAD (MIT) via onnxruntime (`vad` extra), file pinned by SHA-256 (ADR 0001 section 12).
Tests use a fake backend; the real-model test is opt-in (`SILERO_VAD_MODEL_PATH`).

## 4. Risk score (FR-804, FR-805, ADR 0005) `risk.*`

`score = min(100, sum over types of min(count, cap) * points[severity] * weight[type])`.
Points LOW 2 / MEDIUM 8 / HIGH 20; cap 3 per type; weight 1.0 (0 for DISCONNECTED, RECONNECTED,
PROCTOR_PAUSE, PROCTOR_MESSAGE, PROCTOR_RESUME, SIDE_CAMERA_RECONNECTED, FULLSCREEN_RESTORED,
SCREEN_SHARE_RESUMED, IDENTITY_MANUAL_REVIEW, RESUME_OTP_FAILED). Bands: LOW 0-29, MEDIUM 30-59,
HIGH 60-100 (`mediumMinScore`, `highMinScore`). Overrides: `severityPoints`, `capPerType`,
`capOverrides`, `severityByType`, `weightByType`. TC-075: 2 HIGH + 3 MEDIUM = 64, HIGH.
Routing (FR-805): MEDIUM/HIGH, pending identity review or pending short-answer scoring -> review.
Severity is always taken from the type; a severity sent by a client is ignored.

Accommodations (FR-305): `disabledEventTypes` lists event types that are never produced by the
analyzers (the model or loop does not run) and never scored (dropped before counting).

## 5. False-positive risks (for the PM)

| Risk | Detector | Who is affected | Mitigation now | Residual |
| --- | --- | --- | --- | --- |
| IDE snippets, auto-complete, auto-close | PASTE_BURST | Everyone | 80-char threshold above typical snippets | A long snippet or template expansion over 80 chars is flagged; reviewer sees excerpt |
| Format document, undo/redo | PASTE_BURST | Everyone | Whitespace-equal replace and re-insertion of recently deleted text ignored | Undo after more than 2 minutes is flagged |
| Fixed-dwell input (switch, eye-gaze, AAC) | TYPING_ANOMALY | Candidates with motor disabilities | Per-candidate disable (FR-305) | Flagged by default until accommodated; HR must set it before the test |
| Speech-to-text, screen reader | Typing, bursts | Accessibility users | Chunked inserts are not single-char typing; bursts only if over 80 chars in 1 s | Dictating a whole paragraph at once may exceed 80 chars: accommodate |
| Held key, macros, text expanders | TYPING_ANOMALY, PASTE_BURST | Power users | Repeat stretches ignored; expanders look like paste | Expanders flagged, reviewer decides |
| Thinking, reading, paper work | IDLE_THEN_COMPLETE | Slow starters, planners | Needs 5 min idle AND 200 chars within 30 s; confidence at most 0.7 | A planner who writes a prepared answer quickly is flagged |
| Small or standard problems | CODE_SIMILARITY | Everyone | minTokens, starter code, common-idiom filter | Short canonical solutions in small corpora can still match |
| Prior public solutions (textbook algorithm) | CODE_SIMILARITY, AI_LIKENESS | Everyone | Threshold 0.8/0.85 | AI solutions resemble textbook ones, so AI_LIKENESS is MEDIUM and advisory |
| Family, TV, street noise | SPEECH_DETECTED | Home candidates | Segments under 2 s dropped | Long background speech is flagged; reviewer listens |
| Accent, tone, pitch | MULTIPLE_VOICES | Anyone | Pitch ratio is not accent-dependent but weak; capped at 0.6 | One person with strong intonation or a child/adult pair, see below |
| Poor lighting, glasses | Face detectors | Not in this worker | Browser detectors (FE) | See SDK notes |

The worker has no face-based detectors, so poor lighting and glasses do not affect these modules.

## 6. Known bypasses this code cannot detect (seed for red-team-report.md)

1. **Human-speed, jittered auto-typer.** A script typing under ~25 chars/s with a coefficient of
   variation above 0.12 passes both typing checks. Only IDLE_THEN_COMPLETE and similarity may catch it.
2. **Paste in small pieces.** Inserting under 80 chars per second (for example 60 chars every 900 ms
   through an external tool) evades PASTE_BURST. Mitigation: lower `burstMinChars`, accept more noise.
3. **Retyping from a second device.** Typing rhythm looks human. Only similarity and the webcam/side
   camera can catch it.
4. **Paraphrased AI answers.** Restructured code (different algorithm, loops vs comprehension) is not
   matched by token fingerprints. Winnowing is robust to renaming and reordering, not to rewriting.
5. **Peer collusion with rewrites** and sharing through memorized solutions.
6. **Same-pitch accomplices.** The pitch heuristic cannot separate two similar voices; whispering
   and typed or silent communication are invisible to audio.
7. **Audio from a muted or blocked microphone** yields no evidence; the browser reports
   DETECTOR_UNAVAILABLE only if it detects the block.
8. **Untrusted client clock.** Keystroke timing comes from the client; a forged `t` can fake
   rhythm. The signed batch (ARC-03) prevents tampering in transit, not by the page itself.
9. **Offsets beyond the BMP.** The SDK reports UTF-16 offsets; the worker replays with Python code
   points, so text with emoji or astral characters can desynchronize replay-based checks (not the
   counts). Logged in docs/followups/integrity.md.

## 7. Face matching (FR-403, TC-033; ADR 0004, D-05) `face.*`

Code: `src/worker/face/`. Interface (ADR 0004 section 2): `detect_and_align(image)`, `embed(aligned)`,
`compare(a, b)`, `model_id`. Detector (MediaPipe Face Landmarker, Apache 2.0) and embedder (AuraFace
`glintr100.onnx` only, F-1) are swappable; tests use fakes. Output is MATCH or MANUAL_REVIEW with a
reason from `identity_review_reason`. **There is no reject outcome**: no face, multiple faces, low
detection confidence, bad/oversized/corrupt image, model error, hash mismatch, failed liveness and
score below threshold are all MANUAL_REVIEW.

| Key | Default | Meaning |
| --- | --- | --- |
| matchThreshold | **0.75 (PLACEHOLDER, NOT TUNED)** | Cosine at or above is MATCH. Valid range 0.30-1.0. Waits for INT-01 tuning on the diverse test set (ADR 0004 section 2, D-18). Deliberately high so doubt goes to a human. ADR 0004 calls the threshold system configuration, not an org setting: the API should pass it from system config, not `organizations.settings`. |
| minDetectionConfidence | 0.7 | Reported detector confidence below this is treated as no usable face (NO_FACE). The MediaPipe landmarker reports none, so it only applies to other detectors |
| maxImageBytes / maxImagePixels | 10 MiB / 25,000,000 | Larger images are MANUAL_REVIEW (MATCH_ERROR, IMAGE_SIZE); decompression-bomb guard |
| selfieCacheMaxSessions | 256 | Bounded LRU of selfie embeddings for FR-606 re-checks; cleared at session end; ID embeddings are never kept |

Model files (never committed, never downloaded by code; download needs owner approval P-07):
`AURAFACE_MODEL_PATH` -> `glintr100.onnx`, SHA-256 `a7933ea5330113b01c9b60351d8f4c33003f145d8470ac5f0e52ee2effe25c60`
(ADR 0001 section 12.2); any other file name or digest is refused. `FACE_LANDMARKER_MODEL_PATH` ->
`face_landmarker.task` (SHA-256 `64184e22...` in ADR 0001 section 12.2). `model_id` = `auraface-v1:a7933ea5`.
Optional extra: `pip install -e '.[face]'` (mediapipe, onnxruntime, pillow).

Privacy: embeddings, aligned crops and the selfie cache have redacted repr/str, cannot be pickled or
copied, are never logged, and nothing is written to disk (tests). Logs carry fixed codes only.

False negatives (a genuine candidate sent to review): poor lighting, glasses glare, head pose,
low-resolution or old ID photos, heavy ID security patterns over the face, webcam blur, and groups
the model covers less well (AuraFace card, F-6). False positives (a wrong person matched): look-alikes
and family members; a threshold that is too low. Manual review and the pilot-exit review of false
match and false non-match rates (ADR 0004) are the safeguards; no automatic rejection exists.
An ID card held up to a webcam is small for the BlazeFace short-range model (ADR 0001 12.2 notes).
