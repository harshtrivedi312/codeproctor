# Red-team round 1, local dry run

Owner: qa-engineer (QA B). Run 2026-10-09. Plan: docs/qa/redteam-plan.md (section 4). Approval: Delivery Lead message, 2026-10-09 (D-80 follow-up), a message, not a repo record: D-80 is not in the docs on this branch.

## 1. Environment and deviations

| Item | Value |
| --- | --- |
| Build under test | `main` at `d2bcd707` (docs and code read at that commit). The running stack was started by the owner; `/health` returns only `status` and the postgres and redis checks, so its build could not be read and may be older |
| Target | the owner's LOCAL demo stack: API `http://localhost:4000/api/v1`, web `http://localhost:3000`, Mailpit `:8025`. NOT staging, not pilot |
| Purpose | a dry run to validate the method and the helper `packages/qa/redteam/round1-local.mjs` (it refuses any non-local base URL and never follows redirects). It is not the QA-02 round and its results do not go into docs/red-team-report.md |
| Deviation from plan rule 1 | rule 1 says staging only, after DEP-01. This run is local, on the owner's request, with the Delivery Lead's approval (message above) |
| Outcomes | the plan has three outcomes (Blocked, Detected, Undetected). This document adds Not testable (route absent), Blocked-by-env (needs something this run did not have) and Out of scope. The extra three apply only to this dry run, not to the QA-02 report |
| Data | synthetic demo seed only (Demo Corp, one organisation) |
| What the run changed | not "nothing": the three staff logins each created a login session (refresh token and audit rows) and the wrong-password call added one to the failed-login count of the demo recruiter. The helper was run four times: a first run (before the events and keystrokes probes existed in it), two re-runs after review, and a final run on the pushed commit. The totals in section 2 are from the final run only; earlier runs differed (the first run had 4 fewer calls, because the events and keystrokes probes came later). Summed over all four runs: `/auth/login` 16 calls (12 successful, 4 wrong-password, spread over more than 60 s between runs, under the 10 a minute limit), `/candidate/session/link` 28 plus one hand-made curl, `/otp` 4, `/start` 4. Everything else was a read, a rejected write or an unknown id |
| Not done | no start, stop or reset of the stack; no database access (no psql, no Adminer, no seed script); no candidate token existed; the owner's demo link was not used |
| Secrets | none recorded. The helper prints route, status and problem `code` only (and a few booleans that compare answers) |
| Rate limits | no 429 in any run; no limit probed more than 10 times. The helper ends the run at the first 429 from any call |

The API answers with problem+json (`type`, `title`, `status`, `instance`, `traceId`, `detail`). The 401, 403 and 404 answers seen carry no `code` field, which matches the plan for role denials and the generic link 404. The column "answer" therefore shows the status and "no code".

## 2. Counts

Final run: 56 calls, all as the docs expect. 3 are setup (the staff logins), 53 are attempts. Per row (RT id):

| Outcome | Rows | Calls |
| --- | --- | --- |
| Blocked (at least one part attempted) | 6: RT-05, RT-08, RT-62, RT-63, RT-64, RT-68 | 53 |
| Detected | 0 | 0 |
| Undetected | 0 | 0 |
| Blocked-by-env (not attempted) | 18: RT-01, 02, 03, 04, 06, 07, 10, 11, 13, 14, 55a, 55b, 60, 61, 65, 67, 69, 70 | 0 |
| Not testable (route absent) | 2: RT-66, RT-71 | 0 |
| Out of scope | RT-09, RT-12, RT-72 to RT-74, RT-20 to RT-47, RT-50 to RT-54, RT-56 | 0 |

The six Blocked rows are partial: what they leave over is in 3.3. No finding, no blocker.

## 3. Rows

### 3.1 Attempted (53 calls)

