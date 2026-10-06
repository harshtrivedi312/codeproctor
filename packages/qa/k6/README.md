# Load tests (k6): TC-090 and TC-091

Owner: QA B (ops). Covers NFR-01, NFR-02, FR-609, FR-701, FR-608, FR-801 and the request volume estimate R-02 in docs/status.md.

| Script               | TC     | Pri | What it does                                        | Pass criteria (docs/test-cases.md) |
| -------------------- | ------ | --- | --------------------------------------------------- | ---------------------------------- |
| `tc-090-load.js`     | TC-090 | P1  | 200 simulated candidates at the real client cadence | API p95 under 300 ms, no errors    |
| `tc-091-code-run.js` | TC-091 | P2  | 50 concurrent code runs                             | run p95 under 5 s                  |

Nothing here runs until DEP-01 (staging) exists. Staging only, synthetic data only. Never point it at pilot or production.

The routes, limits and 412 handling follow **Proposed** ADR 0013 (not yet accepted). Re-check the scripts against the code when BE-09 and BE-10 merge.

## Offered load per candidate (R-02, ADR 0013 section 5)

| Activity                                      | Cadence                                 | Route                                                                                                     | Signed                                         |
| --------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Heartbeat                                     | every 10 s                              | `POST /candidate/session/heartbeat`                                                                       | no                                             |
| Event batch (2 events)                        | every 5 s                               | `POST /candidate/session/events`                                                                          | `X-Signature`, HMAC-SHA256 over the exact body |
| Keystroke batch (10 edits)                    | every 2 s                               | `POST /candidate/session/keystrokes`                                                                      | same                                           |
| Media chunk, per stream SCREEN, WEBCAM, AUDIO | every 10 s per stream                   | `POST /candidate/session/media/presign`, `PUT` to object storage, `POST /candidate/session/media/confirm` | no                                             |
| Code run                                      | once a minute (`RUN_EVERY_MS`; 0 = off) | `POST /candidate/answers/:questionId/run`                                                                 | no                                             |

That is about 1.4 API requests per second per candidate: 0.1 heartbeat, 0.2 events, 0.5 keystrokes, 0.6 presign and confirm, plus the storage PUTs (0.3 per second, not API calls). At 200 candidates this is roughly 280 API requests per second, which matches R-02's estimate of 250 to 300. It stays under the per-session limits in ADR 0013 (events 120 per minute, keystrokes 240, heartbeat 12, presign and confirm 60 per stream), so any 429 is a finding, not a script artefact.

### Traffic this test does not send

The scripts model the cadence in R-02 and nothing else. The BE-15B report must not claim more coverage than this:

- draft autosave (about 0.1 per second per candidate in the SDK),
- the identity re-check every 120 s and its evidence presign,
- `system-check`, `finish`, token renewal through the heartbeat, and any proctor, admin or reviewer traffic,
- real media: chunks are zero bytes, so no thumbnail, transcode or ingest work is exercised.

Add up the missing routes before reading the 300 ms result as a statement about the whole candidate surface. Keystroke batches carry fresh `EDIT` events at increasing offsets from an empty document: they are valid input but are not a replayable editing history (no initial `RESET`), so a replay or reconstruction check on this data is meaningless.

The test event is RIGHT_CLICK (LOW severity, empty payload), so a run does not pause sessions or raise risk bands. Event and chunk contents are synthetic: media chunks are zero bytes of the declared size, not playable WebM.

## Thresholds (all in the scripts)

| Threshold                                                                                                                                                      | Source                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `api_duration` p95 under 300 ms (every API call except code runs and storage PUTs), and the same per endpoint: heartbeat, events, keystrokes, presign, confirm | TC-090, NFR-01                                                                                                 |
| `http_req_duration{endpoint:run}` p95 under 5000 ms                                                                                                            | TC-091, NFR-01                                                                                                 |
| `http_req_failed{kind:api}` rate equal to 0 (a 429 counts as an error)                                                                                         | TC-090 "no errors"                                                                                             |
| `http_req_failed{kind:storage}` under 0.1 percent                                                                                                              | storage PUTs are not the API; a few object-store failures are tolerated and reported                           |
| `cp_failures` count 0, `cp_setup_failures` count 0, `checks` rate 1 (API checks only)                                                                          | no errors, every session got its key                                                                           |
| `cp_duplicate_batches` count 0                                                                                                                                 | a `duplicate:true` answer on a fresh session is a finding; the script still advances `seq`                     |
| `cp_storage_failures` about 0.1 percent of expected PUTs                                                                                                       | storage failures are judged only here and in `http_req_failed{kind:storage}`, not in `cp_failures` or `checks` |
| `cp_late_slots` rate under 1 percent                                                                                                                           | proof of offered load: a slot more than half an interval late is skipped ahead and counted                     |
| `http_reqs{kind:api}` rate at least 90 percent of the expected average (1.4 x VUS, ramps weighted at half)                                                     | proof of offered load: a slow generator or API cannot pass on a lighter load                                   |

