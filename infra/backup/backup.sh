#!/bin/sh
# Nightly database backup (DB-07, NFR-03, ADR 0004 R-7).
#
# pg_dump (custom format, compressed) -> checks -> upload to the S3-compatible backup bucket
# (Cloudflare R2 on staging, AWS S3 on pilot and production).
#
# BACKUP_MODE=versioned (default; pilot and production, ADR 0017 5.3, owner decision C-55): the dump goes
# to ONE fixed key, <prefix>dump/latest.dump, in a versioned bucket. Each night is a new object version,
# a lifecycle rule keeps the newest 3 versions, and the backup role has no delete permission, so in
# this mode the script NEVER deletes or rotates anything. restore.sh takes a version id.
# BACKUP_MODE=timestamped (staging: Cloudflare R2 has no object versioning): <prefix>dumps/
# codeproctor-<stamp>.dump per night; the script keeps the newest 3 whatever their age and prunes
# the rest after BACKUP_RETENTION_DAYS (14). Synthetic data only.
# In both modes the checksum, the dump time and the row counts travel as the object's own metadata
# (sha256, dumped-at, counts), so they can never belong to another object or version.
#
# Environment (nothing is accepted on the command line, so no secret shows up in `ps`):
#   PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE   the database to dump (libpq settings)
#   S3_BACKUP_BUCKET, S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY,
#   S3_FORCE_PATH_STYLE                          the store (same names as .env.example)
#   PG_BIN_DIR               optional directory with the pg_dump that matches the server version
#   BACKUP_PREFIX            key prefix, default "db/"
#   BACKUP_MODE              versioned (default) or timestamped
#   BACKUP_RETENTION_DAYS    timestamped mode only, default 14
#   BACKUP_KEEP_NEWEST       timestamped mode only, default 3: never pruned whatever their age (C-55)
#   BACKUP_SSE               optional server-side encryption, for example AES256 (AWS S3). Leave
#                            empty on R2, which always encrypts at rest.
#
# Staging and pilot credentials exist only in GitHub Actions secrets and on the servers
# (ADR 0009). Never run this against them from a developer machine or an agent session.
#
# The dump runs as a role that can read every table (the migration owner, not app_user).
# Object uploaded: <prefix>dump/latest.dump (versioned) or <prefix>dumps/codeproctor-<stamp>.dump
# (timestamped), with metadata sha256, dumped-at and counts.
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
KEEP_NEWEST=${BACKUP_KEEP_NEWEST:-3}
case "$KEEP_NEWEST" in '' | *[!0-9]*) die "BACKUP_KEEP_NEWEST must be a whole number." ;; esac
if [ "$KEEP_NEWEST" -lt 1 ] || [ "$KEEP_NEWEST" -gt 1000 ]; then die "BACKUP_KEEP_NEWEST must be between 1 and 1000."; fi

WORK=$(mktemp -d)
# The work directory holds a plaintext dump of candidate data: remove it on every way out,
# signals included (dash runs the EXIT trap after `exit`, not after a signal by itself).
trap 'rm -rf "$WORK"' EXIT
trap 'exit 1' INT TERM HUP
init_s3

stamp=$(utc_stamp)
file=$WORK/dump
if [ "$BACKUP_MODE" = timestamped ]; then key="${DUMP_PREFIX}codeproctor-$stamp.dump"; else key=$DUMP_KEY; fi

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
#    The dump goes to a file first: a pipe would hide pg_dump's exit status (POSIX sh has no
#    pipefail), and a dump cut off after its table of contents would still look valid.
log "dumping the database..."
pg_dump --format=custom --compress=6 --no-owner --quote-all-identifiers --file="$file" ||
  die "pg_dump failed. Nothing was uploaded."

# 3. Verify before anything is uploaded (the dump is read on stdin, so a client that runs elsewhere works too): pg_restore can read it, every data block is intact.
pg_restore --list < "$file" > "$WORK/toc.txt" || die "pg_restore cannot read the dump."
# A full read of every data block catches a truncated archive that the table of contents hides.
pg_restore --file=/dev/null < "$file" || die "the dump is truncated or damaged."
# An empty or partial dump must never become the newest version: every table counted above needs a data entry.
tables=$(wc -l < "$WORK/counts.tsv" | tr -d ' ')
data=$(grep -c ' TABLE DATA ' "$WORK/toc.txt" || true)
# Fail closed: a test that errors (a non-integer) must also stop the upload.
if ! { [ "$tables" -gt 0 ] && [ "$data" -ge "$tables" ]; }; then
  die "the dump holds $data table data entries but the database has $tables tables."
fi
sum=$(sha256_of "$file")
size=$(wc -c < "$file" | tr -d ' ')
# The counts ride in the object's metadata as table=count,table=count (S3 allows about 2 KB).
counts=$(tr '\t' '=' < "$WORK/counts.tsv" | paste -sd, -)
[ "${#counts}" -le 1500 ] || die "the row counts are too long for object metadata."
printf '%s' "$counts" | grep -q '^[a-z0-9_=,]*$' || die "unexpected characters in the row counts."

