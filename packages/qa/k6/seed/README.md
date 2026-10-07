# Session seeder for the k6 load tests (TC-090, TC-091)

Owner: QA B (ops). Creates fresh synthetic candidates, invitations and candidate sessions on **staging** through the public API, brings each one to IN_PROGRESS, and writes the sessions list that `tc-090-load.js` and `tc-091-code-run.js` read (`SESSIONS_FILE`, format in `../README.md`).

**Status (2026-10-07): the candidate path uses the real routes of BE-07 (#98): link, otp, start, consent, consent/sign, test/start.** The system check, room scan (presign and confirm) and identity routes (ADR 0013 5.4, 5.5) are not on `main`, so a full seed stops there with a named "not available on main yet" error; `--stop-at CONSENTED` works today. The staff invitation body and the erasure route are still ASSUMED (marked in `lib/routes.mjs`). The tests run against `mock/mock-api.mjs`, which mirrors the candidate DTOs by reading `apps/api`; a green run proves the seeder matches the code it was written from, not a running API. Re-check when the missing routes land and edit only `lib/routes.mjs` and the `AVAILABLE` flags.

## What it does

Per candidate (all through the API, nothing in the database):

| Step                                                                                                                                    | State after                               | Source                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------ |
| `POST /tests/:id/invitations` with a synthetic name, a `@example.test` email and the identity waiver                                    | INVITED                                   | FSD section 4; waiver: C-19, C-25, ADR 0015 (Proposed) |
| Read the link token from the mail sink, `POST /candidate/session/otp`, read the OTP from the mail sink, `POST /candidate/session/start` | OPENED                                    | FR-106, FR-303, ADR 0003                               |
| `GET /candidate/session/consent`, `POST /candidate/session/consent/sign` with the typed synthetic name and the 18+ confirmation         | CONSENTED                                 | FR-401, C-07, C-30; a fresh signature per session      |
| `POST /candidate/session/system-check` with a clean synthetic report                                                                    | CONSENTED                                 | ADR 0013 5.4                                           |
| Identity: nothing to do, waived by the invitation. No ID image, no selfie, no face anywhere                                             | (waived)                                  | C-25, ADR 0015                                         |
| Room scan: presign, `PUT` of one tiny labeled placeholder chunk (not a video), confirm                                                  | `verify-session` job moves it to VERIFIED | FR-404, ADR 0013 5.5 and the CONSENTED to VERIFIED job |
| Start test, polled while it answers 409 (VERIFIED not yet reached)                                                                      | IN_PROGRESS                               | ADR 0013 ("the start-test call")                       |

It then **does not call `POST /candidate/session/proctor-key`**. That route answers 409 `KEY_ALREADY_ISSUED` the second time for an epoch (ADR 0013 section 4), so the k6 script must make the one call. The sessions file therefore has no `keyB64`.

Output entry per session (extra keys are ignored by k6):

```json
{
  "token": "...",
  "sessionQuestionId": "<uuid>",
  "questionId": "<uuid>",
  "seedRunId": "k6seed-...",
  "tokenExpiresAt": "<iso, if the API returns it>"
}
```

The candidate token is short lived and the k6 scripts do not follow renewal through the heartbeat. Seed shortly before the run (200 candidates take roughly 5 to 10 minutes at the default 5 requests per second) and check `tokenExpiresAt`.

## Usage

```sh
export API_BASE_URL=https://<staging-host>/api/v1
export ALLOWED_HOSTS=<staging-host>
export STORAGE_ALLOWED_HOSTS=<bucket-host>           # for the room-scan PUT
export SEED_ORG_NAME='SYNTHETIC QA Org'              # the staff account's organisation
export SEED_TEST_ID=<uuid of a test with a Python coding question, in that org>
export SEED_MAIL_URL=https://<mail-sink-host>        # Mailpit-compatible API, staging only
export SEED_STAFF_EMAIL=...  SEED_STAFF_PASSWORD=...  # read from your secret store, not typed in a shared shell
export SEED_STAFF_TOTP_SECRET=...                     # only if the staff account has 2FA

node packages/qa/k6/seed/seed.mjs --dry-run --count 200 --out /absolute/path/outside/repo/sessions.json
node packages/qa/k6/seed/seed.mjs            --count 200 --out /absolute/path/outside/repo/sessions.json
# ... run k6 with SESSIONS_FILE=/absolute/path/outside/repo/sessions.json ...
node packages/qa/k6/seed/seed.mjs --cleanup --run-id k6seed-<14 digits>-<6 hex> --manifest /absolute/path/outside/repo/sessions.json.manifest.json
```

Switches (argv carries nothing secret; any other argument is refused without echoing it):

| Switch                                    | Meaning                                                                                                                                                                                                                                       |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--count N` / `SEED_COUNT`                | Candidates, 1 to 1000, default 200 (TC-090); use 50 for TC-091                                                                                                                                                                                |
| `--out FILE` / `SEED_OUT`                 | Sessions file, absolute path, written with mode 0600 (temp file, then rename). Refused if it exists unless `--force`                                                                                                                          |
| `--stop-at STATE`                         | End each candidate after OPENED, CONSENTED or IN_PROGRESS (default). `CONSENTED` is for TC-105: the capacity script starts the later steps itself. The sessions file then holds `token`, `state`, `tokenExpiresAt` and no `sessionQuestionId` |
| `--identity`                              | Run the identity step with generated synthetic assets. Fails with a named "not available on main yet" error until that route exists; cannot be combined with `--stop-at`                                                                      |
| `--dry-run`                               | Validates the configuration (including the host guard) and prints the plan. No request is sent, nothing is written. Exit 2 if configuration is missing                                                                                        |
| `--allow-partial`                         | If some candidates fail, still write the ones that worked (exit stays 1). Default: write nothing and tell you to clean up                                                                                                                     |
| `--cleanup --run-id ID [--manifest FILE]` | Erase what that run created (below)                                                                                                                                                                                                           |

## Environment

| Variable                                  | Required                                                | Meaning                                                                                                                                                                                                             |
| ----------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `API_BASE_URL`                            | yes                                                     | API base including `/api/v1`. No default. Same strict URL pattern and host guard as the k6 scripts (`../lib/guard.js`, reused)                                                                                      |
| `ALLOWED_HOSTS`                           | yes (except localhost, 127.0.0.1, host.docker.internal) | Exact host names. Any host containing `prod`, `production` or `pilot` is refused, no override. Also applies to `SEED_MAIL_URL`                                                                                      |
| `SEED_STAFF_EMAIL`, `SEED_STAFF_PASSWORD` | yes                                                     | A RECRUITER-or-higher account of the synthetic organisation. `--cleanup` needs the erase permission (SUPER_ADMIN assumed, see below)                                                                                |
| `SEED_STAFF_TOTP_SECRET`                  | if 2FA                                                  | Base32 secret; the seeder computes the 6-digit code itself (RFC 6238). Accounts that still need 2FA enrolment are refused (a human step)                                                                            |
| `SEED_ORG_NAME`                           | yes                                                     | Must contain "synthetic", and the logged-in account's `orgName` must equal it exactly, else the run stops before the first invitation. Organisation creation has no API route, so the org is specified, not created |
| `SEED_TEST_ID`                            | seed                                                    | UUID of the test template to invite to                                                                                                                                                                              |
| `SEED_MAIL_URL`                           | seed                                                    | Base URL of a Mailpit-compatible mail sink (`/api/v1/search`, `/api/v1/message/:id`) that receives the synthetic recipients' mail                                                                                   |
| `SEED_INVITE_LINK_REGEX`                  | no                                                      | Regex with one capture group for the token in the invitation email. Default `/(?:invite\|i\|start)/([A-Za-z0-9_-]{32,})` (ASSUMED)                                                                                  |
| `SEED_EMAIL_DOMAIN`                       | no                                                      | Default `example.test`. Only reserved domains are accepted (`*.test`, `*.invalid`, `*.example`, `example.com/org/net`)                                                                                              |
| `STORAGE_ALLOWED_HOSTS`                   | for the room scan                                       | Exact host names the presigned PUT may go to; `https` only. A presign pointing elsewhere is not followed and the URL is not printed. Local hosts are allowed only when the API itself is local                      |
| `SEED_RPS`                                | no                                                      | Request starts per second across the run, default 5, max 50                                                                                                                                                         |
| `SEED_CONCURRENCY`                        | no                                                      | Candidates in parallel, default 4                                                                                                                                                                                   |
| `SEED_ROOM_SCAN_BYTES`                    | no                                                      | Size of the placeholder chunk, default 256                                                                                                                                                                          |
| `SEED_VERIFY_TIMEOUT_S`                   | no                                                      | How long to poll start-test while the session is not yet VERIFIED, default 60                                                                                                                                       |

## Safety properties (each has a test)

- **Staging only (ADR 0009).** No database access, no database credentials. The staff password and TOTP secret exist only in the environment of the process and are never written, printed or put in an error. Run it from your own shell or a CI job with the secrets mapped to environment variables.
- **Host guard** before any request, in the same code as the k6 scripts. Not allow-listed, prod, production, pilot, userinfo tricks: exit 2, nothing sent.
- **Synthetic only.** Names `K6SEED <run> NNN`, emails `<run id>-NNN@example.test`. No face, no ID. The room-scan chunk is a repeated ASCII label ("CODEPROCTOR-SYNTHETIC-K6SEED-PLACEHOLDER-NOT-A-VIDEO"), not a video.
- **Output hygiene.** Everything printed goes through `lib/redact.mjs` (URLs whole, bearer tokens, JWTs, long opaque strings, six-digit codes, known secret values). Errors state the step, the HTTP status and the problem `code` only, never a body. Redirects are never followed.
- **Files.** The sessions file (bearer tokens) must be outside the repo, or one of the git-ignored patterns under `packages/qa/k6` (`sessions*.json`, `.local/`). Mode 0600. The manifest holds ids only (candidate, invitation and session ids, run id), also 0600, written after every invitation so a crashed run can still be cleaned up.
- **Polite.** One global request-rate limit; 429 and 503 honour `Retry-After` (capped at 30 s) with backoff and jitter; 502/504/network errors are retried only for GET and PUT. Non-repeatable POSTs are never replayed after an unclear failure.

## Cleanup and idempotency (TC-094)

Every run has a run id (`k6seed-<UTC time>-<6 hex>`) in each candidate's email and name. `--cleanup --run-id` reads the manifest for that id, checks it belongs to the same organisation, and asks the admin deletion flow to erase each candidate (`POST /candidates/:id/erasure`, ASSUMED). 404/410 count as already gone and the manifest remembers what was erased, so cleanup can be repeated. The sessions file is deleted once every candidate was erased. Erasure completes within 30 days at most (C-06), asynchronously; none of these sessions is UNDER_REVIEW or APPEALED, so no hold applies.

Cleanup does **not** touch: objects the load run itself put in storage (use the admin deletion flow, see `../README.md`), and messages in the mail sink (they hold link tokens and OTPs for synthetic recipients; delete them in the sink).

## What this needs from BE-07 and BE-09 (unmet or unconfirmed)

1. **A way to read the invitation token and OTP.** They are only emailed. A staging mail sink (Mailpit or similar, reachable from the seeder) is required; none is specified in `infra/`, `.env.example` or the DEP docs. Alternatives need an owner decision: a staging-only test hook that returns the token and OTP (a credential-exposing route, security review needed). Not invented here.
2. **The OTP request route.** REAL on main (#98): `POST /candidate/session/link {invitationToken}` shows the state and sends nothing, `POST /candidate/session/otp {invitationToken}` sends the code (429 `OTP_COOLDOWN` inside 30 s), `POST /candidate/session/start {invitationToken, otp}` returns `sessionToken`.
3. **The start-test route.** REAL on main: `POST /candidate/session/test/start` answers 409 until VERIFIED and returns `sections[].questions[]` with `{ sessionQuestionId, position, points }` and, by design (Backend B), no question content or type; the render projection is not built yet. The seeder writes `sessionQuestionId` per session. BE-11's `/candidate/answers/:id/{run,draft,submit}` take that `sessionQuestionId` (resolved under the token's session), so TC-091 and TC-105 can call run and submit without knowing the type, once #187 is on main. Any 409 except `SYSTEM_CHECK_BLOCKED` and `SESSION_NOT_ACTIVE` is polled.
4. **Invitation request and response bodies** (`candidateName`, `candidateEmail`, `windowStart`, `windowEnd`, `accommodations`; response `id`, `candidateId`, `sessionId`). FSD says "single or bulk" without a shape.
5. **Consent signature body**: REAL (`consentTextId`, `signedName`, `confirmedAge18`), and the start response (`sessionToken`, `sessionTokenExpiresAt`). The staging consent text must be usable: `REQUIRE_LEGAL_APPROVED_CONSENT` is false on staging, otherwise consent GET is refused (FR-401) and seeding stops at that step.
6. **Identity waiver** is ADR 0015, still Proposed (feature flags, `reasonCode: OTHER`). If it is not accepted or built, the seeder cannot reach VERIFIED without real ID and selfie images. A "placeholder images" path is deliberately not built: it needs BE-08's upload route (not pinned) and would send non-face images to the face-match worker.
7. **Admin erasure route** for TC-094: not in FSD section 4. ASSUMED `POST /candidates/:id/erasure`, SUPER_ADMIN.
8. **A synthetic organisation and test.** No route creates an organisation; the Database/Deploy owner must provide a staging org named with "synthetic", a staff account in it, and a test whose question has a Python option and sample tests (the same assumption as `../README.md`).
9. **Token renewal.** The seeder does not renew tokens: the only renewal on main is the heartbeat (`POST /candidate/session/heartbeat` renews the token when half its life is gone, FR-609), which the k6 scripts send. A sessions file older than the token life is refused by the API (401), not silently reused; seed shortly before the run.
10. **Mail for the pilot (SES, C-52).** Only the Mailpit-compatible reader exists. An SES receiving path needs an owner answer on the mailbox and on sandbox versus production SES (qa.md section 23, Q9); no AWS SDK or inbox contract is invented here.
11. **Host guard for `prod`/`pilot`.** Unchanged: the seeder and the k6 scripts refuse those hosts. Whether the pilot names (`api.assess.thebigbraintech.com`) pass is the owner's decision (Q2); until then a pilot run uses a neutral twin name.
12. **Rate limits on the candidate routes before start** (OTP request, start) are not in ADR 0013; the seeder spreads requests at `SEED_RPS`, and a 429 is retried with backoff rather than treated as a finding.

Room-scan note: BE-12 ingest may try to probe or transcode the placeholder chunk and report an error for it; the same caveat as the zero-byte chunks in `../README.md`.

## Tests

```sh
node --test packages/qa/k6/seed/test/seed.test.mjs   # 26 tests, local mock only, no network beyond 127.0.0.1
```

`mock/mock-api.mjs` is the stand-in (staff login with optional TOTP, invitations, a Mailpit-style sink, OTP, consent, system check, room scan with a presigned PUT, start-test with a delay before VERIFIED, proctor-key once-only, erasure, fault injection for 429/503/500). It is not the product.