Storage PUTs treat 2xx and 412 as expected (`responseCallback`), so an "already stored" answer is not a failed request.

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
k6 run -e API_BASE_URL=https://<staging-host>/api/v1 -e ALLOWED_HOSTS=<staging-host> \
       -e SESSIONS_FILE=/absolute/path/to/sessions.json \
       packages/qa/k6/tc-090-load.js

# Docker (the image CI pins by digest in .github/workflows/qa.yml)
docker run --rm -v "$PWD/packages/qa/k6:/k6" -v /absolute/path/to:/seed:ro -w /k6 \
  grafana/k6@sha256:e66db15b860113878fa74670e31f5e274830b7b6e42c8bff28b2f2d86a257603 \
  run -e API_BASE_URL=https://<staging-host>/api/v1 -e ALLOWED_HOSTS=<staging-host> -e SESSIONS_FILE=/seed/sessions.json tc-090-load.js
```

Use `SESSIONS_JSON` instead of `SESSIONS_FILE` when the list comes from a CI secret. Never put either value on the command line in a shared shell (history); export it as an environment variable.

| Variable                                 | Default                                   | Meaning                                                                                                                                                                                           |
| ---------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `API_BASE_URL`                           | `http://localhost:4000/api/v1`            | API base including `/api/v1`                                                                                                                                                                      |
| `SESSIONS_FILE`, `SESSIONS_JSON`         | none                                      | the seeded sessions (above); `SESSIONS_FILE` must be an absolute path (k6 resolves relative paths against `lib/`)                                                                                 |
| `VUS`                                    | 200 (TC-090), 50 (TC-091)                 | candidates                                                                                                                                                                                        |
| `RAMP_UP`, `HOLD`, `RAMP_DOWN`           | 2m, 10m, 1m                               | TC-090 stages                                                                                                                                                                                     |
| `ROUNDS`                                 | 6                                         | TC-091 runs per user                                                                                                                                                                              |
| `RUN_EVERY_MS`                           | 60000                                     | TC-090 run cadence; 0 turns runs off                                                                                                                                                              |
| `RUN_CODE`                               | `print(1)` (TC-090), a stdin sum (TC-091) | candidate code                                                                                                                                                                                    |
| `CHUNK_BYTES_VIDEO`, `CHUNK_BYTES_AUDIO` | 262144, 65536                             | size of the synthetic chunks                                                                                                                                                                      |
| `ALLOWED_HOSTS`                          | none (required)                           | comma separated exact host names (no scheme or port) the run may target; `localhost`, `127.0.0.1`, `host.docker.internal` are always allowed. Any other host is refused, at init and in `setup()` |

A host name containing `prod`, `production` or `pilot` is refused even when it is in `ALLOWED_HOSTS`; there is no override. The deny-list matches substrings, so a host such as `product-staging.example.com` is refused too.

