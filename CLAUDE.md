# CodeProctor

Project: CodeProctor, a proctored coding assessment platform for hiring.
Source of truth: /docs/brd.md, /docs/fsd.md, /docs/architecture.md, /docs/database.md, /docs/test-cases.md. Read the relevant doc before changing code. If code and docs disagree, stop and ask.

Stack: pnpm monorepo. apps/web (Next.js App Router, TypeScript, Tailwind, shadcn/ui), apps/api (NestJS, Prisma, PostgreSQL 16, Redis + BullMQ, Socket.IO), apps/worker (Python 3.12, FastAPI), packages/proctor-sdk, packages/shared (types + zod schemas). Judge0 CE for code execution. Cloudflare R2 for media. Docker Compose for local and staging.

Rules:
- TypeScript strict mode; no `any`.
- Every API route has a DTO validated with class-validator or zod, a role guard, and an org-scope check.
- Never log secrets, tokens, OTPs, or candidate media keys.
- Every feature ships with tests; reference FR and TC IDs from the docs in test names.
- Small commits with conventional commit messages.
- Prefer free and open-source tools.

Build prompts: /docs/prompts/database.md (runs first), backend.md, frontend.md, agents-qa-deploy.md. Sub-agent definitions live in .claude/agents/.
