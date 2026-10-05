#!/bin/sh
# Nightly database backup (DB-07, NFR-03, ADR 0004 R-7).
#
# pg_dump (custom format) -> gzip -> checks -> upload to the S3-compatible backup bucket
# (Cloudflare R2 on staging, AWS S3 on pilot and production) -> prune dumps older than 14 days.
#
# Environment (nothing is accepted on the command line, so no secret shows up in `ps`):
#   PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE   the database to dump (libpq settings)
#   S3_BACKUP_BUCKET, S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY,
#   S3_FORCE_PATH_STYLE                          the store (same names as .env.example)
#   PG_BIN_DIR               optional directory with the pg_dump that matches the server version
#   BACKUP_PREFIX            key prefix, default "db/"
#   BACKUP_RETENTION_DAYS    default 14
#   BACKUP_SSE               optional server-side encryption, for example AES256 (AWS S3). Leave
#                            empty on R2, which always encrypts at rest.
#
# Staging and pilot credentials exist only in GitHub Actions secrets and on the servers
# (ADR 0009). Never run this against them from a developer machine or an agent session.
#
# The dump runs as a role that can read every table (the migration owner, not app_user).
# Note on `[ a \< b ]` below: dash and bash accept it; a shell that did not would never prune, which is safe.
# Objects uploaded: <prefix>dumps/codeproctor-<stamp>.dump.gz, .sha256, .counts.tsv
set -eu
here=$(dirname "$0")
# shellcheck source=infra/backup/lib.sh
. "$here/lib.sh"

[ "$#" -eq 0 ] || die "backup.sh takes no arguments. Configure it through the environment."
require_env PGHOST PGDATABASE PGUSER
# libpq reads a connection string with a password from PGDATABASE; only a plain name is allowed,
# so nothing sensitive can reach a log line or a command line.
printf '%s' "$PGDATABASE" | grep -q '^[A-Za-z0-9_.-]\{1,63\}$' || die "PGDATABASE must be a plain database name."
RETENTION_DAYS=${BACKUP_RETENTION_DAYS:-14}
case "$RETENTION_DAYS" in '' | *[!0-9]*) die "BACKUP_RETENTION_DAYS must be a whole number." ;; esac
[ "$RETENTION_DAYS" -ge 1 ] || die "BACKUP_RETENTION_DAYS must be at least 1."

WORK=$(mktemp -d)
# The work directory holds a plaintext dump of candidate data: remove it on every way out,
# signals included (dash runs the EXIT trap after `exit`, not after a signal by itself).
trap 'rm -rf "$WORK"' EXIT
trap 'exit 1' INT TERM HUP
init_s3

stamp=$(utc_stamp)
name=codeproctor-$stamp.dump.gz
file=$WORK/$name

# 0. The dump client must match the server's major version (see lib.sh).
require_matching_client "" pg_dump

# 1. Row counts, in one read-only snapshot. The restore drill compares them (TC-none, NFR-03).
psql --no-psqlrc -X -q -At -v ON_ERROR_STOP=1 > "$WORK/counts.tsv" <<'SQL'
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT format('SELECT %L || E''\t'' || count(*) FROM %I.%I', c.relname, n.nspname, c.relname)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> '_prisma_migrations'
ORDER BY c.relname
\gexec
COMMIT;
SQL

# 2. Dump. --no-owner lets a restore run as any role; privileges (GRANT to app_user) are kept.
#    -Z0 because gzip compresses the whole stream afterwards.
#    The dump goes to a file first: a pipe would hide pg_dump's exit status (POSIX sh has no
#    pipefail), and a dump cut off after its table of contents would still look valid.
log "dumping the database..."
pg_dump --format=custom --compress=0 --no-owner --quote-all-identifiers --file="$WORK/dump" ||
  die "pg_dump failed. Nothing was uploaded or pruned."
gzip -6 -c "$WORK/dump" > "$file"
rm -f "$WORK/dump"

