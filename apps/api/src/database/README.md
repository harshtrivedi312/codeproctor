# Database access and org scoping (DB-05)

Everything in this folder serves one rule: **a query can only see or change rows of the caller's
org** (ADR 0006, NFR-04, FR-103, TC-008). Services never build a Prisma client of their own. They
inject `PrismaService` and use `prisma.client`, which runs every model query through the org scope.

**Which `PrismaService`.** There are two classes with that name, in different files:

- `database/prisma.service.ts` (exported from `database/index.ts`, provided by `DatabaseModule`) is
  the org-scoped one. **New business modules must use it.**
- `database/prisma.module.ts` is BE-02's interim client: an unscoped `PrismaClient` for auth
  bootstrap only. It stays until `auth.service.ts` moves onto `database/prisma.service.ts` inside
  `runSystem('AUTH_BOOTSTRAP', ...)` (see the recipe below), and then it is deleted. A test
  (`prisma-client-smoke.spec.ts`) fails if any file outside `src/auth/`, `src/database/` and
  `app.module.ts` imports it.

Nest injects by class reference, not by name, so the two never collide at runtime. Always import
from the file named above, and check the import line when an editor offers an auto-import.

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

| Where the code runs                       | Who sets the context                                                                           |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Staff HTTP route                          | `OrgContextInterceptor`, from `request.user` (BE-02's `JwtAuthGuard` sets an `AuthUser`)       |
| Candidate route (token, then its session) | the candidate guard or interceptor calls `orgContext.runInOrg(session.orgId, ...)` (BE-07)     |
| BullMQ job, Socket.IO event               | the processor or gateway calls `runInOrg(job's session org, ...)` or `runAsUser(...)` (BE-08+) |
| Login, refresh, token lookups, cross-org  | `orgContext.runSystem(reason, ...)` with a reason from `SYSTEM_SCOPE_REASONS`, outside any org |
| A reviewed raw SQL query                  | `orgContext.runRawSql('why', ...)`                                                             |

`request.user` is BE-02's `AuthUser` (`common/auth/auth.types.ts`): `{ id, orgId, role, kind }`.
The interceptor checks it (`kind` must be `access`, `id` and `orgId` must be uuids, `role` a known
role), maps `id` to `userId`, and runs the handler inside `runAsUser({ orgId, userId, role })`.
`AuthenticatedUser` (`{ orgId, userId, role }`) is the shape inside the context. `orgId` comes from
the verified token, never from the body, a header or the query string. A `request.user` that does
not match is answered 401 and the handler does not run. A `@Public()` route has no `request.user`
(the guard returns early), so it runs with no context and a query on org data from it throws.
Guards run before interceptors, so `request.user` is always set by the time the interceptor reads
it (tested with the real `JwtAuthGuard` and real tokens).

### Why AsyncLocalStorage, not Nest request scope

A request-scoped provider makes every provider that injects it request-scoped, and Nest rebuilds
that whole chain on each request: slower (NFR-01), and unusable outside HTTP. This API also runs
BullMQ jobs and Socket.IO events, which have no request object. AsyncLocalStorage keeps every
provider a singleton, follows one request's async calls, and keeps concurrent requests apart
(tested with concurrent units of work and concurrent HTTP requests from two orgs).

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

A path follows the parent chain (the relation that owns the row), not staff references such as
`created_by` or `collected_by`. Those, and `test_questions.question_version_id`, rely on ADR 0006
section 2 rule (i): load every foreign id through the scoped client first, answer 404 on a miss.
The test checks each hop is a required to-one relation held on the child side, that the path ends at
a model with `org_id`, and that it does not pass a model that already has one (nearest ancestor).

## What the extension does

One hook, `query.$allOperations`, sees every model operation and every raw query
(`org-scope.extension.ts`; the argument rewriting is in `org-scope-args.ts`).

| Operation                                                                                                       | Inside an org scope                                                                                                     |
| --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `findUnique`, `findUniqueOrThrow`, `findFirst`, `findFirstOrThrow`, `findMany`, `count`, `aggregate`, `groupBy` | org filter ANDed into `where`                                                                                           |
| `update`, `updateMany`, `updateManyAndReturn`, `delete`, `deleteMany`                                           | org filter ANDed into `where`; on `direct` models an update cannot change `orgId`                                       |
| `create`, `createMany`, `createManyAndReturn`                                                                   | `direct`: `orgId` added when missing, refused when it names another org. `path`: passed through. `self`: refused        |
| `upsert`                                                                                                        | filter on `where`, `create` stamped and `update` checked as above                                                       |
| anything else                                                                                                   | refused (fail closed), and a compile-time check (`OPERATION_COVERAGE`) breaks `typecheck` when Prisma adds an operation |

With no context a query on any model throws `OrgContextMissingError`. In system scope it runs
unfiltered. The caller's own `where` (`OR`, `NOT`, an `orgId` naming another org) is kept and ANDed
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
change. It cannot be entered from inside an org scope (work that has an org never widens to all
orgs), but code in a system scope may narrow to one org with `runInOrg`. An org scope cannot switch
to another org either. `runRawSql` nests inside `runSystem` and inside `runAsUser` or `runInOrg`, in
either order, and also works with no scope at all. Treat every `runSystem` and `runRawSql` in a pull
request as a review flag.

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

## Auth bootstrap recipe

For BE-02's `AuthService` (login, forgot, reset, refresh, 2FA completion) and any other code that
runs before the caller's org is known:

1. **Pre-login lookups go inside `runSystem('AUTH_BOOTSTRAP', ...)`.** Inside it model queries are
   unfiltered, so the lookup by email or token hash works.
2. **Raw SQL goes inside `runRawSql('<reason>', ...)`, inside that scope.** The lockout counter and
   the recovery-code consume are examples. Either nesting order works. Outside `runRawSql`, raw SQL
   is still refused, even in system scope.
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

The extension looks only at the top-level model: its `where`, its `cursor`, and the `orgId` of a
create or update. Everything reached through a relation is **not** looked at.

- **(a) Nested writes are passed through.** A parent-side `connect`, `set`, `connectOrCreate`,
  nested `create` or nested `update` in `data` can change another org's rows. Example:
  `organization.update({ where: { id: A }, data: { users: { connect: { id: userOfB } } } })` moves
  B's user into A, and the filter on Organization does not see it. (The composite foreign keys of
  ADR 0006 section 2 ii cover only the delivery chain.) Until a guard exists (FU-DB-63), **every id
  in a nested write follows rule (i)**: load it through the scoped client first, and answer 404 on
  a miss.
