// The `verify-session` job: CONSENTED to VERIFIED (ADR 0002 section 2, ADR 0013 CS-4.7). The system
// check, identity and room-scan routes (BE-08b, BE-10, Integrity B) call `enqueueVerifySession`
// when their step is done; this job re-checks every condition itself and makes the change, once,
// through SessionStateService, inside the locked transaction of SessionJobProcessor.
//
//   payload   { orgId, sessionId } and nothing else (ids only, lower-cased once)
//   who       enqueueVerifySession accepts a caller only inside the candidate (or session-job) scope
//             of THE SAME org and session: the ids come from the verified token's scope, never from
//             a request, so nobody can verify another session or another org's session
//   jobId     verify-session_{sessionId}_{n}, n = INCR of the Redis counter `vs:{sessionId}` (TTL 24 h)
//             (ADR 0013 CS-4.7). BullMQ refuses ':' in custom ids in some versions, so the separator
//             is '_' and the ADR's colon form is not used (the ADR's open spike).
//   debounce  a 2 s delay and deduplication { id: verify-session_{sessionId}, ttl 5 s, extend,
//             replace }: a burst (up to 60 room-scan confirms a minute) is one run, and the enqueue
//             that completes the conditions replaces the pending one instead of being dropped. When
//             a run starts its deduplication key is removed, so an enqueue that arrives while it is
//             active schedules a fresh run and is never lost.
//   result    CONSENTED and every condition met: VERIFIED. VERIFIED: no-op success (idempotent).
//             Conditions not met, any other status, an erased or missing session: dropped, logged
//             with ids and condition names only.
import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import { Queue, UnrecoverableError, Worker, type Job } from 'bullmq';
import { z } from 'zod';
import type { Env } from '../config/env';
import { OrgContextService } from '../database/org-context';
import { PrismaService } from '../database/prisma.service';
import { REDIS_CLIENT } from '../infrastructure/infrastructure.module';
import { ensureConnected } from '../infrastructure/redis-ready';
import { bullConnection } from './bull-connection';
import { SessionJobProcessor } from './session-job.processor';
import { SessionStateConflictError } from './session-state.errors';
import { SessionStateService } from './session-state.service';
import { VerifyConditionsPort } from './verify-conditions.port';

export const VERIFY_SESSION_QUEUE = 'verify-session';
export const VERIFY_SESSION_JOB = 'verify-session';

const payload = z.strictObject({
  orgId: z.guid().transform((v) => v.toLowerCase()),
  sessionId: z.guid().transform((v) => v.toLowerCase()),
});
const DEBOUNCE_DELAY_MS = 2_000;
const DEBOUNCE_TTL_MS = 5_000;
const COUNTER_TTL_SECONDS = 86_400;

/** An enqueue from outside the session's own scope. A coding error, never retried. */
export class VerifyEnqueueScopeError extends Error {
  constructor() {
    super('verify-session may be enqueued only from the candidate scope of that same session');
    this.name = 'VerifyEnqueueScopeError';
  }
}

export type VerifyOutcome = 'VERIFIED' | 'ALREADY_VERIFIED' | 'DROPPED';

