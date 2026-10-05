// BullMQ plumbing for the candidate session (backend.md Step 7; ADR 0013 section 5.3 and CS-4.7).
// One queue, `session-jobs`, with these jobs. Every job carries ids only, never a code, token, key,
// URL or answer; the queue keeps no payload after success.
//   consent-pdf             render and store the signed consent PDF, email the copy (D-17)
//   consent-pdf-sweep       repeatable: re-queue signed consents that have no PDF or no email yet
//   discover-disconnected   repeatable every 15 s: find IN_PROGRESS or PAUSED sessions silent for
//                           more than 60 s and queue one `disconnected` job each (FR-609)
//   disconnected            log a DISCONNECTED event for one session: an event, not a status
//   server-event            write RECONNECTED after a beat that follows a DISCONNECTED
// Job ids use `_`, never `:` (BullMQ restricts custom ids). The worker starts after the app is up
// and never blocks start: with Redis down the API still answers /health.
import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker } from 'bullmq';
import type { ConnectionOptions, Job } from 'bullmq';
import type { Redis } from 'ioredis';
import { Inject } from '@nestjs/common';
import { z } from 'zod';
import { DEFAULT_EVENT_SEVERITY, parseEventPayload } from '@codeproctor/shared';
import type { Env } from '../config/env';
import { OrgContextService } from '../database/org-context';
import { PrismaService } from '../database/prisma.service';
import { REDIS_CLIENT } from '../infrastructure/infrastructure.module';
import { ensureConnected } from '../infrastructure/redis-ready';
import { LIVE_STATUSES } from '../session/session-transitions';
import { ConsentPdfService } from './consent-pdf.service';

export const SESSION_QUEUE = 'session-jobs';
/** FR-609: more than 60 s without a heartbeat logs DISCONNECTED. */
export const DISCONNECT_AFTER_MS = 60_000;
const DISCOVERY_EVERY_MS = 15_000;
const CONSENT_SWEEP_EVERY_MS = 300_000;
const SWEEP_MIN_AGE_MS = 60_000;
const DISCOVERY_BATCH = 500;
const DISCONNECT_MARKER_TTL_SECONDS = 86_400;

const uuid = z.guid();
const consentPdfData = z.object({ sessionId: uuid, orgId: uuid });
const disconnectedData = z.object({ sessionId: uuid, orgId: uuid, lastHeartbeatMs: z.number().int() });
const serverEventData = z.object({
  sessionId: uuid,
  orgId: uuid,
  type: z.literal('RECONNECTED'),
  atMs: z.number().int(),
});

/** BullMQ takes connection options, not a URL; derive them from REDIS_URL. */
export function bullConnection(redisUrl: string): ConnectionOptions {
  const url = new URL(redisUrl);
  return {
    host: url.hostname,
    port: url.port === '' ? 6379 : Number(url.port),
    ...(url.username !== '' ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password !== '' ? { password: decodeURIComponent(url.password) } : {}),
    ...(url.pathname.length > 1 ? { db: Number(url.pathname.slice(1)) } : {}),
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
  };
}

