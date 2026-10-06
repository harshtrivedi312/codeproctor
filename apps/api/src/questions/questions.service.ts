// Question bank, slice 4a (FR-201, FR-202, FR-204, FR-205; BE-04). Every query runs through the
// org-scoped client, so another org's question is simply not found: the same 404 as a missing id
// (TC-008). Versions: a question has version rows numbered from 1. The highest number is the
// latest. A published version is immutable (database.md immutability rule): it is never updated
// and its test cases never change; editing a published question creates the next version as a
// draft (FR-204), which becomes `current_version_id` when published. Past sessions point at the
// version row they ran, so they never change (TC-013).
//
// Locking. Every mutation of a question starts with `lockWritable`, an UPDATE of the question row
// that is a no-op by value and guarded by is_archived = false. It takes the row lock, so all
// mutations of one question (edit, publish, archive, test cases, and later the validate job) run
// one at a time, and everything is read AFTER the lock: no mutation works on a stale read. The
// version updates keep their own `is_published = false` guard as a second line. Lock order is
// always question row, then version row.
//
// Mutations write their audit row in the same transaction. Audit metadata names ids and changed
// fields only, never content. `full` (see staff-view.ts) is decided once in the controller.
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';
import { Prisma } from '../generated/prisma/client';
import type { Question } from '../generated/prisma/client';
import type { RequestContext } from '../common/request-context';
import { InvalidAnswerSpecError, toCandidateQuestion } from './candidate-view';
import type { CandidateQuestionView } from './candidate-view';
import { computeRevision } from './revision';
import {
  audit,
  checkRevision,
  latestVersion,
  loadVariants,
  lockDraft,
  lockWritable,
  noHistory,
  NOT_FOUND,
  requireQuestion,
} from './question-tx';
import type { Actor, Db } from './question-tx';
import { aiReferenceProblems, minAssistantsFromSettings } from './ai-reference-rules';
import { renderVariant, variantPublishProblems } from './variant-rules';
import { checkLimits, limitsToStored, publishProblems, shapeProblems } from './question-content';
import type { Limits } from './question-content';
import { MAX_TEST_CASES } from './dto/questions.dto';
import type {
  CreateQuestionDto,
  QuestionDetailDto,
  QuestionListDto,
  QuestionListQueryDto,
  QuestionSummaryDto,
  TestCaseDto,
  CreateTestCaseDto,
  UpdateQuestionDto,
  UpdateTestCaseDto,
} from './dto/questions.dto';
import {
  toFullVersion,
  toStaffReadVersion,
  toTestCaseDto,
  toVersionRef,
  VERSION_REF_SELECT,
} from './staff-view';
import type { VersionRefRow } from './staff-view';

/** The most rows a list can skip: deep offsets are refused (400), as in the staff user list. */
export const MAX_LIST_OFFSET = 10_000;

export type { Actor };

function slugFromTitle(title: string): string {
  const base = title
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return `${base || 'question'}-${randomBytes(3).toString('hex')}`;
}

const isUniqueViolation = (e: unknown): boolean =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

@Injectable()
export class QuestionsService {
  constructor(private readonly prisma: PrismaService) {}

  // ---- read -----------------------------------------------------------------------------------

  /**
   * `full` false (no question:update): published versions only. A question that was never
   * published is not listed and no draft version ref appears (the same rule as `get`).
   */
  async list(q: QuestionListQueryDto, full: boolean): Promise<QuestionListDto> {
    if ((q.page - 1) * q.pageSize > MAX_LIST_OFFSET) {
      throw new BadRequestException('The page is too deep; narrow the filters instead.');
    }
    const where: Prisma.QuestionWhereInput = {
      ...(q.includeArchived && full ? {} : { isArchived: false }),
      ...(full ? {} : { currentVersionId: { not: null } }),
      ...(q.type ? { type: q.type } : {}),
      ...(q.tag ? { tags: { has: q.tag } } : {}),
      ...(q.difficulty
        ? {
            OR: [
              { currentVersion: { is: { difficulty: q.difficulty } } },
              { currentVersionId: null, versions: { some: { difficulty: q.difficulty } } },
            ],
          }
        : {}),
    };
    const db = this.prisma.client;
    const [rows, total] = await Promise.all([
      db.question.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      db.question.count({ where }),
    ]);
    // Reference columns only: never the statement, code maps or answer_spec of every version.
    const versions = rows.length
      ? await db.questionVersion.findMany({
          where: {
            questionId: { in: rows.map((r) => r.id) },
            ...(full ? {} : { isPublished: true }),
          },
          select: { questionId: true, ...VERSION_REF_SELECT },
          orderBy: [{ questionId: 'asc' }, { version: 'desc' }],
        })
      : [];
    const items = rows.flatMap((row) => {
      const mine = versions.filter((v) => v.questionId === row.id);
      const latest = mine[0];
      return latest ? [this.summary(row, mine, latest)] : [];
    });
    return { items, page: q.page, pageSize: q.pageSize, total };
  }

