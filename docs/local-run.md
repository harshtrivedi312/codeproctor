# Run it locally

Everything below runs on your own machine with synthetic data only. Nothing here touches AWS, a real
email address, or a real candidate. Last checked against `main` on 2026-10-07 (commit `a3aaa02e`); the
"What works today" table says what was actually seen working and what is not on `main` yet.

## What you can do, in one table

| You want to                                      | Use                                                            | State today                                                         |
| ------------------------------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------- |
| See every screen with no backend at all          | `pnpm dev:web:mock` (section 5)                                | Works. Fake data, fake API.                                         |
| Start everything with one command                | `pnpm demo:up` (section 2)                                     | Works on a free machine; `pnpm demo:down` stops it.                 |
| Sign in as staff, browse questions, tests, users | the real stack (sections 1 to 4)                               | Works (checked).                                                    |
| Open a candidate invitation link                 | `node infra/scripts/demo-invite.mjs` (section 4)               | The link opens; the one-time code cannot be sent yet (see below).   |
| Take a test as a candidate, end to end           | the real stack                                                 | **Not on `main` yet**: needs a dev mail sink and a code runner.     |
| Run candidate code                               | Judge0                                                         | **Not on `main` yet** on a Mac: Judge0 needs Linux x86 (section 7). |

## 1. Prerequisites

- **Node 24** (`package.json` says `>=24 <25`). Check with `node --version`.
- **pnpm 12** (the repository pins the exact version; `corepack enable` installs it).
- **Docker Desktop** (or Docker Engine) running, for PostgreSQL 16, Redis 8.8 and Adminer.
- Git. Nothing else: no AWS account, no cloud login.

Free local ports: 5432 (PostgreSQL), 6379 (Redis), 8080 (Adminer), 4000 (API), 3000 (web). If
another stack already uses 5432 or 6379, stop it first (or see "Troubleshooting").

## 2. One command, or step by step

**One command** (from the repository root, with Docker running and ports 5432, 6379, 8025, 8080, 9000,
9001, 4000 and 3000 free):

```bash
pnpm install
pnpm demo:up
```

`pnpm demo:up` writes `.env` if it is missing, starts the stack, builds the shared package, migrates,
seeds, gives the seeded invitation a real link, starts the API and the web app in the background (logs in
`.demo/`), waits until both answer, and prints the links, the accounts and where the password is. It is safe
to run again (an app that already answers is left alone, and `demo:down` only stops processes it can see are
its own pnpm dev commands). `pnpm demo:down` stops the two apps (`pnpm demo:down --infra` stops the containers too; the
data stays in Docker volumes). `pnpm demo:up --dry-run` lists the steps without running them, and
`--no-apps` starts everything except the API and the web app.

**Step by step** (what `demo:up` does):

From the repository root:

```bash
pnpm install
node infra/scripts/local-env.mjs      # writes .env and apps/web/.env.local with random local secrets
pnpm dev:infra                        # PostgreSQL 16, Redis 8.8, Adminer, Mailpit, MinIO; waits until healthy
pnpm --filter @codeproctor/shared build   # the shared types the API and web import (needed on a fresh checkout)
pnpm db:generate
pnpm db:migrate                       # applies the migrations and sets the local app_user password
pnpm db:seed                          # the demo data (section 3)
```

What `local-env.mjs` does: copies `.env.example`, replaces every `change-me` with a fresh random value
(the database passwords, the JWT, cookie and OTP secrets, the encryption keys, the MinIO login), and writes
`apps/web/.env.local` with `NEXT_PUBLIC_API_URL=http://localhost:4000/api`. The API serves under
`/api`, and the web app's built-in default (`http://localhost:4000`) lacks that prefix, so without the
second file every sign-in fails with "The server did not answer as expected". `.env` sets `APP_ENV=development` explicitly: it is required and has no default, and the local-only paths
(the seed, the demo scripts, and later the mail sink, object store and execution stub) switch on only for
exactly that value. The script refuses to overwrite
an existing `.env`; delete the file to start again. Never put these values anywhere shared.

