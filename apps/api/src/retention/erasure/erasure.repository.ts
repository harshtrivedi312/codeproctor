// The database touchpoints of erasure on request (ADR 0004 9.5, rule R-6 as amended; C-06, C-17).
// Selection runs in `runSystem('RETENTION_ERASURE')` with one reviewed raw query (ids only). Everything
// else runs in a plain `runInOrg(orgId)` through the org-scoped client: scalar columns only, no nested
// writes, no `orgId` or scope FK in an update, no `sessions` row deleted and no `sessions.status`
// written (the fence is BE-07's SessionStateService, behind SessionFencePort). The per-candidate
// advisory lock is the first lock of every transaction here (ADR 0004 9.4), and the consent record
// is never touched (C-17: it lives until R-9).
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Prisma } from '../../generated/prisma/client.js';
import { OrgContextService, PrismaService } from '../../database';
import { reduceAccommodations, reduceWaiverOnly } from '../accommodations';
import {
  ERASURE_AUDIT_ACTIONS,
  ERASURE_RESERVED_ACTIONS,
  SESSION_ENTITY_TYPE,
} from '../retention.constants';
import { RetentionRepository } from '../retention.repository';
import type { Tx } from '../retention.repository';

export interface RequestedErasure {
  readonly candidateId: string;
  readonly orgId: string;
}

export interface ErasureSessionRow {
  readonly id: string;
  readonly status: string;
  readonly hasOpenAppeal: boolean;
}

export interface ErasureCandidateRow {
  readonly erasureRequestedAt: Date | null;
  readonly erasedAt: Date | null;
}

/** `settings.erasure.holdWhileReviewOrAppealOpen`: a boolean, default true; anything else fails toward the hold. */
const holdSchema = z.object({
  erasure: z.object({ holdWhileReviewOrAppealOpen: z.boolean() }),
});

const safeAction = (action: string): Prisma.Sql => {
  if (!/^[A-Z_]+$/.test(action)) throw new Error('unsafe audit action');
  return Prisma.raw(`'${action}'`);
};

/** The request id (ADR 0004 9.5): the candidate and the epoch seconds of the request. Needs no DDL. */
export const requestIdOf = (candidateId: string, requestedAt: Date): string =>
  `${candidateId}_${Math.floor(requestedAt.getTime() / 1000)}`;