# 3. Verify before anything is uploaded or deleted: the gzip is intact and pg_restore can read it.
gzip -t "$file" || die "the gzip stream is damaged."
gzip -dc "$file" | pg_restore --list > "$WORK/toc.txt" || die "pg_restore cannot read the dump."
# A full read of every data block catches a truncated archive that the table of contents hides.
gzip -dc "$file" | pg_restore --file=/dev/null || die "the dump is truncated or damaged."
# An empty or partial dump must never replace a good one: every table counted above needs a data entry.
tables=$(wc -l < "$WORK/counts.tsv" | tr -d ' ')
data=$(grep -c ' TABLE DATA ' "$WORK/toc.txt" || true)
[ "$tables" -gt 0 ] && [ "$data" -ge "$tables" ] || die "the dump holds $data table data entries but the database has $tables tables."
sha256_of "$file" > "$WORK/$name.sha256"
size=$(wc -c < "$file" | tr -d ' ')

# 4. Upload and confirm the stored size.
set --
[ -z "${BACKUP_SSE:-}" ] || set -- --sse "$BACKUP_SSE"
# The dump goes up LAST: a dump that is present always has its checksum and counts, so
# "restore latest" never picks a backup it cannot verify.
s3cp "$WORK/$name.sha256" "s3://$BUCKET/$DUMP_PREFIX$name.sha256" "$@"
s3cp "$WORK/counts.tsv" "s3://$BUCKET/$DUMP_PREFIX${name%.dump.gz}.counts.tsv" "$@"
s3cp "$file" "s3://$BUCKET/$DUMP_PREFIX$name" "$@"
remote=$(s3api head-object --bucket "$BUCKET" --key "$DUMP_PREFIX$name" --query ContentLength --output text)
[ "$remote" = "$size" ] || die "uploaded size $remote differs from local size $size. Nothing was pruned."
log "uploaded $DUMP_PREFIX$name ($size bytes)."

# 5. Prune, only now that the new backup is safely stored. Dumps older than the retention
#    period go; the newest dump is never pruned, so a stalled schedule cannot empty the bucket.
cutoff=$(stamp_days_ago "$RETENTION_DAYS")
load_keys "$DUMP_PREFIX"
newest=$(printf '%s\n' "$KEYS" | sed -n "s#^$DUMP_PREFIX\\(codeproctor-$STAMP_RE\\)\\.dump\\.gz\$#\\1#p" | sort | tail -1)
printf '%s\n' "$KEYS" | while read -r key; do
  base=${key#"$DUMP_PREFIX"}
  case "$base" in codeproctor-*) ;; *) continue ;; esac
  keystamp=$(printf '%s' "$base" | sed -n "s#^codeproctor-\\($STAMP_RE\\)\\..*#\\1#p")
  [ -n "$keystamp" ] || continue
  [ "codeproctor-$keystamp" != "$newest" ] || continue
  if [ "$keystamp" \< "$cutoff" ]; then
    s3api delete-object --bucket "$BUCKET" --key "$key" > /dev/null
    log "pruned $key."
  fi
done

# 6. The erasure list only needs entries whose erasure COMPLETED after the oldest backup that is
#    left (an erasure finished earlier is already in every remaining backup). One day of margin.
#    Entries not marked complete are never pruned (see erasure-list.sh).
load_keys "$DUMP_PREFIX"
oldest=$(printf '%s\n' "$KEYS" | sed -n "s#^$DUMP_PREFIX\\(codeproctor-$STAMP_RE\\)\\.dump\\.gz\$#\\1#p" | sort | head -1)
oldest=${oldest#codeproctor-}
if [ -n "$oldest" ]; then
  oday=$(printf '%s' "$oldest" | cut -c1-8)
  margin=$(date -u -d "$oday -1 day" +%Y%m%d 2>/dev/null || date -u -j -v-1d -f %Y%m%d "$oday" +%Y%m%d)
  sh "$here/erasure-list.sh" prune "${margin}T000000Z"
fi
log "backup finished."
