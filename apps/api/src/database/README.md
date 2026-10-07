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
which is the review point. A sixth rule guards not the org scope but **who may take the per-session
write lock**: `database/session-locks` (see "Session write locks" below), with an empty allowlist: only
SessionStateService may be added (who calls what is in "Session write locks" below).

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
> (FU-DB-180 to FU-DB-198, FU-DB-210 and the rows after it). **PR 1** built the two actors, the session
> filter, the CANDIDATE model allowlist, relation vectors 1 to 5 and the fluent API, and CS-4.4's write
> column as an allowlist. **PR 2** (this one) builds CS-4.4's **read allowlists with `omit`**, the
> **explicit-only columns and `withGrant`** (eleven grant sites), the **submissions RUN filter** and the
> **consents create** under the ConsentService grant (item 9, ADR 0013 PR #178). Not built yet (PR 3): the
> FU-DB-67 call-site test and the fluent-API lint. CandidateSessionGuard and SessionJobProcessor are
> BE-07; `render-question` projections are CS-4.6.
>
> **BE-07 may rely on CANDIDATE column safety from this PR on** (FU-DB-190): a candidate query names only
> readable columns, a call that returns rows with no `select` gets the default `omit`, an explicit-only
> column needs its grant, and a write carries only the columns of the model's write list plus the ones a
> grant unlocks. Until the guard calls the candidate-facts setter, **every** candidate query throws.

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
orgContext.withGrant<T>(request: GrantRequest, fn: () => T): Scoped<T>                   // the eleven CS-4.4 grant sites only (below)
```

- `runAsCandidate` is called by **CandidateSessionGuard only**, from the verified token claims
  (`oid`, `sid`). `runAsSessionJob` is called by **SessionJobProcessor only**, from the job payload,
  after `detachForSessionJob`. Both validate both ids as uuids, lower-case them, and send no SQL.
- **`detachForSessionJob` is for SessionJobProcessor only.** It asserts that the store is empty (no scope,
  no `runRawSql` hatch, no grant) and runs `fn` in a fresh empty store; in any scope, any system scope
  (`BACKGROUND_JOB` included) or open hatch it throws. A BullMQ worker is built at module init, outside
  any scope, and each session job runs in its own worker callback: this is where the processor proves
  that it did not inherit a scope. A candidate scope cannot leave itself.
- **`setCandidateFacts` is for CandidateSessionGuard only.** It lives in `candidate-facts.ts`, which is
  **not exported from `index.ts`**. The setter itself is a **closure** that `org-context.ts` hands out
  once per process and `candidate-facts.ts` holds; it is not a method of `OrgContextService` under any
  name or symbol, so reflection on the service finds nothing to call, and a second claim throws. The
  scope builders (`enter`, `enterSession`, `runWith`) are ES `#private`, not TypeScript `private`, so
  they do not exist on the object at runtime. The facts are set once per CANDIDATE scope (frozen; a
  second call, a SERVICE scope or no scope throws). Until they are set, a read of `candidates`,
  `invitations` or `tests` throws. The paths left are a deep import of `org-context.ts` or
  `candidate-facts.ts`, which FU-DB-67 pins by importer (FU-DB-189). `database.module.ts` imports
  `candidate-facts.ts` for its side effect, so the claim is made when the module loads (every app loads it),
  not when the guard's file does, and a module that imports `org-context.ts` cannot claim the setter first
  (`database-boot.spec.ts`).

### The guard recipe (DL-31 option (a), FU-DB-185 and FU-DB-174)

The facts come from rows the guard loads **before** it enters the candidate scope, because inside it
`invitations` and `candidates` are filtered by those very facts, `include` is refused and the setter
runs once. Interim, until the hub confirms:

```ts
// 1. The only org-wide read, in trusted guard code: two selects in a plain org scope.
const loaded = await orgContext.runInOrg(oid, async () => {
  const session = await prisma.client.session.findUnique({
    where: { id: sid },
    select: { invitationId: true },
  });
  if (session === null) throw new UnauthorizedException(); // another org's session is not found
  return prisma.client.invitation.findUnique({
    where: { id: session.invitationId },
    select: { id: true, candidateId: true, testId: true },
  });
});
// 2. Leave that scope, enter the candidate scope and set the facts before any other query.
return orgContext.runAsCandidate(oid, sid, async () => {
  setCandidateFacts(orgContext, {
    candidateId: loaded.candidateId,
    invitationId: loaded.id,
    testId: loaded.testId,
  });
  // 3. From here on every query is session-scoped: check auth_epoch, load the CandidateContext.
});
```

The ids are read from the database, never from the request. **A wrong fact can only narrow**: each of
the three filters is ANDed with one derived from the scope's own session (`sid` comes from the verified
token), so a guard that sets another candidate's facts of the same org reads nothing (S2). The `sessions`
read in step 1 carries `oid` from the verified claims through the org filter, so a session of another
org is not found.

### Entering and nesting (CS-4.1; ADR 0006 section 8.4)

| Current scope                             | `runAsCandidate`, `runAsSessionJob`           | `runInOrg(same org)`                                                 | `runAsUser`, `runSystem`, the other actor, another org, `detachForSessionJob` |
| ----------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| none                                      | allowed                                       | allowed                                                              | `runAsUser`, `runSystem`, `detachForSessionJob`: allowed                      |
| staff, plain org, any system scope, hatch | **throws**                                    | n/a                                                                  | n/a                                                                           |
| a session scope (either actor)            | **throws**, the same ids included (FU-DB-180) | allowed; the session and the actor stay (the very same scope object) | **throw**                                                                     |

A session scope only narrows: nothing inside it can drop or change the session. Entering from "no
scope only" also means no `runRawSql` hatch can carry into it. The org id is lower-cased in every org
scope, so `A` and `a` are one org.

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
  (pinned by tests: a `submission.create` is 2 statements, the `COUNT` and the `INSERT`; a `createMany`
  of 3 rows is 2, and so is one of 30; a create that needs no check is 1). It runs on the client's own
  connection, **outside a caller's interactive `$transaction`**: a session question created earlier in
  the same, uncommitted transaction is not visible to it, so the create fails closed (FU-DB-182,
  FU-DB-192).
- **Session keys are immutable.** An `update`, `updateMany`, `updateManyAndReturn` or the update branch
  of `upsert` that writes `session_id` or a `session_question_id` throws, whatever the value (the
  `{ set }` form too; FU-DB-181): `sessionId` and `id` of sessions and session_questions,
  `sessionQuestionId` of submissions and keystroke batches, and **`sessions.invitationId`** (the
  composite foreign key allows any invitation of the org, and the CS-4.3 filters of `invitations`,
  `candidates` and `tests` follow it). In a CANDIDATE scope also **`session_questions.questionVersionId`,
  `testQuestionId` and `variantId`**, which feed the `questions` filter and the question content.
- **Raw SQL is refused** in any session scope, **even inside `runRawSql`** (ADR 0006 section 8.5).
  Session jobs use the query API.
