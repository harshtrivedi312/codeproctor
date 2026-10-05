# Database access and org scoping (DB-05)

Everything in this folder serves one rule: **a query can only see or change rows of the caller's
org** (ADR 0006, NFR-04, FR-103, TC-008). Services never build a Prisma client of their own. They
inject `PrismaService` and use `prisma.client`, which runs every model query through the org scope.

**Which `PrismaService`.** There are two classes with that name, in different files:

- `database/prisma.service.ts` (exported from `database/index.ts`, provided by `DatabaseModule`) is
  the org-scoped one. **New business modules must use it.**
- `database/prisma.module.ts` is BE-02's interim client: an unscoped `PrismaClient` for auth
  bootstrap only. It stays until `auth.service.ts` moves onto `database/prisma.service.ts` inside
  `runSystem('AUTH_BOOTSTRAP', ...)` (see the recipe below), and then it is deleted (FU-DB-58).

An import guard (`import-guard.spec.ts`) keeps three things out of new code, because each reaches
Postgres around the org scope: `database/prisma.module`, `database/create-prisma-client`, and BE-01's
`PG_POOL` token. It reads every non-test file under `src` for `from '...'`, `require('...')` and
`import('...')`, with or without `.js`, and compares against an explicit per-file allowlist in the
spec (not folders). A new legitimate user is added to that list in the same pull request, which is
the review point.

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
not match is answered **401** and the handler does not run (FU-DB-65 changes this to 500 in a
later PR). A `@Public()` route has no `request.user`
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
to another org either. `runRawSql` needs an active scope: **scope first, then `runRawSql`** (inside
`runSystem`, `runAsUser` or `runInOrg`). Called with no scope it throws, so there is no other
order. Treat every `runSystem` and `runRawSql` in a pull request as a review flag.

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
or update. A nested guard ("Nested writes and nested cursors" below) refuses the nested writes and
nested cursors that could change or rank against another org's rows. Everything else reached
through a relation is **not** looked at.

