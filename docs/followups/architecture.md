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
- **TODO (FU-DB-60): link `apps/api/src/database/README.md` from docs/architecture.md.** PR #30 is merged, so the README is on main. The link is the architect's next docs change.
- **[integrity; db-engineer, backend-engineer] Same-parent check for cross-chain references (ADR 0006 section 8.1).** Rule (i) proves only that a target is in the same org. `variant_test_cases.test_case_id` is cross-chain, so a variant test case could point to a test case of a different question version than its `variant_id`. The same applies to `ai_reference_solutions.variant_id` and to `question_version_id`, `test_question_id` and `variant_id` on `session_questions`. Options: a service check that the targets share the parent (BE-04, BE-07), or a later composite foreign key through an ADR 0008 amendment. For `session_questions.variant_id`, see also ADR 0013 CS-4.6 (render-question correctness).
- **[db-engineer] Scope exits and grant sites (FU-DB-67, ADR 0006 section 8.5).** The FU-DB-67 allow-list must also cover `exit`, `enterWith` and `disable` on the OrgContext store, `detachForSessionJob` (allowed from no scope only), the ten ADR 0013 CS-4.4 grant sites (with the candidate-facts setter; `CandidateSessionGuard` has no grant since DL-31), the guard's `runInOrg` candidate-facts pre-read (ADR 0013 section 5.10), and the candidate-write datasource as an allowed client importer. Its row in docs/followups/database.md still lists only `runSystem`, `runInOrg` and `runRawSql`.
- **[db-engineer, Delivery Lead] Nested writes are denied by default (ADR 0006 section 8.2, DL-14).**
  - Built in main (7c5d2e0), in org and system scope, with an empty `NESTED_WRITE_ALLOWLIST` (FU-DB-101).
  - The DB-05 merge gate is satisfied; the remaining deltas are listed in ADR 0006 section 8.0.
  - The Delivery Lead should align the DL-14 wording in docs/status.md ("every org scope") to include system scope.
- **[Delivery Lead] build-plan.md DB-05 still says "request-scoped OrgContext".** ADR 0001 C-1 and database prompt Step 5 now say "an OrgContext per unit of work on AsyncLocalStorage, not a Nest REQUEST-scoped provider". The architect may not edit build-plan.md in parallel work, so the Delivery Lead aligns it.

## Pointer

The [ARC-02] items under "frontend/step-2" in docs/followups/frontend.md (staff auth schemas, endpoints, 2FA challenge, password policy, fragment tokens) are architecture-hub work and are tracked there.

## Compliance amendments to ADR 0004 and ADR 0001 (C-04, C-06, C-10, C-17, C-18, C-26, C-27, C-35; branch arc/compliance-adr-amendments)

Proposed; the owner accepts. Apply these once ADR 0004 §9 and ADR 0001 §12.4 are accepted. The full list is in ADR 0004 §9.9.

