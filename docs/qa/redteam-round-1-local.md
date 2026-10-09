# Red-team round 1, local dry run

Owner: qa-engineer (QA B). Run 2026-10-09. Plan: docs/qa/redteam-plan.md (section 4). Approval: Delivery Lead, D-80 follow-up.

## 1. Environment

| Item | Value |
| --- | --- |
| Build under test | `main` at `d2bcd707` (the running stack was started by the owner; its exact build was not inspected, so a stack older than this commit is possible) |
| Target | the owner's LOCAL demo stack: API `http://localhost:4000/api/v1`, web `http://localhost:3000`, Mailpit `:8025`. NOT staging, not pilot |
| Purpose | a dry run to validate the method and the helper `packages/qa/redteam/round1-local.mjs` (it refuses any non-local base URL). It is not the QA-02 round and its results do not go into docs/red-team-report.md |
| Data | synthetic demo seed only (Demo Corp, one organisation). Nothing created, nothing changed: every call was a read, a rejected write or an unknown id |
| Not done | no start, stop or reset of the stack; no database access (no psql, no Adminer, no seed script); no candidate token existed |
| Secrets | none recorded. The helper prints route, status and problem `code` only |
| Rate limits | 48 attempts in one run; no 429 seen; no limit probed more than 10 times |

Every answer carried no `code`. The API answers with problem+json (`type`, `title`, `status`, `detail`, `traceId`); role denials and the generic 401 and 404 have no `code` by design (plan RT-63, link 404). The column "answer" therefore shows the status and "no code".

## 2. Outcomes

Scale: Blocked (server refused), Detected, Undetected, Not testable (route absent), Blocked-by-env (needs something this run did not have).

Counts: Blocked 11 rows (48 attempts), Detected 0, Undetected 0, Not testable 5 rows, Blocked-by-env 12 rows. No finding, no blocker.

### 2.1 Attempted

| RT | Method (attempts) | Outcome | Server answer | Proposed fix |
| --- | --- | --- | --- | --- |
| RT-62 (candidate side) | Candidate routes (`GET /candidate/session`, `POST /candidate/session/proctor-key`, `POST /candidate/answers/:id/submit`) with no token, a garbage token, `alg: none`, an HS256 token signed with a random key, the same expired (15 attempts) | Blocked | 401, no code, every case | none |
| RT-62 (staff token on candidate routes) | Recruiter access token on `GET /candidate/session`, `POST .../heartbeat`, `POST .../proctor-key` (3) | Blocked | 401, no code | none |
| RT-62 (candidate-shaped token on staff routes) | Forged candidate-shaped HS256 and `alg: none` on `GET /review/queue`, `/questions`, `/tests` (6) | Blocked | 401, no code | none. A real candidate token on staff routes is Blocked-by-env (2.3) |
| RT-63 recruiter | `GET /review/queue`, `POST /questions` (empty body), `PATCH /questions/:id` (unknown id), `GET /admin/users`, `GET /admin/org-settings` (5) | Blocked | 403, no code. The guard answers before validation and before the id lookup | none |
| RT-63 reviewer | `GET /tests`, `POST /tests`, `POST /questions`, `GET /admin/users` (4) | Blocked | 403, no code | none |
| RT-63 author | `GET /review/queue`, `GET /review/sessions/:id`, `GET /tests` (3) | Blocked | 403, no code | none |
| RT-64 / RT-61 (within one org) | Recruiter `GET /tests/<unknown uuid>` twice with different ids, and `/tests/not-a-uuid` (3) | Blocked | 404 for both unknown ids, same status and body length; 400 for the malformed id. No oracle inside the org. The cross-org half of the row needs a second org (2.3) | none |
| RT-68 (unknown links) | `POST /candidate/session/link`, `/otp`, `/start` (wrong code) with a random 43-character token (3) | Blocked | 404, no code, the same answer on all three ("This invitation link is not valid."): no oracle between link, OTP and start | none |
| RT-68 (input) | `link` with a 10000-character token, a numeric token, an extra property (3) | Blocked | 400 for each (the 10000-character token and the extra property: 400 from validation, not a lookup) | none |
| RT-08 (input limits, route that exists) | `POST /candidate/session/link` with a 300 KiB body, `Content-Type: text/plain`, invalid JSON (3) | Blocked | 413; 400; 400 | The plan expects 415 for `text/plain` on the events routes; this public route answers 400. Not a defect for this route; re-check with the events route when it exists |
| RT-68 / TC-002 (one wrong password) | `POST /auth/login` recruiter, wrong password, once | Blocked | 401, no code | none (no guessing beyond this one check) |

