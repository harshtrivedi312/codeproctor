// Question bank, slice 4a (FR-201, FR-202, FR-204, FR-205; BE-04). Every query runs through the
// org-scoped client, so another org's question is simply not found: the same 404 as a missing id
// (TC-008). Versions: a question has version rows numbered from 1. The highest number is the
// latest. A published version is immutable (database.md immutability rule): it is never updated
// and its test cases never change; editing a published question creates the next version as a
// draft (FR-204), which becomes `current_version_id` when published. Past sessions point at the
// version row they ran, so they never change (TC-013). Mutations write their audit row in the
// same transaction. Audit metadata names ids and changed fields only, never content. Lock rule:
// every change to a draft starts with an update of that version row (guarded by is_published =
// false), which serializes it against a concurrent publish and against other edits.
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';
import type { OrgScopedPrismaClient } from '../database/org-scope.extension';
import { Prisma } from '../generated/prisma/client';
import type { Question, QuestionVersion, TestCase } from '../generated/prisma/client';
import type { RequestContext } from '../common/request-context';
import { toCandidateQuestion } from './candidate-view';
import type { CandidateQuestionView } from './candidate-view';
import {
  checkLimits,
  limitsFromStored,
  limitsToStored,
  publishProblems,
  shapeProblems,
} from './question-content';
import type { Limits } from './question-content';
import { MAX_TEST_CASES } from './dto/questions.dto';
import type {
  CreateQuestionDto,
  QuestionDetailDto,
  QuestionListDto,
  QuestionListQueryDto,
  QuestionSummaryDto,
  QuestionVersionDto,
  QuestionVersionRefDto,
  TestCaseDto,
  TestCaseFieldsDto,
  UpdateQuestionDto,
  UpdateTestCaseDto,
} from './dto/questions.dto';

export interface Actor {
  id: string;
  orgId: string;
}

/** The most rows a list can skip: deep offsets are refused (400), as in the staff user list. */
export const MAX_LIST_OFFSET = 10_000;

type Db = Pick<OrgScopedPrismaClient, 'question' | 'questionVersion' | 'testCase' | 'auditLog'>;

const NOT_FOUND = 'Question not found.';
const noHistory = { validatedAt: null, validationReport: Prisma.DbNull } as const;

