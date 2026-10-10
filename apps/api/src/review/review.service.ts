// Reviewer read API (FR-901, FR-703, FR-105; demo sprint). Three reads: the queue, the review bundle
// of one session and a presigned playback URL. Every query goes through the org-scoped client, and
// every id chain is walked with flat top-level queries (nested reads are not org-filtered, see the
// header of database/org-scope.extension.ts): a session, recording or answer of another org is the
// same 404 as a missing one (TC-008). The candidate payload of events, source code of runs, hidden
// test data and object keys never leave this file: only the fields mapped below are returned.
// Nothing here logs a key or a URL.
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { Prisma } from '../generated/prisma/client';
import type { SessionStatus } from '../generated/prisma/enums';
import type {
  PlaybackDto,
  QueueDto,
  QueueQueryDto,
  ReviewAnswerDto,
  ReviewBundleDto,
} from './dto/review.dto';
import { decodeCursor, encodeCursor } from './review-cursor';
import {
  RECORDING_KINDS,
  contentTypeOf,
  eventDetail,
  parseRecordingId,
  recordingId,
  runTests,
} from './review-mappers';
import type { RecordingKind } from './review-mappers';
import { reviewStatement } from './review-statement';
import { RecordingStoragePort } from './recording-storage.port';

/** FR-703: playback URLs are valid for 15 minutes. */
export const PLAYBACK_TTL_SECONDS = 900;
const DEFAULT_QUEUE_STATUSES: SessionStatus[] = ['GRADED', 'UNDER_REVIEW'];
const MAX_EVENTS = 5000;
const MAX_RUNS = 500;
const MAX_PARTS = 5000;
const NOT_FOUND = 'Session not found.';

const num = (d: Prisma.Decimal | null): number | null => (d === null ? null : Number(d));
const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

