// The Prisma client extension that enforces org scoping (ADR 0006 section 1, ADR 0009 section 4.2:
// Prisma 7 has no `$use` middleware, so this is a `$extends` query extension).
//
// One hook, `query.$allOperations`, sees every model operation and every raw query:
//
//   Model operation   The model's rule in ORG_SCOPE decides. With no org context the call throws
//                     OrgContextMissingError. In an org scope, applyOrgScope adds the filter (or
//                     stamps and checks the payload). In system scope the call runs unfiltered,
//                     but a nested relation write, an `orgId` in an update and a change of a
//                     path model's first-hop scope key (`testId` of TestSection) are still refused.
//                     An unscoped model runs as it is. A model with no rule, or an operation that
//                     is not in SCOPED_OPERATIONS, is refused: the extension fails closed.
//   Raw query         $queryRaw, $queryRawUnsafe, $executeRaw, $executeRawUnsafe (and any other
//                     operation without a model) are refused unless the caller is inside
//                     OrgContextService.runRawSql(reason, fn). Raw SQL cannot be filtered, so the
//                     SQL itself must filter by org_id, and the reason says why it is allowed. In a
//                     session scope (runAsCandidate, runAsSessionJob) it is refused even inside
//                     runRawSql (ADR 0006 section 8.5, ADR 0013 CS-4.2).
//   Session scope     An org scope bound to one session (ADR 0013 CS-4): the model's org rule
//                     applies, and on top of it the session filter, the CANDIDATE allowlist, the
//                     relation-vector refusal and the CS-4.4 column control: read allowlist, default
//                     omit, grants, RUN filter (session-scope-args.ts, candidate-interim.ts). A create of
//                     a submission or a keystroke batch first runs ONE existence check on
//                     session_questions, and a consents create ONE read of the org's current consent text
//                     (below).
//   Grant             withGrant (org-context.ts) puts a grant in the store. A query that runs under one
//                     that has ended (its callback settled) throws, in every scope and for raw SQL too.
//
// Nested relation writes are denied by default (ADR 0006 section 8): in any scope the extension
// applies to, org scope and system scope, every nested relation write in `data` is refused
// (connect, connectOrCreate, create, createMany, update, updateMany, upsert, delete, deleteMany,
// set, disconnect), through every relation class and on both sides, `org: { connect }` included
// (org-scope-nested.ts). `connect` through a COMPOSITE relation rewrites org_id, `connect` next to
// an `update` writes the connected row, and the other classes reach rows the filter never selected,
// so no shape is safe by class. Services write with scalar foreign keys (Prisma's unchecked
// inputs) and separate top-level calls; Postgres checks the composite keys. The exception list
// NESTED_WRITE_ALLOWLIST is empty, and an entry needs its own cross-org test. A cursor nested in
// include or select (and the fluent API) is refused too.
//
// What it does not do. Only the top-level model, its `where`, its `cursor`, the `orgId` of a create
// or update, nested relation writes and nested cursors are looked at. Everything else reached
// through a relation is not (README "Limits"):
//
// (a) Ids written as scalar foreign keys. The extension does not check which id is written; the
//     composite keys (invitations.test_id, invitations.candidate_id, sessions.invitation_id) are
//     checked by Postgres, and every other id follows ADR 0006 section 2 rule (i): load each
//     through the scoped client first, answer 404 on a miss.
// (b) In an org scope, an update that changes a path model's first-hop foreign key (re-parenting,
//     for example `testSection.update({ data: { testId } })`) is the same as a path create: rule
//     (i). System scope refuses it (FU-DB-107), as it refuses `orgId` in an update.
// (c) Nested reads are not filtered. `include`, `select`, the fluent API, relation filters,
//     `orderBy` on a relation and `_count` follow foreign keys blindly, so any foreign key that
//     crosses orgs leaks: `sessionReview.findUnique({ include: { reviewer: true } })` returns the
//     reviewer user row of another org, password hash included, if reviewer_id points there.
// (d) Rule (i) covers 27 foreign keys, not only the staff references and
//     test_questions.question_version_id (RULE_I_REFERENCES in org-scope-relations.ts, 27 keys: 14
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
import { applyOrgScope, assertSystemScopeWrite, isScopedOperation } from './org-scope-args';
import { scrubPrismaError } from './error-scrub';
import { ORG_SCOPE } from './org-scope-map';
import { assertPlainArgs } from './plain-args';
import { assertScheduleCapacityScope } from './schedule-capacity';
import type { ModelName, OrgScopeRule } from './org-scope-map';
import {
  applySessionScope,
  assertCandidateModelAllowed,
  sessionQuestionsWhere,
} from './session-scope-args';

interface HookArgs {
  readonly model?: string;
  readonly operation: string;
  readonly args: unknown;
  readonly query: (args: unknown) => Promise<unknown>;
}