`pnpm db:migrate` and `pnpm db:seed` refuse to run unless every database URL points at this machine and
`APP_ENV` is `development`. That is deliberate (ADR 0009): they can never touch another environment.

**The local `.env` is for this laptop only.** Staging and the pilot refuse its placeholder-style values
and need their own real, generated secrets from their own store (ADR 0009). Never copy this file to
another machine or environment, and never commit it.

The stack (`infra/docker-compose.yml`) binds every port to 127.0.0.1:

| Service  | Address                                   | What it is                                                              |
| -------- | ----------------------------------------- | ----------------------------------------------------------------------- |
| Mailpit  | <http://localhost:8025> (SMTP on 1025)    | Catches every email (candidate codes) so nothing leaves the machine.    |
| MinIO    | S3 <http://localhost:9000>, console <http://localhost:9001> | Local S3-compatible object store; the buckets `codeproctor-media` and `codeproctor-backup` exist at start, CORS only for `http://localhost:3000`. Login: `MINIO_ROOT_USER` and `MINIO_ROOT_PASSWORD` in `.env`. |
| Adminer  | <http://localhost:8080>                   | A database browser.                                                     |

An `.env` written before MinIO was added has no `MINIO_*` or `S3_*` lines, and `pnpm dev:infra` then refuses
to start (the MinIO image would otherwise run with a publicly known login). Delete that `.env` and run
`pnpm demo:up` (or `node infra/scripts/local-env.mjs`) again.

The MinIO image is a frozen Bitnami build (the official MinIO images are no longer published), which is
fine for synthetic local data and must never be used in a shared environment.

Adminer (a database browser) is at <http://localhost:8080>: system PostgreSQL, server `postgres`, user
`codeproctor`, the `POSTGRES_PASSWORD` from your `.env`, database `codeproctor`.

## 3. The demo data

`pnpm db:seed` creates one organisation, **Demo Corp**, and:

| Who                                 | Email                         | Role        |
| ----------------------------------- | ----------------------------- | ----------- |
| Admin                               | `admin@demo-corp.example`     | SUPER_ADMIN |
| Recruiter                           | `recruiter@demo-corp.example` | RECRUITER   |
| Author                              | `author@demo-corp.example`    | AUTHOR      |
| Reviewer                            | `reviewer@demo-corp.example`  | REVIEWER    |
| Five candidates (Avery, Bao, ...)   | `*@candidates.example`        | -           |

The password of every staff account is the development password in `prisma/seed/guard.ts`
(`DEMO_PASSWORD`, currently `ChangeMe!2026`). It exists only in the development seed; staging, pilot
and production never use it, and the seed refuses to run anywhere but a local development database.

The demo invitation (`demo-invite.mjs`) is Avery Stone's, on the **Backend Engineer Screen**, which uses the
**STANDARD** proctoring profile (the other test, the Senior Engineer Screen, is STRICT and is not used for
the demo). That test has 60 minutes in two sections: four coding questions (Parcel Surcharge, Sensor Burst
Count, Steady Stretch, Stock Rebalancing, each with 3 sample tests shown to the candidate and 8 hidden
tests), one multiple-choice and one short-answer question, so runs and submits have something to show.

Also seeded: 8 questions (coding, multiple choice, short answer; all published), 2 tests (Backend
Engineer Screen, Senior Engineer Screen), 7 invitations with their sessions in different states
(invited, consented, expired, declined, completed, one under review), consents, identity checks,
proctor events and one completed review. Running `pnpm db:seed` again inserts nothing.

## 4. Start the apps

Two terminals (or run each in the background), from the repository root:

```bash
pnpm --filter @codeproctor/api dev    # builds, then serves http://localhost:4000/api/v1
pnpm dev:web                          # http://localhost:3000
```

