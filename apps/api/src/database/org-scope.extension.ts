// The Prisma client extension that enforces org scoping (ADR 0006 section 1, ADR 0009 section 4.2:
// Prisma 7 has no `$use` middleware, so this is a `$extends` query extension).
//
// One hook, `query.$allOperations`, sees every model operation and every raw query:
//
//   Model operation   The model's rule in ORG_SCOPE decides. With no org context the call throws
//                     OrgContextMissingError. In an org scope, applyOrgScope adds the filter (or
//                     stamps and checks the payload). In system scope the call runs unfiltered.
//                     An unscoped model runs as it is. A model with no rule, or an operation that
//                     is not in SCOPED_OPERATIONS, is refused: the extension fails closed.
//   Raw query         $queryRaw, $queryRawUnsafe, $executeRaw, $executeRawUnsafe (and any other
//                     operation without a model) are refused unless the caller is inside
//                     OrgContextService.runRawSql(reason, fn). Raw SQL cannot be filtered, so the
//                     SQL itself must filter by org_id, and the reason says why it is allowed.
//
// What it does not do. Only the top-level model, its `where`, its `cursor`, the `orgId` of a create
// or update, and nested writes (org-scope-nested.ts, FU-DB-63) are looked at. Everything else
// reached through a relation is not (README "Limits"):
//
// (a) Ids written through a relation or a scalar foreign key. In an org scope a parent-side
//     `connect`, `connectOrCreate` or `set` is refused (it changes rows the filter never selected:
//     `organization.update({ where: { id: A }, data: { users: { connect: { id: userOfB } } } })`),
//     and so is a nested row of a model with its own org_id that names another org. A child-side
//     `connect` is the same as setting the scalar foreign key and stays allowed, as do nested
//     create, update, upsert and delete under an in-scope parent. The ids in all of them follow
//     ADR 0006 section 2 rule (i): load each through the scoped client first, answer 404 on a miss.
// (b) An update that changes a path model's first-hop foreign key (re-parenting, for example
//     `testSection.update({ data: { testId } })`) is the same as a path create: rule (i).
// (c) Nested reads are not filtered. `include`, `select`, the fluent API, relation filters,
//     `orderBy` on a relation and `_count` follow foreign keys blindly, so any foreign key that
//     crosses orgs leaks: `sessionReview.findUnique({ include: { reviewer: true } })` returns the
//     reviewer user row of another org, password hash included, if reviewer_id points there.
// (d) Rule (i) covers 25 foreign keys, not only the staff references and
//     test_questions.question_version_id (RULE_I_REFERENCES in org-scope-relations.ts, 25 keys: 12
//     staff and 13 cross-chain). The main cross-chain ones: session_questions
//     to test_questions, question_versions and question_variants; session_sections to
//     test_sections; consents to consent_texts; keystroke_batches to session_questions;
//     webhook_deliveries to sessions; organizations to consent_texts.
// (e) The raw SQL hatch is not reset by a nested scope: an open runRawSql stays open inside a
//     runAsUser or runInOrg started within it. Wrap only the single raw statement.
import { Prisma } from '../generated/prisma/client.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { OrgContextMissingError, OrgScopeViolationError, RawQueryNotAllowedError } from './errors';
import type { ScopeSource } from './org-context';
import { applyOrgScope } from './org-scope-args';
import { ORG_SCOPE } from './org-scope-map';
import type { ModelName, OrgScopeRule } from './org-scope-map';

interface HookArgs {
  readonly model?: string;
  readonly operation: string;
  readonly args: unknown;
  readonly query: (args: unknown) => Promise<unknown>;
}

function ruleFor(model: string): OrgScopeRule | undefined {
  return Object.hasOwn(ORG_SCOPE, model) ? ORG_SCOPE[model as ModelName] : undefined;
}

export function orgScopeExtension(source: ScopeSource) {
  return Prisma.defineExtension({
    name: 'org-scope',
    query: {
      $allOperations: async ({ model, operation, args, query }: HookArgs): Promise<unknown> => {
        const store = source.current();

        // Raw queries and any other operation that is not tied to a model.
        if (model === undefined) {
          if (store?.rawSqlReason === undefined) throw new RawQueryNotAllowedError(operation);
          return query(args);
        }

        const rule = ruleFor(model);
        if (rule === undefined) {
          throw new OrgScopeViolationError(
            `${model} has no entry in ORG_SCOPE (apps/api/src/database/org-scope-map.ts).`,
          );
        }
        if (rule.kind === 'unscoped') return query(args);

        const scope = store?.scope;
        if (scope === undefined) throw new OrgContextMissingError(`${model}.${operation}`);
        if (scope.kind === 'system') return query(args);

        return query(
          applyOrgScope({ model: model as ModelName, rule, operation, args, orgId: scope.orgId }),
        );
      },
    },
  });
}

export function createOrgScopedClient(base: PrismaClient, source: ScopeSource) {
  return base.$extends(orgScopeExtension(source));
}

/** The client every repository and service uses: all queries go through the org scope. */
export type OrgScopedPrismaClient = ReturnType<typeof createOrgScopedClient>;
