# ADR 0010: Shared contracts v0 (events, keystrokes, permission matrix)

| Field | Value |
| --- | --- |
| Status | Accepted 2026-10-05 by the owner, with the changes recorded in §1, §3 and §6. |
| Author | architect |
| Serves | FR-103, FR-501, FR-601..FR-610, FR-608, FR-801, FR-802, FR-804, FR-903; NFR-04, NFR-05, NFR-08; TC-004, TC-053, TC-055, TC-062, TC-063, TC-065, TC-075, TC-097 |
| Builds on | ADR 0001 (TB-1, C-2), ADR 0005 (taxonomy, defaults, replay), ADR 0007 §8 |
| Leaves to | ARC-03: canonical JSON, HMAC transport and key lifecycle, evidence key layout, and how system-check events (MULTI_MONITOR, before the HMAC key is issued) are signed. Rest of ARC-02: API contract v0 (paths, drafts, RunResult, error envelope). |

## Context

BE-03, BE-10, FE-06/07 and the integrity worker need one typed source for event types, batch shapes and permissions (ADR 0001: packages/shared is the single source). The docs fix the enum values (database.md), the event fields (backend.md Step 10) and the defaults (ADR 0005). They do not say which types a browser may send, what each payload holds, or how editor events are encoded.

## Options

1. **Typed per-type payloads, client/server split, edit-delta keystrokes (chosen).** A zod discriminated union over the client types only; each type has a bounded payload schema; keystrokes are editor model changes.
2. **One generic event with `payload: Record<string, unknown>`.** Less code, but no bounds per type, and a client could post server-only types such as RESUME_OTP_FAILED or PASTE_BURST.
3. **Raw keydown/keyup capture for keystrokes.** Richer typing dynamics, but it records keys outside the code (shortcuts, modifiers) and cannot replay Monaco edits exactly (TC-062).

## Decision

1. **Sources.** `CLIENT_EVENT_TYPES` (27) are the only types a signed batch accepts. Server-only: DISCONNECTED, RECONNECTED (heartbeat watchdog, FR-609), PASTE_BURST, TYPING_ANOMALY, IDLE_THEN_COMPLETE, CODE_SIMILARITY, AI_LIKENESS (worker), PROCTOR_PAUSE/MESSAGE/RESUME, IDENTITY_MANUAL_REVIEW, RESUME_OTP_FAILED. SPEECH_DETECTED, MULTIPLE_VOICES and SIDE_CAMERA_DISCONNECTED are both. Why SPEECH_DETECTED and MULTIPLE_VOICES are also server-written: FSD M7/M8 and backend.md Step 12 specify a server-side audio check, where the worker runs voice activity detection on the recorded audio and emits these events with source SERVER. The browser detector emits them with source CLIENT; both are valid.
2. **Envelope.** `{ type, occurredAt (UTC ISO), durationMs?, confidence? 0-1, evidenceKey?, payload }`, per backend.md Step 10. No session id (from the token), no severity (server assigns; unknown keys are stripped, so a client severity is ignored). No per-event id: idempotency is per batch `seq` (ADR 0005 §3). Batch: `{ seq: int 0..2^31-1, events: 1..100 }`. The signature is added by ARC-03.
3. **Keystrokes.** Batch `{ seq, sessionQuestionId, startedAt, events: 1..1000 }`; events are `RESET` (whole model set: load, restore, reset, language switch), `EDIT` (offset, deleteLength, text) and `CURSOR` (offset, selectionLength). `t` is ms from `startedAt`, non-decreasing. Inserted text from EDIT events is capped per batch at `MAX_SOURCE_CODE_LENGTH`. RESET is excluded from that cap and has its own limit of `MAX_SOURCE_CODE_LENGTH` (100,000 characters) per event, so a restore followed by typing fits in one batch. Total text across RESET and EDIT in one batch is capped at `MAX_KEYSTROKE_BATCH_TOTAL_TEXT` (200,000), so the schema bounds itself. BE-10 must also enforce `MAX_KEYSTROKE_BATCH_BODY_BYTES` (2 MiB) on the route before the HMAC check and parsing (413 path tested), and the SDK splits batches to stay under it. Replay orders batches by `seq`, not arrival time (NFR-08). No key codes or modifiers (NFR-05).
4. **Payload privacy.** Payloads never carry clipboard content (only a length), OTPs or typed keys.
5. **Defaults.** ADR 0005 §2 severities, weights, points and cap, the FR-804 band function and the forced-live list are exported constants.
6. **Permissions.** `resource:action` strings for every fsd.md §4 action plus `ai_reference:*`, `user:manage` and `org_settings:manage`; roles from `user_role` plus CANDIDATE and SERVICE pseudo-roles; deny by default. This is a skeleton: BE-03 adds the route map and refines the role mapping. SUPER_ADMIN keeps review, verdict and live permissions (owner decision). FR-904 is enforced by person, not role: the appeal reviewer must be a different user from the reviewer who set the original verdict. BE-13 (and whichever step implements appeals) must check this on the user id. **Amendment 2026-10-06 (proposed; the owner accepts it when merging this change, CLAUDE.md rule 7):** the CANDIDATE role gains `candidate_session:read` (GET /candidate/session), `candidate_session:start` (POST /candidate/session/test/start, the authenticated test start, not the public OTP exchange), `candidate_session:heartbeat` (POST /candidate/session/heartbeat, FR-609) and `candidate_session:key` (POST /candidate/session/proctor-key, ADR 0013). No staff role holds them. The three pre-token routes (link resolve, OTP send, OTP verify) stay public, not permissions. Still not in the matrix, left to later steps and the same amendment route: appeals (FR-904), reports and webhooks, `account:self`, and the other candidate routes in ADR 0013 (system-check, media confirm, evidence presign, identity read and re-check, accommodations, side camera, practice, draft, section finish).
7. **Languages.** `CODE_LANGUAGES` is the single list; `codeLanguageSchema` and `AI_REFERENCE_LANGUAGES` derive from it.

## Consequences

- A parity test fails if the shared enums drift from prisma/schema.prisma.
- Payload shapes are v0. Changing one is a contract change: update this ADR and tell the affected agents.
- **integrity-engineer (BE-10, BE-12):** validate with `proctorEventBatchSchema` and `keystrokeBatchSchema` on the parsed body after the HMAC check on the raw body; store the parsed output; assign severity with `DEFAULT_EVENT_SEVERITY` plus org overrides; use `parseEventPayload` for server events.
- **proctor-sdk-engineer (FE-06, FE-07, FE-08):** emit only `ClientProctorEvent`; send editor changes as RESET/EDIT/CURSOR.
- **backend-engineer (BE-03, BE-04, BE-13):** BE-03 refines `ROLE_PERMISSIONS` and adds the route map; BE-04 uses `AI_REFERENCE_LANGUAGES`; BE-13 uses `shouldPushToLive`.
- **frontend-engineer (FE-01, FE-03, FE-11):** hide UI with `hasPermission`; the replay panel applies RESET/EDIT in order.
