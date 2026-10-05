#!/bin/sh
# Restores a named backup into a FRESH database, then re-applies the erasures made since
# (DB-07, NFR-03, ADR 0004 R-7). It never restores over an existing database and never drops one.
#
#   restore.sh --target-db <new database name> [--backup <dump file name>|latest] [--skip-erasures]
#
# Environment: PGHOST PGPORT PGUSER PGPASSWORD for the server to restore INTO (the role needs
# CREATEDB, and the privileges pg_restore needs to create extensions), plus the S3_* and
# BACKUP_PREFIX settings that backup.sh uses.
#   RESTORE_ALLOW_REMOTE=1    allow a target server that is not this machine. Set only in GitHub
#                             Actions or on a server, where its credentials live (D-38). Without
#                             it the script runs the localhost guard (assert-local-db.mjs) and
#                             refuses any other PGHOST.
#   RESTORE_CREATE_APP_USER=1 create app_user (NOLOGIN) when the target server lacks it. The dump
#                             grants to app_user, and roles are not part of a database dump.
#                             Production servers have the role from provisioning (ADR 0006 7.5).
#
# Exit codes: 0 restored and verified; 1 error; 2 restored but the row counts differ from the
# counts recorded at backup time (the database is left in place for inspection).
set -eu
here=$(dirname "$0")
# shellcheck source=infra/backup/lib.sh
. "$here/lib.sh"

target=
backup=latest
reapply=yes
while [ "$#" -gt 0 ]; do
  case "$1" in
    --target-db) target=${2:-}; shift 2 || die "--target-db needs a value." ;;
    --backup) backup=${2:-}; shift 2 || die "--backup needs a value." ;;
    --skip-erasures) reapply=no; shift ;;
    *) die "unknown argument. Usage: restore.sh --target-db <name> [--backup <file>|latest] [--skip-erasures]" ;;
  esac
done
printf '%s' "$target" | grep -q '^[a-z_][a-z0-9_]\{0,62\}$' ||
  die "--target-db must be a plain lower-case database name (letters, digits, underscore)."
require_env PGHOST PGUSER

# Localhost guard (brief DB-07). Remote restores are for CI and servers only.
if [ "${RESTORE_ALLOW_REMOTE:-}" != "1" ]; then
  case "$PGHOST" in
    localhost | 127.0.0.1 | ::1) ;;
    *) die "PGHOST is not this machine. Remote restores run only in GitHub Actions or on the server (set RESTORE_ALLOW_REMOTE=1 there)." ;;
  esac
  case "${PGHOSTADDR:-}${PGSERVICE:-}" in '') ;; *) die "PGHOSTADDR and PGSERVICE are not allowed in a local restore." ;; esac
  if [ -f .env ] || [ -f "$here/../../.env" ]; then
    node "$here/../scripts/assert-local-db.mjs" || die "the localhost guard refused. Fix .env first."
  fi
fi

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
init_s3

if [ "$backup" = latest ]; then
  backup=$(list_keys "$DUMP_PREFIX" | sed -n "s#^$DUMP_PREFIX\\(codeproctor-$STAMP_RE\\.dump\\.gz\\)\$#\\1#p" | sort | tail -1)
  [ -n "$backup" ] || die "the bucket has no backup under $DUMP_PREFIX."
fi
printf '%s' "$backup" | grep -q "^codeproctor-$STAMP_RE\\.dump\\.gz\$" || die "--backup must be a file name like codeproctor-20261005T020000Z.dump.gz."
log "restoring $backup into new database $target..."

