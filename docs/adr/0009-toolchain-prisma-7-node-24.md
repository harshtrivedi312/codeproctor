# ADR 0009: Toolchain: Prisma 7, Node 24 LTS, TypeScript 6.0

| Field | Value |
| --- | --- |
| Status | **Accepted** 2026-10-02 (D-31, D-32). Details marked "architect detail" are chosen by the architect, for the owner to confirm. |
| Author | architect |
| Decides | Toolchain versions; where the database URL lives; the Prisma Client generator and driver adapter; the Prisma 7 CLI changes DB-02..DB-04 rely on; how the `db:*` scripts are guarded; how Prisma's AI-agent consent check is handled |
| Serves | NFR-04 (secrets, least privilege), NFR-03 (no accidental loss of a shared database), FR-105 (the app connects as `app_user`), NFR-01 (driver pool, tuned in BE-15B) |
| Related | ADR 0006 section 7 (roles through a migration, D-35, same day). DB-01 code review findings S4 (no host guard on `db:reset`) and N14 (init scripts run only on an empty volume). |

## 1. Context

DB-01 (`db/step-1`) pins Prisma CLI 7.10.0, TypeScript ~6.0.3, pnpm 12.8.1 and Node 22. The briefs and prompts were written for Prisma 6 (`url` in `schema.prisma`, `prisma-client-js`, `--to-schema-datamodel`, automatic seed). The owner decided Prisma 7 (D-31) and Node 24 LTS (D-32). Prisma also blocks destructive commands when it detects an AI agent. Every database task in this project is run by an agent.

## 2. Toolchain

| Tool | Pin | Where it is pinned | Why | Support |
| --- | --- | --- | --- | --- |
| Node.js | 24 LTS "Krypton" | `.nvmrc` `24`; `engines.node` `>=24 <25`; `@types/node` `^24` | D-32. Current LTS line that still bundles corepack. | Maintenance LTS from 2026-10-20; end of life 2028-04-30 |
| pnpm | 12.8.1 | `packageManager`, enabled by `corepack enable` (CI and local) | Reproducible installs | Runs on Node >= 18 |
| TypeScript | ~6.0 (6.0.3) | root devDependency | typescript-eslint supports TypeScript `>=4.8.4 <6.1.0`. TypeScript 7.0 ships no JavaScript API, so typescript-eslint cannot run on it. Revisit when typescript-eslint supports 7.x. | n/a |
| typescript-eslint | ^8.71 | root devDependency | `no-explicit-any` (CLAUDE.md) | n/a |
| Prisma CLI, `@prisma/client`, `@prisma/adapter-pg` | 7.10.x, the same exact version for all three | CLI: root devDependency. Client and adapter: `apps/api` dependencies (DB-02) | D-31. CLI and client versions must match. | n/a |
| `pg` | ^8.16.3, the range `@prisma/adapter-pg` 7.10.0 requires | `apps/api` dependency | Driver behind the adapter | n/a |
| Python | 3.12 | `apps/worker/pyproject.toml`, CI `setup-python` | CLAUDE.md | Security fixes only; end of life 2028-10 |
| PostgreSQL | 16 | `postgres:16` in compose; managed hosts (ARC-05) | Already decided | End of life 2028-11-09 |
| Redis | 8.8 (AGPLv3 option) | `redis:8.8` in compose | Already decided (D-09) | n/a |

## 3. Options considered

- **Prisma.**
  - (a) **Chosen:** Prisma 7.10 with the `prisma-client` generator and `@prisma/adapter-pg`.
  - (b) Stay on Prisma 6. Rejected: DB-01 already pins 7.10.0, and moving after BE code exists would mean rewriting every client construction.
  - (c) Prisma 7 with the legacy `prisma-client-js`. Rejected: it is deprecated, and Prisma says it will be removed.
- **Node.**
  - **Chosen:** 24.
  - 22: maintenance-only since 2025-10-21, end of life 2027-04-30.
  - 26: LTS from 2026-10-28, but corepack is not bundled from Node 25 on, so CI would need a separate pnpm install step.
- **TypeScript.**
  - **Chosen:** ~6.0.
  - 7.0: no JavaScript API, so no typescript-eslint, which the `no-explicit-any` rule needs.

## 4. Decisions

### 4.1 Datasource URL (D-31)

