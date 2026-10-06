// BullMQ plumbing for the identity jobs (ADR 0014 3.3, 6.5; design notes section 4). One queue,
// `identity-jobs`, job `face-match`. Payloads carry ids only. Job ids use `_`, never `:`.
//
//   face-match   2 attempts, fixed 2 s. A verified WORKER_BUSY re-delays without using an attempt,
//                at most MAX_BUSY_REDELAYS times. When no retry is left, or the worker failed for
//                good, the row is resolved as MANUAL_REVIEW / MATCH_ERROR (the candidate continues,
//                D-05), so a PENDING row never outlives its job.
//   reconcile    repeatable: a row PENDING for more than 2 minutes with no job gets one again (the
//                same job id, so an existing job is left alone).
// The worker starts after the app is up and never blocks start: with Redis down the API still
// answers /health (the same shutdown handling as the session jobs).
import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DelayedError, Queue, UnrecoverableError, Worker } from 'bullmq';
import type { Job } from 'bullmq';
import { z } from 'zod';
import { bullConnection } from '../candidate/session-jobs.service';
import type { Env } from '../config/env';
import { OrgContextService } from '../database/org-context';
import { PrismaService } from '../database/prisma.service';
import { FaceMatchService } from './face-match.service';
import { FaceMatchQueue } from './identity-ports';
import {
  FACE_MATCH_ATTEMPTS,
  FACE_MATCH_BACKOFF_MS,
  FACE_MATCH_JOB,
  IDENTITY_QUEUE,
  MAX_BUSY_REDELAYS,
  PENDING_RECONCILE_AFTER_MS,
  RECONCILE_EVERY_MS,
} from './identity.constants';
import { IdentityFacts } from './identity-facts';
import { WorkerBusyError, WorkerRetryableError, WorkerUnrecoverableError } from './worker-client';

const uuid = z.guid();
const faceMatchData = z.object({
  orgId: uuid,
  sessionId: uuid,
  attempt: z.number().int().min(1).max(2),
  busy: z.number().int().min(0).optional(),
});

const SHUTDOWN_WAIT_MS = 3_000;
const RECONCILE_BATCH = 200;