@Injectable()
export class VerifySessionJobs
  extends SessionJobProcessor
  implements OnModuleInit, OnApplicationShutdown
{
  protected readonly logger = new Logger(VerifySessionJobs.name);
  private queue: Queue | undefined;
  private worker: Worker | undefined;

  constructor(
    private readonly config: ConfigService<Env, true>,
    prisma: PrismaService,
    orgContext: OrgContextService,
    private readonly states: SessionStateService,
    private readonly conditions: VerifyConditionsPort,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {
    super(prisma, orgContext, states);
  }

  onModuleInit(): void {
    const connection = bullConnection(this.config.get('REDIS_URL', { infer: true }));
    this.queue = new Queue(VERIFY_SESSION_QUEUE, { connection });
    this.queue.on('error', () => this.logger.warn('verify-session queue connection error'));
    this.worker = new Worker(VERIFY_SESSION_QUEUE, (job) => this.onJob(job), {
      connection,
      concurrency: 5,
    });
    this.worker.on('error', () => this.logger.warn('verify-session worker connection error'));
    this.worker.on('failed', (job, err) => {
      // The session id and the error class only: never the message, a payload or a stack.
      const ids = payload.safeParse(job?.data);
      const sid = ids.success ? ids.data.sessionId : 'unknown';
      this.logger.warn(
        `verify-session failed: session ${sid} (${err.name}, attempt ${String(job?.attemptsMade ?? 0)})`,
      );
    });
  }

  async onApplicationShutdown(): Promise<void> {
    // Bounded: with Redis down a graceful close would wait for ever.
    const bounded = (close: Promise<void> | undefined): Promise<unknown> =>
      close === undefined
        ? Promise.resolve()
        : Promise.race([close, new Promise((resolve) => setTimeout(resolve, 3_000).unref())]);
    await Promise.allSettled([bounded(this.worker?.close()), bounded(this.queue?.close())]);
  }

  /**
   * Queue a CONSENTED to VERIFIED check for one session. Callable only inside the candidate (or
   * session-job) scope of that same org and session: BE-08b, BE-10 and Integrity B call it from
   * their route, in the guard's scope, with the ids of the verified token. Safe to call many times.
   *
   * Call it AFTER the transaction that completed the condition has committed (the job reads the
   * committed rows under its own lock; an enqueue before the commit can run first and drop). The
   * ADR 0013 CS-4.7 wording "re-enqueues itself if any changed during the run" is met differently:
   * the run frees its deduplication key when it starts, so a change that arrives during the run
   * enqueues a fresh run instead of being absorbed. The 2 s debounce with replace and extend can
   * postpone a run while enqueues keep arriving; that is bounded by the route rate limit (60 room
   * scan confirms a minute).
   */
  async enqueueVerifySession(orgId: string, sessionId: string): Promise<void> {
    const ids = payload.parse({ orgId, sessionId });
    const scope = this.currentScope();
    if (
      scope?.kind !== 'org' ||
      scope.session === undefined ||
      scope.orgId !== ids.orgId ||
      scope.session.sessionId !== ids.sessionId
    ) {
      throw new VerifyEnqueueScopeError();
    }
    if (this.queue === undefined) throw new Error('The verify-session queue is not started');
    await ensureConnected(this.redis);
    // INCR and the first EXPIRE in one script: a counter never lives without its TTL.
    const n = (await this.redis.eval(
      "local n = redis.call('INCR', KEYS[1]) if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end return n",
      1,
      `vs:${ids.sessionId}`,
      String(COUNTER_TTL_SECONDS),
    )) as number;
    await this.queue.add(VERIFY_SESSION_JOB, ids, {
      jobId: `verify-session_${ids.sessionId}_${String(n)}`,
      delay: DEBOUNCE_DELAY_MS,
      deduplication: {
        id: `verify-session_${ids.sessionId}`,
        ttl: DEBOUNCE_TTL_MS,
        extend: true,
        replace: true,
      },
      attempts: 5,
      backoff: { type: 'exponential', delay: 2_000 },
      removeOnComplete: true,
      // Kept for investigation, for LESS time than the counter lives: once the counter restarts at 1
      // a failed job with the same id must be gone, or the add would be ignored and the enqueue lost.
      removeOnFail: { age: COUNTER_TTL_SECONDS - 3_600, count: 1_000 },
    });
  }

  /** The worker callback: free this job's own deduplication key first, so an enqueue during the run is kept. */
  private async onJob(job: Job): Promise<VerifyOutcome> {
    if (payload.safeParse(job.data).success) {
      // Own key only: it removes the key if it still maps to THIS job.
      await job.removeDeduplicationKey().catch(() => undefined);
    }
    return this.process(job.data);
  }

  /** One job. A bad payload can never become valid: it fails for good (UnrecoverableError). */
  async process(data: unknown): Promise<VerifyOutcome> {
    const parsed = payload.safeParse(data);
    if (!parsed.success) {
      this.logger.warn('verify-session failed for good: the payload is not { orgId, sessionId }');
      throw new UnrecoverableError('Invalid verify-session payload');
    }
    const { orgId, sessionId } = parsed.data;
    const result = await this.withLiveSession(sessionId, orgId, async (tx) => {
      const row = await tx.session.findUnique({
        where: { id: sessionId },
        select: { status: true },
      });
      if (row?.status === 'VERIFIED') return 'ALREADY_VERIFIED' as const;
      if (row?.status !== 'CONSENTED') {
        this.logger.warn(`verify-session dropped: session ${sessionId} is not CONSENTED`);
        return 'DROPPED' as const;
      }
      // Re-check every condition under the lock; the enqueue alone proves nothing.
      const evidence = await this.conditions.evaluate(tx, sessionId);
      if (!evidence.met) {
        this.logger.warn(
          `verify-session dropped: session ${sessionId} conditions not met: ${evidence.unmet.join(',')}`,
        );
        return 'DROPPED' as const;
      }
      try {
        await this.states.transition({
          sessionId,
          from: 'CONSENTED',
          to: 'VERIFIED',
          db: tx,
        });
      } catch (e) {
        // A concurrent writer won the compare-and-set: success if the session is VERIFIED now.
        if (!(e instanceof SessionStateConflictError)) throw e;
        if (e.extensions.sessionStatus !== 'VERIFIED') {
          this.logger.warn(`verify-session dropped: session ${sessionId} moved on`);
          return 'DROPPED' as const;
        }
        return 'ALREADY_VERIFIED' as const;
      }
      return 'VERIFIED' as const;
    });
    if (result.outcome === 'LIVE') return result.value;
    if (result.outcome === 'ERASED') {
      this.logger.warn(`verify-session dropped: session ${sessionId} is erased`);
    }
    return 'DROPPED';
  }
}
