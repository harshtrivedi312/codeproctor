// Question variants, slice 4b (FR-203, ADR 0007 V-1..V-6; BE-04). A variant is an explicit row of
// question_variants with its own flat `params`; the statement, starter code and reference solution
// of the version are templates with {{name}} placeholders rendered per variant (variant-template.ts).
// `variant_test_cases` rows override one test slot's input and expected output; the hidden flag,
// position and weight always come from the slot (V-1).
//
// Same rules as the rest of the question bank (questions.service.ts): every mutation takes the
// question row lock first (lockDraft) and reads after it; a published version is immutable (409:
// edit the question to fork the next version, which copies variants and overrides); each change
// clears the last validation result; the audit row is written in the same transaction and names
// ids and field names only, never params or content. Invariant kept on every write: every ACTIVE
// variant of a draft renders cleanly, so `rendered_statement` is never stale and an unknown
// placeholder is rejected (400), never rendered empty.
//
// Variant data never reaches a caller without question:update, except through `preview`, which is
// the candidate-shaped view (ADR 0013): rendered statement and starter code, samples only, no
// params, no hidden cases, no reference solution, no answer_spec (candidate-view.ts).
import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { CodedConflictException } from '../common/coded.exception';
import { OrgContextService } from '../database/org-context';
import { PrismaService } from '../database/prisma.service';
import { Prisma } from '../generated/prisma/client';
import type { QuestionVersion } from '../generated/prisma/client';
import type { RequestContext } from '../common/request-context';
import { toCandidateQuestion } from './candidate-view';
import type { CandidateQuestionView } from './candidate-view';
import { computeRevision } from './revision';
import {
  audit,
  checkRevision,
  loadVariants,
  lockDraft,
  NOT_FOUND,
  requireQuestion,
} from './question-tx';
import type { Actor, Db, VariantRow } from './question-tx';
import { toVariantDto } from './staff-view';
import { mergeSlots, renderVariant } from './variant-rules';
import type {
  CreateVariantDto,
  UpdateVariantDto,
  VariantListDto,
  VariantMutationDto,
  VariantOverrideFieldsDto,
} from './dto/variants.dto';
import { MAX_VARIANTS } from './dto/variants.dto';
import type { VariantDto, VariantTestCaseOverrideDto } from './dto/questions.dto';

const VARIANT_NOT_FOUND = 'Variant not found.';
const SLOT_NOT_FOUND = 'Test case not found.';
const VARIANT_HAS_AI_DETAIL =
  'The variant has AI reference rows, which are never deleted; set it inactive instead.';

