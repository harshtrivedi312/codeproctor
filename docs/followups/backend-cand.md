# Follow-ups: Backend B (candidate)

Owner: the Backend B (candidate) session (D-51). IDs use the prefix FU-BEB-NN, so they never collide with the first session's file. Only blockers stop a merge (CLAUDE.md rule 2); security weaknesses are always blockers (rule 3).

| ID | Source | Severity | Item | Owner | Target | Status |
| --- | --- | --- | --- | --- | --- | --- |
| FU-BEB-01 | BE-05 | should-fix | `ValidationReportSink` (execution/reference-validation.types.ts, token `VALIDATION_REPORT_SINK`) has no implementation. BE-04 must implement it (write `validation_report`, `validated_at`), render Mustache references per variant, call `validateAndRecord`, and gate publish (FR-203, TC-012). | Backend A (BE-04) | BE-04 | open |
| FU-BEB-02 | BE-05 | should-fix | apps/api cannot import packages/shared; language map uses its own keys and a test reads CODE_LANGUAGES as text. Hub: add shared as workspace dependency of apps/api (PR #62 may cover it), then type the map as Record<CodeLanguage, number>. | architecture hub | after #62 | open |
| FU-BEB-03 | BE-05 | should-fix | PA-05/R-11: seed validation (6 questions x 3 languages) via `validateSeeded` is not run; needs real Judge0 on the ARC-05 host. Confirm seeded Java uses `public class Main`. | backend-cand | ARC-05 | open |
| FU-BEB-04 | BE-05 | should-fix | MEMORY_LIMIT is inferred (crash status, peak memory >= 95% of limit) since Judge0 has no such status; language ids 100/102/91 and cgroup v1 on 1.13.1 need confirming on the real host (R-01). | backend-cand | ARC-05 | open |
| FU-BEB-05 | BE-05 | nit | infra/judge0/docker-compose.judge0.yml is a standalone fragment, not merged into infra/docker-compose.yml; DEP-01/hub decides. Real-Judge0 TC-042..044 skipped unless JUDGE0_URL and JUDGE0_INTEGRATION=true; not in CI until ARC-05. | hub, DEP-01 | DEP-01 | open |
| FU-BEB-06 | BE-05 | nit | Run/Submit endpoints (FR-502, 1 run per 5 s) are BE-11 and call `ExecutionService.run` with reveal for samples only, without captureActualOutput. | backend-cand | BE-11 | open |
