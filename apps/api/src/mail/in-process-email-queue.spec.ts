import { InProcessEmailQueue } from './in-process-email-queue';
import type { QueueLogger } from './in-process-email-queue';
import type { EmailJob } from './mail-templates';
import { MailError } from './mail-transport';

const job = (n = 0): EmailJob => ({
  template: 'otp',
  to: `u${n}@example.com`,
  params: { otp: '111111', minutes: 10 },
});

function capture(): { logger: QueueLogger; lines: string[] } {
  const lines: string[] = [];
  const push = (m: string): void => void lines.push(m);
  return { logger: { log: push, warn: push, error: push }, lines };
}

describe('FU-BE-21 in-process email queue', () => {
  it('FU-BE-89: enqueue reports accepted, and rejected when full or stopped', async () => {
    const cap = capture();
    const q = new InProcessEmailQueue(() => new Promise<void>(() => undefined), {
      capacity: 2,
      concurrency: 1,
      logger: cap.logger,
    });
    expect(await q.enqueue(job(1))).toBe('accepted');
    expect(await q.enqueue(job(2))).toBe('accepted');
    expect(await q.enqueue(job(3))).toBe('rejected');
    expect(cap.lines).toContain('mail enqueue rejected template=otp reason=full');
    q.stop();
    expect(cap.lines.some((l) => l.includes('dropped 1 waiting jobs'))).toBe(true);
    expect(await q.enqueue(job(4))).toBe('rejected');
    expect(cap.lines).toContain('mail enqueue rejected template=otp reason=stopped');
    expect(cap.lines.join('\n')).not.toContain('example.com');
  });

  it('FU-BE-21: a completed job is removed (queue empty after the run)', async () => {
    const seen: string[] = [];
    const q = new InProcessEmailQueue(
      (j) => {
        seen.push(j.to);
        return Promise.resolve();
      },
      { logger: capture().logger },
    );
    await q.enqueue(job(1));
    await q.enqueue(job(2));
    await q.idle();
    expect(seen).toHaveLength(2);
    expect(q.size()).toBe(0);
  });

  it('FU-BE-21: retries with exponential backoff, then succeeds', async () => {
    let calls = 0;
    const times: number[] = [];
    const q = new InProcessEmailQueue(
      () => {
        calls++;
        times.push(Date.now());
        return calls < 3 ? Promise.reject(new MailError('x')) : Promise.resolve();
      },
      { baseBackoffMs: 20, logger: capture().logger },
    );
    await q.enqueue(job());
    await q.idle();
    expect(calls).toBe(3);
    expect((times[1] ?? 0) - (times[0] ?? 0)).toBeGreaterThanOrEqual(15);
    expect((times[2] ?? 0) - (times[1] ?? 0)).toBeGreaterThanOrEqual(35);
    expect(q.size()).toBe(0);
  });

  it('FU-BE-21: after the final attempt the job is dropped and its payload is gone', async () => {
    let calls = 0;
    const { logger, lines } = capture();
    const q = new InProcessEmailQueue(
      () => {
        calls++;
        return Promise.reject(new MailError('failed', 'Boom'));
      },
      { maxAttempts: 3, baseBackoffMs: 1, logger },
    );
    await q.enqueue(job(7));
    await q.idle();
    expect(calls).toBe(3);
    expect(q.size()).toBe(0);
    expect(
      JSON.stringify(
        Object.values(q).map((v: unknown) => (v instanceof Map ? [...v.values()] : v)),
      ),
    ).not.toContain('u7@example.com');
    expect(lines.some((l) => l.includes('dropped after 3 attempts'))).toBe(true);
  });

  it('FU-BE-21: never runs more than the concurrency bound at once', async () => {
    let running = 0;
    let max = 0;
    const q = new InProcessEmailQueue(
      async () => {
        running++;
        max = Math.max(max, running);
        await new Promise((r) => setTimeout(r, 10));
        running--;
      },
      { concurrency: 2, logger: capture().logger },
    );
    for (let i = 0; i < 8; i++) await q.enqueue(job(i));
    await q.idle();
    expect(max).toBe(2);
    expect(q.size()).toBe(0);
  });

  it('FU-BE-21: a permanent failure is dropped at once, without retries', async () => {
    let calls = 0;
    const q = new InProcessEmailQueue(
      () => {
        calls++;
        return Promise.reject(new MailError('invalid recipient', 'none', true));
      },
      { maxAttempts: 5, baseBackoffMs: 1, logger: capture().logger },
    );
    await q.enqueue(job());
    await q.idle();
    expect(calls).toBe(1);
    expect(q.size()).toBe(0);
  });

  it('FU-BE-21: no retry is scheduled after the queue is stopped', async () => {
    let calls = 0;
    const q = new InProcessEmailQueue(
      () => {
        calls++;
        q.stop();
        return Promise.reject(new MailError('x'));
      },
      { baseBackoffMs: 1, logger: capture().logger },
    );
    await q.enqueue(job());
    await q.idle();
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toBe(1);
    expect(q.size()).toBe(0);
  });

  it('FU-BE-21: shutdown drains first, so mail enqueued while deferrals settle is still sent', async () => {
    const sent: string[] = [];
    const cap = capture();
    const q = new InProcessEmailQueue(
      async (j) => {
        await new Promise((r) => setTimeout(r, 20));
        sent.push(j.to);
      },
      { drainMs: 1_000, logger: cap.logger },
    );
    await q.enqueue(job(1));
    const shutdown = q.onApplicationShutdown();
    // A deferred reset mail arriving during shutdown is still accepted.
    expect(await q.enqueue(job(2))).toBe('accepted');
    await shutdown;
    expect(sent.sort()).toEqual(['u1@example.com', 'u2@example.com']);
    expect(await q.enqueue(job(3))).toBe('rejected');
  });

  it('FU-BE-21: shutdown gives up after drainMs, drops what is left and logs the count', async () => {
    const cap = capture();
    const q = new InProcessEmailQueue(() => new Promise<void>(() => undefined), {
      concurrency: 1,
      drainMs: 30,
      logger: cap.logger,
    });
    await q.enqueue(job(1));
    await q.enqueue(job(2));
    await q.onApplicationShutdown();
    expect(cap.lines.some((l) => l.includes('dropped 1 waiting jobs'))).toBe(true);
  });

  it('FU-BE-21: a transient failure after stop is logged as dropped (stopped)', async () => {
    const cap = capture();
    const q = new InProcessEmailQueue(
      () => {
        q.stop();
        return Promise.reject(new MailError('x'));
      },
      { logger: cap.logger },
    );
    await q.enqueue(job());
    await q.idle();
    expect(cap.lines.some((l) => l.includes('dropped (stopped)'))).toBe(true);
  });
});
