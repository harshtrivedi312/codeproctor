# ADR 0006: Org scoping, cross-tenant integrity, database roles and indexes

| Field | Value |
| --- | --- |
| Status | **Accepted** 2026-10-01 (D-16): every recommendation as proposed. No amendment from D-17..D-23 beyond the tables they add, which carry or inherit `org_id` (section 1). Applied to database.md; deltas in ADR 0008. **Amended 2026-10-02 (D-35):** section 7 replaces "roles are created outside the migrations" in section 3; the rest of section 3 stands. **Proposed amendment 2026-10-05 (DB-05 review):** section 8, for the owner to accept. |
| Author | architect |
| Decides | Q-10, Q-15, A-07, A-22 (index list for the freeze list), Q-17 (doc hygiene) |
| Serves | FR-103, FR-105; NFR-01, NFR-04; TC-006, TC-008 |
| Hands off | Worker database access: ARC-04 (OI-1). Role creation on the pilot and production hosts: ARC-05 and the pilot stack task (PA-07). |

## 1. Org scoping (Q-10)

- (a) **Accepted.** Put `org_id` on the two hub tables of the candidate path: `sessions.org_id uuid NOT NULL REFERENCES organizations(id)` and `invitations.org_id uuid NOT NULL REFERENCES organizations(id)`.
  - New tables from ADRs 0002 to 0007 follow the same rule. `consent_texts` and `webhook_endpoints` carry `org_id`. `session_sections`, `variant_test_cases`, `ai_reference_solutions`, `proctor_event_batches` and `webhook_deliveries` declare scope paths.
  - Every other table without `org_id` declares a scope path to its nearest ancestor that has one (for example ProctorEvent → session.orgId, TestCase → questionVersion.question.orgId).
  - DB-05's Prisma extension adds the filter from that map.
  - A test fails if any model has neither `org_id` nor a scope path, like the permission-matrix test.
  - Candidate routes scope through the token's session, and jobs through the job's session (ADR 0001 C-1).
- (b) Postgres row-level security with a per-request `SET app.org_id`. It is the strongest guard, but with Prisma it needs a transaction per request and complicates pooling. Not for the pilot.
- (c) Parent-chain joins only, no DDL. Hot candidate routes then pay multi-hop joins (NFR-01), and every child query depends on a hand-written join.

## 2. Cross-tenant writes (A-07)

**Accepted.**
- (i) Service rule: every foreign ID in a create or update payload is first loaded through the org-scoped client, and a miss returns 404 (TC-008). Each module has tests for it, and code-reviewer checks it.
- (ii) Composite foreign keys on the delivery chain, now that `org_id` is there. They replace the single-column foreign keys on these columns:

```sql
ALTER TABLE tests       ADD UNIQUE (id, org_id);
ALTER TABLE candidates  ADD UNIQUE (id, org_id);
ALTER TABLE invitations ADD UNIQUE (id, org_id);
-- invitations: FOREIGN KEY (test_id, org_id)       REFERENCES tests (id, org_id)
--              FOREIGN KEY (candidate_id, org_id)  REFERENCES candidates (id, org_id)
-- sessions:    FOREIGN KEY (invitation_id, org_id) REFERENCES invitations (id, org_id)
```

Staff references (`reviewer_id`, `assigned_to`, `created_by`, `reviewed_by`, `collected_by`) and `test_questions.question_version_id` rely on rule (i).

Alternative: rule (i) only, with no composite foreign keys.

## 3. Database roles (Q-15)

**Accepted:**
- Two roles.
  - An owner role owns the schema and runs migrations. It is the host's admin role or a dedicated `codeproctor_owner`.
  - `app_user` has DML only and cannot UPDATE, DELETE or TRUNCATE `audit_logs`.
- Roles are created outside the migrations, once per environment, by `infra/sql/roles.sql` with the password taken from the vault.
  - Role creation differs between hosts (RDS, Postgres on EC2, Supabase or Neon), and it is not verified on each.
  - The local compose init script runs the same file.
- The `audit_append_only` migration only grants. It fails if `app_user` does not exist.
  - `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user`
  - `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user`
  - `ALTER DEFAULT PRIVILEGES FOR ROLE <owner> IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user`, which covers future tables
  - `REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM app_user`
- Two connection URLs.
  - `DATABASE_URL` uses `app_user` at runtime.
  - `MIGRATION_DATABASE_URL` uses the owner role and is used only by `prisma migrate` in deploy jobs and local development.

Alternative: the migration creates the role, as database prompt Step 3 says. This works locally, but it may fail on managed hosts and puts a password into migration history.

