// VERIFIED to IN_PROGRESS (ADR 0002 L-1, S-2, S-3; ADR 0013 sections 2 and 3; FR-301, FR-305,
// FR-505, TC-024, TC-047). One transaction does all of it, so a failure leaves the session in
// VERIFIED with nothing half-built:
//   - the status change, as a compare-and-set through SessionStateService (the winner of a race);
//   - started_at and deadline_at from the SERVER clock, scaled by the accommodation's extra time;
//   - the per-session HMAC master key, wrapped (it is returned by the proctor-key route, not here);
//   - invitations.used_at (the link is single-use from this moment, L-1);
//   - session_sections (one per test section, the first opened) and session_questions (fixed
//     questions as authored, random rules resolved, one active variant picked per question).
// Variant parameters, hidden cases and answer keys never appear in the response.
import { HttpStatus, Injectable } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { z } from 'zod';
import { CodedHttpException } from '../common/coded.exception';
import type { CandidateProblemCode } from '../common/coded.exception';
import { PrismaService } from '../database/prisma.service';
import { Difficulty, QuestionType } from '../generated/prisma/enums.js';
import { extraTimePct, scaledMs } from '../session/accommodations';
import { SessionKeyService } from '../session/session-key.service';
import { SessionStateConflictError } from '../session/session-state.errors';
import { SessionStateService } from '../session/session-state.service';
import { LIVE_STATUSES, PRE_START_STATUSES } from '../session/session-transitions';
import { sessionNotActive } from '../session/session-write-gate';
import type { CandidateContext } from './candidate.types';

/** The latest system check must be this fresh when the test starts (ADR 0013 section 3). */
export const SYSTEM_CHECK_MAX_AGE_MS = 15 * 60_000;

// What BE-06 stores in test_questions.random_rule. Unknown keys are refused, so a rule that this
// code does not understand fails the start instead of silently picking from the whole bank.
const randomRuleSchema = z
  .object({
    tags: z.array(z.string().min(1).max(64)).max(20).optional(),
    difficulty: z.enum(Difficulty).optional(),
    type: z.enum(QuestionType).optional(),
  })
  .strict();

// What the system-check route (BE-10) stores in sessions.device_info.systemCheck.
const systemCheckSchema = z.object({
  passed: z.boolean(),
  checkedAt: z.iso.datetime(),
});

export interface StartedSection {
  readonly position: number;
  readonly title: string;
  readonly timeLimitMs: number | null;
  readonly startedAt: Date | null;
  readonly deadlineAt: Date | null;
  readonly questions: readonly { sessionQuestionId: string; position: number; points: string }[];
}

export interface TestStartView {
  readonly status: 'IN_PROGRESS' | 'PAUSED';
  readonly serverTime: Date;
  readonly startedAt: Date;
  readonly deadlineAt: Date;
  readonly sections: readonly StartedSection[];
}

function coded(
  status: HttpStatus,
  message: string,
  code: CandidateProblemCode,
  extensions: Record<string, string | number | null> = {},
): CodedHttpException {
  return new CodedHttpException(status, message, code, extensions);
}

function pick<T>(items: readonly T[]): T | undefined {
  return items.length === 0 ? undefined : items[randomInt(0, items.length)];
}

interface PlannedQuestion {
  readonly testQuestionId: string;
  readonly questionVersionId: string;
  readonly variantId: string | null;
  readonly points: string;
}