@Injectable()
export class IdentityJobsService
  extends FaceMatchQueue
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(IdentityJobsService.name);
  private queue: Queue | undefined;
  private worker: Worker | undefined;
  private retry: NodeJS.Timeout | undefined;
  private closing = false;

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
    private readonly orgContext: OrgContextService,
    private readonly faceMatch: FaceMatchService,
    private readonly facts: IdentityFacts,
  ) {
    super();
  }

  onModuleInit(): void {
    const connection = bullConnection(this.config.get('REDIS_URL', { infer: true }));
    this.queue = new Queue(IDENTITY_QUEUE, { connection });
    this.queue.on('error', () => this.logger.warn('Identity queue connection error'));
    this.worker = new Worker(IDENTITY_QUEUE, (job, token) => this.process(job, token), {
      connection,
      concurrency: 4, // ADR 0014 6.6: the face queue runs 4 at a time against the worker's semaphore
    });
    this.worker.on('error', () => this.logger.warn('Identity worker connection error'));
    this.scheduleReconciler();
  }

  private scheduleReconciler(): void {
    const queue = this.queue;
    if (queue === undefined || this.closing) return;
    void queue
      .upsertJobScheduler(
        'reconcile-pending',
        { every: RECONCILE_EVERY_MS },
        {
          name: 'reconcile-pending',
          data: {},
          opts: { removeOnComplete: true, removeOnFail: true },
        },
      )
      .catch(() => {
        if (this.closing) return;
        this.retry = setTimeout(() => this.scheduleReconciler(), 10_000);
        this.retry.unref();
      });
  }

  async onApplicationShutdown(): Promise<void> {
    this.closing = true;
    if (this.retry) clearTimeout(this.retry);
    const bounded = async (close: Promise<void> | undefined, force: () => Promise<void>) => {
      if (close === undefined) return;
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), SHUTDOWN_WAIT_MS);
      });
      try {
        if ((await Promise.race([close.then(() => 'closed' as const), timeout])) === 'timeout') {
          void force().catch(() => undefined);
        }
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    await Promise.allSettled([
      bounded(this.worker?.close(), () => this.worker?.disconnect() ?? Promise.resolve()),
      bounded(this.queue?.close(), () => this.queue?.disconnect() ?? Promise.resolve()),
    ]);
  }

  private requireQueue(): Queue {
    if (this.queue === undefined) throw new Error('The identity queue is not started');
    return this.queue;
  }

  /** The job id is the idempotency key: adding it again while the job exists is a no-op. */
  async enqueue(orgId: string, sessionId: string, attempt: number): Promise<void> {
    await this.requireQueue().add(
      FACE_MATCH_JOB,
      { orgId, sessionId, attempt },
      {
        jobId: `${FACE_MATCH_JOB}_${sessionId}_${String(attempt)}`,
        attempts: FACE_MATCH_ATTEMPTS,
        backoff: { type: 'fixed', delay: FACE_MATCH_BACKOFF_MS },
        removeOnComplete: { age: 3_600 },
        removeOnFail: { age: 86_400 },
      },
    );
  }

  /** One callback per job; the data is validated before anything is touched. */
  async process(job: Pick<Job, 'name' | 'data'> & Partial<Job>, token?: string): Promise<void> {
    if (job.name === 'reconcile-pending') {
      await this.reconcilePending();
      return;
    }
    if (job.name !== FACE_MATCH_JOB) {
      this.logger.warn('Unknown identity job dropped');
      return;
    }
    const data = faceMatchData.parse(job.data);
    const last = (job.attemptsMade ?? 0) + 1 >= (job.opts?.attempts ?? FACE_MATCH_ATTEMPTS);
    try {
      await this.faceMatch.run(data);
    } catch (e) {
      if (e instanceof WorkerBusyError) {
        const busy = data.busy ?? 0;
        if (busy >= MAX_BUSY_REDELAYS) {
          await this.faceMatch.resolveAsMatchError(data);
          return;
        }
        // Re-delay without using an attempt (ADR 0014 6.4).
        if (job.updateData && job.moveToDelayed && token !== undefined) {
          await job.updateData({ ...data, busy: busy + 1 });
          await job.moveToDelayed(Date.now() + e.retryAfterSeconds * 1000, token);
          throw new DelayedError();
        }
        throw e;
      }
      if (e instanceof WorkerUnrecoverableError) {
        // A key or request mistake no retry can fix: the candidate still continues (D-05).
        await this.faceMatch.resolveAsMatchError(data);
        return;
      }
      if (e instanceof WorkerRetryableError || e instanceof Error) {
        if (last) {
          await this.faceMatch.resolveAsMatchError(data);
          return;
        }
        throw e instanceof WorkerRetryableError ? e : new Error(e.name);
      }
      throw new UnrecoverableError('face-match failed');
    }
  }

  /** Rows PENDING for more than 2 minutes get their job again (same id). Skips waived sessions. */
  async reconcilePending(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - PENDING_RECONCILE_AFTER_MS);
    const stuck = await this.orgContext.runSystem('BACKGROUND_JOB', () =>
      this.prisma.client.identityCheck.findMany({
        where: { status: 'PENDING', createdAt: { lt: cutoff } },
        select: { attempt: true, sessionId: true, session: { select: { orgId: true } } },
        take: RECONCILE_BATCH,
      }),
    );
    let queued = 0;
    for (const row of stuck) {
      const orgId = row.session.orgId;
      const skip = await this.orgContext.runInOrg(orgId, async () => {
        const session = await this.facts.session(row.sessionId);
        if (session === null || session.imagesGone) return true; // erased or face tier run: leave it
        return (await this.facts.policy(row.sessionId)).waived;
      });
      if (skip) continue;
      await this.enqueue(orgId, row.sessionId, row.attempt);
      queued += 1;
    }
    return queued;
  }
}
