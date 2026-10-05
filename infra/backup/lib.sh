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
  AWS_REQUEST_CHECKSUM_CALCULATION=when_required
  AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
  AWS_PAGER=
  export AWS_DEFAULT_REGION AWS_REQUEST_CHECKSUM_CALCULATION AWS_RESPONSE_CHECKSUM_VALIDATION AWS_PAGER
  if [ "${S3_FORCE_PATH_STYLE:-false}" = "true" ]; then
    # An aws config file is the only way to choose path-style addressing.
    AWS_CONFIG_FILE=${WORK:?}/aws-config
    printf '[default]\ns3 =\n    addressing_style = path\n' > "$AWS_CONFIG_FILE"
    export AWS_CONFIG_FILE
  fi
  BUCKET=$S3_BACKUP_BUCKET
  PREFIX=${BACKUP_PREFIX:-db/}
  case "$PREFIX" in */) ;; *) PREFIX="$PREFIX/" ;; esac
  case "$PREFIX" in /* | *..*) die "BACKUP_PREFIX must be a relative path without '..'." ;; esac
  DUMP_PREFIX="${PREFIX}dumps/"
  ERASURE_PREFIX="${PREFIX}erasure-list/"
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

# list_keys <prefix>: one key per line, all pages.
list_keys() {
  s3api list-objects-v2 --bucket "$BUCKET" --prefix "$1" --query 'Contents[].Key' --output text |
    tr '\t' '\n' | sed '/^None$/d;/^$/d'
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

# Dump keys look like <prefix>dumps/codeproctor-20261005T020000Z.dump.gz
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
  server_major=$(psql --no-psqlrc -X -At -v ON_ERROR_STOP=1 -d "${1:-postgres}" -c 'SHOW server_version_num' | cut -c1-2)
  for tool in $2; do
    client_major=$("$tool" --version | sed -n 's/^[a-z_]* (PostgreSQL) \([0-9]*\).*/\1/p')
    [ "$server_major" = "$client_major" ] ||
      die "$tool is version ${client_major:-unknown} but the server is version $server_major. Install the matching client or set PG_BIN_DIR."
  done
}
