// Shared transaction helpers of the question bank (QuestionsService and VariantsService): the row
// lock, the draft guard, the revision check and the audit row. See the header of
// questions.service.ts for the locking rules; every mutation of a question, test cases and
// variants included, starts with `lockWritable` or `lockDraft` and reads only after it.
import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { OrgScopedPrismaClient } from '../database/org-scope.extension';
import { Prisma } from '../generated/prisma/client';
import type { Question, QuestionVersion } from '../generated/prisma/client';
import type { RequestContext } from '../common/request-context';
import { computeRevision } from './revision';

export interface Actor {
  id: string;
  orgId: string;
}

export type Db = Pick<
  OrgScopedPrismaClient,
  | 'question'
  | 'questionVersion'
  | 'testCase'
  | 'questionVariant'
  | 'variantTestCase'
  | 'aiReferenceSolution'
  | 'organization'
  | 'auditLog'
>;

export const NOT_FOUND = 'Question not found.';
export const noHistory = { validatedAt: null, validationReport: Prisma.DbNull } as const;

export async function requireQuestion(db: Db, id: string): Promise<Question> {
  const q = await db.question.findUnique({ where: { id } });
  if (!q) throw new NotFoundException(NOT_FOUND);
  return q;
}

/**
 * Locks the question row for a mutation and returns it. A missing or other-org id is 404 and an
 * archived question is 409; both take the same statements whether the id is another org's or
 * missing.
 */
export async function lockWritable(db: Db, id: string): Promise<Question> {
  const { count } = await db.question.updateMany({
    where: { id, isArchived: false },
    data: { isArchived: false },
  });
  const q = await requireQuestion(db, id);
  if (count !== 1) throw new ConflictException('The question is archived.');
  return q;
}

export function latestVersion(db: Db, questionId: string): Promise<QuestionVersion | null> {
  return db.questionVersion.findFirst({ where: { questionId }, orderBy: { version: 'desc' } });
}

/** A variant with its per-slot overrides, as stored. */
export interface VariantRow {
  id: string;
  params: unknown;
  renderedStatement: string;
  isActive: boolean;
  testCaseOverrides: { testCaseId: string; input: string; expectedOutput: string }[];
}

export function loadVariants(db: Db, questionVersionId: string): Promise<VariantRow[]> {
  return db.questionVariant.findMany({
    where: { questionVersionId },
    include: { testCaseOverrides: true },
    orderBy: { id: 'asc' },
  });
}

/** Optimistic concurrency: a client that loaded an older revision must reload (409, no code). */
export async function checkRevision(
  db: Db,
  head: QuestionVersion,
  expected: string | undefined,
): Promise<void> {
  if (expected === undefined) return;
  const cases = await db.testCase.findMany({ where: { questionVersionId: head.id } });
  const variants = await loadVariants(db, head.id);
  if (computeRevision(head, cases, variants) !== expected) {
    throw new ConflictException(
      'The question changed since you loaded it; reload it and apply your edit again.',
    );
  }
}

/**
 * The draft version a test case or variant change targets, locked and with its validation result
 * cleared (changed test data invalidates the last validation run). A published version is
 * immutable: 409.
 */
export async function lockDraft(
  db: Db,
  id: string,
  version: number,
  what = 'test cases',
): Promise<QuestionVersion> {
  const question = await lockWritable(db, id);
  const v = await db.questionVersion.findFirst({ where: { questionId: id, version } });
  if (!v) throw new NotFoundException(NOT_FOUND);
  if (question.type !== 'CODING') {
    throw new UnprocessableEntityException(`Only coding questions have ${what}.`);
  }
  const { count } = await db.questionVersion.updateMany({
    where: { id: v.id, isPublished: false },
    data: noHistory,
  });
  if (count !== 1) {
    throw new ConflictException(
      'A published version is immutable; edit the question to create a new version.',
    );
  }
  return v;
}

export async function audit(
  tx: Db,
  actor: Actor,
  action: string,
  entityId: string,
  ctx: RequestContext,
  metadata: Prisma.InputJsonObject,
): Promise<void> {
  await tx.auditLog.create({
    data: {
      orgId: actor.orgId,
      actorId: actor.id,
      action,
      entityType: 'question',
      entityId,
      ip: ctx.ip ?? null,
      metadata,
    },
  });
}
