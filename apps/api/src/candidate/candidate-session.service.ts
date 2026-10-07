// Session reads and the heartbeat (FR-609, ADR 0013 section 5.3) and the proctor key route
// (ADR 0013 sections 2 and 4). Time is the server's: deadlines come from the database and the API
// clock, never from the client (FR-505, TC-047).
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { ConfigService } from '@nestjs/config';
import { CodedHttpException } from '../common/coded.exception';
import type { Env } from '../config/env';
import { PrismaService } from '../database/prisma.service';
import { CandidateScope } from './candidate-scope';
import type { MediaStream, PauseReason, SessionStatus } from '../generated/prisma/enums.js';
import { REDIS_CLIENT } from '../infrastructure/infrastructure.module';
import { ensureConnected } from '../infrastructure/redis-ready';
import {
  effectiveSectionDeadline,
  effectiveSessionDeadline,
  proctorPauseCapMs,
} from '../session/deadlines';
import type { DeadlineSession } from '../session/deadlines';
import { SessionStateConflictError } from '../session/session-state.errors';
import { SessionStateService } from '../session/session-state.service';
import { SessionKeyConfigError, SessionKeyService } from '../session/session-key.service';
import { LIVE_STATUSES, PRE_START_STATUSES } from '../session/session-transitions';
import { sessionNotActive } from '../session/session-write-gate';
import { CandidateTokenService } from './candidate-token.service';
import type { CandidateContext } from './candidate.types';
import { SessionJobsService } from './session-jobs.service';

/** Gate renewals come on the candidate's action or the expiry warning (ADR 0013 section 5.10). */
export const TOKEN_RENEW_LIMIT_PER_MINUTE = 6;
/** Statuses in which the gate renewal route may mint a token (before the test starts). */
const GATE_STATUSES: readonly SessionStatus[] = ['OPENED', 'CONSENTED', 'VERIFIED'];

export interface RenewedToken {
  readonly sessionToken: string;
  readonly sessionTokenExpiresAt: Date;
}

/** Beats arrive every 10 s; 12 per minute per session (ADR 0013 section 5.3). */
export const HEARTBEAT_LIMIT_PER_MINUTE = 12;
const REC_TTL_SECONDS = 600;
const MAX_REC_BYTES = 16 * 1024;
const KEY_ISSUE_GRACE_SECONDS = 3600;
const MEDIA_STREAMS: readonly MediaStream[] = ['SCREEN', 'WEBCAM', 'AUDIO'];

export interface SessionStateView {
  readonly serverTime: Date;
  readonly status: SessionStatus;
  readonly startedAt: Date | null;
  readonly deadlineAt: Date | null;
  readonly sectionDeadlineAt: Date | null;
  readonly pauseReasons: readonly PauseReason[];
}

export interface HeartbeatView extends SessionStateView {
  readonly sessionToken?: string;
  readonly sessionTokenExpiresAt?: Date;
}

export interface ProctorKeyView {
  readonly alg: 'HMAC-SHA256';
  readonly key: string;
  readonly keyEpoch: number;
  readonly counters: {
    readonly eventSeqStart: number;
    readonly keystrokeSeqStart: number;
    readonly media: Record<'SCREEN' | 'WEBCAM' | 'AUDIO', { nextSeq: number; nextSegment: number }>;
  };
}