- **A cursor is refused** on the session-path models in both actors (it ranks rows against a row named
  by its own fields, which could be another session's), and for a CANDIDATE on every model.
- **Nested relation writes** throw in both actors, as in every scope (ADR 0006 section 8.2).
- **Models outside the table** (`tests`, `candidates`, `questions`, ...) get the org filter only.
  `session_reviews` and `webhook_deliveries` carry a `session_id` but are not on the CS-4.2 list, so they
  are org-only in SERVICE scope too (FU-DB-183, FU-DB-191; one test pins it).

### SERVICE (`runAsSessionJob`): no allowlist, no column limits (CS-4.1)

The org filter plus the session filter, nothing else: every model, every column, relations in `include`,
`select`, `where` and `orderBy`, and no `select` is required. The session filter covers **top-level**
queries; nested reads in SERVICE scope follow foreign keys without it and stay a rule (i) review item
(ADR 0013 CS-4.1).

### CANDIDATE (`runAsCandidate`): deny by default (CS-4.3, CS-4.5)

A model that is not listed throws, for every operation, before any query, and before the `unscoped`
early return of the extension. Read-only models refuse every write operation, and a session-path model
takes only the creates and updates its CS-4.4 write list grants.

**A candidate deletes nothing** (FU-DB-184). Nothing a candidate writes names `id`, `orgId`, `createdAt` or
`updatedAt`, and an update never names a session key.

| Model                                 | Access                                                                                                                                                                                                                                                                                      | Row filter, on top of the org filter                                                                                                                                                                            |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Session`                             | read; update `lastHeartbeat`; **`status`, `pauseReasons`, `submittedAt` only under the SessionStateService grant, `deviceInfo` only under DeviceInfoService**; no create                                                                                                                    | the session filter                                                                                                                                                                                              |
| `SessionQuestion`                     | read; update `finalCode`, `finalLanguage`, `answer`; no create                                                                                                                                                                                                                              | the session filter                                                                                                                                                                                              |
| `SessionSection`                      | read; **no write at all** (CS-4.4 "none")                                                                                                                                                                                                                                                   | the session filter                                                                                                                                                                                              |
| `Submission`                          | read (`results`, `passed`, `total` only through the RUN filter); **create only** (`sessionQuestionId`, `kind`, `language`, `sourceCode`, and `results`, `passed`, `total` on a `RUN` row); no update                                                                                        | the session filter (through the session question)                                                                                                                                                               |
| `IdentityCheck`                       | read; **create only** (`attempt`, `idImageKey`, `selfieKey`, `livenessPassed`; the two keys are the sealed copies inside the session's own prefix); no update. **`status` (so never `WAIVED`) is not writable, and the ADR 0015 `video_check_*` columns are neither readable nor writable** | the session filter                                                                                                                                                                                              |
| `ProctorEventBatch`, `KeystrokeBatch` | read (`keystroke_batches.id` is not readable: read by `seq`); **create only**; no update                                                                                                                                                                                                    | the session filter                                                                                                                                                                                              |
| `MediaChunk`                          | read; create and update (its eight columns; `objectKey` on a write stays inside the session's own prefix)                                                                                                                                                                                   | the session filter                                                                                                                                                                                              |
| `ProctorEvent`                        | read; create (the CS-4.4 columns; **not a server-only `type`**); update `durationMs` only                                                                                                                                                                                                   | the session filter and **`source = 'CLIENT'`** (SERVER events stay hidden); a create carries `source = 'CLIENT'`                                                                                                |
| `Consent`                             | read (`id`, `consentTextId`, `signedAt`, `declinedAt`); **one `create`, only under the ConsentService (create) grant**; no update, upsert, delete or batch                                                                                                                                  | the session filter                                                                                                                                                                                              |
| `Organization`                        | read                                                                                                                                                                                                                                                                                        | `id = orgId` (the org filter of the tenant root)                                                                                                                                                                |
| `Candidate`                           | read                                                                                                                                                                                                                                                                                        | `id = ctx.candidateId` **and** an invitation of this session (`invitations: { some: { sessions: { some: { id: sid } } } }`)                                                                                     |
| `Invitation`                          | read                                                                                                                                                                                                                                                                                        | `id = ctx.invitationId` **and** `sessions: { some: { id: sid } }`                                                                                                                                               |
| `Test`                                | read                                                                                                                                                                                                                                                                                        | `id = ctx.testId` **and** an invitation of this session                                                                                                                                                         |
| `TestSection`                         | read                                                                                                                                                                                                                                                                                        | `sessionSections: { some: { sessionId } }` (injected)                                                                                                                                                           |
| `Question`                            | read                                                                                                                                                                                                                                                                                        | `versions: { some: { sessionQuestions: { some: { sessionId } } } }` (injected)                                                                                                                                  |
| `ConsentText`, `TestQuestion`         | read **only under a grant of that model** (`id IN grant.ids`; `test_questions` also the session's own questions); no write                                                                                                                                                                  | the org filter, the grant, and for `TestQuestion` `sessionQuestions: { some: { sessionId } }`                                                                                                                   |
| every other model                     | **throws**                                                                                                                                                                                                                                                                                  | `User`, `RefreshToken`, `AuditLog`, `QuestionVersion`, `TestCase`, `QuestionVariant`, `VariantTestCase`, `AiReferenceSolution`, `SessionReview`, `FlagDecision`, `Appeal`, `WebhookEndpoint`, `WebhookDelivery` |

A filter that needs a fact **throws while the fact is unset**. The facts come from the guard recipe above.

**Relation vectors 1 to 6 throw** in a CANDIDATE scope, on the caller's arguments, before the extension
adds its own relation filters (so those never trip the check):

| #   | Vector                                                                                                                                                                                                            |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | a relation field in `include`                                                                                                                                                                                     |
| 2   | a relation field in `select`                                                                                                                                                                                      |
| 3   | a relation filter in `where` or `having` (`some`, `every`, `none`, `is`, `isNot`, or a plain relation object), at any depth under `AND`, `OR` and `NOT`                                                           |
| 4   | a relation field in `orderBy`                                                                                                                                                                                     |
| 5   | a relation `_count` in `select` or `include` (the row `_count` of `aggregate`, `groupBy` and `count` is not a relation count and stays)                                                                           |
| 6   | the fluent API (`findUnique(...).questionVersion()`): Prisma 7.10 runs it as a `findUnique` on the parent model with a relation `select`, so vector 2 refuses it (tested for every find operation and for chains) |

Load each model with its own scoped call instead. A relation field is any field in the relation table
of `org-scope-relations.ts`, whatever its value (`false`, `null` and `{}` too).

### Column control (CS-4.4): the read allowlist, `omit`, the explicit-only columns, the RUN filter

**Reads are CS-4.4's "Read" column as an allowlist** (`CANDIDATE_READ` in `candidate-interim.ts`; the file
keeps its PR 1 name because the consent-access scan of Database B pins the path, FU-DB-211). Every column
of the 18 models on the CANDIDATE allowlist is exactly one of:

| Class        | Meaning                                                                                                                                                                                                                                                                      |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **readable** | CS-4.4's read column: nameable in `select`, `where`, `having`, `orderBy`, `distinct`, `groupBy`'s `by` and every aggregate, and in the default select                                                                                                                        |
| **key**      | the ids of the candidate's own org, session and test (`orgId`, `sessionId`, `sessionQuestionId`, `testId`): readable and filterable although CS-4.4 does not list them (PR 1's choice, FU-DB-195 (k); compound keys name them)                                               |
| **explicit** | `sessions.hmacKeyEnc` and `deviceInfo`, `media_chunks.objectKey`, `organizations.settings`, `tests.settings`, `invitations.accommodations`, `session_questions.testQuestionId`: never in the default select, nameable only under a grant of that model that names the column |
| **RUN-only** | `submissions.results`, `passed`, `total`: never in the default select; naming one ANDs `kind = 'RUN'` (below)                                                                                                                                                                |
| **hidden**   | everything else: never nameable, always omitted. This is every column that CS-4.4 does not list, and `score` and `sourceCode` of submissions, `signedName`, `ip`, `userAgent` and `ageConfirmedAt` (C-30, D-55) of consents (a grant changes none of it)                     |

`candidate-interim.spec.ts` holds its own copy of the ADR's column and fails when `CANDIDATE_READ` differs,
and when a column of the schema is none of the five (a new column breaks the build until it is classified).

- **`omit` is the default select, on every row-returning operation.** A call that returns rows and names no
  `select` (`findUnique`, `findUniqueOrThrow`, `findFirst`, `findFirstOrThrow`, `findMany`, `create`,
  `createManyAndReturn`, `update`, `updateManyAndReturn`, `upsert`) runs with an `omit` of every scalar
  column that is not in its default select. The list is **computed from the generated client**
  (`Prisma.<Model>ScalarFieldEnum`) minus the readable and key columns, so a column that a migration adds is
  hidden until it is listed, not visible until it is denied. A caller's own `omit` is merged and ours wins
  (`omit: { hmacKeyEnc: false }` brings nothing back); a `select` together with an `omit` is refused (Prisma
  refuses it too); a `select` or an `omit` that is not an object is refused. The row that a write returns has
  the same shape as a read. **PR 1's rule "every read must name its `select`" is dropped** (FU-DB-190). The
  `omit` is added for all **eleven** row-returning operations (the ten above and `delete`, which a candidate
  never reaches: it is refused on every model first). What the tests cover, exactly:
  `candidate-interim.spec.ts` checks the added `omit` of every model for every one of those operations that
  the model allows; the Postgres sweep (`cs4-session-isolation.spec.ts`) runs a bare `findMany`, `findFirst`,
  `findFirstOrThrow`, `findUnique` and `findUniqueOrThrow` on each of the 16 session and org models and
  compares the returned columns with the default select; `cs4-columns-grants.spec.ts` runs a bare `update`
  (`sessions`, `session_questions`, `media_chunks`: no `objectKey`), `updateManyAndReturn` (`sessions`),
  `create` (`proctor_events`, `submissions`, `consents`), `createManyAndReturn` (`proctor_events`) and `upsert`
  (`media_chunks`), and a bare read of `test_questions` and `consent_texts` under their grants.
  `createManyAndReturn` and `updateManyAndReturn` on the other models are covered by the pure layer only.
  Services should still name a `select` for what they need, because the TypeScript result type does not know
  about the `omit`.
- **The read list governs everything that can leak a value**: `select`, `where` (a JSON-path filter on a
  hidden column included), `having`, `orderBy`, `distinct`, `by`, `_count`, `_sum`, `_avg`, `_min`, `_max`
  and the `select` of `count`. A compound unique selector (`orgId_slug`) is read through to its columns, and a
  unique key that is itself hidden (`invitations.tokenHash`, `sessions.invitationId`) cannot be looked up by.
  `_all` is allowed in `count`'s `select` and in `_count` only. A field reference
  (`client.model.fields.column`) is refused in a `where` and a `having` (it compares a column without naming
  it).
- **Explicit-only** columns are enforced at runtime by the grant (next section), not by a lint rule. Even under
  the grant they stay out of the default select: a service names them in `select`.
- **The RUN filter** (CS-4.4, `submissions`). Whenever `results`, `passed` or `total` appears anywhere in
  `select`, `where`, `having`, `orderBy`, `distinct`, `by` or an aggregate, the extension ANDs `kind: 'RUN'` into
  the query, next to the org and session filters. So `count({ where: { kind: 'SUBMIT', passed: N } })` runs as
  `kind = SUBMIT AND kind = RUN` and answers 0 for every N; a `findMany` that selects `results` returns RUN rows
  only; `aggregate`, `groupBy` and `orderBy` over those columns see RUN rows only. A create that reads them back
  (a `select` on `create` or `createManyAndReturn`) throws unless every row it writes is a `RUN` row (a create
  has no `where` to filter). `score` and `sourceCode` are never readable. The three columns are written on a
  create of a `RUN` row only (`kind: 'RUN'` in the same row); a `SUBMIT` row, or a row with no `kind`, that
  names one throws. A submission has no candidate update, so this is the only way they are written. (The default
  select omits them, so a bare read never needs the filter; this is the stricter reading, FU-DB-213.)
- **A candidate sees nothing until the facts are set.** In CANDIDATE scope every query on every model throws
  while the candidate facts are unset (ADR 0013 CS-4.4); PR 1 threw only on the three models whose filters use a
  fact (FU-DB-214).
- **A `select` names at least one column with `true`** (review of #185, S2). `select: {}`, `{ id: false }` and
  `{ id: undefined }` are refused in a CANDIDATE scope with no statement; a value other than `true`, `false` or
  `undefined` is refused too. Prisma 7.10 answers those shapes with a validation error today, which is a Prisma
  detail and not a promise, so the scope does not rely on it. A hidden column named `false` is still refused by
  name.
- **Arguments must be plain, in every scope** (review of #185, B1; `plain-args.ts`). Prisma 7.10 clones the
  arguments before the extension sees them: an inherited key is copied to an own key (so every check sees it),
  but a key named `__proto__` that `JSON.parse` made an own property becomes the **prototype** of the top-level
  args, and stays an own key in a nested object. The checks read own keys and then forward a spread copy, which
  keeps own keys only, so `{"__proto__":{"select":{"id":true}}}` used to make the CANDIDATE scope see a `select`,
  add no `omit`, and let Prisma return every column (the sealed key, `accommodations`, SUBMIT `results`, `score`,
  a consent's private columns). The hook now refuses, **before any other check and in every scope** (candidate,
  job, staff, plain org, system): top-level args whose prototype is not `Object.prototype` or `null` or that carry
  an own `__proto__`; a structure object (`where`, `select`, `orderBy`, `having`, `cursor`, `omit`, `include`,
  the aggregates, walked to a depth of 64) with a foreign prototype, an own `__proto__` or an inherited key; and
  a `data` row (each row of a `createMany`) and one level below a column with an own `__proto__` or an inherited
  key. Json contents are not walked, so an ingest path pays O(columns). Dates, byte arrays, Decimals, the Json
  null sentinels and field references are values, not structure. **So is the operand of a Json filter** (re-review of #185, S1): on a Json column (`JSON_COLUMNS`, the schema's twelve, compared with the generated client by a spec) the operand of `equals`, `not`, `in`, `notIn`, `array_*` and `string_*` is a stored document, which may be nested past the limit or hold an own `__proto__`, and Prisma never reads it as structure; the compare-and-set of retention, the org settings and the device-info fence passes it. The `where` and `having` of a call are walked model by model (AND, OR, NOT and relation filters follow the model), the filter object itself, a `path` and everything else are still walked, and a `where` nested in a `select` or `include` is walked whole. (Prisma 7.10 drops an own `__proto__` key from such an operand, so a compare-and-set against a document that raw SQL stored with one matches nothing: FU-DB-222.) A class instance with no enumerable inherited
  key (a DTO) passes as a `data` row. The checks themselves read `select`, `omit`, `where`, `data` and the rest
  through `ownValue` and an own-key copy of the args, so a key that is not the caller's own is never seen.

**Writes are CS-4.4's "Write" column as an allowlist** (`CANDIDATE_MODELS` in `session-scope-map.ts`): a
create and an update carry only the columns listed for the model, anything else throws, an update on a
create-only model throws, a create on an update-only model throws, and `id`, `orgId` and the timestamps are
never named. A create that names an `id` is refused the same way whether the id exists or not, before any
statement. `sessionId` is allowed on a create because Prisma's unchecked create input requires it; it must be
the scope's own. A column that CS-4.4 opens only under a grant (`grantedUpdate`: `sessions.status`,
`pauseReasons`, `submittedAt`, `deviceInfo`) is writable while a grant of that model names it, and a grant never
adds an operation the model refuses. Only the column is unlocked: the CS-4.4a transition rules are the
service's. `candidate-interim.spec.ts` tries **every column of every model** against every create and update
operation: a listed column passes, every other column throws; and it holds the CS-4.4 column apart from the map
so a widened list fails.

- **The consents create** (item 9, ADR 0013 PR #178; FR-401, C-17). A candidate scope creates the `consents`
  row **once, with `create`, under the ConsentService (create) grant** whose `ids` are `[ctx.sessionId]`. There
  is no update, delete, upsert or `createMany`: sign and decline are one create each, and write-once is
  `UNIQUE(session_id)` plus the CHECKs, so a second create fails with **P2002** (BE-07 answers 409). The create
  carries `sessionId` and `consentTextId`, which ConsentService sets from the context and the text it checked
  (Prisma's unchecked create input requires them); **the extension verifies them** and throws on any mismatch:
  `sessionId` must be the scope's own session and one of the grant's ids, and `consentTextId` must be
  `organizations.current_consent_text_id` of the scope's org. That check is **one read selecting only that
  column, `where id = ctx.orgId`, on the factory client outside the caller's transaction** (FU-DB-192), after the
  facts check and before the insert. A create is therefore **two statements** (the read, then the insert), also
  inside a `$transaction` (the read then uses a second connection). A text published between the read and the
  insert is not caught by the extension; the read narrows that window, ConsentService's own version check
  (`CONSENT_TEXT_CHANGED`) is the other half. Exactly one of `signedAt` and `declinedAt` is set, `signedName` comes
  with `signedAt`, a sign carries `ageConfirmedAt` as a valid `Date` (`createNeedsDate`: an ISO string, a number,
  `null` or an invalid Date is refused) and a decline never carries it (`createForbids`), all thrown before the
  database with the column names only. These rules bind the CANDIDATE create only: a SERVICE or STAFF write and
  every update, the consent-PDF job's update of a pre-C-30 row included, are untouched. Writable: `signedName`, `signedAt`, `declinedAt`,
  `ageConfirmedAt` (C-30, D-55: server time, set at sign; ConsentService requires the body's `ageConfirmed: true`;
  the database has no CHECK on it, which would block the PDF job's update of a row signed before C-30, so the
  create is the net under the service, FU-DB-260), `ip`, `userAgent`; `pdfKey`, `pdfGeneratedAt` and `copyEmailedAt` are the consent-PDF job's (SERVICE). The row
  the create returns omits `signedName`, `ip`, `userAgent` and `ageConfirmedAt`, and a `select` of them throws,
  grant or not.
  The create and `SessionStateService.transition()` run **one after the other in one transaction, each under
  its own grant** (grants do not nest; tested, with the rollback).
- **`proctor_events` (CS-4.4, permanent):** reads and writes see `source = 'CLIENT'` rows only, a create
  carries `source = 'CLIENT'` (stamped when missing, refused when anything else) and an update writes
  `durationMs` only. `source` itself is not a readable column.
- **Object keys stay inside the session's prefix** (`CANDIDATE_OBJECT_KEYS`; ADR 0013 section 5.7, ADR 0004
  section 9.2). A candidate write of `media_chunks.objectKey`, `identity_checks.idImageKey` and `selfieKey`
  or `proctor_events.evidenceKey` must be `orgs/{orgId}/sessions/{sessionId}/` (the scope's own ids) and then
  the folder and shape of the column: `media/{stream}/{segment:06d}/{seq:08d}.webm` (the stream is the
  `MediaStream` enum of the schema), `identity/{attempt}/sealed/{id|selfie}-{ULID}.jpg` (**the sealed copy
  only**) and `evidence/{ULID}.jpg` (not `evidence/sealed/`). A ULID is 26 characters of Crockford base32.
  - **The key is bound to its own row.** The key's own parts must equal the row's `stream`, `segment`, `seq`
    (or the identity `attempt`): the values the same write carries (a create that leaves out `segment` or
    `attempt` gets the schema default), and, **on an update, the values its `where` pins** (FU-DB-199): an
    update, `updateMany`, `updateManyAndReturn`, and the update branch of an `upsert`, by
    `sessionId_stream_seq` or by plain equality (`stream: 'WEBCAM'`, `seq: { equals: 42 }`). What the write
    carries wins over the `where` (the row after the update); a `where` that names none of them binds nothing
    (`where: { id }`); a `where` that **mentions** one in a form that pins nothing (a range, `in`, `not`,
    anything under `AND`, `OR` or `NOT`) next to a key write is refused, because the row the key belongs to is
    not determined. Whether a candidate may update `stream`, `segment` or `seq` at all is an open question for
    the architect (CS-4.4 lists them; FU-DB-199).
  - Another session's prefix, another org's, `..`, `//`, a leading `/`, a backslash, a control character and
    any other shape are refused; `null` is accepted on a create only. The message names the model and the
    column, never the key. A SERVICE scope writes any key.
  - **The table holds predicate functions, not RegExp objects** (a frozen RegExp can still be rewritten with
    `compile`); `deepFreeze` refuses a RegExp.
- **`keystroke_batches.id` is not readable** (it is a global identity counter); a candidate reads its batches
  by `seq`.
- **A candidate create never carries a server-only event type** (`SERVER_ONLY_EVENT_TYPES`: exactly the
  `EVENT_TYPES` of `packages/shared` that are not in `CLIENT_EVENT_TYPES`, 12 of them). `FACE_MISMATCH` is **not**
  on it: it is still in `CLIENT_EVENT_TYPES` (FU-DB-197).
- **The scope tables are frozen** (`deep-freeze.ts`): `SESSION_SCOPE`, `CANDIDATE_MODELS`, `CANDIDATE_READ`,
  `GRANT_SITES`, `COMPOUND_UNIQUES` and the other lists throw a `TypeError` on a write.

### Grants: `withGrant` and the eleven CS-4.4 sites (ADR 0013 CS-4.4, ADR 0006 section 8.5)

```ts
orgContext.withGrant<T>(
  request: { model: string; columns: readonly string[]; ids: readonly (string | bigint | number)[] },
  fn: () => T,
): Scoped<T>
```

`model` is the **Prisma model name** (`Session`, `MediaChunk`, `Consent`; not `sessions`), `columns` are Prisma
field names (`hmacKeyEnc`, `legalApprovedAt`), `ids` are primary keys. **Private to the grant sites below**:
`call-sites.spec.ts` pins them (a slice of FU-DB-67, FU-DB-189): it scans every non-test file under
`apps/api/src` (`.ts`, `.mts`, `.cts`, `.js`, `.mjs`, `.cjs`; any other extension fails the scan) for a USE of
`withGrant`, `claimCandidateFactsSetter`, `setCandidateFacts` and `detachForSessionJob`, and the three session-lock
names `guardLive`, `lockForAccommodation` and `lockAnySession` (their own rules are in "Session write locks"; a call,
a definition, a member access, a bracket access, an exact string, or the name inside braces; a mention in a comment
or in prose is not a use), and a file that is not on its per-file list fails. **Today the list holds the database
files that define them** (`org-context.ts`, `candidate-facts.ts`, `session-locks.ts`) **and BE-07's
`candidate/candidate-scope.ts`**: `SessionJobProcessor`, the state file and the grant-site services are added to
`CALL_SITES` in the PR that builds them, one entry per file, with the CS-4.4 grant site(s) it holds. **The guard pins files, not grants**:
PR 3 adds an AST check (each `withGrant(` takes an object literal whose `model` and `columns` match the file's
declared `sites`, and no function forwards a parameter as the request), and no BE-07 grant site merges before
it exists (a hard gate, FU-DB-189 and FU-DB-190); until then a run-time name, a unicode escape, `require` and
`moduleRef` are known misses. It is a method of `OrgContextService`, so a service calls it
with the service it already has:

```ts
// KeyService: read the sealed key of the context's session.
const key = await this.orgContext.withGrant(
  { model: 'Session', columns: ['hmacKeyEnc'], ids: [ctx.sessionId] },
  () =>
    this.prisma.client.session.findUniqueOrThrow({
      where: { id: ctx.sessionId },
      select: { hmacKeyEnc: true },
    }),
);
```

- **All three fields are mandatory; an empty `ids` throws**, and so does a model without a grant site, an empty
  or duplicated `columns`, a column that is not on the model, and columns of two sites in one grant (a grant is
  one service: `['status', 'hmacKeyEnc']` throws). `ids` are normalised: lower-case uuids and no duplicates, or
  positive integers as `bigint` for `media_chunks`. `ids` are **never request input**: read them in the scope,
  or resolve them through CS-2 first.
- **It needs an org scope** (none or a system scope throws) and **does not nest** (a second grant inside the
  first, or inside a callback that outlived it, throws). It is allowed in any org scope (staff, plain org,
  CANDIDATE, SERVICE), but the extension enforces it in a CANDIDATE scope only: the other actors have no column
  limit, so the grant is validated and carries no filter there.
- **What it does in a CANDIDATE scope.** It unlocks exactly its columns on exactly its model: the read of an
  explicit-only column, the write of a granted column (`status`, `pauseReasons`, `submittedAt`, `deviceInfo`),
  the read of a model that is readable only under a grant (`consent_texts`, `test_questions`, through the grant's
  columns), or the one `consents` create. **`id IN ids` is ANDed into every query on that model** (a create
  grant has no `where`, so its `ids` constrain the create's `sessionId` instead). Grants never widen the model
  allowlist, the session filter, the org filter or the facts filters: candidate A's grant naming B's id reaches
  nothing of B's (tested against Postgres for every site).
- **Lifetime.** The grant object has an `active` flag that is cleared in a `finally` when `fn` settles (return,
  throw, resolve or reject). The extension refuses **every** query that runs under an ended grant, raw SQL and
  other models included. AsyncLocalStorage keeps the store of work that `fn` started and did not await (a
  promise, `setTimeout`, an emitter or a stream callback) alive after `fn` settles, so a query from there finds
  the ended grant and throws (`org-context-grant.spec.ts` and `cs4-columns-grants.spec.ts`). The flag lives in a
  module-private set: a copy of the grant object is a snapshot, and nothing outside can switch it on.
- **Await inside `fn`.** Like the scope functions, `withGrant` starts a returned thenable inside the grant. A
  lazy Prisma query that is returned inside an object is not started there: await queries inside `fn`.

| Grant site (BE-07)                        | `model`           | `columns`                                                                                                          | `ids`                                                      | `mode`   |
| ----------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- | -------- |
| `SessionStateService.transition()`        | `Session`         | `status`, `pauseReasons`, `submittedAt` (write)                                                                    | `[ctx.sessionId]`                                          | `rows`   |
| `KeyService`                              | `Session`         | `hmacKeyEnc` (read)                                                                                                | `[ctx.sessionId]`                                          | `rows`   |
| `DeviceInfoService`                       | `Session`         | `deviceInfo` (read and write)                                                                                      | `[ctx.sessionId]`                                          | `rows`   |
| `StorageService`                          | `MediaChunk`      | `objectKey` (read)                                                                                                 | ids of the chunk rows, as `bigint`, resolved by CS-2       | `rows`   |
| `OrgSettingsService`                      | `Organization`    | `settings` (read)                                                                                                  | `[ctx.orgId]`                                              | `rows`   |
| `TestSettingsService`                     | `Test`            | `settings` (read)                                                                                                  | `[ctx.testId]`                                             | `rows`   |
| `AccommodationsService` (projection only) | `Invitation`      | `accommodations` (read)                                                                                            | `[ctx.invitationId]`                                       | `rows`   |
| `SectionGateService`, step 1              | `SessionQuestion` | `testQuestionId` (read)                                                                                            | `[sessionQuestionId resolved through CS-2]`                | `rows`   |
| `SectionGateService`, step 2              | `TestQuestion`    | `id`, `sectionId` (read)                                                                                           | `[test_question_id from step 1]`                           | `rows`   |
| `ConsentService` (consent text)           | `ConsentText`     | `id`, `version`, `bodyMd`, `legalApprovedAt` (read)                                                                | `[current_consent_text_id, the session's consent_text_id]` | `rows`   |
| `ConsentService` (create)                 | `Consent`         | `sessionId`, `consentTextId`, `signedName`, `signedAt`, `declinedAt`, `ageConfirmedAt`, `ip`, `userAgent` (create) | `[ctx.sessionId]`                                          | `create` |

`CandidateSessionGuard` has **no grant** (DL-31): it reads `sessions.invitation_id` in its org-scope pre-read,
so `invitationId` is not readable in CANDIDATE scope at all. A grant may name a subset of one site's columns
(`columns: ['status']`), which unlocks only those.

**`test_questions` is also filtered by the session** (the stricter reading, FU-DB-212): under its grant a read
reaches only a test question that one of this session's questions points to
(`sessionQuestions: { some: { sessionId } }`), so a service that passes another candidate's
`test_question_id` still reads nothing.

### Tests

`org-context-session.spec.ts` (actors, nesting, detach, facts, reflection, lower-casing; no database),
`plain-args.spec.ts` (the plain-arguments guard through the real client in every scope, no database) and
`call-sites.spec.ts` (the call-site allowlist),
`database-boot.spec.ts` (the facts setter is claimed when `DatabaseModule` loads),
`session-scope-args.spec.ts` and `candidate-interim.spec.ts` (every model and operation on the rewritten
arguments: the read allowlist and `omit` for all 18 models, the write allowlist, the consents create, the
object keys and FU-DB-199), `candidate-grants.spec.ts` (what each of the eleven grant sites unlocks, the
`id IN ids` filter, the RUN filter), `org-context-grant.spec.ts` (`withGrant`: ids, sites, nesting, the `active`
flag, a detached promise, `setTimeout` and emitter after `fn` settled, through the real client with no
database), `session-scope.extension.spec.ts` (the allowlist sweep over every model of the generated client,
the vectors, the fluent API and the `unscoped` order, through the real client, no database),
`cs4-session-isolation.spec.ts` (two candidates in one org and one in another, against Postgres 16 as
`app_user`: cross-candidate reads and writes, SERVICE, the bare read of every model, creates, keys, raw SQL,
statement counts, and a third candidate who sits the same test as the first) and `cs4-columns-grants.spec.ts`
(against Postgres: every grant site as A with B's and another org's ids, the writes under the state and device
grants, the consents create with its statement count, P2002, the current text and the transaction, the RUN
filter, `omit` on writes and the facts). Removing the session filter, the allowlist, `omit`, a grant property,
the RUN filter or any one of the other rules above makes tests fail. FU-DB-67 will add the call-site test.

## Session write locks (ADR 0013 section 5.7, ADR 0006 section 8.5, ADR 0015 section 6)

Three functions in `session-locks.ts` take the **per-session row lock** that serialises a writer against the
erasure fence (ADR 0004 section 9) and against the accommodation writers. They are the **lock core**:
`SessionStateService.guardLive`, `SessionStateService.lockForAccommodation` and
`SessionStateService.lockAnySession` are thin wrappers over them, which Backend B builds (the hub's ruling,
merged #205, and its follow-ups). They go through the model API, so there is no raw SQL and no FU-DB-67 raw
call site. **They are not exported from `index.ts`**, on purpose.

```ts
guardLive(tx: SessionLockTx, sessionId: string): Promise<'LIVE' | 'ERASED'>
lockForAccommodation(tx: SessionLockTx, sessionId: string): Promise<SessionStatus>
lockAnySession(tx: SessionLockTx, sessionId: string): Promise<SessionStatus>
```

`SessionLockTx` is the two calls they use, `tx.session.findUnique` and `tx.session.updateMany`; the
interactive transaction client of `prisma.client.$transaction(async (tx) => ...)` fits (checked by the
type-check of `session-locks-postgres.spec.ts`). `guardLiveWith`, which used to take the ERASED member as a
parameter, is gone: the module exports exactly the three locks, `erasedStatusOf` and `MAX_LOCK_ATTEMPTS`
(a test pins that list).

### Who calls what (FU-DB-67, the hub's rulings)

The files are pinned by **path**, in `testing/lock-call-sites.ts` (the constants are Backend B's real paths from #98 and
#206, and Database B's):

| Constant                 | Path                                |
| ------------------------ | ----------------------------------- |
| `SESSION_STATE_FILE`     | `session/session-state.service.ts`  |
| `SESSION_PROCESSOR_FILE` | `session/session-job.processor.ts`  |
| `ACCOMMODATIONS_FILE`    | `session/accommodations.ts`         |
| `RETENTION_LOCK_FILE`    | `retention/retention.repository.ts` |

| Lock                   | Callers outside `database/` (allowed files)                                                                                                                                                                                                                                                                                                                                                                                      | The wrapper                                |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `guardLive`            | **exactly two**: `SessionJobProcessor.withLiveSession` (SERVICE; `session-job.processor.ts`) and **one** named STAFF method, `SessionStateService.proctorResume` (the proctor-resume transition, ADR 0002 P-3: it writes `session_sections.deadline_at`; `session-state.service.ts`)                                                                                                                                             | `SessionStateService.guardLive`            |
| `lockAnySession`       | only `SessionJobProcessor.withAnySession` (`session-job.processor.ts`), through SessionStateService (`session-state.service.ts`)                                                                                                                                                                                                                                                                                                 | `SessionStateService.lockAnySession`       |
| `lockForAccommodation` | **STAFF**, through SessionStateService: the accommodations PATCH, redact-note and the video-check PUT (the calls are in `accommodations.ts`; `session-state.service.ts` holds the wrapper only and makes no call of it). And **one** org-job site: `retention/retention.repository.ts`, `RetentionRepository.casAccommodations`, in a plain `runInOrg`, for erasure, R-4 and R-10 (R-4 runs there too: it has no SERVICE caller) | `SessionStateService.lockForAccommodation` |

Five tests pin it, all with an **empty** list outside the defining file today:

- **The import guard** (`import-guard.spec.ts`, rule `database/session-locks`, `allowed: []`): only the
  SessionStateService file imports the module, and the allowlist must stay a **subset of that one path**
  (`lockImportProblems`). Nothing else imports it, nothing in `database/` either, and a re-export from `index.ts` is
  refused. It reads `from '...'`, `require(...)`, `import(...)` with single quotes, double quotes or backticks, and a
  specifier ending in any of `.js .ts .mjs .mts .cjs .cts`.
- **The call-site test** (`call-sites.spec.ts`, `CALL_SITES`): `guardLive`, `lockForAccommodation` and
  `lockAnySession` are in `GUARDED_NAMES`. Today the only file that may use them is `database/session-locks.ts`.
- **The caller rules** (`lockCallSiteProblems`, over the real tree in `call-sites.spec.ts`, pinned on synthetic
  files in `lock-call-sites.spec.ts`), **mechanical, so an extra entry fails**. Outside `database/`, a lock may be
  listed only for its allowed files (a subset rule): `guardLive` and `lockAnySession` for the state and processor
  files, `lockForAccommodation` for the state, accommodations and retention files. Inside `database/`, only
  `database/session-locks.ts` may name a lock. The `why` of an entry names its callers: `proctorResume` (state,
  `guardLive`), `withLiveSession` (processor, `guardLive`), `withAnySession` (`lockAnySession`), the accommodation
  writer and one of PATCH, redact-note, video-check (state and accommodations, `lockForAccommodation`), the erasure,
  R-4 and R-10 jobs (retention).
- **The per-file rules**, for the state and processor files **whenever they exist, listed or not**, and for each listed
  accommodations or retention file that exists (text rules over the source with comments stripped). The state and
  processor files are each in **one of two states, and there is no third**: **before the switch-over** (Backend B's #206;
  how BE-07 #98 left them on main) the file names **no lock at all**, and the state file does not import the core: a
  wrapper, a member call or a string that names a lock then fails with "does not import database/session-locks"; once
  the processor names a lock, or the state file reaches the core in **any** form (a type-only import counts), it gets the
  **full shape** below, for all three locks in the state file and for both `withLiveSession` and `withAnySession` in the
  processor, with nothing relaxed. A file that is missing passes no rule vacuously: a listed one fails the stale-entry
  check, and the rules run on it as soon as it appears.
  - **The state file** (`session-state.service.ts`), once it imports the core:
    - **How the cores come in.** Each core is **imported by name under an alias**, by an
      `import { guardLive as coreGuardLive } from` statement and **by no other form**: never under its own name, never
      as a namespace (`import * as locks`), and never by `import locks = require(...)`, `const locks = require(...)`,
      `await import(...)`, a side-effect `import '...'` or an `export ... from` of the module. Every specifier of
      `database/session-locks` in the file must be one of the parsed `import { ... } from` statements, so a form with a
      plain string-literal specifier that the parser does not know still fails. A specifier that is **not** a plain
      string literal (`createRequire(__filename)(...)`, `const r = require; r(...)`, a parenthesised, concatenated or
      built template specifier) is not read at all, so **the state file may hold no `require`, `createRequire` or
      `import(` token at all** (SF-2 of the r3 review), in either state: any of them fails, even in a string or a log
      message that says "require", and so does a `typeof import(...)` type query. A file that reaches the module in a
      form the scan can read is never skipped by the export check.
    - **No default import, and no loader route** (N-4 of the r3 review, SF-1 of the r4 review): `import core from` and
      `import core, { ... } from` the module are refused (a default import holds the whole module), and so are
      `_load`, `getBuiltinModule`, an import of `module`, `node:module`, `vm` or `node:vm`, and a specifier with an
      escape in it (`session\u002dlocks`: TypeScript resolves the decoded string, the scan reads the raw text). **Write
      the import on its own line, in prettier's layout**: the statement is parsed by a strict clause grammar, so a
      statement the grammar does not know fails (OTHERS) instead of passing. No file under `apps/api/src` may hold an
      escaped specifier at all (`import-guard.spec.ts`).
    - **The wrapper.** Each core is **called exactly once, inside the wrapper method of the same name**, a method of
      the `SessionStateService` class (a method of another class in the file does not count), and the alias is used
      nowhere else (not passed, returned, stored, or called in another method or an exported function). The wrapper
      is **thin**: its whole body is `return <alias>(<param1>, <param2>);` (an `await` and any whitespace are fine),
      with exactly two plain parameters handed on in order. A body that stores a closure, adds a statement or changes
      the arguments fails. **The parameters take no `=` default and no `?`** (N-1): a default such as
      `sessionId = this.lastSessionId` would lock a session the caller did not name.
    - **No decorator on the three wrappers or on `proctorResume`** (N-2): what stands above a pinned method's header
      must end the previous member or open the class (`}`, `;` or `{`), so a decorator, also one over several lines,
      fails (it can take `descriptor.value` and hand the method out under no name). A **class** decorator
      (`@Injectable()`) is allowed: Nest builds the service with it, and a class decorator that hands methods out by a
      computed lookup is in the computed-name class of misses that the AST gate closes (FU-DB-189).
    - **Every other mention.** A mention of a lock name is the wrapper's definition or a member call, nothing else:
      `const { lockAnySession } = this`, `Reflect.apply(this.lockAnySession, ...)`, `const f = this.lockAnySession`,
      `.guardLive.bind(this)` and an optional-call or bracket form all fail. **A string or a log message that names a
      lock fails too** (`this.logger.log('guardLive done')`): the scan does not tell a string from code, so it fails
      closed; a comment is stripped first and does not count.
    - **Member calls, with ANY receiver** (`this.`, `self.`, `this?.`, `(this as X).`, `super.`, another object;
      whitespace or a line break after the dot is fine): **exactly one `.guardLive(` call, inside the brace-matched
      `proctorResume` body**, and **no `.lockAnySession(`, no `.lockForAccommodation(` and no `.proctorResume(` call
      at all** in this file (the accommodation routes call the second from `session/accommodations.ts`, the jobs the
      first from the processor, and the controller calls `proctorResume` from outside the file: a state method that
      called one of them, say a `closeIngest` that locks any session, would be reachable from a SERVICE job and write
      into an ERASED session; one that called `proctorResume` would be a second door to `guardLive`).
    - **`proctorResume` is treated like a lock name in this file** (SF-1 of the r3 review): every bare mention is its
      method definition (`const { proctorResume } = this`, a string or a log message that says it fails), and **every
      member mention is refused, called or not** (`{ resume: this.proctorResume }`,
      `Reflect.apply(this.proctorResume, this, args)`, `.call`, `.apply`, `.bind`, a read through any receiver). The
      scan sees only this file and the processor (below): **who calls
      `proctorResume` from OTHER files is a review point until FU-DB-189's AST gate, not a pin**.
    - **Write the wrappers as methods with a body** (the scan looks for `async name(...) {`), and keep inline object
      types out of their return types.
  - **The processor file** (`session-job.processor.ts`), once it names a lock: `.guardLive(` **exactly once, inside `withLiveSession`**;
    `.lockAnySession(` **exactly once, inside `withAnySession`**; every mention of a lock name is a member call
    (`this.state.guardLive(...)`). A string or a log message that names a lock fails here as well (fail closed).
    The two methods are **the `SessionJobProcessor` class's own** (N-3: a method of another class in the file does
    not count, and a file with no such class fails), they take **no decorator** (N-2), and the file makes **no
    `.lockForAccommodation(` call**. **The processor never mentions `proctorResume`, in either state** (SF-2 of the
    r4 review): it is the STAFF transition, and a job that called it would be a second door to `guardLive`.
  - **The accommodations and retention files:** every mention of a lock name is a member call
    (`this.state.lockForAccommodation(...)`); nothing is held, bound or passed.
- **The export check** (`findLockExports`, **no allowlist**, the state file included): no file outside `database/`
  exports a lock or an alias of one, other than through `export ... from` (the import guard catches that): not
  `export { guardLive as g }`, `export const g = guardLive`, `export default guardLive`, `export default { guardLive }`,
  `module.exports = { guardLive }`, `export = { guardLive }`, nor the same through a local variable. The whole core
  under one name is refused too (`import * as core`, `import core = require(...)`, `const core = require(...)`,
  `const core = await import(...)`), and so is any file that reaches the module other than by a named import (a
  `require(`, `import(`, side-effect import or `export * from`), even when it names no lock. It also finds a
  **wrapper under a new name**: an exported function, arrow or object whose text calls a lock or an alias
  (`export function g(tx, s) { return guardLive(tx, s) }`, `export const g = (tx, s) => core(tx, s)`), and a
  **static property** that holds or calls one (`static g = guardLive`). A class that merely has a method with the
  name is fine. Backend B's SessionStateService file is checked by the same test: that is the mechanical review
  point.

All of these are **text rules** over the comment-stripped source, not a parser, so they have limits a reviewer must not
rely past: a quote or a `/*` inside a **regex literal** can unbalance a body or hide code (`stripComments` and the brace
matching skip strings and templates, not regex literals), so the result there is wrong in either direction; a name written
with a **unicode escape**, built at run time, reached through a computed property or an eval, or passed out through a
closure built from a parameter is not seen; a specifier that is not a plain string literal is not read by the import
guard in any other file (the state file refuses every loader token instead, SF-2); and the exported-function check
assumes prettier's column-0 layout. FU-DB-189
builds the AST gate that replaces the scan; FU-DB-244 records the comment-stripper case.

**What to add, and when.**

- **Backend B**, in the PR that builds SessionStateService: exactly **`session/session-state.service.ts`** to `allowed`
  of the import-guard rule, and `CALL_SITES` entries for `session/session-state.service.ts` (`guardLive`,
  `lockForAccommodation`, `lockAnySession`; a `why` naming `proctorResume`, `withAnySession`, and the accommodation
  writers with PATCH, redact-note, video-check PUT), `session/session-job.processor.ts` (`guardLive` with
  `withLiveSession`, `lockAnySession` with `withAnySession`) and `session/accommodations.ts` (`lockForAccommodation`,
  why naming the STAFF accommodation writers and a route). Nothing else. Write the wrappers and the call sites as
  described above: `grep` for `.guardLive(` in your files and check there are exactly the calls the table lists.
- **Database B**, in **its own PR**: the entry `retention/retention.repository.ts` (`lockForAccommodation`, `why`
  naming the erasure, R-4 and R-10 jobs and the plain `runInOrg`). Not before: the stale-entry check fails while the
  call does not exist. `casAccommodations` calls SessionStateService's wrapper, not the core, in a plain
  `runInOrg(orgId)`; R-4 runs there too, there is no SERVICE caller of `lockForAccommodation`. The ADRs also say
  "and the erasure job files": the rule stays narrow (`retention.repository.ts` only, fail-closed) until the hub rules
  on that (FU-DB-242).

The errors are exported from `index.ts` (`SessionNotFoundError`, `SessionLockRetryError`,
`AccommodationLockedError`), so a caller can map them without importing the module.

**Error codes and who maps them.** Each error has a stable, read-only `code` (a prototype getter, not an own property)
and an exported class for `instanceof`; `SESSION_LOCK_ERROR_CODES` and `SessionLockErrorCode` are exported too. The
global `ProblemFilter` (docs/api-contract.md section 8, Backend A) matches database SQLSTATEs and Prisma codes, and
these three carry none, so without a mapping a route would answer 500.

| Error                      | `code`                 | Route                                                                                             | Job                                                         |
| -------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `SessionNotFoundError`     | `SESSION_NOT_FOUND`    | 404 (the accommodations PATCH, ADR 0015 section 6)                                                | drop the job (a poison job, ADR 0006 8.4)                   |
| `SessionLockRetryError`    | `SESSION_LOCK_RETRY`   | **503 `BUSY` with `Retry-After`** via ProblemFilter (the proctor-resume, ADR 0013 5.7), never 500 | a BullMQ retry through `busy-lock.ts` (SessionJobProcessor) |
| `AccommodationLockedError` | `ACCOMMODATION_LOCKED` | **409**, a state conflict (ADR 0015 section 6)                                                    | a BullMQ retry (the retention site)                         |

### How the lock works

Read `status` in the caller's scope; then
`session.updateMany({ where: { id, status: <read>, NOT: { status: 'ERASED' } }, data: { status: <read> } })`
(the `NOT` only in `guardLive`). Writing the status to its current value takes the row lock. Prisma 7 emits
exactly one `UPDATE sessions SET status = ... WHERE ...` (no `RETURNING`, no other column: `sessions` has no
`updated_at`), so the whole call is **one SELECT and one UPDATE** (`session-locks-postgres.spec.ts` counts them
with `pg_stat_statements`; this is the ADR 0015 section 8 spike). No key column changes, so the lock mode is
**FOR NO KEY UPDATE** (read back with `pgrowlocks`): it excludes another `UPDATE sessions` and the fence, and it
does **not** block the `FOR KEY SHARE` that a child-table insert (`proctor_events`, `media_chunks`,
`identity_checks`) takes, in either direction. `status: <read>` is in the `where`, so the same-value write can
never revert a status that committed in between: if one did, 0 rows change, the status is re-read and the lock is
tried again, **at most 3 tries in total** (the re-read after the last lost try only decides ERASED or not;
accepted as built by the hub).

| Call                   | Returns                                                                                                                                                                                              | Throws                                                                                                                                         |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `guardLive`            | `'LIVE'` when 1 row is updated (the lock is held). `'ERASED'` when the status read, or the re-read after 0 rows, is ERASED: nothing was written and the caller writes nothing either                 | `SessionNotFoundError` (no such session in this scope: drop the job); `SessionLockRetryError` (3 lost tries: the job's own retry)              |
| `lockForAccommodation` | the status it read under the lock, **any** status, ERASED included                                                                                                                                   | `SessionNotFoundError` (the route answers 404); `AccommodationLockedError` (3 lost tries: 409 `ACCOMMODATION_LOCKED`)                          |
| `lockAnySession`       | the same as `lockForAccommodation`, for the erasure-compatible **jobs** (`withAnySession`: ingest close and key destruction, the sweeps, `evidence-expire`, the erasure re-run, the consent-PDF job) | `SessionNotFoundError` (drop the job); `SessionLockRetryError` (3 lost tries: the job is retried by BullMQ, so not the 409 error of the route) |

All three throw `OrgScopeViolationError` for a refused scope and for the client itself as `tx` (below).
`lockForAccommodation` and `lockAnySession` share one implementation and differ only in the error of the lost
compare-and-set, and in one scope (below). The errors are plain `Error`s with fixed messages and **no value in
them**, never the session id.

### Which scopes may call them (an allowlist of actors, `session-lock-scope.ts`)

Call them as the **first statement of an interactive transaction at READ COMMITTED** (a higher isolation level
turns the compare-and-set into serialization errors) and keep the transaction short: the lock is held until it
commits, and nothing may do I/O inside it (ADR 0013 5.7). Each lock has **its own allowlist**, built to the merged ADR 0006 section 8.5 (#211, #213), the
narrower and fail-closed reading (FU-DB-240); a lock passes **only** in the scopes marked `yes`:

| Scope                                                               | `guardLive` | `lockAnySession` | `lockForAccommodation` |
| ------------------------------------------------------------------- | ----------- | ---------------- | ---------------------- |
| SERVICE session scope (`detachForSessionJob`, `runAsSessionJob`)    | yes         | yes              | **refused**            |
| STAFF scope (`runAsUser`), also under the SessionStateService grant | yes         | **refused**      | yes                    |
| plain org job scope (`runInOrg`: no user, no session, not system)   | **refused** | **refused**      | yes                    |
| CANDIDATE scope, with or without a grant                            | refused     | refused          | refused                |
| system scope (`runSystem`)                                          | refused     | refused          | refused                |
| no scope at all, or any scope kind or actor that does not exist yet | refused     | refused          | refused                |

`lockAnySession` is a **job** lock (SERVICE only: `withAnySession` is a job entry), so STAFF is refused.
`lockForAccommodation` is refused in SERVICE: **R-4 has no SERVICE caller and none may be added** (it runs in the plain
org job scope at `RetentionRepository.casAccommodations`). `guardLive` keeps SERVICE (`withLiveSession`) and STAFF
(`proctorResume`). A refusal is an `OrgScopeViolationError` before any statement, with a message that names no value. The extension
adds the org filter (and in a session scope the session filter) to the read and the write, so another org's
session, another session of the same org (in a session scope) and an unknown id all give `SessionNotFoundError`
and no UPDATE.

**The STAFF and plain-org split is advisory at run time until the ADR 0006 nesting rows (lines 412 and 413, Planned)
are built (FU-DB-241):** today a `runInOrg` nested inside `runAsUser` drops the user (it becomes a plain org scope,
where `guardLive` and `lockAnySession` are refused and `lockForAccommodation` passes), and `runAsUser` works from a
plain org scope (it becomes STAFF). Two tests show it. The call-site rules above carry the split until then.

- **CANDIDATE is the hub's ruling, not a relaxable default.** A candidate path never takes a session lock.
  ADR 0013's "candidate transactions lock `sessions` first too" is an ordering rule: `transition()`'s own
  compare-and-set UPDATE is the first `sessions` lock. So the wrappers are never called in a CANDIDATE scope.
  A **STAFF or SERVICE call under the SessionStateService grant is fine** (ADR 0015 section 6, ADR 0013 section
  5.7): no grant is needed there (FU-DB-232, checked after CS-4 PR 2), and an active one changes nothing (tested).
- **Why `lockForAccommodation` alone passes in a plain `runInOrg`** (ADR 0015 section 6(b), ADR 0006 section 8.5):
  Database B's one retention site, `RetentionRepository.casAccommodations` (erasure, R-4 and R-10), runs per session in
  `runInOrg(orgId)`, and the per-candidate advisory lock it takes first is raw SQL, which session scopes refuse. The conditions: the target session id comes from the
  job's own query and the update runs under the org filter, so another org's session reads no row and throws
  `SessionNotFoundError`, never a lock on another org's row (tested); CANDIDATE, system and every other kind stay
  refused for it too; the same-value `updateMany` shape and the any-status semantics (ERASED included) are
  unchanged; and FU-DB-67 pins its call sites (above).
- **Lock order for the retention transaction (Database B):** the ADR 0004 per-candidate advisory lock (raw SQL
  through `runRawSql`, org scope), then the `sessions` row lock (`lockForAccommodation`), then `invitations`, then
  the accommodations compare-and-set, all in **one** transaction (`session-locks-postgres.spec.ts` runs that order).
- **Pass the `tx` of the interactive transaction, never `prisma.client`.** On the client itself the read and the
  write would commit one by one and the lock would be gone at once, with the caller believing it holds it.
  `SessionLockTx` types `$connect` and `$disconnect` as `never` (Prisma removes them from a transaction client), so
  `guardLive(prisma.client, id)` does not compile, and all three throw an `OrgScopeViolationError` at run time if
  they see either. **The run-time check is a heuristic**: an object that has neither method, such as
  `{ session: prisma.client.session }`, passes it (a test shows it), so the type is the real guard and a reviewer
  looks at what a call site passes. `$transaction` cannot be the discriminator: Prisma 7 leaves it on the
  transaction client.
- Lock timeouts are not set here. SERVICE session jobs use a pool whose `pg` options set `lock_timeout` and
  `statement_timeout` (ADR 0013 5.7), because `SET LOCAL` is raw SQL and refused in session scopes. A wait that
  ends in SQLSTATE 55P03 or a deadlock (40P01) propagates as a Prisma error and stays with the caller:
  `SessionJobProcessor` maps it to a BullMQ retry; a staff route of ADR 0015 retries once on 40P01 or 40001 (ADR
  0015 line 211) and then answers 409; staff routes run on the main pool, which sets no `lock_timeout`, so a wait
  there ends at the Prisma interactive-transaction timeout (P2028), not at 55P03 (FU-DB-235). **`proctorResume` is
  the exception** (ADR 0013 5.7, line 350): exhausted retries, a lock timeout (55P03) and a deadlock (40P01)
  answer **503 with `Retry-After`**, never 500 (a 409 `SESSION_ERASED` on an ERASED session), and its staff
  transaction uses a Prisma `timeout` of **5 s**, because the SERVICE pool's `lock_timeout` does not apply to it.

### ERASED detection

`session_status` gained `ERASED` with ADR 0004 section 9 (PR #91, now on main, so the generated enum has the
member and the **present** mode is live). Before that migration the enum had no such member and no row could be
ERASED. `session-locks.ts` reads it from the generated enum once, at load: `Object.hasOwn(SessionStatus, 'ERASED')`, for one thing, the typed `NOT: { status: 'ERASED' }`
condition of `guardLive`'s write:

- **present:** `guardLive` adds the `NOT` condition to the update;
- **absent:** the condition is left out. That is equivalent (`status: <read>` already excludes ERASED); this is the
  mode of a client generated before #91, and it is still tested (with the generated enums module replaced).
  Regenerating the client switched the first branch on, with no code change.

**The status that was read is always compared with the literal string `'ERASED'`**, in both modes (N1 of the
review of #208), so a client generated before #91 still fails closed on a row that reads ERASED: `guardLive`
returns `'ERASED'` and writes nothing. The typing stays sound with no `any` and no assertion on the enum: the
member is taken from the enum object, so it is a `SessionStatus` whenever it exists. `lockForAccommodation` and
`lockAnySession` never stop on ERASED.

### Tests

`session-locks.spec.ts` (fake transaction: the module surface, the exact arguments, the retry count, the two
any-status locks side by side, the scope allowlist through the real `OrgContextService`, the client-itself check
and its limit), `session-lock-scope.spec.ts` (the allowlist on synthetic scopes, an unknown kind and an unknown
actor included), `session-locks-enum-erased.spec.ts` and `session-locks-enum-absent.spec.ts` (the real `guardLive`
with the generated enum replaced by one with and without ERASED, sharing `testing/guard-live-cases.ts`, plus a
stale client whose row reads ERASED), and `session-locks-postgres.spec.ts` (Postgres 16 as `app_user`: scopes,
grants, cross-org, refused scopes send nothing, statement counts, two connections for the lock semantics, a
forced and a real race, the retention lock order, and the ERASED cases against the real enum: an owner-set ERASED
row, `guardLive` returns `'ERASED'` and writes nothing, `lockForAccommodation` and `lockAnySession` lock it, the fence
wins a real race, and the `NOT (status = 'ERASED')` clause is in `guardLive`'s UPDATE text and in no other lock's; they
are plain tests, **never skipped**: #91 is on main, a client generated before it fails them, and the "no ERASED"
mode is covered by the mocked-enum spec). The import-guard and call-site cases are in `import-guard.spec.ts` and `call-sites.spec.ts`.

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
  **In a CANDIDATE scope (ADR 0013 CS-4.5) all six vectors throw** (the fluent API arrives as vector 2),
  and in a SERVICE scope they stay a review item: see "Candidate and session-job scopes".
- **(d) Rule (i) covers 26 foreign keys**, not only the staff references (`created_by`,
  `reviewer_id`, `assigned_to`, `collected_by`, `scored_by`, `reviewed_by`, `video_check_by`,
  `actor_id`) and
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
(`FK_CLASSES`, **59 foreign keys**). `org-scope-relations.spec.ts` derives the keys from
`prisma/schema.prisma`, asserts the total and each class count
(`{ ORG_ID: 9, SCOPE_HOP: 21, COMPOSITE: 3, RULE_I: 26, total: 59 }`), and fails for a key that is
missing, unclassified, classified twice, or in the wrong class. A new foreign key breaks the build
until it is classified.

| Class       | Count | What it is                                                                                                                                                             | Who guards it                                                                                                 |
| ----------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `ORG_ID`    | 9     | the `org_id` key of a model with its own org (to `organizations`)                                                                                                      | the scope (filter and stamp)                                                                                  |
| `SCOPE_HOP` | 21    | the first hop of a path model's scope path (its own parent)                                                                                                            | the scope filter; creating, and re-parenting in an org scope, is rule (i) (system scope refuses to re-parent) |
| `COMPOSITE` | 3     | `(id, org_id)` keys on `invitations` (2) and `sessions` (1), ADR 0006 2 ii                                                                                             | the database                                                                                                  |
| `RULE_I`    | 26    | references the scope cannot check: **13 staff** (to users: `created_by`, `reviewer_id`, `assigned_to`, ...) and **13 cross-chain** (another chain, or a second parent) | **rule (i)**                                                                                                  |

`SCOPE_HOP + COMPOSITE + RULE_I` is 50; the 9 `ORG_ID` keys make 59. Each `RULE_I` entry also says
whether it is `staff` or `cross-chain` (`ruleI`).

`RULE_I_REFERENCES` (the 26 `RULE_I` keys) is the list a service must follow: **before writing an
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

| File                                           | What it holds                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create-prisma-client.ts`                      | The only `new PrismaClient` (ADR 0009 section 4.2)                                                                                                                                                                                                                                                                                                                |
| `prisma.service.ts`, `database.module.ts`      | The Nest service (connect, disconnect) and the global module                                                                                                                                                                                                                                                                                                      |
| `org-scope-map.ts`                             | The scope map and `orgFilter`                                                                                                                                                                                                                                                                                                                                     |
| `org-scope-args.ts`                            | Pure argument rewriting per operation, and the operation coverage check                                                                                                                                                                                                                                                                                           |
| `org-scope-nested.ts`                          | The nested guards: nested writes that reach another org's rows, and nested cursors                                                                                                                                                                                                                                                                                |
| `org-scope-relations.ts`                       | Every foreign key classified (`FK_CLASSES`, `RULE_I_REFERENCES`), the first-hop column of each path model (`scopeHopColumn`) and the side of every relation that holds the key                                                                                                                                                                                    |
| `org-scope.extension.ts`                       | The `$extends` query extension and `OrgScopedPrismaClient`                                                                                                                                                                                                                                                                                                        |
| `org-context.ts`, `org-context.interceptor.ts` | The AsyncLocalStorage context, its API (`withGrant` included), and the HTTP population point                                                                                                                                                                                                                                                                      |
| `session-scope-map.ts`                         | CS-4.2 `SESSION_SCOPE` (the ten session-path models) and CS-4.3 `CANDIDATE_MODELS` (the allowlist, row filters, **CS-4.4's write column as an allowlist**, the columns a grant unlocks for a write, the consents create), `GRANT_SITES` (the eleven sites), the object-key shapes, the server-only event types                                                    |
| `session-scope-args.ts`                        | Pure argument rewriting for a session scope: allowlist gate, creates, session keys, the filters and the existence check's `where`                                                                                                                                                                                                                                 |
| `candidate-relations.ts`                       | CS-4.5 relation vectors 1 to 5 refused in a CANDIDATE scope                                                                                                                                                                                                                                                                                                       |
| `candidate-facts.ts`                           | `setCandidateFacts`: **CandidateSessionGuard only**, not exported from `index.ts`                                                                                                                                                                                                                                                                                 |
| `deep-freeze.ts`                               | `deepFreeze`: the scope tables are frozen when their module loads                                                                                                                                                                                                                                                                                                 |
| `plain-args.ts`                                | `assertPlainArgs` (the hook refuses arguments Prisma and the checks would read differently), `ownValue` and `ownArgs` (own-key reads), `isFieldRef`                                                                                                                                                                                                               |
| `candidate-interim.ts`                         | `CANDIDATE_READ` (CS-4.4's read column per model: readable, key, explicit-only, RUN-only), `omit`, the RUN filter, `COMPOUND_UNIQUES`, the field-reference refusal. Not interim any more: the name stays because `retention/consent-access.spec.ts` pins the path (FU-DB-211)                                                                                     |
| `errors.ts`                                    | `OrgContextMissingError`, `OrgScopeViolationError`, `RawQueryNotAllowedError`, and the session-lock outcomes `SessionNotFoundError`, `SessionLockRetryError`, `AccommodationLockedError`                                                                                                                                                                          |
| `session-locks.ts`, `session-lock-scope.ts`    | `guardLive`, `lockForAccommodation` and `lockAnySession`, the lock core: **not exported from `index.ts`**; only SessionStateService imports it (import guard, `allowed: []` today), `CALL_SITES` and the caller rules pin who uses each name (FU-DB-67); the scope file is the actor allowlist (SERVICE, STAFF; plain `runInOrg` for `lockForAccommodation` only) |
| `error-scrub.ts`                               | Keeps argument values out of the Prisma errors that are logged (FU-DB-70)                                                                                                                                                                                                                                                                                         |
| `testing/`                                     | Test helpers (excluded from the build): throwaway migrated Postgres, fixtures, scope checks                                                                                                                                                                                                                                                                       |

Tests (`*.spec.ts`) name TC-008 and NFR-04 or FR-103: the map completeness test and its failure
cases, the argument rewriting for every operation and model, the context and interceptor, the
extension without a database, the TC-008 matrix against a real Postgres (all read operations and the
update and delete operations as org A against org B's rows in all 31 models, with positive controls;
upsert, create, cursors, nested writes and the HTTP path on chosen models), and a smoke test that builds the API
and runs the compiled client and `DatabaseModule` on Node. `auth-bootstrap.spec.ts` covers what
BE-02's auth needs: raw SQL and transactions inside system scope, and the statement counts
(NFR-04, FR-104).

Session rows are never deleted by the API (ADR 0004 section 9.3, accepted D-54). `app_user` has no DELETE and no TRUNCATE on `sessions`, so `session.delete` and
`session.deleteMany` fail with "permission denied" in every scope, system scope included. Deleting a
session would cascade to its consent row, which R-9 keeps for 3 years. The erasure fence (SessionStateService)
moves a session to ERASED; retention never changes a status. Both clear data and never delete the row. Test teardown and seed
cleanup delete sessions as the migration owner (and delete the appeal first, if the session's review
has one). `retention-erasure-schema.spec.ts` covers this, the ERASED and CLOSED_ERASED enum values
and the retention marker index (FR-704, NFR-05); the TC-008 matrix and the CS-4 SERVICE matrix each have a Session branch for it.
