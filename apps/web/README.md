# @codeproctor/web

Next.js 16 (App Router, TypeScript strict), Tailwind v4, shadcn/ui-style components, TanStack Query,
react-hook-form + zod (schemas from `@codeproctor/shared`), `openapi-fetch` client, MSW mocks.

Route groups: `(public)` landing and errors, `(staff)` `/admin/*`, `(candidate)` `/t/[token]/*`.

## Run with mocked API (no backend needed)

```sh
pnpm install
pnpm dev:web:mock        # from the repo root; same as: pnpm --filter @codeproctor/web dev:mock
```

Open <http://localhost:3000/t/demo/test> for the mocked candidate test screen preview. The token
`demo` only works when `NEXT_PUBLIC_API_MOCKING=enabled`.

Without mocks: `pnpm dev:web` (expects the API at `NEXT_PUBLIC_API_URL`, default
`http://localhost:4000`).

`predev` builds `@codeproctor/shared` and copies Monaco to `public/monaco` (git-ignored).

## Scripts

| Script                      | What it does                                                      |
| --------------------------- | ----------------------------------------------------------------- |
| `dev`, `dev:mock`           | Dev server, without or with MSW mocks                             |
| `build`, `start`            | Production build and server                                       |
| `typecheck`, `lint`, `test` | tsc, eslint, Vitest (MSW runs in Node there)                      |
| `gen:api`                   | Regenerates `src/lib/api/schema.d.ts` from `openapi/openapi.yaml` |

## API contract and mocks

There is no backend OpenAPI spec yet. `openapi/openapi.yaml` is a small hand-written contract for
the endpoints the mocks serve. When the API publishes its spec, replace the file, run `gen:api`, and
delete the matching handlers in `src/mocks` (remove mocks when the backend step merges).

## Content Security Policy

`src/middleware.ts` sets a per-request nonce CSP built by `src/lib/csp.ts` (unit tested).

- `script-src 'self' 'nonce-...' 'strict-dynamic'`. No inline scripts except Next's nonced ones.
- `connect-src 'self'` + `NEXT_PUBLIC_API_URL` origin + `NEXT_PUBLIC_UPLOAD_ORIGINS`.
- `style-src` allows `'unsafe-inline'` (Monaco and Radix inject style attributes). Scripts do not.
- `worker-src 'self' blob:` for Monaco workers and the MSW service worker.
- Dev only (`next dev`): `'unsafe-eval'` in script-src (React dev stacks) and `ws://localhost:*` in
  connect-src (hot reload). Never emitted in production.

## Candidate test preview (`/t/demo/test`)

Mocked only, no proctoring logic. Monaco is self-hosted (copied from `node_modules`, no CDN). Demo
controls: "Enter fullscreen" start gate (or "Continue without fullscreen (demo only)"), and
"Simulate fullscreen exit" (Alt+Shift+X) to show the lock overlay when fullscreen is unavailable.
Sample-run results are fake: code containing `sort` passes samples 1 and 2, adding `<=` or `max(`
also passes sample 3, empty code gives a compile error, `while True` gives a timeout.
