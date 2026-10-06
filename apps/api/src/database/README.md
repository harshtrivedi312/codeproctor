# Database access and org scoping (DB-05)

Everything in this folder serves one rule: **a query can only see or change rows of the caller's
org** (ADR 0006, NFR-04, FR-103, TC-008). Services never build a Prisma client of their own. They
inject `PrismaService` and use `prisma.client`, which runs every model query through the org scope.

**Which `PrismaService`.** There is one: `database/prisma.service.ts` (exported from
`database/index.ts`, provided by `DatabaseModule`), the org-scoped one. BE-02's interim
unscoped client (`database/prisma.module.ts`) is gone: `AuthService` and `JwtAuthGuard` use the
scoped one inside `runSystem('AUTH_BOOTSTRAP', ...)` or `runInOrg` (FU-DB-58, FU-DB-102).

An import guard (`import-guard.spec.ts`) keeps five things out of new code, because each reaches
Postgres around the org scope: the removed `database/prisma.module` (no file may bring it back),
`database/create-prisma-client`, BE-01's `PG_POOL` token, the `pg` package (allowed only in `infrastructure/infrastructure.module.ts` and
`health/health.service.ts`) and the `@prisma/adapter-pg` package (only in
`database/create-prisma-client.ts`). It reads every non-test file under `src` for `from '...'`,
`require('...')` and `import('...')`, with or without `.js`, and compares against an explicit
per-file allowlist in the spec (not folders). **A re-export (`export ... from`) of a guarded module,
package or identifier is refused even in an allowlisted file**, because it hands the thing to every
importer of that file. A new legitimate user is added to the allowlist in the same pull request,
which is the review point.

Developer notes:

- A fresh clone needs `pnpm db:generate` before `typecheck`, `build`, typed `lint` or the tests
  (the generated client is git-ignored; CI does it). FU-DB-13.
- The database tests start Postgres 16 with Testcontainers, so **Docker must be running**. They
  apply the real migrations with `prisma migrate deploy` and connect as `app_user`.

## Using it

```ts
@Injectable()
export class SessionRepository {
  constructor(private readonly prisma: PrismaService) {}

  find(id: string) {
    // Another org's session is simply not found: answer 404 (TC-008).
    return this.prisma.client.session.findUnique({ where: { id } });
  }
}
```

The org comes from the context, never from a parameter:

