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