## 4. Foreign-key and query indexes (A-22), for the freeze list

- **Add:**
  - `invitations (test_id)`, `invitations (candidate_id)`
  - `session_questions (session_id)`
  - `refresh_tokens (user_id)` (ADR 0003)
  - `test_cases (question_version_id)`, `question_variants (question_version_id)`
  - `test_sections (test_id)`, `test_questions (section_id)`
  - `sessions (org_id, status)`, `users (org_id)`, `tests (org_id)`
  - `session_reviews (reviewer_id)`, `appeals (assigned_to)`
- **Already covered** by a key proposed elsewhere:
  - `identity_checks (session_id, attempt)` (ADR 0004)
  - `appeals (session_review_id)` (ADR 0002)
  - `sessions (retention_anchor_at)` partial index (ADR 0004)
  - `refresh_tokens (family_id)` (ADR 0003)
  - The indexes on the new tables (ADRs 0002, 0005, 0007)

## 5. Doc hygiene (Q-17)

Applied in Phase B. No schema change.
- ERD: `totp_secret` becomes `totp_secret_enc`. `invitations ||--o| sessions` and `sessions ||--o| consents` (A-21 item 5).
- Data rules, first line, becomes: "Tables with `org_id`: users, questions, tests, candidates, invitations, sessions, audit_logs, consent_texts and webhook_endpoints. Every other table is scoped through its declared parent path. Every API query filters by the caller's `org_id`." Applied to database.md on 2026-10-01.

## 6. Consequences and affected agents

- **Accepted delta:** `org_id` on `sessions` and `invitations`, 3 UNIQUE (id, org_id) constraints, 3 composite foreign keys, 13 indexes, and a roles script outside the migrations.
- **db-engineer:** DB-02, DB-03 (grants, not role creation), DB-05 (scope map and completeness test), DB-08 (verify the grants and that `app_user` cannot TRUNCATE `audit_logs`).
- **backend-engineer:** BE-01 (two database URLs), BE-03 to BE-14 (rule (i) on every write).
- **code-reviewer:** checks rule (i).
- **Deploy (DEP-01, PA-07):** run `roles.sql` per environment.
- **Doc amendments (applied in Phase B):** database prompt Step 3 (the role is created outside the migration) and Step 5 (scope paths for tables without `org_id`); database.md Data rules and ERD (Q-17).

## 7. Amendment 2026-10-02 (D-35): `app_user` is created by a migration

**Why.** Postgres init scripts run only when the data volume is empty (review N14). The DB-01 volume already exists, so an init-mounted `infra/sql/roles.sql` would never run there. The owner decided that DB-03 creates the role in a migration (D-35).

### 7.1 Decision

- No `infra/sql/roles.sql` and no compose init mount.
- The `audit_append_only` migration:
  1. creates `app_user` if it does not exist, with no password;
  2. then grants and revokes.
- The password is set outside migrations, per environment (7.4).
- Unchanged from section 3:
  - the two roles;
  - DML-only `app_user` that cannot UPDATE, DELETE or TRUNCATE `audit_logs`;
  - the two URLs.
- Additions, chosen by the architect for the owner to confirm:
  - explicit USAGE on schema `public`;
  - default privileges for sequences;
  - no access to `_prisma_migrations`;
  - no `FOR ROLE <owner>` clause.

### 7.2 The migration SQL (DB-03 uses it as written)

```sql
-- audit_append_only: app_user, grants and the append-only audit log (ADR 0006 section 7, D-35).
-- No password in any migration. The password is set outside migrations (ADR 0006 section 7.4).

-- 1. app_user is created once per cluster, and skipped when it already exists.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'app_user') THEN
    BEGIN
      CREATE ROLE app_user LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    EXCEPTION
      WHEN duplicate_object THEN
        NULL; -- created by a concurrent run, for example a shadow database
      WHEN insufficient_privilege THEN
        RAISE EXCEPTION 'app_user does not exist and role % cannot create roles. Create app_user at provisioning (ADR 0006 section 7.5), then rerun prisma migrate deploy.', current_user;
    END;
  END IF;
END
$$;

-- 2. Grants on what exists now. USAGE is explicit because a reset recreates schema public
--    without PUBLIC's default USAGE (ADR 0009 section 5, P12).
GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;

-- 3. Defaults for tables and sequences that later migrations create. No FOR ROLE: they apply to
--    the role running this migration, which runs every migration (MIGRATION_DATABASE_URL).
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_user;

-- 4. Append-only audit log, and no access to Prisma's migration history.
REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM app_user;
DO $$
BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    REVOKE ALL ON TABLE public._prisma_migrations FROM app_user;
  END IF;
END
$$;
```