  async get(id: string, version: number | undefined, full: boolean): Promise<QuestionDetailDto> {
    return this.detail(this.prisma.client, id, version, full, false);
  }

  /**
   * The candidate-facing rendering of a version (FR-202, TC-011). Callers without question:update
   * see published versions only (default: the current one); a draft, a never-published question
   * and a missing or other-org id are the same 404.
   */
  async preview(
    id: string,
    version: number | undefined,
    full: boolean,
  ): Promise<CandidateQuestionView> {
    const db = this.prisma.client;
    const question = await requireQuestion(db, id);
    const row =
      version !== undefined
        ? await db.questionVersion.findFirst({
            where: { questionId: id, version, ...(full ? {} : { isPublished: true }) },
          })
        : question.currentVersionId
          ? await db.questionVersion.findFirst({
              where: { id: question.currentVersionId, questionId: id },
            })
          : full
            ? await latestVersion(db, id)
            : null;
    if (!row) throw new NotFoundException(NOT_FOUND);
    const testCases = await db.testCase.findMany({
      where: { questionVersionId: row.id },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
    });
    try {
      return toCandidateQuestion({ ...row, type: question.type }, testCases);
    } catch (e) {
      if (e instanceof InvalidAnswerSpecError) {
        throw new UnprocessableEntityException('The answer_spec of this version is incomplete.');
      }
      throw e;
    }
  }

  // ---- create ---------------------------------------------------------------------------------

  async create(
    actor: Actor,
    dto: CreateQuestionDto,
    ctx: RequestContext,
    full: boolean,
  ): Promise<QuestionDetailDto> {
    const type = dto.type ?? 'CODING';
    const limits: Limits = dto.limits ?? { cpuMs: 2000, wallMs: 5000, memoryKb: 262_144 };
    const content = {
      allowedLanguages: dto.allowedLanguages ?? [],
      starterCode: dto.starterCode ?? {},
      referenceSolution: dto.referenceSolution ?? {},
      answerSpec: dto.answerSpec ?? null,
    };
    const problems = [...shapeProblems(type, content), ...checkLimits(limits)];
    if (type !== 'CODING' && (dto.testCases?.length ?? 0) > 0) {
      problems.push(`testCases: not allowed on a ${type} question`);
    }
    if (problems.length) throw new BadRequestException(problems);

    // A generated slug that collides is retried once; an explicit one is a 409.
    for (let attempt = 0; ; attempt++) {
      const slug = dto.slug ?? slugFromTitle(dto.title);
      try {
        const id = await this.prisma.client.$transaction(async (tx) => {
          const question = await tx.question.create({
            data: {
              orgId: actor.orgId,
              slug,
              type,
              tags: dto.tags ?? [],
              createdById: actor.id,
            },
          });
          const version = await tx.questionVersion.create({
            data: {
              questionId: question.id,
              version: 1,
              title: dto.title,
              statementMd: dto.statementMd,
              difficulty: dto.difficulty,
              allowedLanguages: content.allowedLanguages,
              limits: limitsToStored(limits),
              starterCode: content.starterCode,
              referenceSolution: content.referenceSolution,
              answerSpec:
                content.answerSpec === null
                  ? Prisma.DbNull
                  : (content.answerSpec as Prisma.InputJsonObject),
            },
          });
          const cases = dto.testCases ?? [];
          if (cases.length) {
            await tx.testCase.createMany({
              data: cases.map((t, i) => ({
                questionVersionId: version.id,
                input: t.input,
                expectedOutput: t.expectedOutput,
                isHidden: t.isHidden ?? true,
                weight: t.weight ?? 1,
                position: t.position ?? i,
              })),
            });
          }
          await audit(tx, actor, 'QUESTION_CREATED', question.id, ctx, {
            type,
            version: 1,
            testCases: cases.length,
          });
          return question.id;
        });
        return await this.detail(this.prisma.client, id, undefined, full, false);
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
        if (dto.slug !== undefined || attempt >= 1) {
          throw new ConflictException('A question with this slug already exists.');
        }
      }
    }
  }

