#!/usr/bin/env bash
# Run the face-match worker on the host for the local demo (no Docker). From the repo root:
#   apps/worker/tools/be08/run-local.sh
# Needs Python 3.12. Writes the three API settings to ~/.cache/codeproctor/worker-local.env. Reads no credentials.
set -euo pipefail
cd "$(dirname "$0")/../.."

KID="${WORKER_HMAC_KEY_ID:-local1}"
KEY="${WORKER_HMAC_KEY:-$(openssl rand -base64 32)}"
MODELS="${WORKER_MODELS_DIR:-$HOME/.cache/codeproctor/models}"
PORT="${WORKER_PORT:-8000}"

[ -d .venv ] || python3.12 -m venv .venv
.venv/bin/pip install -q -e '.[face]' uvicorn

export WORKER_ENV=local
export WORKER_HMAC_KEYS="$KID:$KEY"
# Must equal the scheme, host and port of the presigned URLs the API signs (its S3_ENDPOINT).
export WORKER_OBJECT_STORE_ORIGINS="${WORKER_OBJECT_STORE_ORIGINS:-http://localhost:9000}"
export WORKER_OBJECT_STORE_BUCKET="${WORKER_OBJECT_STORE_BUCKET:?set WORKER_OBJECT_STORE_BUCKET to the media bucket}"
# Both pinned files must be in the models directory, or leave the directory unset: the worker
# then reports not ready and the API resolves MANUAL_REVIEW (the candidate still continues).
if [ -f "$MODELS/auraface-v1/glintr100.onnx" ] && [ -f "$MODELS/mediapipe/face_landmarker.task" ]; then
  export WORKER_MODELS_DIR="$MODELS"
else
  echo "Models incomplete in $MODELS: starting without them (identity checks go to MANUAL_REVIEW)." >&2
fi

# The key goes to a private file, never to the terminal or a log.
OUT="$HOME/.cache/codeproctor/worker-local.env"
mkdir -p "$(dirname "$OUT")"
(umask 077; printf 'WORKER_BASE_URL=http://localhost:%s\nWORKER_HMAC_KEY_ID=%s\nWORKER_HMAC_KEY=%s\n' "$PORT" "$KID" "$KEY" > "$OUT")
echo "API settings written to $OUT: copy the three lines into .env." >&2
exec .venv/bin/uvicorn worker.app:app --host 127.0.0.1 --port "$PORT"