@Injectable()
export class ReviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: RecordingStoragePort,
  ) {}

  // ---- queue ----------------------------------------------------------------------------------

  async queue(q: QueueQueryDto): Promise<QueueDto> {
    const db = this.prisma.client;
    const statuses = q.status ? [q.status] : DEFAULT_QUEUE_STATUSES;
    const conditions: Prisma.SessionWhereInput[] = [{ status: { in: statuses } }];
    if (q.cursor) {
      const c = decodeCursor(q.cursor);
      conditions.push(
        c.t === null
          ? { submittedAt: null, id: { gt: c.id } }
          : {
              OR: [
                { submittedAt: { gt: new Date(c.t) } },
                { submittedAt: new Date(c.t), id: { gt: c.id } },
                { submittedAt: null },
              ],
            },
      );
    }
    // Oldest submission first; sessions without a submission time (only for explicit pre-submit
    // statuses) sort last in PostgreSQL ascending order.
    const rows = await db.session.findMany({
      where: { AND: conditions },
      orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
      take: q.pageSize + 1,
      select: {
        id: true,
        status: true,
        submittedAt: true,
        riskScore: true,
        invitationId: true,
      },
    });
    const page = rows.slice(0, q.pageSize);
    const last = page[page.length - 1];
    const nextCursor =
      rows.length > q.pageSize && last
        ? encodeCursor({ t: iso(last.submittedAt), id: last.id })
        : null;
    if (page.length === 0) return { items: [], nextCursor };

    const sessionIds = page.map((s) => s.id);
    const invitations = await db.invitation.findMany({
      where: { id: { in: page.map((s) => s.invitationId) } },
      select: { id: true, testId: true, candidateId: true },
    });
    const [candidates, tests, flags, pending] = await Promise.all([
      db.candidate.findMany({
        where: { id: { in: invitations.map((i) => i.candidateId) } },
        select: { id: true, fullName: true, email: true },
      }),
      db.test.findMany({
        where: { id: { in: invitations.map((i) => i.testId) } },
        select: { id: true, name: true },
      }),
      db.proctorEvent.groupBy({
        by: ['sessionId'],
        where: { sessionId: { in: sessionIds }, severity: { in: ['MEDIUM', 'HIGH'] } },
        _count: { _all: true },
      }),
      db.sessionQuestion.groupBy({
        by: ['sessionId'],
        where: { sessionId: { in: sessionIds }, scoring: 'MANUAL_PENDING' },
        _count: { _all: true },
      }),
    ]);
    const invById = new Map(invitations.map((i) => [i.id, i]));
    const candById = new Map(candidates.map((c) => [c.id, c]));
    const testById = new Map(tests.map((t) => [t.id, t]));
    const flagBy = new Map(flags.map((f) => [f.sessionId, f._count._all]));
    const pendBy = new Map(pending.map((f) => [f.sessionId, f._count._all]));

    return {
      items: page.map((s) => {
        const inv = invById.get(s.invitationId);
        const cand = inv ? candById.get(inv.candidateId) : undefined;
        const test = inv ? testById.get(inv.testId) : undefined;
        return {
          sessionId: s.id,
          candidateName: cand?.fullName ?? '',
          candidateEmail: cand?.email ?? '',
          testTitle: test?.name ?? '',
          status: s.status,
          submittedAt: iso(s.submittedAt),
          riskScore: s.riskScore,
          flagCount: flagBy.get(s.id) ?? 0,
          pendingManualCount: pendBy.get(s.id) ?? 0,
        };
      }),
      nextCursor,
    };
  }

  // ---- bundle ---------------------------------------------------------------------------------

  async bundle(sessionId: string): Promise<ReviewBundleDto> {
    const db = this.prisma.client;
    const session = await db.session.findFirst({
      where: { id: sessionId },
      select: {
        id: true,
        status: true,
        startedAt: true,
        submittedAt: true,
        totalScore: true,
        riskScore: true,
        invitationId: true,
      },
    });
    if (!session) throw new NotFoundException(NOT_FOUND);
    const invitation = await db.invitation.findFirst({
      where: { id: session.invitationId },
      select: { testId: true, candidateId: true },
    });
    if (!invitation) throw new NotFoundException(NOT_FOUND);

    const [candidate, test, sqs, events, chunks, review] = await Promise.all([
      db.candidate.findFirst({
        where: { id: invitation.candidateId },
        select: { fullName: true, email: true },
      }),
      db.test.findFirst({ where: { id: invitation.testId }, select: { name: true } }),
      db.sessionQuestion.findMany({
        where: { sessionId },
        orderBy: { position: 'asc' },
        select: {
          id: true,
          questionVersionId: true,
          variantId: true,
          points: true,
          score: true,
          scoring: true,
          scoringNote: true,
          finalCode: true,
          finalLanguage: true,
          answer: true,
        },
      }),
      db.proctorEvent.findMany({
        where: { sessionId },
        orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
        take: MAX_EVENTS,
        select: {
          id: true,
          occurredAt: true,
          type: true,
          severity: true,
          durationMs: true,
          confidence: true,
          flagDecision: { select: { id: true } },
        },
      }),
      db.mediaChunk.findMany({
        where: {
          sessionId,
          stream: { in: [...RECORDING_KINDS] },
          deletedAt: null,
          uploadedAt: { not: null },
          objectKey: { not: null },
        },
        orderBy: [{ stream: 'asc' }, { segment: 'asc' }, { seq: 'asc' }],
        take: MAX_PARTS,
        select: { stream: true, segment: true, startedAt: true, durationMs: true },
      }),
      db.sessionReview.findFirst({
        where: { sessionId },
        select: { verdict: true, notes: true, completedAt: true },
      }),
    ]);

    // The variant each session question was dealt, org-scoped, loaded with the versions. Only what
    // is needed to show the statement the candidate saw (FR-105); params never leave this method.
    const variantIds = [
      ...new Set(sqs.flatMap((s) => (s.variantId === null ? [] : [s.variantId]))),
    ];
    const [versions, variants] = await Promise.all([
      sqs.length
        ? db.questionVersion.findMany({
            where: { id: { in: sqs.map((s) => s.questionVersionId) } },
            select: { id: true, title: true, statementMd: true, questionId: true },
          })
        : [],
      variantIds.length
        ? db.questionVariant.findMany({
            where: { id: { in: variantIds } },
            select: { id: true, params: true, renderedStatement: true },
          })
        : [],
    ]);
    const variantById = new Map(variants.map((x) => [x.id, x]));
    const questions = versions.length
      ? await db.question.findMany({
          where: { id: { in: versions.map((v) => v.questionId) } },
          select: { id: true, type: true },
        })
      : [];
    const runs = sqs.length
      ? await db.submission.findMany({
          where: { sessionQuestionId: { in: sqs.map((s) => s.id) } },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: MAX_RUNS,
          select: {
            sessionQuestionId: true,
            createdAt: true,
            passed: true,
            total: true,
            results: true,
          },
        })
      : [];
    const versionById = new Map(versions.map((v) => [v.id, v]));
    const typeByQuestion = new Map(questions.map((q) => [q.id, q.type]));

    const answers: ReviewAnswerDto[] = sqs.map((s) => {
      const v = versionById.get(s.questionVersionId);
      const type = (v && typeByQuestion.get(v.questionId)) ?? 'CODING';
      const base = {
        sessionQuestionId: s.id,
        type,
        title: v?.title ?? '',
        statement: reviewStatement(
          v?.statementMd ?? '',
          s.variantId === null ? null : variantById.get(s.variantId),
        ),
        points: Number(s.points),
        score: num(s.score),
        scoring: s.scoring,
        scoringNote: s.scoringNote,
      };
      if (type !== 'CODING') return { ...base, answer: s.answer ?? null };
      return {
        ...base,
        answer:
          s.finalCode === null && s.finalLanguage === null
            ? null
            : { language: s.finalLanguage, code: s.finalCode },
        runResults: runs
          .filter((r) => r.sessionQuestionId === s.id)
          .map((r) => ({
            at: r.createdAt.toISOString(),
            passed: r.passed,
            total: r.total,
            tests: runTests(r.results),
          })),
      };
    });

    const groups = new Map<
      string,
      { kind: RecordingKind; segment: number; startedAt: Date; durationMs: number }
    >();
    for (const c of chunks) {
      const kind = c.stream as RecordingKind;
      const id = recordingId(kind, c.segment);
      const g = groups.get(id);
      if (!g) {
        groups.set(id, {
          kind,
          segment: c.segment,
          startedAt: c.startedAt,
          durationMs: c.durationMs,
        });
      } else {
        g.durationMs += c.durationMs;
        if (c.startedAt < g.startedAt) g.startedAt = c.startedAt;
      }
    }

    return {
      session: {
        id: session.id,
        status: session.status,
        startedAt: iso(session.startedAt),
        submittedAt: iso(session.submittedAt),
        totalScore: num(session.totalScore),
        riskScore: session.riskScore,
      },
      candidate: { name: candidate?.fullName ?? '', email: candidate?.email ?? '' },
      test: { title: test?.name ?? '' },
      answers,
      events: events.map((e) => ({
        id: e.id.toString(),
        at: e.occurredAt.toISOString(),
        type: e.type,
        severity: e.severity,
        detail: eventDetail(e.durationMs, e.confidence === null ? null : Number(e.confidence)),
        flagId: e.flagDecision?.id ?? null,
      })),
      recordings: [...groups.entries()].map(([id, g]) => ({
        id,
        kind: g.kind,
        startedAt: g.startedAt.toISOString(),
        durationMs: g.durationMs,
      })),
      verdict: review
        ? { verdict: review.verdict, notes: review.notes, completedAt: iso(review.completedAt) }
        : null,
    };
  }

  // ---- playback -------------------------------------------------------------------------------

  async playback(sessionId: string, rawRecordingId: string): Promise<PlaybackDto> {
    const db = this.prisma.client;
    const parsed = parseRecordingId(rawRecordingId);
    if (!parsed) throw new NotFoundException('Recording not found.');
    const session = await db.session.findFirst({ where: { id: sessionId }, select: { id: true } });
    if (!session) throw new NotFoundException(NOT_FOUND);
    const chunks = await db.mediaChunk.findMany({
      where: {
        sessionId,
        stream: parsed.kind,
        segment: parsed.segment,
        deletedAt: null,
        uploadedAt: { not: null },
        objectKey: { not: null },
      },
      orderBy: { seq: 'asc' },
      take: MAX_PARTS,
      select: { seq: true, durationMs: true, objectKey: true },
    });
    if (chunks.length === 0) throw new NotFoundException('Recording not found.');

    const expiresAt = new Date(Date.now() + PLAYBACK_TTL_SECONDS * 1000);
    const parts: PlaybackDto['parts'] = [];
    for (const c of chunks) {
      if (c.objectKey === null) continue;
      parts.push({
        url: await this.storage.presignGet(
          c.objectKey,
          contentTypeOf(parsed.kind),
          PLAYBACK_TTL_SECONDS,
        ),
        seq: c.seq,
        durationMs: c.durationMs,
      });
    }
    const first = parts[0];
    if (!first) throw new NotFoundException('Recording not found.');
    return {
      url: first.url,
      expiresAt: expiresAt.toISOString(),
      contentType: contentTypeOf(parsed.kind),
      parts,
    };
  }
}
