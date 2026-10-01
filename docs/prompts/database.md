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

Stack: pnpm monorepo. apps/web (Next.js App Router, TypeScript, Tailwind, shadcn/ui), apps/api (NestJS, Prisma, PostgreSQL 16, Redis + BullMQ, Socket.IO), apps/worker (Python 3.12, FastAPI), packages/proctor-sdk, packages/shared (types + zod schemas). Judge0 CE for code execution. Cloudflare R2 for media. Docker Compose for local and staging.

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
Read /docs/database.md fully. Create prisma/schema.prisma that matches the reference DDL exactly: all 24 tables, all enums, all unique constraints, foreign keys with the same ON DELETE behavior, and all indexes.
Map names to snake_case with @@map and @map; use camelCase in the Prisma client.
Use @db.Uuid, @db.Citext, @db.Inet, @db.Timestamptz(6), and Decimal with the same precision as the DDL.
For the circular questions.current_version_id relation, model it as an optional relation with a named relation.
Do not invent columns. List any DDL feature Prisma cannot express (CHECK constraints, partial indexes, extensions) in a TODO list for Step 3.
Verify: `pnpm prisma validate` and `pnpm prisma format` pass.
```

## Step 3 — Migrations, including what Prisma cannot express

```text
Generate the initial migration with `prisma migrate dev --create-only --name init`.
Then edit the generated SQL to add everything from your Step 2 TODO list: the pgcrypto and citext extensions (at the top), all CHECK constraints from /docs/database.md, the partial index on sessions(risk_band), and a trigger that sets users.updated_at on update.
Create a second migration `audit_append_only` that creates a database role `app_user`, grants it SELECT/INSERT/UPDATE/DELETE on all tables, then REVOKEs UPDATE and DELETE on audit_logs from app_user.
Verify: `pnpm db:reset` applies both migrations cleanly; as app_user, `DELETE FROM audit_logs` fails with permission denied.
```

## Step 4 — Seed data

```text
Create prisma/seed.ts that inserts realistic development data:
- 1 organization "Demo Corp" with retention_days 90.
- 4 staff users, one per role, password "ChangeMe!2026" hashed with argon2id; print their emails at the end.
- 6 coding questions (2 EASY, 3 MEDIUM, 1 HARD) with original problem statements (do not copy LeetCode), Python/JavaScript/Java starter code, a reference solution per language, 3 sample and 8 hidden test cases each, and 3 variants each with params.
- 1 MCQ question.
- 2 tests: "Backend Engineer Screen" (STANDARD, 60 min, 2 sections) and "Senior Engineer Screen" (STRICT, 90 min, random pick rules).
- 5 candidates with invitations in different states, and 3 completed sessions with submissions, proctor events of mixed severity, a risk score in each band, and one completed review.
The seed must be idempotent (safe to run twice).
Verify: `pnpm db:seed` twice without errors; counts per table printed.
```

## Step 5 — Data-access helpers and org scoping

```text
In apps/api create a PrismaService (NestJS) and a Prisma client extension that automatically adds `org_id` filtering for tables that have it, and throws if a query on an org-scoped model runs without an org context.
Add a request-scoped OrgContext populated from the authenticated user.
Write unit tests proving that a user from org A cannot read org B rows through any repository method (reference TC-008).
Verify: tests pass.
```

## Step 6 — Retention and deletion jobs (database side)

```text
Read FR-704 and NFR-05 in /docs/fsd.md and Data rules in /docs/database.md.
Implement a RetentionService in apps/api that finds sessions older than their organization's retention_days, returns the R2 object keys to delete from media_chunks and identity_checks, nulls those keys in one transaction after deletion succeeds, and writes one audit_logs row per session.
Implement CandidateErasureService for deletion on request: removes candidate personal data, media keys and keystroke batches, keeping anonymized scores for statistics.
Do not call R2 here; take a storage interface as a dependency so it can be mocked.
Verify: unit tests for both services, including TC-072 and TC-094.
```

## Step 7 — Backups and restore

```text
Create infra/scripts/backup.sh that runs pg_dump in custom format, gzips it, uploads it to an R2 bucket named from env, and deletes backups older than 14 days. Create infra/scripts/restore.sh that restores a named backup into a fresh database.
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
