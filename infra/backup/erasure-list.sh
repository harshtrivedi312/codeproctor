#!/bin/sh
# The erased-candidate list (ADR 0004 R-7, docs/database.md "Backups"). It lives OUTSIDE the
# database and its backups, in the backup bucket under <prefix>erasure-list/, so a restore can
# re-apply every erasure made after the backup was taken.
#
# One immutable object per erasure, named <UTC stamp>-<candidate uuid>.json. The key carries all
# the information, so readers need one list call and appends from two erasures never race.
# The body ({"candidateId":..., "erasedAt":...}) is for humans. The list holds ids only:
# no name, email or other personal data.
#
#   erasure-list.sh append <candidate-uuid> [<UTC stamp>]   record an erasure (idempotent)
#   erasure-list.sh list                                     print "<stamp> <uuid>" per entry
#   erasure-list.sh prune <UTC stamp>                        drop entries older than the stamp
#
# The erasure service must append BEFORE it commits the erasure to the database (DB-06): a
# crash then leaves an entry for an erasure that did not happen, which is harmless (re-applying
# erases a candidate who asked to be erased), instead of an erasure that a restore would undo.
set -eu
here=$(dirname "$0")
# shellcheck source=infra/backup/lib.sh
. "$here/lib.sh"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
init_s3

cmd=${1:-}
case "$cmd" in
  append)
    id=${2:-}
    stamp=${3:-$(utc_stamp)}
    is_uuid "$id" || die "append needs a candidate uuid."
    is_stamp "$stamp" || die "the time must look like 20261005T020000Z."
    id=$(printf '%s' "$id" | tr 'A-F' 'a-f')
    # An entry for this candidate may exist already (an earlier request); keep the first one.
    if list_keys "$ERASURE_PREFIX" | grep -q -- "-$id\.json\$"; then
      log "candidate already on the erasure list."
      exit 0
    fi
    printf '{"candidateId":"%s","erasedAt":"%s"}\n' "$id" "$stamp" > "$WORK/entry.json"
    s3cp "$WORK/entry.json" "s3://$BUCKET/$ERASURE_PREFIX$stamp-$id.json" --content-type application/json
    ;;
  list)
    list_keys "$ERASURE_PREFIX" |
      sed -n "s#^$ERASURE_PREFIX\\($STAMP_RE\\)-\\([0-9a-f-]\\{36\\}\\)\\.json\$#\\1 \\2#p" | sort
    ;;
  prune)
    before=${2:-}
    is_stamp "$before" || die "prune needs a UTC stamp."
    "$0" list | while read -r stamp id; do
      if [ "$stamp" \< "$before" ]; then
        s3api delete-object --bucket "$BUCKET" --key "$ERASURE_PREFIX$stamp-$id.json" > /dev/null
        log "pruned erasure-list entry from $stamp."
      fi
    done
    ;;
  *)
    die "usage: erasure-list.sh append <uuid> [stamp] | list | prune <stamp>"
    ;;
esac