- **(b) Re-parenting.** An update that changes a path model's first-hop foreign key, for example
  `testSection.update({ data: { testId } })`, is the same as a path create: rule (i). A `create` on
  a `path` model cannot be stamped either (there is no `org_id` column), so the parent id in the
  payload must have been loaded through the scoped client first.
- **(c) Nested reads are not filtered.** `include`, `select`, the fluent API, relation filters,
  `orderBy` on a relation and `_count` follow foreign keys blindly. Any foreign key that crosses
  orgs leaks. Example: if `session_reviews.reviewer_id` points at another org's user,
  `sessionReview.findUnique({ where: { id }, include: { reviewer: true } })` returns that user row,
  password hash included. Select only the fields you need, and never `include` a user.
  (`tc-008-org-isolation.spec.ts` pins this behaviour; it documents the limit and is not a fix.)
- **(d) Rule (i) covers 25 foreign keys**, not only the staff references (`created_by`,
  `reviewer_id`, `assigned_to`, `collected_by`, `scored_by`, `reviewed_by`, `actor_id`) and
  `test_questions.question_version_id` (FU-DB-64 lists them all). The main cross-chain ones:
  `session_questions` to `test_questions`, `question_versions` and `question_variants`;
  `session_sections` to `test_sections`; `consents` to `consent_texts`; `keystroke_batches` to
  `session_questions`; `webhook_deliveries` to `sessions`; `organizations.current_consent_text_id`
  to `consent_texts`.
- **(e) An open `runRawSql` carries into nested scopes.** A `runAsUser`, `runInOrg` or `runSystem`
  started inside it keeps the hatch, so raw SQL there is not refused. Wrap only the single raw
  statement, never a block that also does model work.
- **Cursors.** In an org scope a cursor is given the caller's org on models with `org_id`, accepted
  only for the caller's own row on Organization, and **refused on models without `org_id`** (Prisma
  finds the cursor row by its own fields, so there is no way to scope it). Page those with `where`
  plus `orderBy`, for example `where: { id: { gt: lastId } }, orderBy: { id: 'asc' }`.
- Prisma queries are lazy. See "Writing queries inside the scope" below.
- Prisma returns `BigInt` for the identity ids and `Decimal` for scores (FU-DB-06): serialise them
  before sending JSON.

## Rules for services (from the follow-ups)

- Look a session up from its invitation with
  `prisma.client.session.findUnique({ where: { invitationId } })`, never `invitation.sessions[0]`.
  `Invitation.sessions` is a list by design (FU-DB-04).
- Always pass `allowedLanguages` (question versions) and `events` (webhook endpoints) explicitly:
  the columns are NOT NULL with no database default, and Prisma treats list inputs as optional
  (FU-DB-07).
- Connect as `app_user` (`DATABASE_URL`). `MIGRATION_DATABASE_URL` never appears in API code.

## Files

| File                                           | What it holds                                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `create-prisma-client.ts`                      | The only `new PrismaClient` (ADR 0009 section 4.2)                                          |
| `prisma.service.ts`, `database.module.ts`      | The Nest service (connect, disconnect) and the global module                                |
| `org-scope-map.ts`                             | The scope map and `orgFilter`                                                               |
| `org-scope-args.ts`                            | Pure argument rewriting per operation, and the operation coverage check                     |
| `org-scope.extension.ts`                       | The `$extends` query extension and `OrgScopedPrismaClient`                                  |
| `org-context.ts`, `org-context.interceptor.ts` | The AsyncLocalStorage context, its API, and the HTTP population point                       |
| `prisma.module.ts`                             | BE-02's interim unscoped client for auth bootstrap only (not part of DB-05)                 |
| `errors.ts`                                    | `OrgContextMissingError`, `OrgScopeViolationError`, `RawQueryNotAllowedError`               |
| `testing/`                                     | Test helpers (excluded from the build): throwaway migrated Postgres, fixtures, scope checks |

Tests (`*.spec.ts`) name TC-008 and NFR-04 or FR-103: the map completeness test and its failure
cases, the argument rewriting for every operation and model, the context and interceptor, the
extension without a database, the TC-008 matrix against a real Postgres (every operation as org A
against org B's rows in all 31 models, with positive controls), and a smoke test that builds the API
and runs the compiled client and `DatabaseModule` on Node. `auth-bootstrap.spec.ts` covers what
BE-02's auth needs: raw SQL and transactions inside system scope, and the statement counts
(NFR-04, FR-104).