  // ---- update ---------------------------------------------------------------------------------

  /**
   * Edits the latest version in place while it is a draft. When the latest version is published
   * it is left untouched and the edit becomes the next version, a draft (FR-204, TC-013).
   * `tags` live on the question and change without a new version.
   */
  async update(
    actor: Actor,
    id: string,
    dto: UpdateQuestionDto,
    ctx: RequestContext,
    full: boolean,
  ): Promise<QuestionDetailDto> {
    const { tags, expectedRevision, ...rest } = dto;
    const contentFields = (Object.keys(rest) as (keyof typeof rest)[]).filter(
      (k) => rest[k] !== undefined,
    );
    if (tags === undefined && contentFields.length === 0) {
      throw new BadRequestException('Send at least one field to change.');
    }
    let forked: boolean;
    try {
      forked = await this.prisma.client.$transaction(async (tx) => {
        const question = await lockWritable(tx, id);
        const head = await latestVersion(tx, id);
        if (!head) throw new NotFoundException(NOT_FOUND);
        await checkRevision(tx, head, expectedRevision);
        if (tags !== undefined) await tx.question.update({ where: { id }, data: { tags } });
        if (contentFields.length === 0) {
          await audit(tx, actor, 'QUESTION_UPDATED', id, ctx, { fields: ['tags'] });
          return false;
        }
        const merged = {
          title: rest.title ?? head.title,
          statementMd: rest.statementMd ?? head.statementMd,
          difficulty: rest.difficulty ?? head.difficulty,
          allowedLanguages: rest.allowedLanguages ?? head.allowedLanguages,
          limits: rest.limits ? limitsToStored(rest.limits) : head.limits,
          starterCode: rest.starterCode ?? head.starterCode,
          referenceSolution: rest.referenceSolution ?? head.referenceSolution,
          answerSpec: rest.answerSpec !== undefined ? rest.answerSpec : head.answerSpec,
        };
        const problems = [
          ...shapeProblems(question.type, merged),
          ...(rest.limits ? checkLimits(rest.limits) : []),
        ];
        // Variants (FR-203): the edited statement, starter code and reference solution must still
        // render for every ACTIVE variant, so a draft never holds an unrenderable active variant.
        const variants = question.type === 'CODING' ? await loadVariants(tx, head.id) : [];
        const rendered = new Map<string, string>();
        if (
          rest.statementMd !== undefined ||
          rest.starterCode !== undefined ||
          rest.referenceSolution !== undefined
        ) {
          for (const x of variants.filter((v) => v.isActive)) {
            const r = renderVariant(merged, x);
            if (r.ok) rendered.set(x.id, r.content.statementMd);
            else problems.push(...r.problems);
          }
        }
        if (problems.length) throw new BadRequestException(problems);
        const fields = [...contentFields, ...(tags !== undefined ? (['tags'] as const) : [])];
        const data = {
          title: merged.title,
          statementMd: merged.statementMd,
          difficulty: merged.difficulty,
          allowedLanguages: merged.allowedLanguages,
          limits: merged.limits as Prisma.InputJsonValue,
          starterCode: merged.starterCode as Prisma.InputJsonValue,
          referenceSolution: merged.referenceSolution as Prisma.InputJsonValue,
          answerSpec:
            merged.answerSpec === null || merged.answerSpec === undefined
              ? Prisma.DbNull
              : (merged.answerSpec as Prisma.InputJsonValue),
        };
        if (!head.isPublished) {
          const { count } = await tx.questionVersion.updateMany({
            where: { id: head.id, isPublished: false },
            data: { ...data, ...noHistory },
          });
          if (count !== 1) throw new ConflictException('The version was published meanwhile.');
          for (const [variantId, renderedStatement] of rendered) {
            await tx.questionVariant.updateMany({
              where: { id: variantId, questionVersionId: head.id },
              data: { renderedStatement },
            });
          }
          await audit(tx, actor, 'QUESTION_UPDATED', id, ctx, {
            version: head.version,
            fields,
          });
          return false;
        }
        const next = await tx.questionVersion.create({
          data: { questionId: id, version: head.version + 1, ...data },
        });
        const cases = await tx.testCase.findMany({
          where: { questionVersionId: head.id },
          orderBy: [{ position: 'asc' }, { id: 'asc' }],
        });
        // The copies get explicit ids so variant overrides can be re-pointed at the new slots.
        const slotIds = new Map(cases.map((t) => [t.id, randomUUID()]));
        if (cases.length) {
          await tx.testCase.createMany({
            data: cases.map((t) => ({
              id: slotIds.get(t.id),
              questionVersionId: next.id,
              input: t.input,
              expectedOutput: t.expectedOutput,
              isHidden: t.isHidden,
              weight: t.weight,
              position: t.position,
            })),
          });
        }
        // Variants and their overrides are part of the content and are copied (FR-204).
        const variantIds = new Map(variants.map((x) => [x.id, randomUUID()]));
        if (variants.length) {
          await tx.questionVariant.createMany({
            data: variants.map((x) => ({
              id: variantIds.get(x.id),
              questionVersionId: next.id,
              params: x.params as Prisma.InputJsonValue,
              renderedStatement: rendered.get(x.id) ?? x.renderedStatement,
              isActive: x.isActive,
            })),
          });
          const overrides = variants.flatMap((x) =>
            x.testCaseOverrides.flatMap((o) => {
              const variantId = variantIds.get(x.id);
              const testCaseId = slotIds.get(o.testCaseId);
              return variantId && testCaseId
                ? [{ variantId, testCaseId, input: o.input, expectedOutput: o.expectedOutput }]
                : [];
            }),
          );
          if (overrides.length) await tx.variantTestCase.createMany({ data: overrides });
        }
        await audit(tx, actor, 'QUESTION_VERSION_CREATED', id, ctx, {
          version: next.version,
          fromVersion: head.version,
          fields,
        });
        return true;
      });
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new ConflictException('A newer version was created meanwhile; reload and retry.');
      }
      throw e;
    }
    return this.detail(this.prisma.client, id, undefined, full, forked);
  }

  // ---- publish and archive --------------------------------------------------------------------

  /**
   * Publishes the latest draft after the completeness rules pass (FR-201, FR-202, FR-205) and,
   * for a coding question, a recorded passing validation run (FR-203, TC-012). The rules run on
   * the row as it is after the question lock, so no edit can slip in between check and publish.
   */
  async publish(
    actor: Actor,
    id: string,
    ctx: RequestContext,
    full: boolean,
    expectedRevision?: string,
  ): Promise<QuestionDetailDto> {
    await this.prisma.client.$transaction(async (tx) => {
      const question = await lockWritable(tx, id);
      const head = await latestVersion(tx, id);
      if (!head) throw new NotFoundException(NOT_FOUND);
      await checkRevision(tx, head, expectedRevision);
      if (head.isPublished) {
        throw new ConflictException('There is no draft to publish; edit the question first.');
      }
      const { count } = await tx.questionVersion.updateMany({
        where: { id: head.id, isPublished: false },
        data: { isPublished: true },
      });
      if (count !== 1) throw new ConflictException('The version was published meanwhile.');
      // Re-read after the version lock: the rules see exactly what is being published.
      const fresh = await tx.questionVersion.findUnique({ where: { id: head.id } });
      if (!fresh) throw new NotFoundException(NOT_FOUND);
      const cases = await tx.testCase.findMany({ where: { questionVersionId: fresh.id } });
      const variants = await loadVariants(tx, fresh.id);
      const problems = publishProblems(
        question.type,
        fresh,
        computeRevision(fresh, cases, variants),
        cases.map((t) => ({ isHidden: t.isHidden, weight: Number(t.weight) })),
      );
      // Every active variant must render cleanly and every override must name a slot of this
      // version (ADR 0007 V-2, V-6); the stored rendered statements are refreshed from the very
      // content being published.
      const vp = variantPublishProblems(fresh, new Set(cases.map((t) => t.id)), variants);
      problems.push(...vp.problems);
      if (question.type === 'CODING') {
        // ADR 0005 AI-5: current AI reference rows from enough distinct assistants per language.
        // Read after the question lock, and every AI write takes that lock, so the count is exact.
        const org = await tx.organization.findUnique({
          where: { id: actor.orgId },
          select: { settings: true },
        });
        const rows = await tx.aiReferenceSolution.findMany({
          where: { questionVersionId: fresh.id, supersededAt: null },
          select: { language: true, assistant: true },
        });
        problems.push(
          ...aiReferenceProblems(
            fresh.allowedLanguages,
            rows,
            minAssistantsFromSettings(org?.settings),
          ),
        );
      }
      if (problems.length) throw new UnprocessableEntityException({ message: problems });
      for (const x of variants) {
        const statement = vp.rendered.get(x.id);
        if (statement !== undefined && statement !== x.renderedStatement) {
          await tx.questionVariant.updateMany({
            where: { id: x.id, questionVersionId: fresh.id },
            data: { renderedStatement: statement },
          });
        }
      }
      await tx.question.update({ where: { id }, data: { currentVersionId: fresh.id } });
      await audit(tx, actor, 'QUESTION_PUBLISHED', id, ctx, { version: fresh.version });
    });
    return this.detail(this.prisma.client, id, undefined, full, false);
  }

  async setArchived(
    actor: Actor,
    id: string,
    archived: boolean,
    ctx: RequestContext,
  ): Promise<QuestionSummaryDto> {
    await this.prisma.client.$transaction(async (tx) => {
      // The same question row lock as every writer; count 0 is a missing id or the state already set.
      const { count } = await tx.question.updateMany({
        where: { id, isArchived: !archived },
        data: { isArchived: archived },
      });
      if (count === 1) {
        await audit(tx, actor, archived ? 'QUESTION_ARCHIVED' : 'QUESTION_UNARCHIVED', id, ctx, {});
        return;
      }
      await requireQuestion(tx, id);
    });
    const db = this.prisma.client;
    const question = await requireQuestion(db, id);
    const versions = await db.questionVersion.findMany({
      where: { questionId: id },
      select: VERSION_REF_SELECT,
      orderBy: { version: 'desc' },
    });
    const latest = versions[0];
    if (!latest) throw new NotFoundException(NOT_FOUND);
    return this.summary(question, versions, latest);
  }

  // ---- test cases (FR-202) --------------------------------------------------------------------

  async addTestCase(
    actor: Actor,
    id: string,
    version: number,
    dto: CreateTestCaseDto,
    ctx: RequestContext,
    full: boolean,
  ): Promise<TestCaseDto> {
    return this.prisma.client.$transaction(async (tx) => {
      const v = await lockDraft(tx, id, version);
      await checkRevision(tx, v, dto.expectedRevision);
      const count = await tx.testCase.count({ where: { questionVersionId: v.id } });
      if (count >= MAX_TEST_CASES) {
        throw new UnprocessableEntityException(
          `A version has at most ${MAX_TEST_CASES} test cases.`,
        );
      }
      let position = dto.position;
      if (position === undefined) {
        const max = await tx.testCase.aggregate({
          where: { questionVersionId: v.id },
          _max: { position: true },
        });
        position = (max._max.position ?? -1) + 1;
      }
      const created = await tx.testCase.create({
        data: {
          questionVersionId: v.id,
          input: dto.input,
          expectedOutput: dto.expectedOutput,
          isHidden: dto.isHidden ?? true,
          weight: dto.weight ?? 1,
          position,
        },
      });
      await audit(tx, actor, 'QUESTION_TEST_CASE_ADDED', id, ctx, {
        version,
        testCaseId: created.id,
        isHidden: created.isHidden,
      });
      return toTestCaseDto(created, full);
    });
  }

  async updateTestCase(
    actor: Actor,
    id: string,
    version: number,
    testCaseId: string,
    dto: UpdateTestCaseDto,
    ctx: RequestContext,
    full: boolean,
  ): Promise<TestCaseDto> {
    const fields = (Object.keys(dto) as (keyof UpdateTestCaseDto)[]).filter(
      (k) => k !== 'expectedRevision' && dto[k] !== undefined,
    );
    if (fields.length === 0) throw new BadRequestException('Send at least one field to change.');
    return this.prisma.client.$transaction(async (tx) => {
      const v = await lockDraft(tx, id, version);
      await checkRevision(tx, v, dto.expectedRevision);
      const { count } = await tx.testCase.updateMany({
        where: { id: testCaseId, questionVersionId: v.id },
        data: {
          ...(dto.input !== undefined ? { input: dto.input } : {}),
          ...(dto.expectedOutput !== undefined ? { expectedOutput: dto.expectedOutput } : {}),
          ...(dto.isHidden !== undefined ? { isHidden: dto.isHidden } : {}),
          ...(dto.weight !== undefined ? { weight: dto.weight } : {}),
          ...(dto.position !== undefined ? { position: dto.position } : {}),
        },
      });
      if (count !== 1) throw new NotFoundException('Test case not found.');
      const row = await tx.testCase.findFirst({
        where: { id: testCaseId, questionVersionId: v.id },
      });
      if (!row) throw new NotFoundException('Test case not found.');
      await audit(tx, actor, 'QUESTION_TEST_CASE_UPDATED', id, ctx, {
        version,
        testCaseId,
        fields,
      });
      return toTestCaseDto(row, full);
    });
  }

  async removeTestCase(
    actor: Actor,
    id: string,
    version: number,
    testCaseId: string,
    expectedRevision: string | undefined,
    ctx: RequestContext,
  ): Promise<void> {
    await this.prisma.client.$transaction(async (tx) => {
      const v = await lockDraft(tx, id, version);
      await checkRevision(tx, v, expectedRevision);
      const { count } = await tx.testCase.deleteMany({
        where: { id: testCaseId, questionVersionId: v.id },
      });
      if (count !== 1) throw new NotFoundException('Test case not found.');
      await audit(tx, actor, 'QUESTION_TEST_CASE_REMOVED', id, ctx, { version, testCaseId });
    });
  }

  // ---- helpers --------------------------------------------------------------------------------

  private summary(
    q: Question,
    versions: readonly VersionRefRow[],
    latest: VersionRefRow,
  ): QuestionSummaryDto {
    const published = q.currentVersionId
      ? versions.find((v) => v.id === q.currentVersionId)
      : undefined;
    return {
      id: q.id,
      slug: q.slug,
      type: q.type,
      tags: q.tags,
      isArchived: q.isArchived,
      createdAt: q.createdAt.toISOString(),
      published: published ? toVersionRef(published) : null,
      latest: toVersionRef(latest),
    };
  }

  /**
   * `full` false is the staff read view (no answers, no hidden test data); see staff-view.ts.
   * Only the chosen version's content is loaded; the version list carries reference columns.
   */
  private async detail(
    db: Db,
    id: string,
    versionNo: number | undefined,
    full: boolean,
    createdNewVersion: boolean,
  ): Promise<QuestionDetailDto> {
    const question = await requireQuestion(db, id);
    // Without question:update only published versions exist (latest = the latest published).
    const versions = await db.questionVersion.findMany({
      where: { questionId: id, ...(full ? {} : { isPublished: true }) },
      select: VERSION_REF_SELECT,
      orderBy: { version: 'desc' },
    });
    const latest = versions[0];
    const chosenRef =
      versionNo === undefined ? latest : versions.find((v) => v.version === versionNo);
    if (!latest || !chosenRef) throw new NotFoundException(NOT_FOUND);
    const chosen = await db.questionVersion.findUnique({ where: { id: chosenRef.id } });
    if (!chosen) throw new NotFoundException(NOT_FOUND);
    const cases = await db.testCase.findMany({
      where: { questionVersionId: chosen.id },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
    });
    // Variants (params, overrides) are loaded for the full view only: a recruiter never receives
    // them, not even from the database (ADR 0007 V-5).
    const variants = full ? await loadVariants(db, chosen.id) : [];
    return {
      ...this.summary(question, versions, latest),
      versions: [...versions].reverse().map(toVersionRef),
      version: full ? toFullVersion(chosen, cases, variants) : toStaffReadVersion(chosen, cases),
      createdNewVersion,
    };
  }
}
