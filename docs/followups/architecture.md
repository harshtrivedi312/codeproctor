# Architecture follow-ups

Non-blocking review findings. Only blockers stop a merge.

## ARC-02 part 1 (PR #6, code-reviewer verdict: MERGE, no code blockers)

### Should-fix
1. `packages/shared/src/events.ts` CODE_SIMILARITY: require exactly one of `matchedSessionId` / `aiReferenceSolutionId` (FR-803, ADR 0005 AI-1), with a test.
2. SPEECH_DETECTED and MULTIPLE_VOICES are listed as server-writable, but no doc supports a server-side audio re-check. Back with an FR/ADR reference or drop from `SERVER_EVENT_TYPES`.
3. `keystroke.ts`: RESET text counts toward the per-batch text cap, so a large RESET plus an insert is rejected. Exclude RESET from the cap, or state in ADR 0010 that the SDK starts a new batch after a large RESET; add a test (TC-062).
4. Test names missing FR/TC IDs: `events.test.ts` (3 tests), `keystroke.test.ts` (2), `permissions.test.ts` (1). `events.test.ts` misuses TC-065 (HMAC mismatch); use FR-801 or NFR-04.
5. SUPER_ADMIN currently holds review, verdict and live pause/message permissions. Record the question in ADR 0010 for BE-03; FR-904 requires appeals go to a different reviewer.
6. ADR 0010 is Proposed; the human must accept it.

### Nits
- Unknown keys are stripped, so stored events differ from the signed raw body; document in the ADR or use strict objects.
- `EXTENSION_INTERFERENCE.signal` should be an enum; treat `deviceLabel` as untrusted text in the review UI.
- `hasPermission`: the `granted !== undefined` check is unreachable; accept a `string` principal or drop it.
- List missing permissions (candidate heartbeat FR-609, appeals FR-904, reports, webhooks) in ADR "Leaves to".
- ADR 0010 §3: replay orders keystroke batches by `seq`, not arrival (NFR-08).
- `matchedSessionId` may point to an erased session; review UI must handle 404.
- Missing tests: SHORTCUT_BLOCKED regex, evidence key with leading `/` or `//`, DETECTOR_UNAVAILABLE payload, client-sent `sessionId` stripped.

### Open for ARC-02 remainder / ARC-03
`sessions.device_info.capabilities` shape, API paths (fsd.md §4 vs placeholder OpenAPI), HMAC transport and canonical JSON, evidence key layout, signing of pre-start events (MULTI_MONITOR during system check).
