# ADR 0006: Org scoping, cross-tenant integrity, database roles and indexes

| Field | Value |
| --- | --- |
| Status | **Accepted** 2026-10-01 (D-16): every recommendation as proposed. No amendment from D-17..D-23 beyond the tables they add, which carry or inherit `org_id` (section 1). Applied to database.md; deltas in ADR 0008. **Amended 2026-10-02 (D-35):** section 7 replaces "roles are created outside the migrations" in section 3; the rest of section 3 stands. **Proposed amendment 2026-10-05 (DB-05 review):** section 8, for the owner to accept (pending D-xx). |
| Author | architect |
| Decides | Q-10, Q-15, A-07, A-22 (index list for the freeze list), Q-17 (doc hygiene) |
| Serves | FR-103, FR-105; NFR-01, NFR-04; TC-006, TC-008 |
| Hands off | Worker database access: ARC-04 (OI-1). Role creation on the pilot and production hosts: ARC-05 and the pilot stack task (PA-07). |

## 1. Org scoping (Q-10)

- (a) **Accepted.** Put `org_id` on the two hub tables of the candidate path: `sessions.org_id uuid NOT NULL REFERENCES organizations(id)` and `invitations.org_id uuid NOT NULL REFERENCES organizations(id)`.
  - New tables from ADRs 0002 to 0007 follow the same rule. `consent_texts` and `webhook_endpoints` carry `org_id`. `session_sections`, `variant_test_cases`, `ai_reference_solutions`, `proctor_event_batches` and `webhook_deliveries` declare scope paths.
  - Every other table without `org_id` declares a scope path along its composition parent chain to an ancestor that has one (section 8.7; for example ProctorEvent → session.orgId, TestCase → questionVersion.question.orgId). *Wording amended 2026-10-05 (proposed, owner to accept): was "to its nearest ancestor".*
  - DB-05's Prisma extension adds the filter from that map.
  - A test fails if any model has neither `org_id` nor a scope path, like the permission-matrix test.
  - Candidate routes scope through the token's session. Session jobs scope through the job's session, and cross-session jobs run in `runInOrg` (ADR 0001 C-1; section 8.4). *Wording amended 2026-10-05 (proposed): was "jobs through the job's session".*
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

Staff references (`reviewer_id`, `assigned_to`, `created_by`, `reviewed_by`, `collected_by`) and `test_questions.question_version_id` rely on rule (i). (Superseded by section 8.1, proposed 2026-10-05.)

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

