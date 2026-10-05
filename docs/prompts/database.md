# Prompts — Database setup

Run these 8 prompts in order in Claude Code, one per step, and check each result before moving on. This track runs first because the backend and frontend both depend on the schema.

## How to use these prompts

1. Create the repo and copy the BRD, FSD, Architecture, Database and Test Cases tabs into `/docs` as markdown files (`brd.md`, `fsd.md`, `architecture.md`, `database.md`, `test-cases.md`).
2. Save the context prompt below as `CLAUDE.md` in the repo root. Claude Code reads it automatically in every session.
3. Paste one step at a time. After each step, run the verification command it names and commit.

## Step 0 — Project context (save as CLAUDE.md)

```text
Project: CodeProctor, a proctored coding assessment platform for hiring.
Source of truth: /docs/brd.md, /docs/fsd.md, /docs/architecture.md, /docs/database.md, /docs/test-cases.md. Read the relevant doc before changing code. If code and docs disagree, stop and ask.

Stack: pnpm monorepo. apps/web (Next.js App Router, TypeScript, Tailwind, shadcn/ui), apps/api (NestJS, Prisma, PostgreSQL 16, Redis + BullMQ, Socket.IO), apps/worker (Python 3.12, FastAPI), packages/proctor-sdk, packages/shared (types + zod schemas). Judge0 CE for code execution. Object storage behind one S3-compatible interface: staging uses Cloudflare R2 with synthetic data only; pilot and production use AWS S3; only configuration differs between environments. Docker Compose for local and staging.

Rules:
- TypeScript strict mode; no `any`.
- Every API route has a DTO validated with class-validator or zod, a role guard, and an org-scope check.
- Never log secrets, tokens, OTPs, or candidate media keys.
- Every feature ships with tests; reference FR and TC IDs from the docs in test names.
- Small commits with conventional commit messages.
- Prefer free and open-source tools.
```

## Step 1 — Monorepo and local infrastructure

```text
Read /docs/architecture.md (Repository layout and Deployment).
Create the pnpm monorepo skeleton exactly as the repository layout shows, with empty apps and packages that each build.
Create infra/docker-compose.yml with services: postgres:16 (with a named volume and healthcheck), redis:8.8 (AGPLv3 licence option; see ADR 0001), and adminer for local DB browsing. Use an .env.example with DATABASE_URL, REDIS_URL, and placeholders for every secret the architecture mentions.
Add root scripts: `pnpm dev:infra` (compose up), `pnpm db:migrate`, `pnpm db:seed`, `pnpm db:reset`.
Verify: `pnpm dev:infra` starts all containers healthy; `psql $DATABASE_URL -c 'select 1'` works.
```

## Step 2 — Prisma schema

```text
Read /docs/database.md fully, and /docs/adr/0008-schema-freeze-list.md. Create prisma/schema.prisma that matches the reference DDL exactly: all 31 tables, all 20 enums, all unique constraints (including the composite (id, org_id) ones), foreign keys with the same ON DELETE behavior (22 CASCADE, 1 SET NULL, 3 composite), and all indexes.
Map names to snake_case with @@map and @map; use camelCase in the Prisma client.
Use @db.Uuid, @db.Citext, @db.Inet, @db.Timestamptz(6), Bytes for bytea, enum lists for pause_reason[], and Decimal with the same precision as the DDL.
For the circular relations questions.current_version_id and organizations.current_consent_text_id, model each as an optional relation with a named relation.
Do not invent columns. Tick every line of the freeze list. List any DDL feature Prisma cannot express (CHECK constraints, partial indexes, extensions, identity columns) in a TODO list for Step 3.
Prisma 7 (ADR 0009): the datasource block has only `provider = "postgresql"` and no `url`; the CLI URL lives in prisma.config.ts. Use the `prisma-client` generator with `output = "../apps/api/src/generated/prisma"` and `moduleFormat = "cjs"`, add `@prisma/client` and `@prisma/adapter-pg` (same exact version as the CLI) and `pg` to apps/api, a single client factory that passes a `PrismaPg` adapter, and a root `db:generate` script. For the SQL check use `prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script` (`--to-schema-datamodel` was removed).
Verify: `pnpm prisma validate`, `pnpm prisma format` and `pnpm db:generate` pass.
```

## Step 3 — Migrations, including what Prisma cannot express

```text
Generate the initial migration with `pnpm db:migrate --create-only --name init` (localhost-guarded; Prisma 7's migrate dev no longer runs generate or seed, ADR 0009).
Then edit the generated SQL to add everything from your Step 2 TODO list: the pgcrypto and citext extensions (at the top), all 12 CHECK constraints from /docs/database.md, the partial indexes on sessions(risk_band) and sessions(retention_anchor_at), the GENERATED ALWAYS AS IDENTITY columns, and a trigger that sets users.updated_at on update.
The database role comes from a migration (ADR 0006 section 7, D-35); there is no roles.sql and no compose init script. Create a second migration `audit_append_only` (`pnpm db:migrate --create-only --name audit_append_only`) containing the SQL in ADR 0006 section 7.2: it creates `app_user` if it does not exist (no password in any migration), grants USAGE on schema public, SELECT/INSERT/UPDATE/DELETE on all tables and USAGE/SELECT on all sequences, sets default privileges for future tables and sequences, then REVOKEs UPDATE, DELETE and TRUNCATE on audit_logs and all access to _prisma_migrations. It fails with a clear message only where the migration role cannot create roles. Write infra/scripts/set-app-user-password.mjs, which sets app_user's local password from APP_USER_PASSWORD behind the localhost guard; staging, pilot and production set it at provisioning. Migrations run with MIGRATION_DATABASE_URL (owner role); the app uses DATABASE_URL (app_user).
Verify: `pnpm db:migrate` applies both migrations on the existing local volume, and `prisma migrate deploy` applies them to a throwaway Postgres 16 container; as app_user, `DELETE FROM audit_logs` and `TRUNCATE audit_logs` fail with permission denied. Only a human runs `pnpm db:reset` (ADR 0009 section 4.4); never run it, `prisma migrate reset` or `db push` yourself.
```

