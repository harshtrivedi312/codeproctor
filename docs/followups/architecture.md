# Architecture follow-ups

Non-blocking review findings. Only blockers stop a merge.

## ARC-02 part 1 (PR #6, code-reviewer verdict: MERGE, no code blockers)

### Should-fix
1. `packages/shared/src/events.ts` CODE_SIMILARITY: require exactly one of `matchedSessionId` / `aiReferenceSolutionId` (FR-803, ADR 0005 AI-1), with a test.
2. ~~SPEECH_DETECTED / MULTIPLE_VOICES server source~~ Resolved in ADR 0010 (owner decision: FSD M7/M8, backend.md Step 12).
3. ~~RESET and the batch text cap~~ Resolved: RESET has its own 100,000-char limit (ADR 0010 §3); batch total capped at 200,000 chars; BE-10 enforces the 2 MiB body limit.
4. Test names missing FR/TC IDs: `events.test.ts` (3 tests), `keystroke.test.ts` (2), `permissions.test.ts` (1). `events.test.ts` misuses TC-065 (HMAC mismatch); use FR-801 or NFR-04.
5. ~~SUPER_ADMIN~~ Resolved: keeps review/verdict/live; FR-904 enforced by person (appeal reviewer is a different user). BE-13 implements.
6. ~~ADR 0010 acceptance~~ Accepted 2026-10-05.

### Nits
- Unknown keys are stripped, so stored events differ from the signed raw body; document in the ADR or use strict objects.
- `EXTENSION_INTERFERENCE.signal` should be an enum; treat `deviceLabel` as untrusted text in the review UI.
- `hasPermission`: the `granted !== undefined` check is unreachable; accept a `string` principal or drop it.
- List missing permissions (candidate heartbeat FR-609, appeals FR-904, reports, webhooks) in ADR "Leaves to".
- ~~ADR 0010 §3: replay orders keystroke batches by `seq`, not arrival (NFR-08).~~ Resolved in ADR 0010 §3.
- `matchedSessionId` may point to an erased session; review UI must handle 404.
- Missing tests: SHORTCUT_BLOCKED regex, evidence key with leading `/` or `//`, DETECTOR_UNAVAILABLE payload, client-sent `sessionId` stripped.

### Open for ARC-02 remainder / ARC-03
`sessions.device_info.capabilities` shape, API paths (fsd.md §4 vs placeholder OpenAPI), HMAC transport and canonical JSON, evidence key layout, signing of pre-start events (MULTI_MONITOR during system check).

## frontend/step-1 architect review of shared contracts (moved from docs/followups.md)

Verdict: approve after the blocker fixes below. Fixed on this branch: `RunRequest.code` and `DraftRequest.code` now carry `maxLength: 100000` in `apps/web/openapi/openapi.yaml`, matching the new `MAX_SOURCE_CODE_LENGTH` in `packages/shared/src/code-run.ts`; `loginRequestSchema` now caps email at 254 and password at 1024 characters (`MAX_EMAIL_LENGTH`, `MAX_PASSWORD_LENGTH`) so an anonymous caller cannot send an unbounded string to Argon2id (FR-101, NFR-04). Tests added in `apps/web/src/lib/forms.test.ts`. The items below are for ARC-02 (shared + API contract v0) and do not block this merge.

