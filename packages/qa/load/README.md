# Load tests (k6): TC-090 and TC-091

Owner: QA B (ops). Covers NFR-01, NFR-02, FR-609, FR-701, FR-608, FR-801 and the request volume estimate R-02 in docs/status.md.

| Script               | TC     | Pri | What it does                                        | Pass criteria (docs/test-cases.md) |
| -------------------- | ------ | --- | --------------------------------------------------- | ---------------------------------- |
| `tc-090-load.js`     | TC-090 | P1  | 200 simulated candidates at the real client cadence | API p95 under 300 ms, no errors    |
| `tc-091-code-run.js` | TC-091 | P2  | 50 concurrent code runs                             | run p95 under 5 s                  |

Nothing here runs until DEP-01 (staging) exists. Staging only, synthetic data only. Never point it at pilot or production.

## Offered load per candidate (R-02, ADR 0013 section 5)

| Activity                                      | Cadence                                 | Route                                                                                                     | Signed                                         |
| --------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Heartbeat                                     | every 10 s                              | `POST /candidate/session/heartbeat`                                                                       | no                                             |
| Event batch (2 events)                        | every 5 s                               | `POST /candidate/session/events`                                                                          | `X-Signature`, HMAC-SHA256 over the exact body |
| Keystroke batch (10 edits)                    | every 2 s                               | `POST /candidate/session/keystrokes`                                                                      | same                                           |
| Media chunk, per stream SCREEN, WEBCAM, AUDIO | every 10 s per stream                   | `POST /candidate/session/media/presign`, `PUT` to object storage, `POST /candidate/session/media/confirm` | no                                             |
| Code run                                      | once a minute (`RUN_EVERY_MS`; 0 = off) | `POST /candidate/answers/:questionId/run`                                                                 | no                                             |

That is about 1.4 API requests per second per candidate: 0.1 heartbeat, 0.2 events, 0.5 keystrokes, 0.6 presign and confirm, plus the storage PUTs (0.3 per second, not API calls). At 200 candidates this is roughly 280 API requests per second, which matches R-02's estimate of 250 to 300. It stays under the per-session limits in ADR 0013 (events 120 per minute, keystrokes 240, heartbeat 12, presign and confirm 60 per stream), so any 429 is a finding, not a script artefact.

The test event is RIGHT_CLICK (LOW severity, empty payload), so a run does not pause sessions or raise risk bands. Event and chunk contents are synthetic: media chunks are zero bytes of the declared size, not playable WebM.

## Thresholds (all in the scripts)

| Threshold                                                                                                                                                      | Source                                                                               |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `api_duration` p95 under 300 ms (every API call except code runs and storage PUTs), and the same per endpoint: heartbeat, events, keystrokes, presign, confirm | TC-090, NFR-01                                                                       |
| `http_req_duration{endpoint:run}` p95 under 5000 ms                                                                                                            | TC-091, NFR-01                                                                       |
| `http_req_failed{kind:api}` rate equal to 0 (a 429 counts as an error)                                                                                         | TC-090 "no errors"                                                                   |
| `http_req_failed{kind:storage}` under 0.1 percent                                                                                                              | storage PUTs are not the API; a few object-store failures are tolerated and reported |
| `cp_failures` count 0, `cp_setup_failures` count 0, `checks` rate 1                                                                                            | no errors, every session got its key                                                 |

ADR 0013 section 5.3 also sets a design target of heartbeat p95 under 50 ms. It is not a TC criterion, so it is not a threshold; read it in the per-endpoint results of the summary.

A failed threshold makes k6 exit non-zero, so the CI job fails.

## Seeding the sessions

Each virtual user needs its own IN_PROGRESS candidate session on staging with synthetic data (200 for TC-090, 50 for TC-091; FR-502 allows one run per 5 s per candidate, so runs cannot share a session). Seeding is done with the staging admin tools or API by whoever owns DEP-01 (there is no seeding script yet); the result is a JSON file:

```json
[
  {
    "token": "<candidate bearer token>",
    "sessionQuestionId": "<uuid>",
    "questionId": "<uuid>",
    "keyB64": "<optional, 32-byte batch key, base64>",
    "counters": {}
  }
]
```

