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

## DB-05 architect gate (2026-10-05, ADR 0006 section 8 proposed)

- **[ARC-05] Pilot org provisioning (FU-DB-76).** Pilot orgs are provisioned outside the API by a CLI built on the client factory (`apps/api/src/database/create-prisma-client.ts`), like the seed. It creates the org and its first SUPER_ADMIN. The set-password link is sent from a `set-password` job whose payload carries only `orgId` and `userId`. The processor rotates the token with a conditional update and calls the mail provider in process (option (b)), so the link never reaches Redis or a mail job. The CLI can re-issue the link for an admin who has no password yet. There is no API route and no system-scope reason. If self-serve or platform-admin org creation is ever needed, add `ORG_PROVISIONING` through an ADR 0006 amendment. DEP-03 runs the CLI on the pilot host, over SSH from a GitHub Actions job or on a self-hosted runner in the pilot network. A GitHub-hosted runner never connects straight to the pilot database. Inputs come from a file on the host or a secret. The db-engineer builds the CLI. Recorded in ADR 0006 section 8.9.
- **[ARC-05, DEP-02] RLS revisit (FU-DB-77).** Revisit Postgres row-level security on `org_id` (ADR 0006 section 1, option b) before production. Not for build or pilot (ADR 0006 section 8.3).
- **TODO (FU-DB-60): link `apps/api/src/database/README.md` from docs/architecture.md** once PR #30 merges. The README is not on main yet, so the link is deferred.
- **[integrity; db-engineer, backend-engineer] Same-parent check for cross-chain references (ADR 0006 section 8.1).** Rule (i) proves only that a target is in the same org. `variant_test_cases.test_case_id` is cross-chain, so a variant test case could point to a test case of a different question version than its `variant_id`. The same applies to `ai_reference_solutions.variant_id` and to `question_version_id`, `test_question_id` and `variant_id` on `session_questions`. Options: a service check that the targets share the parent (BE-04, BE-07), or a later composite foreign key through an ADR 0008 amendment. For `session_questions.variant_id`, see also ADR 0013 CS-4.6 (render-question correctness).
- **[db-engineer] Scope exits and grant sites (FU-DB-67, ADR 0006 section 8.5).** The FU-DB-67 allow-list must also cover `exit`, `enterWith` and `disable` on the OrgContext store, `detachForSessionJob` (allowed from no scope only), and the ADR 0013 CS-4.4 grant entry sites. Its row in docs/followups/database.md still lists only `runSystem`, `runInOrg` and `runRawSql`.
- **[db-engineer] Nested writes are denied by default (ADR 0006 section 8.2, Delivery Lead decision).** This replaces the per-class guard from FU-DB-63. The allowlist starts empty. It is a DB-05 merge gate: PR #30 does not merge, and BE-03 and BE-06 write no invitation or session code, until deny by default, its system-scope application and the COMPOSITE `connect` test land.
- **[Delivery Lead] build-plan.md DB-05 still says "request-scoped OrgContext".** ADR 0001 C-1 and database prompt Step 5 now say "an OrgContext per unit of work on AsyncLocalStorage, not a Nest REQUEST-scoped provider". The architect may not edit build-plan.md in parallel work, so the Delivery Lead aligns it.

## Pointer

The [ARC-02] items under "frontend/step-2" in docs/followups/frontend.md (staff auth schemas, endpoints, 2FA challenge, password policy, fragment tokens) are architecture-hub work and are tracked there.

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
