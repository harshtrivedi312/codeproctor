# ADR 0009: Toolchain: Prisma 7, Node 24 LTS, TypeScript 6.0

| Field | Value |
| --- | --- |
| Status | **Accepted** 2026-10-02 (D-31, D-32). Details marked "architect detail" are chosen by the architect, for the owner to confirm. **Amended 2026-10-02 (D-37, D-38, D-39; DB-01 second review):** section 4.4 now describes a policy backed by speed bumps, with the final script texts, the credentials rule and the accepted risks. |
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

### 4.4 Guards and the AI-agent consent check (D-31, D-37, D-38, D-39; review S4, SF2, SF5, SF6, SF7)

**Policy, backed by speed bumps (D-38).**
- **What agents never run:** `pnpm db:reset`, `pnpm dev:infra:reset`, `prisma migrate reset` or `prisma db push`.
  - An agent that needs one of these stops and asks the human to run it in their own terminal.
  - CLAUDE.md and the db-engineer definition (D-36) say the same.
- **Where shared credentials live:** staging and pilot database credentials never exist on developer machines or in agent sessions. They live only in GitHub Actions secrets and on the servers (D-38, CLAUDE.md).
  - This rule is what protects the shared databases: a local command cannot reach a database whose credentials are not on the machine.
- **What the scripts are:** speed bumps.
  - They stop honest mistakes, and they make any breach of the policy deliberate and visible.
  - They are not a security boundary against a determined person or agent. The risks they leave are accepted at the end of this section.
