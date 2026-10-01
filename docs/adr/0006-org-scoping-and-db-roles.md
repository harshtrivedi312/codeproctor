# ADR 0006: Org scoping, cross-tenant integrity, database roles and indexes

| Field | Value |
| --- | --- |
| Status | **Accepted** 2026-10-01 (D-16): every recommendation as proposed. No amendment from D-17..D-23 beyond the tables they add, which carry or inherit `org_id` (section 1). Applied to database.md; deltas in ADR 0008. |
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