Total 48 attempts, all as the docs expect.

### 2.2 Not testable: route absent on `main` at `d2bcd707`

| RT | Reason |
| --- | --- |
| RT-01 to RT-07 | `POST /candidate/session/events` (signed batches) does not exist. The signing helper basis (`packages/qa/k6/lib/canonical.js`) is ready |
| RT-08 (events 256 KiB, keystrokes 2 MiB, gzip, 101 events) | events and keystrokes routes absent |
| RT-13, RT-14 (events, keystrokes, presign limits; batches after submit) | events and keystrokes routes absent. Heartbeat and proctor-key limits need a candidate token (2.3) |
| RT-71 | no Socket.IO gateway in `apps/api/src` |
| RT-55a, RT-55b, RT-66 (playback, results) | playback route exists (`GET /review/sessions/:id/recordings/:recordingId/playback`) but needs a recording and a second org; no recording exists locally. Results routes (report, verdict, export, webhook) are absent |

### 2.3 Blocked-by-env: not run, reason

| RT | Reason |
| --- | --- |
| RT-10 (proctor-key second call, 409 `KEY_ALREADY_ISSUED`) | needs a real candidate session token. The only way to get one is the seeded invitation (`node infra/scripts/demo-invite.mjs`), which needs the owner's `.env` database credentials (the script connects to the database as the owner role and rewrites the owner's current demo link). A QA session does not hold those (ADR 0009, brief: no database access). Helper support exists (below) |
| RT-11 (takeover) | needs two OTP sign-ins on a started session |
| RT-60 (A1 token with A2 identifiers) | needs two candidate sessions (the seed has them, but no link) |
| RT-61, RT-64 (cross-org), RT-55a, RT-67 | blocked: needs second org. The seed has one organisation, Demo Corp, and the API has no route to create an organisation. Not created through the database by design |
| RT-62 (a real candidate token on `/review/*`, `/questions`, `/tests`) | needs a candidate token |
| RT-65 (hidden tests oracle) | needs a started session and the run and submit routes (they exist: `answers/:questionId/run` and `submit`) |
| RT-68 (link reuse, OTP brute force before and during the test, old OTP) | needs the real link and the OTP from Mailpit; the 5-wrong-codes block (TC-007) would also lock the owner's demo link for 30 minutes |
| RT-69 (consent bypass, sign without 18+, replay, decline then continue) | needs a candidate token. Decline is final for the invitation |
| RT-70 | needs an erased session |
| RT-72, RT-73, RT-74 | out of scope for this dry run (browser or Judge0 or webhooks) |
| RT-20 to RT-56 (SDK, devices, screens, uploads) | out of scope: need browsers, OBS, camera (round 2) |

## 3. How the owner can complete the candidate rows

The helper runs the candidate rows when it is given the link the owner already has. The link is a secret: it goes in an environment variable on the owner's machine, never in a file, issue or chat.

```bash
node infra/scripts/demo-invite.mjs        # the owner's step; prints the link
RT_CANDIDATE_URL='<link>' node packages/qa/redteam/round1-local.mjs
```

It then asks for the code, reads it from Mailpit in memory, makes one wrong-code check, signs in, and runs the RT-68 replay and the RT-69 rows that do not change state (test start, presign, run and heartbeat before consent; consent sign without the 18+ confirmation). The decline rows run only with `RT_ALLOW_DECLINE=1`, because decline ends the demo invitation. This candidate part has NOT been run (no link); it is unverified code and its expected statuses are taken from the docs, so treat a first difference as a possible helper error.

## 4. Method notes

- The helper only needs Node 24, no install. It reads the demo password from the seed's guard file at run time and never prints it.
- Not yet tested: a real candidate token against a different candidate's ids (RT-60). Because candidate routes have no `:sessionId` (CS-1), ids in paths and bodies (`:questionId`) are the only handle; that is the first thing to try when a link is available.
- No security weakness was found in the attempted rows; no blocker to report.