Check the API: <http://localhost:4000/api/v1/health> answers `{"status":"ok", ...}` with PostgreSQL and
Redis `up`. The API log will repeat `Job consent-pdf failed`: the seeded consents have no PDF and there
is no object store locally yet. That is expected until the local object store exists (section 7).

**Browser**: use **Chrome or Firefox**, and always open the web app as `http://localhost:3000` (not
`127.0.0.1`: the API's allowed web origin is exactly that). Safari does not keep the staff sign-in
cookie over plain `http://localhost` (it is `Secure`), so staff sign-in and refresh break there until the
local-only fix (FU-BE-222, Backend A) is merged; this note will then be dropped.

**Sign in as the recruiter**: open <http://localhost:3000/admin/login>, `recruiter@demo-corp.example`
and the development password. You land on the staff dashboard. Questions (8) and Tests (2) show the
seed.

**Sign in as the admin** (needs a second factor, forced on first sign-in): after the password the page
shows a QR code and a "manual key". You do not need a phone:

```bash
node infra/scripts/demo-totp.mjs <the manual key shown on the page>
```

It prints the current 6 digit code. Type it in, then save the recovery codes shown. Later sign-ins ask
for a fresh code from the same command (the manual key is shown only while you enrol: keep it, or use
one of the recovery codes).

**A candidate link**: the seed's invitation links are placeholders and cannot open. This gives one
seeded invitation (Avery Stone's, still INVITED) a real link, valid for seven days:

```bash
node infra/scripts/demo-invite.mjs
```

It prints the candidate's email and the link (`http://localhost:3000/t/<token>`). Run it again for a
new link; the old one stops working. The link opens the gate page ("Demo Corp"). Asking for the
email code then fails with "The code could not be sent": see section 7.

## Your camera, your microphone, your data

The local demo uses your real camera and microphone. Recordings, the ID photo and the selfie are stored
only in the local MinIO and PostgreSQL containers, on this Mac. To remove them, run `pnpm demo:down
--infra`, then delete the Docker volumes (`docker volume rm codeproctor_minio_data
codeproctor_postgres_data`; a person runs this, it deletes all local data). Use a synthetic candidate
name and the seeded test mailbox (Mailpit), and never upload a real ID document.

## 5. No backend: mock mode

```bash
pnpm dev:web:mock
```

Serves every API call from fake data in the browser. Nothing else needs to run, not even Docker. Open
<http://localhost:3000/admin/login> (mock users and passwords are listed in `apps/web/README.md`; the
admin's code is `123456`) and <http://localhost:3000/t/demo/test> for the candidate test screen preview.
Screens that the real API does not serve yet (candidates, live, review, reports) can be seen here.

## 6. What works today and what does not

Checked on 2026-10-07 on a throwaway database with the commands above.

| Area                                                  | State                                                                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `pnpm db:migrate`, `pnpm db:seed`                     | Works. 358 seeded rows.                                                                                 |
| API starts, `/api/v1/health`                          | Works (PostgreSQL, Redis).                                                                              |
| Staff sign-in (recruiter), dashboard                  | Works through the web app.                                                                              |
| Admin sign-in with the second factor                  | Works with `demo-totp.mjs` (checked against the API).                                                   |
| Questions list (8) and Tests list (2)                 | Works against the real API.                                                                             |
| Candidates list (`/admin/candidates`)                 | **Not on `main` yet**: the API has no `admin/candidates` route (the page stays on "Loading"). Mock mode shows it. |
| Invite candidates, live view, review, reports         | **Not on `main` yet** in the API (no routes). Mock mode shows the screens.                              |
| Candidate link opens the gate                         | Works after `demo-invite.mjs`.                                                                          |
| Mailpit (the inbox) in the stack                      | Works: the stack starts it and a test email sent to port 1025 shows in <http://localhost:8025> (checked). |
| Candidate one-time email code                         | **Not working yet on `main`**: the API has the `smtp-dev` adapter and `local-env.mjs` now switches it on (`EMAIL_PROVIDER=smtp-dev`, allowed only with `APP_ENV=development`), but the candidate module is not bound to a mail provider: the send answers 503 `MAIL_UNAVAILABLE` and the log says `UnboundCandidateMailPort ... template otp not sent` (checked 2026-10-07). Waiting for Backend A to bind it. |
| MinIO (the object store) in the stack                 | Works: the two buckets exist at start, an upload and a listing through the S3 API work, and a browser preflight from `http://localhost:3000` is allowed while any other origin is not (checked). |
| File uploads, ID images, consent PDF                  | **Lands with #119** (BE-09: `StorageService` and `S3ObjectStore`, which bind the API to S3). The `S3_*` values in `.env` already point at MinIO; until #119 merges nothing in the API uses the store, and the API log repeats `Job consent-pdf failed`. |
| Running candidate code                                | The API accepts `JUDGE0_MODE=stub` and `local-env.mjs` switches it on (`JUDGE0_MODE=stub`: canned results labelled "local stub, not real execution", allowed only with `APP_ENV=development`). Real Judge0 is Linux x86 only (section 7); it is not used on a Mac. |
| Analysis worker (`apps/worker`)                       | **Not part of `demo:up`.** The face-match service exists (`worker.app:app`, FastAPI) but has no Dockerfile or tuned models yet (the face landmarker model is not downloaded, P-13), and the API's presigned URLs name `localhost:9000`, which a worker inside Docker cannot reach. Without it the identity check answers MANUAL_REVIEW and the candidate continues. The compose file has a `worker` profile as the place for it. |
| Proctoring in a real browser against the real API     | Not wired end to end; the browser parts run in mock mode (`/t/demo/test`, `/dev/proctor`).              |

## 7. Not on `main` yet: what is planned

These are tracked in the delivery plan; this guide changes as each lands.

- **Mail**: Mailpit is in the stack and the API has the `smtp-dev` adapter. The candidate module still has to
  be bound to it (Backend A); then the candidate code shows in Mailpit's web page.
- **Object store**: MinIO is in the stack. #119 (BE-09) binds the API to it.
- **Code execution**: Backend A's local stub. Real Judge0 (`infra/judge0`) needs Linux x86, privileged
  containers and cgroup v1, so it is not validated on macOS or Apple Silicon and its isolation is not
  relaxed for a Mac; it runs on the pilot host.
- **Worker**: a Dockerfile and the model files, then the `worker` profile (Integrity B).

Changes to `infra/docker-compose.yml` get the architecture hub's gate review.

## 8. Stop, restart, start again

```bash
pnpm demo:down                        # stops the API and the web app
pnpm demo:down --infra                # ... and the containers; the data stays in Docker volumes
pnpm demo:up                          # starts everything again (safe to repeat)
```

By hand: `pnpm dev:infra:down` and `pnpm dev:infra`, then the two app commands.

To get a clean database, ask a person to run `pnpm db:reset` (it deletes the local data, and only works
on a local database; agents never run it). Then `pnpm db:migrate` and `pnpm db:seed` again.

## Troubleshooting

- **"The server did not answer as expected" on sign-in**: `apps/web/.env.local` is missing or does not
  say `NEXT_PUBLIC_API_URL=http://localhost:4000/api`; restart `pnpm dev:web` after fixing it.
- **`db:migrate` or `db:seed` refuses**: the message names the cause: `APP_ENV` must be `development`
  (seed), and every database URL must point at `127.0.0.1` or `localhost`.
- **Port already in use** (5432, 6379, 4000, 3000): another stack or dev server is running. Stop it,
  or change the port in `.env` and in `infra/docker-compose.yml` together.
- **API refuses to boot**: it names the missing or invalid `.env` value. A secret shorter than 32
  characters, or a leftover `change-me`, is refused. Delete `.env` and run `local-env.mjs` again.
- **Signed in, then thrown out at once (Safari)**: see the Browser note in section 4; use Chrome or Firefox.
- **Node version**: the install may work on other versions, but only Node 24 is supported.