## Step 4 — Seed data

```text
Create prisma/seed.ts that inserts realistic development data:
- 1 organization "Demo Corp" with retention_days 90, and one consent text marked as a placeholder (body starts with "PLACEHOLDER - NOT APPROVED BY LEGAL", legal_approved_at NULL) set as the organization's current consent text.
- 4 staff users, one per role, password "ChangeMe!2026" hashed with argon2id; print their emails at the end. Refuse to run with this password outside development (Q-28).
- 6 coding questions (2 EASY, 3 MEDIUM, 1 HARD) with original problem statements (do not copy LeetCode), Python/JavaScript/Java starter code, a reference solution per language, 3 sample and 8 hidden test cases each, and 3 variants each with params. Where a variant's params change inputs or outputs, add its variant_test_cases rows (ADR 0007); statement and reference solution may use Mustache placeholders.
- For each coding question, 6 AI reference solution rows (2 assistants x Python, JavaScript, Java), clearly labelled as synthetic seed data.
- 1 MCQ question and 1 short-answer question (answer_spec with an answer and accepted variants).
- 2 tests: "Backend Engineer Screen" (STANDARD, 60 min, 2 sections, one with a 20-minute limit) and "Senior Engineer Screen" (STRICT, 90 min, random pick rules). No LOCKDOWN profile exists.
- 5 candidates with invitations and sessions in different states (INVITED, CONSENTED, EXPIRED, DECLINED, COMPLETED); every session row carries org_id. 3 completed sessions with signed consents (pdf_key NULL in seed), session_sections, submissions, proctor events of mixed severity with their event batches, a risk score in each band, and one completed review. Every refresh token has a family_id.
The seed must be idempotent (safe to run twice).
Verify: `pnpm db:seed` twice without errors; counts per table printed.
```

## Step 5 — Data-access helpers and org scoping

```text
In apps/api create a PrismaService (NestJS) that builds its client with the factory from Step 2 (`@prisma/adapter-pg`, DATABASE_URL as app_user; ADR 0009), and a Prisma client extension (`$extends`; Prisma 7 removed `$use` middleware) that automatically adds `org_id` filtering for tables that have it, and throws if a query on an org-scoped model runs without an org context.
For every model without org_id, declare a scope path along its composition parent chain (ADR 0006 section 8.7) to an ancestor that has one (for example ProctorEvent -> session.orgId, TestCase -> questionVersion.question.orgId) and let the extension add that relation filter (ADR 0006). Add a test that fails if any model has neither org_id nor a scope path.
Add an OrgContext per unit of work on AsyncLocalStorage, not a Nest REQUEST-scoped provider, populated from the authenticated user (ADR 0001 C-1, amended 2026-10-05; ADR 0006 section 8).
Write unit tests proving that a user from org A cannot read org B rows through any repository method (reference TC-008).
Verify: tests pass.
```

## Step 6 — Retention and deletion jobs (database side)

```text
Read FR-704 and NFR-05 in /docs/fsd.md and Data rules in /docs/database.md.
Implement a RetentionService in apps/api that follows the retention rules in Data rules (ADR 0004): it finds sessions whose retention_anchor_at + organization retention_days has passed (a NULL anchor means hold: never eligible), returns the object storage keys to delete (media_chunks, identity_checks ID and selfie, proctor_events evidence, sessions report), and after deletion succeeds nulls those keys (and sets media_chunks.deleted_at) and deletes keystroke_batches in one transaction, writing one audit_logs row per session. The consent record and its signed PDF are kept.
Implement CandidateErasureService for deletion on request, following Data rules (D-19): the request sets candidates.erasure_requested_at; while any of the candidate's sessions has a review or appeal open and the org setting erasure.holdWhileReviewOrAppealOpen is true (default), erasure waits and the candidate is told; otherwise it deletes all objects (including consent PDFs), deletes media, identity, event and keystroke rows, blanks code and answers, removes free text about the candidate, and anonymizes the candidate, keeping only anonymized scores, risk and verdicts.
Do not call object storage here; take a storage interface as a dependency so it can be mocked.
Verify: unit tests for both services, including TC-072 and TC-094 (both the immediate case and the open-appeal hold).
```

## Step 7 — Backups and restore

```text
Create infra/scripts/backup.sh that runs pg_dump in custom format, gzips it, uploads it through the S3-compatible storage interface to a backup bucket named from env (Cloudflare R2 on staging; AWS S3 on pilot and production, so candidate data stays in AWS), and deletes backups older than 14 days. Create infra/scripts/restore.sh that restores a named backup into a fresh database.
Add a GitHub Actions workflow (scheduled nightly) that runs the backup against staging using repository secrets.
Verify: run backup then restore locally into a new database and compare row counts.
```

## Step 8 — Database verification

```text
Write an integration test suite (Jest + Testcontainers for Postgres) that:
- applies migrations to a fresh container,
- checks every table, enum and index from /docs/database.md exists,
- checks CHECK constraints reject bad data (duration_minutes 1, window_end before window_start, risk_score 101),
- checks cascade deletes behave as documented,
- checks audit_logs is append-only for app_user.
Verify: `pnpm test:db` passes in CI.
```
