// Test templates (FR-301, FR-302; BE-06 slice 6a). Every query runs through the org-scoped client,
// so another org's test (or question version) is simply not found: the same 404 as a missing id
// (TC-008). A test that already has an invitation or a session is never edited in place (ADR 0002
// S-6): PATCH answers 409 and the recruiter builds a new test. There is no copy or archive route
// yet because the schema has no support for it (TODO(FU-BE-110)).
//
// Locking. PATCH starts with SELECT ... FOR UPDATE on the tests row. A plain same-value UPDATE is
// not enough: it takes FOR NO KEY UPDATE, which does NOT conflict with the FOR KEY SHARE lock that
// the foreign key check of an invitation insert takes, so an invitation could slip in between the
// "has attempts?" check and the rewrite. FOR UPDATE conflicts with KEY SHARE: an invitation insert
// in flight makes the edit wait and then see it (409), and an edit in flight makes the invitation
// insert wait until the edit is committed. The used check runs AFTER the lock.
//
// No nested Prisma relation writes (the scoped client refuses them): the test, its sections and
// its questions are separate top-level calls in one transaction. Audit rows are written in the same
// transaction and name ids and changed fields only, never content.
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { OrgContextService } from '../database/org-context';
import { PrismaService } from '../database/prisma.service';
import type { OrgScopedPrismaClient } from '../database/org-scope.extension';
import { Prisma } from '../generated/prisma/client';
import type { Test } from '../generated/prisma/client';
import type { RequestContext } from '../common/request-context';
import { candidateCap, unservedSlots } from './feasibility';
import { parseRandomRule, ruleKey } from './random-rule';
import type { RandomRule } from './random-rule';
import { DEFAULT_POINTS, orderByPosition, planProblems } from './test-structure';
import type { Plan } from './test-structure';
import type {
  CreateTestDto,
  TestDetailDto,
  TestListDto,
  TestListQueryDto,
  TestSectionInputDto,
  TestSummaryDto,
  UpdateTestDto,
} from './dto/tests.dto';

export interface Actor {
  id: string;
  orgId: string;
}

/** The most rows a list can skip: deep offsets are refused (400), as in the staff user list. */
export const MAX_LIST_OFFSET = 10_000;

type Db = Pick<
  OrgScopedPrismaClient,
  | 'test'
  | 'testSection'
  | 'testQuestion'
  | 'question'
  | 'questionVersion'
  | 'invitation'
  | 'session'
  | 'auditLog'
  | '$queryRaw'
>;

const NOT_FOUND = 'Test not found.';

/** One question slot after validation: a fixed version or a normalized random rule. */
interface Slot {
  position: number;
  points: number;
  versionId: string | null;
  rule: RandomRule | null;
}
interface ResolvedSection {
  title: string;
  position: number;
  timeLimitMin: number | null;
  questions: Slot[];
}

const toPlan = (
  durationMinutes: number,
  passScore: number | null,
  sections: readonly ResolvedSection[],
): Plan => ({
  durationMinutes,
  passScore,
  sections: sections.map((s) => ({
    position: s.position,
    timeLimitMin: s.timeLimitMin,
    questions: s.questions.map((q) => ({ position: q.position, points: q.points })),
  })),
});

const num = (d: Prisma.Decimal | null): number | null => (d === null ? null : Number(d));