/** Runs the query, and keeps argument values out of any Prisma error it throws (FU-DB-70). */
async function execute(query: HookArgs['query'], args: unknown): Promise<unknown> {
  try {
    return await query(args);
  } catch (error) {
    throw scrubPrismaError(error);
  }
}

function ruleFor(model: string): OrgScopeRule | undefined {
  return Object.hasOwn(ORG_SCOPE, model) ? ORG_SCOPE[model as ModelName] : undefined;
}

/** Counts session_questions for the existence check of a create; see assertSessionQuestionsExist. */
export type SessionQuestionCounter = (where: Record<string, unknown>) => Promise<number>;

/**
 * The scoped primary-key existence check of ADR 0013 CS-4.2. `submissions` and `keystroke_batches`
 * name a session_question the context cannot check, so a create first counts the session_questions
 * with those ids under the org filter AND the session filter, and throws unless every distinct id is
 * found. One query, however many rows a createMany carries. It runs on the client's own connection,
 * outside a caller's interactive transaction: a session_question created earlier in the same,
 * uncommitted transaction is not visible to it, and the create then fails closed (FU-DB-182). No id
 * or value is in the message.
 */
async function assertSessionQuestionsExist(
  count: SessionQuestionCounter | undefined,
  where: { model: string; operation: string; orgId: string; sessionId: string },
  ids: readonly string[],
): Promise<void> {
  if (count === undefined) {
    throw new OrgScopeViolationError(
      `${where.model}.${where.operation}: no session_questions lookup is configured for the existence check.`,
    );
  }
  let found: number;
  try {
    found = await count(sessionQuestionsWhere(where.orgId, where.sessionId, ids));
  } catch (error) {
    throw scrubPrismaError(error);
  }
  if (found !== new Set(ids).size) {
    throw new OrgScopeViolationError(
      `${where.model}.${where.operation}: sessionQuestionId is not a question of this session (ADR 0013 CS-4.2).`,
    );
  }
}

/**
 * Reads `organizations.current_consent_text_id` of one org, or `null` when it has none (or the org is not
 * found). The factory client's own connection, outside a caller's transaction (FU-DB-192).
 */
export type CurrentConsentTextReader = (orgId: string) => Promise<string | null>;

/**
 * The check of a consents create (ADR 0013 CS-4.4, item 9): the text the create names must be the text
 * the organisation has published now. The candidate facts are already known to be set (the gate threw
 * otherwise). One read, selecting only that column, `where id = ctx.orgId`. A missing reader, a null
 * current text and a different text all throw; the service maps a different text to 409
 * CONSENT_TEXT_CHANGED. The insert follows the read, so a text published between the two is not caught
 * (the read narrows that window, it cannot close it without a transaction the extension does not own).
 * No id is in the messages.
 */
async function assertConsentTextCurrent(
  read: CurrentConsentTextReader | undefined,
  where: { model: string; operation: string; orgId: string },
  ids: readonly string[],
): Promise<void> {
  if (read === undefined) {
    throw new OrgScopeViolationError(
      `${where.model}.${where.operation}: no current-consent-text lookup is configured for the check.`,
    );
  }
  let found: string | null;
  try {
    found = await read(where.orgId);
  } catch (error) {
    throw scrubPrismaError(error);
  }
  if (found === null) {
    throw new OrgScopeViolationError(
      `${where.model}.${where.operation}: the organisation has no current consent text, so a consent ` +
        'cannot be recorded (ADR 0013 CS-4.4).',
    );
  }
  const current = found.toLowerCase();
  if (ids.some((id) => id !== current)) {
    throw new OrgScopeViolationError(
      `${where.model}.${where.operation}: consentTextId is not the current consent text of the ` +
        'organisation (ADR 0013 CS-4.4).',
    );
  }
}