**Rule for later migrations.**
- Every migration in an environment runs as the same role. If that role ever changes, a new migration repeats steps 2 to 4 for the new role.
- A migration that recreates `audit_logs` must repeat the REVOKE. DB-08 tests it.

### 7.3 Safe wherever migrations run

Roles belong to the whole Postgres cluster, not to one database. So the `IF NOT EXISTS` check covers every case below.

| Where | What happens | Why it is safe |
| --- | --- | --- |
| `migrate dev` shadow database (local, temporary, same server) | Both migrations replay into a temporary database | If `app_user` exists, the block skips. If not, the shadow run creates it with no password, and the main database then skips. The shadow's grants are dropped with the shadow database. Needs CREATEDB, which the local owner role has. |
| Existing local volume (the DB-01 volume, no role yet) | `pnpm db:migrate` applies both migrations | The role is created by the migration, and the local script sets its password (7.4). |
| Fresh local volume | Same | Same |
| `pnpm db:reset`, run by a human only (ADR 0009 section 4.4) | Prisma drops and recreates the schema and replays the migrations | The role and its password survive, because they belong to the cluster. Schema USAGE, grants and default privileges are re-applied by the migration. |
| DB-08 Testcontainers | `prisma migrate deploy` into a new container | The role is created; the test sets a random password for that run |
| Staging, pilot, production | `prisma migrate deploy` from the deploy job with `MIGRATION_DATABASE_URL` | Creates `app_user` if the migration role can create roles. Otherwise it fails with the clear message, and provisioning creates the role first (7.5). |
| `migrate diff --from-migrations` (optional drift check) | Replays into a shadow database | `_prisma_migrations` may not exist there; step 4 checks for it |

### 7.4 Setting the password (never in migration history)

| Environment | Who | How |
| --- | --- | --- |
| Local | `infra/scripts/set-app-user-password.mjs` (DB-03). It runs after migrations in `db:migrate` and `db:reset`, and starts with the localhost guard (`infra/scripts/local-db-guard.mjs`), refusing on any problem. | Reads `APP_USER_PASSWORD` from the shell or `.env`. Connects with the `pg` client, not psql, as the owner role through `MIGRATION_DATABASE_URL`. Runs `ALTER ROLE app_user WITH PASSWORD …` with the value quoted by `client.escapeLiteral`. The value is never on a command line and never printed; the script prints only "app_user password set". Idempotent. (Amended after the DB-01 second review, SF6.) |
| Staging | DEP-01 provisioning, run on the server or in a GitHub Actions job, never from a developer machine or an agent session (D-38) | After the first `migrate deploy` (or before it, on a host where the migration role cannot create roles), set the password from the vault. Use psql `\password app_user`, which encrypts on the client, so the cleartext never reaches history or the server log. Or use `ALTER ROLE app_user PASSWORD 'SCRAM-SHA-256$…'` with a verifier computed in the job; Postgres stores a SCRAM verifier as given. Then store the `app_user` `DATABASE_URL` in the vault: GitHub Actions secrets and the server only (D-38). |
| Pilot | DEP-03 | Same as staging, with a pilot-only password (D-10). |
| Production | Production deploy; DEP-02 checks it | Same as staging. |

**Rotation.** Run the same command, update the vault, restart the API. The API's environment never holds `MIGRATION_DATABASE_URL`.

### 7.5 Managed hosts (checked 2026-10-02)