- **Time-box (D-39):** the reset guard is complete as of the second DB-01 review (PR #3). It changes only if the code-reviewer finds a blocker.

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
4. **The consent value comes from a human, typed at a terminal. An agent must not generate, guess, reuse or relay it.**
   - Agents do not run `pnpm db:reset`. That is the policy.
   - The script refuses the agent sessions it can detect, and any session without a terminal. Those refusals are the speed bumps.

**`infra/scripts/db-reset` (final text, PR #3).** The human types a fixed confirmation. That typed text is the user's consent message, so it is the value Prisma asks for.

```sh
#!/bin/sh
# pnpm db:reset: drop and rebuild the LOCAL database (ADR 0009 section 4.4; D-31, D-37; review S4).
# Prisma's AI-agent check stays on. Its consent variable is set here only, for one command,
# from a confirmation that a human types at a terminal. Never set it anywhere else.
set -eu
cd "$(dirname "$0")/../.."
unset PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION

if [ -n "${CI:-}" ]; then
  echo "db:reset never runs in CI." >&2
  exit 1
fi

# AI agents never reset a database (D-37). Refuse when any variable that Prisma uses to detect
# an agent is set. Keep this list in step with ADR 0009 section 4.4.
agent_marker=""
for name in CLAUDECODE CODEX_THREAD_ID CODEX_CI CODEX_SANDBOX CODEX_SANDBOX_NETWORK_DISABLED \
  GEMINI_CLI QWEN_CODE CURSOR_AGENT COPILOT_CLI OPENCODE OPENCODE_CLIENT CLINE_ACTIVE CRUSH \
  AUGMENT_AGENT ANTIGRAVITY_AGENT AI_AGENT AGENT; do
  if printenv "$name" >/dev/null 2>&1; then
    agent_marker=$name
    break
  fi
done
if [ "${OR_APP_NAME:-}" = "Aider" ]; then
  agent_marker=OR_APP_NAME
fi
case "${REPLIT_SESSION:-}" in
  agent-*) agent_marker=REPLIT_SESSION ;;
esac
if [ -n "$agent_marker" ]; then
  echo "db:reset never runs inside an AI agent ($agent_marker is set). AI agents: stop and ask the user to run 'pnpm db:reset' in their own terminal." >&2
  exit 1
fi

# 1. Localhost guard (S4, D-37): exits non-zero unless every database URL points at this machine
#    and uses the host port that Docker Compose publishes for the local postgres service.
node infra/scripts/assert-local-db.mjs --compose-port

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

**Order of checks in `db-reset`:**
1. Refuse if `CI` is set.
2. Refuse if an agent marker is set (D-37), and name the variable. The markers:
   - any of `CLAUDECODE`, `CODEX_THREAD_ID`, `CODEX_CI`, `CODEX_SANDBOX`, `CODEX_SANDBOX_NETWORK_DISABLED`, `GEMINI_CLI`, `QWEN_CODE`, `CURSOR_AGENT`, `COPILOT_CLI`, `OPENCODE`, `OPENCODE_CLIENT`, `CLINE_ACTIVE`, `CRUSH`, `AUGMENT_AGENT`, `ANTIGRAVITY_AGENT`, `AI_AGENT` or `AGENT`, set to any value;
   - `OR_APP_NAME=Aider`;
   - `REPLIT_SESSION` starting with `agent-`.

   These are Prisma's environment markers. Prisma's `/opt/.devin` file check is not repeated here; Prisma still applies it. Keep the list in step with Prisma on every upgrade.
3. Run the localhost guard with `--compose-port` (below).
4. Refuse if stdin is not a terminal.
5. Require the exact phrase `reset local database`.
6. Run `prisma migrate reset --force`, with the consent value inline for that one command.

Arguments given to `pnpm db:reset` are ignored, so `--config` cannot reach Prisma. The script's comment "Agents and CI have no terminal" describes the usual case only; see the accepted risks below.

**The localhost guard: `infra/scripts/local-db-guard.mjs` and `infra/scripts/assert-local-db.mjs`.**
- **`local-db-guard.mjs`** holds the checks as pure functions (`findProblems`, `findPortProblems`, `parseComposePort`, `readComposePort`) and the constants `CONSENT_VAR` and `LIBPQ_REDIRECT_VARS`. It is the only script file that names the consent variable.
- **`assert-local-db.mjs`** runs the checks every time it starts. There is no "run only when executed directly" test that could skip them.
  - It refuses unknown arguments.
  - `--compose-port` adds the port check.
  - `db:migrate` and `db:seed` run it without the flag; `db:reset` runs it with the flag.
  - It loads the repository-root `.env` the way `prisma.config.ts` does: values already in the shell win.
- **It refuses when:**
  - the consent variable is set in the environment, or defined in `.env` (rule 3);
  - `PGHOSTADDR`, `PGSERVICE` or `PGSERVICEFILE` is set, even to an empty value (SF6), because libpq can use them to connect somewhere other than the URL's host. `PGHOST` is allowed, because every URL names its own host;
  - `MIGRATION_DATABASE_URL` is missing or empty, is not a URL, or is not `postgres://` or `postgresql://`;
  - its host is not `localhost`, `127.0.0.1` or `[::1]`;
  - it has a `host`, `hostaddr` or `service` query parameter, in any letter case or percent-encoded. `DATABASE_URL` gets the same checks whenever it is set;
  - with `--compose-port` (D-37): either URL's port differs from the port reported by `docker compose -f infra/docker-compose.yml port postgres 5432`, or Compose reports no port. A URL with no port counts as 5432.
- Messages name only hosts and variables, never a URL or a credential.

**`infra/scripts/dev-infra-reset` (`pnpm dev:infra:reset`; review N14, SF5).** It stops the local stack and deletes its volumes, including the roles in that Postgres cluster. Order of checks:
1. Refuse if `CI` is set.
2. Refuse a Docker engine that could be remote:
   - `DOCKER_HOST` must be unset or a `unix://` socket;
   - the current Docker context's endpoint must be a `unix://` socket;
   - a failed context lookup counts as remote.
3. Refuse if stdin is not a terminal.
4. Require the exact phrase `delete local volumes`.
5. Run `docker compose --env-file .env -f infra/docker-compose.yml down --volumes`, on the local Compose project `codeproctor`.

It does not check agent markers; the policy covers it. Staging and pilot run Compose under their own project names (`codeproctor-staging` and `codeproctor-pilot`; DEP-01, DEP-03), so the local project name never matches their volumes, even on their own hosts.

**Root scripts.**
- `dev:infra:reset`: `sh infra/scripts/dev-infra-reset`.
- `db:migrate`: `node infra/scripts/assert-local-db.mjs && prisma migrate dev`.
  - From DB-03 it becomes `sh infra/scripts/db-migrate`, which also sets the local `app_user` password.
  - The wrapper refuses `--config` and `--url` arguments. Prisma 7.10.0 `migrate dev` accepts both (section 5, P17), and either could point Prisma away from the URLs the guard checked.
- `db:seed`: `node infra/scripts/assert-local-db.mjs && prisma db seed`.
- `db:reset`: `sh infra/scripts/db-reset`.
- `db:deploy` (`prisma migrate deploy`) is added by DEP-01. It is not localhost-guarded: it is not destructive, and it runs only in the deploy job, where the credentials live (D-38).

**Defence in depth.**
- `prisma.config.ts` throws if `.env` defines the consent variable. Otherwise loading `.env` would hand it to a direct `prisma migrate reset`.
- **CI consent check.** It fails if the variable's name appears in any tracked file outside these four: `docs/`, `infra/scripts/db-reset`, `infra/scripts/local-db-guard.mjs` and `prisma.config.ts`.
  - The workflow builds the name from two pieces, so the workflow file does not contain it.
  - It checks `git grep`'s exit status explicitly: 1 passes, 0 fails, anything else is an error.
- **Other CI steps:** `pnpm exec prisma version` loads `prisma.config.ts`, and `shellcheck` checks `db-reset` and `dev-infra-reset`.

**How agents verify the guards (SF2).**
- Agents verify the refusal paths only through `pnpm test`.
- The tests in `infra/scripts/*.test.mjs` start each script with an explicit environment, with stand-in `docker` and `pnpm` commands on `PATH`. Nothing reaches a reset, and every case asserts that no stand-in was asked to do anything destructive.
- Agents never run `pnpm db:reset` or `pnpm dev:infra:reset` themselves, not even to watch a refusal.
- The owner's one-time interactive `pnpm db:reset` in DB-03 is a human step.

**Accepted risks (D-38).** The owner accepts these. Under the D-39 time-box, the guard changes only for a code-reviewer blocker.
- **Agents with a terminal.** An agent running in an interactive terminal (a tmux or screen pane, `script(1)`, an IDE terminal) has a terminal on stdin. If it also lacks the marker variables (an agent not on the list, or one that unsets them), only the typed phrase remains, and an agent can type it. The policy, and D-38, cover this case.
- **Local tunnels.** A tunnel on this machine, such as `ssh -L` or a cloud SQL proxy, can make a remote database look local.
  - **What narrows it:** the Compose-port check. The URL must use the exact port Compose publishes for the local Postgres. While the stack runs, that container already holds the port on `127.0.0.1`, so a tunnel cannot bind the same address and port.
  - **What remains:** a tunnel on another loopback address with that port, such as `[::1]:5432`, reached through a `localhost` or `[::1]` URL. That is why the examples use `127.0.0.1`.
  - D-38 keeps shared credentials off the machine, so such a tunnel has nothing to log in with.
- **Extra arguments before DB-03.** Until the DB-03 wrapper exists, `pnpm db:migrate --url …` or `--config …` reaches `prisma migrate dev`, and the guard has checked only the environment. `pnpm db:seed --config …` is similar. `migrate dev` never resets (it stops on drift), and D-38 applies. The DB-03 wrapper closes the `db:migrate` case.
- **Direct Prisma commands.** Running `prisma migrate reset` or `db push --force-reset` directly bypasses these scripts. Only Prisma's own agent check remains, and a human can still run them. The policy is never to use them outside `db-reset`.
- **Prisma's detection list.** It can change in a new Prisma version. Until `db-reset` is updated, a newly detected agent is caught only by Prisma's own check.
- **`dev-infra-reset` and agents.** It has no agent-marker check. It refuses only on CI, a non-local Docker engine, a missing terminal or a wrong phrase.

**Trade-off.**
- A human must be at the keyboard for every reset.
- Agents verify migrations without resets:
  - `pnpm db:migrate` on the existing local volume;
  - `prisma migrate deploy` into a throwaway container;
  - Testcontainers in DB-08.
- Rejected alternative: the agent relays the human's chat consent through a script-only variable. That follows Prisma's documented flow, but the text passes through the agent, so the script cannot tell real consent from invented text.

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
| P16 | `process.loadEnvFile` does not override variables already set in the shell | Verified on Node 22.23.3 (architect) and Node 24.21.0 (db-engineer, DB-01 second review) | local tests |
| P17 | `migrate dev` accepts `--url` and `--config`; `migrate reset` accepts `--config` but not `--url`. The CLI reference does not list `--url` for `migrate dev`. | Verified in source only | 7.10.0 `build/cli.js` |
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
  - Our reset scripts refuse what they can detect: non-local database URLs, ports other than the local Compose Postgres, remote Docker engines, and agent sessions. With D-38 keeping shared credentials off local machines, an accidental reset of a shared database needs several mistakes at once. This is a policy with speed bumps, not a security boundary (section 4.4).
  - Prisma's agent check is kept and backed by our own guard.
- **Negative.**
  - Agents do not reset databases (policy). A human runs `pnpm db:reset` and `pnpm dev:infra:reset`.
  - The risks listed in section 4.4 are accepted.
  - Node 24 enters maintenance in 18 days.
  - TypeScript 7 waits for typescript-eslint.
- **db-engineer.**
  - DB-01 (PRs #2 and #3) covers:
    - the Node 24 pins;
    - the guard, `db-reset` and `dev-infra-reset`;
    - the `prisma.config.ts` consent check;
    - the CI checks and the `pnpm test` refusal-path tests.
  - The guard is complete after PR #3 (D-39).
  - DB-02: 4.2 and 4.3.
  - DB-03: ADR 0006 section 7 and the brief.
  - DB-04, DB-05 and DB-08: 4.2.
- **backend-engineer.**
  - BE-01: 4.1 and 4.2.
  - DEP-01, DEP-03 and production:
    - `migrate deploy` only;
    - `MIGRATION_DATABASE_URL` lives only in the deploy job;
    - staging and pilot database credentials live only in GitHub Actions secrets and on the servers (D-38);
    - their own Compose project names, `codeproctor-staging` and `codeproctor-pilot`;
    - the `app_user` password per ADR 0006 section 7.4.
- **code-reviewer.** Reject any of these:
  - `db push`;
  - `prisma-client-js`;
  - a second `new PrismaClient`;
  - *setting* the consent variable anywhere except `infra/scripts/db-reset`;
  - `MIGRATION_DATABASE_URL` in API code;
  - staging or pilot credentials in any file, log or local environment (D-38).
- **All agents.**
  - Never run `pnpm db:reset`, `pnpm dev:infra:reset`, `prisma migrate reset` or `db push`. Ask the human.
  - Verify refusal paths only with `pnpm test`.
  - Never hold staging or pilot database credentials (D-38).