export function orgScopeExtension(
  source: ScopeSource,
  countSessionQuestions?: SessionQuestionCounter,
  readCurrentConsentText?: CurrentConsentTextReader,
) {
  return Prisma.defineExtension({
    name: 'org-scope',
    query: {
      $allOperations: async ({ model, operation, args, query }: HookArgs): Promise<unknown> => {
        const store = source.current();

        // A grant that has ended: its callback settled, so nothing may use it any more (ADR 0013 CS-4.4,
        // "Lifetime"). This is the one place that stops a promise or a timer that the callback started
        // and did not await, whose AsyncLocalStorage store is still alive. It applies to every query of
        // every scope, raw SQL included, before anything else.
        if (store?.grant !== undefined && !store.grant.active) {
          throw new OrgScopeViolationError(
            `${model ?? operation}: the grant of this unit of work has ended (its callback settled); a ` +
              'query that outlives withGrant is refused (ADR 0013 CS-4.4).',
          );
        }

        // Arguments must be plain (B1 of the #185 review): Prisma reads inherited keys that the checks
        // below do not see, so a foreign prototype or an inherited key is refused before anything else
        // reads the arguments, in EVERY scope, system and staff included (plain-args.ts).
        if (model !== undefined) assertPlainArgs(model, operation, args);

        // Raw queries and any other operation that is not tied to a model.
        if (model === undefined) {
          // Refused in a session scope even inside runRawSql (ADR 0006 section 8.5, CS-4.2).
          if (store?.scope?.kind === 'org' && store.scope.session !== undefined) {
            throw new RawQueryNotAllowedError(operation, true);
          }
          if (store?.rawSqlReason === undefined) throw new RawQueryNotAllowedError(operation);
          return execute(query, args);
        }

        const rule = ruleFor(model);
        if (rule === undefined) {
          throw new OrgScopeViolationError(
            `${model} has no entry in ORG_SCOPE (apps/api/src/database/org-scope-map.ts).`,
          );
        }
        // Deny by default in every scope, unscoped models included (FU-DB-160, ADR 0006 section 8.2):
        // an operation outside SCOPED_OPERATIONS (findRaw and aggregateRaw exist on every delegate at
        // runtime, even on PostgreSQL) never runs.
        if (!isScopedOperation(operation)) {
          throw new OrgScopeViolationError(
            `${model}.${operation}: unknown operation. Add it to SCOPED_OPERATIONS and handle it.`,
          );
        }

        const scope = store?.scope;
        const isCandidate = scope?.kind === 'org' && scope.session?.actor === 'CANDIDATE';
        // CS-4.3 deny by default comes first, before the `unscoped` early return: a model that is
        // global on purpose is still not reachable by a candidate unless the allowlist names it.
        if (isCandidate) assertCandidateModelAllowed(model, operation, store?.grant);
        if (rule.kind === 'unscoped') {
          if (isCandidate) {
            // On the allowlist and global: no row filter exists for it yet, so it fails closed.
            throw new OrgScopeViolationError(
              `${model}.${operation}: an unscoped model has no CANDIDATE row filter (ADR 0013 CS-4.3).`,
            );
          }
          return execute(query, args);
        }

        if (scope === undefined) throw new OrgContextMissingError(`${model}.${operation}`);
        if (scope.kind === 'system') {
          // ADR 0017 section 4.7 (C-53): scheduled_windows is read across organisations only under
          // SCHEDULE_CAPACITY, in five columns, and never written in system scope; the reason reads
          // nothing else (schedule-capacity.ts).
          assertScheduleCapacityScope(model, operation, scope.reason, args);
          // System scope is unfiltered, but an unknown operation, a nested relation write, an orgId
          // in an update and a change of a path model's first-hop scope key are refused here too
          // (a row is never moved to another org).
          assertSystemScopeWrite(model as ModelName, rule, operation, args);
          return execute(query, args);
        }

        if (scope.session !== undefined) {
          // ADR 0013 CS-4: org filter, session filter, and for a CANDIDATE the allowlist, the
          // relation-vector refusal and the column control (the grant, if one is active, is part of it).
          // A create that names a session_question proves it first, and a consents create proves its
          // consent text.
          const result = applySessionScope({
            model: model as ModelName,
            rule,
            operation,
            args,
            orgId: scope.orgId,
            session: scope.session,
            facts: source.candidateFacts(),
            grant: store?.grant,
          });
          if (result.sessionQuestionIds.length > 0) {
            await assertSessionQuestionsExist(
              countSessionQuestions,
              { model, operation, orgId: scope.orgId, sessionId: scope.session.sessionId },
              result.sessionQuestionIds,
            );
          }
          if (result.consentTextIds.length > 0) {
            await assertConsentTextCurrent(
              readCurrentConsentText,
              { model, operation, orgId: scope.orgId },
              result.consentTextIds,
            );
          }
          return execute(query, result.args);
        }

        return execute(
          query,
          applyOrgScope({ model: model as ModelName, rule, operation, args, orgId: scope.orgId }),
        );
      },
    },
  });
}

export function createOrgScopedClient(base: PrismaClient, source: ScopeSource) {
  // The existence check uses the base (unextended) client with the org and session filters built by
  // hand (sessionQuestionsWhere), so it neither recurses into this extension nor depends on it.
  const countSessionQuestions: SessionQuestionCounter = (where) =>
    base.sessionQuestion.count({ where });
  // The same for the consent text check: one column of the caller's own org, by id, on the base client.
  const readCurrentConsentText: CurrentConsentTextReader = async (orgId) =>
    (
      await base.organization.findUnique({
        where: { id: orgId },
        select: { currentConsentTextId: true },
      })
    )?.currentConsentTextId ?? null;
  return base.$extends(orgScopeExtension(source, countSessionQuestions, readCurrentConsentText));
}

/** The client every repository and service uses: all queries go through the org scope. */
export type OrgScopedPrismaClient = ReturnType<typeof createOrgScopedClient>;
