# Prompts — Multi-agent build, QA and deployment

These prompts coordinate parallel agents in Claude Code, then test and deploy the platform. Use the orchestrator prompt once the Database track is merged.

## Orchestrator prompt (Claude Code with sub-agents)

```text
You are the lead engineer for CodeProctor. Read CLAUDE.md and everything in /docs.
The Database track is complete. Plan and coordinate the rest of the build using sub-agents working in parallel, each on its own git worktree and branch:

- Agent "backend-core": Backend prompts Steps 1–7 in /docs/prompts/backend.md, strictly in order.
- Agent "frontend-staff": Frontend Steps 1–5, using MSW mocks until backend endpoints are merged.
- Agent "proctor-sdk": Frontend Steps 6–8 (packages/proctor-sdk only).
- After backend-core finishes Step 7, start in parallel: "backend-media" (Backend Steps 8–9), "backend-integrity" (Backend Steps 10–12), "frontend-candidate" (Frontend Steps 9–10).
- Then "backend-review" (Backend Steps 13–14) and "frontend-review" (Frontend Steps 11–13).
- Finally "hardening" (Backend Step 15) and "qa" (QA prompts below).

Rules for every agent:
- Only touch files in your assigned area; changes to packages/shared need a note in the PR description.
- Run lint, type-check and tests before reporting done; include the FR and TC IDs covered.
- Never merge your own branch; report back and I will review and merge in dependency order.
Start by writing /docs/build-plan.md with the dependency graph and assignment table, then launch the first wave.
```

Put the Backend and Frontend prompt tabs into the repo as `/docs/prompts/backend.md` and `/docs/prompts/frontend.md` so the orchestrator can hand them to sub-agents.

## QA 1 — Test suite from the test cases

```text
Read /docs/test-cases.md. For every test case, decide the right level (unit, API integration, Playwright end-to-end, manual) and create /docs/test-matrix.md mapping TC ID → test file → status.
Implement all automatable P1 cases first, then P2. Name each test with its TC ID.
For cases that need real hardware or people (second face, phone in view, second monitor), write a manual test script in /docs/manual-tests.md with exact steps and expected results.
Add a CI job that fails if any P1 automated test fails, and prints coverage per module.
```

## QA 2 — Red-team the anti-cheating controls

```text
Act as a candidate trying to cheat. Using the running staging environment, attempt every bypass you can think of against /docs/fsd.md M6 and M8: pasting via browser extensions, auto-typing tools, second browser profile, virtual camera, screen-share of a single window disguised as a screen, devtools tricks, tampering with the proctor SDK in the browser, replaying or forging event batches, blocking uploads to hide recordings, and editing the clock.
For each attempt record: method, detected (yes/no), event produced, and a proposed fix. Write /docs/red-team-report.md and open issues for every undetected method.
```

## Deploy 1 — Staging on free tiers

```text
Create infra for a free-tier staging environment:
- One Linux VM (x86, confirm Judge0 compatibility) running Docker Compose with: api, worker, redis, judge0 (+ its db and redis), caddy (automatic HTTPS).
- Managed Postgres (Supabase or Neon free) via DATABASE_URL; Cloudflare R2 buckets for media and backups; web app on Cloudflare Pages.
- GitHub Actions: on merge to main, build images, push to GitHub Container Registry, SSH-deploy to the VM with zero-downtime restart, run prisma migrate deploy, then smoke tests.
- Sentry for web, api and worker; uptime checks on /health.
Write /docs/runbook.md: deploy, rollback, rotate secrets, restore backup, scale up.
```

## Deploy 2 — Production readiness

```text
Review staging against /docs/fsd.md NFR-01 to NFR-09 and the BRD compliance section. Produce /docs/go-live-checklist.md covering: free-tier limits vs expected usage for the first 3 months (flag anything that needs a paid tier), data processing agreements with each provider, consent text sign-off, retention job verified, backups restored successfully, load test results, security review closed, accessibility audit closed, incident contact list.
Do not deploy to production; list the decisions a human must make first.
```
