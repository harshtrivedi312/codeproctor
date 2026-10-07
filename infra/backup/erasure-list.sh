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
#   erasure-list.sh append <candidate-uuid> [<UTC stamp>]    record an erasure request (idempotent)
#   erasure-list.sh complete <candidate-uuid>                   record that the erasure is finished
#   erasure-list.sh list                                      print "<stamp> <uuid>" per entry
#   erasure-list.sh prune <UTC stamp>                         drop COMPLETED entries finished before the stamp
#
# An erasure can finish long after it was requested (a review or appeal hold, the re-run after the
# fence, day-28 anonymisation: ADR 0004 9.5). Backups taken in between still hold the personal data,
# so an entry is pruned on its COMPLETION time, never on its request time, and an entry without a
# completion marker is never pruned. The erasure service calls `complete` once the candidate row is
# anonymised and ERASURE_COMPLETED is written.
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
    load_keys "$ERASURE_PREFIX"
    if keys_grep -q -- "-$id\.json\$"; then
      log "candidate already on the erasure list."
      exit 0
    fi
    printf '{"candidateId":"%s","erasedAt":"%s"}\n' "$id" "$stamp" > "$WORK/entry.json"
    s3cp "$WORK/entry.json" "s3://$BUCKET/$ERASURE_PREFIX$stamp-$id.json" --content-type application/json
    ;;
  complete)
    # Always "now": a back-dated completion could get the entry pruned while backups still hold the data.
    id=${2:-}
    [ "$#" -le 2 ] || die "complete takes only a candidate uuid."
    stamp=$(utc_stamp)
    is_uuid "$id" || die "complete needs a candidate uuid."
    id=$(printf '%s' "$id" | tr 'A-F' 'a-f')
    load_keys "$ERASURE_PREFIX"
    keys_grep -q -- "-$id\.json\$" || die "the candidate is not on the erasure list. Run append first."
    load_keys "$COMPLETED_PREFIX"
    if keys_grep -q -- "-$id\.json\$"; then
      log "erasure already marked complete."
      exit 0
    fi
    printf '{"candidateId":"%s","completedAt":"%s"}\n' "$id" "$stamp" > "$WORK/done.json"
    s3cp "$WORK/done.json" "s3://$BUCKET/$COMPLETED_PREFIX$stamp-$id.json" --content-type application/json
    ;;
  list)
    load_keys "$ERASURE_PREFIX"
    [ -n "$KEYS" ] || exit 0
    printf '%s\n' "$KEYS" |
      sed -n "s#^$ERASURE_PREFIX\\($STAMP_RE\\)-\\([0-9a-f-]\\{36\\}\\)\\.json\$#\\1 \\2#p" | sort > "$WORK/parsed"
    # An entry that does not parse must stop a restore, never be skipped: it may be an erasure.
    [ "$(wc -l < "$WORK/parsed" | tr -d ' ')" = "$(printf '%s\n' "$KEYS" | wc -l | tr -d ' ')" ] ||
      die "a key under $ERASURE_PREFIX is not named <stamp>-<lower-case uuid>.json."
    cat "$WORK/parsed"
    ;;
  prune)
    [ "$BACKUP_MODE" = timestamped ] || die "prune is for BACKUP_MODE=timestamped only; in versioned mode the owner-applied expiry function prunes the list."
    before=${2:-}
    is_stamp "$before" || die "prune needs a UTC stamp."
    # Only entries whose completion marker is older than the stamp. Entries without a marker stay.
    load_keys "$COMPLETED_PREFIX"
    printf '%s\n' "$KEYS" |
      sed -n "s#^$COMPLETED_PREFIX\\($STAMP_RE\\)-\\([0-9a-f-]\\{36\\}\\)\\.json\$#\\1 \\2#p" > "$WORK/completed"
    load_keys "$ERASURE_PREFIX"
    while read -r done_stamp id; do
      if stamp_lt "$done_stamp" "$before"; then
        # The request entry goes first: if it fails the marker stays, and the next run retries.
        printf '%s\n' "$KEYS" | { grep -- "-$id\.json\$" || true; } > "$WORK/request-keys"
        while read -r key; do
          s3api delete-object --bucket "$BUCKET" --key "$key" > /dev/null < /dev/null
        done < "$WORK/request-keys"
        s3api delete-object --bucket "$BUCKET" --key "$COMPLETED_PREFIX$done_stamp-$id.json" > /dev/null < /dev/null
        log "pruned a completed erasure-list entry from $done_stamp."
      fi
    done < "$WORK/completed"
    ;;
  *)
    die "usage: erasure-list.sh append|complete <uuid> [stamp] | list | prune <stamp>"
    ;;
esac
