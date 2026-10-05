# Integrity follow-ups

Non-blocking findings. Only blockers stop a merge.

## Analysis worker (branch integrity/worker-analysis)

### Needs a decision or a change outside apps/worker
1. **Doc location.** The role brief wants `/docs/integrity-config.md` and `/docs/red-team-report.md`; the worker session may only edit `apps/worker`. Both are seeded in `apps/worker/INTEGRITY-CONFIG.md` (sections 1-4 config, 5 false positives, 6 known bypasses). Architecture hub: move or split.
2. **Accommodation keys.** `PROCTOR_DETECTORS` in events.ts has only browser detectors. The worker disables analyzers by event type (`disabledEventTypes`: PASTE_BURST, TYPING_ANOMALY, IDLE_THEN_COMPLETE, CODE_SIMILARITY, AI_LIKENESS, SPEECH_DETECTED, MULTIPLE_VOICES). FR-305 / BE-06 must map candidate accommodations onto event types; confirm.
3. **OrgSettings shape.** ADR 0007 section 6 says `OrgSettings` lives in packages/shared but it is not there yet. `IntegrityConfig` accepts camelCase or snake_case; BE-12 must adapt `organizations.settings.risk` and `.integrity` into it.
4. **Payload extras.** `matchedLines` (CODE_SIMILARITY, AI_LIKENESS) and `Finding.details` (interval stats, pitch ratio) are not in the zod payload schemas, which strip unknown keys. If reviewers should see them, extend events.ts (ARC-02) or store them in `evidence`.
5. **TYPING_ANOMALY metric** is a free label (`interval_cv_low`, `speed_outlier`, `deletion_ratio_low`, joined by `+`); an enum in events.ts would be safer (also noted for architecture follow-ups).
6. **UTF-16 offsets.** keystroke.ts offsets are UTF-16 code units; the worker replays on Python code points. Differs only for astral characters; a UTF-16 aware replay is needed if TC-062 must hold for emoji.
7. **Python CI.** No CI job runs ruff, mypy or pytest for apps/worker, and `apps/worker/package.json` only compiles. Add a job (CI config is hub-owned).

### Should-fix inside the worker
- Peer comparison is O(n^2) over a question's submissions; fine for pilot sizes. Add an inverted index on fingerprint hashes before any corpus over a few thousand.
- Silero ONNX backend input names (`input`, `state`, `sr`, 64-sample context) follow the v5 interface and are untested against the real v6.2.3 file; run the opt-in test with `SILERO_VAD_MODEL_PATH` before BE-12.
- Audio chunk download, decoding and resampling to 16 kHz are not built (BE-12).
- `app.py` has no request size limit beyond field caps; put a body limit at the proxy.
- Starlette TestClient emits a deprecation warning about httpx.

# Follow-ups: Integrity track

## From ARC-02 review of PR #16 (code-reviewer)

- **[BE-12 / worker, FR-802] RESET can bypass paste-burst detection.** A client can send a RESET whose text is a finished solution ("restore after reload") and typing-speed or paste-burst analytics will not see it. The worker or API should compare RESET text with server-known state (starter code or the last saved draft) and, on a mismatch, emit evidence (PASTE_BURST or a new signal), never a verdict automatically.

### Code-reviewer findings on PR #20 (should-fix and nits; the blocker and the regex fix are in the PR)
- Peer compare: precompute fingerprints once and use an inverted index (O(n^2) today); routes are synchronous and block the event loop on large corpora.
- Mirror drift from keystroke.ts: `MAX_KEYSTROKE_BATCH_TEXT` total-text check is missing, `sessionQuestionId` should be a UUID, `startedAt` should be timezone-aware (AwareDatetime). Extend `test_contracts.py` accordingly.
- `app.py` input limits: cap total request size, per-field code lengths on keystroke text, and number of events in `/risk`.
- `sample_rate` and `frame_samples` are org-overridable in `VadConfig` but the Silero backend needs 16000/512; make them constants or validate.
- `X-Internal-Token` / `WORKER_INTERNAL_TOKEN` is provisional pending the architect decision on API-to-worker auth (ADR 0001 TB-6, OI-1, Q-21). Document the env var in the deploy env template once decided.
- Nits: `/risk` response drops the breakdown; `/docs` and `/openapi.json` are open; 422 responses echo input (candidate code); camelCase vs snake_case in route bodies; peer cap is applied one-sided; `deleted_chars` stat counts replaced text; `speaker_min_voiced_ms // 4` is a magic number; `test_contracts.py` has a hard-coded language set and a module-wide skipif that could hide drift.
- Re-review nits: `compare` confidence `size_factor` uses raw token counts including starter code (should use non-ignored size). A stray unterminated `/*` hides the rest of the file from similarity, which a candidate could use to evade; consider falling back to line-based comment stripping.
