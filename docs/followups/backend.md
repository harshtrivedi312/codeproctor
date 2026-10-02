# Follow-ups: Backend track

Should-fix items and nits from Backend-track work. Same columns as `docs/followups/database.md`.

## Items

| ID | Source | Type | Item | Owner | Target | Status |
| --- | --- | --- | --- | --- | --- | --- |
| FU-BE-01 | BE-01 | should-fix | Throttler uses the default in-memory store, so limits are per instance. Switch to a Redis-backed storage before running more than one API instance. | backend | BE-13 or deploy | open |
| FU-BE-02 | BE-01 | should-fix | Jest only exits with `--forceExit` (the test script sets it); something keeps a handle open after Testcontainers and the app close (`--detectOpenHandles` reports none). Find the leak. | backend | any | open |
| FU-BE-03 | BE-01 | should-fix | FU-DB-06 (BigInt and Decimal JSON serialization) is not done in BE-01: no route returns those types yet. The first step that does must add the serializer and the string-or-number contract decision from ARC-02. | architecture hub, backend | BE-02 or first affected route | open |
| FU-BE-04 | BE-01 | nit | The /health route has no role guard or `@Public()` marker because the RBAC guard arrives in BE-03; BE-03 must list it as public in the permission matrix. | backend | BE-03 | open |
| FU-BE-05 | BE-01 | nit | `pnpm add` reported ignored dependency build scripts (`@scarf/scarf`, `@parcel/watcher`, `cpu-features`, `protobufjs`, `ssh2`, `unrs-resolver`). Nothing needed them for tests to pass; the architecture hub owns `allowBuilds` in pnpm-workspace.yaml if any should be approved. | architecture hub | any | open |
| FU-BE-06 | BE-01 | nit | Local shell ran Node 22 while `.nvmrc` and engines require 24; checks passed on 22. CI uses 24. | backend | any | open |
| FU-BE-07 | BE-01 | nit | ADR 0001 C-8 says `/docs/api-contract.md` is authoritative until BE-01 exists; that file is absent. The OpenAPI spec is now served at `/api/docs-json` in non-production; export-to-file for the frontend is not yet automated. | architecture hub | ARC-02 | open |
| FU-BE-08 | BE-01 review | should-fix | `trust proxy` is never set; behind Caddy every client shares one throttle bucket (`req.ip` is the proxy). Add a `TRUST_PROXY_HOPS` env var (default 0), set it in `bootstrap.ts`, and test with `X-Forwarded-For`. Must land before any deploy behind Caddy. | backend | before first deploy | open |
| FU-BE-09 | BE-01 review | should-fix | `areaOf` in `app.module.ts` matches `req.path` case-sensitively but Express routing is case-insensitive, so `/api/v1/AUTH/...` is throttled as `other` (100/min instead of 10). Lowercase the path or use per-controller `@Throttle` metadata; add a test. | backend | BE-02/BE-03 | open |
| FU-BE-10 | BE-01 review | should-fix | Swagger detection fails open: NODE_ENV and APP_ENV default to `development`. Make docs opt-in (`ENABLE_API_DOCS`, default false, rejected in pilot/production) or require APP_ENV. | backend | before first deploy | open |
| FU-BE-11 | BE-01 review | nit | `WEB_ORIGIN` should be normalised with `new URL(u).origin` so a trailing slash cannot silently break CORS. | backend | any | open |
| FU-BE-12 | BE-01 review | nit | `problem.filter.ts` traceId fallback reflects the raw inbound `x-request-id` without the regex check; use `''` or the same validation. | backend | any | open |
| FU-BE-13 | BE-01 review | nit | Nest's default 404 detail echoes the full URL including the query string; strip the query or use a fixed detail. | backend | any | open |
| FU-BE-14 | BE-01 review | nit | Unhandled errors are logged as the full Error object; add an `err` serializer or redaction (Prisma errors may carry values). | backend | BE-15 | open |
| FU-BE-15 | BE-01 review | nit | Drop `--forceExit` once FU-BE-02 is fixed, and run `--detectOpenHandles` in CI. | backend | with FU-BE-02 | open |
| FU-BE-16 | BE-01 review | nit | Test gaps: malformed inbound `x-request-id` is replaced, validation `errors[]` detail stays safe, shutdown hook. | backend | any | open |
| FU-BE-17 | BE-01 review | nit | `.env.example` omits NODE_ENV, LOG_LEVEL, THROTTLE_* and HEALTH_TIMEOUT_MS. | backend | any | open |
| FU-BE-18 | BE-01 review | nit | Default candidate throttle (30/min/IP) will be tight once heartbeats, events and chunk uploads exist; revisit. | backend | BE-10/BE-15 | open |