| RT | Method (calls) | Outcome | Server answer | Proposed fix |
| --- | --- | --- | --- | --- |
| RT-62 (candidate side) | `GET /candidate/session`, `POST /candidate/session/proctor-key`, `POST /candidate/answers/:id/submit` with no token, a garbage token, `alg: none`, an HS256 token signed with a random key, the same expired (15) | Blocked | 401, no code, every case | none |
| RT-62 (staff token on candidate routes) | Recruiter access token on `GET /candidate/session`, `POST .../heartbeat`, `POST .../proctor-key` (3) | Blocked | 401, no code | none |
| RT-62 (forged candidate-shaped token on staff routes) | HS256 random key and `alg: none` on `GET /review/queue`, `/questions`, `/tests` (6) | Blocked | 401, no code | none. A real candidate token on staff routes: 3.3 |
| RT-05 (forged token only) | `POST /candidate/session/events` and `/keystrokes` with no token and with a random-key HS256 token, no signature (4). These routes exist on main (BE-10) | Blocked | 401, no code, the token check comes before the signature check | none. The signature and the A1-key-with-A2-token parts: 3.3 |
| RT-63 recruiter | `GET /review/queue`, `POST /questions` (empty body), `PATCH /questions/:id` (unknown id), `GET /admin/users`, `GET /admin/org-settings` (5) | Blocked | 403, no code; the guard answered before validation and the id lookup | none |
| RT-63 reviewer | `GET /tests`, `POST /tests`, `POST /questions`, `GET /admin/users` (4) | Blocked | 403, no code | none |
| RT-63 author | `GET /review/queue`, `GET /review/sessions/:id`, `GET /tests` (3) | Blocked | 403, no code | none |
| RT-64 (one org only) | Recruiter `GET /tests/<unknown uuid>` twice with different ids, and `/tests/not-a-uuid` (3) | Blocked | 404 twice, 400 for the malformed id. The two unknown ids answered alike in status, code and length; the problem body includes `instance`, so equal length is by construction. Oracle (own org vs other org) NOT tested: needs a second org | none |
| RT-68 (unknown link) | `POST /candidate/session/link`, `/otp`, `/start` (wrong code) with a random 43-character token (3) | Blocked | 404, no code on all three. The helper compares status and code only; the `detail` text ("This invitation link is not valid.") was read once by hand with curl on the link route. A valid-token vs invalid-token comparison is what an enumeration test needs, and needs a real link: 3.3 | none |
| RT-68 (input) | `link` with a 10000-character token, a numeric token, an extra property (3) | Blocked | 400 each (the status only; the helper does not read why) | none |
| RT-68 / TC-002 (one wrong password) | `POST /auth/login` recruiter, wrong password, once (1) | Blocked | 401, no code | none (no guessing beyond this one check) |
| RT-08 (link route only) | `POST /candidate/session/link` with a 300 KiB body, `Content-Type: text/plain`, invalid JSON (3) | Blocked | 413; 400; 400 | The plan expects 415 for `text/plain` on the events routes; this public route answers 400. Re-check on `POST /candidate/session/events` with a candidate token |

3 + 15 + 3 + 6 + 4 + 5 + 4 + 3 + 3 + 3 + 3 + 1 + 3 = 56 calls with the setup logins.

### 3.2 Not testable: route absent on `main` at `d2bcd707`

| RT | Reason (checked by listing every `@Controller` in `apps/api/src`) |
| --- | --- |
| RT-66 (staff half) | no report, score, verdict, export or webhook route exists; the review controller has only `queue`, `sessions/:id` and the recording playback. The candidate half (the state route masks review statuses as SUBMITTED, Q17, C-28) is Blocked-by-env: it needs a candidate token |
| RT-71 | no Socket.IO gateway or `@SubscribeMessage` in `apps/api/src` (only the BE-08 README mentions one as future) |

### 3.3 Blocked-by-env: not run, and what each attempted row left over

Why: no candidate token. The only source of one is the seeded invitation (`node infra/scripts/demo-invite.mjs`), which connects to the database with the owner's `.env` credentials and rewrites the owner's current demo link; a QA session holds neither (ADR 0009, brief: no database access). The cross-org rows need a second organisation: the seed has one (Demo Corp), the API cannot create one, and one is not created through the database.