- [hub] database.md Data rules, four conflicts: *Eligible* has no 90-day face-image cap (C-27); *Kept* says "until erasure" (C-04, R-9); the erasure rules delete the consent PDF and blank `signed_name`/`ip`/`user_agent` (C-17). Also add R-9, R-10 (1-year results, C-26), the no-session-delete rule and the post-erasure access rule.
- [hub] fsd.md FR-704: 90-day face-image cap, 3-year consent clock and 1-year results clock. NFR-05: the C-06 wording, dropping "Provisional (D-19, Legal to confirm)". FR-401: consent proof kept through erasure.
- [hub, QA] test-cases.md TC-072 (the cap, from the face clock) and TC-094 (keeps the consent proof). QA adds the TCs listed in ADR 0004 §9.9 row 8: R-9; R-10 for a multi-session candidate; tier selection by session; a failed DeleteObjects leaving no marker; erasure during IN_PROGRESS with a late PUT, during SUBMITTED or GRADED with grading in flight, and during a hold with a second session; an orphan identity object deleted by day 90; INCONCLUSIVE at day 90 in an open identity review; the session-delete refusal; access to the kept proof; email ordering.
- [hub] prompts/database.md Step 6: two-tier R-4, R-9, R-10; the erasure service keeps the consent proof.
- ~~[hub, with or before #39] ADR 0013: the 5.7 consent PDF row, the 5.7 erasure bullet, the §8 BE-09 consent prefix, and CS-4 for erased candidates' consents.~~ Done in ADR 0013 (PR #39). No CS-4 change is needed: CANDIDATE scope already excludes these columns, and the SERVICE carve-out is enforced in the service layer (ADR 0004 §9.5).
- [hub, #39, gates acceptance of ADR 0004 §9] ADR 0013 5.7 and the BE-09 row must match ADR 0004 §9.6. In particular, the face tier must use face clock + LEAST(retention_days, 90) with the COALESCE fallbacks, not "the earlier of anchor + LEAST(...) and 90 days after capture". R-10 lists the whole prefix and does not wait for earlier markers. "At the latest by R-10" holds only with the erasure fence. Keep the two ADRs in step until both are accepted.
- [hub, #39] ADR 0013 licence gate: one unit per named model (the COCO-SSD manifest plus every shard). Each `licence-acceptances` line carries D-28. There is no deploy-config override.
- [hub, #39, round 4 of #48] ADR 0013 must take up: a marker is written only after verified deletion (all pages listed, no DeleteObjects `Errors`, fresh listing empty); R-10 lists and deletes the whole session prefix; `RETENTION_MARKER_ACTIONS` is reserved to RetentionService; erasure never writes markers, fences live sessions and re-runs after ingest close plus the margin; the face tier runs on the face clock with no hold (C-35); "purged" is keyed on the `RETENTION_RESULTS_DONE` marker, never on "no submissions rows".
- [hub] ADR 0008 delta: partial index `audit_logs (action, entity_id) WHERE action IN (RETENTION_*_DONE)` (ADR 0004 §9.2).
- [hub] ADR 0002 and ADR 0008 amendments: a new terminal `session_status` value `ERASED` with no exit transition, fencing every non-held session of the candidate (terminal ones included); a new `appeal_status` value `CLOSED_ERASED`; R-1 keeps or sets the anchor; `SessionStateService.guardLive` in every SERVICE writer, with object writes inside the lock or self-deleted; fsd.md §3 and database.md enum lines (ADR 0004 §9.5, §9.9 rows 20 to 23).
- [integrity, FR-803] `analyze-session` excludes ERASED sessions as comparison sources. A CODE_SIMILARITY payload on another candidate's session never copies the matched code (`matchedSessionId` only). Latent today, because the zod schema strips `matchedLines` (followups/integrity.md item 4). From ADR 0004 §9.6.
- [hub, relay to ADR 0013] Name ERASED where its fence paragraph and Q21 say "still settling"; name `guardLive` and its full job list; make the grading reconciler's skip session-keyed; align the face clock; R-10 does not wait for earlier tiers; pin the erasure re-run to the fence time (ADR 0004 §9.6).
- [hub] ADR 0006 §7.2 and ADR 0008 deltas: `REVOKE DELETE, TRUNCATE ON sessions FROM app_user`, with a `has_table_privilege` test so a later re-grant is caught (ADR 0004 §9.3).
- [hub] ARC-05: S3 versioning must not keep noncurrent copies of deleted face images, reports or consent PDFs (ADR 0004 §9.7). Redis AOF and RDB snapshot retention for email job payloads (ADR 0004 §9.5).
- [Delivery Lead] status.md §9: one entry citing C-10 and D-28 that lists the exact `name@sha256` of every AuraFace and COCO-SSD file (the gate reads it). retention-schedule.md: pseudonymisation wording and the IP and browser row. DPIA: 3-year rationale and the legal flags in ADR 0004 §9.8.
- [database] DB-06: ADR 0004 §9.2 to §9.5 and §9.7.
- [backend] BE-06 `erasure-completed` template (deterministic job id, sent and failed audit rows); BE-09 tiers selected by session with markers; BE-13 and BE-14 hide erased candidates' consent fields, derive "results purged" from the `RETENTION_RESULTS_DONE` marker (never from a NULL verdict), refuse appeals on a NULL verdict, and allow INCONCLUSIVE once face images are gone.
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

The six owner questions were answered by C-21 (2026-10-05, D-49) and are recorded in `docs/api-contract.md` section 1 ("Owner answers"). Two backend follow-ups come from them: (1) disabling 2FA must require a current TOTP code (`totpCode`) and revoke that user's refresh sessions: backend PR #51 (pending merge); (2) reset already revokes the target's sessions in #26. QA must update `apps/api/test/integration/tc-003.int.test.ts` for the new disable body. Also recorded: `totpEnabled` on the session user (api-contract.md section 1; backend-engineer, task to be assigned by the Delivery Lead). Should-fix (ARC-02 part 2): the other docs that still call ADR 0011/0012 proposed (`docs/status.md`, `docs/compliance/dpia.md`) are the Delivery Lead's to update.

### Should-fix (ARC-02 part 2)
- Add fsd.md §4 rows for `/auth/2fa/setup/*`, disable, regenerate and reset; ask QA for new TC IDs.
- `reauth` body schema in packages/shared.
- BE-02: a successful re-auth does not reset the failed-login counter on main (it only refunds its own reservation); confirm or change.
- Backend follow-up: add `req.body.currentPassword`, `req.body.password`, `req.body.newPassword` (and `err` equivalents) to the pino redact list in `apps/api/src/app.module.ts` (no body paths on main today).
- Backend follow-up: audit every re-auth failure and a successful `setup/start` (today only completed actions and the lock-triggering failure are audited).

## Hub review follow-ups (2026-10-06 batch)

From the ADR 0013 / 0006 section 8 / 0014 / 0016 reviews and the CI PRs. Owner-gated items are marked.

### ADR 0013 (merged as Proposed)
- F1: the consent-PDF renderer must be named as a carve-out reader of `signedName`, `ip`, `userAgent` in ADR 0004 section 9.5 (the lint fails closed until then).
- F2: the SERVICE pool needs a whole-transaction bound (Prisma `$transaction` timeout about 5 s, `idle_in_transaction_session_timeout`); the bounded PUT under the lock gets its own timeout.
- F3: main-pool candidate writes outside `$transaction` have no `statement_timeout`; add one or state that every candidate write runs in a `$transaction`.
- F4: name the enforcement for "no other transaction API" (lint or the FU-DB-67 test rejecting `$transaction` in session-job code outside `SessionJobProcessor`).
- Wording: the 409 `SESSION_NOT_ACTIVE` problem extension member is `sessionStatus` (not `status`, which RFC 7807 reserves for the HTTP code); 200 bodies keep `status` (done in this PR, ADR 0013 lines 132 and 193). Add `sessionStatus` to docs/api-contract.md (which lists `code` as the only extension member) when BE-07 or BE-10 implements it.
- fsd.md section 4: publish, archive and unarchive need their guard named (presumably `question:update`; validate uses `question:validate`); a question-publish permission would amend ADR 0010 section 6 (owner).
- ADR 0004 section 9.5 step 4 predicate text: copy `where: { id, status: <read>, NOT: { status: 'ERASED' } }` and the `withLiveSession` / `withAnySession` names so the three ADRs read the same.

### ADR 0006 section 8 (merged)
- F5: add "the erasure re-run" to the `withAnySession` list. F6: name `withLiveSession` and `withAnySession` in FU-DB-67 (high priority before its implementation). F7: state the SERVICE pool decision (`lock_timeout=1000`, `statement_timeout=10000`) and add its client to the 8.6 importer list with the "extension is applied" test. F8: pick one form for the pool `statement_timeout` (pg field or `options`) for the BE-07 spike.
- Code gaps recorded in the as-built table: unknown system-scope write operations pass through (Database A is making it deny-by-default against SCOPED_OPERATIONS); org-scope delete of the Organization row is closed by #82 (FU-DB-68).

### ADR 0014 (merged as Proposed)
- Nonce race: after the signature verifies, do an atomic check-and-insert. The corpus read must re-check fences just before `/v1/analyze/similarity`, or record that residual. List exactly which unsigned codes the API accepts as genuine (413 and 400 are sent before the signature check). An injected unsigned 401 is an availability residual: note it or probe `/v1/ready` first. Cap `Retry-After` on the API side.
- Frontend constraint (FU-FEB-03): the production-build mock guard must read `process.env.ALLOW_MOCKING_IN_PRODUCTION_BUILD === 'staging-only'` at build time in `next.config.ts` and never expose it through `nextConfig.env` or a `NEXT_PUBLIC_` alias.

### ADR 0016 (merged as Proposed)
- DNS Firewall rule groups associate per VPC: a shared pilot VPC allowlist must cover the app host's names, or Judge0 gets its own VPC (layout ADR decides; preferred: separate VPC).
- Integrity B benchmark: AuraFace about 279 ms per embedding (1 thread about 3.6 per second, 4 threads about 11.2 per second). Without a selfie cache, 200 concurrent candidates need about 4.0 per second, so 2 vCPU is thin. Rerun the benchmark on the chosen instance type before the pilot; this feeds the cache recommendation in ADR 0004 Q1 / ADR 0014 Q7 (owner questions via the Delivery Lead).

### CI (PRs #86, #87, #105, #110)
- `qa.yml`: reject an empty host in the three allow-list steps; lowercase `host` consistently (`ALLOWED_HOSTS`, `web_host`, `api_host`); run the ZAP verdict step with `if: ${{ !cancelled() }}`; the node tests for `packages/qa/zap` and `k6/lib/guard.test.mjs` do not run in CI (needs a QA A script); the `K6_SESSIONS_JSON` secret may exceed 48 KB for 200 sessions.
- `backup-nightly.yml`: `PGSSLROOTCERT=system` needs a publicly signed certificate matching `STAGING_BACKUP_PGHOST`; document in the runbook. Pin `postgres:16` by digest in both workflow files, kept in sync with `POSTGRES_IMAGE` in `verify-drill-support.mjs`. The `verify` job may need a longer `timeout-minutes` now that it runs the restore drill.

### Owner-gated (not done here)
- ADR 0011 amendment: `currentPassword` step-up also covers `POST /admin/users`, `PATCH /admin/users/:userId` and `POST .../unlock`. ADR 0010 section 6: `account:self`, heartbeat, appeals, reports and webhooks permissions and a CANDIDATE route variant (PR #113 adds `candidate_session:read|start|heartbeat|key`).
- CLAUDE.md rule 9/11 amendment (merge by the Delivery Lead, no re-run for disjoint changes); ADR 0004 section 9 and ADR 0015 acceptance with the database.md update for migrations #91 and #100; C-30 age-confirmation storage; BE-07 B-1 exception.

## Delivery Lead relay queue (2026-10-06)

The architecture hub session hasn't been running since 2026-10-06 02:25 UTC, so the Delivery Lead queues hub items here. The hub works through them when it restarts and strikes each one through with its PR number. Decisions that also need the owner are marked **owner**.

### ADR text corrections, before the owner accepts under P-15
~~1. **ADR 0013 §5.10 (DL-31, FU-DB-185).** The guard reads the session's `invitation_id`, then the invitation's `candidate_id` and `test_id`, in a plain `runInOrg(oid)`. These are column-only selects, never `accommodations`. The callback returns before `runAsCandidate(oid, sid)`. A missing or other-org session returns 401. `setCandidateFacts` runs before any other candidate-scope query. Update §5.10, the CS-4.4 `CandidateSessionGuard` grant row and its copy in ADR 0006 §8.4 (not needed under option (a)), and the FU-DB-67 call-site list. Alternatively, choose the narrower variant (only `invitations` read in org scope, with the grant row kept).~~ **Done in PR #140 (pending merge).**
~~2. **ADR 0015 (DL-30).** Reconcile §6 with DL-30. Keep §6's window: a waiver may be set only while no identity attempt exists. Apply DL-30's rule (every earlier attempt's sealed ID image and selfie is deleted at once, and the attempt row keeps only ids, status and timestamps) to the race, and to any path where images already exist when a waiver lands. Widening §6 to allow a waiver after a match has run is **owner** (C-02, C-19), because it would let a failed match be waived away. Integrity B raised it in docs/briefs/BE-08b-design.md.~~ **Done in PR #140 (pending merge).**
~~3. **ADR 0004 §9.2, the face-clock bullet** (raised by Database B in #134, merged; not a DL row). Replace "earliest terminal-transition audit row written by SessionStateService.transition()" with: "Terminal transition time: for a session that was never submitted, `sessions.retention_anchor_at`, which the state machine stamps at its first terminal status (expiry, decline) and the erasure fence keeps or sets. Never updated_at." ADR 0013 §5.7 already says "terminal transition time".~~ **Done in PR #140 (pending merge).**

### Contracts and packages/shared
4. **BE-08b (Integrity B, #129; FU-INB-29..37).** `GET /candidate/session/identity` with `canRetry`; the `IDENTITY_ATTEMPTS_EXHAUSTED` error code; BE-09's name state and `capturedAt`; and who builds `withLiveSession`, `guardLive` and verify-session.
5. **FU-FEB-10, the token hand-off (ARC-03 part 2, Frontend B).**
6. **BE-04 (Backend A, DL-32).**
   - FU-BE-101: a declarative variant parameter schema is new scope and a schema change (**owner**). BE-04b follows ADR 0007 as written meanwhile.
   - FU-BE-102: move the short-answer normalisation and the answer_spec zod schema (D-23) into packages/shared. It must match the web editor's copy.
   - Decide whether publish and archive get a separate `question:publish` permission. It amends accepted ADR 0010 §6, so it's **owner** (as P-15 was).
7. **BE-06 (Backend A, DL-33).**
   - Copy-or-archive for tests (ADR 0002) has no `archived_at` or `source_test_id` column. Decide the schema (an ADR 0008 delta, **owner**) or another design.
   - fsd.md §4 and api-contract rows are missing for test copy and archive, invitation list, read, resend and revoke, and the accommodations PATCH. New FSD rows are **owner**. Bulk invite already exists (fsd.md `POST /tests/:id/invitations`, FR-304, `invitation:create`); only the CSV upload format (multipart shape and row-error report) is missing from api-contract.md.
   - New permissions `invitation:read` and a revoke permission amend accepted ADR 0010 §6, so they're **owner**.
   - Publish `accommodationsSchema` in packages/shared. build-plan BE-06 says the hub records it in an ADR. If no approved ADR covers it, it's **owner** (CLAUDE.md rule 7).
   - docs/prompts/backend.md Step 6 still names Resend or Brevo. C-31 says Amazon SES.
8. **FU-FEB-34 (Frontend B).** There is no room-scan waiver in FR-305. Decide whether the accommodations waiver covers FR-404's room scan (**owner** if it changes the FSD).
