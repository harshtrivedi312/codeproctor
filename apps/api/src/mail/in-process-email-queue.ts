// In-process email queue (see email-queue.port.ts for the BullMQ seam). Jobs live in memory only.
// A job is removed when it completes and after its final failed attempt; nothing is persisted, so
// a restart loses queued mail (accepted until BullMQ replaces this). Log lines carry the template
// id, a random job id, the attempt and the error class name, never the payload.
import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { OnApplicationShutdown } from '@nestjs/common';
import { EmailQueuePort } from './email-queue.port';
import type { EmailJobHandler, EnqueueOutcome } from './email-queue.port';
import type { EmailJob } from './mail-templates';
import { MailError } from './mail-transport';

export interface QueueLogger {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface InProcessQueueOptions {
  concurrency?: number;
  maxAttempts?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  /** Jobs waiting or running above this are rejected. */
  capacity?: number;
  logger?: QueueLogger;
  /** How long shutdown waits for waiting and retrying jobs before dropping them. Default 5 s. */
  drainMs?: number;
}

interface Entry {
  id: string;
  job: EmailJob;
  attempt: number;
}

export class InProcessEmailQueue extends EmailQueuePort implements OnApplicationShutdown {
  private readonly concurrency: number;
  private readonly maxAttempts: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly capacity: number;
  private readonly drainMs: number;
  private readonly logger: QueueLogger;
  private readonly ready: Entry[] = [];
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly retrying = new Map<string, Entry>();
  private active = 0;
  private stopped = false;
  private idleWaiters: Array<() => void> = [];

  constructor(
    private readonly handler: EmailJobHandler,
    opts: InProcessQueueOptions = {},
  ) {
    super();
    this.concurrency = opts.concurrency ?? 4;
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.baseBackoffMs = opts.baseBackoffMs ?? 1_000;
    this.maxBackoffMs = opts.maxBackoffMs ?? 60_000;
    this.capacity = opts.capacity ?? 1_000;
    this.drainMs = opts.drainMs ?? 5_000;
    this.logger = opts.logger ?? new Logger('EmailQueue');
  }

  /** Jobs waiting, running or waiting to retry. Zero once everything has finished. */
  size(): number {
    return this.ready.length + this.active + this.retrying.size;
  }

  enqueue(job: EmailJob): Promise<EnqueueOutcome> {
    if (this.stopped || this.size() >= this.capacity) {
      this.logger.warn(
        `mail enqueue rejected template=${job.template} reason=${this.stopped ? 'stopped' : 'full'}`,
      );
      return Promise.resolve('rejected');
    }
    this.ready.push({ id: randomUUID(), job, attempt: 0 });
    this.pump();
    return Promise.resolve('accepted');
  }

  /** Resolves when no job is waiting, running or retrying (tests, graceful drain). */
  idle(): Promise<void> {
    if (this.size() === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /**
   * Shutdown order: AuthService settles its deferred mail in beforeApplicationShutdown, which Nest
   * runs before every onApplicationShutdown, so those mails reach this queue while it still
   * accepts. Here the queue drains for drainMs, then stops and drops what is left (count logged).
   */
  async onApplicationShutdown(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      this.idle(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.drainMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    this.stop();
  }

  /** Stops accepting, cancels retries and drops waiting jobs (count logged, no payload). */
  stop(): void {
    this.stopped = true;
    const dropped = this.ready.length + this.retrying.size;
    if (dropped > 0) this.logger.warn(`mail queue stopped, dropped ${dropped} waiting jobs`);
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.retrying.clear();
    this.ready.length = 0;
    this.notifyIdle();
  }

  private pump(): void {
    while (!this.stopped && this.active < this.concurrency && this.ready.length > 0) {
      const entry = this.ready.shift();
      if (!entry) break;
      this.active++;
      void this.run(entry);
    }
  }

  private async run(entry: Entry): Promise<void> {
    entry.attempt++;
    try {
      await this.handler(entry.job);
      this.logger.log(`mail job ${entry.id} template=${entry.job.template} sent`);
    } catch (e) {
      const errName = e instanceof MailError ? `${e.name}/${e.causeName}` : 'unknown';
      const permanent = e instanceof MailError && e.permanent;
      if (permanent || entry.attempt >= this.maxAttempts) {
        this.logger.error(
          `mail job ${entry.id} template=${entry.job.template} dropped after ${entry.attempt} attempts${permanent ? ' (permanent)' : ''} error=${errName}`,
        );
      } else if (this.stopped) {
        this.logger.error(
          `mail job ${entry.id} template=${entry.job.template} dropped (stopped) error=${errName}`,
        );
      } else {
        this.logger.warn(
          `mail job ${entry.id} template=${entry.job.template} attempt ${entry.attempt} failed error=${errName}`,
        );
        this.scheduleRetry(entry);
      }
    } finally {
      this.active--;
      this.pump();
      this.notifyIdle();
    }
  }

  private scheduleRetry(entry: Entry): void {
    if (this.stopped) return;
    const delay = Math.min(this.baseBackoffMs * 2 ** (entry.attempt - 1), this.maxBackoffMs);
    this.retrying.set(entry.id, entry);
    const timer = setTimeout(() => {
      this.timers.delete(entry.id);
      this.retrying.delete(entry.id);
      if (this.stopped) return;
      this.ready.push(entry);
      this.pump();
    }, delay);
    timer.unref();
    this.timers.set(entry.id, timer);
  }

  private notifyIdle(): void {
    if (this.size() !== 0) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const w of waiters) w();
  }
}