| RT | Needs |
| --- | --- |
| RT-01, 02, 03, 04, 06, 07 | a candidate token and the batch key (`POST /candidate/session/proctor-key`, once per epoch) to build signed `events` batches with the ADR 0013 scheme. The routes exist (BE-10). The helper does not implement the signing half; the basis is `packages/qa/k6/lib/canonical.js` |
| RT-08 (events 256 KiB, keystrokes 2 MiB, gzip, 101 events) and RT-13, RT-14 | the same, plus a started session for the after-submit rows |
| RT-10, RT-11 | a candidate token and a started session; RT-11 two OTP sign-ins |
| RT-60 | two candidate sessions (the seed has them; no link) |
| RT-61, RT-64 (cross-org half), RT-55a, RT-67 | blocked: needs second org |
| RT-55b | a recording (none exists locally) |
| RT-62 (a real candidate token on `/review/*`, `/questions`, `/tests`) | a candidate token |
| RT-65 | a started session; `answers/:questionId/run` and `submit` exist |
| RT-68 (link reuse, OTP brute force before and during the test, old OTP, valid vs invalid token) | the real link and the OTP. Five wrong codes lock the owner's demo link for 30 minutes (TC-007) |
| RT-05 (A1 key with A2's token, B1's token) | two candidate sessions and a key |
| RT-69 | a candidate token. Decline is final for the invitation |
| RT-70 | an erased session |

### 3.4 Out of scope for this dry run

RT-72 (browser XSS), RT-73 (Judge0), RT-74 (webhooks), RT-09 (key extraction from the page: browser) and RT-12 (dropping requests at a proxy: proxy and browser), and the browser, device and camera rows RT-20 to RT-47, RT-50 to RT-54 and RT-56 (round 2: need browsers, OBS, cameras).

## 4. The candidate half of the helper (unverified)

The helper can run the candidate rows when the owner gives it the link. The link is a secret: it goes in an environment variable on the owner's machine, never in a file, issue or chat. This half has NOT been run (no link). Its expected statuses come from the docs and the DTOs, so treat a first difference as a possible helper error.

```bash
node infra/scripts/demo-invite.mjs        # the owner's step; prints the link and the candidate's email
RT_CANDIDATE_URL='http://localhost:3000/t/<token>' RT_CANDIDATE_EMAIL='<address>' \
  node packages/qa/redteam/round1-local.mjs
```

What it does: requests the code, polls Mailpit for the newest message to that address that arrived after the request (it submits nothing if none arrives), and refuses to start if a previous run left a wrong-code attempt less than 30 minutes ago. It then makes one wrong-code check, signs in with the right code, replays the used code, and tries the RT-69 rows that need no consent (test start, presigns, run, heartbeat, proctor-key before start). For the 18+ control (C-30) it first reads the consent document for `consentTextId`, then sends a body with `consentTextId`, `signedName` and varies only `confirmedAge18` (missing, then false), expecting 400 for each. SAME needs more than the status: the missing case must carry an `errors[]` entry starting with `confirmedAge18` (the DTO validation), and the false case must carry the problem `code` `AGE_CONFIRMATION_REQUIRED` (it passes the boolean check and is refused by the consent service, so its text does not name the field). These assertions are unrun and unverified. The decline rows (decline, sign after decline expecting 409, test start after decline) run only with `RT_ALLOW_DECLINE=1`.

Side effects on the owner's stack, to know before running it:

- The right-code start raises `auth_epoch` (ADR 0002 L-2, `candidate-auth.controller.ts`): the owner's browser on that link is signed out of its session.
- If the consent control were broken, a sign call could move the session from OPENED to CONSENTED.
- One wrong code counts toward the pre-test lock (5 wrong block the link for 30 minutes).
- A decline cannot be undone for that invitation.

The decline rows, the 18+ rows and the replay need a real link and are unrun.

## 5. Method notes

- The helper needs Node 24 and no install. The staff password is `RT_STAFF_PASSWORD` if set, else the development constant in the seed guard (local seed only); it is never printed.
- No security weakness was found in the attempted rows; no blocker to report.