@Injectable()
export class CandidateSessionService {
  private readonly logger = new Logger(CandidateSessionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: CandidateScope,
    private readonly keys: SessionKeyService,
    private readonly tokens: CandidateTokenService,
    private readonly jobs: SessionJobsService,
    private readonly states: SessionStateService,
    private readonly config: ConfigService<Env, true>,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /** Deadlines as the candidate may see them now: the stored value plus a running proctor pause. */
  private async state(ctx: CandidateContext, now: Date): Promise<SessionStateView> {
    // Candidate scope: the session's own readable columns and its sections (CS-4.4).
    const { session, openSection } = await this.scope.asCandidate(ctx, async () => {
      const row = await this.prisma.client.session.findUnique({
        where: { id: ctx.sessionId },
        select: {
          status: true,
          startedAt: true,
          deadlineAt: true,
          pausedMs: true,
          proctorPausedAt: true,
          pauseReasons: true,
        },
      });
      if (row === null) throw sessionNotActive(ctx.status);
      const section = LIVE_STATUSES.includes(row.status)
        ? await this.prisma.client.sessionSection.findFirst({
            where: { sessionId: ctx.sessionId, startedAt: { not: null }, endedAt: null },
            orderBy: { position: 'asc' },
            select: { startedAt: true, deadlineAt: true },
          })
        : null;
      return { session: row, openSection: section };
    });
    // The org allowance matters only while a proctor pause is running. `organizations.settings` is
    // not readable in candidate scope, so this one read runs in the org scope (after the other).
    let capMs = 0;
    if (session.pauseReasons.includes('PROCTOR')) {
      const org = await this.scope.asOrg(ctx, () =>
        this.prisma.client.organization.findUnique({
          where: { id: ctx.orgId },
          select: { settings: true },
        }),
      );
      capMs = proctorPauseCapMs(org?.settings);
    }
    const deadlineSession: DeadlineSession = session;
    return {
      serverTime: now,
      status: session.status,
      startedAt: session.startedAt,
      deadlineAt: effectiveSessionDeadline(deadlineSession, now, capMs),
      sectionDeadlineAt: openSection
        ? effectiveSectionDeadline(openSection, deadlineSession, now, capMs)
        : null,
      pauseReasons: session.pauseReasons,
    };
  }

  /** GET /candidate/session: the state after a reload, with the server's clock. */
  view(ctx: CandidateContext, now: Date = new Date()): Promise<SessionStateView> {
    return this.state(ctx, now);
  }

  /**
   * POST /candidate/session/heartbeat. One UPDATE by primary key sets last_heartbeat (the guard
   * already proved the session exists in the token's org). A beat after a logged DISCONNECTED
   * queues the RECONNECTED event, because candidate scope cannot write SERVER events directly.
   */
  async heartbeat(
    ctx: CandidateContext,
    body: { recorder?: unknown; queue?: unknown },
    now: Date = new Date(),
  ): Promise<HeartbeatView> {
    if (!LIVE_STATUSES.includes(ctx.status)) throw sessionNotActive(ctx.status);
    // The one write a candidate scope allows on `sessions` (CS-4.4: last_heartbeat only).
    await this.scope.asCandidate(ctx, () =>
      this.prisma.client.session.update({
        where: { id: ctx.sessionId },
        data: { lastHeartbeat: now },
        select: { id: true },
      }),
    );
    await ensureConnected(this.redis);
    // The marker is set by the watchdog when it logs DISCONNECTED; the first beat removes it.
    // Queue RECONNECTED first and remove the marker after: if the queue is down the marker stays
    // and the next beat tries again, so the event is never lost (the job id carries the episode, so
    // a repeat is not written twice).
    const marker = `disc:${ctx.sessionId}`;
    const episode = await this.redis.get(marker);
    if (episode !== null) {
      try {
        await this.jobs.enqueueServerEvent(ctx.sessionId, ctx.orgId, 'RECONNECTED', now, episode);
        await this.redis.del(marker);
      } catch {
        this.logger.warn('RECONNECTED was not queued; the next beat retries');
      }
    }
    await this.storeRecorderSnapshot(ctx.sessionId, body);

    const view = await this.state(ctx, now);
    const ttlMs = this.tokens.ttlSeconds * 1000;
    // Renew when less than half of the lifetime is left, so a token never lapses mid-test.
    if (ctx.tokenExpiresAt.getTime() - now.getTime() < ttlMs / 2) {
      const renewed = this.tokens.sign(
        { sid: ctx.sessionId, oid: ctx.orgId, epoch: ctx.epoch },
        now,
      );
      return { ...view, sessionToken: renewed.token, sessionTokenExpiresAt: renewed.expiresAt };
    }
    return view;
  }

  /**
   * POST /candidate/session/token/renew (ADR 0013 section 5.10, "Renewal is bounded"). The guard
   * already proved the token is unexpired and its epoch current. Here: the session must still be
   * OPENED, CONSENTED or VERIFIED (read fresh, so a start that just happened wins) and
   * now < window_end on this very request, not only through the expiry job. The new token lives
   * min(now + TTL, window_end), so a stolen gate token has a hard ceiling. Once the test runs, the
   * heartbeat renews instead and window_end never limits it.
   */
  async renewToken(ctx: CandidateContext, now: Date = new Date()): Promise<RenewedToken> {
    if (!GATE_STATUSES.includes(ctx.status)) throw sessionNotActive(ctx.status);
    // The invitation is not readable in candidate scope: this read runs in the org scope.
    const { status, windowEnd } = await this.scope.asOrg(ctx, async () => {
      const row = await this.prisma.client.session.findUnique({
        where: { id: ctx.sessionId },
        select: { status: true, invitation: { select: { windowEnd: true } } },
      });
      if (row === null) throw sessionNotActive(ctx.status);
      return { status: row.status, windowEnd: row.invitation.windowEnd };
    });
    if (!GATE_STATUSES.includes(status)) throw sessionNotActive(status);

    // Whole seconds left, rounded down, so the token never outlives window_end. Under one second
    // left there is nothing to mint.
    const secondsLeft = Math.floor((windowEnd.getTime() - now.getTime()) / 1000);
    if (secondsLeft < 1) {
      if (now.getTime() > windowEnd.getTime()) {
        // Same as the start gate (ADR 0002 L-4): the unstarted session is EXPIRED now.
        try {
          await this.scope.asOrg(ctx, () =>
            this.states.transition({
              sessionId: ctx.sessionId,
              from: PRE_START_STATUSES,
              to: 'EXPIRED',
              now,
            }),
          );
        } catch (e) {
          if (!(e instanceof SessionStateConflictError)) throw e;
        }
      }
      throw new CodedHttpException(HttpStatus.CONFLICT, 'This link has expired.', 'LINK_EXPIRED');
    }
    const issued = this.tokens.sign(
      { sid: ctx.sessionId, oid: ctx.orgId, epoch: ctx.epoch },
      now,
      secondsLeft,
    );
    return { sessionToken: issued.token, sessionTokenExpiresAt: issued.expiresAt };
  }

  /** `rec:{sessionId}` holds the latest recorder and queue health for the review (ADR 0013 5.3). */
  private async storeRecorderSnapshot(
    sessionId: string,
    body: { recorder?: unknown; queue?: unknown },
  ): Promise<void> {
    if (body.recorder === undefined && body.queue === undefined) return;
    const json = JSON.stringify({ recorder: body.recorder ?? null, queue: body.queue ?? null });
    if (Buffer.byteLength(json) > MAX_REC_BYTES) return;
    await this.redis.set(`rec:${sessionId}`, json, 'EX', REC_TTL_SECONDS);
  }

  /**
   * POST /candidate/session/proctor-key: K_e for the token's epoch, once (ADR 0013 section 4). The
   * Redis marker `pkey:{sessionId}:{epoch}` is taken with SET NX before the key is derived, so two
   * concurrent calls cannot both receive it. If Redis loses the marker the key can be issued again
   * for that epoch: the ADR records this fail-open risk and leaves a durable marker to its own ADR.
   */
  async proctorKey(ctx: CandidateContext, now: Date = new Date()): Promise<ProctorKeyView> {
    if (!LIVE_STATUSES.includes(ctx.status)) throw sessionNotActive(ctx.status);
    // The wrapped key is not readable in candidate scope (CS-4.4: KeyService under a grant, PR 2):
    // this read stays in the org scope.
    const session = await this.scope.asOrg(ctx, () =>
      this.prisma.client.session.findUnique({
        where: { id: ctx.sessionId },
        select: { hmacKeyEnc: true, deadlineAt: true },
      }),
    );
    if (session === null) throw sessionNotActive(ctx.status);
    if (session.hmacKeyEnc === null || session.deadlineAt === null) {
      throw new CodedHttpException(
        HttpStatus.CONFLICT,
        'No proctor key exists for this session.',
        'KEY_UNAVAILABLE',
      );
    }

    // TTL lasts until deadline + ingest grace + 1 h (ADR 0013 section 2); a proctor-pause credit
    // re-sets it later (BE-13).
    const grace = this.config.get('PROCTOR_INGEST_GRACE_SECONDS', { infer: true });
    const ttl = Math.max(
      KEY_ISSUE_GRACE_SECONDS,
      Math.ceil((session.deadlineAt.getTime() - now.getTime()) / 1000) +
        grace +
        KEY_ISSUE_GRACE_SECONDS,
    );
    const marker = `pkey:${ctx.sessionId}:${String(ctx.epoch)}`;
    await ensureConnected(this.redis);
    const claimed = await this.redis.set(marker, '1', 'EX', ttl, 'NX');
    if (claimed !== 'OK') {
      throw new CodedHttpException(
        HttpStatus.CONFLICT,
        'The key for this sign-in was already issued. Sign in again with the code to get a new one.',
        'KEY_ALREADY_ISSUED',
      );
    }

    let key: Buffer;
    try {
      key = this.keys.batchKeyFor(session.hmacKeyEnc, ctx.sessionId, ctx.epoch);
    } catch (e) {
      // Nothing was handed out: give the marker back so the client can retry.
      await this.redis.del(marker).catch(() => undefined);
      if (e instanceof SessionKeyConfigError) {
        throw new CodedHttpException(
          HttpStatus.SERVICE_UNAVAILABLE,
          'The candidate portal is not configured.',
          'CANDIDATE_PORTAL_UNCONFIGURED',
        );
      }
      throw e;
    }
    try {
      const counters = await this.scope.asCandidate(ctx, () => this.counters(ctx.sessionId));
      return { alg: 'HMAC-SHA256', key: key.toString('base64'), keyEpoch: ctx.epoch, counters };
    } catch (e) {
      await this.redis.del(marker).catch(() => undefined);
      throw e;
    } finally {
      key.fill(0);
    }
  }

  /** Where a new device must continue each sequence (ADR 0013 section 2, "Sequence numbers"). */
  private async counters(sessionId: string): Promise<ProctorKeyView['counters']> {
    const [events, keystrokes, chunks] = await Promise.all([
      this.prisma.client.proctorEventBatch.aggregate({ where: { sessionId }, _max: { seq: true } }),
      this.prisma.client.keystrokeBatch.aggregate({ where: { sessionId }, _max: { seq: true } }),
      this.prisma.client.mediaChunk.groupBy({
        by: ['stream'],
        where: { sessionId, stream: { in: [...MEDIA_STREAMS] } },
        _max: { seq: true, segment: true },
      }),
    ]);
    const media = { SCREEN: ZERO, WEBCAM: ZERO, AUDIO: ZERO } as Record<
      'SCREEN' | 'WEBCAM' | 'AUDIO',
      { nextSeq: number; nextSegment: number }
    >;
    for (const row of chunks) {
      if (row.stream === 'SCREEN' || row.stream === 'WEBCAM' || row.stream === 'AUDIO') {
        media[row.stream] = {
          nextSeq: (row._max.seq ?? -1) + 1,
          nextSegment: (row._max.segment ?? -1) + 1,
        };
      }
    }
    return {
      eventSeqStart: (events._max.seq ?? -1) + 1,
      keystrokeSeqStart: (keystrokes._max.seq ?? -1) + 1,
      media,
    };
  }
}

const ZERO = { nextSeq: 0, nextSegment: 0 } as const;