**Status: Proposed amendment 2026-10-05, for the owner to accept. Decision id: pending D-xx**, assigned in status.md when the owner accepts.
- Source: the DB-05 architect gate (PR #30) and the Delivery Lead.
- **Built and planned.** "Built" means present in main at 7c5d2e0, where PR #30 (DB-05) is merged. "Planned" means work that is not built yet, with its follow-up in docs/followups/database.md. Section 8.0 lists each item.
- Until the owner accepts it, sections 1 to 7 stand as written.
- Serves FR-103, FR-105, NFR-01 and NFR-04; TC-006 and TC-008.
- Candidate session scope (from the candidate token to its session) is decided in ADR 0013 section 5.10 (proposed, PR #39), with ADR 0001 C-1. This section states only how it meets the org scope (8.4, 8.5).

Each item is tagged:
- **(owner decision)** when the owner or the Delivery Lead decided it. The Delivery Lead's three decisions are also pending a D-xx id: nested writes denied by default (8.2), no schema change (8.3), and provisioning by CLI (8.9).
- **(architect detail)** when the architect chose it for the owner to confirm.

### 8.0 As built in main and planned

DB-05 (PR #30) is merged into main at 7c5d2e0. The code, the README (`apps/api/src/database/README.md`) and the error messages cite this section. "Built" below means present in main at 7c5d2e0. "Planned" means not built yet; the follow-up is in docs/followups/database.md. When the code differs from a rule here, the row says "as built" and lists the delta for the db-engineer, rather than changing the rule silently (FU-DB-105).

| Item | Status in main (7c5d2e0) |
| --- | --- |
| Foreign-key classification, 8.1 (`FK_CLASSES` 58: ORG_ID 9, SCOPE_HOP 21, COMPOSITE 3, RULE_I 25; `RULE_I_REFERENCES`) and the relation side table with its completeness test against `schema.prisma` (FU-DB-64, FU-DB-103) | Built |
| Nested relation writes denied by default, in org scope and system scope, with an empty `NESTED_WRITE_ALLOWLIST` and a unit test that fails while it is not empty (8.2; FU-DB-94, FU-DB-98, FU-DB-101) | Built |
| Nested cursors refused; top-level cursors scoped (8.2; FU-DB-93) | Built |
| Scalar `orgId` rule in an org scope, on every create and update operation (8.2) | Built |
| System scope: any `orgId` refused in `update`, `updateMany`, `updateManyAndReturn` and `upsert.update` on a direct model; an Organization keeps its id in every scope (8.2; FU-DB-104) | Built |
| System scope: an unrecognised write operation throws | **Planned.** As built, system scope checks only the known writes and then runs the query; an unknown operation passes through. Delta for the db-engineer: refuse it, as the org scope already does (fail closed, with `OPERATION_COVERAGE`). |
| `createMany` and `createManyAndReturn` rows are not walked; Prisma rejects relation keys there | As built. The test is planned (FU-DB-106). |
| Three closed system reasons; `runSystem` refused inside an org scope; org switch refused (8.4) | Built |
| Actor in the scope, `runAsCandidate`, `runAsSessionJob`, `detachForSessionJob`, the candidate-facts setter and the full 8.4 transition table | Planned (ADR 0013 CS-4; BE-07, BE-08) |
| `runRawSql` requires a scope (8.5) | Built |
| An open `runRawSql` hatch carries into nested scopes (8.5) | **As built**, and documented in the README as limit (e). Planned: the hatch does not carry into nested scopes, and never into a session scope. |
| Raw SQL refused in a `sessionId` scope; the advisory-lock call site; `withGrant`; `guardLive`; `lockForAccommodation`; `lockAnySession` (8.5) | Planned (no session scopes exist yet) |
| FU-DB-67 call-site allow-list (`runSystem`, `runInOrg`, `runRawSql`, the session entries, the store methods, the grant sites) | Planned |
| Importer guard (`import-guard.spec.ts`) | **Built**, for `create-prisma-client` (only `prisma.service.ts` and the interim `prisma.module.ts`), `prisma.module` and `PG_POOL`. It scans `apps/api/src` only, so the seed and a CLI outside it are not covered. Planned: add the provisioning CLI and the candidate-write client (8.6). |
| `Organization`: create refused in an org scope | Built |
| `Organization`: delete refused in an org scope (FU-DB-68); full deny by default in every scope; updates only in a STAFF scope (8.6) | Planned. As built, an org scope may delete its own organization row, and system scope may create, upsert or delete one. |
| Candidate-write client with pool options on `PrismaPg` and the widened factory `createPrismaClient(connectionString, poolOptions?)` (8.6) | Planned. As built, the factory takes only a connection string. |
| Readiness role assertion on each pool (8.8; FU-DB-66) | Planned |
| Interceptor answers 500 for a malformed `request.user` (8.8; FU-DB-65) | Planned. As built, it answers 401. |
| `errorFormat: 'minimal'` in the factory (ADR 0009 section 4.2; FU-DB-70) | Planned. As built, the factory does not set it. |
| Pilot provisioning CLI (8.9; FU-DB-76) | Planned |

### 8.1 Foreign-key classification (architect detail)

The init migration has 58 foreign keys. Nine are the `org_id` columns of the `direct` tables. The other 49 fall into three classes:

| Class | Count | Foreign keys |
| --- | --- | --- |
| Scope first hop | 21 | The first relation of each scope path in the DB-05 scope map, one per `path` model (for example `proctor_events.session_id`, `test_cases.question_version_id`, `webhook_deliveries.endpoint_id`) |
| Composite (section 2 ii) | 3 | `invitations (test_id, org_id)`, `invitations (candidate_id, org_id)`, `sessions (invitation_id, org_id)` |
| Rule (i) references | 25 | **12 staff references:** `audit_logs.actor_id`, `questions.created_by`, `ai_reference_solutions.collected_by`, `tests.created_by`, `invitations.created_by`, `session_questions.scored_by`, `consent_texts.created_by`, `identity_checks.reviewed_by`, `session_reviews.reviewer_id`, `flag_decisions.reviewer_id`, `appeals.assigned_to`, `webhook_endpoints.created_by`. **13 cross-chain references:** `organizations.current_consent_text_id`, `refresh_tokens.replaced_by`, `questions.current_version_id`, `variant_test_cases.test_case_id`, `ai_reference_solutions.variant_id`, `test_questions.question_version_id`, `session_sections.section_id`, `session_questions.test_question_id`, `session_questions.question_version_id`, `session_questions.variant_id`, `consents.consent_text_id`, `keystroke_batches.session_question_id`, `webhook_deliveries.session_id` |

- This replaces the shorter list at the end of section 2, which named only five staff columns and `test_questions.question_version_id`.
- **Built in main (FU-DB-64).**
  - The classes are in code: `FK_CLASSES` and `RULE_I_REFERENCES` in `apps/api/src/database/org-scope-relations.ts`.
  - `org-scope-relations.spec.ts` asserts `{ ORG_ID: 9, SCOPE_HOP: 21, COMPOSITE: 3, RULE_I: 25, total: 58 }`.
  - It fails for a key that is missing, unclassified, classified twice or in the wrong class. So a new foreign key must be classified in the PR that adds it.
- Rule (i) proves only that the target is in the same org. It does not prove that a cross-chain target belongs to the same parent: for example `variant_test_cases.test_case_id` and `variant_id` may point to different question versions. Tracked in docs/followups/architecture.md.
- **Proposed change (ADR 0015, PR #49).** `identity_checks.video_check_by` would be a new staff rule (i) reference. Staff references would go from 12 to 13, `RULE_I` from 25 to 26, and the total from 58 to 59. `FK_CLASSES`, `RULE_I_REFERENCES` and the count test change in the PR that adds the column.

### 8.2 Write invariant (architect detail; nested writes: owner decision, Delivery Lead, pending D-xx)

- An org-scoped write changes only the rows its filter selected, or the rows it creates.

**Nested writes are denied by default.** This is the Delivery Lead's decision (DL-14). It is built in main (7c5d2e0), whose code, README and error messages cite this section ("ADR 0006 §8, deny-by-default").
- **Scopes:** every scope the extension applies to: org scopes (STAFF, plain org, SERVICE, CANDIDATE) and system scope.
  - ADR 0013 CS-4.5 uses this same list for CANDIDATE scope.
  - *For the Delivery Lead:* the DL-14 text in docs/status.md says "every org scope". The code and this ADR also cover system scope, so DL-14 should be aligned. The architect does not edit status.md.
- **What is refused:** every nested relation write inside the `data` of `create`, `update`, `updateMany` and `upsert` (and their `*AndReturn` forms). It is refused at the first level, which blocks any deeper nesting.
  - Operations: `connect`, `connectOrCreate`, `create`, `createMany`, `update`, `updateMany`, `upsert`, `delete`, `deleteMany`, `set` and `disconnect`.
  - Relations: every relation class (`ORG_ID`, `SCOPE_HOP`, `COMPOSITE`, `RULE_I`), on both sides, including `org: { connect }`. A relation key whose value is `null` or `{}` is refused too.
  - As built, the guard looks only at the first level of `data` (`assertNoNestedWrites` in `org-scope-nested.ts`). Any relation key there is refused, so nothing deeper can be reached.
  - The error, `OrgScopeViolationError`, names the model, relation and operation, never a value.
  - The check adds no query. It looks up each key of `data` in the relation side table in `apps/api/src/database/org-scope-relations.ts` (FU-DB-103).
    - That table covers 116 relation fields, on both sides of the 58 foreign keys.
    - A completeness test checks it against `schema.prisma`.
    - Production code does not read Prisma's internal runtime data model (FU-DB-61).
    - So a relation `set` is refused, while a scalar-list `{ set }` and Json columns are not relation writes and stay allowed.
- **Allowlist:** `NESTED_WRITE_ALLOWLIST` starts empty. Adding an entry needs all of the following (FU-DB-101):
  - a named pattern (model, relation field, operations and reason);
  - its own cross-org Postgres test;
  - code-reviewer plus architect review.
- **How services write instead:**
  - They write scalar foreign keys through Prisma's unchecked inputs (`XUncheckedCreateInput`, `XUncheckedUpdateInput`), one top-level scoped call per row.
  - The COMPOSITE keys (`invitations.test_id`, `invitations.candidate_id`, `sessions.invitation_id`) are written only as scalars. The composite foreign key then rejects another org's parent with P2003.
- **`createMany` and `createManyAndReturn`:** the guard does not walk their rows (as built). Prisma's own validation rejects relation keys there. The test is planned (FU-DB-106).
- **Why:** each relation class had a hole, shown on Prisma 7 against Postgres (the database README and `tc-008-org-isolation.spec.ts`):
  - a parent-side `connect` moves another org's row in;
  - a `RULE_I` nested `update` writes a user in another org;
  - a COMPOSITE `connect` copies `org_id` from the connected row, which moves the row across orgs;
  - a to-one `connect` combined with a write rewrites another org's row.

  Denying every shape closes the whole class at zero query cost, and it does not have to be re-proven on every Prisma release.
- **Unchanged:**
  - scalar fields and scalar foreign keys;
  - scalar-list `{ set }`;
  - Json columns;
  - flat `createMany`;
  - nested reads without a cursor (FU-DB-78, below);
  - nested cursors refused, and top-level cursors scoped;
  - the 58-key foreign-key classification, kept as the rule (i) checklist.
- **Built in main (7c5d2e0):**
  - deny by default, in org scope and in system scope (FU-DB-94, FU-DB-98), with an empty allowlist;
  - an `Organization`'s `id` cannot change, in any scope;
  - in system scope, `orgId` cannot change on update (FU-DB-104).
- **Planned:**
  - the `createMany` relation-key test (FU-DB-106);
  - an unrecognised write operation throwing in system scope (below).
- **DB-05 merge gate: satisfied in 7c5d2e0.** All four items are built:
  - deny by default;
  - its application in system scope;
  - the COMPOSITE `connect` test;
  - the system-scope refusal of `orgId` in `update`, `updateMany`, `updateManyAndReturn` and `upsert.update`.

  BE-03 and BE-06 may write invitation and session code.

**No write moves a row to another org.**
- With nested relation writes refused, the remaining path is a scalar `orgId`.
- **Write operations covered.** Every create and update operation: `create`, `createMany`, `createManyAndReturn`, `update`, `updateMany`, `updateManyAndReturn`, and `upsert` (both branches). Any write operation the extension does not recognise throws, in every scope. As built, this holds in an org scope only (fail closed, with `OPERATION_COVERAGE`). In system scope it is planned (8.0).
- **In an org scope** (built), on a direct model:
  - `create`, `createMany`, `createManyAndReturn` and the create branch of `upsert`: the extension stamps `orgId` when it is missing, and refuses a scalar `orgId` whose value is not `ctx.orgId`.
  - `update`, `updateMany`, `updateManyAndReturn` and the update branch of `upsert`: it refuses a scalar `orgId` whose value is not `ctx.orgId`.
- **In system scope** there is no `ctx.orgId`.
  - **Built (FU-DB-104).** On direct models, any `orgId` key, whatever its value (the `{ set }` form too), is refused in `update`, `updateMany`, `updateManyAndReturn` and the update branch of `upsert`. An Organization keeps its id. `AUTH_BOOTSTRAP` writes sessions (INVITED → OPENED) and auth rows before it narrows, so this check matters.
  - **Planned:** an unrecognised write operation throws in system scope as well, as it does in an org scope.
  - `create`, `createMany`, `createManyAndReturn` and the create branch of `upsert` may still set `orgId` in system scope (see below).
  - Writes under `AUTH_BOOTSTRAP` should still narrow to `runInOrg` as soon as the org is known.
  - A create of a model with `org_id` should narrow to `runInOrg(orgId)` first, so the scalar rule applies.
  - A create left in system scope is review-only (rule (i)): the context does not track which org ids were loaded, and code-reviewer checks that the org was loaded first.

**No write moves a row to another session (ADR 0013 CS-4).** In a SERVICE session scope, an update on a session-path model may not change `session_id` or any `session_question_id`. This mirrors the scalar `orgId` rule above.
- This is enforced only in SERVICE session scope.
- Cross-session plain-org jobs, such as `analyze-session` and retention, can still re-parent a row under rule (i). Code review checks that they never write `session_id` or `session_question_id`.
- It covers `update`, `updateMany`, `updateManyAndReturn` and the update branch of `upsert`.
- Creates take `session_id` from the scope.
- CANDIDATE scope follows the stricter ADR 0013 CS-4 rules.

**Cursors (built).**
- On a model with `org_id`, the cursor gets `orgId` added, and a cursor naming another org is refused.
- On `Organization`, the cursor must be the caller's own id.
- On a path model, a cursor is refused; page with `where` plus `orderBy` (keyset paging) instead.
- A cursor nested in `include`, `select`, `_count` or a fluent relation call is refused (FU-DB-93).

**What the extension does not check (rule (i)).**
- Scalar foreign-key writes and re-parenting stay under rule (i): load the target through the scoped client first, and answer 404 on a miss. The 58-key classification (`FK_CLASSES`, `RULE_I_REFERENCES`, 8.1) is the review checklist for this.
- Nested reads without a cursor follow foreign keys without the org filter. This covers `include`, `select`, the fluent API, relation filters, relation `orderBy` and `_count`. One TC-008 test pins this behaviour (FU-DB-78).
  - CS-4 refuses all six of these vectors in a CANDIDATE scope (ADR 0013).
  - In STAFF, plain org and SERVICE scopes they remain a rule (i) review item: select only the fields needed, and never `include` a user.

### 8.3 Schema and row-level security (owner decision: Delivery Lead)

- No schema change for the build or the pilot.
- FU-DB-77 stays open as a pre-production item for ARC-05 and DEP-02: revisit Postgres RLS on `org_id` (section 1, option b).

### 8.4 Scopes inside the API (architect detail)

**Every scope has an actor**, set by the entry function. A caller cannot pass the actor, so it cannot forge it.
- ADR 0013 section 5.10, rule CS-4 (PR #39), is the one place that defines the two session actors: their entries, filters, allowlists and tests. This section only places them among the org scopes.
- If the two ADRs disagree, CS-4 wins for session scopes, and this table is corrected.

| Actor | Entered by | Allowed from | Who calls it |
| --- | --- | --- | --- |
| STAFF | `runAsUser({ orgId, userId, role })` | no scope, system, or the same user (no change) | `OrgContextInterceptor`, and auth code once the user is known |
| Org scope, no session | `runInOrg(orgId)` | no scope, or system. Inside any org scope of the same org it is allowed and changes nothing; the actor, user and session stay (rows below). | Cross-session jobs (similarity, dashboards, retention follow-up), and narrowing from system scope |
| CANDIDATE (ADR 0013 CS-4) | `runAsCandidate(oid, sid)` | no scope only | `CandidateSessionGuard` only |
| SERVICE (ADR 0013 CS-4) | `runAsSessionJob(oid, sid)` | no scope only (after detach; see 8.5). The handler runs only from the BullMQ worker callback, and the processor calls `orgContext.detachForSessionJob()` first (ADR 0013 CS-4.1). | `SessionJobProcessor`, the one job-processor base class, only |
| SYSTEM | `runSystem(reason)` | no scope | The three reasons below |

**A scope only narrows.** Each row below has its own test. A row not listed is refused.

| Current scope | Entering | Result |
| --- | --- | --- |
| None | `runAsUser`, `runInOrg`, `runSystem(reason)` | Allowed |
| None | `runAsCandidate(A, S)` | Allowed (the guard) |
| None | `runAsSessionJob(A, S)` | Allowed (`SessionJobProcessor`) |
| None | `detachForSessionJob(fn)` | Allowed (`SessionJobProcessor`). It runs `fn` with an empty store. |
| Any org scope (STAFF, plain org, CANDIDATE, SERVICE) | `detachForSessionJob` | Refused |
| SYSTEM, any reason | `detachForSessionJob` | Refused |
| Any scope with an open `runRawSql` hatch | `detachForSessionJob` | Refused |
| SYSTEM, reason R | `runAsUser` or `runInOrg(A)` | Allowed (narrows) |
| SYSTEM, any reason | `runAsSessionJob` | Refused. A session scope starts from no scope only, so no open `runRawSql` hatch (8.5) can carry into it. Discovery enqueues per-session jobs, and retention narrows with `runInOrg(orgId)` or enqueues per-session jobs. |
| SYSTEM, any reason | `runAsCandidate` | Refused |
| SYSTEM, reason R | `runSystem(R)` | Allowed, no change |
| SYSTEM, reason R | `runSystem` with a different reason | Refused |
| Any org scope | `runSystem` | Refused |
| Any org scope in org A | Any scope in org B | Refused |
| STAFF, user U in org A | `runAsUser(U)` | Allowed, no change |
| STAFF, user U | `runAsUser` naming another user | Refused |
| STAFF, user U in org A | `runInOrg(A)` | Allowed; the actor stays STAFF with user U |
| Org scope in org A, no session | `runInOrg(A)` | Allowed, no change |
| STAFF, or org scope with no session | `runAsCandidate` or `runAsSessionJob` | Refused. A plain org scope never narrows into a session scope; staff reads of a session use the org scope and service checks. |
| CANDIDATE or SERVICE in org A, session S | `runInOrg(A)` | Allowed; S stays and the actor stays |
| CANDIDATE in org A, session S | `runAsCandidate(A, S)` | Allowed, no change |
| SERVICE in org A, session S | `runAsSessionJob(A, S)` | Allowed, no change |
| CANDIDATE | `runAsSessionJob` | Refused |
| SERVICE | `runAsCandidate` | Refused |
| CANDIDATE or SERVICE | `runAsUser`, `runSystem`, or any call that drops or changes S | Refused |

**Built:** the org switch and the system-from-org case are refused (`org-context.ts`, `enter`), and the three system reasons are closed.
**Planned:** the actor, both session entries and the other rows (ADR 0013 CS-4).

No rule in this ADR depends on a plain org scope narrowing into a session scope. There is no `runInOrg(A, { sessionId })` entry: session scopes are entered only through the two CS-4 entries.

**System scope has three closed reasons.** A new reason needs an amendment to this ADR. ADR 0013 adds none: start-test, `render-question` and grading are session jobs (below; ADR 0013 section 7).

| Reason | Allowed for |
| --- | --- |
| `AUTH_BOOTSTRAP` | Lookups before the caller's org is known. On the staff side: login by email, refresh-token rotation and set-password tokens. On the candidate side, only the three routes before a candidate session JWT exists: link resolve, OTP send and OTP verify (ADR 0013 section 5.10). Narrow to `runAsUser` or `runInOrg(A)` as soon as the org is known. It cannot enter a session scope. The per-request guard re-check of the user (BE-03) is not `AUTH_BOOTSTRAP`: it runs in `runInOrg(claims.org)`, because the verified token carries the org (FU-DB-58, FU-DB-102). |
| `BACKGROUND_JOB` | Scheduled discovery across orgs only. See the job rules below. |
| `RETENTION_ERASURE` | Selecting what is due only. Each session is then deleted in a plain `runInOrg(orgId)` (FU-DB-71), or by enqueueing a per-session job, which does not run inside the system scope. No system reason enters `runAsSessionJob`. |

**Background jobs.**
- The job payload carries `orgId`, and `sessionId` when the job concerns a session.
- A session job runs in `runAsSessionJob(orgId, sessionId)` through `SessionJobProcessor` (actor SERVICE).
- A cross-session job (similarity, dashboards, retention follow-up) runs in plain `runInOrg(orgId)`.
- Either way, the processor loads its target in scope. If the target is missing, or the `sessionId` does not belong to the `orgId`, the job is dropped.
- That check catches a mismatched payload. It does not stop an attacker who can write both fields, so the trust boundary is Redis access control and network isolation (ADR 0001 C-7). Signed job payloads are an option if the owner wants more.

**Routes behind `CandidateSessionGuard` use no system scope.**
- Link resolve, OTP send and OTP verify are the candidate routes outside the guard (ADR 0013 section 5.10). They run under `AUTH_BOOTSTRAP`.
- The guard verifies the candidate JWT. It then reads the candidate facts in a plain `runInOrg(oid)` entered from no scope (ADR 0013 section 5.10, DL-31; architect detail, DL-31 interim pick, owner accepts under P-15; the narrower variant, with `sessions.invitation_id` read in CANDIDATE scope under a grant, was considered and not chosen): the session's `invitation_id`, then the invitation's `candidate_id` and `test_id`, as column-only selects, never `accommodations`. That callback returns before the next step; it is never nested.
- It then enters `runAsCandidate(oid, sid)` from no scope, using the verified claims, and calls the candidate-facts setter before any other query in that scope. **Fail closed:** in CANDIDATE scope the extension throws on any query on any model while the facts are unset; an injected filter whose context value is missing throws and is never passed to Prisma as `undefined` (Prisma would drop it from the `where`); the setter throws if called twice or with any id missing.
- Inside that scope it loads the session with `id = sid` and checks `auth_epoch` against the token's `epoch`.
- A missing session, a session in another org, or a missing invitation is simply not found. All three answer 401 with the same problem body and code.

**Session jobs (grading, render-question, start-test) add no system reason.**
- Hidden-test grading and start-test run as session jobs with actor SERVICE. ADR 0013 holds their contracts and timeouts; this ADR does not restate them.
  - **Grading.** In ADR 0013 section 5.11, submit returns only `{ accepted, submissionId }`. Hidden-test grading runs in `grade-session` (ADR 0007). There is no synchronous submit result.
  - **Start-test.** `start-session`, which includes question assignment, stays a job that the route awaits, with 503 on timeout.
  - What the candidate sees after the test is an open owner question.
- `runSystem` stays refused from every org scope, including a candidate scope, and the reason set stays closed.
- Any future synchronous exception inside a candidate request needs an explicit amendment to this section, naming the call site and the new row.

There is no org-provisioning reason (8.6, 8.9).

### 8.5 Raw SQL (architect detail)

- **Raw SQL needs `runRawSql` and a scope.**
  - Raw SQL is refused unless it runs inside `runRawSql(reason)`.
  - `runRawSql` requires an active scope. **Built:** with no scope it throws `OrgContextMissingError`.
  - **As built, the hatch carries into nested scopes** (README limit (e)). An open `runRawSql` stays open in a `runAsUser`, `runInOrg` or `runSystem` started inside it, so the README says to wrap only the single raw statement. **Planned:** an open hatch does not carry into any scope entered inside it, and never into a `sessionId` scope.
- **What each scope allows:**
  - **System scope:** the raw SQL must serve the active system reason. An example is the `AUTH_BOOTSTRAP` failed-login counter.
  - **Org scope without a session:** the SQL itself must filter by `org_id`. A table without `org_id` must be joined along its 8.7 scope path.
    - **One exception: the advisory lock (ADR 0004 section 9.4, PR #48).** `SELECT pg_advisory_xact_lock(...)` reads no table, so it cannot filter by `org_id`.
      - It is allowed in an org scope without a session, as a named raw call site on the FU-DB-67 list.
      - Its key is derived only from ids already read in the scope.
      - It is refused in any `sessionId` scope, like all raw SQL.
  - **Any scope carrying a `sessionId`:** raw SQL is refused, for actor CANDIDATE (`runAsCandidate`) and actor SERVICE (`runAsSessionJob`) alike. A session job that needs raw SQL needs an amendment to this ADR; a named call site alone is not enough. ADR 0013 CS-4 must say the same.
- **Per-session write lock for SERVICE writers: `guardLive` (ADR 0004 section 9.5; ADR 0013).**
  - SERVICE writers do not use the advisory lock. They take the lock through the model API with `guardLive`, the first statement of the write transaction.
  - **The lock.** `guardLive` is `sessions.updateMany({ where: { id, status: <the status read>, NOT: { status: 'ERASED' } }, data: { status: <the same status> } })`. It writes the status to its current value, which takes the row lock without raw SQL.
    - It does not require a "live" status. Writers on GRADED or COMPLETED sessions, such as reports, use it too.
    - If the status read is ERASED, the writer returns without writing.
  - **0 rows.** The status changed in the meantime. The writer re-reads it and stops on ERASED; otherwise it retries a bounded number of times.
  - **Jobs that work on ERASED sessions** use a separate entry, `withAnySession(sid, fn)`, not `guardLive`: ingest-close and key destruction, the sweep passes, evidence-expire, and the consent-PDF job.
  - **Where it lives.** `SessionJobProcessor` provides the write-transaction wrapper that calls `SessionStateService.guardLive`, a thin wrapper over the lock cores in `apps/api/src/database/session-locks.ts` (Database A: `guardLive`, `lockForAccommodation`, `lockAnySession`). Those database primitives may be imported only by `SessionStateService` and its tests. Writers do not call it by hand.
  - **Lock timeout.** If ADR 0004 keeps a `lock_timeout`, it is set without raw SQL: either a SERVICE pool whose pg options include `-c lock_timeout=...`, or the Prisma interactive-transaction `timeout`.
- **Second model-API lock: `lockForAccommodation` (ADR 0015).**
  - It is the same same-value `sessions.updateMany` with `status: <the status read>` in the `where`, but without the ERASED exclusion. It works in any status, ERASED included.
  - It is used only by the accommodation writers:
    - the accommodations PATCH;
    - redact-note;
    - the video-check PUT;
    - the accommodations reduction in erasure, R-10 and R-4.
  - Those writers never use `guardLive`, and no other writer uses `lockForAccommodation`.
  - On 0 rows, the writer re-reads the status and retries a bounded number of times.
- **Lock order** (both locks):
  - the ADR 0004 advisory lock (where used), then the `sessions` row lock (`guardLive` or `lockForAccommodation`), then `invitations`;
  - a writer that touches several sessions takes one session per transaction. Where it cannot, it locks them in ascending id order.
- **Never on organizations.** Raw SQL never writes `organizations`, in any scope.
- Model queries inside `runRawSql` stay scoped.
- The `runRawSql` reason stays free text for the reviewer.
- **Call-site allow-list (planned, FU-DB-67).** A test lists every call site of `runSystem`, `runInOrg`, `runAsCandidate`, `runAsSessionJob` and `runRawSql`, by file and count. It also refuses `$queryRawUnsafe` and `$executeRawUnsafe` unless they are listed. It lands before BE-03, together with FU-DB-58.
  - For each raw call, the list records the pair (call site, system reason or org scope).
  - Only two call sites may enter a session scope: `runAsCandidate` in the `CandidateSessionGuard` file, and `runAsSessionJob` in the `SessionJobProcessor` base class. Both start from no scope only.
- **Leaving a scope.** `AsyncLocalStorage.exit()`, `enterWith()` and `disable()` would let code leave its scope and bypass every "only narrows" row. So:
  - The OrgContext `AsyncLocalStorage` instance stays private to `org-context.ts`. It is never exported, and never reachable through a getter.
  - The only way to leave a scope is `orgContext.detachForSessionJob(fn)`. Only the `SessionJobProcessor` base class calls it.
    - It asserts an empty store, then runs `fn` in a fresh empty store. It throws on any scope, raw-SQL hatch or grant. The grant check is redundant, because grants cannot exist outside a scope; it is kept as defence in depth (as in ADR 0013).
    - It is allowed from no scope only. It throws inside any org scope (STAFF, plain org, SERVICE and CANDIDATE), in system scope, and while a `runRawSql` hatch is open. So a candidate scope cannot leave itself, and nothing can reach a session scope in two steps.
    - Workers are built at module init, outside any scope. `SessionJobProcessor` asserts that there is no scope, and its handler runs only from the BullMQ worker callback. A discovery processor never calls a session handler inline; it enqueues the session job.
    - The 8.4 rows for `detachForSessionJob` each have a test.
  - The call-site allow-list and its test (FU-DB-67) also cover:
    - `exit`, `enterWith` and `disable` on the OrgContext store;
    - `detachForSessionJob`;
    - the `runInOrg` call site in `CandidateSessionGuard` for its candidate-facts pre-read (ADR 0013 section 5.10, DL-31), the only non-CANDIDATE read on routes behind the guard;
    - the eleven grant sites in the ADR 0013 CS-4.4 grant-site table (`CandidateSessionGuard` has no grant, DL-31):
      - `SessionStateService`
      - `KeyService`
      - `DeviceInfoService`
      - `StorageService`
      - `OrgSettingsService`
      - `TestSettingsService`
      - `AccommodationsService`
      - `SectionGateService` (two grants)
      - `ConsentService` (two grants: the `consent_texts` read and the `consents` create)

      ADR 0013 CS-4.4 defines each site's model, columns and ids. This ADR does not repeat them.
    - the private candidate-facts setter for `ctx.candidateId`, `ctx.invitationId` and `ctx.testId`. Only `CandidateSessionGuard` may call it, once per scope, before any other query in the scope; it throws if called twice or with any id missing, and the values are immutable afterwards.
    - the three model-API lock call sites, `SessionStateService.guardLive` (only from the `SessionJobProcessor.withLiveSession` write-transaction wrapper and the one STAFF proctor-resume method of `SessionStateService`, ADR 0013 5.7), `SessionStateService.lockForAccommodation` (only from the ADR 0015 accommodation writers and the erasure, R-4 and R-10 jobs, which take it themselves and never `guardLive`) and `SessionStateService.lockAnySession` (only from `SessionJobProcessor.withAnySession`), each a thin wrapper over the same-named core in session-locks.ts.
    - the two session-job write entries, `withLiveSession` and `withAnySession`, both only in the `SessionJobProcessor` base class (ADR 0013 5.7).
  - The grant-entry API and the candidate-facts setter stay private to `org-context.ts` or the extension, like the store.
  - **How grants work.** This is the normative grant spec; ADR 0013 uses the same wording.
    - `withGrant({ model, columns, ids }, fn)`. All three fields are mandatory, and an empty `ids` throws.
    - The extension checks the model and the columns, and adds `id IN ids` to the query itself.
    - For a create grant there is no `where` to filter: `ids` then constrain the checked parent key (the extension checks that the create's `session_id` is in `ids`), and nothing else is filtered.
    - A grant is a nested AsyncLocalStorage run inside the current scope. It carries an `active` flag that is cleared in `finally` when `fn` settles, and the extension refuses any query under an inactive grant. So async work started inside `fn` and not awaited (a promise, `setTimeout`, an emitter or a stream callback) cannot use the grant after `fn` settles. A test checks that such a detached query throws.
    - Grants exist only inside a scope.
    - `ids` are never request input. They are values read inside the same scope, or ids resolved within the session through ADR 0013 CS-2 and CS-4.2. For example, `SectionGateService`'s step-1 id comes from the URL after that resolution.
    - Typical ids:
      - `[ctx.sessionId]` for session-row grants;
      - `[ctx.sessionId]` for the `consents` create (ConsentService);
      - `[ctx.orgId]` for org settings;
      - `[ctx.testId]` for test settings.
  - Any use outside those files fails the test or the lint rule.
  - The FU-DB-67 row in docs/followups/database.md still lists only `runSystem`, `runInOrg` and `runRawSql`. The db-engineer extends it to everything above.
  - A new call site updates the list, and code-reviewer checks it.

### 8.6 Organization (architect detail)

**Rows.**
- Org rows are created only by the provisioning CLI (8.9).
- No 8.4 reason creates or deletes them inside the API. That needs `ORG_PROVISIONING`, added through an amendment.
- Deleting an org is out of scope for the pilot.

**How `Organization` itself is scoped.**
- It uses the `self` rule: every query on it is filtered by `id = ctx.orgId`.
- So when rule (i) loads an org through the scoped client, only the caller's own org can be found.

**Operations on `Organization`: deny by default, in every scope.**
- **Built:** create is refused in an org scope; the id never changes, in any scope.
- **As built (delta):**
  - an org scope may still delete its own organization row (FU-DB-68);
  - system scope may create, upsert or delete one;
  - an update is not limited to a STAFF scope.
- **Planned:** the full deny-by-default list below, in every scope.
- Allowed:
  - reads: `findUnique`, `findUniqueOrThrow`, `findFirst`, `findFirstOrThrow`, `findMany`, `count`, `aggregate` and `groupBy`;
  - `update`, `updateMany` and `updateManyAndReturn`, but only in a STAFF scope (the org-settings service), never in a plain org, SERVICE or CANDIDATE scope, and only when the data does not contain `id`. `organizations.id` is immutable; a test covers it, and there is no trigger (8.3).
- Refused: `create`, `createMany`, `createManyAndReturn`, `upsert`, `delete` and `deleteMany`.
- Any operation the extension does not recognise throws.

**Nested writes.** The general deny-by-default rule (8.2) covers `Organization` too.
- Every nested write on a relation to `Organization` is refused, in every scope: `create`, `connect`, `connectOrCreate`, `update` (including one that sets `id`), `upsert`, `delete`, `set` and `disconnect`.
- Examples: `user.create({ data: { organization: { create: … } } })` and `test.update({ data: { organization: { update: { id } } } })`.
- Org settings change only through a top-level `organization.update`, in the service that holds the authorization check for org settings.
- **Built**, as part of the general rule in 8.2, in org and system scope. An `Organization`'s `id` cannot change in any scope.

**No write moves a row to another org.** This is the scalar `orgId` rule in 8.2.

**The raw client.** The raw, unextended factory client is the 8.9 exemption. As built, `import-guard.spec.ts` allows `create-prisma-client` only in `prisma.service.ts` and the interim `prisma.module.ts`, and it scans `apps/api/src` only. The rule is that only these may import `createPrismaClient`:
- `prisma.service.ts`, which extends it;
- the seed;
- the provisioning CLI;
- BE-02's interim `prisma.module.ts`, until FU-DB-58 deletes it;
- the candidate-write datasource (ADR 0013): a second client. Prisma 7 uses `@prisma/adapter-pg` (ADR 0009 section 4.2), so `pool_timeout` and `connection_limit` URL parameters do not apply; the pool options go on `PrismaPg`:
  - `max`;
  - `connectionTimeoutMillis: 2000`;
  - `statement_timeout: 3000`.

  The factory signature widens to `createPrismaClient(connectionString, poolOptions?)`. The BE-07 spike confirms the options. It exists because `SET LOCAL` is raw SQL and is refused in session scopes, and it must carry the same extension.

This list is part of the FU-DB-67 importer test. That test proves only who calls `createPrismaClient`, not that the extension is applied, so a second test checks the candidate-write client itself:
- with no scope, a query on it throws `OrgContextMissingError`;
- in a CANDIDATE scope, it applies the CS-4 filters.

 Without that check, the exemption would be a bypass inside `apps/api`.

### 8.7 Path rule (architect detail)

- A scope path follows the composition parent chain, with the owner taken from the database.md ERD. Section 1 and database prompt Step 5 point here.
- It never follows a staff or cross-chain reference, and it is not chosen by hop count.
- Example: `AiReferenceSolution` is scoped through its question version (`questionVersion.question.orgId`), not through `collectedBy`.

### 8.8 Runtime checks (architect detail)

**Readiness role assertion (planned, FU-DB-66, before DEP-01; FU-DB-66 lists the first four checks, and this section adds the rest).** The readiness check asserts all of these:

- `current_user = 'app_user'`;
- the role has no SUPERUSER, BYPASSRLS, CREATEROLE, CREATEDB or REPLICATION;
- **it is a member of no role.** `SELECT 1 FROM pg_auth_members WHERE member = 'app_user'::regrole` returns no rows.
  - The query filters on the `member` column only. In PG 16 a CREATEROLE creator, such as the RDS master or the Neon owner, gets a row with `roleid = app_user`. A two-way query would therefore fail on those hosts.
  - Being a member of no role directly also rules out indirect memberships, such as `pg_read_all_data`, `pg_write_all_data`, `rds_superuser`, `neon_superuser` or the owner role.
- **it owns nothing:**
  - no database (`pg_database.datdba`);
  - no schema (`pg_namespace.nspowner`);
  - no relation in any schema (`pg_class.relowner`);
  - no function (`pg_proc.proowner`).
- **it has no create rights:**
  - no CREATE or TEMP on the database (`has_database_privilege`);
  - no CREATE on schema `public` (`has_schema_privilege`).
  - DB-08 already checks these at test time; the readiness check repeats them at runtime.

How the check runs:

- It runs on each pool: the main client and the candidate-write client. A misconfigured candidate-write URL that points at a privileged role would otherwise go unnoticed.
- It is a readiness check, not a blocking startup query.
- It logs which assertion failed, never the connection URL.
- The DEP-01 and DEP-03 deploy jobs poll readiness, and fail or roll back when an assertion fails.

**Interceptor (FU-DB-65).**

- A malformed `request.user` reaches the interceptor only after the guard has passed, so it is a server fault.
- **As built:** it answers 401, and the code, the tests and the README agree.
- **Planned (FU-DB-65):** it answers 500.
- The log names the fault. It never includes `request.user` content or the token.

### 8.9 Pilot org provisioning (FU-DB-76, ARC-05 and DEP-03)

**The decision (owner decision: Delivery Lead, pending D-xx).**

- Pilot orgs are created outside the API by a provisioning CLI built on the client factory, like the seed.
- There is no API route for it.

**How the CLI works (architect detail).**

- **What it creates, in one transaction:**
  - one `organizations` row (name, `retention_days`);
  - its first SUPER_ADMIN user, with no password.

  It creates no consent text or other content; the admin adds those in the app.
- **The placeholder token.** The `users` CHECK (`password_hash` or `set_password_token_hash` must be set; database.md) needs a token hash when the admin row is inserted. So the CLI:
  - stores the SHA-256 of a random 32-byte token;
  - sets `set_password_expires_at` to the insert time, so the placeholder is never valid. The reset endpoint treats `set_password_expires_at <= now()` as expired, so the placeholder can never match;
  - discards the cleartext at once, and never prints, logs or keeps it.
- **Sending the link (option (b), recommended).** Considered: (a) the CLI sends mail itself; (c) enqueue the cleartext with `removeOnComplete` and `removeOnFail` (the minimum, not recommended).
  - After commit, the CLI enqueues a `set-password` job.
    - Its payload carries only `orgId` and `userId`.
    - Its `jobId` is `set-password_{userId}`, so concurrent re-issues collapse into one.
    - It sets `removeOnComplete` and `removeOnFail`.
    - It uses a small number of attempts, with backoff.
  - The processor runs inside `runInOrg(orgId)`. It rotates the token with one conditional update:
    - the `where` is `{ id: userId, passwordHash: null, role: SUPER_ADMIN, isActive: true }`;
    - the update sets a new token hash and `set_password_expires_at` = now + 72 h;
    - zero rows updated means the job is dropped, and the log holds ids only.
  - Each attempt rotates the token again, so only the last email's link works.
  - The processor calls the mail provider in process. It never enqueues a mail job that carries the link. The BE-06 mail jobs (FU-BE-21) carry template variables, which would include the URL.
  - Provider errors are logged without the link and without the request body.
- **Token rules (ADR 0003, D-22).**
  - Staff-invite template and a 72-hour expiry.
  - Single use: the token is cleared in the `/auth/password/reset` transaction.
  - The token is in the URL fragment (`#token=`).
  - The invitation token's Referer and never-log rules apply (ADR 0001 C-5, A-13).
  - The link or token is never printed, never written to a file, and never in a GitHub Actions log.
- **Re-issue.**
  - The CLI can re-issue the link only for a SUPER_ADMIN of the named org who has no password. It enqueues the same job.
  - An optional cooldown per user may be added.
  - If the enqueue fails after commit, the CLI exits non-zero and tells the operator to run re-issue. It prints the org id and the user id, and nothing else.
- **Where it runs:**
  - Only on the pilot host: over SSH from a GitHub Actions job, or on a self-hosted runner inside the pilot network.
  - Never from a developer machine or an agent session (ADR 0009, D-38).
  - A GitHub-hosted runner never connects straight to the pilot database, because Postgres is not exposed to the internet.
- **Inputs:**
  - The org name and the admin email come from a file on the pilot host or from a secret.
  - `workflow_dispatch` inputs are not used for them: masking does not hide inputs in the run metadata, and the admin email is personal data.
- **How it connects:**
  - To Postgres as `app_user`, through `DATABASE_URL`.
  - With no `MIGRATION_DATABASE_URL` fallback.
  - Without reusing the seed's localhost guard or URL fallback.
  - The Redis credentials come from a secret on the host, like `DATABASE_URL`.
- **Why 8.4 does not apply:** the CLI uses the raw factory client in its own process, outside the API. So it needs no system-scope reason, and the 8.6 refusals in the extension do not touch it.
- **Audit and logging:**
  - One `audit_logs` row, with `actor_id` NULL, for each org created, each re-issue and each link sent. The metadata holds the job run id and the org and user ids only, never the email (ADR 0001 C-3).
  - The CLI never prints a connection string.
- **Later:** if self-serve or platform-admin org creation is ever needed inside the API, add `ORG_PROVISIONING` through an amendment to this ADR.

### 8.10 Consequences and agents affected

- **Positive:** the DB-05 merge gate is satisfied in main (7c5d2e0). The scope rules are closed and testable (FK classification, call-site allow-list, readiness check), with no schema change before the pilot.
- **Negative:**
  - Rule (i) stays a service-level guard for the `RULE_I` foreign keys listed in 8.1 until RLS is revisited (FU-DB-77).
  - Session jobs run in a `sessionId` scope, so they cannot use raw SQL (8.5). This is deliberate. It covers BE-12 risk scoring, BE-14 report generation, and DB-06 per-session deletion when it runs as a session job. All of them must use the model API. If one of them needs raw SQL, that needs an amendment to this ADR.
- **db-engineer.** Status as built is in 8.0.
  - **Done in main (7c5d2e0):**
    - 8.1, the classification and the relation side table (FU-DB-64, FU-DB-103);
    - 8.2, deny by default in org and system scope with an empty `NESTED_WRITE_ALLOWLIST` (FU-DB-94, FU-DB-98, FU-DB-101);
    - nested cursors (FU-DB-93);
    - the scalar `orgId` rule, in org scope and on system-scope updates (FU-DB-104);
    - `runRawSql` requiring a scope;
    - the importer guard for `create-prisma-client`.
  - **Deltas between the code and this ADR, to build next:**
    - 8.2: an unrecognised write operation throws in system scope.
    - 8.2: the `createMany` relation-key test (FU-DB-106).
    - 8.5: the raw-SQL hatch does not carry into nested scopes.
    - 8.6: refuse Organization delete in an org scope (FU-DB-68), then full deny by default in every scope, with updates only in a STAFF scope.
    - 8.8: FU-DB-65 (500), FU-DB-66 (the readiness checks, including REPLICATION, membership and ownership, on each pool), and FU-DB-70 (`errorFormat`).
  - **Planned with the session scopes (ADR 0013 CS-4; BE-07, BE-08):**
    - 8.4: the actor in the scope (STAFF, plain org, CANDIDATE, SERVICE, SYSTEM), set by the entry function.
    - 8.4: `runAsCandidate` (guard only, from no scope) and `runAsSessionJob` (`SessionJobProcessor` only, from no scope, after `detachForSessionJob`).
    - 8.4: the transition table, with one test per row.
    - 8.5: keep the `AsyncLocalStorage` instance private.
    - 8.5: `detachForSessionJob`, allowed from no scope only. It throws in any org scope, in system scope, and with an open hatch or a grant.
    - 8.5: `SessionJobProcessor` asserts that there is no scope.
    - 8.5: refuse raw SQL in a `sessionId` scope.
    - 8.5: `withGrant({ model, columns, ids }, fn)`, with mandatory ids and the `active` flag.
    - 8.5: `guardLive`, `lockForAccommodation` and `lockAnySession`.
    - 8.2: in SERVICE session scope, refuse an update that changes `session_id` or `session_question_id`.
  - **FU-DB-67, the call-site allow-list.** It covers:
    - `runSystem`, `runInOrg` and `runRawSql`, including the `runInOrg` pre-read in `CandidateSessionGuard` (DL-31);
    - the two session entries;
    - `exit`, `enterWith`, `disable` and `detachForSessionJob`;
    - the eleven CS-4.4 grant sites, with the candidate-facts setter;
    - the advisory-lock raw call site;
    - `guardLive`, `lockForAccommodation` and `lockAnySession`, each limited to its callers, with the lock order: advisory lock, then `sessions`, then `invitations`;
    - `withLiveSession` and `withAnySession`, only in `SessionJobProcessor`.

    Update the FU-DB-67 row in docs/followups/database.md to match.
  - **Second client.** Build the candidate-write datasource:
    - pool options on `PrismaPg`: `max`, `connectionTimeoutMillis: 2000`, `statement_timeout: 3000`;
    - the widened factory `createPrismaClient(connectionString, poolOptions?)`;
    - the same extension, with a test that it throws `OrgContextMissingError` with no scope and applies the CS-4 filters in CANDIDATE scope;
    - an entry in the importer guard;
    - readiness on its pool.

    The BE-07 spike confirms the options.
  - **Still open:**
    - nested reads (FU-DB-78);
    - FU-DB-71 and FU-DB-72, DB-06 and the job rules (update FU-DB-72 so that session jobs use `runAsSessionJob`);
    - 8.9, the provisioning CLI (the org and its first admin, the placeholder hash, enqueue and re-issue, audit rows), to be added to the importer guard.
- **backend-engineer:**
  - Use only the three reasons in 8.4.
  - Build job payloads and processors per `BACKGROUND_JOB` in 8.4.
  - Build the `set-password` job processor in 8.9: a conditional rotate, mail sent in process, no link in any queue or log.
  - Build `SessionJobProcessor`.
  - Run grading (`grade-session`), `render-question` and start-test (`start-session`) as session jobs (ADR 0007; ADR 0013 CS-4).
  - Retention deletes each session in `runInOrg(orgId)` (FU-DB-71) or through a per-session job.
  - Move auth onto the scoped client (FU-DB-58) before BE-03, with the allow-list (FU-DB-67).
  - DB-06 and the retention job follow 8.4.
- **Deploy (DEP-01, DEP-03):**
  - Poll readiness and roll back on a failed assertion (8.8).
  - Run the provisioning CLI per 8.9.
- **code-reviewer checks:**
  - that every new foreign key is classified (8.1);
  - every new `runSystem`, `runInOrg`, `runAsCandidate`, `runAsSessionJob` and `runRawSql` call site;
  - nested reads in STAFF, plain org and SERVICE scopes (FU-DB-78);
  - the path rule (8.7).
- **qa:**
  - The TC-008 evidence lives in `apps/api/src/database/tc-008-org-isolation.spec.ts` (FU-DB-59).
  - The P1 gate does not see it yet (FU-DB-81).
  - Real-route, `/live` and candidate-token cases are tracked as FU-DB-86 and FU-DB-87.
  - The P1 gate gap is also recorded in docs/followups/qa.md section 7.6.