@Injectable()
export class VariantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orgContext: OrgContextService,
  ) {}

  // ---- read -----------------------------------------------------------------------------------

  /** Author view (question:update): all variants of a version with params and overrides. */
  async list(id: string, version: number): Promise<VariantListDto> {
    const db = this.prisma.client;
    await requireQuestion(db, id);
    const row = await db.questionVersion.findFirst({ where: { questionId: id, version } });
    if (!row) throw new NotFoundException(NOT_FOUND);
    const { cases, variants } = await this.snapshot(db, row.id);
    return {
      items: variants.map((x) => toVariantDto(x, cases)),
      revision: computeRevision(row, cases, variants),
    };
  }

  /**
   * The candidate-shaped rendering of one variant (ADR 0013 render-question shape, FR-203, TC-011).
   * Callers without question:update (`full` false) get published versions and active variants
   * only. A missing, other-org, draft or inactive target is the same 404.
   */
  async preview(
    id: string,
    version: number,
    variantId: string,
    full: boolean,
  ): Promise<CandidateQuestionView> {
    const db = this.prisma.client;
    const question = await requireQuestion(db, id);
    const row = await db.questionVersion.findFirst({
      where: { questionId: id, version, ...(full ? {} : { isPublished: true }) },
    });
    if (!row) throw new NotFoundException(NOT_FOUND);
    const variant = await db.questionVariant.findFirst({
      where: { id: variantId, questionVersionId: row.id, ...(full ? {} : { isActive: true }) },
      include: { testCaseOverrides: true },
    });
    if (!variant) throw new NotFoundException(VARIANT_NOT_FOUND);
    const cases = await db.testCase.findMany({
      where: { questionVersionId: row.id },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
    });
    const r = renderVariant(row, variant);
    if (!r.ok) {
      // Authors see why; anyone else gets no detail (a published version always renders).
      throw new UnprocessableEntityException(
        full ? { message: r.problems } : 'This variant cannot be shown.',
      );
    }
    return toCandidateQuestion(
      { ...row, type: question.type, starterCode: r.content.starterCode },
      mergeSlots(cases, variant.testCaseOverrides),
      { statementMd: r.content.statementMd },
    );
  }

  // ---- variants -------------------------------------------------------------------------------

  async create(
    actor: Actor,
    id: string,
    version: number,
    dto: CreateVariantDto,
    ctx: RequestContext,
  ): Promise<VariantMutationDto> {
    return this.prisma.client.$transaction(async (tx) => {
      const v = await lockDraft(tx, id, version, 'variants');
      await checkRevision(tx, v, dto.expectedRevision);
      const count = await tx.questionVariant.count({ where: { questionVersionId: v.id } });
      if (count >= MAX_VARIANTS) {
        throw new UnprocessableEntityException(`A version has at most ${MAX_VARIANTS} variants.`);
      }
      const isActive = dto.isActive ?? true;
      const renderedStatement = this.renderStrict(v, 'new', dto.params, isActive);
      const created = await tx.questionVariant.create({
        data: {
          questionVersionId: v.id,
          params: dto.params as Prisma.InputJsonObject,
          renderedStatement,
          isActive,
        },
      });
      await audit(tx, actor, 'QUESTION_VARIANT_ADDED', id, ctx, {
        version,
        variantId: created.id,
        isActive,
      });
      return this.mutation(tx, v, created.id);
    });
  }

  async update(
    actor: Actor,
    id: string,
    version: number,
    variantId: string,
    dto: UpdateVariantDto,
    ctx: RequestContext,
  ): Promise<VariantMutationDto> {
    const fields = (['params', 'isActive'] as const).filter((k) => dto[k] !== undefined);
    if (fields.length === 0) throw new BadRequestException('Send at least one field to change.');
    return this.prisma.client.$transaction(async (tx) => {
      const v = await lockDraft(tx, id, version, 'variants');
      await checkRevision(tx, v, dto.expectedRevision);
      const current = await this.requireVariant(tx, v.id, variantId);
      const params = dto.params ?? current.params;
      const isActive = dto.isActive ?? current.isActive;
      const renderedStatement = this.renderStrict(
        v,
        variantId,
        params,
        isActive,
        current.renderedStatement,
      );
      const { count } = await tx.questionVariant.updateMany({
        where: { id: variantId, questionVersionId: v.id },
        data: { params: params as Prisma.InputJsonObject, isActive, renderedStatement },
      });
      if (count !== 1) throw new NotFoundException(VARIANT_NOT_FOUND);
      await audit(tx, actor, 'QUESTION_VARIANT_UPDATED', id, ctx, { version, variantId, fields });
      return this.mutation(tx, v, variantId);
    });
  }

  async remove(
    actor: Actor,
    id: string,
    version: number,
    variantId: string,
    expectedRevision: string | undefined,
    ctx: RequestContext,
  ): Promise<void> {
    await this.prisma.client.$transaction(async (tx) => {
      const v = await lockDraft(tx, id, version, 'variants');
      await checkRevision(tx, v, expectedRevision);
      // ADR 0005 AI-1: AI reference rows are append-only and variant_id cascades on delete, so a
      // variant that any row (current or superseded) points to is never deleted (permanent 409;
      // retire it with isActive=false instead). The variant row is locked FOR UPDATE before the
      // rows are counted: an AI insert holds FOR KEY SHARE on its variant through the FK, so a
      // writer that is still uncommitted makes this wait, and one that committed is counted.
      if (!(await this.lockVariantRow(tx, actor.orgId, v.id, variantId))) {
        throw new NotFoundException(VARIANT_NOT_FOUND);
      }
      const aiRows = await tx.aiReferenceSolution.count({ where: { variantId } });
      if (aiRows > 0) {
        throw new CodedConflictException(VARIANT_HAS_AI_DETAIL, 'VARIANT_HAS_AI_REFERENCES');
      }
      // Overrides go with it (ON DELETE CASCADE).
      const { count } = await tx.questionVariant.deleteMany({
        where: { id: variantId, questionVersionId: v.id },
      });
      if (count !== 1) throw new NotFoundException(VARIANT_NOT_FOUND);
      await audit(tx, actor, 'QUESTION_VARIANT_REMOVED', id, ctx, { version, variantId });
    });
  }

  /** True when the variant exists in this version and org and is now row-locked. */
  private async lockVariantRow(
    tx: Db & Pick<PrismaService['client'], '$queryRaw'>,
    orgId: string,
    versionId: string,
    variantId: string,
  ): Promise<boolean> {
    const rows = await this.orgContext.runRawSql(
      'Lock one question_variants row FOR UPDATE before counting its AI rows; the model API has no row lock. Filtered by variant, version and org (variant -> version -> question, the org-scope path); only the variant row is locked.',
      () =>
        tx.$queryRaw<{ id: string }[]>(Prisma.sql`
          SELECT v.id FROM question_variants v
          JOIN question_versions qv ON qv.id = v.question_version_id
          JOIN questions q ON q.id = qv.question_id
          WHERE v.id = ${variantId}::uuid AND v.question_version_id = ${versionId}::uuid
            AND q.org_id = ${orgId}::uuid
          FOR UPDATE OF v`),
    );
    return rows.length === 1;
  }

  // ---- per-slot overrides (V-1, V-6) ----------------------------------------------------------

  /** Sets (creates or replaces) the override of one test slot of this very version (V-6). */
  async setOverride(
    actor: Actor,
    id: string,
    version: number,
    variantId: string,
    testCaseId: string,
    dto: VariantOverrideFieldsDto,
    ctx: RequestContext,
  ): Promise<VariantTestCaseOverrideDto> {
    return this.prisma.client.$transaction(async (tx) => {
      const v = await lockDraft(tx, id, version, 'variants');
      await checkRevision(tx, v, dto.expectedRevision);
      await this.requireVariant(tx, v.id, variantId);
      // The slot must be a test case of the same version; otherwise it is the same 404 as a
      // missing one, whatever version or org it belongs to.
      const slot = await tx.testCase.findFirst({
        where: { id: testCaseId, questionVersionId: v.id },
      });
      if (!slot) throw new NotFoundException(SLOT_NOT_FOUND);
      const { count } = await tx.variantTestCase.updateMany({
        where: { variantId, testCaseId },
        data: { input: dto.input, expectedOutput: dto.expectedOutput },
      });
      if (count === 0) {
        await tx.variantTestCase.create({
          data: { variantId, testCaseId, input: dto.input, expectedOutput: dto.expectedOutput },
        });
      }
      await audit(tx, actor, 'QUESTION_VARIANT_TEST_CASE_SET', id, ctx, {
        version,
        variantId,
        testCaseId,
        isHidden: slot.isHidden,
      });
      return {
        testCaseId,
        isHidden: slot.isHidden,
        position: slot.position,
        input: dto.input,
        expectedOutput: dto.expectedOutput,
      };
    });
  }

  /** Removes an override: the slot's default input and output apply again. */
  async removeOverride(
    actor: Actor,
    id: string,
    version: number,
    variantId: string,
    testCaseId: string,
    expectedRevision: string | undefined,
    ctx: RequestContext,
  ): Promise<void> {
    await this.prisma.client.$transaction(async (tx) => {
      const v = await lockDraft(tx, id, version, 'variants');
      await checkRevision(tx, v, expectedRevision);
      await this.requireVariant(tx, v.id, variantId);
      const { count } = await tx.variantTestCase.deleteMany({ where: { variantId, testCaseId } });
      if (count !== 1) throw new NotFoundException('Override not found.');
      await audit(tx, actor, 'QUESTION_VARIANT_TEST_CASE_REMOVED', id, ctx, {
        version,
        variantId,
        testCaseId,
      });
    });
  }

  // ---- helpers --------------------------------------------------------------------------------

  private async requireVariant(db: Db, versionId: string, variantId: string): Promise<VariantRow> {
    const x = await db.questionVariant.findFirst({
      where: { id: variantId, questionVersionId: versionId },
      include: { testCaseOverrides: true },
    });
    if (!x) throw new NotFoundException(VARIANT_NOT_FOUND);
    return x;
  }

  /**
   * Renders the statement of an active variant against the draft's current content, or throws a
   * 400 listing every unknown or malformed placeholder. An inactive variant is not rendered
   * (the previous statement is kept, or '' for a new one) and is checked again on reactivation.
   */
  private renderStrict(
    v: QuestionVersion,
    variantId: string,
    params: unknown,
    isActive: boolean,
    previous = '',
  ): string {
    if (!isActive) return previous;
    const r = renderVariant(v, { id: variantId, params });
    if (!r.ok) throw new BadRequestException(r.problems);
    return r.content.statementMd;
  }

  private async snapshot(
    db: Db,
    versionId: string,
  ): Promise<{ cases: Awaited<ReturnType<Db['testCase']['findMany']>>; variants: VariantRow[] }> {
    const cases = await db.testCase.findMany({
      where: { questionVersionId: versionId },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
    });
    return { cases, variants: await loadVariants(db, versionId) };
  }

  /** The response of a variant write: the variant as stored and the version's new revision. */
  private async mutation(
    tx: Db,
    v: QuestionVersion,
    variantId: string,
  ): Promise<VariantMutationDto> {
    const { cases, variants } = await this.snapshot(tx, v.id);
    const row = variants.find((x) => x.id === variantId);
    if (!row) throw new NotFoundException(VARIANT_NOT_FOUND);
    const variant: VariantDto = toVariantDto(row, cases);
    return { variant, revision: computeRevision(v, cases, variants) };
  }
}
