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
| `infra/backup/backup.sh` | `pg_dump` (custom format) to a file, then gzip. It checks that the gzip and the dump are readable and that every table has a data entry. It uploads `dumps/codeproctor-<UTC stamp>.dump.gz`, `.sha256` and `.counts.tsv` to the backup bucket, checks the stored size, then deletes dumps older than 14 days and erasure-list entries that no remaining backup needs. The newest dump is never pruned. |
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
database and its dumps. One object per erasure request, named `<UTC stamp>-<candidate uuid>.json`,
holding the id and time only (no name or email). `restore.sh` re-applies **every** entry after the
restore; the SQL is idempotent except that `sessions.auth_epoch` only increases (`infra/backup/reapply-erasures.sql`), it follows C-17 (the consent
record is kept), it also raises `sessions.auth_epoch` by 1,000,000 (past any epoch issued between the backup and the erasure) and clears `hmac_key_enc` and `report_key` so
old candidate tokens and keys do not come back, and it does not touch object storage (objects
already deleted stay deleted). Restored rows can still point at deleted objects until the retention
jobs run.

The erasure service (DB-06) calls, in this order:
1. `erasure-list.sh append <uuid>` **before** it commits the erasure to the database. A crash then
   leaves an entry for an erasure that did not happen, which is harmless, instead of an erasure that
   a restore would undo.
2. `erasure-list.sh complete <uuid>` once the candidate row is anonymised and `ERASURE_COMPLETED` is
   written. An erasure can finish weeks after the request (review or appeal hold, the re-run after
   the fence, anonymisation at day 28), and every backup taken until then still holds the personal
   data. So `backup.sh` prunes an entry only when its **completion** is more than a day older than the oldest remaining
   backup, and never prunes an entry without a completion marker.

`restore.sh` also raises `auth_epoch` by 1,000,000 on **every** restored session, so a token revoked since the backup (a device that lost its session to another device) does not work again; candidates sign in again. It also revokes every staff refresh token, so staff sign in again (a restore would otherwise un-revoke and un-rotate them).

A zero-byte "folder" object at `<prefix>erasure-list/` (some consoles create one) makes every restore stop, by design: any key there that is not `<stamp>-<uuid>.json` could be an erasure. Delete the folder object.

Known gaps until DB-06 lands (FU-DBB-01): re-application erases every session of the candidate even if a
review or appeal hold still protects it, anonymises the candidate at once instead of at day 28, and sets
no `ERASED` status.

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
   with `PG*` pointing at the server, as the **migration owner role** (`--no-owner` makes the restoring
   role the owner of every object, and later migrations run as the migration owner). The role needs
   `CREATEDB`. `--skip-erasures` is refused here. `app_user` must already exist on the
   server (ADR 0006 section 7.5); the script stops if not.
3. Exit code 0: restored, counts match, erasures re-applied. Exit code 2 (only this): restored, but the row
   counts differ from the backup; inspect before using it. Any other failure is exit code 1. If the output says
   the erasures were NOT re-applied, do not use that database: it holds personal data that was erased.
4. Check the application against the new database (`app_user` grants, `audit_logs` append-only), then
   switch `DATABASE_URL` and `MIGRATION_DATABASE_URL` to it. Keep the old database until the new one is
   confirmed; a human decides when to drop it.
5. The retention jobs are anchored and idempotent (ADR 0004 9.7): the next daily run deletes again
   anything the restore brought back that is past its limit.

### Preconditions for the nightly staging workflow

The workflow handles staging database and bucket credentials. Before the owner creates the secrets:
the `staging` environment must allow deployment from the `main` branch only (otherwise any pushed branch
can edit `backup.sh`, dispatch the workflow and read the secrets), must have no required reviewers
(they would stall the schedule), and the database connection must use `PGSSLMODE=verify-full` with a
trusted root certificate. See FU-DBB-04.

### Known limits

- Row counts are taken in a separate read-only snapshot just before `pg_dump`. On a busy database
  they can differ by the rows written in between; the nightly job runs when traffic is lowest.
- The staging workflow assumes the staging database host accepts connections from GitHub-hosted
  runners (or a tunnel set up in the workflow). That is a staging deployment question (DEP-01).

## Provisioning a pilot organization (ADR 0006 section 8.9)

Owner: Database B (ops) track. Files: `infra/scripts/provision-org.mjs`, `provision-org-core.mjs`;
tests `infra/scripts/provision-org.test.mjs`. Only the owner runs this, on the pilot host (over SSH from a
GitHub Actions job, or on a self-hosted runner inside the pilot network), never from a developer machine
or an agent session (ADR 0009, D-38). A GitHub-hosted runner never connects straight to the pilot database.

What it does: creates the organization and its first SUPER_ADMIN (no password) and one `audit_logs` row
in one transaction, then queues a `set-password` job that emails the admin a one-time link (72 hours,
single use). The link is built by the job, never by this script: no link or token is ever printed,
logged, written to a file or put in a queue payload.

### Inputs

A JSON file on the pilot host (or written from a secret), never command-line values, environment
variables or `workflow_dispatch` inputs (the email is personal data, and masking does not hide inputs
in run metadata):

```json
{ "orgName": "Example Corp", "retentionDays": 90, "adminEmail": "admin@example.com", "adminName": "A. Admin" }
```

`retentionDays` is optional (default 90; 7 to 730). `reissue` takes only `orgName` and `adminEmail`.
Environment: `DATABASE_URL` (the `app_user` URL; the script refuses any other role and has no
`MIGRATION_DATABASE_URL` fallback) and `REDIS_URL`. Nothing else is read.

### Run

```bash
node --import tsx infra/scripts/provision-org.mjs create  --file /secure/path/org.json
node --import tsx infra/scripts/provision-org.mjs reissue --file /secure/path/org.json
```

`create` prints `org=<id> user=<id>` and nothing else. Exit code 0: done. Exit code 1: bad input,
configuration or a failure (an error that names a field, never a value; nothing was created, except when
the message says otherwise). Exit code 2: the org and admin exist but the job could not be queued
(Redis down): run `reissue` with the same file. `reissue` works only for an active SUPER_ADMIN of the
named org who has no password yet; each run queues the job again, and only the last link works.

### Before the first run

- The API's `set-password` job processor (BE-06) must be deployed, and `bullmq` must be installed in
  `apps/api`; until then the script stops before it creates anything.
- Run `pnpm db:generate` once on the host (the script loads the Prisma client from `apps/api`).
- After `create`, delete the input file if it came from a secret mount.
- Check `audit_logs` for one `ORG_PROVISIONED` row (ids only, no email) and that the admin got the email.
