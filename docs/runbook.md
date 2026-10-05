# Runbook

Operational procedures. Each section names who may run it and where. Staging and pilot
credentials never exist on developer machines or in agent sessions (ADR 0009); procedures that
need them run in GitHub Actions or on the server.

## Database backups and restore

Owner: Database B (ops) track. Serves NFR-03, FR-704 and ADR 0004 R-7. Files: `infra/backup/`,
the nightly workflow (below). Tests: `infra/scripts/verify-backup.test.mjs`.

### What runs

| Piece | What it does |
| --- | --- |
| `infra/backup/backup.sh` | `pg_dump` (custom format) piped through gzip. It checks that the gzip and the dump are readable and that every table has a data entry. It uploads `dumps/codeproctor-<UTC stamp>.dump.gz`, `.sha256` and `.counts.tsv` to the backup bucket, checks the stored size, then deletes dumps older than 14 days and erasure-list entries that no remaining backup needs. The newest dump is never pruned. |
| `infra/backup/restore.sh` | Downloads a named backup (or the latest), verifies the checksum, restores into a **new** database, compares row counts with the counts taken at backup time, then re-applies the erasure list. Never restores over an existing database and never drops one. |
| `infra/backup/erasure-list.sh` | The erased-candidate list kept outside the database and its backups (see below). |
| Nightly workflow (proposed to the architecture hub, which owns CI config; not in this PR) | 02:17 UTC every night: backs up staging with repository secrets, then restores the new backup into a throwaway Postgres 16 service container and compares counts. Until it lands, nothing schedules the backup (FU-DBB-07). |

Settings (names match `.env.example`): `PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE`,
`S3_BACKUP_BUCKET S3_ENDPOINT S3_REGION S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY S3_FORCE_PATH_STYLE`,
and optionally `BACKUP_PREFIX` (default `db/`), `BACKUP_RETENTION_DAYS` (default 14),
`BACKUP_SSE` (for example `AES256` on AWS S3), `PG_BIN_DIR`. The scripts take no secrets as
arguments, so nothing shows up in `ps`, and they never print a URL, key or password.

Environments: staging writes to Cloudflare R2 (synthetic data only). Pilot and production write
to AWS S3 in the same region as the data, so candidate data stays in AWS; only configuration
differs. Backups of pilot and production run on the server or in a pilot workflow that DEP-03
adds. Turn on bucket default encryption and Block Public Access on the backup bucket (ARC-05).
Do not turn on object versioning without a short noncurrent-version lifecycle rule: noncurrent
copies would outlive the 14-day limit (ADR 0004 9.7).

The `pg_dump` client must have the same major version as the server (16). A newer client writes
settings that a 16 server rejects at restore time; `backup.sh` and `restore.sh` refuse a mismatch.

### The erasure list (ADR 0004 R-7)

A restore brings back rows that were erased after the backup was taken. To undo that, the ids of
erased candidates are kept in the backup bucket under `<prefix>erasure-list/`, outside the
database and its dumps. One object per erasure, named `<UTC stamp>-<candidate uuid>.json`, holding
the id and time only (no name or email). `restore.sh` re-applies **every** entry after the restore;
the SQL is idempotent (`infra/backup/reapply-erasures.sql`), it follows C-17 (the consent record is
kept), and it does not touch object storage (objects already deleted stay deleted).

The erasure service (DB-06) must add the candidate with `erasure-list.sh append <uuid>` **before**
it commits the erasure to the database. A crash then leaves an entry for an erasure that did not
happen, which is harmless, instead of an erasure that a restore would undo. Entries older than the
oldest remaining backup (plus one day) are pruned by `backup.sh`.

### Restore drill (run on a throwaway server)

Locally, with a throwaway container (never the dev stack):

```bash
docker run -d --rm --name restore-drill -e POSTGRES_PASSWORD=drill -p 127.0.0.1:55432:5432 postgres:16
```

Run the restore with the drill server's settings and the backup store settings of the environment
you are testing. For staging that means GitHub Actions; the nightly workflow does exactly this on
every run. For a local check without any bucket, run the automated drill instead, which uses an
in-memory S3 server and a throwaway Postgres container:

```bash
node --test infra/scripts/verify-backup.test.mjs
```

### Restoring for real (an incident)

Run on the server or in a manually triggered workflow in the affected environment, by a human.
1. Pick the backup: list `<prefix>dumps/` in the bucket. Prefer the newest one taken before the incident.
2. `RESTORE_ALLOW_REMOTE=1 sh infra/backup/restore.sh --target-db <new name> --backup <file>`
   with `PG*` pointing at the server. The role needs `CREATEDB`. `app_user` must already exist on the
   server (ADR 0006 section 7.5); the script stops if not.
3. Exit code 0: restored, counts match, erasures re-applied. Exit code 2: restored, but the row counts
   differ from the backup; inspect before using it.
4. Check the application against the new database (`app_user` grants, `audit_logs` append-only), then
   switch `DATABASE_URL` and `MIGRATION_DATABASE_URL` to it. Keep the old database until the new one is
   confirmed; a human decides when to drop it.
5. The retention jobs are anchored and idempotent (ADR 0004 9.7): the next daily run deletes again
   anything the restore brought back that is past its limit.

### Known limits

- Row counts are taken in a separate read-only snapshot just before `pg_dump`. On a busy database
  they can differ by the rows written in between; the nightly job runs when traffic is lowest.
- The staging workflow assumes the staging database host accepts connections from GitHub-hosted
  runners (or a tunnel set up in the workflow). That is a staging deployment question (DEP-01).
