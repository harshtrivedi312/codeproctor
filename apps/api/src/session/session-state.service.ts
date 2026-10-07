// SessionStateService: the only code that writes `sessions.status` (ADR 0001 F2, ADR 0002, ADR 0013
// CS-4.4a). Every other module asks it for a transition. A grep test (status-writers.spec.ts) fails
// when any other file writes the column.
//
// Race safety: a transition is one conditional UPDATE (`WHERE id = $1 AND status = $from`). Two
// callers racing for the same move cannot both win, and a caller that lost reads the actual state
// and gets 409 SESSION_STATE_CONFLICT. There is no read-then-write window.
import {
  ForbiddenException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DEFAULT_EVENT_SEVERITY, hasPermission, parseEventPayload } from '@codeproctor/shared';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import { CodedHttpException } from '../common/coded.exception';
import type { Env } from '../config/env';
import { REDIS_CLIENT } from '../infrastructure/infrastructure.module';
import { ensureConnected } from '../infrastructure/redis-ready';
import type { PauseReason, SessionStatus } from '../generated/prisma/enums.js';
import { SessionNotFoundError } from '../database/errors';
import { OrgContextService } from '../database/org-context';
import { PrismaService } from '../database/prisma.service';
import type { OrgScopedPrismaClient } from '../database/org-scope.extension';
import type { Prisma } from '../generated/prisma/client.js';
import {
  guardLive as coreGuardLive,
  lockForAccommodation as coreLockForAccommodation,
  lockAnySession as coreLockAnySession,
} from '../database/session-locks';
import { busyLockToProblem } from './busy-lock';
import { effectiveSectionDeadline, effectiveSessionDeadline, proctorPauseCapMs } from './deadlines';
import { IllegalTransitionError, SessionStateConflictError } from './session-state.errors';
import {
  isAllowedTransition,
  stampsRetentionAnchor,
  stampsSubmittedAt,
} from './session-transitions';

/** The transaction client a session write receives (`prisma.client.$transaction(async (tx) => ...)`). */
export type SessionTx = Parameters<Parameters<OrgScopedPrismaClient['$transaction']>[0]>[0];

/** Either the scoped client or the client a `$transaction` callback receives. */
export type SessionDb = Pick<OrgScopedPrismaClient, 'session'>;

/**
 * Columns a transition may set together with the status, in the same statement. The caller never
 * passes the status, a retention anchor or `submitted_at`: the table decides those.
 */
export interface SessionTransitionPatch {
  readonly startedAt?: Date;
  readonly deadlineAt?: Date;
  readonly hmacKeyEnc?: string;
  readonly pauseReasons?: readonly PauseReason[];
  readonly proctorPausedAt?: Date | null;
  readonly pausedMs?: bigint;
}

export interface TransitionRequest {
  readonly sessionId: string;
  /** The state the caller expects. Several are allowed (for example any pre-start state to EXPIRED). */
  readonly from: SessionStatus | readonly SessionStatus[];
  readonly to: SessionStatus;
  /** Server time of the change. Defaults to now; tests pass a fixed value. Never client time. */
  readonly now?: Date;
  readonly patch?: SessionTransitionPatch;
  /** More compare-and-set conditions of the same UPDATE (a concurrent change makes it lose). */
  readonly alsoWhere?: Pick<Prisma.SessionWhereInput, 'pauseReasons' | 'proctorPausedAt'>;
  /** The transaction client, when the status change belongs to a larger unit of work. */
  readonly db?: SessionDb;
  /**
   * Compare-and-set on the pause reasons the caller read: the update matches only while
   * `pause_reasons` still equals this list, so a reason added meanwhile (a proctor pause) is never
   * overwritten. A miss is SessionStateConflictError, like a lost status race.
   */
  readonly ifPauseReasons?: readonly PauseReason[];
}

