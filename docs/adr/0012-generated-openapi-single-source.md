# ADR 0012: The API's generated OpenAPI is the single source of truth

| Field | Value |
| --- | --- |
| Status | Accepted 2026-10-05 (C-21, D-49). PR #36 (frontend) was allowed to merge ahead of the first sync PR under C-21, then moves in that sync PR. |
| Author | architecture hub |
| Serves | NFR-04; ARC-02 part 2; FE-01 |
| Builds on | ADR 0001 C-8, C-9; ADR 0011 |
| Affects | backend-engineer, frontend-engineer, qa-engineer, architecture hub (CI) |

## Context

The frontend keeps a hand-written `apps/web/openapi/openapi.yaml` (paths under `/v1`, covering routes the backend has not built) and MSW mocks written against it. The backend already generates OpenAPI with `@nestjs/swagger` (prefix `/api/v1`, matching fsd.md §4) but only serves it when `ENABLE_API_DOCS` is on, and nothing in the repo keeps it. The two have started to drift (paths, error shape, 2FA routes).

## Decision (owner's plan)

1. The NestJS-generated OpenAPI is the only source of truth for routes it covers.
2. CI exports it to `apps/api/openapi/openapi.json` and fails the build if the committed file is out of date.
3. The frontend generates its types and builds its MSW mocks from that file.

The path prefix is `/api/v1` (the backend's `API_PREFIX`). Errors are RFC 7807 with the extension member `code` (api-contract.md).

## Design

**Export (backend).**
- `pnpm --filter @codeproctor/api openapi:export` builds the Nest module graph without opening a database or Redis connection (`NestFactory.create(..., { preview: true })` or a test module with stubbed infrastructure; backend verifies which works) and writes the document regardless of `ENABLE_API_DOCS`. The runtime flag stays off in pilot and production.
- Output is deterministic: sorted keys, no timestamps, no host-specific `servers` entry, 2-space JSON.
- `openapi:check` regenerates to a temp file and diffs it against the committed file.
- A test fails when any operation has no documented 2xx response type, no declared error response using the problem schema, or neither a security requirement nor an explicit public marker. This is what keeps the generated client types useful instead of `unknown`.
- DTOs use the `@nestjs/swagger` CLI plugin where possible, so the spec follows the class-validator DTOs.

**CI (hub-owned, `.github/workflows/ci.yml`).** One job `openapi-drift` in `ci.yml`: install, run `openapi:check`, fail with "run `pnpm --filter @codeproctor/api openapi:export` and commit the result". CI config goes through the hub (CLAUDE.md rule 12), so the hub adds the job. The export and the check use fixed dummy environment values and no GitHub secrets. The job runs on `pull_request` (never `pull_request_target`), with a read-only token and no access to repository secrets, so a pull request cannot read a secret through the build it controls; later edits to the job must keep these three properties.

**Frontend, gradual and isolated.** The backend has built only auth and health. The web app also needs admin and candidate routes that do not exist yet, so the placeholder cannot be dropped in one step.
- `apps/web/openapi/pending.yaml` keeps the placeholder routes the backend has not built, renamed to `/api/v1`.
- `apps/web/openapi/adopted-routes.txt` lists the route groups the frontend has switched to the generated spec.
- A merge script builds the spec the types come from: generated spec for adopted routes, `pending.yaml` for the rest. CI fails if an adopted path is missing from the generated file, or if a path is both adopted and in `pending.yaml`. A non-failing report lists pending routes the backend now implements.
- Because adoption is the frontend's own change, a backend PR never breaks the web typecheck; the frontend adopts each group when it is ready.
- MSW handlers are typed from the generated `paths` types, so a changed response shape is a compile error. `openapi-msw` (MIT) is the candidate helper; the frontend checks it against the installed MSW version and falls back to handlers typed by hand from `schema.d.ts` if it does not fit. A test fails if an adopted operation the web calls has no mock handler.

## Steps and timing

| # | Who | What | When |
| --- | --- | --- | --- |
| 0 | hub | This ADR; prefix and error `code` decided in api-contract.md | now |
| 1 | backend | `openapi:export`, `openapi:check`, completeness test, problem schema with `code`, bearer scheme; commit the first `openapi.json` | one PR, straight after PR #26 merges, so the 2FA re-auth shapes land in the first export |
| 2 | hub | `openapi-drift` job in `ci.yml` | same day as step 1 merges, one small PR |
| 3 | frontend | Contract sync PR 1: adopt the auth group (login, 2FA, refresh, logout, password, health), rename `/v1` to `/api/v1`, handle problem `code`, typed MSW for those routes | after steps 1 and 2 merge |
| 4 | frontend | Security page (2FA management with re-auth, ADR 0011) built on the adopted auth types | after step 3 |
| 5 | frontend | Adopt each further group (admin users, settings, consent, candidates, candidate session) when its backend step merges | one small PR per group, in the backend's order |
| 6 | all | Each backend PR that changes a route commits the regenerated `openapi.json`; the PR description names the web areas affected | ongoing |

Until a group is adopted its routes stay in `pending.yaml`, where the frontend keeps working against mocks as today.

## Options considered

1. **Generated spec as source of truth, CI-checked (chosen).** Drift becomes a failing build.
2. **Hand-written spec as the contract, backend conforms.** Keeps the frontend unblocked, but the backend would then have to be checked against it, and the two have already drifted.
3. **Shared zod schemas generate the spec for both.** Rejected: the backend uses class-validator DTOs (CLAUDE.md allows either), so it would be a rewrite, and packages/shared already carries only cross-service types.
4. **One-step switch.** Rejected: the generated spec lacks most routes the web needs.

## Consequences

- The generated file is committed, so diffs show API changes in review.
- A route group is only usable by the frontend through generated types once the backend has merged it; before that it stays a typed placeholder.
- `docs/api-contract.md` keeps only what OpenAPI cannot say (rules, error `code` values, re-auth behaviour); route and field lists move to the spec as each group is adopted.
- If the export cannot run without infrastructure, backend reports it and the hub decides between a test module and preview mode.