- `prisma/schema.prisma` has `datasource db { provider = "postgresql" }` and no `url`. Prisma 7 rejects `url`, `directUrl` and `shadowDatabaseUrl` in the schema file.
- The CLI URL lives only in root `prisma.config.ts`. It is `MIGRATION_DATABASE_URL`, the owner role (ADR 0006). The fallback `''` keeps `validate`, `format` and `generate` working without a database.
  - Prisma accepts an empty string as a URL: its config check only tests `typeof url === "string"`. So the guard in 4.4 rejects an empty URL.
- The runtime client never reads `prisma.config.ts`. It connects as `app_user` through `DATABASE_URL` and the driver adapter (4.2).
- In staging, pilot and production, only the deploy job holds `MIGRATION_DATABASE_URL`. The API process does not.
- Prisma 7 does not load `.env`. `prisma.config.ts` loads it with `process.loadEnvFile`, and values already set in the shell win.

### 4.2 Generator and runtime client (architect detail)

```prisma
generator client {
  provider     = "prisma-client"
  output       = "../apps/api/src/generated/prisma"
  moduleFormat = "cjs"
}
```

- **Output.** `apps/api` is the only TypeScript runtime that uses the database; the worker is Python. The generated client is plain TypeScript, compiled by `apps/api`. It is git-ignored and excluded from ESLint and Prettier.
- **Module format.** `cjs` because `apps/api` compiles to CommonJS today (NodeNext with no `"type": "module"`), which is NestJS's default. If BE-01 moves `apps/api` to ESM, it changes `moduleFormat` in the same PR. That needs no ADR.
- **Other generator fields.** `importFileExtension` and `generatedFileExtension` keep their defaults. If DB-04 (tsx) or DB-05 (the Nest build) cannot resolve the generated imports, change only those fields and say so in the PR.
- **Client construction.** In one factory, `apps/api/src/database/create-prisma-client.ts`: `new PrismaClient({ adapter: new PrismaPg({ connectionString }) })`. Nothing else calls `new PrismaClient`.

