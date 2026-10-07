# Run it locally

Everything below runs on your own machine with synthetic data only. Nothing here touches AWS, a real
email address, or a real candidate. Last checked against `main` on 2026-10-07 (commit `a3aaa02e`); the
"What works today" table says what was actually seen working and what is not on `main` yet.

## What you can do, in one table

| You want to                                      | Use                                                            | State today                                                         |
| ------------------------------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------- |
| See every screen with no backend at all          | `pnpm dev:web:mock` (section 5)                                | Works. Fake data, fake API.                                         |
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

## 2. First time

From the repository root:

```bash
pnpm install
node infra/scripts/local-env.mjs      # writes .env and apps/web/.env.local with random local secrets
pnpm dev:infra                        # PostgreSQL 16, Redis 8.8, Adminer; waits until healthy
pnpm --filter @codeproctor/shared build   # the shared types the API and web import (needed on a fresh checkout)
pnpm db:generate
pnpm db:migrate                       # applies the migrations and sets the local app_user password
pnpm db:seed                          # the demo data (section 3)
```

What `local-env.mjs` does: copies `.env.example`, replaces every `change-me` with a fresh random value
(the database passwords, the JWT, cookie and OTP secrets, the encryption keys), and writes
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
| Candidate one-time email code                         | **Not on `main` yet**: `EMAIL_PROVIDER=noop` drops mail and the send answers 503 `MAIL_UNAVAILABLE`. Planned: a local mail sink (Mailpit) and an SMTP adapter allowed only locally. |
| File uploads, ID images, consent PDF                  | **Not on `main` yet**: no local object store (the `S3_*` values are empty). Planned: MinIO in the local compose stack. |
| Running candidate code                                | **Not on `main` yet** on a Mac: Judge0 needs Linux x86 (section 7). Planned: a local-only execution stub with clearly labelled canned results. |
| Analysis worker (`apps/worker`)                       | **Nothing to start yet**: Python modules and tests only; the job consumer arrives with later steps.     |
| Proctoring in a real browser against the real API     | Not wired end to end; the browser parts run in mock mode (`/t/demo/test`, `/dev/proctor`).              |

## 7. Not on `main` yet: what is planned

These are tracked in the delivery plan; this guide will change as each lands.

- **Mail** (local only): Mailpit, a free dev mail sink, in `infra/docker-compose.yml`, plus an SMTP mail
  adapter in the API that is refused outside local development. The candidate code will then show in
  Mailpit's web page.
- **Object store**: MinIO (S3 compatible, free) in the compose stack, with the bucket created on start
  and the CORS that browser uploads need, and the local `S3_*` values filled in `.env.example`.
- **Code execution**: a local-only stub that returns canned results labelled "local stub, not real
  execution". Real Judge0 (`infra/judge0`) needs Linux x86, privileged containers and cgroup v1, so it
  is not validated on macOS or Apple Silicon; it runs on the pilot host.
- **Worker**: a compose service once the worker has a job consumer.

Changes to `infra/docker-compose.yml` get the architecture hub's gate review.

## 8. Stop, restart, start again

```bash
pnpm dev:infra:down                   # stops the containers; the data stays in Docker volumes
pnpm dev:infra                        # starts them again; then the two app commands
```

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