# 1. Download and verify the checksum before touching the server.
s3cp "s3://$BUCKET/$DUMP_PREFIX$backup" "$WORK/$backup"
s3cp "s3://$BUCKET/$DUMP_PREFIX$backup.sha256" "$WORK/$backup.sha256"
[ "$(sha256_of "$WORK/$backup")" = "$(tr -d ' \n' < "$WORK/$backup.sha256")" ] || die "checksum mismatch. The backup is damaged."
gzip -t "$WORK/$backup" || die "the gzip stream is damaged."
counts=${backup%.dump.gz}.counts.tsv
s3cp "s3://$BUCKET/$DUMP_PREFIX$counts" "$WORK/expected-counts.tsv"

# 2. Preconditions on the server: the client matches, the target is new, and app_user exists.
require_matching_client postgres pg_restore
psql_admin() { psql --no-psqlrc -X -At -v ON_ERROR_STOP=1 -d postgres "$@"; }
exists=$(psql_admin -c "SELECT 1 FROM pg_database WHERE datname = '$target'")
[ -z "$exists" ] || die "database $target already exists. Restore goes into a new database only."
role=$(psql_admin -c "SELECT 1 FROM pg_roles WHERE rolname = 'app_user'")
if [ -z "$role" ]; then
  [ "${RESTORE_CREATE_APP_USER:-}" = "1" ] || die "the server has no app_user role. Create it (ADR 0006 section 7.5) or set RESTORE_CREATE_APP_USER=1 for a drill."
  psql_admin -c "CREATE ROLE app_user NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS" > /dev/null
fi

# 3. Restore. A failure leaves the new database in place for inspection; nothing is dropped.
psql_admin -c "CREATE DATABASE \"$target\"" > /dev/null
gzip -dc "$WORK/$backup" | pg_restore --no-owner --exit-on-error --dbname "$target" ||
  die "pg_restore failed. Database $target was left in place for inspection."

# 4. Compare row counts with the counts taken at backup time, BEFORE erasures are re-applied.
psql --no-psqlrc -X -q -At -v ON_ERROR_STOP=1 -d "$target" > "$WORK/actual-counts.tsv" <<'SQL'
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT format('SELECT %L || E''\t'' || count(*) FROM %I.%I', c.relname, n.nspname, c.relname)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> '_prisma_migrations'
ORDER BY c.relname
\gexec
COMMIT;
SQL
status=0
if diff "$WORK/expected-counts.tsv" "$WORK/actual-counts.tsv" > "$WORK/counts.diff"; then
  log "row counts match the backup ($(wc -l < "$WORK/actual-counts.tsv" | tr -d ' ') tables)."
else
  log "row counts differ from the backup (table, count):"
  cat "$WORK/counts.diff" >&2
  status=2
fi

# 5. Re-apply the erasures (ADR 0004 R-7). Every entry on the list is applied, not just those
#    after the backup stamp: re-applying one that is already in the backup changes nothing.
if [ "$reapply" = yes ]; then
  "$here/erasure-list.sh" list > "$WORK/erasures.txt"
  n=$(wc -l < "$WORK/erasures.txt" | tr -d ' ')
  {
    printf 'CREATE TEMP TABLE _reapply_erasures (candidate_id uuid PRIMARY KEY, erased_at timestamptz NOT NULL);\n'
    while read -r stamp id; do
      is_uuid "$id" && is_stamp "$stamp" || die "the erasure list holds a malformed entry."
      iso=$(printf '%s' "$stamp" | sed 's/^\(....\)\(..\)\(..\)T\(..\)\(..\)\(..\)Z$/\1-\2-\3T\4:\5:\6Z/')
      printf "INSERT INTO _reapply_erasures VALUES ('%s', '%s') ON CONFLICT DO NOTHING;\n" "$id" "$iso"
    done < "$WORK/erasures.txt"
    printf '\\i %s/reapply-erasures.sql\n' "$here"
  } > "$WORK/reapply.sql"
  psql --no-psqlrc -X -q -v ON_ERROR_STOP=1 -d "$target" -f "$WORK/reapply.sql" > /dev/null
  log "re-applied $n erasure(s) from the erasure list."
fi
log "restore finished: database $target."
exit "$status"