| Where the code runs                       | Who sets the context                                                                                                                              |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Staff HTTP route                          | `OrgContextInterceptor`, from `request.user` (BE-02's `JwtAuthGuard` sets an `AuthUser`)                                                          |
| Candidate route (token, then its session) | `CandidateSessionGuard` calls `orgContext.runAsCandidate(oid, sid, ...)` from the verified claims (BE-07; see "Candidate and session-job scopes") |
| BullMQ session job                        | `SessionJobProcessor` calls `detachForSessionJob`, then `runAsSessionJob(orgId, sessionId, ...)` from the payload (BE-07, BE-08)                  |
| BullMQ cross-session job, Socket.IO event | the processor or gateway calls `runInOrg(job's org, ...)` or `runAsUser(...)` (BE-08+)                                                            |
| Login, refresh, token lookups, cross-org  | `orgContext.runSystem(reason, ...)` with a reason from `SYSTEM_SCOPE_REASONS`, outside any org                                                    |
| A reviewed raw SQL query                  | `orgContext.runRawSql('why', ...)`                                                                                                                |

`request.user` is BE-02's `AuthUser` (`common/auth/auth.types.ts`): `{ id, orgId, role, kind }`.
The interceptor checks it (`kind` must be `access`, `id` and `orgId` must be uuids, `role` a known
role), maps `id` to `userId`, and runs the handler inside `runAsUser({ orgId, userId, role })`.
`AuthenticatedUser` (`{ orgId, userId, role }`) is the shape inside the context. `orgId` comes from
the verified token, never from the body, a header or the query string. A `request.user` that does
not match is answered **500** and the handler does not run: the guard accepted the token, so a
user that fails this check is a bug in the auth layer, not a bad credential from the client. The
error is logged without any value. A `@Public()` route has no `request.user` (the guard returns
early), so it runs with no context and a query on org data from it throws.
Guards run before interceptors, so `request.user` is always set by the time the interceptor reads
it (tested with the real `JwtAuthGuard` and real tokens).

### Why AsyncLocalStorage, not Nest request scope

A request-scoped provider makes every provider that injects it request-scoped, and Nest rebuilds
that whole chain on each request: slower (NFR-01), and unusable outside HTTP. This API also runs
BullMQ jobs and Socket.IO events, which have no request object. AsyncLocalStorage keeps every
provider a singleton, follows one request's async calls, and keeps concurrent requests apart
(tested with concurrent units of work and concurrent HTTP requests from two orgs). The storage is module-level, so a service that is provided twice shares one context, and `current()` returns frozen objects (the store, the scope and a copy of the user), so nothing can change the context from outside.

## The scope map

`org-scope-map.ts` has one entry per model. `Record<ModelName, ...>` makes the compiler reject a
missing or unknown model, and `org-scope-map.spec.ts` checks the map against the generated client
and `prisma/schema.prisma`, so a new model fails the build and the test until it is declared.

| Rule     | Meaning                                                                              | Models                                                                                           |
| -------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `direct` | has an `org_id` column; filter `{ orgId }`                                           | User, Question, Test, Candidate, Invitation, Session, AuditLog, ConsentText, WebhookEndpoint (9) |
| `self`   | the organization row, the tenant root; filter `{ id: orgId }`                        | Organization                                                                                     |
| `path`   | no `org_id`; filter climbs required to-one relations to the nearest ancestor with it | see below (21)                                                                                   |

| Model               | Org path                                 |
| ------------------- | ---------------------------------------- |
| RefreshToken        | `user.orgId`                             |
| QuestionVersion     | `question.orgId`                         |
| TestCase            | `questionVersion.question.orgId`         |
| QuestionVariant     | `questionVersion.question.orgId`         |
| VariantTestCase     | `variant.questionVersion.question.orgId` |
| AiReferenceSolution | `questionVersion.question.orgId`         |
| TestSection         | `test.orgId`                             |
| TestQuestion        | `section.test.orgId`                     |
| SessionSection      | `session.orgId`                          |
| SessionQuestion     | `session.orgId`                          |
| Submission          | `sessionQuestion.session.orgId`          |
| Consent             | `session.orgId`                          |
| IdentityCheck       | `session.orgId`                          |
| MediaChunk          | `session.orgId`                          |
| ProctorEventBatch   | `session.orgId`                          |
| ProctorEvent        | `session.orgId`                          |
| KeystrokeBatch      | `session.orgId`                          |
| SessionReview       | `session.orgId`                          |
| FlagDecision        | `event.session.orgId`                    |
| Appeal              | `sessionReview.session.orgId`            |
| WebhookDelivery     | `endpoint.orgId`                         |

**Intentionally global or unscoped models: none.** `Organization` is not global: it is the tenant
root and is scoped by its own id. An `unscoped` entry (with a written reason) exists in the type for
a future decision; the architect decides, and `org-scope-map.spec.ts` fails until the test list is
updated.

**The composition-parent rule.** A path follows the **composition parent**: the row that owns the
child and goes with it (a test owns its sections, a session its events, a question version its test
cases). It never follows a staff reference such as `created_by`, `reviewer_id` or `collected_by`: a
user is a person who acts, not an owner. Those references, and `test_questions.question_version_id`
and the other cross-chain keys, rely on ADR 0006 section 2 rule (i): load every foreign id through
the scoped client first, answer 404 on a miss. The one path that ends in `User` is
`RefreshToken.user`, because a refresh token belongs to its user and is deleted with it; the test
refuses a hop into `User` anywhere else (FU-DB-69). It also checks each hop is a required to-one
relation held on the child side, that the path ends at a model with `org_id`, and that it does not
pass a model that already has one (nearest ancestor).

## What the extension does

One hook, `query.$allOperations`, sees every model operation and every raw query
(`org-scope.extension.ts`; the argument rewriting is in `org-scope-args.ts`).

| Operation                                                                                                       | Inside an org scope                                                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `findUnique`, `findUniqueOrThrow`, `findFirst`, `findFirstOrThrow`, `findMany`, `count`, `aggregate`, `groupBy` | org filter ANDed into `where`                                                                                                                                                                    |
| `update`, `updateMany`, `updateManyAndReturn`, `delete`, `deleteMany`                                           | org filter ANDed into `where`; on `direct` models an update that names another org's `orgId` is refused. `self`: `delete` and `deleteMany` are refused (deleting a tenant is a system operation) |
| `create`, `createMany`, `createManyAndReturn`                                                                   | `direct`: `orgId` checked (refused when it names another org) and, as a safety net, added when missing. `path`: passed through. `self`: refused                                                  |
| `upsert`                                                                                                        | filter on `where`, `create` stamped and `update` checked as above                                                                                                                                |
| anything else                                                                                                   | refused (fail closed), and a compile-time check (`OPERATION_COVERAGE`) breaks `typecheck` when Prisma adds an operation                                                                          |

With no context a query on any model throws `OrgContextMissingError`. In system scope it runs
unfiltered, except that an unknown operation, a nested relation write and an `orgId` in an update are still refused. The caller's own `where` (`OR`, `NOT`, an `orgId` naming another org) is kept and ANDed
with the org filter, so it can only narrow.

### Raw queries

`$queryRaw`, `$queryRawUnsafe`, `$executeRaw` and `$executeRawUnsafe` are **refused**, in every
scope, unless the call is inside `orgContext.runRawSql(reason, fn)`. The reason is free text (at
least 10 characters) for the reviewer: what the query does and why the model API cannot. Raw SQL
cannot be filtered by the extension, so the SQL itself must filter by `org_id`. Model queries inside
`runRawSql` stay scoped to the active org.

### System scope

`runSystem(reason, fn)` runs without an org filter, only for a reason in `SYSTEM_SCOPE_REASONS`
(`AUTH_BOOTSTRAP`, `BACKGROUND_JOB`, `RETENTION_ERASURE`). A new reason is an architect-reviewed
change. `BACKGROUND_JOB` is for **scheduled cross-org discovery only**: job payloads carry `orgId`
and `sessionId` (stamped by the enqueuer from its scope), and a processor runs
`runInOrg(payload.orgId, ...)` and loads the session inside it; a miss is a poison job. It cannot be entered from inside an org scope (work that has an org never widens to all
orgs), but code in a system scope may narrow to one org with `runInOrg`. An org scope cannot switch
to another org either. `runRawSql` needs an active scope: **scope first, then `runRawSql`** (inside
`runSystem`, `runAsUser` or `runInOrg`). Called with no scope it throws, so there is no other
order. Treat every `runSystem` and `runRawSql` in a pull request as a review flag.

System scope is unfiltered, but it refuses what would move a row to another org, and anything it
does not know. Four rules hold in it:

- **Unknown operations are refused** (deny by default; ADR 0006 §8.2, FU-DB-160), as in an org scope: only the
  operations in `SCOPED_OPERATIONS` run, so one that a future Prisma adds cannot run unfiltered
  before it is reviewed. `OPERATION_COVERAGE` breaks `typecheck` when that happens.
- **Nested relation writes are refused**, as in an org scope (see "Nested writes and nested cursors").
- **`orgId` cannot be changed on update.** Any `orgId` key in the data of `update`, `updateMany`,
  `updateManyAndReturn` or the update branch of `upsert` is refused on a model with its own
  `org_id`, whatever its value (the `{ set }` form too), and an Organization keeps its id.
- **A path model's first-hop scope key cannot be changed on update** (FU-DB-107): `testId` of
  `TestSection`, `sessionId` of `ProctorEvent`, `userId` of `RefreshToken`, and the rest of the 21
  `SCOPE_HOP` keys (`scopeHopColumn(model)` in `org-scope-relations.ts`), on the same four
  operations and in the same forms. The first hop is what ties such a row to its org, so re-pointing
  it moves the row to the org of the new parent, and Postgres does not catch that.

**`create` may set `orgId` and any parent id** (creates in system scope are review-only, ADR 0006).
With nested relation writes denied, a scalar foreign key is the only way left to move a row: the
`orgId` of a model that has one, or the first-hop key of a path model. They are the keys that decide
which org a row belongs to, which is why they, and not the other foreign keys, are refused. Postgres
catches `orgId` only on the composite-key tables and the first-hop key never, so a mass-assignment
bug in a system-scope write could otherwise move a user, question, test, candidate, consent text or
webhook endpoint, or re-parent a section, event or token. The checks send no query, and their
messages carry no value.

In an **org scope** the two rules differ. An update naming the caller's own `orgId` is accepted
(another org's is refused). A first-hop key is **not** refused: re-parenting a path-model row there
is rule (i), limit (b) below, because the scope filters the row being updated and cannot see the new
parent. A service that re-parents loads the new parent through the scoped client first and answers
404 on a miss. (`tc-008-org-isolation.spec.ts` pins this; it documents the limit and is not a fix.)

### Transactions

`$transaction(async (tx) => ...)` and `$transaction([...])` run in the scope that was active when
they were called, and keep it: in system scope they are unfiltered, in an org scope every query in
them is filtered. Raw SQL inside a transaction needs `runRawSql` (around the `$transaction` call, or
inside its callback) like anywhere else, and rolls back with the transaction.

### No SQL of its own

Entering a scope (`runSystem`, `runAsUser`, `runInOrg`, `runRawSql`) sends no statement, and the
extension never adds a query: it only rewrites arguments. `auth-bootstrap.spec.ts` proves it with
`pg_stat_statements`, which counts what Postgres received: the statements for each operation are
identical to the plain client's, and in an org scope identical to the plain client with the filter
written by hand.

## Candidate and session-job scopes (ADR 0013 CS-4)

> **Status.** ADR 0013 is **Proposed** and its CS-4 is "architect detail, owner to confirm". This is built
> from the text on main, and where the text was ambiguous the stricter reading was built and recorded
> (FU-DB-180 to FU-DB-189). This is **PR 1 of 3**: the two actors, the session filter, the CANDIDATE
> model allowlist and relation vectors 1 to 5. Not built yet (PR 2 and 3): column allowlists, `omit`,
> `withGrant` and the explicit-only columns (CS-4.4), the `submissions` RUN filter and the
> `proctor_events` source filter, vector 6 (the fluent API), the FU-DB-67 call-site test.
> CandidateSessionGuard and SessionJobProcessor are BE-07; `render-question` projections are CS-4.6.

Org scoping does not stop one candidate from reading another candidate's session in the same org. A
**session scope** is an org scope bound to **one session**, taken from the token or the job payload, and
the entry function sets the actor, so a caller cannot forge it.

### The public API (for BE-07)

```ts
orgContext.runAsCandidate<T>(orgId: string, sessionId: string, fn: () => T): Scoped<T>   // actor CANDIDATE
orgContext.runAsSessionJob<T>(orgId: string, sessionId: string, fn: () => T): Scoped<T>  // actor SERVICE
orgContext.detachForSessionJob<T>(fn: () => T): Scoped<T>                                // SessionJobProcessor ONLY
setCandidateFacts(orgContext, { candidateId, invitationId, testId }): void               // CandidateSessionGuard ONLY
orgContext.candidateFacts(): CandidateFacts | undefined                                  // read-only
```

- `runAsCandidate` is called by **CandidateSessionGuard only**, from the verified token claims
  (`oid`, `sid`). `runAsSessionJob` is called by **SessionJobProcessor only**, from the job payload,
  after `detachForSessionJob`. Both validate both ids as uuids and send no SQL.
- **`detachForSessionJob` is for SessionJobProcessor only.** It asserts that the store is empty (no scope,
  no `runRawSql` hatch, no grant) and runs `fn` in a fresh empty store; in any scope, any system scope
  (`BACKGROUND_JOB` included) or open hatch it throws. A BullMQ worker is built at module init, outside
  any scope, and each session job runs in its own worker callback: this is where the processor proves
  that it did not inherit a scope. A candidate scope cannot leave itself.
- **`setCandidateFacts` is for CandidateSessionGuard only.** It lives in `candidate-facts.ts`, which is
  **not exported from `index.ts`**, and the service's own setter is a method keyed by an unregistered
  symbol, so it is not part of the service's surface. It sets `candidateId`, `invitationId` and `testId`
  once per CANDIDATE scope (frozen; a second call, a SERVICE scope or no scope throws). Until it is
  called, a read of `candidates`, `invitations` or `tests` throws. FU-DB-67 pins its one caller.

### Entering and nesting (CS-4.1; ADR 0006 section 8.4)

| Current scope                             | `runAsCandidate`, `runAsSessionJob`           | `runInOrg(same org)`                                                 | `runAsUser`, `runSystem`, the other actor, another org, `detachForSessionJob` |
| ----------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| none                                      | allowed                                       | allowed                                                              | `runAsUser`, `runSystem`, `detachForSessionJob`: allowed                      |
| staff, plain org, any system scope, hatch | **throws**                                    | n/a                                                                  | n/a                                                                           |
| a session scope (either actor)            | **throws**, the same ids included (FU-DB-180) | allowed; the session and the actor stay (the very same scope object) | **throw**                                                                     |

A session scope only narrows: nothing inside it can drop or change the session. Entering from "no
scope only" also means no `runRawSql` hatch can carry into it.

### The session filter (CS-4.2), both actors

Applied on top of the org filter, on every operation, so another candidate's session of the same org is
not found:

| Model (table)                                                                                                                        | Row filter                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `Session` (`sessions`)                                                                                                               | `id = sid`                                                  |
| `SessionQuestion`, `SessionSection`, `IdentityCheck`, `MediaChunk`, `ProctorEventBatch`, `ProctorEvent`, `KeystrokeBatch`, `Consent` | `session_id = sid`                                          |
| `Submission` (`submissions`, no `session_id`)                                                                                        | `sessionQuestion: { sessionId }` (injected relation filter) |

- **Filtered:** `findUnique`, `findUniqueOrThrow`, `findFirst`, `findFirstOrThrow`, `findMany`, `count`,
  `aggregate`, `groupBy`, `update`, `updateMany`, `updateManyAndReturn`, `delete`, `deleteMany` and the
  `where` of `upsert`. An unknown operation throws (as everywhere).
- **Creates take the session from the context.** `sessionId` (or `id` on sessions) is stamped when
  missing and a different value throws, in `create`, `createMany`, `createManyAndReturn` and the create
  branch of `upsert`. Prisma's unchecked create types require `sessionId`, so typed code passes it
  (take it from the context); the stamp is a safety net, as with `orgId`.
- **Existence check.** A create of a `Submission` or a `KeystrokeBatch` with a `sessionQuestionId` first
  runs **one** scoped primary-key query on `session_questions` (`id IN (...)`, under the org filter and
  the session filter) and throws on a miss. It is one statement however many rows a `createMany` has
  (measured: a `submission.create` is 2 statements, the `COUNT` and the `INSERT`; a `createMany` of 3
  rows is 2; a create that needs no check is 1). It runs on the client's own connection, **outside a
  caller's interactive `$transaction`**: a session question created earlier in the same, uncommitted
  transaction is not visible to it, so the create fails closed (FU-DB-182).
- **Session keys are immutable.** An `update`, `updateMany`, `updateManyAndReturn` or the update branch
  of `upsert` that writes `session_id` or a `session_question_id` (`sessionId` and `id` of sessions
  and session_questions, `sessionQuestionId` of submissions and keystroke batches) throws, whatever the
  value (the `{ set }` form too; FU-DB-181).
- **Raw SQL is refused** in any session scope, **even inside `runRawSql`** (ADR 0006 section 8.5).
  Session jobs use the query API.
- **A cursor is refused** on the session-path models in both actors (it ranks rows against a row named
  by its own fields, which could be another session's), and for a CANDIDATE on every model.
- **Nested relation writes** throw in both actors, as in every scope (ADR 0006 section 8.2).
- **Models outside the table** (`tests`, `candidates`, `questions`, ...) get the org filter only.
  `session_reviews` and `webhook_deliveries` carry a `session_id` but are not on the CS-4.2 list, so they
  are org-only in SERVICE scope too (FU-DB-183; one test pins it).

### SERVICE (`runAsSessionJob`): no allowlist, no column limits (CS-4.1)

The org filter plus the session filter, nothing else: every model, every column, relations in `include`,
`select`, `where` and `orderBy`. The session filter covers **top-level** queries; nested reads in SERVICE
scope follow foreign keys without it and stay a rule (i) review item (ADR 0013 CS-4.1).

### CANDIDATE (`runAsCandidate`): deny by default (CS-4.3, CS-4.5)

A model that is not listed throws, for every operation, before any query. Read-only models refuse every
write operation.

| Model                         | Access                                      | Row filter, on top of the org filter                                                                                                                                                                            |
| ----------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the ten above                 | per CS-4.4 (**PR 2**; no column limits yet) | the session filter. **A candidate deletes nothing** (FU-DB-184)                                                                                                                                                 |
| `Organization`                | read                                        | `id = orgId` (the org filter of the tenant root)                                                                                                                                                                |
| `Candidate`                   | read                                        | `id = ctx.candidateId` (a candidate fact)                                                                                                                                                                       |
| `Invitation`                  | read                                        | `id = ctx.invitationId` (a candidate fact)                                                                                                                                                                      |
| `Test`                        | read                                        | `id = ctx.testId` (a candidate fact)                                                                                                                                                                            |
| `TestSection`                 | read                                        | `sessionSections: { some: { sessionId } }` (injected)                                                                                                                                                           |
| `Question`                    | read                                        | `versions: { some: { sessionQuestions: { some: { sessionId } } } }` (injected)                                                                                                                                  |
| `ConsentText`, `TestQuestion` | **throw for now**                           | readable only under a grant (PR 2: `id IN grant.ids`); TODO in `session-scope-map.ts`                                                                                                                           |
| every other model             | **throws**                                  | `User`, `RefreshToken`, `AuditLog`, `QuestionVersion`, `TestCase`, `QuestionVariant`, `VariantTestCase`, `AiReferenceSolution`, `SessionReview`, `FlagDecision`, `Appeal`, `WebhookEndpoint`, `WebhookDelivery` |

A filter that needs a fact **throws while the fact is unset**. The facts exist after the guard has called
`setCandidateFacts`; reading `invitations` to learn them cannot work in the scope, because that read
needs `ctx.invitationId` first (FU-DB-185: the guard flow in ADR 0013 needs a decision).

**Relation vectors 1 to 5 throw** in a CANDIDATE scope, on the caller's arguments, before the extension
adds its own relation filters (so those never trip the check):

| #   | Vector                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | a relation field in `include`                                                                                                                           |
| 2   | a relation field in `select`                                                                                                                            |
| 3   | a relation filter in `where` or `having` (`some`, `every`, `none`, `is`, `isNot`, or a plain relation object), at any depth under `AND`, `OR` and `NOT` |
| 4   | a relation field in `orderBy`                                                                                                                           |
| 5   | a relation `_count` in `select` or `include` (the row `_count` of `aggregate`, `groupBy` and `count` is not a relation count and stays)                 |
| 6   | the fluent API: **not built, PR 3** (a skipped test names it)                                                                                           |

Load each model with its own scoped call instead. A relation field is any field in the relation table
of `org-scope-relations.ts`, whatever its value (`false`, `null` and `{}` too).

### Tests

`org-context-session.spec.ts` (actors, nesting, detach, facts; no database), `session-scope-args.spec.ts`
(every model and operation on the rewritten arguments), `session-scope.extension.spec.ts` (the allowlist
sweep over every model of the generated client and the vectors, through the real client, no database) and
`cs4-session-isolation.spec.ts` (two candidates in one org and one in another, against Postgres 16 as
`app_user`: cross-candidate reads and writes, SERVICE, creates, keys, raw SQL, statement counts).
Removing the session filter, the allowlist or any one of the other rules above makes tests fail.
FU-DB-67 will add the call-site test.

## Auth bootstrap recipe

For BE-02's `AuthService` (login, forgot, reset, refresh, 2FA completion) and any other code that
runs before the caller's org is known:

1. **Pre-login lookups go inside `runSystem('AUTH_BOOTSTRAP', ...)`.** Inside it model queries are
   unfiltered, so the lookup by email or token hash works.
2. **Raw SQL goes inside `runRawSql('<reason>', ...)`, inside that scope.** The lockout counter and
   the recovery-code consume are examples. The order is scope first, then `runRawSql`: it throws
   with no scope. Outside `runRawSql`, raw SQL is still refused, even in system scope.
3. **Once the user is known, switch to `runAsUser({ orgId, userId, role }, ...)`** (or
   `runInOrg(orgId, ...)` when there is no user). Narrowing from system scope to an org scope is
   allowed, so no `runInOrg` workaround is needed. Inside the inner scope queries are filtered, and
   raw SQL is refused again **unless a `runRawSql` is still open around it**: an open hatch carries
   into nested scopes (see Limits (e)), so keep `runRawSql` around the single statement only. When
   the inner scope ends you are back in system scope. The reverse is refused: `runSystem` inside an
   org scope throws.
4. **Transactions work in system scope** (interactive and batch), keep the scope, and accept raw SQL
   through `runRawSql`.
5. **`runSystem`, `runAsUser`, `runInOrg` and `runRawSql` add no queries**, and the extension never
   adds one, so equal-work timing tests (unknown, wrong and locked logins) are unaffected.

```ts
// A sketch of the shape, not BE-02's code.
async login(email: string, password: string) {
  return this.orgContext.runSystem('AUTH_BOOTSTRAP', async () => {
    const user = await this.prisma.client.user.findUnique({ where: { email } }); // unfiltered
    if (!user || !(await this.passwords.verify(user, password))) {
      await this.orgContext.runRawSql('atomic failed-login counter and lockout (TC-002)', () =>
        this.prisma.client.$queryRaw(Prisma.sql`UPDATE users SET ... RETURNING failed_logins`),
      );
      throw new UnauthorizedException('Invalid email or password.');
    }
    // The user is known: from here on, work as that user in that org.
    return this.orgContext.runAsUser({ orgId: user.orgId, userId: user.id, role: user.role }, () =>
      this.startSession(user),
    );
  });
}
```

## Limits (read before relying on it)

The extension filters the top-level model: its `where`, its `cursor`, and the `orgId` of a create
or update. Nested relation writes are **denied by default** ("Nested writes and nested cursors"
below), and nested cursors are refused. Everything else reached through a relation is **not**
looked at.

- **(a) Ids written as scalar foreign keys.** Services relate rows with scalar foreign keys only
  (`invitationId`, `testId`, `userId`). The extension does not check what id you write, and
  Postgres checks only the composite keys (`invitations.test_id`, `invitations.candidate_id`,
  `sessions.invitation_id`, which include `org_id`). **Every other id follows rule (i)**: load the
  row through the scoped client first, and answer 404 on a miss.
- **(b) Re-parenting in an org scope.** An update that changes a path model's first-hop foreign
  key, for example `testSection.update({ data: { testId } })`, is the same as a path create: rule
  (i). System scope refuses it (see "System scope"); an org scope does not. A `create` on
  a `path` model cannot be stamped either (there is no `org_id` column), so the parent id in the
  payload must have been loaded through the scoped client first.
- **(c) Nested reads are not filtered.** `include`, `select`, the fluent API, relation filters,
  `orderBy` on a relation and `_count` follow foreign keys blindly. Any foreign key that crosses
  orgs leaks. Example: if `session_reviews.reviewer_id` points at another org's user,
  `sessionReview.findUnique({ where: { id }, include: { reviewer: true } })` returns that user row,
  password hash included. Select only the fields you need, and never `include` a user.
  (`tc-008-org-isolation.spec.ts` pins this behaviour; it documents the limit and is not a fix.)
  **In a CANDIDATE scope (ADR 0013 CS-4.5) vectors 1 to 5 throw**, and in a SERVICE scope they stay a
  review item: see "Candidate and session-job scopes".
- **(d) Rule (i) covers 25 foreign keys**, not only the staff references (`created_by`,
  `reviewer_id`, `assigned_to`, `collected_by`, `scored_by`, `reviewed_by`, `actor_id`) and
  `test_questions.question_version_id`. The list is `RULE_I_REFERENCES` in
  `org-scope-relations.ts` (see "Foreign keys and rule (i)" below). The main cross-chain ones:
  `session_questions` to `test_questions`, `question_versions` and `question_variants`;
  `session_sections` to `test_sections`; `consents` to `consent_texts`; `keystroke_batches` to
  `session_questions`; `webhook_deliveries` to `sessions`; `organizations.current_consent_text_id`
  to `consent_texts`.
- **(e) An open `runRawSql` carries into nested scopes.** A `runAsUser`, `runInOrg` or `runSystem`
  started inside it keeps the hatch, so raw SQL there is not refused. Wrap only the single raw
  statement, never a block that also does model work.
- **Cursors.** In an org scope a top-level cursor is given the caller's org on models with
  `org_id`, accepted only for the caller's own row on Organization, and **refused on models without
  `org_id`** (Prisma finds the cursor row by its own fields, so there is no way to scope it). Page
  those with `where` plus `orderBy`, for example `where: { id: { gt: lastId } }, orderBy: { id:
'asc' }`. A cursor nested in `include`, `select` or the fluent API is refused on every model:
  **page nested relations with `where`, `take` and `orderBy`** (see below).
- Prisma queries are lazy. See "Writing queries inside the scope" below.
- Prisma returns `BigInt` for the identity ids and `Decimal` for scores (FU-DB-06): serialise them
  before sending JSON.

## Foreign keys and rule (i)

`org-scope-relations.ts` classifies **every foreign key in the schema**, one class each
(`FK_CLASSES`, **58 foreign keys**). `org-scope-relations.spec.ts` derives the keys from
`prisma/schema.prisma`, asserts the total and each class count
(`{ ORG_ID: 9, SCOPE_HOP: 21, COMPOSITE: 3, RULE_I: 25, total: 58 }`), and fails for a key that is
missing, unclassified, classified twice, or in the wrong class. A new foreign key breaks the build
until it is classified.

| Class       | Count | What it is                                                                                                                                                             | Who guards it                                                                                                 |
| ----------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `ORG_ID`    | 9     | the `org_id` key of a model with its own org (to `organizations`)                                                                                                      | the scope (filter and stamp)                                                                                  |
| `SCOPE_HOP` | 21    | the first hop of a path model's scope path (its own parent)                                                                                                            | the scope filter; creating, and re-parenting in an org scope, is rule (i) (system scope refuses to re-parent) |
| `COMPOSITE` | 3     | `(id, org_id)` keys on `invitations` (2) and `sessions` (1), ADR 0006 2 ii                                                                                             | the database                                                                                                  |
| `RULE_I`    | 25    | references the scope cannot check: **12 staff** (to users: `created_by`, `reviewer_id`, `assigned_to`, ...) and **13 cross-chain** (another chain, or a second parent) | **rule (i)**                                                                                                  |

`SCOPE_HOP + COMPOSITE + RULE_I` is 49; the 9 `ORG_ID` keys make 58. Each `RULE_I` entry also says
whether it is `staff` or `cross-chain` (`ruleI`).

`RULE_I_REFERENCES` (the 25 `RULE_I` keys) is the list a service must follow: **before writing an
id into any of these columns, load the row through the scoped client and answer 404 on a miss.**
Module tests and code review take their checklist from it, for example "every write of
`session_questions.test_question_id` loads the test question first".

The same table lists every relation field (both sides of each foreign key), which the nested guard
uses to tell a relation from a scalar.

## Nested writes and nested cursors

### Nested relation writes are denied by default (ADR 0006 section 8)

In **any scope the extension applies to** (an org scope, and system scope too), `applyOrgScope`
refuses every nested relation write in the `data` of `create`, `update`, `updateMany`, `upsert`
(and their `*AndReturn` forms): `connect`, `connectOrCreate`, `create`, `createMany`, `update`,
`updateMany`, `upsert`, `delete`, `deleteMany`, `set` and `disconnect`, through every relation
class (`ORG_ID`, `SCOPE_HOP`, `COMPOSITE`, `RULE_I`) and on both sides, including `org: { connect }`.
It throws `OrgScopeViolationError`:

```
Organization.update: nested relation write refused (Organization.users.connect): write related rows
with their own scoped call and scalar foreign keys (ADR 0006 §8, deny-by-default).
```

The message names the model, relation and operation, never a value. The check adds no query: it
looks up each key of `data` in the relation table. It does **not** touch scalar fields (scalar
foreign keys included), a scalar list's `{ set: [...] }`, Json columns, a flat top-level
`createMany`, or nested reads (`include`/`select` without a cursor). With no scope active
everything already throws.

**Why every shape, not a list of safe ones.** A nested write acts on rows the scope filter never
selected, and each class had a hole, shown on Prisma 7 against Postgres:

- **Parent side:** `organization.update({ data: { users: { connect: { id: userOfB } } } })` moves
  B's user into A.
- **`RULE_I`:** `sessionReview.update({ data: { reviewer: { update: { passwordHash } } } })` writes
  the user the review names, who can belong to another org.
- **`COMPOSITE`:** `connect` writes **every column of the key, `org_id` included**, from the
  connected row. `session.update({ data: { invitation: { connect: { id: invitationOfB } } } })`
  ran with org A's filter and left the session with `org_id` = B and B's `invitation_id`, with its
  proctor events in org B. The composite foreign key is satisfied by the new values, so Postgres
  accepts it. The scalar form `invitationId: <B's>` keeps `org_id` = A, and Postgres rejects it
  (`sessions_invitation_id_org_id_fkey`).
- **`connect` next to a write in one to-one input:** Prisma applies the `update` to the row that
  was just connected. `refreshToken.update({ data: { user: { connect: { id: userOfB }, update: {
passwordHash, email } } } })` rewrote B's user, through a `SCOPE_HOP` relation.

A rule that lists the safe shapes would have to be re-proven on every Prisma release and schema
change; refusing all of them cannot be wrong in this way. (`tc-008-org-isolation.spec.ts` records
each of these on the plain client, and shows the refusal.)

### Write with scalar foreign keys and separate calls

**COMPOSITE keys (`invitations.test_id`, `invitations.candidate_id`, `sessions.invitation_id`) are
written only as scalar foreign keys, never through `connect`**, and a nested to-one input never
combines `connect` with a write. Postgres checks the composite keys on the scalar form.

Prisma's relation inputs are the **checked** types (`XCreateInput`, `XUpdateInput`: `connect` and
the rest). Scalar foreign keys are the **unchecked** types (`XUncheckedCreateInput`,
`XUncheckedUpdateInput`), which Prisma picks by itself when the input has scalar keys and no
relation. So the way to write related rows is the unchecked form, one top-level call per row:

```ts
// Refused: a checked input with a relation (deny by default).
await prisma.client.invitation.create({
  data: {
    org: { connect: { id: orgId } },
    test: { connect: { id: testId } },
    candidate: { connect: { id: candidateId } },
    tokenHash,
    windowStart,
    windowEnd,
  },
});

// Allowed: the unchecked input, scalar foreign keys only. orgId is a scalar too, and you pass it.
const invitation = await prisma.client.invitation.create({
  data: { orgId, testId, candidateId, tokenHash, windowStart, windowEnd },
});
await prisma.client.session.create({ data: { orgId, invitationId: invitation.id } });

// Several rows under one parent: separate top-level calls (or createMany), not a nested create.
await prisma.client.testSection.createMany({ data: sections.map((s) => ({ testId, ...s })) });
```

Each id you write is a rule (i) id (`RULE_I_REFERENCES`): load the row first. The unchecked forms
work through the extended client's types without casts (a test compiles the calls above).

**Pass `orgId` explicitly on a create of a model that has one.** Prisma's unchecked create types
require `orgId` (it is a required scalar), so typed code has to write it, and the extension then
checks it: a value that is not the caller's org is refused. The extension also **adds `orgId` when
it is missing**, but that is a safety net for loosely typed calls, not an API: typed services never
reach it, and nothing should rely on it (FU-DB-100). Take the value from the context
(`orgContext.requireOrgId()`), never from the request body.

### Exceptions: `NESTED_WRITE_ALLOWLIST`

`NESTED_WRITE_ALLOWLIST` in `org-scope-nested.ts` is the named exception list. **It is empty**: BE-02
and BE-03 use scalar foreign keys and top-level calls only. To add an entry, give the model, the
relation field and the nested operations, say why the shape cannot reach another org's row, and add
a cross-org test for it to `tc-008-org-isolation.spec.ts`. A unit test fails while the list is not
empty, so the addition is a reviewed change.

### Nested cursors

A **`cursor` anywhere inside `include` or `select`** is refused at any depth (and in `_count`).
Prisma finds a nested cursor row by its own fields too (shown on Prisma 7: `id >= (SELECT id FROM
proctor_events WHERE id = $cursor)`), so it ranks the caller's rows against another org's row. The
fluent API (`session.findUnique(...).proctorEvents({ cursor })`) reaches the extension as a
`select` on the relation and is refused the same way. **Page nested relations with `where`,
`take` and `orderBy`.**

## Writing queries inside the scope

Prisma queries are lazy: `client.x.findMany()` sends nothing until something awaits it, and the
scope that counts is the one active at that moment. The context methods start a query that is
returned **directly** from the callback (`runInOrg(id, () => client.x.findMany())` works). Nothing
else is rescued, so:

- **`await` queries inside the callback.**
- **Never return queries wrapped in an object or an array** (`() => ({ rows: client.x.findMany() })`):
  they run when finally awaited, in whatever scope is active then, or with none (the call throws).
- **Never build a `$transaction([...])` array in one scope and run it in another.** Its queries run
  in the scope that is active when the batch runs: a batch built for org A and run in org B reads
  org B's rows; run in system scope it is unfiltered.
- The run methods return a native `Promise` for a returned query, never a `PrismaPromise`
  (`Scoped<T>` in `org-context.ts`).

## Errors and logging carry no argument values (FU-DB-70)

Errors are logged (pino writes the message, the stack and own properties such as `meta`), and
tokens, OTPs, hashes and media keys must never reach a log. Three rules:

- **The factory sets `errorFormat: 'minimal'`** (no code frame with the calling source lines).
- **Never enable query logging.** `log: ['query']` and `$on('query')` print every query with its
  parameters. The factory passes no `log` option, and a test fails if any source file turns it on.
- **The org-scoped client scrubs the values `minimal` leaves in** (`error-scrub.ts`). Shown on
  Prisma 7: a validation error prints the rejected arguments; `invalid input syntax for type uuid:
"<value>"` echoes the value (also from a failing raw query); a check or not-null violation lists
  the whole failing row in `meta.driverAdapterError.cause.detail`; and that driver error's own
  message, shown by `util.inspect`, repeats the database text. The scrub rewrites the error in place
  (so `instanceof` and `error.code` still work): free text that can hold values becomes a fixed
  sentence, the cause keeps only codes and names, a validation error keeps the names of the rejected
  arguments, and the SQLSTATE stays. A unique, foreign key, not-found, check or not-null violation
  keeps its message, which names a constraint or table and never a value. It sends no query.

**A bare `DriverAdapterError` is scrubbed too** (PR #82 review S1). Prisma wraps the adapter errors it
can map into a known request error (the adapter error then sits in `meta.driverAdapterError`), but
an error it cannot map is rethrown raw, and the commit of a transaction is not wrapped at all. Found
on Prisma 7.10 and Postgres 16: a `Serializable` transaction that fails at COMMIT (SQLSTATE 40001)
reaches the caller as a bare `DriverAdapterError` with `cause.kind` `TransactionWriteConflict`.
Its message and its `cause` (`originalMessage`, `detail`, `hint`) are the database's text, so
`scrubPrismaError` also takes an error with `name === 'DriverAdapterError'` and an object `cause`
(Prisma's own test; the class is not a dependency of this app). It keeps the class, the name, the
kind and the codes, drops the message, `detail`, `hint` and every other text whatever the SQLSTATE,
and puts a fixed sentence in the message. Two limits. The org-scoped client's extension does not see
`$transaction` itself, so **a commit failure is not scrubbed on its way out**: its text is the
database's fixed wording today (40001 names no value), and a caller or exception filter that logs an
error it did not get from a query call should pass it through `scrubPrismaError` first. And from
reading the 7.10 runtime (not reproduced): an adapter kind the runtime does not know becomes a plain
`Error` whose message is the cause as JSON; that is only possible if `@prisma/client` and
`@prisma/adapter-pg` drift apart, which the lockfile prevents.

`error-hygiene.spec.ts` proves it against Postgres: a unique violation on a known token hash, an
id that is not a uuid, a check and a foreign key violation, a record not found, validation errors, a
failing raw query, an interactive and a batch transaction, and a Serializable transaction that fails at commit. The plain factory client (the seed only) does
**not** scrub: do not log its errors as they are.

## `upsert` in an org scope is not a native upsert

In system scope (and on the plain client) `upsert` is one `INSERT ... ON CONFLICT DO UPDATE`. In
an org scope the org filter on `where` stops Prisma using it: it becomes `BEGIN`, a `SELECT`, an
`INSERT` or an `UPDATE`, a re-read `SELECT` and `COMMIT` (5 or 6 statements), and two concurrent
upserts of a missing row can raise `P2002`. `auth-bootstrap.spec.ts` pins the difference. Hot
ingest paths (events, keystroke batches, media chunks) should use `createMany({ skipDuplicates: true })`,
which stays one statement, and be ready to retry on `P2002` elsewhere.

## Rules for services (from the follow-ups)

- Look a session up from its invitation with
  `prisma.client.session.findUnique({ where: { invitationId } })`, never `invitation.sessions[0]`.
  `Invitation.sessions` is a list by design (FU-DB-04).
- Always pass `allowedLanguages` (question versions) and `events` (webhook endpoints) explicitly:
  the columns are NOT NULL with no database default, and Prisma treats list inputs as optional
  (FU-DB-07).
- Relate rows with scalar foreign keys, through Prisma's unchecked inputs, one top-level call per
  row; never `connect` and the other nested relation writes (see "Write with scalar foreign keys
  and separate calls").
- Re-parenting a row (an update of a path model's first-hop key, `testSection.testId`,
  `proctorEvent.sessionId`) in an org scope is rule (i): load the new parent through the scoped
  client first, and answer 404 on a miss. System scope refuses it (FU-DB-107); do not re-parent from
  there.
- Connect as `app_user` (`DATABASE_URL`). `MIGRATION_DATABASE_URL` never appears in API code.

## Files

| File                                           | What it holds                                                                                                                                                                  |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `create-prisma-client.ts`                      | The only `new PrismaClient` (ADR 0009 section 4.2)                                                                                                                             |
| `prisma.service.ts`, `database.module.ts`      | The Nest service (connect, disconnect) and the global module                                                                                                                   |
| `org-scope-map.ts`                             | The scope map and `orgFilter`                                                                                                                                                  |
| `org-scope-args.ts`                            | Pure argument rewriting per operation, and the operation coverage check                                                                                                        |
| `org-scope-nested.ts`                          | The nested guards: nested writes that reach another org's rows, and nested cursors                                                                                             |
| `org-scope-relations.ts`                       | Every foreign key classified (`FK_CLASSES`, `RULE_I_REFERENCES`), the first-hop column of each path model (`scopeHopColumn`) and the side of every relation that holds the key |
| `org-scope.extension.ts`                       | The `$extends` query extension and `OrgScopedPrismaClient`                                                                                                                     |
| `org-context.ts`, `org-context.interceptor.ts` | The AsyncLocalStorage context, its API, and the HTTP population point                                                                                                          |
| `session-scope-map.ts`                         | CS-4.2 `SESSION_SCOPE` (the ten session-path models) and CS-4.3 `CANDIDATE_MODELS` (the allowlist, row filters)                                                                |
| `session-scope-args.ts`                        | Pure argument rewriting for a session scope: allowlist gate, creates, session keys, the filters and the existence check's `where`                                              |
| `candidate-relations.ts`                       | CS-4.5 relation vectors 1 to 5 refused in a CANDIDATE scope                                                                                                                    |
| `candidate-facts.ts`                           | `setCandidateFacts`: **CandidateSessionGuard only**, not exported from `index.ts`                                                                                              |
| `errors.ts`                                    | `OrgContextMissingError`, `OrgScopeViolationError`, `RawQueryNotAllowedError`                                                                                                  |
| `error-scrub.ts`                               | Keeps argument values out of the Prisma errors that are logged (FU-DB-70)                                                                                                      |
| `testing/`                                     | Test helpers (excluded from the build): throwaway migrated Postgres, fixtures, scope checks                                                                                    |

Tests (`*.spec.ts`) name TC-008 and NFR-04 or FR-103: the map completeness test and its failure
cases, the argument rewriting for every operation and model, the context and interceptor, the
extension without a database, the TC-008 matrix against a real Postgres (all read operations and the
update and delete operations as org A against org B's rows in all 31 models, with positive controls;
upsert, create, cursors, nested writes and the HTTP path on chosen models), and a smoke test that builds the API
and runs the compiled client and `DatabaseModule` on Node. `auth-bootstrap.spec.ts` covers what
BE-02's auth needs: raw SQL and transactions inside system scope, and the statement counts
(NFR-04, FR-104).
