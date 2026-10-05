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

Several sessions work on this repo at once, each in its own worktree. These rules apply to every session and replace any pasted copy; if they conflict, this file wins. The Rules above and accepted ADRs take precedence over this section.

### Autonomy
1. You may create branches, commit, push and open draft PRs without asking. Push only to your own branches; never push to `main` and never force-push a branch you do not own.
2. Review rule: only blockers stop a merge. Should-fix items and nits go to your track's follow-up file (rule 17: `docs/followups/<track>.md`; tracks: database, frontend, backend, proctor-sdk, integrity, qa, architecture; deploy work files under qa).
3. Security weaknesses in authentication, authorization, session handling, cryptography or access to candidate data are always blockers. Fix them before merge, even if the reviewer files them as should-fix.
4. Switch on the CI monitor (auto_fix) for your PRs. Auto-fix may only change files on your own branch and within your scope.
5. No PR skips code-reviewer, whatever its size. Docs-only PRs may get a quick review; anything touching `packages/shared`, schemas, tests, CI or config (including CLAUDE.md, ADRs and `.claude/`) always gets a full review.
6. When code-reviewer has no blockers and CI is green, merge and start the next step in your track without asking.
7. Ask the owner only for: an unresolvable blocker, a database schema or `packages/shared` change not covered by an approved ADR, anything involving real credentials or AWS (never accept or paste credentials into a session; the human performs the action, see Rules above and ADR 0009), agent definition changes, any change to CLAUDE.md or `.claude/` (agents, settings, permissions, hooks), accepting or amending an ADR, scope changes, or a disagreement between code and docs (in addition to the Rules above).

### Merging
8. Never enable GitHub auto-merge (no `gh pr merge --auto`, no `set_auto_merge`, no UI toggle).
9. Merge only with an explicit `gh pr merge`, only your own PRs, only after your final push, and never while the PR is a draft or has pending work. After your final push and review, mark the PR ready with `gh pr ready`. Before merging, confirm you have no unpushed or pending commits, and that the head SHA is the one that was reviewed and CI-green. If auto-fix or your own fixes pushed after the review, re-run code-reviewer on the new commits.
10. If you have waited on CI for more than 30 minutes without a CI status update or notification, check it with `gh pr checks`.

### Coordination
11. Before each step, update from main. Before opening a PR, rebase on main and rerun lint, type-check and tests. If main moves after the PR is opened, rebase again and rerun the checks before merging.
12. Stay inside your agent's file scope. Changes to `packages/shared`, root `package.json`, CI config or `prisma/` go through the architecture hub unless your step explicitly owns them.
13. Never hand-merge `pnpm-lock.yaml`. On conflict, take main's version and rerun `pnpm install`. On a conflict in any docs file, keep both sides' content and flag any contradiction to the architecture hub.
14. Only the Database session starts or stops the local Docker stack (`dev:infra`, `dev:infra:down`). Resets (`db:reset`, `dev:infra:reset`) stay human-only per the Rules above and ADR 0009. Other sessions may connect to the stack but never start, stop or reset it. Tests needing a database use Testcontainers.
15. Only the Frontend session runs the web dev server.
16. Only the architecture hub edits `docs/status.md` and `docs/build-plan.md`. Report your progress in PR descriptions.
17. Follow-ups go in `docs/followups/<track>.md`.

Report briefly after each merge, to the owner in chat and in the PR description: what merged, what's next.
