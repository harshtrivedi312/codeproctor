// AI reference solutions (ADR 0005 AI-1..AI-6; BE-04 slice 4c). Author data, never shown to
// recruiters or candidates and never used for grading. Rows are append-only: the only update is
// `superseded_at`, and a refresh inserts the replacement in the same transaction. Every write takes
// the question row lock (question-tx.ts `lockWritable`), so it runs one at a time with publish,
// which reads the rows under the same lock. Audit rows (`AI_REFERENCE_CREATED`,
// `AI_REFERENCE_SUPERSEDED`) are written in the same transaction with ids only.
import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import type { AiReferenceSolution } from '../generated/prisma/client';
import type { RequestContext } from '../common/request-context';
import { audit, lockWritable, NOT_FOUND, requireQuestion } from './question-tx';
import type { Actor, Db } from './question-tx';
import type {
  AiReferenceDto,
  AiReferenceListDto,
  CreateAiReferenceDto,
  SupersedeAiReferenceDto,
  SupersedeResultDto,
} from './dto/ai-references.dto';

const NOT_FOUND_AI = 'AI reference solution not found.';

function toDto(r: AiReferenceSolution): AiReferenceDto {
  return {
    id: r.id,
    variantId: r.variantId,
    assistant: r.assistant,
    modelLabel: r.modelLabel,
    language: r.language,
    solutionCode: r.solutionCode,
    promptText: r.promptText,
    collectedAt: r.collectedAt.toISOString(),
    collectedById: r.collectedById,
    supersededAt: r.supersededAt ? r.supersededAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
  };
}

@Injectable()
export class AiReferencesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Server time; replaceable in tests. */
  clock: () => Date = () => new Date();

  async list(id: string, version: number): Promise<AiReferenceListDto> {
    const db = this.prisma.client;
    await requireQuestion(db, id);
    const v = await db.questionVersion.findFirst({
      where: { questionId: id, version },
      select: { id: true },
    });
    if (!v) throw new NotFoundException(NOT_FOUND);
    const rows = await db.aiReferenceSolution.findMany({
      where: { questionVersionId: v.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    });
    return { items: rows.map(toDto) };
  }

  async create(
    actor: Actor,
    id: string,
    version: number,
    dto: CreateAiReferenceDto,
    ctx: RequestContext,
  ): Promise<AiReferenceDto> {
    return this.prisma.client.$transaction(async (tx) => {
      const v = await this.lockVersion(tx, id, version);
      const row = await this.insert(tx, actor, v, dto);
      await audit(tx, actor, 'AI_REFERENCE_CREATED', id, ctx, {
        version,
        aiReferenceId: row.id,
        language: row.language,
        variantId: row.variantId,
      });
      return toDto(row);
    });
  }

  async supersede(
    actor: Actor,
    id: string,
    version: number,
    aiReferenceId: string,
    dto: SupersedeAiReferenceDto,
    ctx: RequestContext,
  ): Promise<SupersedeResultDto> {
    return this.prisma.client.$transaction(async (tx) => {
      const v = await this.lockVersion(tx, id, version);
      const existing = await tx.aiReferenceSolution.findFirst({
        where: { id: aiReferenceId, questionVersionId: v.id },
      });
      if (!existing) throw new NotFoundException(NOT_FOUND_AI);
      // The only update the table ever sees (AI-1); the guard makes a second retire a 409.
      const { count } = await tx.aiReferenceSolution.updateMany({
        where: { id: aiReferenceId, questionVersionId: v.id, supersededAt: null },
        data: { supersededAt: this.clock() },
      });
      if (count !== 1)
        throw new ConflictException('The AI reference solution is already superseded.');
      const replacement = dto.replacement ? await this.insert(tx, actor, v, dto.replacement) : null;
      if (replacement) {
        await audit(tx, actor, 'AI_REFERENCE_CREATED', id, ctx, {
          version,
          aiReferenceId: replacement.id,
          language: replacement.language,
          variantId: replacement.variantId,
        });
      }
      await audit(tx, actor, 'AI_REFERENCE_SUPERSEDED', id, ctx, {
        version,
        aiReferenceId,
        replacementId: replacement ? replacement.id : null,
      });
      const retired = await tx.aiReferenceSolution.findUniqueOrThrow({
        where: { id: aiReferenceId },
      });
      return { superseded: toDto(retired), replacement: replacement ? toDto(replacement) : null };
    });
  }

  /** Locks the question (404 other org or missing, 409 archived) and returns its coding version. */
  private async lockVersion(
    tx: Db,
    id: string,
    version: number,
  ): Promise<{ id: string; allowedLanguages: string[] }> {
    const question = await lockWritable(tx, id);
    const v = await tx.questionVersion.findFirst({
      where: { questionId: id, version },
      select: { id: true, allowedLanguages: true },
    });
    if (!v) throw new NotFoundException(NOT_FOUND);
    if (question.type !== 'CODING') {
      throw new UnprocessableEntityException('Only coding questions have AI reference solutions.');
    }
    return v;
  }

  private async insert(
    tx: Db,
    actor: Actor,
    v: { id: string; allowedLanguages: string[] },
    dto: CreateAiReferenceDto,
  ): Promise<AiReferenceSolution> {
    if (!v.allowedLanguages.includes(dto.language)) {
      throw new UnprocessableEntityException('language: not an allowed language of this version');
    }
    if (dto.variantId !== undefined) {
      const found = await tx.questionVariant.findFirst({
        where: { id: dto.variantId, questionVersionId: v.id },
        select: { id: true },
      });
      if (!found) throw new NotFoundException('Variant not found.');
    }
    return tx.aiReferenceSolution.create({
      data: {
        questionVersionId: v.id,
        variantId: dto.variantId ?? null,
        assistant: dto.assistant.trim(),
        modelLabel: dto.modelLabel.trim(),
        language: dto.language,
        solutionCode: dto.solutionCode,
        promptText: dto.promptText ?? null,
        collectedAt: this.clock(),
        collectedById: actor.id,
      },
    });
  }
}