function slugFromTitle(title: string): string {
  const base = title
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return `${base || 'question'}-${randomBytes(3).toString('hex')}`;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

function ref(v: QuestionVersion): QuestionVersionRefDto {
  return {
    id: v.id,
    version: v.version,
    isPublished: v.isPublished,
    title: v.title,
    difficulty: v.difficulty,
    validatedAt: iso(v.validatedAt),
    createdAt: v.createdAt.toISOString(),
  };
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function stringMap(v: unknown): Record<string, string> {
  const rec = asRecord(v) ?? {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(rec)) if (typeof val === 'string') out[k] = val;
  return out;
}

@Injectable()
export class QuestionsService {
  constructor(private readonly prisma: PrismaService) {}

  // ---- read -----------------------------------------------------------------------------------

  async list(q: QuestionListQueryDto): Promise<QuestionListDto> {
    if ((q.page - 1) * q.pageSize > MAX_LIST_OFFSET) {
      throw new BadRequestException('The page is too deep; narrow the filters instead.');
    }
    const where: Prisma.QuestionWhereInput = {
      ...(q.includeArchived ? {} : { isArchived: false }),
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
    const versions = rows.length
      ? await db.questionVersion.findMany({
          where: { questionId: { in: rows.map((r) => r.id) } },
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

  /** The candidate-facing rendering of a version, for authors to preview (FR-202, TC-011). */
  async preview(id: string, version: number | undefined): Promise<CandidateQuestionView> {
    const db = this.prisma.client;
    const question = await this.requireQuestion(db, id);
    const row =
      version !== undefined
        ? await db.questionVersion.findFirst({ where: { questionId: id, version } })
        : question.currentVersionId
          ? await db.questionVersion.findFirst({
              where: { id: question.currentVersionId, questionId: id },
            })
          : await this.latestVersion(db, id);
    if (!row) throw new NotFoundException(NOT_FOUND);
    const testCases = await db.testCase.findMany({
      where: { questionVersionId: row.id },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
    });
    return toCandidateQuestion({ ...row, type: question.type }, testCases);
  }

  // ---- create ---------------------------------------------------------------------------------

  async create(
    actor: Actor,
    dto: CreateQuestionDto,
    ctx: RequestContext,
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
    const slug = dto.slug ?? slugFromTitle(dto.title);

    let id: string;
    try {
      id = await this.prisma.client.$transaction(async (tx) => {
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
        await this.audit(tx, actor, 'QUESTION_CREATED', question.id, ctx, {
          type,
          version: 1,
          testCases: cases.length,
        });
        return question.id;
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('A question with this slug already exists.');
      }
      throw e;
    }
    return this.detail(this.prisma.client, id, undefined, true, false);
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
  ): Promise<QuestionDetailDto> {
    const { tags, ...rest } = dto;
    const contentFields = (Object.keys(rest) as (keyof typeof rest)[]).filter(
      (k) => rest[k] !== undefined,
    );
    if (tags === undefined && contentFields.length === 0) {
      throw new BadRequestException('Send at least one field to change.');
    }
    const fork = await this.prisma.client
      .$transaction(async (tx) => {
        const question = await this.requireWritable(tx, id);
        const head = await this.latestVersion(tx, id);
        if (!head) throw new NotFoundException(NOT_FOUND);
        if (tags !== undefined) {
          await tx.question.update({ where: { id }, data: { tags } });
        }
        if (contentFields.length === 0) {
          await this.audit(tx, actor, 'QUESTION_UPDATED', id, ctx, { fields: ['tags'] });
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
          if (count !== 1)
            throw new ConflictException('The version was published meanwhile; retry.');
          await this.audit(tx, actor, 'QUESTION_UPDATED', id, ctx, {
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
        if (cases.length) {
          await tx.testCase.createMany({
            data: cases.map((t) => ({
              questionVersionId: next.id,
              input: t.input,
              expectedOutput: t.expectedOutput,
              isHidden: t.isHidden,
              weight: t.weight,
              position: t.position,
            })),
          });
        }
        await this.audit(tx, actor, 'QUESTION_VERSION_CREATED', id, ctx, {
          version: next.version,
          fromVersion: head.version,
          fields,
        });
        return true;
      })
      .catch((e: unknown) => {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          throw new ConflictException('A newer version was created meanwhile; reload and retry.');
        }
        throw e;
      });
    return this.detail(this.prisma.client, id, undefined, true, fork);
  }

  // ---- publish and archive --------------------------------------------------------------------

  /** Publishes the latest draft after the completeness rules pass (FR-201, FR-202, FR-205). */
  async publish(actor: Actor, id: string, ctx: RequestContext): Promise<QuestionDetailDto> {
    await this.prisma.client.$transaction(async (tx) => {
      const question = await this.requireWritable(tx, id);
      const head = await this.latestVersion(tx, id);
      if (!head) throw new NotFoundException(NOT_FOUND);
      if (head.isPublished) {
        throw new ConflictException('There is no draft to publish; edit the question first.');
      }
      // Take the row lock first, then read: an edit cannot slip in between check and publish.
      const { count } = await tx.questionVersion.updateMany({
        where: { id: head.id, isPublished: false },
        data: { isPublished: true },
      });
      if (count !== 1) throw new ConflictException('The version was published meanwhile.');
      const cases = await tx.testCase.findMany({ where: { questionVersionId: head.id } });
      const problems = publishProblems(
        question.type,
        head,
        cases.map((t) => ({ isHidden: t.isHidden, weight: Number(t.weight) })),
      );
      if (problems.length) throw new UnprocessableEntityException({ message: problems });
      await tx.question.update({ where: { id }, data: { currentVersionId: head.id } });
      await this.audit(tx, actor, 'QUESTION_PUBLISHED', id, ctx, { version: head.version });
    });
    return this.detail(this.prisma.client, id, undefined, true, false);
  }

  async setArchived(
    actor: Actor,
    id: string,
    archived: boolean,
    ctx: RequestContext,
  ): Promise<QuestionSummaryDto> {
    await this.prisma.client.$transaction(async (tx) => {
      const question = await this.requireQuestion(tx, id);
      if (question.isArchived === archived) return;
      await tx.question.update({ where: { id }, data: { isArchived: archived } });
      await this.audit(
        tx,
        actor,
        archived ? 'QUESTION_ARCHIVED' : 'QUESTION_UNARCHIVED',
        id,
        ctx,
        {},
      );
    });
    const d = await this.detail(this.prisma.client, id, undefined, false, false);
    const { versions: _v, version: _ver, createdNewVersion: _c, ...summary } = d;
    void _v;
    void _ver;
    void _c;
    return summary;
  }

  // ---- test cases (FR-202) --------------------------------------------------------------------

  async addTestCase(
    actor: Actor,
    id: string,
    version: number,
    dto: TestCaseFieldsDto,
    ctx: RequestContext,
  ): Promise<TestCaseDto> {
    return this.prisma.client.$transaction(async (tx) => {
      const v = await this.lockDraft(tx, id, version);
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
      await this.audit(tx, actor, 'QUESTION_TEST_CASE_ADDED', id, ctx, {
        version,
        testCaseId: created.id,
        isHidden: created.isHidden,
      });
      return this.testCaseDto(created, true);
    });
  }

  async updateTestCase(
    actor: Actor,
    id: string,
    version: number,
    testCaseId: string,
    dto: UpdateTestCaseDto,
    ctx: RequestContext,
  ): Promise<TestCaseDto> {
    const fields = (Object.keys(dto) as (keyof UpdateTestCaseDto)[]).filter(
      (k) => dto[k] !== undefined,
    );
    if (fields.length === 0) throw new BadRequestException('Send at least one field to change.');
    return this.prisma.client.$transaction(async (tx) => {
      const v = await this.lockDraft(tx, id, version);
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
      await this.audit(tx, actor, 'QUESTION_TEST_CASE_UPDATED', id, ctx, {
        version,
        testCaseId,
        fields,
      });
      return this.testCaseDto(row, true);
    });
  }

  async removeTestCase(
    actor: Actor,
    id: string,
    version: number,
    testCaseId: string,
    ctx: RequestContext,
  ): Promise<void> {
    await this.prisma.client.$transaction(async (tx) => {
      const v = await this.lockDraft(tx, id, version);
      const { count } = await tx.testCase.deleteMany({
        where: { id: testCaseId, questionVersionId: v.id },
      });
      if (count !== 1) throw new NotFoundException('Test case not found.');
      await this.audit(tx, actor, 'QUESTION_TEST_CASE_REMOVED', id, ctx, { version, testCaseId });
    });
  }

  // ---- helpers --------------------------------------------------------------------------------

  private async requireQuestion(db: Db, id: string): Promise<Question> {
    const q = await db.question.findUnique({ where: { id } });
    if (!q) throw new NotFoundException(NOT_FOUND);
    return q;
  }

  private async requireWritable(db: Db, id: string): Promise<Question> {
    const q = await this.requireQuestion(db, id);
    if (q.isArchived) throw new ConflictException('The question is archived.');
    return q;
  }

  private latestVersion(db: Db, questionId: string): Promise<QuestionVersion | null> {
    return db.questionVersion.findFirst({ where: { questionId }, orderBy: { version: 'desc' } });
  }

  /**
   * The draft version a test case change targets, locked and with its validation result cleared
   * (a changed test set invalidates the last validation run). A published version is immutable: 409.
   */
  private async lockDraft(db: Db, id: string, version: number): Promise<QuestionVersion> {
    const question = await this.requireWritable(db, id);
    const v = await db.questionVersion.findFirst({ where: { questionId: id, version } });
    if (!v) throw new NotFoundException(NOT_FOUND);
    if (question.type !== 'CODING') {
      throw new UnprocessableEntityException('Only coding questions have test cases.');
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

  private testCaseDto(t: TestCase, full: boolean): TestCaseDto {
    const show = full || !t.isHidden;
    return {
      id: t.id,
      position: t.position,
      isHidden: t.isHidden,
      weight: Number(t.weight),
      input: show ? t.input : null,
      expectedOutput: show ? t.expectedOutput : null,
    };
  }

  private summary(
    q: Question,
    versions: QuestionVersion[],
    latest: QuestionVersion,
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
      published: published ? ref(published) : null,
      latest: ref(latest),
    };
  }

  /** `full` is false for callers without question:update: no answers, no hidden test data. */
  private async detail(
    db: Db,
    id: string,
    versionNo: number | undefined,
    full: boolean,
    createdNewVersion: boolean,
  ): Promise<QuestionDetailDto> {
    const question = await this.requireQuestion(db, id);
    const versions = await db.questionVersion.findMany({
      where: { questionId: id },
      orderBy: { version: 'desc' },
    });
    const latest = versions[0];
    const chosen = versionNo === undefined ? latest : versions.find((v) => v.version === versionNo);
    if (!latest || !chosen) throw new NotFoundException(NOT_FOUND);
    const cases = await db.testCase.findMany({
      where: { questionVersionId: chosen.id },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
    });
    const version: QuestionVersionDto = {
      ...ref(chosen),
      statementMd: chosen.statementMd,
      allowedLanguages: chosen.allowedLanguages,
      limits: limitsFromStored(chosen.limits),
      starterCode: stringMap(chosen.starterCode),
      testCases: cases.map((t) => this.testCaseDto(t, full)),
      ...(full
        ? {
            referenceSolution: stringMap(chosen.referenceSolution),
            answerSpec: asRecord(chosen.answerSpec),
            validationReport: asRecord(chosen.validationReport),
          }
        : {}),
    };
    return {
      ...this.summary(question, versions, latest),
      versions: [...versions].reverse().map(ref),
      version,
      createdNewVersion,
    };
  }

  private async audit(
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
}