- **(a) Ids written through a relation or a scalar foreign key.** A parent-side `connect`,
  `connectOrCreate` or `set`, nested writes through a `RULE_I` relation, and a nested row of a
  model with its own `org_id` that names another org are refused in an org scope (see "Nested
  writes and nested cursors"). A child-side `connect` is the same as setting the scalar foreign key,
  and neither is checked: **every such id follows rule (i)**. Load it through the scoped client
  first, and answer 404 on a miss.
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

| Class       | Count | What it is                                                                                                                                                             | Who guards it                                          |
| ----------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `ORG_ID`    | 9     | the `org_id` key of a model with its own org (to `organizations`)                                                                                                      | the scope (filter and stamp)                           |
| `SCOPE_HOP` | 21    | the first hop of a path model's scope path (its own parent)                                                                                                            | the scope filter; creating or re-parenting is rule (i) |
| `COMPOSITE` | 3     | `(id, org_id)` keys on `invitations` (2) and `sessions` (1), ADR 0006 2 ii                                                                                             | the database                                           |
| `RULE_I`    | 25    | references the scope cannot check: **12 staff** (to users: `created_by`, `reviewer_id`, `assigned_to`, ...) and **13 cross-chain** (another chain, or a second parent) | **rule (i)**                                           |

`SCOPE_HOP + COMPOSITE + RULE_I` is 49; the 9 `ORG_ID` keys make 58. Each `RULE_I` entry also says
whether it is `staff` or `cross-chain` (`ruleI`).

`RULE_I_REFERENCES` (the 25 `RULE_I` keys) is the list a service must follow: **before writing an
id into any of these columns, load the row through the scoped client and answer 404 on a miss.**
Module tests and code review take their checklist from it, for example "every write of
`session_questions.test_question_id` loads the test question first".

The same table says which side of each relation holds the key, and its class, which the nested
guard needs (next section).

## Nested writes and nested cursors

In an org scope, `applyOrgScope` walks the `data` of `create`, `update`, `updateMany`, `upsert`
(and their `*AndReturn` forms) at any depth, and the `include` and `select` of every operation. It
visits relation fields only (the table above says which fields are relations and which class of
foreign key each one is), so it never descends into a Json column and leaves a scalar list's
`{ set: [...] }` alone. It adds no query. It **refuses** with `OrgScopeViolationError` (the message
names models and fields, never values):

- `connect`, `connectOrCreate` and `set` on a **parent-side** relation (the key is on the related
  model): they change rows the scope filter never selected. Example:
  `organization.update({ where: { id: A }, data: { users: { connect: { id: userOfB } } } })`.
- `create`, `createMany`, `update`, `updateMany`, `upsert`, `delete`, `deleteMany` and
  `connectOrCreate` **through a `RULE_I` relation, on either side** (and a parent-side
  `disconnect`). The row on the other side of a `RULE_I` relation can belong to another org after
  one rule (i) slip, so
  `sessionReview.update({ data: { reviewer: { connect: { id: userOfB }, update: { passwordHash } } } })`
  would take over that user, and `user.update({ data: { sessionReviews: { updateMany } } })` would
  rewrite other orgs' reviews that name this user. Write those rows with their own scoped call.
- a nested `create`, `update`, `upsert` or `createMany` of a model with its own `org_id` that names
  another org, through `orgId` or `org: { connect }`; a nested create of an organization; and a
  nested operation the guard does not know.
- **a `cursor` anywhere inside `include` or `select`**, at any depth (and in `_count`). Prisma finds
  a nested cursor row by its own fields too (shown on Prisma 7: `id >= (SELECT id FROM
proctor_events WHERE id = $cursor)`), so it ranks the caller's rows against another org's row.
  The fluent API (`session.findUnique(...).proctorEvents({ cursor })`) reaches the extension as a
  `select` on the relation and is refused the same way. **Page nested relations with `where`,
  `take` and `orderBy`.**

It **allows**:

- a **child-side `connect` or `disconnect`** through any relation (the key is on this model: the
  same as setting or clearing the scalar foreign key, so it stays under rule (i));
- nested `create`, `update`, `upsert` and `delete` through a **`SCOPE_HOP`, `COMPOSITE` or `ORG_ID`**
  relation (`test.sections`, `candidate.invitations`, `organization.questions`). Only there does the
  nested write act inside the parent's own subtree, in the parent's org by construction. That is
  **not** true through a `RULE_I` relation, which is why those are refused above.

A `createMany` of a path model is flat and is not walked.

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
- Connect as `app_user` (`DATABASE_URL`). `MIGRATION_DATABASE_URL` never appears in API code.

## Files

| File                                           | What it holds                                                                                                      |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `create-prisma-client.ts`                      | The only `new PrismaClient` (ADR 0009 section 4.2)                                                                 |
| `prisma.service.ts`, `database.module.ts`      | The Nest service (connect, disconnect) and the global module                                                       |
| `org-scope-map.ts`                             | The scope map and `orgFilter`                                                                                      |
| `org-scope-args.ts`                            | Pure argument rewriting per operation, and the operation coverage check                                            |
| `org-scope-nested.ts`                          | The nested guards: nested writes that reach another org's rows, and nested cursors                                 |
| `org-scope-relations.ts`                       | Every foreign key classified (`FK_CLASSES`, `RULE_I_REFERENCES`) and the side of every relation that holds the key |
| `org-scope.extension.ts`                       | The `$extends` query extension and `OrgScopedPrismaClient`                                                         |
| `org-context.ts`, `org-context.interceptor.ts` | The AsyncLocalStorage context, its API, and the HTTP population point                                              |
| `prisma.module.ts`                             | BE-02's interim unscoped client for auth bootstrap only (not part of DB-05)                                        |
| `errors.ts`                                    | `OrgContextMissingError`, `OrgScopeViolationError`, `RawQueryNotAllowedError`                                      |
| `testing/`                                     | Test helpers (excluded from the build): throwaway migrated Postgres, fixtures, scope checks                        |

Tests (`*.spec.ts`) name TC-008 and NFR-04 or FR-103: the map completeness test and its failure
cases, the argument rewriting for every operation and model, the context and interceptor, the
extension without a database, the TC-008 matrix against a real Postgres (all read operations and the
update and delete operations as org A against org B's rows in all 31 models, with positive controls;
upsert, create, cursors, nested writes and the HTTP path on chosen models), and a smoke test that builds the API
and runs the compiled client and `DatabaseModule` on Node. `auth-bootstrap.spec.ts` covers what
BE-02's auth needs: raw SQL and transactions inside system scope, and the statement counts
(NFR-04, FR-104).
