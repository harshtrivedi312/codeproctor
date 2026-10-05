# CodeProctor

Project: CodeProctor, a proctored coding assessment platform for hiring.
Source of truth: /docs/brd.md, /docs/fsd.md, /docs/architecture.md, /docs/database.md, /docs/test-cases.md. Read the relevant doc before changing code. If code and docs disagree, stop and ask.

Stack: pnpm monorepo. apps/web (Next.js App Router, TypeScript, Tailwind, shadcn/ui), apps/api (NestJS, Prisma, PostgreSQL 16, Redis + BullMQ, Socket.IO), apps/worker (Python 3.12, FastAPI), packages/proctor-sdk, packages/shared (types + zod schemas). Judge0 CE for code execution. Object storage behind one S3-compatible interface: staging uses Cloudflare R2 with synthetic data only; pilot and production use AWS S3; only configuration differs between environments. Docker Compose for local and staging.

Rules:
- TypeScript strict mode; no `any`.
- Every API route has a DTO validated with class-validator or zod, a role guard, and an org-scope check.
- Never log secrets, tokens, OTPs, or candidate media keys.
- Staging and pilot database credentials never exist on developer machines or in agent sessions; they live only in GitHub Actions secrets and on the servers (ADR 0009).
- Agents never run `pnpm db:reset`, `pnpm dev:infra:reset`, `prisma migrate reset` or `db push`; ask the human (ADR 0009).
- Every feature ships with tests; reference FR and TC IDs from the docs in test names.
- Small commits with conventional commit messages.
- Prefer free and open-source tools.

Build prompts: /docs/prompts/database.md (runs first), backend.md, frontend.md, agents-qa-deploy.md. Sub-agent definitions live in .claude/agents/.

## Working in parallel

Several sessions work on this repo at once, each in its own worktree. These rules apply to every session and replace any pasted copy.

### Autonomy
1. You may create branches, commit, push and open draft PRs without asking.
2. Review rule: only blockers stop a merge. Should-fix items and nits go to your track's file at `docs/followups/<track>.md` (database, frontend, backend, proctor-sdk, integrity, qa, architecture).
3. Security weaknesses in authentication, authorization, session handling, cryptography or access to candidate data are always blockers. Fix them before merge, even if the reviewer files them as should-fix.
4. Switch on the CI monitor (auto_fix) for your PRs. Auto-fix may only change files on your own branch and within your scope.
5. No PR skips code-reviewer, whatever its size. Docs-only PRs may get a quick review; anything touching `packages/shared`, schemas, tests, CI or config always gets a full review.
6. When code-reviewer has no blockers and CI is green, merge and start the next step in your track without asking.
7. Ask the owner only for: an unresolvable blocker, a database schema or `packages/shared` change not covered by an approved ADR, anything involving real credentials or AWS, agent definition changes, or scope changes.

### Merging
8. Never enable GitHub auto-merge (no `gh pr merge --auto`, no `set_auto_merge`, no UI toggle).
9. Merge only with an explicit `gh pr merge`, only your own PRs, only after your final push, and never while the PR is a draft or has pending work. Before merging, confirm you have no unpushed or pending commits.
10. If you have waited on CI for more than 30 minutes without an event, check it with `gh pr checks`.

### Coordination
11. Before each step, update from main. Before opening a PR, rebase on main and rerun lint, type-check and tests.
12. Stay inside your agent's file scope. Changes to `packages/shared`, root `package.json`, CI config or `prisma/` go through the architecture hub unless your step explicitly owns them.
13. Never hand-merge `pnpm-lock.yaml`. On conflict, take main's version and rerun `pnpm install`. On a conflict in any docs file, keep both sides' content.
14. Only the Database session starts, stops or resets the local Docker stack. Others may connect to it but never run `dev:infra`, `dev:infra:down` or `db:reset`. Tests needing a database use Testcontainers.
15. Only the Frontend session runs the web dev server.
16. Only the architecture hub edits `docs/status.md` and `docs/build-plan.md`. Report your progress in PR descriptions.
17. Follow-ups go in `docs/followups/<track>.md`.

Report briefly after each merge: what merged, what's next.