- **[ARC-02] Placeholder paths disagree with fsd.md §4.** The YAML uses `/v1/...` with server `http://localhost:4000`; fsd.md §4 says `/api/v1`. Run is `/candidate/questions/{id}/run` in the YAML but `/candidate/answers/:questionId/run` in fsd.md. `GET /candidate/session`, `PUT .../draft`, `GET /time` and `POST /candidate/sections/{id}/finish` are not in the fsd.md table, although ADR 0002 S-1/S-5 needs section finish and draft calls. ARC-02 must decide the final paths and add the missing rows to fsd.md §4 (or /docs/api-contract.md per ADR 0001 C-8); FE-01 then renames the mocks. Safe now only because the file is labelled placeholder and nothing on the backend reads it.
- **[ARC-02] Language list exists twice.** `codeLanguageSchema` (shared) and `components.schemas.Language` (YAML) both list python, javascript, java. ADR 0005 also names `AI_REFERENCE_LANGUAGES` with the same values. Make one shared constant the source (for example `CODE_LANGUAGES`, with `AI_REFERENCE_LANGUAGES` derived or equal), and either generate the YAML enum from it or add a parity test that loads the YAML and compares. Once NestJS publishes its code-first spec this disappears. *Partly done (ADR 0010):* `CODE_LANGUAGES` is now the single shared list and `codeLanguageSchema` and `AI_REFERENCE_LANGUAGES` derive from it; the YAML parity check is still open (FE-01 or the rest of ARC-02).
- **[ARC-02] `MAX_SOURCE_CODE_LENGTH = 100_000` is a new limit not yet in any doc.** Record it (with the submit and draft bodies, and `session_questions.final_code`) in the API contract, and note that zod `.max` counts UTF-16 code units while OpenAPI `maxLength` counts characters; non-BMP characters make the two differ slightly. The backend must also set a JSON body size limit consistent with it.
- **[ARC-02] `DraftRequest` has no shared zod schema** and is not a discriminated union: `kind: code` does not require `language`/`code`, `kind: mcq` does not require `selectedOptionId`. ADR 0007 makes `answer_spec` a discriminated union by question type; the draft and answer bodies should follow it (and cover short-answer, which the `kind` enum omits).
- **[ARC-02] `RunResult.outcome` is narrower than Judge0.** Missing at least memory-limit-exceeded and an internal/system error value (FR-503, TC-042..TC-044). Add them before BE wires Judge0, and move `RunResult` into packages/shared as zod.
- **[ARC-02] 429 shape.** The rate-limit response carries `retryAfterSeconds` in the body only; also send the standard `Retry-After` header and define one shared error envelope for 4xx (409 for out-of-section calls per ADR 0002 S-5 is not described).
- **[ARC-02] No security schemes in the YAML.** Candidate routes use the session token and staff routes the access token (ADR 0003); declare both so the generated client and docs show which routes need which.
- **[BE-02] `otpCodeSchema` is six digits only.** `/auth/2fa/verify` must also accept a recovery code (ADR 0003 §1), so BE-02 needs a separate `recoveryCodeSchema` or a union; do not reuse `otpCodeSchema` as the whole 2FA body.
- **[BE-02] Password reset schema must use `MAX_PASSWORD_LENGTH`** as its upper bound so a password that can be set can always be used to log in.
- **Nit:** `z.string().email()` is deprecated in zod 4 in favour of `z.email()`; switch when the auth schemas grow.
- **Nit:** `pnpm --filter @codeproctor/web gen:api` writes unformatted output while the committed `schema.d.ts` is prettier-formatted (and the file is in `.prettierignore`), so every regeneration shows a whole-file diff. Either append a prettier step to `gen:api` or commit the raw output.
- **Nit:** `packages/shared` resolves to `dist/` for `tsc` but to `src/` for vitest; a new export can pass tests and fail typecheck until `shared` is rebuilt. Consider `exports` with a source condition or TS project references in ARC-02.

## Pointer

The [ARC-02] items under "frontend/step-2" in docs/followups/frontend.md (staff auth schemas, endpoints, 2FA challenge, password policy, fragment tokens) are architecture-hub work and are tracked there.

## Compliance amendments to ADR 0004 and ADR 0001 (C-04, C-06, C-10, C-17, C-18; branch arc/compliance-adr-amendments)

Proposed; the owner accepts. Apply these once the ADR 0004 §9 and ADR 0001 §12.4 amendments are accepted. Full list: ADR 0004 §9.6.

- [hub] database.md Data rules: replace the retention *Kept.* bullet and the two erasure bullets on the consent PDF and consent record; add R-9 (consent records deleted 3 years after `signed_at`) and the post-erasure access rule; comment on `consents.pdf_key`.
- [hub] fsd.md FR-401 and FR-704: consent record kept 3 years after signing, then deleted, also after erasure (C-04, C-17). NFR-05: C-06 wording, drop "Provisional".
- [hub] test-cases.md TC-094: erasure keeps the consent record and PDF; drop "provisional, Legal to confirm". QA adds a TC for the 3-year consent clock.
- [hub] prompts/database.md Step 6: RetentionService adds R-9; CandidateErasureService stops deleting consent PDFs and blanking the consent record.
- [hub, PR #39] ADR 0013 5.7: consent PDF row reason ("kept 3 years after signing, through erasure") and the erasure bullet (session prefix only; R-9 deletes the consent prefix). Owner question 16 then closes.
- [hub, PR #39] ADR 0013 licence gate: overrides for AuraFace and COCO-SSD cite D-28 (updated by C-10) in status.md §9, or the gate also reads docs/compliance/decisions.md.
- [database] DB-06: implement R-9 and the amended R-6 (tests: TC-072, TC-094, new consent-clock TC).
- [backend] BE-09: erasure deletes only the session prefix. BE-06: erasure confirmation email says the consent record is kept until its 3-year date.
- [frontend] FE-03: erase confirmation text mentions the kept consent record.
- [owner] ADR 0004 §9.7 questions: litigation hold; declined consents on the 3-year clock; erasure clears `invitations.accommodations`.
