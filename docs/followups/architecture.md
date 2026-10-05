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

## Compliance amendments to ADR 0004 and ADR 0001 (C-04, C-06, C-10, C-17, C-18, C-26, C-27; branch arc/compliance-adr-amendments)

Proposed; the owner accepts. Apply these once ADR 0004 §9 and ADR 0001 §12.4 are accepted. The full list is in ADR 0004 §9.9.

- [hub] database.md Data rules, four conflicts: *Eligible* has no 90-day face-image cap (C-27); *Kept* says "until erasure" (C-04, R-9); the erasure rules delete the consent PDF and blank `signed_name`/`ip`/`user_agent` (C-17). Also add R-9, R-10 (1-year results, C-26), the no-session-delete rule and the post-erasure access rule.
- [hub] fsd.md FR-704: 90-day face-image cap, 3-year consent clock and 1-year results clock. NFR-05: the C-06 wording, dropping "Provisional (D-19, Legal to confirm)". FR-401: consent proof kept through erasure.
- [hub] test-cases.md TC-072 (cap) and TC-094 (keeps the consent proof). QA adds TCs for R-9, R-10 and access to the kept proof.
- [hub] prompts/database.md Step 6: two-tier R-4, R-9, R-10; the erasure service keeps the consent proof.
- ~~[hub, with or before #39] ADR 0013: the 5.7 consent PDF row, the 5.7 erasure bullet, the §8 BE-09 consent prefix, and CS-4 for erased candidates' consents.~~ Done in ADR 0013 (PR #39, head 75de77c). No CS-4 change is needed: CANDIDATE scope already excludes these columns, and the SERVICE carve-out is enforced in the service layer (ADR 0004 §9.5).
- [hub, #39, gates acceptance of ADR 0004 §9] ADR 0013 object deletion is aligned at head 75de77c: tiers selected by session with completion markers; R-4 excludes `reports/`; the face tier at LEAST(retention_days, 90); R-10 runs the earlier tiers first, then deletes `reports/` and `submissions`; erasure deletes `reports/`; the R-9 cite is §9.3. Keep the two ADRs in step until both are accepted.
- [hub, #39] ADR 0013 licence gate: one unit per named model (the COCO-SSD manifest plus every shard). Each `licence-acceptances` line carries D-28. There is no deploy-config override.
- [hub] ADR 0006 §7.2 and ADR 0008 deltas: `REVOKE DELETE, TRUNCATE ON sessions FROM app_user`, with a `has_table_privilege` test so a later re-grant is caught (ADR 0004 §9.3).
- [hub] ARC-05: S3 versioning must not keep noncurrent copies of deleted face images, reports or consent PDFs (ADR 0004 §9.7). Redis AOF and RDB snapshot retention for email job payloads (ADR 0004 §9.5).
- [Delivery Lead] status.md §9: one entry citing C-10 and D-28 that lists the exact `name@sha256` of every AuraFace and COCO-SSD file (the gate reads it). retention-schedule.md: pseudonymisation wording and the IP and browser row. DPIA: 3-year rationale and the legal flags in ADR 0004 §9.8.
- [database] DB-06: ADR 0004 §9.2 to §9.5 and §9.7.
- [backend] BE-06 `erasure-completed` template (deterministic job id, sent and failed audit rows); BE-09 tiers selected by session with markers; BE-13 and BE-14 hide erased candidates' consent fields, treat a NULL verdict as "results purged", and refuse appeals on purged reviews.
- [integrity] BE-08 embedding cache lifetime (ADR 0004 §9.1).
- [frontend] FE-03 erase confirmation text.
- [owner] OQ-10 (legal hold), OQ-11 (declined consents), OQ-12 (accommodations on erasure); the embedding cache under C-18; C-27 scope; the pseudonymisation wording; the BIPA 5-year flag.

## CLAUDE.md "Working in parallel" (PR #29 review)

### Should-fix
1. Rules 6 and 7: a PR touching CLAUDE.md, `.claude/` or an ADR needs the owner to approve the merge of the reviewed head SHA, not only the draft. Add to rule 6 "unless the PR falls under rule 7".
2. Rule 13: "keep both sides' content" on docs conflicts must not apply to CLAUDE.md, `.claude/` or ADRs; stop and ask the owner (rule 7).

### Nits
- Rule 9: re-run code-reviewer after any push after review, including a rebase.
- Rule 1: "never force-push a branch you do not own" repeats "push only to your own branches".
- Rule 14: list all four human-only commands (`db:reset`, `dev:infra:reset`, `prisma migrate reset`, `db push`) or none.

### Owner decisions pending
- Only the Database session runs `db:migrate` and `db:seed` on the shared local stack?
- Full review for source-of-truth docs (fsd, database, test-cases, architecture)?
- Escalation of docs-to-docs contradictions from the hub to the owner?

## ADR 0011 re-authentication (PR #31 review)

Owner questions are listed in `docs/api-contract.md` section 1 ("Open for the owner"): admin reset password, shared lockout, mandatory-2FA roles and disable, admin resetting admins, refresh-token revocation, TOTP on disable.

### Should-fix (ARC-02 part 2)
- Add fsd.md §4 rows for `/auth/2fa/setup/*`, disable, regenerate and reset; ask QA for new TC IDs.
- `reauth` body schema in packages/shared.
- BE-02: decide and document whether a successful re-auth resets the failed-login counter, as a login does.
