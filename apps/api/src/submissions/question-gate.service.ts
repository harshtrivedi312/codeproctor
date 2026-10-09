// The one gate every question write runs first (ADR 0002 S-5, ADR 0013 section 5.10 CS-2 and CS-4.6,
// DL-17). Call `open` INSIDE an org scope the caller opened (scope.asOrg), so the reads here and the
// caller's own reads are one step.
//   - the id is a session_questions.id and is resolved ONLY under the token's session: a question of
//     another session, or of another org, is a plain 404 (CS-2, TC-008);
//   - the session is IN_PROGRESS or PAUSED and not paused for a reason that locks writes
//     (assertWritable: PROCTOR, SCREEN_SHARE_STOPPED, SIDE_CAMERA_LOST);
//   - the question's section is open: started, not ended, and, on SERVER time, before its effective
//     deadline and the session's, even if the close job has not run yet. The gate fails closed.
import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { CodedHttpException } from '../common/coded.exception';
import { PrismaService } from '../database/prisma.service';
import type { CandidateContext } from '../candidate/candidate.types';
import type { QuestionType } from '../generated/prisma/enums.js';
import {
  effectiveSectionDeadline,
  effectiveSessionDeadline,
  proctorPauseCapMs,
} from '../session/deadlines';
import { assertWritable, sessionNotActive } from '../session/session-write-gate';
import { LIVE_STATUSES } from '../session/session-transitions';

export interface OpenQuestion {
  readonly sessionQuestionId: string;
  readonly type: QuestionType;
  readonly questionVersionId: string;
  readonly variantId: string | null;
  readonly sectionId: string;
  readonly allowedLanguages: readonly string[];
  readonly limits: unknown;
  /** Server-side only. Never serialized to a candidate. */
  readonly answerSpec: unknown;
}

/**
 * 409 SECTION_NOT_OPEN. When it is refused because a deadline passed on server time, it names what
 * is due so the route can queue the close (lazy opening of the next section, ADR 0013 5.11) without
 * waiting for the sweep. Server-side only: the response body never carries these fields.
 */
export type DueClose =
  | { readonly kind: 'section'; readonly sectionId: string; readonly at: Date }
  | { readonly kind: 'session'; readonly at: Date };

export class SectionNotOpenError extends CodedHttpException {
  /** Server-side only: not serialized (HttpException keeps just message and code). */
  constructor(readonly due?: DueClose) {
    super(HttpStatus.CONFLICT, 'This question is not in the open section.', 'SECTION_NOT_OPEN');
  }
}

function sectionNotOpen(due?: DueClose): SectionNotOpenError {
  return new SectionNotOpenError(due);
}

@Injectable()
export class QuestionGateService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * For section finish: the section at `position` of THIS session (CS-2: resolved only through the
   * session's own sections, never an id). Returns its id while it is open; null when it is already
   * closed (a retry or a race: a no-op). 409 SECTION_NOT_OPEN for a later position that has not
   * opened; 404 for a position the session does not have. Writable like every write.
   */
  async openSectionAt(ctx: CandidateContext, position: number): Promise<string | null> {
    const db = this.prisma.client;
    const session = await db.session.findUnique({
      where: { id: ctx.sessionId },
      select: { status: true, pauseReasons: true },
    });
    if (session === null) throw new NotFoundException();
    assertWritable(session);
    const section = await db.sessionSection.findUnique({
      where: { sessionId_position: { sessionId: ctx.sessionId, position } },
      select: { sectionId: true, startedAt: true, endedAt: true },
    });
    if (section === null) throw new NotFoundException();
    if (section.startedAt === null) throw sectionNotOpen();
    return section.endedAt === null ? section.sectionId : null;
  }

  async open(
    ctx: CandidateContext,
    sessionQuestionId: string,
    now: Date,
    /** 'read' skips the pause write lock: reads stay allowed in every pause (ADR 0013 CS-4.6). */
    mode: 'write' | 'read' = 'write',
  ): Promise<OpenQuestion> {
    const db = this.prisma.client;
    const session = await db.session.findUnique({
      where: { id: ctx.sessionId },
      select: {
        status: true,
        pauseReasons: true,
        deadlineAt: true,
        pausedMs: true,
        proctorPausedAt: true,
      },
    });
    if (session === null) throw new NotFoundException();
    if (mode === 'read') {
      if (!LIVE_STATUSES.includes(session.status)) throw sessionNotActive(session.status);
    } else {
      assertWritable(session);
    }

    const question = await db.sessionQuestion.findFirst({
      where: { id: sessionQuestionId, sessionId: ctx.sessionId },
      select: {
        id: true,
        testQuestionId: true,
        questionVersionId: true,
        variantId: true,
      },
    });
    if (question === null) throw new NotFoundException();

    const org = await db.organization.findUnique({
      where: { id: ctx.orgId },
      select: { settings: true },
    });
    const cap = proctorPauseCapMs(org?.settings);
    const sessionDeadline = effectiveSessionDeadline(session, now, cap);
    if (sessionDeadline === null || now.getTime() >= sessionDeadline.getTime()) {
      throw sectionNotOpen(
        sessionDeadline === null ? undefined : { kind: 'session', at: sessionDeadline },
      );
    }

    const testQuestion = await db.testQuestion.findUnique({
      where: { id: question.testQuestionId },
      select: { sectionId: true },
    });
    if (testQuestion === null) throw sectionNotOpen();
    const section = await db.sessionSection.findUnique({
      where: {
        sessionId_sectionId: { sessionId: ctx.sessionId, sectionId: testQuestion.sectionId },
      },
      select: { startedAt: true, endedAt: true, deadlineAt: true },
    });
    if (section === null || section.startedAt === null || section.endedAt !== null) {
      throw sectionNotOpen();
    }
    const sectionDeadline = effectiveSectionDeadline(section, session, now, cap);
    if (sectionDeadline === null || now.getTime() >= sectionDeadline.getTime()) {
      throw sectionNotOpen(
        sectionDeadline === null
          ? undefined
          : { kind: 'section', sectionId: testQuestion.sectionId, at: sectionDeadline },
      );
    }

    const version = await db.questionVersion.findUnique({
      where: { id: question.questionVersionId },
      select: { questionId: true, allowedLanguages: true, limits: true, answerSpec: true },
    });
    if (version === null) throw new NotFoundException();
    const parent = await db.question.findUnique({
      where: { id: version.questionId },
      select: { type: true },
    });
    if (parent === null) throw new NotFoundException();

    return {
      sessionQuestionId: question.id,
      type: parent.type,
      questionVersionId: question.questionVersionId,
      variantId: question.variantId,
      sectionId: testQuestion.sectionId,
      allowedLanguages: version.allowedLanguages,
      limits: version.limits,
      answerSpec: version.answerSpec,
    };
  }
}
