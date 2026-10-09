// The worker for the grading queue and its repeatable sweep (ADR 0013 section 5.11). Jobs:
//   close-section   close one section (deadline variant from the sweep, final variant from grading)
//   auto-submit     submit a session past its effective deadline, using the latest saved code
//   grade-session   close open sections, grade, SUBMITTED -> GRADED, queue analyze-session
//   grading-sweep   every 15 s: find what is due and queue it (this is the section deadline job, the
//                   session auto-submit job and the grading reconciler in one discovery step)
// The sweep only enqueues, with single-flight job ids; the effective deadline (which a running
// PROCTOR pause pushes out) is re-checked inside each job, so an early pick is a harmless no-op.
// Every payload is parsed with zod before use. Nothing here logs code, answers or tokens.
import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UnrecoverableError, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Job } from 'bullmq';
import { z } from 'zod';
import type { Env } from '../config/env';
import { bullConnection } from '../candidate/session-jobs.service';
import { OrgContextService } from '../database/org-context';
import { PrismaService } from '../database/prisma.service';
import { REDIS_CLIENT } from '../infrastructure/infrastructure.module';
import { ensureConnected } from '../infrastructure/redis-ready';
import { GradingInvariantError, RunnerUnavailableError } from './errors';
import { LIVE_STATUSES } from '../session/session-transitions';
import { CloseSectionService } from './close-section.service';
import { GradeSessionService } from './grade-session.service';
import { CLOSE_GRACE_MS, GRADING_QUEUE, GradingQueue } from './grading-queue';
import { SubmitFlowService } from './submit-flow.service';

const SWEEP_EVERY_MS = 15_000;
const SWEEP_BATCH = 500;
/** A SUBMITTED session not graded after this long has lost its grading job (reconciler, 5.11). */
const STUCK_SUBMITTED_MS = 60_000;
const SHUTDOWN_WAIT_MS = 3_000;
/** After this many failed runs of one job kind for one session the sweep stops re-queuing it (alert). */
export const MAX_JOB_FAILURES = 15;
/** Runner-outage failures are not counted for this long; after it the session is given up. */
export const OUTAGE_CEILING_MS = 6 * 3_600_000;
const SWEEP_MAX_PAGES = 6;
const SWEEP_ALERTS = 50;
const COUNT_SCRIPT = `
local n = redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], ARGV[1])
return n
`;

type JobKind = 'grade' | 'close-section' | 'auto-submit';
const FAILURE_TTL_SECONDS = 7 * 86_400;
/** SUBMITTED for longer than this raises the alert of ADR 0004 9.4 (ADR 0013 5.11). */
const STUCK_ALERT_MS = 3_600_000;
const ALERT_REPEAT_SECONDS = 3_600;

const uuid = z.guid();
const sessionData = z.object({ orgId: uuid, sessionId: uuid });
const closeData = sessionData.extend({
  sectionId: uuid,
  variant: z.enum(['finish', 'deadline', 'final']),
});

