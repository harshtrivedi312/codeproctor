# Follow-ups: Database B (ops) track

Should-fix items and nits from Database B (ops) work and reviews (DB-07 backups, DB-08 verification). Under the session rules, only blockers stop a merge. Items moved here from `database.md` keep a back-reference to their FU-DB id.

Columns:
- **Type:** should-fix or nit.
- **Owner:** the session or agent expected to act.
- **Target:** the task where it gets done.
- **Status:** open, done (give the PR number), or partly done (give the PR number and what remains).

## Items

| ID | Source | Type | Item | Owner | Target | Status |
| --- | --- | --- | --- | --- | --- | --- |
| FU-DBB-01 | DB-07 engineer | should-fix | `infra/backup/reapply-erasures.sql` mirrors the database part of erasure as of ADR 0004 section 9.5 and the schema at DB-03 (consent record kept, per C-17). When DB-06 lands (`ERASED` session status, `retention_anchor_at`, the `audit_logs` marker rows), align the SQL: set sessions to `ERASED`, and decide whether a re-application writes an audit row. `verify-backup.test.mjs` has the TC-094 checks to extend. | Database A (DB-06), Database B | after DB-06 | open |
| FU-DBB-02 | DB-07 engineer | should-fix | The erasure service must run `infra/backup/erasure-list.sh append <candidate-uuid>` (or write the same object, `<prefix>erasure-list/<UTC stamp>-<uuid>.json` in the backup bucket, through the app's S3 interface) **before** it commits the erasure to the database. Without it a restore silently brings erased candidates back. The format and ordering are in `docs/runbook.md`. | Database A (DB-06), backend (ARC-05) | DB-06 | open |
| FU-DBB-03 | DB-07 engineer | nit | The root `pnpm test` runs `infra/scripts/*.test.mjs` only, so the backup tests are named `verify-backup.test.mjs` and live there. CI's "Shellcheck the reset scripts" step does not list `infra/backup/*.sh` or `infra/scripts/db-migrate`; add `shellcheck infra/backup/*.sh` (shellcheck was not installed on the author's machine, so the scripts are unchecked). | architecture hub (CI config) | next CI change | open |
| FU-DBB-04 | DB-07 engineer | should-fix | `backup-nightly.yml` needs these staging secrets (environment `staging`): `STAGING_S3_BACKUP_BUCKET`, `STAGING_S3_ENDPOINT`, `STAGING_S3_BACKUP_ACCESS_KEY_ID`, `STAGING_S3_BACKUP_SECRET_ACCESS_KEY`, `STAGING_BACKUP_PGHOST`, `STAGING_BACKUP_PGPORT`, `STAGING_BACKUP_PGUSER`, `STAGING_BACKUP_PGPASSWORD`, `STAGING_BACKUP_PGDATABASE`. The owner creates them; no session touches them (ADR 0009). The R2 token should be limited to the backup bucket, and the database role to read-only (`pg_read_all_data`). Whether GitHub-hosted runners can reach the staging database (or need a tunnel) is a staging deployment question. | owner, DEP-01 | DEP-01 | open |
| FU-DBB-05 | DB-07 engineer | nit | The row-count comparison is taken in a separate snapshot just before `pg_dump`, so a busy database can show small differences. Exporting a snapshot (`pg_export_snapshot` plus `pg_dump --snapshot`) would make it exact. Not needed while staging is quiet at 02:17 UTC. | Database B | later | open |
| FU-DBB-06 | DB-07 engineer | should-fix | Pilot and production backups: `backup.sh` works with the AWS instance role (leave `S3_ACCESS_KEY_ID` empty) and `BACKUP_SSE=AES256`, but nothing schedules it there. DEP-03 adds a cron or workflow in the pilot environment. ARC-05 sets bucket encryption, Block Public Access and the versioning rule (ADR 0004 9.7). | DEP-03, architecture hub | DEP-03 | open |