| Host | Can the migration role create `app_user`? | Status |
| --- | --- | --- |
| AWS RDS for PostgreSQL 16 | **Yes, as the master user.** It is created as `LOGIN NOSUPERUSER INHERIT CREATEDB CREATEROLE` and is a member of `rds_superuser`, which can "create roles for users and grant privileges". A dedicated `codeproctor_owner` would need CREATEROLE from the master, or the master creates `app_user` first. In PG 16, a CREATEROLE non-superuser gets ADMIN OPTION on roles it creates, so it can later change their passwords. If the master creates `app_user`, the master sets its password. | Verified. Sources: [RDS roles](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Appendix.PostgreSQL.CommonDBATasks.Roles.html), [rds_superuser](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Appendix.PostgreSQL.CommonDBATasks.Roles.rds_superuser.html) (not version-specific); [PG 16 role attributes](https://www.postgresql.org/docs/16/role-attributes.html) |
| Postgres on EC2 | Yes. We hold the superuser. | By construction |
| Supabase (staging only) | **Probably.** `postgres` is "not a superuser" but runs `create role … login password …` in Supabase's own examples. Whether it has the CREATEROLE attribute is not stated. | Partly verified. Sources: [Supabase roles](https://supabase.com/docs/guides/database/postgres/roles), [Supabase blog](https://supabase.com/blog/postgres-roles-and-privileges) |
| Neon (staging only) | **Yes, as the default owner role** (for example `neondb_owner`). It is in `neon_superuser`, with CREATEROLE and CREATEDB. Roles created by SQL get only basic public-schema privileges, which is what `app_user` needs. Passwords need at least 60 bits of entropy. Roles are per branch. | Verified. Sources: [Neon roles](https://neon.com/docs/manage/roles), [Neon database access](https://neon.com/docs/manage/database-access) |

**Not verified; DEP-01 or ARC-05 check these:**
- Supabase's own default privileges may expose new `public` tables to `anon` and `authenticated` through its Data API. If Supabase is chosen, revoke those or turn the Data API off.
- `migrate deploy` needs a direct (not pooled) connection on Supabase and Neon.
- The RDS setting `rds.restrict_password_commands`.

### 7.6 What changes in earlier text

- **Superseded in this ADR:**
  - Section 3, bullets 2 and 3: roles outside the migrations, `roles.sql`, the compose init, and "the migration only grants".
  - Section 6: "a roles script outside the migrations", "DB-03 (grants, not role creation)", and "Deploy: run `roles.sql`".
  - The section 3 "Alternative" warned about passwords in migration history and about managed hosts. Sections 7.4 and 7.5 answer both concerns.
- **Updated the same day:**
  - ADR 0008 section 8 (amendment note);
  - database.md, the roles comment block;
  - prompts/database.md Step 3;
  - build-plan DB-03, DEP-01, DEP-03 and ARC-05;
  - briefs DB-01, DB-02 and the new DB-03.
- **db-engineer, on `db/step-1`:**
  - the `.env.example` comments on `APP_USER_PASSWORD` and `DATABASE_URL`;
  - the `infra/docker-compose.yml` header comment, which mentions an init script.

### 7.7 Agents affected

- **db-engineer:**
  - DB-03 writes 7.2 and the local password script.
  - DB-08 asserts every grant above, including no access to `_prisma_migrations` and no CREATE on `public`.
- **backend-engineer:** DEP-01, DEP-03 and production set the password per 7.4, and create `app_user` first only where 7.5 says the migration role cannot.
- **architect:** ARC-05 confirms the migration role on the chosen pilot and production host.
- **code-reviewer:** rejects any password, or any `infra/sql/roles.sql`, in a PR.

## 8. DB-05 review decisions

**Status: Proposed amendment 2026-10-05, for the owner to accept.** It comes from the DB-05 architect gate (PR #30) and the Delivery Lead. Until the owner accepts it, sections 1 to 7 stand as written. Serves FR-103, FR-105, NFR-01 and NFR-04; TC-006 and TC-008. Candidate session scope (token to session to `runInOrg`) is not decided here: ADR 0013 covers it (proposed, PR #39), with ADR 0001 C-1.

### 8.1 Foreign-key classification

The init migration has 58 foreign keys. Nine are the `org_id` columns of the `direct` tables. The other 49 fall into three classes:

| Class | Count | Foreign keys |
| --- | --- | --- |
| Scope first hop | 21 | The first relation of each scope path in the DB-05 scope map, one per `path` model (for example `proctor_events.session_id`, `test_cases.question_version_id`, `webhook_deliveries.endpoint_id`) |
| Composite (section 2 ii) | 3 | `invitations (test_id, org_id)`, `invitations (candidate_id, org_id)`, `sessions (invitation_id, org_id)` |
| Rule (i) references | 25 | **12 staff references:** `audit_logs.actor_id`, `questions.created_by`, `ai_reference_solutions.collected_by`, `tests.created_by`, `invitations.created_by`, `session_questions.scored_by`, `consent_texts.created_by`, `identity_checks.reviewed_by`, `session_reviews.reviewer_id`, `flag_decisions.reviewer_id`, `appeals.assigned_to`, `webhook_endpoints.created_by`. **13 cross-chain references:** `organizations.current_consent_text_id`, `refresh_tokens.replaced_by`, `questions.current_version_id`, `variant_test_cases.test_case_id`, `ai_reference_solutions.variant_id`, `test_questions.question_version_id`, `session_sections.section_id`, `session_questions.test_question_id`, `session_questions.question_version_id`, `session_questions.variant_id`, `consents.consent_text_id`, `keystroke_batches.session_question_id`, `webhook_deliveries.session_id` |

- This replaces the shorter list at the end of section 2, which named only five staff columns and `test_questions.question_version_id`.
- The rule (i) list lives in code as `RULE_I_REFERENCES` (FU-DB-64). A test fails on any foreign key that is in none of the three classes, so a new foreign key must be classified in the PR that adds it.

### 8.2 Write invariant

- An org-scoped write changes only the rows its filter selected, or the rows it creates.
- The extension refuses, on the parent side, a nested `connect`, `set`, `connectOrCreate`, or a nested create or update that names another org (FU-DB-63).
- A child-side `connect` (the child holds the foreign key) stays under rule (i): load the target through the scoped client first, answer 404 on a miss.

### 8.3 Schema and row-level security

- No schema change for the build or the pilot (Delivery Lead decision).
- FU-DB-77 stays open as a pre-production item for ARC-05 and DEP-02: revisit Postgres RLS on `org_id` (section 1, option b).

### 8.4 System scope

Three closed reasons. A new reason needs an amendment to this ADR.

| Reason | Allowed for |
| --- | --- |
| `AUTH_BOOTSTRAP` | Staff lookups before login, and resolving a candidate token. Narrow to `runAsUser` or `runInOrg` as soon as the org is known. |
| `BACKGROUND_JOB` | Scheduled discovery across orgs only. Job payloads carry `orgId` and `sessionId`, and the processor runs the work inside `runInOrg`. |
| `RETENTION_ERASURE` | Selecting what is due only. DB-06 deletes each session inside `runInOrg`. |

- `runSystem` is refused inside an org scope. Narrowing from system scope to an org scope is allowed.
- There is no org-provisioning reason (8.9).

### 8.5 Raw SQL

- Raw SQL is refused unless it runs inside `runRawSql(reason)`, and `runRawSql` requires an active scope (system or org).
- Model queries inside `runRawSql` stay scoped.
- In an org scope, the SQL itself must filter by `org_id`.
- An allow-list test of every `runSystem`, `runInOrg` and `runRawSql` call site lands with FU-DB-58 (BE-03). A new call site updates the list, and code-reviewer checks it.

### 8.6 Organization

- `organizations` rows are created and deleted only in system scope.
- `organizations.id` is immutable.

### 8.7 Path rule

- A scope path follows the composition parent, the owner in the database.md ERD.
- It never follows a staff or cross-chain reference, and it is not chosen by hop count.
- Example: `AiReferenceSolution` is scoped through its question version (`questionVersion.question.orgId`), not through `collectedBy`.

### 8.8 Runtime checks

- **Readiness role assertion (FU-DB-66, before DEP-01).**
  - The readiness check asserts `current_user = 'app_user'`, and that the role has no SUPERUSER, BYPASSRLS, CREATEROLE or CREATEDB and does not own schema `public`.
  - It is a readiness check, not a blocking startup query.
  - It logs which flags failed, never the connection URL.
- **Interceptor (FU-DB-65).** A malformed `request.user` (it reaches the interceptor only after the guard has passed) is a server fault and answers 500, not 401.

### 8.9 Pilot org provisioning (FU-DB-76, ARC-05 and DEP-03)

- Pilot orgs are created outside the API by a CLI built on the client factory, like the seed.
- There is no API route and no system-scope reason for it.
- If self-serve or platform-admin org creation is ever needed, add `ORG_PROVISIONING` through an amendment to this ADR.

### 8.10 Consequences and agents affected

- **Positive:** the scope rules are closed and testable (FK classification, call-site allow-list, readiness check), with no schema change before the pilot.
- **Negative:** rule (i) stays a service-level guard for 25 foreign keys until RLS is revisited (FU-DB-77).
- **db-engineer:** DB-05 or its follow-ups implement 8.1 (`RULE_I_REFERENCES` and its test), 8.2 (FU-DB-63), 8.5 (`runRawSql` requires a scope), 8.6, 8.8 (FU-DB-65, FU-DB-66) and the pilot CLI in 8.9.
- **backend-engineer:** uses only the three reasons in 8.4; jobs carry `orgId` and `sessionId`; lands the call-site allow-list with FU-DB-58 (BE-03); DB-06 and the retention job follow 8.4.
- **code-reviewer:** checks 8.1 classification for every new foreign key, every new `runSystem`, `runInOrg` and `runRawSql` call site, and the path rule in 8.7.
- **qa:** TC-008 evidence lives in `apps/api/src/database/tc-008-org-isolation.spec.ts` (FU-DB-59); see docs/followups/qa.md for the P1 gate gap.