@Injectable()
export class TestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orgContext: OrgContextService,
  ) {}

  // ---- read -----------------------------------------------------------------------------------

  async list(q: TestListQueryDto): Promise<TestListDto> {
    if ((q.page - 1) * q.pageSize > MAX_LIST_OFFSET) {
      throw new BadRequestException('The page is too deep; narrow the filters instead.');
    }
    const where: Prisma.TestWhereInput = {
      ...(q.search ? { name: { contains: escapeLike(q.search), mode: 'insensitive' } } : {}),
      ...(q.profile ? { profile: q.profile } : {}),
      ...(q.used === true ? { invitations: { some: {} } } : {}),
      ...(q.used === false ? { invitations: { none: {} } } : {}),
    };
    const db = this.prisma.client;
    const [rows, total] = await Promise.all([
      db.test.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      db.test.count({ where }),
    ]);
    const ids = rows.map((r) => r.id);
    const [sections, used] = ids.length
      ? await Promise.all([
          db.testSection.findMany({
            where: { testId: { in: ids } },
            select: { id: true, testId: true },
          }),
          db.invitation.findMany({
            where: { testId: { in: ids } },
            select: { testId: true },
            distinct: ['testId'],
          }),
        ])
      : [[], []];
    const questions = sections.length
      ? await db.testQuestion.findMany({
          where: { sectionId: { in: sections.map((s) => s.id) } },
          select: { sectionId: true },
        })
      : [];
    const testOfSection = new Map(sections.map((s) => [s.id, s.testId]));
    const questionCount = new Map<string, number>();
    for (const tq of questions) {
      const t = testOfSection.get(tq.sectionId);
      if (t !== undefined) questionCount.set(t, (questionCount.get(t) ?? 0) + 1);
    }
    const usedIds = new Set(used.map((u) => u.testId));
    return {
      items: rows.map((r) =>
        this.summary(
          r,
          sections.filter((s) => s.testId === r.id).length,
          questionCount.get(r.id) ?? 0,
          usedIds.has(r.id),
        ),
      ),
      page: q.page,
      pageSize: q.pageSize,
      total,
    };
  }

  async get(id: string): Promise<TestDetailDto> {
    return this.detail(this.prisma.client, id);
  }

  // ---- create ---------------------------------------------------------------------------------

  async create(actor: Actor, dto: CreateTestDto, ctx: RequestContext): Promise<TestDetailDto> {
    const sections = this.resolveSections(dto.sections);
    this.assertPlan(toPlan(dto.durationMinutes, dto.passScore ?? null, sections));
    const id = await this.prisma.client.$transaction(async (tx) => {
      await this.checkReferences(tx, sections);
      const test = await tx.test.create({
        data: {
          orgId: actor.orgId,
          name: dto.name,
          description: dto.description ?? null,
          durationMinutes: dto.durationMinutes,
          profile: dto.profile ?? 'STANDARD',
          passScore: dto.passScore ?? null,
          createdById: actor.id,
        },
      });
      await this.writeSections(tx, test.id, sections);
      await this.audit(tx, actor, 'TEST_CREATED', test.id, ctx, {
        sections: sections.length,
        questions: sections.reduce((a, s) => a + s.questions.length, 0),
      });
      return test.id;
    });
    return this.detail(this.prisma.client, id);
  }

  // ---- update ---------------------------------------------------------------------------------

  async update(
    actor: Actor,
    id: string,
    dto: UpdateTestDto,
    ctx: RequestContext,
  ): Promise<TestDetailDto> {
    const fields = (
      ['name', 'description', 'durationMinutes', 'profile', 'passScore', 'sections'] as const
    ).filter((f) => dto[f] !== undefined);
    if (fields.length === 0) throw new BadRequestException('Send at least one field to change.');
    const replacement = dto.sections ? this.resolveSections(dto.sections) : undefined;

    await this.prisma.client.$transaction(async (tx) => {
      const test = await this.lock(tx, actor, id);
      if (await this.hasAttempts(tx, id)) {
        throw new ConflictException(
          'This test already has invitations or sessions and cannot be edited; create a new test instead.',
        );
      }
      const sections = replacement ?? (await this.currentSections(tx, id));
      const durationMinutes = dto.durationMinutes ?? test.durationMinutes;
      const passScore = dto.passScore ?? num(test.passScore);
      this.assertPlan(toPlan(durationMinutes, passScore, sections));
      if (replacement) await this.checkReferences(tx, replacement);

      const data: Prisma.TestUncheckedUpdateInput = {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.durationMinutes !== undefined ? { durationMinutes: dto.durationMinutes } : {}),
        ...(dto.profile !== undefined ? { profile: dto.profile } : {}),
        ...(dto.passScore !== undefined ? { passScore: dto.passScore } : {}),
      };
      if (Object.keys(data).length > 0) await tx.test.update({ where: { id }, data });
      if (replacement) {
        // test_questions go with their section (ON DELETE CASCADE).
        await tx.testSection.deleteMany({ where: { testId: id } });
        await this.writeSections(tx, id, replacement);
      }
      await this.audit(tx, actor, 'TEST_UPDATED', id, ctx, { fields: [...fields] });
    });
    return this.detail(this.prisma.client, id);
  }

  // ---- helpers --------------------------------------------------------------------------------

  /** Locks the tests row (see the header), then returns it; another org's or a missing id is 404. */
  private async lock(tx: Db, actor: Actor, id: string): Promise<Test> {
    const locked = await this.orgContext.runRawSql(
      'row lock on the test before an edit, FOR UPDATE so it conflicts with the invitation foreign key check, same org only',
      () =>
        tx.$queryRaw<{ id: string }[]>(Prisma.sql`
          SELECT id FROM tests
          WHERE id = ${id}::uuid AND org_id = ${actor.orgId}::uuid
          FOR UPDATE`),
    );
    if (locked.length !== 1) throw new NotFoundException(NOT_FOUND);
    // Read after the lock: the edit never works on a stale row.
    const test = await tx.test.findUnique({ where: { id } });
    if (!test) throw new NotFoundException(NOT_FOUND);
    return test;
  }

  private async hasAttempts(db: Db, testId: string): Promise<boolean> {
    const [invitations, sessions] = await Promise.all([
      db.invitation.count({ where: { testId } }),
      db.session.count({ where: { invitation: { is: { testId } } } }),
    ]);
    return invitations > 0 || sessions > 0;
  }

  /** Orders and validates the shape of the sections; returns them with normalized random rules. */
  private resolveSections(input: readonly TestSectionInputDto[]): ResolvedSection[] {
    const problems: string[] = [];
    const orderedSections = orderByPosition(input);
    if (!orderedSections) {
      throw new BadRequestException(['give a position on every section or on none']);
    }
    const out = orderedSections.map(({ item: s, position }, i) => {
      const orderedQuestions = orderByPosition(s.questions);
      if (!orderedQuestions) {
        problems.push(`sections[${i}]: give a position on every question or on none`);
      }
      const questions: Slot[] = (orderedQuestions ?? []).map(({ item: q, position: qp }, j) => {
        const at = `sections[${i}].questions[${j}]`;
        const fixed = q.questionVersionId !== undefined;
        const random = q.randomRule !== undefined;
        if (fixed === random) {
          problems.push(`${at}: give exactly one of questionVersionId and randomRule`);
        }
        let rule: RandomRule | null = null;
        if (random) {
          const parsed = parseRandomRule(q.randomRule);
          if (parsed.ok) rule = parsed.rule;
          else problems.push(...parsed.problems.map((p) => `${at}.${p}`));
        }
        return {
          position: qp,
          points: q.points ?? DEFAULT_POINTS,
          versionId: q.questionVersionId?.toLowerCase() ?? null,
          rule,
        };
      });
      return { title: s.title, position, timeLimitMin: s.timeLimitMin ?? null, questions };
    });
    if (problems.length) throw new BadRequestException(problems);
    return out;
  }

  private assertPlan(plan: Plan): void {
    const problems = planProblems(plan);
    if (problems.length) throw new BadRequestException(problems);
  }

  /**
   * Fixed questions must be PUBLISHED versions of non-archived questions of this org: a version of
   * another org, and a draft (unpublished) version, are the same 404 as a missing one (DL-34: no
   * existence oracle for drafts); a published version of an archived question is 422. The random
   * rules must then be satisfiable together (see satisfiabilityProblems).
   */
  private async checkReferences(db: Db, sections: readonly ResolvedSection[]): Promise<void> {
    const slots = sections.flatMap((s, i) =>
      s.questions.map((q, j) => ({ ...q, at: `sections[${i}].questions[${j}]` })),
    );
    const versionIds = [...new Set(slots.flatMap((s) => (s.versionId ? [s.versionId] : [])))];
    const fixedQuestionIds = new Set<string>();
    if (versionIds.length) {
      const found = await db.questionVersion.findMany({
        where: { id: { in: versionIds } },
        select: {
          id: true,
          questionId: true,
          isPublished: true,
          question: { select: { isArchived: true } },
        },
      });
      // A draft is the same 404 as a missing or other-org id: a caller without question:update
      // must not be able to tell that a draft exists (DL-34).
      if (found.length !== versionIds.length || found.some((v) => !v.isPublished)) {
        throw new NotFoundException('A question version was not found.');
      }
      const bad = found.filter((v) => v.question.isArchived);
      if (bad.length) {
        throw new UnprocessableEntityException({
          message: slots
            .filter((s) => s.versionId && bad.some((b) => b.id === s.versionId))
            .map((s) => `${s.at}: the question is archived`),
        });
      }
      for (const v of found) fixedQuestionIds.add(v.questionId);
    }
    const problems = await this.satisfiabilityProblems(
      db,
      slots.flatMap((s) => (s.rule ? [{ at: s.at, rule: s.rule }] : [])),
      fixedQuestionIds,
      slots.length - slots.filter((s) => s.rule).length,
    );
    if (problems.length) throw new UnprocessableEntityException({ message: problems });
  }

  /**
   * Read-only: can every random slot of this saved test still get its own question? Same check as
   * at save time, run against today's question bank (FU-BE-114). A test is checked once at save,
   * but a question can be archived or replaced afterwards. The invitation step (BE-06c) MUST call
   * this before it inserts an invitation, and refuse (409) when `satisfiable` is false. Test start
   * (BE-07) still answers 409 RANDOM_RULE_UNSATISFIABLE for a bank that changed after the invitation.
   * Org-scoped (another org's test is 404), no writes, no lock. Never read the test FOR UPDATE
   * in the invitation step (FU-BE-114). Problems name slot positions only.
   */
  async checkTestSatisfiable(
    testId: string,
  ): Promise<{ satisfiable: boolean; problems: string[] }> {
    const db = this.prisma.client;
    const test = await db.test.findUnique({ where: { id: testId }, select: { id: true } });
    if (!test) throw new NotFoundException(NOT_FOUND);
    const sections = await db.testSection.findMany({
      where: { testId },
      orderBy: { position: 'asc' },
    });
    const questions = sections.length
      ? await db.testQuestion.findMany({
          where: { sectionId: { in: sections.map((s) => s.id) } },
          orderBy: { position: 'asc' },
        })
      : [];
    const problems: string[] = [];
    const rules: { at: string; rule: RandomRule }[] = [];
    const fixedVersionIds: string[] = [];
    sections.forEach((s, i) => {
      questions
        .filter((q) => q.sectionId === s.id)
        .forEach((q, j) => {
          const at = `sections[${i}].questions[${j}]`;
          if (q.questionVersionId !== null) {
            fixedVersionIds.push(q.questionVersionId);
            return;
          }
          const parsed = parseRandomRule(q.randomRule);
          if (parsed.ok) rules.push({ at, rule: parsed.rule });
          else problems.push(`${at}.randomRule is not understood`);
        });
    });
    const versions = fixedVersionIds.length
      ? await db.questionVersion.findMany({
          where: { id: { in: [...new Set(fixedVersionIds)] } },
          select: { questionId: true },
        })
      : [];
    problems.push(
      ...(await this.satisfiabilityProblems(
        db,
        rules,
        new Set(versions.map((v) => v.questionId)),
        fixedVersionIds.length,
      )),
    );
    return { satisfiable: problems.length === 0, problems };
  }

  /**
   * One problem line per random slot that cannot get its own question. A test never shows a
   * question twice, a fixed slot takes its question, and a random slot never picks a question that
   * a fixed slot uses (BE-07 takes fixed slots first). Candidates are the org's questions that are
   * not archived, whose current version is published and matches the rule's difficulty, with every
   * tag of the rule and the type: the same matching as test start. Distinct rules are read once
   * each, at most candidateCap ids, and matched with feasibility.ts. Messages name positions only.
   */
  private async satisfiabilityProblems(
    db: Db,
    rules: readonly { at: string; rule: RandomRule }[],
    fixedQuestionIds: ReadonlySet<string>,
    fixedSlots: number,
  ): Promise<string[]> {
    if (rules.length === 0) return [];
    const take = candidateCap(rules.length, Math.max(fixedSlots, fixedQuestionIds.size));
    const byKey = new Map<string, string[]>();
    for (const { rule } of rules) {
      const key = ruleKey(rule);
      if (byKey.has(key)) continue;
      const rows = await db.question.findMany({
        where: {
          isArchived: false,
          currentVersionId: { not: null },
          ...(rule.type !== undefined ? { type: rule.type } : {}),
          ...(rule.tags !== undefined ? { tags: { hasEvery: rule.tags } } : {}),
          currentVersion: {
            is: {
              isPublished: true,
              ...(rule.difficulty !== undefined ? { difficulty: rule.difficulty } : {}),
            },
          },
        },
        select: { id: true },
        orderBy: { id: 'asc' },
        take,
      });
      byKey.set(
        key,
        rows.map((r) => r.id),
      );
    }
    const unserved = unservedSlots(
      rules.map(({ rule }) => byKey.get(ruleKey(rule)) ?? []),
      fixedQuestionIds,
    );
    return unserved.map((i) => {
      const matches = byKey.get(ruleKey(rules[i]?.rule ?? {}))?.length ?? 0;
      return `${rules[i]?.at ?? ''}.randomRule matches ${matches} published question(s) in your organization; the test needs a different one for every random slot`;
    });
  }

  private async writeSections(
    tx: Db,
    testId: string,
    sections: readonly ResolvedSection[],
  ): Promise<void> {
    const created = await tx.testSection.createManyAndReturn({
      data: sections.map((s) => ({
        testId,
        title: s.title,
        position: s.position,
        timeLimitMin: s.timeLimitMin,
      })),
    });
    const idOfPosition = new Map(created.map((c) => [c.position, c.id]));
    const data = sections.flatMap((s) =>
      s.questions.map((q) => {
        const sectionId = idOfPosition.get(s.position);
        if (sectionId === undefined) throw new Error('section row missing after insert');
        return {
          sectionId,
          position: q.position,
          points: q.points,
          questionVersionId: q.versionId,
          ...(q.rule ? { randomRule: q.rule as Prisma.InputJsonObject } : {}),
        };
      }),
    );
    await tx.testQuestion.createMany({ data });
  }

  private async currentSections(db: Db, testId: string): Promise<ResolvedSection[]> {
    const sections = await db.testSection.findMany({
      where: { testId },
      orderBy: { position: 'asc' },
    });
    const questions = sections.length
      ? await db.testQuestion.findMany({
          where: { sectionId: { in: sections.map((s) => s.id) } },
          orderBy: { position: 'asc' },
        })
      : [];
    return sections.map((s) => ({
      title: s.title,
      position: s.position,
      timeLimitMin: s.timeLimitMin,
      questions: questions
        .filter((q) => q.sectionId === s.id)
        .map((q) => ({
          position: q.position,
          points: Number(q.points),
          versionId: q.questionVersionId,
          rule: null,
        })),
    }));
  }

  private summary(
    t: Test,
    sectionCount: number,
    questionCount: number,
    used: boolean,
  ): TestSummaryDto {
    return {
      id: t.id,
      name: t.name,
      description: t.description,
      durationMinutes: t.durationMinutes,
      profile: t.profile,
      passScore: num(t.passScore),
      createdById: t.createdById,
      createdAt: t.createdAt.toISOString(),
      sectionCount,
      questionCount,
      used,
    };
  }

  private async detail(db: Db, id: string): Promise<TestDetailDto> {
    const test = await db.test.findUnique({ where: { id } });
    if (!test) throw new NotFoundException(NOT_FOUND);
    const sections = await db.testSection.findMany({
      where: { testId: id },
      orderBy: { position: 'asc' },
    });
    const questions = sections.length
      ? await db.testQuestion.findMany({
          where: { sectionId: { in: sections.map((s) => s.id) } },
          orderBy: { position: 'asc' },
        })
      : [];
    const versionIds = [
      ...new Set(questions.flatMap((q) => (q.questionVersionId ? [q.questionVersionId] : []))),
    ];
    const versions = versionIds.length
      ? await db.questionVersion.findMany({
          where: { id: { in: versionIds } },
          select: { id: true, title: true, difficulty: true },
        })
      : [];
    const used = await this.hasAttempts(db, id);
    return {
      ...this.summary(test, sections.length, questions.length, used),
      sections: sections.map((s) => ({
        id: s.id,
        title: s.title,
        position: s.position,
        timeLimitMin: s.timeLimitMin,
        questions: questions
          .filter((q) => q.sectionId === s.id)
          .map((q) => {
            const v = versions.find((x) => x.id === q.questionVersionId);
            return {
              id: q.id,
              position: q.position,
              points: Number(q.points),
              questionVersionId: q.questionVersionId,
              title: v?.title ?? null,
              difficulty: v?.difficulty ?? null,
              randomRule: (q.randomRule as Record<string, unknown> | null) ?? null,
            };
          }),
      })),
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
        entityType: 'test',
        entityId,
        ip: ctx.ip ?? null,
        metadata,
      },
    });
  }
}

/** `%`, `_` and `\` are LIKE wildcards or escapes; Prisma's `contains` does not escape them. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}
