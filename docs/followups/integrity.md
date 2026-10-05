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