**What each task must do:**
- **DB-02:**
  - writes the generator block above;
  - adds `@prisma/client` and `@prisma/adapter-pg` (both the CLI's exact version) and `pg` to `apps/api`;
  - adds the factory;
  - adds the root script `db:generate` (`prisma generate`, which needs no database);
  - adds a CI step `pnpm db:generate` after install;
  - adds `apps/api/src/generated/` to `.gitignore`, the ESLint ignores and `.prettierignore`.
- **DB-04:** the seed builds its client with the factory. Prisma 7 no longer seeds on `migrate dev` or `migrate reset`; `pnpm db:seed` is always explicit.
- **DB-05:**
  - PrismaService wraps the factory with `DATABASE_URL`.
  - The org filter is a `$extends` query extension, because Prisma 7 removed `$use` middleware.
  - A smoke test proves the client loads under the Nest build.
- **BE-01:**
  - The zod config requires `DATABASE_URL` and never reads `MIGRATION_DATABASE_URL`.
  - The pool size is set on the adapter and tuned in BE-15B (NFR-01, NFR-02).
- **DB-08:**
  - Each Testcontainers run uses a fresh `postgres:16` container.
  - Migrations are applied with `prisma migrate deploy`, pointing `MIGRATION_DATABASE_URL` at the container. Never use `migrate reset` or `db push`.
  - Give `app_user` a random password generated during the run, then assert its grants with a client connected as `app_user`.
  - Docker is available on GitHub's Ubuntu runners.

### 4.3 CLI changes DB-02..DB-04 rely on

| Use | Prisma 7.10 command |
| --- | --- |
| Validate and format (no database needed) | `pnpm prisma validate`, `pnpm prisma format` |
| Generate the client (no database needed) | `pnpm db:generate`. It is never automatic: `migrate dev` and `migrate reset` no longer run it. |
| Schema to SQL, for the DB-02 check | `pnpm prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script -o <scratch>/init.sql`. `--to-schema-datamodel`, `--from-url`, `--to-url` and `--shadow-database-url` were removed. |
| Create a migration without applying it | `pnpm db:migrate --create-only --name <name>` |
| Apply in development | `pnpm db:migrate`. It uses a temporary shadow database and needs CREATEDB. On drift it stops and suggests `migrate reset`; it never resets by itself. |
| Apply in staging, pilot and production | `prisma migrate deploy`. It needs no shadow database and has no AI-agent check. |
| Seed | `pnpm db:seed` runs `migrations.seed` from `prisma.config.ts` (`tsx prisma/seed.ts`), and only when called. |
| Never used in this repo | `prisma db push` (any flag), and `prisma migrate reset` outside `infra/scripts/db-reset` |

### 4.4 Guards and the AI-agent consent check (D-31, review S4)

**How Prisma's check works.** Read in the Prisma 7.10.0 CLI source on 2026-10-02.
- **Commands covered:** `migrate reset` (with or without `--force`), `db push --force-reset` and `db push --accept-data-loss`. Not covered: `migrate dev`, `migrate deploy`, `db seed` and `db execute`.
- **Detection:**
  - Any of these environment variables: `CLAUDECODE`, `CODEX_THREAD_ID`, `CODEX_CI`, `CODEX_SANDBOX`, `CODEX_SANDBOX_NETWORK_DISABLED`, `GEMINI_CLI`, `QWEN_CODE`, `CURSOR_AGENT`, `COPILOT_CLI`, `OPENCODE`, `OPENCODE_CLIENT`, `CLINE_ACTIVE`, `CRUSH`, `AUGMENT_AGENT`, `ANTIGRAVITY_AGENT`, or `AI_AGENT` with any value.
  - `AGENT` set to `goose`, `amp` or any other value.
  - `OR_APP_NAME=Aider`, or `REPLIT_SESSION` starting with `agent-`.
  - The file `/opt/.devin`.
- **What it does when it detects an agent:** it refuses unless `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION` is set.
  - The CLI only tests that the variable is non-empty. It cannot tell who wrote the value.
  - Prisma's instruction to the agent: stop, explain the command and that it destroys all data, and ask the user. Rerun only with the variable set to "the exact text of the user's message in which they consented". Earlier messages never count. If no user can be reached, abort.
- **Re-check the list on every Prisma upgrade.** It changes between versions.

**Rules (D-31).**
1. The check stays on. No script, config, alias or environment file may pre-fill the consent variable or work around it.
2. The consent variable is set only inside `infra/scripts/db-reset` (the `db:reset` script), only after the S4 localhost guard passes, and only for the one `prisma migrate reset` command, as an inline assignment on that line.
3. Never set it globally:
   - not exported, and not in a shell profile;
   - not in `.env` or `.env.example`;
   - not in compose files, CI workflows or deploy jobs;
   - never for staging, pilot or production databases.
4. **The consent value must come from a human, typed at a terminal. An agent must not generate, guess, reuse or relay it. So no agent can run `pnpm db:reset`.** An agent that needs a reset stops and asks the human to run `pnpm db:reset` in their own terminal.

**Mechanism (architect detail).** The human types a fixed confirmation. That typed text is the user's consent message, so it is the value Prisma asks for. The db-engineer implements `infra/scripts/db-reset` with this text:

```sh
#!/bin/sh
# pnpm db:reset: drop and rebuild the LOCAL database (ADR 0009 section 4.4; D-31; review S4).
# Prisma's AI-agent check stays on. Its consent variable is set here only, for one command,
# from a confirmation that a human types at a terminal. Never set it anywhere else.
set -eu
cd "$(dirname "$0")/../.."
unset PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION

if [ -n "${CI:-}" ]; then
  echo "db:reset never runs in CI." >&2
  exit 1
fi

# 1. Localhost guard (S4): exits non-zero unless every database URL points at this machine.
node infra/scripts/assert-local-db.mjs

# 2. A human must type the confirmation. Agents and CI have no terminal, so they stop here.
if [ ! -t 0 ]; then
  echo "db:reset needs a human at a terminal. AI agents: stop and ask the user to run 'pnpm db:reset' in their own terminal." >&2
  exit 1
fi
echo "This deletes all data in the LOCAL database and re-applies every migration." >&2
printf '%s' "Type 'reset local database' to continue: " >&2
IFS= read -r answer
if [ "$answer" != "reset local database" ]; then
  echo "Reset cancelled." >&2
  exit 1
fi

# 3. The human's typed text is the consent value, for this one command only.
PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION="$answer" pnpm exec prisma migrate reset --force

# 4. From DB-03: give app_user its local password again (idempotent; ADR 0006 section 7.4).
# node infra/scripts/set-app-user-password.mjs
```

**`infra/scripts/assert-local-db.mjs` (S4 guard; written in Node so it reads `.env` exactly as `prisma.config.ts` does).**
- Load `.env` with `process.loadEnvFile`; values already in the shell win.
- `MIGRATION_DATABASE_URL` must be non-empty. Its hostname, from `new URL()`, must be `localhost`, `127.0.0.1` or `::1`.
- Apply the same check to `DATABASE_URL` when it is set.
- Reject any `host` or `hostaddr` query parameter, because libpq and `pg` let that parameter override the host.
- Refuse if `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION` is set in the environment or defined in `.env` (rule 3).
- On failure, print only the offending hostname, never the URL. Exit 1.

**Root scripts.**
- `db:migrate`: `node infra/scripts/assert-local-db.mjs && prisma migrate dev`. Extra arguments reach Prisma. From DB-03 it is a wrapper that also sets the local `app_user` password.
- `db:seed`: `node infra/scripts/assert-local-db.mjs && prisma db seed`.
- `db:reset`: `sh infra/scripts/db-reset`.
- A deploy-only `db:deploy` (`prisma migrate deploy`) is added by DEP-01. It is not localhost-guarded, because it is not destructive.

**Defence in depth.**
- `prisma.config.ts` throws if `.env` defines the consent variable. Otherwise loading `.env` would hand it to a direct `prisma migrate reset`.
- CI fails if the variable's name appears in a tracked file other than `docs/`, `infra/scripts/db-reset`, `infra/scripts/assert-local-db.mjs`, `prisma.config.ts` and the CI step itself.

**Trade-off.**
- A human must be at the keyboard for every reset.
- Agents verify migrations without resets:
  - `pnpm db:migrate` on the existing local volume;
  - `prisma migrate deploy` into a throwaway container;
  - Testcontainers in DB-08.
- Rejected alternative (owner may choose it, see open questions): the agent relays the human's chat consent through a script-only variable. That follows Prisma's documented flow, but the text passes through the agent, so the script cannot tell real consent from invented text.

### 4.5 Node 24 changes

- `.nvmrc` becomes `24`. CI follows it through `setup-node` `node-version-file`, so the workflow file itself does not change.
- `engines.node` becomes `>=24 <25`, and `@types/node` becomes `^24`. Regenerate the lockfile.
- `corepack enable` still works: corepack is bundled with Node 24.
- **Moving to Node 26 or later** needs a new ADR. That move must also install corepack or pnpm separately in CI and locally.
- Prisma 7.10.0 supports Node `^20.19 || ^22.12 || >=24.0`.

## 5. Verification (checked 2026-10-02)

| # | Fact | Status | Source |
| --- | --- | --- | --- |
| P1 | `prisma-client-js` is deprecated; use `prisma-client`, whose `output` is required | Verified | [Generators v7](https://www.prisma.io/docs/orm/v7/prisma-schema/overview/generators); [Upgrade to v7](https://www.prisma.io/docs/guides/upgrade-prisma-orm/v7); 7.10.0 CLI labels it "Legacy" |
| P2 | `PrismaClient` requires a driver adapter; PostgreSQL uses `@prisma/adapter-pg` (`new PrismaPg({ connectionString })`); adapter-pg 7.10.0 depends on `pg` ^8.16.3 | Verified | [Upgrade to v7](https://www.prisma.io/docs/guides/upgrade-prisma-orm/v7); [PostgreSQL connector](https://www.prisma.io/docs/orm/overview/databases/postgresql); [npm registry](https://registry.npmjs.org/@prisma/adapter-pg/7.10.0) |
| P3 | `url` is rejected in `schema.prisma`; URLs live in `prisma.config.ts`; `.env` is not loaded automatically | Verified | Upgrade guide; schema-engine error text in 7.10.0; [Config reference](https://www.prisma.io/docs/orm/reference/prisma-config-reference) |
| P4 | `--to-schema-datamodel` was removed ("use `--[from/to]-schema`"), as were `--from-url`, `--to-url` and `--shadow-database-url`; `-o/--output` exists | Verified | [CLI reference v7](https://www.prisma.io/docs/orm/v7/reference/prisma-cli-reference); 7.10.0 source |
| P5 | `migrate dev` runs neither generate nor seed; `migrate reset` does not seed | Verified | CLI reference; [migrate reset](https://www.prisma.io/docs/cli/v7/migrate/reset) |
| P6 | `migrate reset` does not run generate; `migrate dev` on drift exits and suggests `migrate reset` | Verified in source only | 7.10.0 `build/cli.js` |
| P7 | Seed command is `migrations.seed` in `prisma.config.ts`, run only by `prisma db seed` | Verified | Config reference |
| P8 | AI-agent check: commands, detection list, variable `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION`, value = the user's exact consent message, presence-only test | Verified | 7.10.0 `build/cli.js`; CLI reference; migrate reset page |
| P9 | The check was added in Prisma 6.15.0 | Partly verified (issue, not release notes) | [prisma/prisma#28196](https://github.com/prisma/prisma/issues/28196) |
| P10 | `validate` and `format` need no database URL; `generate` does not either | Verified (generate: in substance) | CLI reference; config reference (`env()` note) |
| P11 | `migrate dev` needs CREATEDB (or superuser) for its temporary shadow database; `migrate deploy` uses none | Verified | [Shadow database](https://www.prisma.io/docs/orm/prisma-migrate/understanding-prisma-migrate/shadow-database) |
| P12 | `migrate reset` drops and recreates the schema, which loses PUBLIC's default USAGE on `public` | **Not verified** from docs; schema-engine strings in 7.10.0 show `DROP SCHEMA "…" CASCADE` and `CREATE SCHEMA`. ADR 0006 section 7 grants USAGE explicitly either way. | 7.10.0 `schema_engine_bg.wasm` |
| P13 | Client middleware (`$use`) removed; use `$extends` | Verified | Upgrade guide |
| P14 | `moduleFormat = "cjs"` is supported by `prisma-client` | Verified. **Not verified:** the generated client running under the NestJS build on Node 24; DB-05 smoke test | Generators v7 |
| P15 | Prisma 7.10.0 requires Node `^20.19 \|\| ^22.12 \|\| >=24.0` and TypeScript >= 5.4 | Verified | installed `prisma/package.json` |
| P16 | `process.loadEnvFile` does not override variables already set in the shell | Verified locally on Node 22.23.3; recheck on 24 | local test |
| N1 | Node 24 "Krypton": LTS 2025-10-28, maintenance from 2026-10-20, end of life 2028-04-30; latest v24.21.0 | Verified | [nodejs/Release schedule](https://github.com/nodejs/Release/blob/main/schedule.json); [Previous releases](https://nodejs.org/en/about/previous-releases) |
| N2 | Corepack is bundled with Node 24 (experimental) and not distributed from Node 25 | Verified | [Node 24 corepack docs](https://nodejs.org/docs/latest-v24.x/api/corepack.html) |
| N3 | Node 26 LTS from 2026-10-28; Node 22 end of life 2027-04-30 | Verified | nodejs/Release schedule |
| N4 | pnpm 12.8.1 runs on Node >= 18 | Verified | pnpm `package.json` in the local corepack cache |
| T1 | typescript-eslint supports TypeScript `>=4.8.4 <6.1.0` and Node `^18.18.0 \|\| ^20.9.0 \|\| >=21.1.0` | Verified | [typescript-eslint dependency versions](https://typescript-eslint.io/users/dependency-versions/); installed 8.71.0 `peerDependencies` |
| T2 | TypeScript 7.0 (2026-07-08) "does not ship with an API"; 7.1 is expected to add a new one; 6.0 can run side by side | Verified | [Announcing TypeScript 7.0](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/) |
| O1 | PostgreSQL 16 supported until 2028-11-09 (16.15 current) | Verified | [PostgreSQL versioning](https://www.postgresql.org/support/versioning/) |
| O2 | Python 3.12 is security-only, end of life 2028-10 | Verified | [Python versions](https://devguide.python.org/versions/) |

## 6. Consequences and affected agents

- **Positive.**
  - One supported toolchain.
  - Destructive database commands cannot reach a non-local host through our scripts.
  - Prisma's agent check is kept and backed by our own guard.
- **Negative.**
  - Agents cannot reset a database. A human runs `pnpm db:reset`.
  - Node 24 enters maintenance in 18 days.
  - TypeScript 7 waits for typescript-eslint.
- **db-engineer.**
  - DB-01 now: Node 24 pins, the S4 guard, the `db-reset` script, the `prisma.config.ts` consent check and the CI grep. Checklist in the hand-off.
  - DB-02: 4.2 and 4.3.
  - DB-03: ADR 0006 section 7 and the brief.
  - DB-04, DB-05 and DB-08: 4.2.
- **backend-engineer.**
  - BE-01: 4.1 and 4.2.
  - DEP-01, DEP-03 and production: `migrate deploy` only. `MIGRATION_DATABASE_URL` lives only in the deploy job. `app_user` password per ADR 0006 section 7.4.
- **code-reviewer.** Reject any of these:
  - `db push`;
  - `prisma-client-js`;
  - a second `new PrismaClient`;
  - the consent variable outside `infra/scripts/db-reset`;
  - `MIGRATION_DATABASE_URL` in API code.
- **All agents.** Never run `pnpm db:reset`, `prisma migrate reset` or `db push`. Ask the human.
