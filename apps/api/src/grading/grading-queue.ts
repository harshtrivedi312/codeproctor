// Producers for the grading queues (ADR 0013 section 5.11). Two queues:
//   grading-jobs     close-section, auto-submit, grade-session and the repeatable grading-sweep
//   analyze-session  produced here, consumed by BE-12 (nothing consumes it yet; the job waits)
// Job ids use `_`, never `:` (BullMQ), and are built from the session and section ids the server
// resolved, so a repeated enqueue is a single flight. Payloads are ids only: never a code, an answer,
// a token or a key.
import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import type { JobsOptions } from 'bullmq';
import type { Env } from '../config/env';
import { bullConnection } from '../candidate/session-jobs.service';

export const GRADING_QUEUE = 'grading-jobs';
export const ANALYZE_QUEUE = 'analyze-session';
/** In-flight saves from the last seconds land before a section is closed or a session graded. */
export const CLOSE_GRACE_MS = 5_000;
const SHUTDOWN_WAIT_MS = 3_000;

export type CloseVariant = 'finish' | 'deadline' | 'final';

const RETRY: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 5_000 },
  // Removed on completion and on final failure (CS-4.7), so a reconciler re-add is never ignored
  // because a failed job still holds the id. The per-session failure counter bounds the re-adds.
  removeOnComplete: true,
  removeOnFail: true,
};

@Injectable()
export class GradingQueue implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(GradingQueue.name);
  private grading: Queue | undefined;
  private analyze: Queue | undefined;

  constructor(private readonly config: ConfigService<Env, true>) {}

  onModuleInit(): void {
    const connection = bullConnection(this.config.get('REDIS_URL', { infer: true }));
    this.grading = new Queue(GRADING_QUEUE, { connection });
    this.analyze = new Queue(ANALYZE_QUEUE, { connection });
    // An unhandled 'error' event would crash the process; Redis outages are reported by /health.
    this.grading.on('error', () => this.logger.warn('Grading queue connection error'));
    this.analyze.on('error', () => this.logger.warn('Analyze queue connection error'));
  }

  queue(): Queue {
    if (this.grading === undefined) throw new Error('The grading queue is not started');
    return this.grading;
  }

  private analyzeQueue(): Queue {
    if (this.analyze === undefined) throw new Error('The analyze queue is not started');
    return this.analyze;
  }

  async enqueueGrade(orgId: string, sessionId: string, delayMs = CLOSE_GRACE_MS): Promise<void> {
    await this.queue().add(
      'grade-session',
      { orgId, sessionId },
      { ...RETRY, jobId: `grade-session_${sessionId}`, delay: delayMs },
    );
  }

  /** True while a grade-session job for the session is active, waiting, delayed or waiting on children. */
  async hasLiveGradeJob(sessionId: string): Promise<boolean> {
    const job = await this.queue().getJob(`grade-session_${sessionId}`);
    if (job === undefined) return false;
    const state = await job.getState();
    return ['active', 'waiting', 'delayed', 'waiting-children', 'prioritized'].includes(state);
  }

  async enqueueCloseSection(
    orgId: string,
    sessionId: string,
    sectionId: string,
    variant: CloseVariant,
    delayMs = 0,
    idSuffix?: string,
  ): Promise<void> {
    await this.queue().add(
      'close-section',
      { orgId, sessionId, sectionId, variant },
      {
        ...RETRY,
        // One id per variant (CS-4.7): a finish click is never swallowed by a queued deadline job.
        jobId: `close-section_${sessionId}_${sectionId}_${variant}${idSuffix === undefined ? '' : `_${idSuffix}`}`,
        ...(delayMs > 0 ? { delay: delayMs } : {}),
      },
    );
  }

  async enqueueAutoSubmit(orgId: string, sessionId: string, delayMs = 0): Promise<void> {
    await this.queue().add(
      'auto-submit',
      { orgId, sessionId },
      {
        ...RETRY,
        jobId: `auto-submit_${sessionId}`,
        ...(delayMs > 0 ? { delay: delayMs } : {}),
      },
    );
  }

  /** BE-12 consumes it. The job id makes a retried grade-session enqueue it once. */
  async enqueueAnalyze(orgId: string, sessionId: string): Promise<void> {
    await this.analyzeQueue().add(
      'analyze-session',
      { orgId, sessionId },
      { ...RETRY, jobId: `analyze-session_${sessionId}` },
    );
  }

  async onApplicationShutdown(): Promise<void> {
    const queues = [this.grading, this.analyze].filter((q): q is Queue => q !== undefined);
    await Promise.allSettled(
      queues.map(async (q) => {
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), SHUTDOWN_WAIT_MS);
        });
        try {
          if (
            (await Promise.race([q.close().then(() => 'closed' as const), timeout])) === 'timeout'
          ) {
            void q.disconnect().catch(() => undefined);
          }
        } finally {
          if (timer) clearTimeout(timer);
        }
      }),
    );
  }
}
