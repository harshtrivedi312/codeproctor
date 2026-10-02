# Follow-ups

Should-fix items and nits from code reviews. Under the session rules, only blockers stop a merge; everything else is recorded here. Each session appends under its own track, and the architecture hub triages items owned by other tracks.

Columns:
- **Type:** should-fix or nit.
- **Owner:** the session or agent expected to act.
- **Target:** the task where it gets done.
- **Status:** open or done (give the PR number when done).

## Database track

| ID | Source | Type | Item | Owner | Target | Status |
| --- | --- | --- | --- | --- | --- | --- |
| FU-DB-01 | PR #5 review | should-fix | DB-03 brief step 2: add `SET NOT NULL` on the 5 list columns (`users.recovery_code_hashes`, `questions.tags`, `question_versions.allowed_languages`, `sessions.pause_reasons`, `webhook_endpoints.events`). Prisma emits them nullable. Add to the acceptance criteria that a second `pnpm db:migrate` reports "Already in sync" after the hand edits. | architecture hub (brief), Database | DB-03 | open |
| FU-DB-02 | PR #5 review (A2) | should-fix | Convert the 5 BIGSERIAL ids to `GENERATED ALWAYS AS IDENTITY` in the init migration, then confirm `migrate dev` shows no diff. If Prisma proposes a diff, the architect decides. Seeds and tests never set these ids. | Database | DB-03 | open |
| FU-DB-03 | PR #5 review (A3) | should-fix | Record in ADR 0008 section 1 or the DB-08 brief that the 20 uniques are unique indexes, not constraints. Count them with `pg_index.indisunique AND NOT indisprimary`, and use `ON CONFLICT (cols)`, never `ON CONFLICT ON CONSTRAINT`. | architecture hub | DB-08 | open |
| FU-DB-04 | PR #5 review (A1) | should-fix | Record in architecture.md or ADR 0008 that `Invitation.sessions` is a list by design. Look sessions up with `prisma.session.findUnique({ where: { invitationId } })`, never `invitation.sessions[0]`. `sessions.invitation_id` is UNIQUE. | architecture hub | DB-05, BE-07 | open |
| FU-DB-05 | PR #5 review (A4) | should-fix | Test the `users.updated_at` trigger. The schema has no `@updatedAt` by design, so the trigger owns the column. | Database | DB-08 | open |
| FU-DB-06 | DB-02 engineer, PR #5 review | should-fix | Prisma returns `BigInt` for the 5 identity ids, `sessions.paused_ms`, `media_chunks.size_bytes`, `session_sections.time_limit_ms` and `flag_decisions.event_id`, and `Decimal` for scores. `JSON.stringify` throws on BigInt. The API contract must choose string or number, and Nest needs a serializer. | architecture hub (ARC-02), backend | ARC-02, BE-01 | open |
| FU-DB-07 | DB-02 engineer | should-fix | Services must always pass `allowedLanguages` and `events` explicitly. The list columns become NOT NULL without a database default, and Prisma Client treats list inputs as optional. | backend, Database | DB-05, BE-04, BE-14 | open |
| FU-DB-08 | PR #5 review | nit | `schema.prisma` TODO header: say that Prisma already emits both circular FKs (`fk_current_version`, `fk_current_consent_text`) and matching `pause_reason[]` and `bytea` columns, so DB-03 can tick those ADR 0008 section 8 items. | Database | DB-03 | open |
| FU-DB-09 | PR #5 review | nit | Write the 12 CHECKs as `CONSTRAINT <name> CHECK (...)` with the names listed in the `schema.prisma` TODO, so DB-08 can assert them. | Database | DB-03 | open |
| FU-DB-10 | PR #5 review | nit | `apps/api/src/database/create-prisma-client.ts:5`: import `'../generated/prisma/client.js'`, so a later move to ESM does not break it. | Database | DB-03 or DB-05 | open |
| FU-DB-11 | PR #5 review | nit | CI: add `pnpm exec prisma format --check`, and optionally `prisma validate`, to catch formatting drift in `schema.prisma`. | architecture hub (CI config) | DB-03 | open |
| FU-DB-12 | DB-02 engineer | nit | `prisma`, `@prisma/client` and `@prisma/adapter-pg` are pinned to the exact same version and must be bumped together. Dependabot covers only GitHub Actions. Consider a CI check that the client and CLI versions match. | architecture hub | later | open |
| FU-DB-13 | DB-02 engineer | nit | Developer note: a fresh clone needs `pnpm db:generate` before `typecheck`, `build` or typed `lint`. CI already does this. | Database | DB-03 | open |
| FU-DB-14 | DB-02 engineer | nit | Remove `prisma/.gitkeep` once migrations exist. | Database | DB-03 | open |
| FU-DB-15 | DB-02 engineer | nit | Contributors need Node 24, as `.nvmrc` says. This machine's default is Node 22.23.3; agents used a scratchpad Node 24 for local checks. | owner | — | open |
| FU-DB-16 | DB-01 review (N10) | nit | In Next.js, a browser-side Sentry DSN needs the `NEXT_PUBLIC_` prefix, so `SENTRY_DSN_WEB` in `.env.example` will likely be renamed. | architecture hub (ARC-03), frontend | ARC-03, FE-01 | open |