@Injectable()
export class GradingWorker implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(GradingWorker.name);
  private worker: Worker | undefined;
  private retry: NodeJS.Timeout | undefined;
  private closing = false;

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
    private readonly orgContext: OrgContextService,
    private readonly queue: GradingQueue,
    private readonly closeSection: CloseSectionService,
    private readonly submitFlow: SubmitFlowService,
    private readonly grading: GradeSessionService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  onModuleInit(): void {
    const connection = bullConnection(this.config.get('REDIS_URL', { infer: true }));
    this.worker = new Worker(GRADING_QUEUE, (job) => this.process(job), {
      connection,
      concurrency: 3,
    });
    this.worker.on('error', () => this.logger.warn('Grading worker connection error'));
    this.worker.on('failed', (job) => {
      // Name and attempt only; the payload is ids, but no job of a candidate session logs its data.
      this.logger.warn(
        `Job ${job?.name ?? '?'} failed (attempt ${String(job?.attemptsMade ?? 0)})`,
      );
    });
    this.scheduleSweep();
  }

  private scheduleSweep(): void {
    if (this.closing) return;
    this.queue
      .queue()
      .upsertJobScheduler(
        'grading-sweep',
        { every: SWEEP_EVERY_MS },
        {
          name: 'grading-sweep',
          data: {},
          opts: { removeOnComplete: true, removeOnFail: true },
        },
      )
      .catch(() => {
        if (this.closing) return;
        this.logger.warn('Could not register the grading sweep; retrying in 10 s');
        this.retry = setTimeout(() => this.scheduleSweep(), 10_000);
        this.retry.unref();
      });
  }

  async onApplicationShutdown(): Promise<void> {
    this.closing = true;
    if (this.retry) clearTimeout(this.retry);
    const worker = this.worker;
    if (worker === undefined) return;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), SHUTDOWN_WAIT_MS);
    });
    try {
      if (
        (await Promise.race([worker.close().then(() => 'closed' as const), timeout])) === 'timeout'
      ) {
        void worker.disconnect().catch(() => undefined);
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** One callback per job; each branch validates its data before touching anything. */
  async process(job: Pick<Job, 'name' | 'data'>): Promise<void> {
    switch (job.name) {
      case 'close-section': {
        const d = closeData.parse(job.data);
        await this.bounded('close-section', d.orgId, d.sessionId, d.sectionId, () =>
          this.closeSection.close(d.orgId, d.sessionId, d.sectionId, d.variant),
        );
        return;
      }
      case 'auto-submit': {
        const d = sessionData.parse(job.data);
        await this.bounded('auto-submit', d.orgId, d.sessionId, undefined, () =>
          this.submitFlow.autoSubmit(d.orgId, d.sessionId),
        );
        return;
      }
      case 'grade-session': {
        const d = sessionData.parse(job.data);
        await this.bounded('grade', d.orgId, d.sessionId, undefined, () =>
          this.grading.grade(d.orgId, d.sessionId),
        );
        return;
      }
      case 'grading-sweep':
        await this.sweep();
        return;
      default:
        this.logger.warn(`Unknown grading job ${job.name} dropped`);
    }
  }

  private failureKey(kind: JobKind, sessionId: string, sectionId?: string): string {
    return `${kind}-failures:${sessionId}${sectionId === undefined ? '' : `:${sectionId}`}`;
  }

  private outageKey(sessionId: string): string {
    return `grade-outage-since:${sessionId}`;
  }

  private async givenUp(key: string): Promise<boolean> {
    await ensureConnected(this.redis);
    return Number((await this.redis.get(key)) ?? '0') >= MAX_JOB_FAILURES;
  }

  /**
   * Runs a job body with a per-session failure budget (grade-session, close-section, auto-submit).
   * A data error (GradingInvariantError) alerts at once and is not retried. A runner outage
   * (RunnerUnavailableError) is NOT counted: it is a platform problem that ends when Judge0 is back,
   * and the sweep keeps re-queuing (runbook: FU-BEB-90). Any other failure counts; at
   * MAX_JOB_FAILURES the session is given up: an error-level alert (ids only) and the sweep stops
   * re-queuing it. A person decides next.
   */
  private async bounded(
    kind: JobKind,
    orgId: string,
    sessionId: string,
    sectionId: string | undefined,
    run: () => Promise<unknown>,
  ): Promise<void> {
    try {
      await run();
      if (kind === 'grade') await this.redis.del(this.outageKey(sessionId)).catch(() => undefined);
    } catch (e) {
      await ensureConnected(this.redis);
      let ceiling = false;
      if (e instanceof RunnerUnavailableError) {
        // Not counted, but not for ever: a submission that always makes the runner fail looks the
        // same as an outage, so uncounted failures stop at a time ceiling (FU-BEB-92).
        const since = this.outageKey(sessionId);
        await this.redis.set(since, String(Date.now()), 'EX', FAILURE_TTL_SECONDS, 'NX');
        const first = Number((await this.redis.get(since)) ?? Date.now());
        if (Date.now() - first <= OUTAGE_CEILING_MS) throw e;
        ceiling = true;
      }
      const invariant = e instanceof GradingInvariantError;
      const key = this.failureKey(kind, sessionId, sectionId);
      let count: number;
      if (invariant || ceiling) {
        count = MAX_JOB_FAILURES;
        await this.redis.set(key, String(count), 'EX', FAILURE_TTL_SECONDS);
      } else {
        count = Number(await this.redis.eval(COUNT_SCRIPT, 1, key, String(FAILURE_TTL_SECONDS)));
      }
      if (count >= MAX_JOB_FAILURES) {
        this.logger.error(
          JSON.stringify({
            alert: `${kind}_gave_up`,
            sessionId,
            ...(sectionId === undefined ? {} : { sectionId }),
            orgId,
            reason: invariant
              ? 'invariant'
              : ceiling
                ? 'runner_outage_ceiling'
                : 'retries_exhausted',
            errorName: e instanceof Error ? e.name : 'unknown',
          }),
        );
        throw new UnrecoverableError(`${kind} gave up`);
      }
      throw e;
    }
  }

  /**
   * Pages through ordered rows and keeps those `keep` accepts, so rows already given up cannot
   * occupy the batch (or the alert slots) of newer ones.
   */
  private async collect<T>(
    fetch: (skip: number, take: number) => Promise<T[]>,
    keep: (row: T) => Promise<boolean>,
    want: number,
  ): Promise<T[]> {
    const out: T[] = [];
    for (let page = 0; page < SWEEP_MAX_PAGES; page++) {
      const rows = await fetch(page * SWEEP_BATCH, SWEEP_BATCH);
      for (const row of rows) {
        if (await keep(row)) {
          out.push(row);
          if (out.length >= want) return out;
        }
      }
      if (rows.length < SWEEP_BATCH) break;
    }
    return out;
  }

  /**
   * Queues what is due. Returns the counts, for tests and metrics. The deadline job re-checks the
   * effective deadline, so a job picked early (a running PROCTOR pause) is a harmless no-op: this
   * sweep, not a re-delay inside the job, is what picks it up again.
   */
  async sweep(
    now: Date = new Date(),
  ): Promise<{ sections: number; sessions: number; stuck: number }> {
    const system = <R>(fn: () => Promise<R>): Promise<R> =>
      this.orgContext.runSystem('BACKGROUND_JOB', fn);
    const sections = await this.collect(
      (skip, take) =>
        system(() =>
          this.prisma.client.sessionSection.findMany({
            where: {
              endedAt: null,
              startedAt: { not: null },
              deadlineAt: { lt: new Date(now.getTime() - CLOSE_GRACE_MS) },
              session: { status: { in: [...LIVE_STATUSES] } },
            },
            select: { sessionId: true, sectionId: true, session: { select: { orgId: true } } },
            orderBy: [{ deadlineAt: 'asc' }, { sessionId: 'asc' }],
            skip,
            take,
          }),
        ),
      async (r) =>
        !(await this.givenUp(this.failureKey('close-section', r.sessionId, r.sectionId))),
      SWEEP_BATCH,
    );
    // The stored deadline is a lower bound of the effective one, so it is a safe filter.
    const sessions = await this.collect(
      (skip, take) =>
        system(() =>
          this.prisma.client.session.findMany({
            where: { status: { in: [...LIVE_STATUSES] }, deadlineAt: { lt: now } },
            select: { id: true, orgId: true },
            orderBy: [{ deadlineAt: 'asc' }, { id: 'asc' }],
            skip,
            take,
          }),
        ),
      async (r) => !(await this.givenUp(this.failureKey('auto-submit', r.id))),
      SWEEP_BATCH,
    );
    const stuckWhere = (olderThanMs: number) => ({
      status: 'SUBMITTED' as const,
      submittedAt: { lt: new Date(now.getTime() - olderThanMs) },
    });
    const stuckFetch = (olderThanMs: number) => (skip: number, take: number) =>
      system(() =>
        this.prisma.client.session.findMany({
          where: stuckWhere(olderThanMs),
          select: { id: true, orgId: true },
          orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
          skip,
          take,
        }),
      );
    const stuck = await this.collect(
      stuckFetch(STUCK_SUBMITTED_MS),
      async (r) =>
        !(await this.givenUp(this.failureKey('grade', r.id))) &&
        // The reconciler leaves a session alone while its grade job is active, waiting or delayed.
        !(await this.queue.hasLiveGradeJob(r.id)),
      SWEEP_BATCH,
    );

    for (const s of sections) {
      await this.queue.enqueueCloseSection(s.session.orgId, s.sessionId, s.sectionId, 'deadline');
    }
    for (const s of sessions) await this.queue.enqueueAutoSubmit(s.orgId, s.id);
    for (const s of stuck) await this.queue.enqueueGrade(s.orgId, s.id, 0);

    // Error-level alert for a session SUBMITTED for more than an hour, once an hour (ids only).
    // The marker is the filter, so older alerted sessions cannot starve newer ones.
    const alerts = await this.collect(
      stuckFetch(STUCK_ALERT_MS),
      async (r) => {
        await ensureConnected(this.redis);
        return (
          (await this.redis.set(`alert:stuck:${r.id}`, '1', 'EX', ALERT_REPEAT_SECONDS, 'NX')) ===
          'OK'
        );
      },
      SWEEP_ALERTS,
    );
    for (const s of alerts) {
      this.logger.error(
        JSON.stringify({ alert: 'session_stuck_submitted', sessionId: s.id, orgId: s.orgId }),
      );
    }
    return { sections: sections.length, sessions: sessions.length, stuck: stuck.length };
  }
}
