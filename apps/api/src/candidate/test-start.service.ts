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
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { CodedHttpException } from '../common/coded.exception';
import type { CandidateProblemCode } from '../common/coded.exception';
import { PrismaService } from '../database/prisma.service';
import { CandidateScope } from './candidate-scope';
import { readExtraTime, scaledMs } from '../session/accommodations';
import { SessionKeyConfigError, SessionKeyService } from '../session/session-key.service';
import { SessionStateConflictError } from '../session/session-state.errors';
import { SessionStateService } from '../session/session-state.service';
import { SYSTEM_CHECK_MAX_AGE_MS, isSystemCheckFresh } from '../session/system-check';
import { LIVE_STATUSES, PRE_START_STATUSES } from '../session/session-transitions';
import {
  effectiveSectionDeadline,
  effectiveSessionDeadline,
  proctorPauseCapMs,
} from '../session/deadlines';
import { sessionNotActive } from '../session/session-write-gate';
import { parseRandomRule, ruleKey } from '../tests/random-rule';
import type { RandomRule } from '../tests/random-rule';
import { unservedSlots } from '../tests/feasibility';
import type { CandidateContext } from './candidate.types';
import { assignDistinct } from './random-assignment';

/** Candidates read per random rule (ordered by id): wide enough for variety between candidates. */
const RANDOM_POOL = 2000;

