// SessionStateService: the only code that writes `sessions.status` (ADR 0001 F2, ADR 0002, ADR 0013
// CS-4.4a). Every other module asks it for a transition. A grep test (status-writers.spec.ts) fails
// when any other file writes the column.
//
// Race safety: a transition is one conditional UPDATE (`WHERE id = $1 AND status = $from`). Two
// callers racing for the same move cannot both win, and a caller that lost reads the actual state
// and gets 409 SESSION_STATE_CONFLICT. There is no read-then-write window.
import { Injectable } from '@nestjs/common';
import type { PauseReason, SessionStatus } from '../generated/prisma/enums.js';
import { PrismaService } from '../database/prisma.service';
import type { OrgScopedPrismaClient } from '../database/org-scope.extension';
import { IllegalTransitionError, SessionStateConflictError } from './session-state.errors';
import {
  isAllowedTransition,
  stampsRetentionAnchor,
  stampsSubmittedAt,
} from './session-transitions';

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
  /** The transaction client, when the status change belongs to a larger unit of work. */
  readonly db?: SessionDb;
}

@Injectable()
export class SessionStateService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Creates the session of a new invitation in INVITED (ADR 0002 Q-01 option a). BE-06 calls it in
   * the invitation's transaction; it is the only place a session row is born.
   */
  async createInvited(
    input: { orgId: string; invitationId: string },
    db: SessionDb = this.prisma.client,
  ): Promise<{ id: string }> {
    const row = await db.session.create({
      data: { orgId: input.orgId, invitationId: input.invitationId, status: 'INVITED' },
      select: { id: true },
    });
    return row;
  }

  /**
   * Moves a session along an edge of the transition table. Throws IllegalTransitionError (409
   * ILLEGAL_TRANSITION) for an edge that is not in the table, and SessionStateConflictError (409
   * SESSION_STATE_CONFLICT) when the session was not in `from` at the moment of the update.
   */
  async transition(request: TransitionRequest): Promise<void> {
    const froms = Array.isArray(request.from)
      ? (request.from as readonly SessionStatus[])
      : [request.from as SessionStatus];
    if (froms.length === 0) throw new Error('transition needs at least one from-state');
    for (const from of froms) {
      if (!isAllowedTransition(from, request.to))
        throw new IllegalTransitionError(from, request.to);
    }
    const db = request.db ?? this.prisma.client;
    const now = request.now ?? new Date();
    const patch = request.patch ?? {};
    const anchors = stampsRetentionAnchor(request.to) && !froms.includes('APPEALED');

    const updated = await db.session.updateMany({
      where: { id: request.sessionId, status: { in: [...froms] } },
      data: {
        status: request.to,
        ...(stampsSubmittedAt(request.to) ? { submittedAt: now } : {}),
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
      where: { id: request.sessionId },
      select: { status: true },
    });
    throw new SessionStateConflictError(current?.status ?? null);
  }
}
