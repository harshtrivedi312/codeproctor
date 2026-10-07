# shellcheck shell=sh
# Shared helpers for backup.sh, restore.sh and erasure-list.sh (DB-07). Sourced, never run.
# POSIX sh. Nothing here prints a secret: no URL, key, password or token ever reaches a log line.

log() { printf '%s\n' "$*" >&2; }
die() { log "error: $*"; exit 1; }

require_env() {
  for name in "$@"; do
    eval "value=\${$name:-}"
    [ -n "$value" ] || die "$name is not set."
  done
}

# S3-compatible store (ADR 0001 section 2.1). Cloudflare R2 on staging (S3_ENDPOINT set,
# S3_REGION=auto); AWS S3 on pilot and production (S3_ENDPOINT empty; the instance role may
# replace the access keys). Credentials go to the aws CLI through its environment, never argv.
# AWS CLI v2 adds CRC32 checksums to uploads by default and R2 and other stores reject some of
# them, so they are sent only when an operation requires them.
init_s3() {
  require_env S3_BACKUP_BUCKET
  if [ -n "${S3_ACCESS_KEY_ID:-}" ]; then
    require_env S3_SECRET_ACCESS_KEY
    AWS_ACCESS_KEY_ID=$S3_ACCESS_KEY_ID
    AWS_SECRET_ACCESS_KEY=$S3_SECRET_ACCESS_KEY
    export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
  fi
  AWS_DEFAULT_REGION=${S3_REGION:-us-east-1}
  # R2 and other stores reject some of the CLI's default checksums; AWS S3 (no endpoint) keeps the
  # defaults, which an Object Lock bucket needs on uploads.
  if [ -n "${S3_ENDPOINT:-}" ]; then
    AWS_REQUEST_CHECKSUM_CALCULATION=when_required
    AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
    export AWS_REQUEST_CHECKSUM_CALCULATION AWS_RESPONSE_CHECKSUM_VALIDATION
  fi
  AWS_PAGER=
  export AWS_DEFAULT_REGION AWS_PAGER
  if [ "${S3_FORCE_PATH_STYLE:-false}" = "true" ]; then
    # An aws config file is the only way to choose path-style addressing.
    AWS_CONFIG_FILE=${WORK:?}/aws-config
    printf '[default]\ns3 =\n    addressing_style = path\n' > "$AWS_CONFIG_FILE"
    export AWS_CONFIG_FILE
  fi
  BUCKET=$S3_BACKUP_BUCKET
  PREFIX=${BACKUP_PREFIX:-db/}
  case "$PREFIX" in */) ;; *) PREFIX="$PREFIX/" ;; esac
  # The prefix goes into sed patterns, so only plain path characters are allowed.
  printf '%s' "$PREFIX" | grep -q '^[A-Za-z0-9_/-]*$' || die "BACKUP_PREFIX may hold only letters, digits, underscore, hyphen and slash."
  case "$PREFIX" in /* | *//*) die "BACKUP_PREFIX must be a relative path." ;; esac
  # These are read by the scripts that source this file.
  # BACKUP_MODE (ADR 0017 5.3, owner decision C-55):
  #   versioned    (default; pilot and production) one fixed key, a versioned bucket, a lifecycle rule
  #                that keeps the newest 3 versions, and a backup role that cannot delete anything.
  #   timestamped  (staging: Cloudflare R2 has no object versioning) one key per dump, and the script
  #                itself keeps the newest 3 and prunes the rest after 14 days.
  BACKUP_MODE=${BACKUP_MODE:-versioned}
  case "$BACKUP_MODE" in versioned | timestamped) ;; *) die "BACKUP_MODE must be versioned or timestamped." ;; esac
  export BACKUP_MODE
  # shellcheck disable=SC2034
  DUMP_KEY="${PREFIX}dump/latest.dump"
  # shellcheck disable=SC2034
  DUMP_PREFIX="${PREFIX}dumps/"
  # shellcheck disable=SC2034
  ERASURE_PREFIX="${PREFIX}erasure-list/"
  # shellcheck disable=SC2034
  COMPLETED_PREFIX="${PREFIX}erasure-completed/"
}

# s3api <aws s3api args...>: adds the endpoint when one is configured.
s3api() {
  if [ -n "${S3_ENDPOINT:-}" ]; then
    aws --endpoint-url "$S3_ENDPOINT" s3api "$@"
  else
    aws s3api "$@"
  fi
}
s3cp() {
  if [ -n "${S3_ENDPOINT:-}" ]; then
    aws --endpoint-url "$S3_ENDPOINT" s3 cp --only-show-errors "$@"
  else
    aws s3 cp --only-show-errors "$@"
  fi
}

# s3_put_once <file> <key> <content type>: writes the object only if the key does not exist yet
# (`If-None-Match: *`). An erasure-list entry is immutable (ADR 0004 R-7), and the pilot backup role
# is allowed to create objects but not to overwrite or delete them (ADR 0017 5.3): `aws s3 cp` cannot
# send the condition, so this uses put-object. A 412 means the entry already exists, which is success.
# Any other failure stops the caller: an erasure missing from the list could come back on a restore.
s3_put_once() {
  if s3api put-object --bucket "$BUCKET" --key "$2" --body "$1" --content-type "$3" --if-none-match '*' > /dev/null 2> "$WORK/put.err"; then
    return 0
  fi
  if grep -Eq 'PreconditionFailed|\(412\)' "$WORK/put.err"; then
    log "already exists, left as it is."
    return 0
  fi
  die "could not write the erasure list entry (not a 'precondition failed' answer)."
}

# load_keys <prefix>: sets KEYS to every key under the prefix, one per line. It runs in the main
# shell and dies when the listing fails: a pipeline would hide the failure (POSIX sh has no
# pipefail), and a restore that cannot read the erasure list must not look like an empty list.
load_keys() {
  s3api list-objects-v2 --bucket "$BUCKET" --prefix "$1" --query 'Contents[].Key' --output text > "$WORK/list.out" ||
    die "cannot list the bucket under $1."
  KEYS=$(tr '\t' '\n' < "$WORK/list.out" | sed '/^None$/d;/^$/d')
}
# keys_grep <grep args>: greps KEYS.
keys_grep() { printf '%s\n' "$KEYS" | grep "$@"; }

# stamp_lt <a> <b>: true when stamp a is earlier than stamp b. Stamps look like 20261005T020000Z; with
# the T and Z removed they are 14-digit numbers, so the comparison is numeric (POSIX test has no
# string ordering).
stamp_lt() {
  [ "$(printf '%s' "$1" | tr -d 'TZ')" -lt "$(printf '%s' "$2" | tr -d 'TZ')" ]
}

utc_stamp() { date -u +%Y%m%dT%H%M%SZ; }

# stamp_days_ago <days>: a UTC stamp in the key format. GNU date and BSD date differ.
stamp_days_ago() {
  date -u -d "-$1 days" +%Y%m%dT%H%M%SZ 2>/dev/null || date -u -v-"$1"d +%Y%m%dT%H%M%SZ
}

# sha256_of <file>: the hex digest only.
sha256_of() {
  if command -v sha256sum > /dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# Timestamped-mode dump keys look like <prefix>dumps/codeproctor-20261005T020000Z.dump
STAMP_RE='[0-9]\{8\}T[0-9]\{6\}Z'
UUID_RE='^[0-9a-fA-F]\{8\}-[0-9a-fA-F]\{4\}-[0-9a-fA-F]\{4\}-[0-9a-fA-F]\{4\}-[0-9a-fA-F]\{12\}$'

is_uuid() { printf '%s' "$1" | grep -q "$UUID_RE"; }
is_stamp() { printf '%s' "$1" | grep -q "^$STAMP_RE\$"; }

# require_matching_client <tool>: the PostgreSQL client tool must have the server's major version.
# A newer client writes or replays settings (for example SET transaction_timeout, version 17) that
# an older server rejects, and the backup would look fine until the day it is needed.
# PG_BIN_DIR points at the right client when several are installed. Needs PG* set for psql.
require_matching_client() {
  if [ -n "${PG_BIN_DIR:-}" ]; then PATH=$PG_BIN_DIR:$PATH; export PATH; fi
  # An empty first argument means "use PGDATABASE from the environment", so it never appears in argv.
  if [ -n "${1:-}" ]; then
    version_num=$(psql --no-psqlrc -X -At -v ON_ERROR_STOP=1 -d "$1" -c 'SHOW server_version_num') || die "cannot reach the database server."
  else
    version_num=$(psql --no-psqlrc -X -At -v ON_ERROR_STOP=1 -c 'SHOW server_version_num') || die "cannot reach the database server."
  fi
  server_major=$(printf '%s' "$version_num" | cut -c1-2)
  for tool in $2; do
    client_major=$("$tool" --version | sed -n 's/^[a-z_]* (PostgreSQL) \([0-9]*\).*/\1/p')
    [ "$server_major" = "$client_major" ] ||
      die "$tool is version ${client_major:-unknown} but the server is version $server_major. Install the matching client or set PG_BIN_DIR."
  done
}
