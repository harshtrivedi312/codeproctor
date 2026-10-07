# Face-match worker: local run (demo)

Entrypoint: `worker.app:app` (FastAPI, HTTP only; the API calls it, the worker reads no Redis).
Face routes are signed (ADR 0014); `GET /health` is open.

## On the host (no Docker)

```sh
WORKER_OBJECT_STORE_BUCKET=<media bucket> apps/worker/tools/be08/run-local.sh
```

Needs Python 3.12. It writes `WORKER_BASE_URL`, `WORKER_HMAC_KEY_ID` and `WORKER_HMAC_KEY` to
`~/.cache/codeproctor/worker-local.env`; copy those three lines into `.env` for the API. Set
`WORKER_OBJECT_STORE_ORIGINS` to exactly the scheme, host and port of the API's `S3_ENDPOINT`
(default `http://localhost:9000`): the worker refuses any other host (ADR 0014 fetch guard).

## In compose

Image: `apps/worker/Dockerfile` (python:3.12-slim, linux/amd64 only because the pinned
`mediapipe==0.10.21` has no Linux arm64 wheel; on Apple silicon it runs emulated and is slower).
Port 8000. Environment:

| Variable | Value |
|---|---|
| `WORKER_ENV` | `local` for the demo (lenient); staging, pilot and production are strict |
| `WORKER_HMAC_KEYS` | `<kid>:<base64 of at least 32 random bytes>`; the API gets the same kid and key as `WORKER_HMAC_KEY_ID` and `WORKER_HMAC_KEY` |
| `WORKER_OBJECT_STORE_ORIGINS` | the origin in the API's presigned URLs (the guard compares host and port exactly) |
| `WORKER_OBJECT_STORE_BUCKET` | the media bucket |
| `WORKER_MODELS_DIR` | `/models` (default in the image); empty means "not ready", and the API then resolves MANUAL_REVIEW |

No S3 credentials: the worker only does GETs on presigned URLs. Do not set
`WORKER_FACE_CACHE_ENABLED`.

## Models (pinned, C-10; never in the image, never downloaded by the build)

Mount read-only at `/models`, checked against `apps/worker/models.lock.json` at startup (wrong
name or digest: the worker refuses to start in strict modes):

- `auraface-v1/glintr100.onnx`, SHA-256 `a7933ea5...ee25c60`, 260,694,151 bytes
- `mediapipe/face_landmarker.task`, SHA-256 `64184e22...c9ff`, 3,758,596 bytes (not yet downloaded:
  the owner must approve it, P-13)

Until both files exist, leave the models directory unset. The identity step then answers
MANUAL_REVIEW and the candidate carries on, so the rest of the demo is unaffected.