@Injectable()
export class SessionStateService {
  private readonly logger = new Logger(SessionStateService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orgContext: OrgContextService,
    private readonly config: ConfigService<Env, true>,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  // The three per-session write locks (ADR 0013 section 5.7, ADR 0006 section 8.5). Thin wrappers over the
  // lock core of Database A (database/session-locks.ts), which only this file imports. The bodies are
  // pinned by lock-call-sites.spec.ts: `return <core>(tx, sessionId);` and nothing else.
  /** guardLive has exactly two callers: SessionJobProcessor.withLiveSession and proctorResume (the one staff caller). */
  guardLive(tx: SessionTx, sessionId: string): Promise<'LIVE' | 'ERASED'> {
    return coreGuardLive(tx, sessionId);
  }

  /** withAnySession only (the erasure-compatible jobs). Answers the status read under the lock. */
  lockAnySession(tx: SessionTx, sessionId: string): Promise<SessionStatus> {
    return coreLockAnySession(tx, sessionId);
  }

  /** The ADR 0015 accommodation writers and the erasure, R-4 and R-10 jobs; never with guardLive. */
  lockForAccommodation(tx: SessionTx, sessionId: string): Promise<SessionStatus> {
    return coreLockForAccommodation(tx, sessionId);
  }

  /**
   * Creates the session of a new invitation in INVITED (ADR 0002 Q-01 option a). BE-06 calls it in
   * the invitation's transaction; it is the only place a session row is born.
   */
  async createInvited(
    ids: { orgId: string; invitationId: string },
    db: SessionDb = this.prisma.client,
  ): Promise<{ id: string }> {
    const row = await db.session.create({
      data: { orgId: ids.orgId, invitationId: ids.invitationId, status: 'INVITED' },
      select: { id: true },
    });
    return row;
  }

  /**
   * Moves a session along an edge of the transition table. Throws IllegalTransitionError (409
   * ILLEGAL_TRANSITION) for an edge that is not in the table, and SessionStateConflictError (409
   * SESSION_STATE_CONFLICT) when the session was not in `from` at the moment of the update.
   */
  async transition(change: TransitionRequest): Promise<void> {
    const froms = Array.isArray(change.from)
      ? (change.from as readonly SessionStatus[])
      : [change.from as SessionStatus];
    if (froms.length === 0) throw new Error('transition needs at least one from-state');
    for (const from of froms) {
      if (!isAllowedTransition(from, change.to)) throw new IllegalTransitionError(from, change.to);
    }
    const db = change.db ?? this.prisma.client;
    const now = change.now ?? new Date();
    const patch = change.patch ?? {};
    const anchors = stampsRetentionAnchor(change.to) && !froms.includes('APPEALED');

    const updated = await db.session.updateMany({
      // AND of the objects: a smuggled `id` or `status` in alsoWhere can only narrow the update.
      where: {
        AND: [
          { id: change.sessionId, status: { in: [...froms] } },
          change.alsoWhere ?? {},
          change.ifPauseReasons !== undefined
            ? { pauseReasons: { equals: [...change.ifPauseReasons] } }
            : {},
        ],
      },
      data: {
        status: change.to,
        ...(stampsSubmittedAt(change.to) ? { submittedAt: now } : {}),
        ...(anchors ? { retentionAnchorAt: now } : {}),
        ...(patch.startedAt !== undefined ? { startedAt: patch.startedAt } : {}),
        ...(patch.deadlineAt !== undefined ? { deadlineAt: patch.deadlineAt } : {}),
        ...(patch.hmacKeyEnc !== undefined ? { hmacKeyEnc: patch.hmacKeyEnc } : {}),
        ...(patch.pauseReasons !== undefined ? { pauseReasons: [...patch.pauseReasons] } : {}),
        ...(patch.proctorPausedAt !== undefined ? { proctorPausedAt: patch.proctorPausedAt } : {}),
        ...(patch.pausedMs !== undefined ? { pausedMs: patch.pausedMs } : {}),
      },
    });
    if (updated.count === 1) return;
    const current = await db.session.findUnique({
      where: { id: change.sessionId },
      select: { status: true },
    });
    throw new SessionStateConflictError(current?.status ?? null);
  }

  /**
   * The proctor resume (ADR 0002 P-3, ADR 0013 section 5.7, FR-903, TC-079): the one STAFF caller of
   * guardLive. Called by the staff /live resume route (BE-13), inside the staff scope; the route
   * carries @Audited, which writes the audit row after a success.
   *
   * In one transaction (5 s Prisma timeout): guardLive first; on ERASED nothing is written, no
   * Redis TTL is reset and 409 SESSION_ERASED is answered. Then the PROCTOR reason is removed and
   * the credit (now - proctor_paused_at, at most what is left of `maxProctorPauseMinutes`) is added
   * to `paused_ms`, `deadline_at` and the open section's `deadline_at`, with the same functions the
   * heartbeat uses (deadlines.ts). With no other pause reason left PAUSED goes to IN_PROGRESS; else
   * the session stays PAUSED. A SERVER event PROCTOR_RESUME is written. After the commit the Redis
   * markers that live until the deadline get their TTL set again (pkey of the current epoch,
   * evidence, etag). A busy lock (SessionLockRetryError, 55P03, 40P01, P2034) is 503 LOCK_BUSY with
   * Retry-After, never 409 or 500.
   */
  async proctorResume(resume: ProctorResumeInput): Promise<ProctorResumeResult> {
    // Only a staff runAsUser scope has a user: this throws in a system, candidate or session-job
    // scope and with no scope. The resuming user is the verified one, never a caller-supplied id.
    const user = this.orgContext.requireUser();
    if (!hasPermission(user.role, 'live:pause')) {
      throw new ForbiddenException('Forbidden.');
    }
    const now = resume.now ?? new Date();
    let committed: { result: ProctorResumeResult; authEpoch: number };
    try {
      committed = await this.prisma.client.$transaction(
        async (tx) => {
          // Bound the wait for the sessions row (the first statement of the transaction; guardLive is
          // the first DATA statement after it) inside this transaction: Prisma's interactive
          // timeout does not cancel a statement that is blocked on a lock (the transaction would
          // hang), and the SERVICE pool's lock_timeout does not apply to a staff transaction. The
          // one raw statement, in the staff scope where the hatch is allowed.
          await this.orgContext.runRawSql(
            'proctor resume: SET LOCAL lock_timeout so a busy sessions row answers 503, not a hang',
            () => tx.$executeRaw`SET LOCAL lock_timeout = '2000ms'`,
          );
          const state = await this.guardLive(tx, resume.sessionId);
          if (state === 'ERASED') {
            throw new CodedHttpException(
              HttpStatus.CONFLICT,
              'This session was erased; nothing was changed.',
              'SESSION_ERASED',
            );
          }
          const session = await tx.session.findUnique({
            where: { id: resume.sessionId },
            select: {
              orgId: true,
              status: true,
              authEpoch: true,
              deadlineAt: true,
              pausedMs: true,
              proctorPausedAt: true,
              pauseReasons: true,
            },
          });
          if (session === null) throw new SessionNotFoundError();
          if (
            session.status !== 'PAUSED' ||
            !session.pauseReasons.includes('PROCTOR') ||
            session.proctorPausedAt === null ||
            session.deadlineAt === null
          ) {
            throw new SessionStateConflictError(session.status);
          }
          const org = await tx.organization.findUnique({
            where: { id: session.orgId },
            select: { settings: true },
          });
          const cap = proctorPauseCapMs(org?.settings);
          const before = effectiveSessionDeadline(session, now, cap) ?? session.deadlineAt;
          const credit = before.getTime() - session.deadlineAt.getTime();
          const pausedMs = session.pausedMs + BigInt(credit);
          const remaining = session.pauseReasons.filter((r) => r !== 'PROCTOR');
          const patch = {
            pauseReasons: remaining,
            proctorPausedAt: null,
            pausedMs,
            deadlineAt: before,
          } satisfies SessionTransitionPatch;
          if (remaining.length === 0) {
            await this.transition({
              sessionId: resume.sessionId,
              from: 'PAUSED',
              to: 'IN_PROGRESS',
              now,
              patch,
              db: tx,
              // Exactly the reasons that were read (this covers PROCTOR), and the same pause.
              alsoWhere: {
                pauseReasons: { equals: [...session.pauseReasons] },
                proctorPausedAt: session.proctorPausedAt,
              },
            });
          } else {
            // A real compare-and-set: the same reasons and the same pause as were read, so a reason
            // added or removed meanwhile is never overwritten.
            const updated = await tx.session.updateMany({
              where: {
                id: resume.sessionId,
                status: 'PAUSED',
                pauseReasons: { equals: [...session.pauseReasons] },
                proctorPausedAt: session.proctorPausedAt,
              },
              data: {
                pauseReasons: [...remaining],
                proctorPausedAt: null,
                pausedMs,
                deadlineAt: before,
              },
            });
            if (updated.count !== 1) throw new SessionStateConflictError(null);
          }
          // The open section gets its own credit (ADR 0002 S-4: only the pause after it opened).
          let sectionDeadlineAt: Date | null = null;
          const open = await tx.sessionSection.findFirst({
            where: { sessionId: resume.sessionId, startedAt: { not: null }, endedAt: null },
            orderBy: { position: 'asc' },
          });
          if (open?.deadlineAt != null) {
            sectionDeadlineAt =
              effectiveSectionDeadline(open, session, now, cap) ?? open.deadlineAt;
            await tx.sessionSection.updateMany({
              where: { sessionId: resume.sessionId, sectionId: open.sectionId, endedAt: null },
              data: { deadlineAt: sectionDeadlineAt },
            });
          }
          await tx.proctorEvent.create({
            data: {
              sessionId: resume.sessionId,
              type: 'PROCTOR_RESUME',
              severity: DEFAULT_EVENT_SEVERITY.PROCTOR_RESUME,
              source: 'SERVER',
              occurredAt: now,
              payload: parseEventPayload('PROCTOR_RESUME', { proctorUserId: user.userId }),
            },
          });
          return {
            result: {
              sessionId: resume.sessionId,
              status: remaining.length === 0 ? ('IN_PROGRESS' as const) : ('PAUSED' as const),
              creditedMs: credit,
              deadlineAt: before,
              sectionDeadlineAt,
            },
            authEpoch: session.authEpoch,
          };
        },
        { timeout: PROCTOR_RESUME_TIMEOUT_MS },
      );
    } catch (e) {
      if (e instanceof SessionNotFoundError) throw new NotFoundException('Not found');
      throw busyLockToProblem(e) ?? e;
    }
    await this.resetDeadlineTtls(
      resume.sessionId,
      committed.authEpoch,
      committed.result.deadlineAt,
      now,
    );
    return committed.result;
  }

  /** ADR 0013 section 2: markers that live until the deadline get their TTL set again. */
  private async resetDeadlineTtls(
    sessionId: string,
    epoch: number,
    deadline: Date,
    now: Date,
  ): Promise<void> {
    const grace = this.config.get('PROCTOR_INGEST_GRACE_SECONDS', { infer: true });
    const ttl = Math.max(60, Math.ceil((deadline.getTime() - now.getTime()) / 1000) + grace + 3600);
    try {
      await ensureConnected(this.redis);
      for (const key of [
        `pkey:${sessionId}:${String(epoch)}`,
        `evidence:${sessionId}`,
        `etag:${sessionId}`,
      ]) {
        await this.redis.expire(key, ttl);
      }
    } catch (e) {
      // Best effort: the resume is committed; a missed TTL is re-set by the next resume or the
      // sweep. Session id and error class only.
      this.logger.warn(
        `proctor resume: Redis TTL not reset for session ${sessionId} (${e instanceof Error ? e.name : 'error'})`,
      );
    }
  }
}

/** A staff resume of a proctor pause. The resuming user comes from the staff scope, not from here. */
export interface ProctorResumeInput {
  readonly sessionId: string;
  readonly now?: Date;
}

export interface ProctorResumeResult {
  readonly sessionId: string;
  readonly status: 'IN_PROGRESS' | 'PAUSED';
  /** Paused time credited to the session and the open section (capped by the org allowance). */
  readonly creditedMs: number;
  readonly deadlineAt: Date;
  readonly sectionDeadlineAt: Date | null;
}

const PROCTOR_RESUME_TIMEOUT_MS = 5_000;