@Injectable()
export class SessionJobsService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(SessionJobsService.name);
  private queue: Queue | undefined;
  private worker: Worker | undefined;
  private retry: NodeJS.Timeout | undefined;
  private closing = false;

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
    private readonly orgContext: OrgContextService,
    private readonly consentPdf: ConsentPdfService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  onModuleInit(): void {
    const connection = bullConnection(this.config.get('REDIS_URL', { infer: true }));
    this.queue = new Queue(SESSION_QUEUE, { connection });
    // An unhandled 'error' event would crash the process; Redis outages are reported by /health.
    this.queue.on('error', () => this.logger.warn('Session queue connection error'));
    this.worker = new Worker(SESSION_QUEUE, (job) => this.process(job), {
      connection,
      concurrency: 5,
    });
    this.worker.on('error', () => this.logger.warn('Session worker connection error'));
    this.worker.on('failed', (job) => {
      // Name and id only: the data is ids, but the rule is the same for every candidate job.
      this.logger.warn(`Job ${job?.name ?? '?'} failed (attempt ${String(job?.attemptsMade ?? 0)})`);
    });
    this.scheduleRepeatables();
  }

  /** Registers the repeatable jobs in the background; retries until Redis answers. */
  private scheduleRepeatables(): void {
    const queue = this.queue;
    if (queue === undefined || this.closing) return;
    const opts = { removeOnComplete: true, removeOnFail: true };
    void Promise.all([
      queue.upsertJobScheduler(
        'discover-disconnected',
        { every: DISCOVERY_EVERY_MS },
        { name: 'discover-disconnected', data: {}, opts },
      ),
      queue.upsertJobScheduler(
        'consent-pdf-sweep',
        { every: CONSENT_SWEEP_EVERY_MS },
        { name: 'consent-pdf-sweep', data: {}, opts },
      ),
    ]).catch(() => {
      if (this.closing) return;
      this.logger.warn('Could not register the session job schedules; retrying in 10 s');
      this.retry = setTimeout(() => this.scheduleRepeatables(), 10_000);
      this.retry.unref();
    });
  }

  async onApplicationShutdown(): Promise<void> {
    this.closing = true;
    if (this.retry) clearTimeout(this.retry);
    await Promise.allSettled([this.worker?.close(), this.queue?.close()]);
  }

  private requireQueue(): Queue {
    if (this.queue === undefined) throw new Error('The session queue is not started');
    return this.queue;
  }

  // ---- enqueue ----

  async enqueueConsentPdf(sessionId: string, orgId: string): Promise<void> {
    await this.requireQueue().add(
      'consent-pdf',
      { sessionId, orgId },
      {
        jobId: `consent-pdf_${sessionId}`,
        attempts: 6,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: true,
        removeOnFail: { age: 86_400 },
      },
    );
  }

  async enqueueServerEvent(
    sessionId: string,
    orgId: string,
    type: 'RECONNECTED',
    at: Date,
  ): Promise<void> {
    await this.requireQueue().add(
      'server-event',
      { sessionId, orgId, type, atMs: at.getTime() },
      {
        jobId: `server-event_${sessionId}_${type}_${String(at.getTime())}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 2_000 },
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  }

  // ---- worker ----

  /** One callback per job; each branch validates its data before touching anything. */
  async process(job: Pick<Job, 'name' | 'data'>): Promise<void> {
    switch (job.name) {
      case 'consent-pdf': {
        const data = consentPdfData.parse(job.data);
        const done = await this.consentPdf.generate(data.orgId, data.sessionId);
        if (!done) this.logger.warn('Consent PDF job found no signed consent; dropped');
        return;
      }
      case 'consent-pdf-sweep':
        await this.sweepConsentPdfs();
        return;
      case 'discover-disconnected':
        await this.discoverDisconnected();
        return;
      case 'disconnected': {
        const data = disconnectedData.parse(job.data);
        await this.logDisconnected(data.orgId, data.sessionId);
        return;
      }
      case 'server-event': {
        const data = serverEventData.parse(job.data);
        await this.writeReconnected(data.orgId, data.sessionId, new Date(data.atMs));
        return;
      }
      default:
        this.logger.warn(`Unknown session job ${job.name} dropped`);
    }
  }

  /**
   * Finds sessions silent for more than 60 s and queues one `disconnected` job per session. It only
   * enqueues; the write happens per session inside that session's org (ADR 0013 CS-4.7).
   */
  async discoverDisconnected(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - DISCONNECT_AFTER_MS);
    const silent = await this.orgContext.runSystem('BACKGROUND_JOB', () =>
      this.prisma.client.session.findMany({
        where: {
          status: { in: [...LIVE_STATUSES] },
          OR: [
            { lastHeartbeat: { lt: cutoff } },
            { lastHeartbeat: null, startedAt: { lt: cutoff } },
          ],
        },
        select: { id: true, orgId: true, lastHeartbeat: true, startedAt: true },
        take: DISCOVERY_BATCH,
      }),
    );
    const queue = this.requireQueue();
    for (const s of silent) {
      const since = (s.lastHeartbeat ?? s.startedAt)?.getTime() ?? 0;
      await queue.add(
        'disconnected',
        { sessionId: s.id, orgId: s.orgId, lastHeartbeatMs: since },
        {
          // One job per silence episode; the Redis marker below is the real once-only guard.
          jobId: `disconnected_${s.id}_${String(since)}`,
          attempts: 3,
          backoff: { type: 'exponential', delay: 2_000 },
          removeOnComplete: { age: 3_600 },
          removeOnFail: true,
        },
      );
    }
    return silent.length;
  }

  /**
   * Writes DISCONNECTED for one session if it is still silent (FR-609). The `disc:{sessionId}`
   * marker, set with NX, makes this once per silence: the next heartbeat removes it and queues
   * RECONNECTED. A DISCONNECTED is an event with severity LOW; the session status is unchanged.
   */
  async logDisconnected(orgId: string, sessionId: string, now: Date = new Date()): Promise<boolean> {
    return this.orgContext.runInOrg(orgId, async () => {
      const session = await this.prisma.client.session.findUnique({
        where: { id: sessionId },
        select: { status: true, lastHeartbeat: true, startedAt: true },
      });
      if (session === null || !LIVE_STATUSES.includes(session.status)) return false;
      const last = session.lastHeartbeat ?? session.startedAt;
      // Re-check: a beat may have arrived since the discovery ran.
      if (last === null || now.getTime() - last.getTime() <= DISCONNECT_AFTER_MS) return false;

      await ensureConnected(this.redis);
      const marker = `disc:${sessionId}`;
      const claimed = await this.redis.set(
        marker,
        String(last.getTime()),
        'EX',
        DISCONNECT_MARKER_TTL_SECONDS,
        'NX',
      );
      if (claimed !== 'OK') return false;
      try {
        await this.prisma.client.proctorEvent.create({
          data: {
            sessionId,
            type: 'DISCONNECTED',
            severity: DEFAULT_EVENT_SEVERITY.DISCONNECTED,
            source: 'SERVER',
            occurredAt: now,
            payload: parseEventPayload('DISCONNECTED', { lastHeartbeatAt: last.toISOString() }),
          },
        });
      } catch (e) {
        await this.redis.del(marker).catch(() => undefined);
        throw e;
      }
      return true;
    });
  }

  private async writeReconnected(orgId: string, sessionId: string, at: Date): Promise<void> {
    await this.orgContext.runInOrg(orgId, async () => {
      const session = await this.prisma.client.session.findUnique({
        where: { id: sessionId },
        select: { status: true },
      });
      if (session === null || !LIVE_STATUSES.includes(session.status)) return;
      await this.prisma.client.proctorEvent.create({
        data: {
          sessionId,
          type: 'RECONNECTED',
          severity: DEFAULT_EVENT_SEVERITY.RECONNECTED,
          source: 'SERVER',
          occurredAt: at,
          payload: parseEventPayload('RECONNECTED', {}),
        },
      });
    });
  }

  /** Re-queues signed consents whose PDF or email step never finished (queue down, job lost). */
  async sweepConsentPdfs(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - SWEEP_MIN_AGE_MS);
    const pending = await this.orgContext.runSystem('BACKGROUND_JOB', () =>
      this.prisma.client.consent.findMany({
        where: {
          signedAt: { not: null, lt: cutoff },
          OR: [{ pdfKey: null }, { copyEmailedAt: null }],
        },
        select: { sessionId: true, session: { select: { orgId: true } } },
        take: DISCOVERY_BATCH,
      }),
    );
    for (const c of pending) await this.enqueueConsentPdf(c.sessionId, c.session.orgId);
    return pending.length;
  }
}
