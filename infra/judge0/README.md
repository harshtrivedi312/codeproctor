# Judge0 CE (BE-05)

Self-hosted code runner for FR-503. The API talks to it through `Judge0Client`
(`apps/api/src/judge0`). Nothing here is started by CI.

Status: NOT VALIDATED on macOS or Apple Silicon. Judge0's sandbox (isolate) needs Linux x86_64,
privileged containers and cgroup v1 (Judge0 1.13.x). Real integration is gated on ARC-05
confirming the host (R-01). Until then, unit tests use `FakeJudge0Client`.

## Run (Linux x86 host only)

```sh
export JUDGE0_AUTH_TOKEN=...   # same value the API uses
export JUDGE0_AUTHZ_TOKEN=...  # X-Auth-User, needed to delete submissions
export JUDGE0_DB_PASSWORD=...
export JUDGE0_REDIS_PASSWORD=...
docker compose -f infra/judge0/docker-compose.judge0.yml up -d
curl -H "X-Auth-Token: $JUDGE0_AUTH_TOKEN" http://127.0.0.1:2358/languages | head
```

Check that language ids 100 (Python), 102 (JavaScript) and 91 (Java) exist in `/languages`; the table
is `apps/api/src/judge0/language-map.ts`.

## Data retention

Judge0 stores source code, stdin and expected output per submission. `ENABLE_SUBMISSION_DELETE=true`
is set (behind `X-Auth-Token` plus `X-Auth-User`, the AUTHZ token Judge0 requires for DELETE) and `HttpJudge0Client` DELETEs every submission token after its
results are read, and on timeout or failure. Deletion is best effort: if it fails a warning is
logged and the row stays, so operations should also purge old rows from Judge0's Postgres on a
schedule (follow-up FU-BEB-08). Callbacks are disabled and Judge0's Redis needs a password.

## Scope note

This step delivers the execution service and reference validation only. FR-203 publish gating
(storing `validation_report` and refusing to publish without a passing one) is NOT done yet: it
needs BE-04 to implement `ValidationReportSink` (FU-BEB-01).

## Isolation

- `judge0_internal` is an internal Docker network: workers (where candidate code runs), Judge0's own
  Postgres and Redis have no route out. The server also joins `judge0_edge` only to publish
  `127.0.0.1:2358`.
- Verify no egress from a worker: `docker compose exec judge0-worker curl -m 3 https://1.1.1.1`
  must fail. TC-042 checks the same from inside a submission.
- Production hosts must also block egress from the host firewall or security group for this network.

## Integration tests (TC-042, TC-043, TC-044)

```sh
JUDGE0_URL=http://127.0.0.1:2358 JUDGE0_AUTH_TOKEN=... JUDGE0_INTEGRATION=true \
  pnpm --filter @codeproctor/api test judge0.integration
```

Skipped unless both `JUDGE0_URL` and `JUDGE0_INTEGRATION=true` are set.