# 4. Upload to the one fixed key (a new object version on a versioned bucket) and confirm it.
if [ "$BACKUP_MODE" = versioned ]; then
  # Before overwriting anything: an existing object without a version id means the bucket is not
  # versioned, and this upload would replace the only backup ("null" is fine: it is an object from
  # before versioning was switched on). A missing object (first backup) is fine too.
  # Only "not found" counts as a first backup. Any other failure (403, a network error, throttling, a
  # wrong endpoint) must stop the run: it cannot be told apart from an existing, unversioned backup.
  if prev=$(s3api head-object --bucket "$BUCKET" --key "$key" --query VersionId --output text 2> "$WORK/head.err"); then
    case "$prev" in None) die "the bucket does not return a version id for the existing $key: it is not versioned. Nothing was uploaded." ;; esac
  elif grep -Eq '\(404\)|NoSuchKey|Not Found' "$WORK/head.err"; then
    log "no earlier backup at $key: this is the first one."
  else
    die "cannot check for an earlier backup at $key, so nothing was uploaded (not a 'not found' answer)."
  fi
fi
set --
[ -z "${BACKUP_SSE:-}" ] || set -- --sse "$BACKUP_SSE"
s3cp "$file" "s3://$BUCKET/$key" --metadata "{\"sha256\":\"$sum\",\"dumped-at\":\"$stamp\",\"counts\":\"$counts\"}" "$@"
remote=$(s3api head-object --bucket "$BUCKET" --key "$key" --query ContentLength --output text)
[ "$remote" = "$size" ] || die "uploaded size $remote differs from local size $size."
stored=$(s3api head-object --bucket "$BUCKET" --key "$key" --query 'Metadata.sha256' --output text)
[ "$stored" = "$sum" ] || die "the stored object does not carry this dump's checksum."
log "uploaded $key ($size bytes, dumped at $stamp)."
if [ "$BACKUP_MODE" = versioned ]; then
  # A bucket without versioning would have just overwritten the only backup: fail loudly (the
  # backups the owner counts on are then fewer than C-55 promises).
  vid=$(s3api head-object --bucket "$BUCKET" --key "$key" --query VersionId --output text)
  case "$vid" in '' | None | null) die "the bucket does not return a version id for $key: it is not versioned. The previous backup was overwritten." ;; esac
  log "stored as version $vid."
fi

if [ "$BACKUP_MODE" = versioned ]; then
  log "versioned mode: nothing is deleted; the bucket's lifecycle rotates the versions. The erasure list is pruned by the owner-applied expiry function."
  log "backup finished."
  exit 0
fi

# 5. Timestamped mode only: prune, now that the new backup is safely stored. Dumps older than the
#    retention period go, except the newest KEEP_NEWEST (3 by default, C-55): they stay whatever their
#    age, so a stalled schedule cannot empty the bucket.
cutoff=$(stamp_days_ago "$RETENTION_DAYS")
load_keys "$DUMP_PREFIX"
keep=$(printf '%s\n' "$KEYS" | sed -n "s#^$DUMP_PREFIX\\(codeproctor-$STAMP_RE\\)\\.dump\$#\\1#p" | sort -r | head -n "$KEEP_NEWEST")
# Fail closed: the new dump must be in the keep set, or nothing is pruned.
printf '%s\n' "$keep" | grep -qx "codeproctor-$stamp" || die "the new backup is not in the keep set; nothing was pruned."
printf '%s\n' "$KEYS" | while IFS= read -r k; do
  base=${k#"$DUMP_PREFIX"}
  case "$base" in codeproctor-*) ;; *) continue ;; esac
  keystamp=$(printf '%s' "$base" | sed -n "s#^codeproctor-\\($STAMP_RE\\)\\.dump\$#\\1#p")
  [ -n "$keystamp" ] || continue
  printf '%s\n' "$keep" | grep -qx "codeproctor-$keystamp" && continue
  if stamp_lt "$keystamp" "$cutoff"; then
    s3api delete-object --bucket "$BUCKET" --key "$k" > /dev/null < /dev/null
    log "pruned $k."
  fi
done

# 6. The erasure list only needs entries whose erasure COMPLETED after the oldest backup that is
#    left (an erasure finished earlier is already in every remaining backup). One day of margin.
#    Entries not marked complete are never pruned (see erasure-list.sh).
load_keys "$DUMP_PREFIX"
oldest=$(printf '%s\n' "$KEYS" | sed -n "s#^$DUMP_PREFIX\\(codeproctor-$STAMP_RE\\)\\.dump\$#\\1#p" | sort | head -1)
oldest=${oldest#codeproctor-}
if [ -n "$oldest" ]; then
  oday=$(printf '%s' "$oldest" | cut -c1-8)
  margin=$(date -u -d "$oday -1 day" +%Y%m%d 2>/dev/null || date -u -j -v-1d -f %Y%m%d "$oday" +%Y%m%d)
  sh "$here/erasure-list.sh" prune "${margin}T000000Z"
fi
log "backup finished."