@Injectable()
export class ErasureRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orgContext: OrgContextService,
    private readonly retentionRepo: RetentionRepository,
  ) {}

  inOrg<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
    return this.orgContext.runInOrg(orgId, fn);
  }

  /**
   * Candidates with an erasure request that are not yet anonymised, or whose request has no completion
   * row. A completed request whose candidate is still named is listed: the notice, the day-25 alert and
   * the day-28 anonymisation need later runs. Selection only.
   */
  findRequested(limit: number, afterId?: string): Promise<RequestedErasure[]> {
    const completed = safeAction(ERASURE_RESERVED_ACTIONS.COMPLETED);
    const after = afterId ? Prisma.sql`AND c.id > ${afterId}::uuid` : Prisma.empty;
    return this.orgContext.runSystem('RETENTION_ERASURE', () =>
      this.orgContext.runRawSql('erasure request selection (ADR 0004 9.5)', async () => {
        return this.prisma.client.$queryRaw<RequestedErasure[]>(Prisma.sql`
          SELECT c.id AS "candidateId", c.org_id AS "orgId"
          FROM candidates c
          WHERE c.erasure_requested_at IS NOT NULL
            AND (c.erased_at IS NULL OR NOT EXISTS (
              SELECT 1 FROM audit_logs a
              WHERE a.action = ${completed} AND a.org_id = c.org_id
                AND a.metadata->>'requestId' = c.id::text || '_' || floor(extract(epoch FROM c.erasure_requested_at))::bigint::text))
            ${after}
          ORDER BY c.id
          LIMIT ${limit}`);
      }),
    );
  }

  /** Sets the request time, once: a second request keeps the first (idempotent). Returns the stored time. */
  async markRequested(args: {
    orgId: string;
    candidateId: string;
    now: Date;
    actorId: string;
  }): Promise<Date | null> {
    const { orgId, candidateId, now, actorId } = args;
    return this.prisma.client.$transaction(async (tx) => {
      await this.retentionRepo.candidateLock(tx, candidateId);
      const candidate = await tx.candidate.findUnique({
        where: { id: candidateId },
        select: { erasureRequestedAt: true },
      });
      if (candidate === null) return null;
      if (candidate.erasureRequestedAt !== null) return candidate.erasureRequestedAt;
      await tx.candidate.update({
        where: { id: candidateId },
        data: { erasureRequestedAt: now },
        select: { id: true },
      });
      await tx.auditLog.create({
        data: {
          orgId,
          actorId,
          action: ERASURE_AUDIT_ACTIONS.REQUESTED,
          entityType: 'candidate',
          entityId: candidateId,
          metadata: { requestId: requestIdOf(candidateId, now) },
        },
      });
      return now;
    });
  }

  readCandidate(candidateId: string): Promise<ErasureCandidateRow | null> {
    return this.prisma.client.candidate.findUnique({
      where: { id: candidateId },
      select: { erasureRequestedAt: true, erasedAt: true },
    });
  }

  /** The org's hold switch: default true, and any invalid value counts as true (fail toward the hold). */
  async holdEnabled(orgId: string): Promise<boolean> {
    const org = await this.prisma.client.organization.findUnique({
      where: { id: orgId },
      select: { settings: true },
    });
    const parsed = holdSchema.safeParse(org?.settings);
    return parsed.success ? parsed.data.erasure.holdWhileReviewOrAppealOpen : true;
  }

  /** The candidate's sessions with what the hold needs: status and whether an appeal is open. */
  async sessionsOf(candidateId: string): Promise<ErasureSessionRow[]> {
    const sessions = await this.prisma.client.session.findMany({
      where: { invitation: { candidateId } },
      select: { id: true, status: true },
      orderBy: { createdAt: 'asc' },
    });
    if (sessions.length === 0) return [];
    const open = await this.prisma.client.appeal.findMany({
      where: { status: 'OPEN', sessionReview: { sessionId: { in: sessions.map((s) => s.id) } } },
      select: { sessionReview: { select: { sessionId: true } } },
    });
    const withOpen = new Set(open.map((a) => a.sessionReview.sessionId));
    return sessions.map((s) => ({ id: s.id, status: s.status, hasOpenAppeal: withOpen.has(s.id) }));
  }

  /**
   * When the last review or appeal of the candidate's sessions closed: the later of the newest review
   * completion and the newest appeal resolution. The C-06 deadline counts from the request or from
   * this, whichever is later. Null when nothing ever held the erasure.
   */
  async holdClosedAt(candidateId: string): Promise<Date | null> {
    const reviews = await this.prisma.client.sessionReview.aggregate({
      where: { session: { invitation: { candidateId } } },
      _max: { completedAt: true },
    });
    const appeals = await this.prisma.client.appeal.aggregate({
      where: { sessionReview: { session: { invitation: { candidateId } } } },
      _max: { resolvedAt: true },
    });
    const times = [reviews._max.completedAt, appeals._max.resolvedAt].filter(
      (t): t is Date => t !== null,
    );
    return times.length === 0 ? null : new Date(Math.max(...times.map((t) => t.getTime())));
  }

  /** True if an audit row of this action exists for the request id (ids only: the request id lives in metadata). */
  async hasAudit(action: string, requestId: string, candidateId: string): Promise<boolean> {
    const row = await this.prisma.client.auditLog.findFirst({
      where: {
        action,
        metadata: { path: ['requestId'], equals: requestId },
        entityId: { in: [candidateId, requestId] },
      },
      select: { id: true },
    });
    return row !== null;
  }

  async isCompleted(requestId: string, candidateId: string): Promise<boolean> {
    return this.hasAudit(ERASURE_RESERVED_ACTIONS.COMPLETED, requestId, candidateId);
  }
  async emailSent(requestId: string, candidateId: string): Promise<boolean> {
    return this.hasAudit(ERASURE_RESERVED_ACTIONS.EMAIL_SENT, requestId, candidateId);
  }
  async noticeRecorded(requestId: string, candidateId: string): Promise<boolean> {
    return this.hasAudit(ERASURE_RESERVED_ACTIONS.NOTICE_RECORDED, requestId, candidateId);
  }

  /** Has this once-only ids-only audit row (delay notified, alert raised) been written for the request and `since`? */
  async onceDone(
    args: { candidateId: string; requestId: string; action: string; since?: string },
    db: Pick<Tx, 'auditLog'> = this.prisma.client,
  ): Promise<boolean> {
    const { candidateId, requestId, action, since } = args;
    const row = await db.auditLog.findFirst({
      where: {
        action,
        entityId: candidateId,
        AND: [
          { metadata: { path: ['requestId'], equals: requestId } },
          ...(since === undefined ? [] : [{ metadata: { path: ['since'], equals: since } }]),
        ],
      },
      select: { id: true },
    });
    return row !== null;
  }

  /** Writes the once-only row, after the side effect it records succeeded (so a failure retries). */
  async writeOnce(args: {
    orgId: string;
    candidateId: string;
    requestId: string;
    action: string;
    since?: string;
    actorId?: string | null;
  }): Promise<void> {
    const { orgId, candidateId, requestId, action, since, actorId = null } = args;
    await this.prisma.client.$transaction(async (tx) => {
      await this.retentionRepo.candidateLock(tx, candidateId);
      if (await this.onceDone({ candidateId, requestId, action, since }, tx)) return;
      await tx.auditLog.create({
        data: {
          orgId,
          actorId,
          action,
          entityType: 'candidate',
          entityId: candidateId,
          metadata: since === undefined ? { requestId } : { requestId, since },
        },
      });
    });
  }

  /** A manual notice (SUPER_ADMIN), audited, once per request. */
  async recordNotice(args: {
    orgId: string;
    candidateId: string;
    requestId: string;
    actorId: string;
  }): Promise<void> {
    await this.writeOnce({ ...args, action: ERASURE_RESERVED_ACTIONS.NOTICE_RECORDED });
  }

  /**
   * The fence time of a session for this request, written once (metadata `fencedAt`). A session that
   * was fenced elsewhere and has no row yet gets `now`, the latest possible time: completion only
   * waits longer. Returns the stored time.
   */
  async fenceTime(args: {
    orgId: string;
    candidateId: string;
    sessionId: string;
    requestId: string;
    now: Date;
  }): Promise<Date> {
    const { orgId, candidateId, sessionId, requestId, now } = args;
    return this.prisma.client.$transaction(async (tx) => {
      await this.retentionRepo.candidateLock(tx, candidateId);
      const existing = await tx.auditLog.findFirst({
        where: {
          action: ERASURE_RESERVED_ACTIONS.FENCED,
          entityId: sessionId,
          entityType: SESSION_ENTITY_TYPE,
          actorId: null,
          metadata: { path: ['requestId'], equals: requestId },
        },
        orderBy: { createdAt: 'asc' },
        select: { metadata: true },
      });
      const stored = (existing?.metadata as { fencedAt?: unknown } | null)?.fencedAt;
      if (typeof stored === 'string' && !Number.isNaN(Date.parse(stored))) return new Date(stored);
      await tx.auditLog.create({
        data: {
          orgId,
          actorId: null,
          action: ERASURE_RESERVED_ACTIONS.FENCED,
          entityType: SESSION_ENTITY_TYPE,
          entityId: sessionId,
          metadata: { requestId, fencedAt: now.toISOString() },
        },
      });
      return now;
    });
  }

  /**
   * One ERASED session, after its whole prefix is verified empty (ADR 0004 9.5 step 6): delete the
   * event, batch, keystroke, media and identity rows (WAIVED included; flag decisions cascade); blank
   * submissions (`source_code` '', `results` '[]') and the answers; null review notes and the scoring
   * note; blank the appeals (`reason` 'Erased', no resolution note) but keep them; clear device_info and
   * report_key; reduce the accommodations (OQ-12). Scores, verdicts and the session row STAY: they are
   * anonymised by R-10 at the anchor + 1 year, or with the candidate (C-06). Idempotent. Returns false
   * unless the session is ERASED (the fence went first).
   */
  purgeSession(args: {
    orgId: string;
    candidateId: string;
    sessionId: string;
    requestId: string;
    reduceAll: boolean;
  }): Promise<boolean> {
    const { orgId, candidateId, sessionId, requestId, reduceAll } = args;
    return this.prisma.client.$transaction(async (tx) => {
      await this.retentionRepo.candidateLock(tx, candidateId);
      const session = await tx.session.findUnique({
        where: { id: sessionId },
        select: { status: true },
      });
      if (session === null || session.status !== 'ERASED') return false;
      // One table order in every retention transaction (proctor_events first), against deadlocks.
      await tx.proctorEvent.deleteMany({ where: { sessionId } });
      await tx.proctorEventBatch.deleteMany({ where: { sessionId } });
      await tx.keystrokeBatch.deleteMany({ where: { sessionId } });
      await tx.mediaChunk.deleteMany({ where: { sessionId } });
      await tx.identityCheck.deleteMany({ where: { sessionId } });
      await tx.submission.updateMany({
        where: { sessionQuestion: { sessionId } },
        data: { sourceCode: '', results: [] },
      });
      await tx.sessionQuestion.updateMany({
        where: { sessionId },
        data: { finalCode: null, answer: Prisma.DbNull, scoringNote: null },
      });
      await tx.sessionReview.updateMany({ where: { sessionId }, data: { notes: null } });
      await tx.appeal.updateMany({
        where: { sessionReview: { sessionId } },
        data: { reason: 'Erased', resolutionNote: null },
      });
      await tx.session.update({
        where: { id: sessionId },
        data: { deviceInfo: {}, reportKey: null },
        select: { id: true },
      });
      await this.retentionRepo.casAccommodations(
        tx,
        sessionId,
        reduceAll ? reduceAccommodations : reduceWaiverOnly,
      );
      await tx.auditLog.create({
        data: {
          orgId,
          actorId: null,
          action: ERASURE_AUDIT_ACTIONS.SESSION_PURGED,
          entityType: SESSION_ENTITY_TYPE,
          entityId: sessionId,
          metadata: { requestId },
        },
      });
      return true;
    });
  }

  /** Nothing of the session's personal content remains in the rows (the check before ERASURE_COMPLETED). */
  async isPurged(sessionId: string): Promise<boolean> {
    const c = this.prisma.client;
    const counts = await Promise.all([
      c.proctorEvent.count({ where: { sessionId } }),
      c.proctorEventBatch.count({ where: { sessionId } }),
      c.keystrokeBatch.count({ where: { sessionId } }),
      c.mediaChunk.count({ where: { sessionId } }),
      c.identityCheck.count({ where: { sessionId } }),
      c.submission.count({
        where: {
          sessionQuestion: { sessionId },
          OR: [{ sourceCode: { not: '' } }, { NOT: { results: { equals: [] } } }],
        },
      }),
      c.sessionQuestion.count({
        where: {
          sessionId,
          OR: [
            { finalCode: { not: null } },
            { scoringNote: { not: null } },
            { NOT: { answer: { equals: Prisma.DbNull } } },
          ],
        },
      }),
      c.sessionReview.count({ where: { sessionId, notes: { not: null } } }),
      c.appeal.count({
        where: {
          sessionReview: { sessionId },
          OR: [{ reason: { not: 'Erased' } }, { resolutionNote: { not: null } }],
        },
      }),
      c.session.count({
        where: {
          id: sessionId,
          OR: [{ reportKey: { not: null } }, { NOT: { deviceInfo: { equals: {} } } }],
        },
      }),
    ]);
    return counts.every((n) => n === 0);
  }

  /**
   * ERASURE_COMPLETED for this request, once, only when EVERY session of the candidate is ERASED and
   * verified (the caller checked); it never writes a RETENTION_*_DONE marker. Returns false if it was
   * already written.
   */
  async recordCompleted(args: {
    orgId: string;
    candidateId: string;
    requestId: string;
  }): Promise<boolean> {
    const { orgId, candidateId, requestId } = args;
    return this.prisma.client.$transaction(async (tx) => {
      await this.retentionRepo.candidateLock(tx, candidateId);
      const existing = await tx.auditLog.findFirst({
        where: {
          action: ERASURE_RESERVED_ACTIONS.COMPLETED,
          entityId: candidateId,
          metadata: { path: ['requestId'], equals: requestId },
        },
        select: { id: true },
      });
      if (existing !== null) return false;
      await tx.auditLog.create({
        data: {
          orgId,
          actorId: null,
          action: ERASURE_RESERVED_ACTIONS.COMPLETED,
          entityType: 'candidate',
          entityId: candidateId,
          metadata: { requestId },
        },
      });
      return true;
    });
  }

  /** Anonymises the candidate row in place (ADR 0004 9.5 step 9) and writes one ids-only audit row. */
  async anonymiseCandidate(args: {
    orgId: string;
    candidateId: string;
    requestId: string;
    now: Date;
  }): Promise<boolean> {
    const { orgId, candidateId, requestId, now } = args;
    return this.prisma.client.$transaction(async (tx) => {
      await this.retentionRepo.candidateLock(tx, candidateId);
      const candidate = await tx.candidate.findUnique({
        where: { id: candidateId },
        select: { erasedAt: true },
      });
      if (candidate === null || candidate.erasedAt !== null) return false;
      await tx.candidate.update({
        where: { id: candidateId },
        data: {
          email: `erased+${candidateId}@invalid`,
          fullName: 'Erased',
          externalRef: null,
          erasedAt: now,
        },
        select: { id: true },
      });
      await tx.auditLog.create({
        data: {
          orgId,
          actorId: null,
          action: 'CANDIDATE_ANONYMISED',
          entityType: 'candidate',
          entityId: candidateId,
          metadata: { requestId },
        },
      });
      return true;
    });
  }
}