@Injectable()
export class TestStartService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly states: SessionStateService,
    private readonly keys: SessionKeyService,
  ) {}

  async start(ctx: CandidateContext, now: Date = new Date()): Promise<TestStartView> {
    const session = await this.prisma.client.session.findUnique({
      where: { id: ctx.sessionId },
      select: { status: true, deviceInfo: true, invitationId: true },
    });
    if (session === null) throw sessionNotActive(ctx.status);
    // Idempotent: a repeated or concurrent start returns the running session, never a second one.
    if (LIVE_STATUSES.includes(session.status)) return this.view(ctx.sessionId, now);
    if (session.status !== 'VERIFIED') throw new SessionStateConflictError(session.status);

    const invitation = await this.prisma.client.invitation.findUnique({
      where: { id: session.invitationId },
      select: { id: true, testId: true, windowEnd: true, accommodations: true },
    });
    if (invitation === null) throw new SessionStateConflictError(session.status);
    if (now.getTime() > invitation.windowEnd.getTime()) {
      try {
        await this.states.transition({
          sessionId: ctx.sessionId,
          from: PRE_START_STATUSES,
          to: 'EXPIRED',
          now,
        });
      } catch (e) {
        if (!(e instanceof SessionStateConflictError)) throw e;
      }
      throw coded(HttpStatus.CONFLICT, 'This link has expired.', 'LINK_EXPIRED');
    }
    this.assertSystemCheck(session.deviceInfo, now);

    const test = await this.prisma.client.test.findUnique({
      where: { id: invitation.testId },
      select: { durationMinutes: true },
    });
    if (test === null) throw new SessionStateConflictError(session.status);
    const sections = await this.prisma.client.testSection.findMany({
      where: { testId: invitation.testId },
      orderBy: { position: 'asc' },
      select: { id: true, position: true, timeLimitMin: true },
    });
    const testQuestions = await this.prisma.client.testQuestion.findMany({
      where: { sectionId: { in: sections.map((s) => s.id) } },
      orderBy: { position: 'asc' },
      select: {
        id: true,
        sectionId: true,
        questionVersionId: true,
        randomRule: true,
        points: true,
        position: true,
      },
    });

    const extra = extraTimePct(invitation.accommodations);
    const deadlineAt = new Date(now.getTime() + scaledMs(test.durationMinutes, extra));
    const planned = await this.plan(sections, testQuestions);
    const wrappedKey = this.keys.generateWrapped(ctx.sessionId);

    try {
      await this.prisma.client.$transaction(async (tx) => {
        await this.states.transition({
          sessionId: ctx.sessionId,
          from: 'VERIFIED',
          to: 'IN_PROGRESS',
          now,
          patch: { startedAt: now, deadlineAt, hmacKeyEnc: wrappedKey },
          db: tx,
        });
        const used = await tx.invitation.updateMany({
          where: { id: invitation.id, usedAt: null },
          data: { usedAt: now },
        });
        // A VERIFIED session whose invitation is already used is inconsistent: stop, do not start.
        if (used.count !== 1) throw new SessionStateConflictError(session.status);

        await tx.sessionSection.createMany({
          data: sections.map((section, index) => {
            const limit =
              section.timeLimitMin === null ? null : scaledMs(section.timeLimitMin, extra);
            const first = index === 0;
            // A section never outlives the session (ADR 0002 S-4); no own limit shares the session time.
            const sectionDeadline =
              limit === null
                ? deadlineAt
                : new Date(Math.min(now.getTime() + limit, deadlineAt.getTime()));
            return {
              sessionId: ctx.sessionId,
              sectionId: section.id,
              position: section.position,
              timeLimitMs: limit === null ? null : BigInt(limit),
              startedAt: first ? now : null,
              deadlineAt: first ? sectionDeadline : null,
            };
          }),
        });
        await tx.sessionQuestion.createMany({
          data: planned.map((q, index) => ({
            sessionId: ctx.sessionId,
            testQuestionId: q.testQuestionId,
            questionVersionId: q.questionVersionId,
            variantId: q.variantId,
            position: index + 1,
            points: q.points,
          })),
        });
      });
    } catch (e) {
      if (e instanceof SessionStateConflictError) {
        // Lost a race: if the winner started the session, answer as for a repeated call.
        const again = await this.prisma.client.session.findUnique({
          where: { id: ctx.sessionId },
          select: { status: true },
        });
        if (again !== null && LIVE_STATUSES.includes(again.status)) return this.view(ctx.sessionId, now);
      }
      throw e;
    }
    return this.view(ctx.sessionId, now);
  }

  /** FR-605: a start needs a fresh passed system check (ADR 0013 section 3). */
  private assertSystemCheck(deviceInfo: unknown, now: Date): void {
    const raw =
      typeof deviceInfo === 'object' && deviceInfo !== null
        ? (deviceInfo as Record<string, unknown>).systemCheck
        : undefined;
    const check = systemCheckSchema.safeParse(raw);
    const fresh =
      check.success && now.getTime() - Date.parse(check.data.checkedAt) <= SYSTEM_CHECK_MAX_AGE_MS;
    if (!check.success || !check.data.passed || !fresh) {
      throw coded(
        HttpStatus.CONFLICT,
        'Run the system check again before starting the test.',
        'SYSTEM_CHECK_BLOCKED',
      );
    }
  }

  private async plan(
    sections: readonly { id: string; position: number }[],
    testQuestions: readonly {
      id: string;
      sectionId: string;
      questionVersionId: string | null;
      randomRule: unknown;
      points: { toString(): string };
    }[],
  ): Promise<PlannedQuestion[]> {
    const order = new Map(sections.map((s) => [s.id, s.position]));
    const ordered = [...testQuestions].sort(
      (a, b) =>
        (order.get(a.sectionId) ?? 0) - (order.get(b.sectionId) ?? 0) ||
        testQuestions.indexOf(a) - testQuestions.indexOf(b),
    );
    const usedQuestionIds = new Set<string>();
    const usedVersionIds = new Set<string>();
    const out: PlannedQuestion[] = [];
    for (const tq of ordered) {
      let versionId = tq.questionVersionId;
      if (versionId === null) {
        versionId = await this.resolveRandom(tq.randomRule, usedQuestionIds, usedVersionIds);
      } else {
        // A fixed version must exist in this org (the scoped client finds only this org's rows).
        const found = await this.prisma.client.questionVersion.findUnique({
          where: { id: versionId },
          select: { id: true, questionId: true },
        });
        if (found === null) {
          throw coded(
            HttpStatus.CONFLICT,
            'A question of this test is not available.',
            'RANDOM_RULE_UNSATISFIABLE',
          );
        }
        usedQuestionIds.add(found.questionId);
      }
      usedVersionIds.add(versionId);
      const variants = await this.prisma.client.questionVariant.findMany({
        where: { questionVersionId: versionId, isActive: true },
        select: { id: true },
      });
      out.push({
        testQuestionId: tq.id,
        questionVersionId: versionId,
        variantId: pick(variants)?.id ?? null,
        points: tq.points.toString(),
      });
    }
    return out;
  }

  private async resolveRandom(
    rawRule: unknown,
    usedQuestionIds: Set<string>,
    usedVersionIds: Set<string>,
  ): Promise<string> {
    const rule = randomRuleSchema.safeParse(rawRule);
    if (!rule.success) {
      throw coded(
        HttpStatus.CONFLICT,
        'A random question rule of this test is not understood.',
        'RANDOM_RULE_UNSATISFIABLE',
      );
    }
    const { tags, difficulty, type } = rule.data;
    const questions = await this.prisma.client.question.findMany({
      where: {
        isArchived: false,
        currentVersionId: { not: null },
        ...(type !== undefined ? { type } : {}),
        ...(tags !== undefined && tags.length > 0 ? { tags: { hasEvery: tags } } : {}),
      },
      select: { id: true, currentVersionId: true },
      take: 2000,
    });
    const versionIds = questions
      .filter((q) => !usedQuestionIds.has(q.id) && q.currentVersionId !== null)
      .map((q) => q.currentVersionId as string)
      .filter((id) => !usedVersionIds.has(id));
    const versions = await this.prisma.client.questionVersion.findMany({
      where: {
        id: { in: versionIds },
        isPublished: true,
        ...(difficulty !== undefined ? { difficulty } : {}),
      },
      select: { id: true, questionId: true },
    });
    const chosen = pick(versions);
    if (chosen === undefined) {
      throw coded(
        HttpStatus.CONFLICT,
        'No question matches a random rule of this test.',
        'RANDOM_RULE_UNSATISFIABLE',
      );
    }
    usedQuestionIds.add(chosen.questionId);
    return chosen.id;
  }

  /** The running session's outline: ids, positions, points and times; no question content. */
  async view(sessionId: string, now: Date = new Date()): Promise<TestStartView> {
    const session = await this.prisma.client.session.findUnique({
      where: { id: sessionId },
      select: { status: true, startedAt: true, deadlineAt: true },
    });
    if (session === null || session.startedAt === null || session.deadlineAt === null) {
      throw sessionNotActive(session?.status ?? 'INVITED');
    }
    const [sessionSections, questions] = await Promise.all([
      this.prisma.client.sessionSection.findMany({
        where: { sessionId },
        orderBy: { position: 'asc' },
      }),
      this.prisma.client.sessionQuestion.findMany({
        where: { sessionId },
        orderBy: { position: 'asc' },
        select: { id: true, position: true, points: true, testQuestionId: true },
      }),
    ]);
    const titles = await this.prisma.client.testSection.findMany({
      where: { id: { in: sessionSections.map((s) => s.sectionId) } },
      select: { id: true, title: true },
    });
    const testQuestions = await this.prisma.client.testQuestion.findMany({
      where: { id: { in: questions.map((q) => q.testQuestionId) } },
      select: { id: true, sectionId: true },
    });
    const sectionOfTq = new Map(testQuestions.map((t) => [t.id, t.sectionId]));
    return {
      status: session.status === 'PAUSED' ? 'PAUSED' : 'IN_PROGRESS',
      serverTime: now,
      startedAt: session.startedAt,
      deadlineAt: session.deadlineAt,
      sections: sessionSections.map((s) => ({
        position: s.position,
        title: titles.find((t) => t.id === s.sectionId)?.title ?? '',
        timeLimitMs: s.timeLimitMs === null ? null : Number(s.timeLimitMs),
        startedAt: s.startedAt,
        deadlineAt: s.deadlineAt,
        questions: questions
          .filter((q) => sectionOfTq.get(q.testQuestionId) === s.sectionId)
          .map((q) => ({ sessionQuestionId: q.id, position: q.position, points: q.points.toString() })),
      })),
    };
  }
}