export { SYSTEM_CHECK_MAX_AGE_MS };

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
  private readonly logger = new Logger(TestStartService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly states: SessionStateService,
    private readonly keys: SessionKeyService,
    private readonly scope: CandidateScope,
  ) {}

  /**
   * Everything here reads question content, test sections, accommodations, the wrapped key and
   * writes status, so it runs in the org scope, not the candidate scope (CS-4.4 opens none of it
   * until PR 2's grants). The session id is the token's.
   */
  start(ctx: CandidateContext, now: Date = new Date()): Promise<TestStartView> {
    return this.scope.asOrg(ctx, () => this.startInScope(ctx, now));
  }

  private async startInScope(ctx: CandidateContext, now: Date): Promise<TestStartView> {
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

    const { pct: extra, ignored } = readExtraTime(invitation.accommodations);
    if (ignored) {
      // Ids only: the accommodation text itself may be health-adjacent and is never logged.
      this.logger.warn(
        `Ignored a malformed extraTimePct for session ${ctx.sessionId} (invitation ${invitation.id})`,
      );
    }
    const deadlineAt = new Date(now.getTime() + scaledMs(test.durationMinutes, extra));
    const planned = await this.plan(ctx.sessionId, sections, testQuestions);
    let wrappedKey: string;
    try {
      wrappedKey = this.keys.generateWrapped(ctx.sessionId);
    } catch (e) {
      if (!(e instanceof SessionKeyConfigError)) throw e;
      throw coded(
        HttpStatus.SERVICE_UNAVAILABLE,
        'The candidate portal is not configured.',
        'CANDIDATE_PORTAL_UNCONFIGURED',
      );
    }

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
        if (again !== null && LIVE_STATUSES.includes(again.status))
          return this.view(ctx.sessionId, now);
      }
      throw e;
    }
    return this.view(ctx.sessionId, now);
  }

  /** FR-605: a start needs a fresh passed system check (ADR 0013 section 3). */
  private assertSystemCheck(deviceInfo: unknown, now: Date): void {
    if (!isSystemCheckFresh(deviceInfo, now)) {
      throw coded(
        HttpStatus.CONFLICT,
        'Run the system check again before starting the test.',
        'SYSTEM_CHECK_BLOCKED',
      );
    }
  }

  private async plan(
    sessionId: string,
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
    const takenQuestionIds = new Set<string>();
    // Fixed slots first: every fixed question (whatever the slot order) is taken before any random
    // rule is resolved, so a random pick can never repeat a fixed question or another version of it.
    const fixed = new Map<string, string>();
    for (const tq of ordered) {
      if (tq.questionVersionId === null) continue;
      // A fixed version must exist in this org (the scoped client finds only this org's rows).
      const found = await this.prisma.client.questionVersion.findUnique({
        where: { id: tq.questionVersionId },
        select: { id: true, questionId: true },
      });
      if (found === null) {
        throw coded(
          HttpStatus.CONFLICT,
          'A question of this test is not available.',
          'RANDOM_RULE_UNSATISFIABLE',
        );
      }
      takenQuestionIds.add(found.questionId);
      fixed.set(tq.id, found.id);
    }
    const randomVersions = await this.assignRandom(
      sessionId,
      ordered.filter((tq) => tq.questionVersionId === null),
      takenQuestionIds,
      fixed.size,
    );
    const out: PlannedQuestion[] = [];
    for (const tq of ordered) {
      const versionId = fixed.get(tq.id) ?? randomVersions.get(tq.id);
      if (versionId === undefined) {
        throw coded(
          HttpStatus.CONFLICT,
          'No question matches a random rule of this test.',
          'RANDOM_RULE_UNSATISFIABLE',
        );
      }
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

  /**
   * One question for every random slot, by the same exact matching the save-time check uses
   * (tests/feasibility.ts), so a test that was accepted at save never fails here. Candidates per
   * distinct rule: the org's questions that are not archived, whose current version is published
   * with the rule's difficulty, with every tag and the type, ordered by id and bounded.
   * Returns test_question id -> the question's current version id.
   */
  private async assignRandom(
    sessionId: string,
    slots: readonly { id: string; randomRule: unknown }[],
    taken: ReadonlySet<string>,
    fixedCount: number,
  ): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    if (slots.length === 0) return result;
    const rules: RandomRule[] = [];
    for (const slot of slots) {
      const parsed = parseRandomRule(slot.randomRule);
      if (!parsed.ok) {
        throw coded(
          HttpStatus.CONFLICT,
          'A random question rule of this test is not understood.',
          'RANDOM_RULE_UNSATISFIABLE',
        );
      }
      rules.push(parsed.rule);
    }
    // Enough ids per rule that truncating cannot change feasibility (feasibility.ts candidateCap),
    // and a wide pool so different candidates still get different questions.
    const take = Math.max(RANDOM_POOL, slots.length + fixedCount);
    const byKey = new Map<string, string[]>();
    const versionOf = new Map<string, string>();
    for (const rule of rules) {
      const key = ruleKey(rule);
      if (byKey.has(key)) continue;
      const rows = await this.prisma.client.question.findMany({
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
        select: { id: true, currentVersionId: true },
        orderBy: { id: 'asc' },
        take,
      });
      for (const r of rows)
        if (r.currentVersionId !== null) versionOf.set(r.id, r.currentVersionId);
      byKey.set(
        key,
        rows.map((r) => r.id),
      );
    }
    const options = rules.map((rule) => byKey.get(ruleKey(rule)) ?? []);
    if (unservedSlots(options, taken).length > 0) {
      throw coded(
        HttpStatus.CONFLICT,
        'No question matches a random rule of this test.',
        'RANDOM_RULE_UNSATISFIABLE',
      );
    }
    const chosen = assignDistinct(options, taken, sessionId);
    slots.forEach((slot, i) => {
      const questionId = chosen[i];
      const versionId =
        questionId === null || questionId === undefined ? undefined : versionOf.get(questionId);
      if (versionId === undefined) {
        throw coded(
          HttpStatus.CONFLICT,
          'No question matches a random rule of this test.',
          'RANDOM_RULE_UNSATISFIABLE',
        );
      }
      result.set(slot.id, versionId);
    });
    return result;
  }

  /** GET /candidate/session/test: the layout of a running session, read in the org scope (P-24 interim). */
  layout(ctx: CandidateContext, now: Date = new Date()): Promise<TestStartView> {
    return this.scope.asOrg(ctx, () => this.view(ctx.sessionId, now, true));
  }

  /** The running session's outline: ids, positions, points and times; no question content. */
  async view(
    sessionId: string,
    now: Date = new Date(),
    /** The GET route: only a running (IN_PROGRESS or PAUSED) session has a layout to read. */
    requireRunning = false,
  ): Promise<TestStartView> {
    const session = await this.prisma.client.session.findUnique({
      where: { id: sessionId },
      select: {
        status: true,
        startedAt: true,
        deadlineAt: true,
        orgId: true,
        pausedMs: true,
        proctorPausedAt: true,
        pauseReasons: true,
      },
    });
    if (session === null || session.startedAt === null || session.deadlineAt === null) {
      throw sessionNotActive(session?.status ?? 'INVITED');
    }
    if (requireRunning && session.status !== 'IN_PROGRESS' && session.status !== 'PAUSED') {
      throw sessionNotActive(session.status);
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
    // The GET route shows the EFFECTIVE deadlines: during a PROCTOR pause the stored ones are stale
    // (ADR 0013 CS-4.6, ADR 0002 P-3), so a reload while paused must not show a shorter timer than
    // the gate and the heartbeat enforce. POST test/start has no pause to account for.
    let cap = 0;
    if (requireRunning) {
      const org = await this.prisma.client.organization.findUnique({
        where: { id: session.orgId },
        select: { settings: true },
      });
      cap = proctorPauseCapMs(org?.settings);
    }
    const sessionDeadline = requireRunning
      ? (effectiveSessionDeadline(session, now, cap) ?? session.deadlineAt)
      : session.deadlineAt;
    return {
      status: session.status === 'PAUSED' ? 'PAUSED' : 'IN_PROGRESS',
      serverTime: now,
      startedAt: session.startedAt,
      deadlineAt: sessionDeadline,
      sections: sessionSections.map((s) => ({
        position: s.position,
        title: titles.find((t) => t.id === s.sectionId)?.title ?? '',
        timeLimitMs: s.timeLimitMs === null ? null : Number(s.timeLimitMs),
        startedAt: s.startedAt,
        deadlineAt: requireRunning ? effectiveSectionDeadline(s, session, now, cap) : s.deadlineAt,
        questions: questions
          .filter((q) => sectionOfTq.get(q.testQuestionId) === s.sectionId)
          .map((q) => ({
            sessionQuestionId: q.id,
            position: q.position,
            points: q.points.toString(),
          })),
      })),
    };
  }
}