- `token`: the candidate access token for that session. It lives for the session token lifetime; renewal through the heartbeat is not followed (a long run needs a token that outlives it).
- `sessionQuestionId`: used in keystroke batches. `questionId`: used in the run route.
- `keyB64` and `counters` are optional. Without them the script calls `POST /candidate/session/proctor-key` once per user. That route answers 409 `KEY_ALREADY_ISSUED` for the same epoch the second time, so **seed fresh sessions for every run** (or store the key and counters yourself).
- The file holds bearer tokens and keys. Keep it outside the repository (the folder's `.gitignore` excludes `sessions*.json`, `.local/` and `results/` as a second guard), never paste it into an issue or chat, and delete it after the run. In CI it comes from a secret, never from a file in git.

Seeding assumptions to confirm with the backend when BE-09 and BE-10 merge: the question has a Python language option, and sample tests exist for the run route.

## Running

Requirements: k6 (or the pinned Docker image), network access to the staging API and its object store.

```sh
# Local binary
k6 run -e API_BASE_URL=https://<staging-host>/api/v1 \
       -e SESSIONS_FILE=/absolute/path/to/sessions.json \
       packages/qa/load/tc-090-load.js

# Docker (the image CI pins by digest in .github/workflows/qa.yml)
docker run --rm -v "$PWD/packages/qa/load:/load" -v /absolute/path/to:/seed:ro -w /load \
  grafana/k6@sha256:e66db15b860113878fa74670e31f5e274830b7b6e42c8bff28b2f2d86a257603 \
  run -e API_BASE_URL=https://<staging-host>/api/v1 -e SESSIONS_FILE=/seed/sessions.json tc-090-load.js
```

Use `SESSIONS_JSON` instead of `SESSIONS_FILE` when the list comes from a CI secret. Never put either value on the command line in a shared shell (history); export it as an environment variable.

| Variable                                 | Default                                   | Meaning                                                |
| ---------------------------------------- | ----------------------------------------- | ------------------------------------------------------ |
| `API_BASE_URL`                           | `http://localhost:4000/api/v1`            | API base including `/api/v1`                           |
| `SESSIONS_FILE`, `SESSIONS_JSON`         | none                                      | the seeded sessions (above)                            |
| `VUS`                                    | 200 (TC-090), 50 (TC-091)                 | candidates                                             |
| `RAMP_UP`, `HOLD`, `RAMP_DOWN`           | 2m, 10m, 1m                               | TC-090 stages                                          |
| `ROUNDS`                                 | 6                                         | TC-091 runs per user                                   |
| `RUN_EVERY_MS`                           | 60000                                     | TC-090 run cadence; 0 turns runs off                   |
| `RUN_CODE`                               | `print(1)` (TC-090), a stdin sum (TC-091) | candidate code                                         |
| `CHUNK_BYTES_VIDEO`, `CHUNK_BYTES_AUDIO` | 262144, 65536                             | size of the synthetic chunks                           |
| `FORBIDDEN_HOST_SUBSTRINGS`              | `prod,production,pilot`                   | the script refuses a host name containing one of these |
| `I_KNOW_THIS_IS_NOT_PRODUCTION`          | unset                                     | `yes` overrides the host-name guard                    |

Do a smoke run first, for example `-e VUS=5 -e RAMP_UP=10s -e HOLD=1m -e RAMP_DOWN=5s`, and clean up the data it left.

## Staging limits to check before a full run

Cloudflare R2 free tier (check the current limits before the run): about 10 GB stored and 1 million class A operations (PUT) a month. A full 200-candidate run is about 3,600 PUTs a minute, about 45,000 over the 13 minutes, and with the default chunk sizes about 8 GB of objects. Lower `CHUNK_BYTES_VIDEO` (for example 65536, about 2 GB) for the first runs, and delete the run's objects afterwards through the admin deletion flow (TC-094). Also note the load generator's upload bandwidth (the default sizes are about 100 Mbit/s at 200 candidates) and that a GitHub-hosted runner is a different network path from a candidate's.

## Checking the scripts without staging

`mock/server.mjs` is a small stand-in for the candidate API, only for checking that the scripts send the right routes, valid canonical-JSON signatures and a cadence under the ADR 0013 limits. It is not the product and says nothing about its performance.

```sh
node packages/qa/load/mock/server.mjs 4010 60          # writes mock/sessions.json (git-ignored)
docker run --rm -v "$PWD/packages/qa/load:/load" -w /load \
  grafana/k6@sha256:e66db15b860113878fa74670e31f5e274830b7b6e42c8bff28b2f2d86a257603 \
  run -e API_BASE_URL=http://host.docker.internal:4010/api/v1 -e SESSIONS_FILE=/load/mock/sessions.json \
      -e VUS=60 -e RAMP_UP=10s -e HOLD=60s -e RAMP_DOWN=5s tc-090-load.js
```

Result of the last check (2026-10-05, k6 from the pinned image, 60 candidates against the mock): all thresholds passed, zero 429s, about 1.5 API requests per second per candidate. `k6 inspect` accepts both scripts.

## CI (hub changes, not made here)

The job `k6` in `.github/workflows/qa.yml` runs `packages/qa/k6/<script>` through `run - < file` on stdin, which cannot import `lib/*.js`, and passes `CANDIDATE_TOKENS`. To use these scripts the workflow needs:

1. Mount the folder instead of stdin: `docker run --rm -v "$PWD/packages/qa/load:/load" -w /load ... run -e API_BASE_URL="$TARGET/api/v1" -e SESSIONS_JSON="$K6_SESSIONS_JSON" tc-090-load.js` (script from `inputs.scan`).
2. Replace the secret `K6_CANDIDATE_TOKENS` with `K6_SESSIONS_JSON` (the JSON list above) in the `staging` environment.
3. Keep the `QA_STAGING_HOSTS` allow-list step; add `-e` for `API_BASE_URL` from the already-validated target.
4. Upload the k6 summary (`--summary-export`) as an artefact so the result report for BE-15B and the matrix has numbers.
5. Remove `packages/qa/k6/` (placeholder paths) once the workflow is changed.