`API_BASE_URL` itself must match `^https?://([a-z0-9.-]+)(:port)?(/[A-Za-z0-9._~/-]*)?$` as a whole, and the host is taken from that match. Anything else is refused: userinfo (`@`), `?`, `#`, `\`, `%` escapes, whitespace, `[` (IPv6), a trailing or leading dot. This is deliberate: k6 (Go `net/url`) and a hand-written parser can read tricks such as `https://api.prod.example.com?@staging.example.com` differently, so those forms never reach k6. The logic is in `lib/guard.js` (pure, no k6 imports) and is tested with a table of good and bad inputs:

```sh
node --test packages/qa/k6/lib/guard.test.mjs
```

`STORAGE_ALLOWED_HOSTS` (optional, comma separated exact host names) additionally restricts where chunk PUTs may go: a presign answer pointing elsewhere is not followed (counted in `cp_storage_failures`, the URL is not logged). Storage PUTs never follow redirects.

## Logs and outputs: presigned URLs

A presigned storage URL is a bearer capability for its lifetime (about 60 s). Three places could carry it, and each is handled:

- **Metrics.** Both scripts set `systemTags` (in `lib/config.js`) without `url`, so no `http_req_*` sample, summary, `--out` file or cloud output has a URL tag. Do not add `url` back.
- **k6 stderr.** On a transport error k6 prints the whole URL, for example `WARN Request Failed error="Put \"https://<host>/<media object key>?X-Amz-Signature=...\"..."`. The path holds the media object key, so redact whole URLs, not only the query: either keep the k6 log out of artefacts, or pipe it through `sed -E 's#https?://[^" ]*#<url-redacted>#g'` before it is stored or shown (a pattern that matches only `?...` would leave the key in the path).
- **Forbidden flags.** Never use `--http-debug` (it dumps request lines and headers, including bearer tokens and signatures). Never use `--out json`, `--out csv` or `--out cloud` with the `url` tag enabled; with the default `systemTags` of these scripts they are safe, but do not override `--system-tags` on the command line. `--summary-export` is safe.

Do a smoke run first, for example `-e VUS=5 -e RAMP_UP=10s -e HOLD=1m -e RAMP_DOWN=5s`, and clean up the data it left.

## Staging limits to check before a full run

Cloudflare R2 free tier (check the current limits before the run): about 10 GB stored and 1 million class A operations (PUT) a month. Chunks are zero bytes, which may break BE-12 media ingest (it may probe, transcode or thumbnail the object); if the object-store clean-up or the ingest worker runs on these objects, expect errors there and note it in the clean-up. A full 200-candidate run is about 3,600 PUTs a minute, about 45,000 over the 13 minutes, and with the default chunk sizes about 8 GB of objects. Lower `CHUNK_BYTES_VIDEO` (for example 65536, about 2 GB) for the first runs, and delete the run's objects afterwards through the admin deletion flow (TC-094). Also note the load generator's upload bandwidth (the default sizes are about 100 Mbit/s at 200 candidates) and that a GitHub-hosted runner is a different network path from a candidate's.

## Checking the scripts without staging

`mock/server.mjs` is a small stand-in for the candidate API, only for checking that the scripts send the right routes, valid canonical-JSON signatures and a cadence under the ADR 0013 limits. It is not the product and says nothing about its performance.

```sh
node packages/qa/k6/mock/server.mjs 4010 60          # writes mock/sessions.json (git-ignored)
docker run --rm -v "$PWD/packages/qa/k6:/k6" -w /k6 \
  grafana/k6@sha256:e66db15b860113878fa74670e31f5e274830b7b6e42c8bff28b2f2d86a257603 \
  run -e API_BASE_URL=http://host.docker.internal:4010/api/v1 -e SESSIONS_FILE=/k6/mock/sessions.json \
      -e VUS=60 -e RAMP_UP=10s -e HOLD=60s -e RAMP_DOWN=5s tc-090-load.js
```

Code runs run inline in the candidate's tick (the VU is blocked while Judge0 answers, up to 5 s at p95). A slot of that candidate that a run delayed is excused: it is not counted in `cp_late_slots` and not skipped, it fires as soon as the run returns, as a browser timer would. Check with a slow run: start the mock with `MOCK_RUN_MS=3000` and run with `-e RUN_EVERY_MS=20000`; `cp_late_slots` stays under 1 percent. `VUS` must be at least 1 and `RAMP_UP + HOLD + RAMP_DOWN` longer than zero (TC-090), `VUS` and `ROUNDS` at least 1 (TC-091); a run that sent no API request fails (`http_reqs` count threshold).

Result of the last check (2026-10-05, k6 from the pinned image, 60 candidates against the mock): all thresholds passed, zero 429s, about 1.43 API requests per second per candidate-second (5,819 API requests over an average of 54 active candidates across the 75 s run, 77 per second), slightly above the 1.4 estimate because it includes one proctor-key call per user and runs every 60 s (0.017 per second). TC-090 now fails if the achieved rate falls under 90 percent of the expected average. The mock binds to 127.0.0.1 by default (`MOCK_HOST` overrides); `host.docker.internal` reached it from Docker Desktop on macOS in this check. On Linux Docker, set `MOCK_HOST=0.0.0.0` only on a trusted network, or run k6 with `--network host`. `k6 inspect` accepts both scripts.

## CI (hub changes, not made here)

This folder does not edit `.github/**`. The exact workflow diff was sent to the architecture hub. In short: the job `k6` in `.github/workflows/qa.yml` runs `packages/qa/k6/<script>` through `run - < file` on stdin, which cannot import `lib/*.js`, and passes `CANDIDATE_TOKENS`. To use these scripts the workflow needs:

1. Mount the folder instead of stdin, and pass the secret by name so it never appears in argv or `ps`:
   `docker run --rm -e SESSIONS_JSON -v "$PWD/packages/qa/k6:/k6" -w /k6 ... run -e API_BASE_URL="$TARGET/api/v1" -e ALLOWED_HOSTS="$TARGET_HOST" tc-090-load.js`, with `SESSIONS_JSON: ${{ secrets.K6_SESSIONS_JSON }}` in the step `env:`. `-e SESSIONS_JSON` with no value makes Docker copy it from the step environment; k6 reads it from its own environment (do not give it as `k6 run -e SESSIONS_JSON=...`).
2. `K6_SESSIONS_JSON` (the JSON list above) replaces the secret `K6_CANDIDATE_TOKENS` in the `staging` environment.
3. Keep the `QA_STAGING_HOSTS` allow-list step; derive `API_BASE_URL` and `ALLOWED_HOSTS` from the already-validated target.
4. Upload the k6 summary (`--summary-export`) as an artefact so the result report for BE-15B and the matrix has numbers. Do not upload the raw k6 log unless it went through `sed -E 's#https?://[^" ]*#<url-redacted>#g'` (section "Logs and outputs").
