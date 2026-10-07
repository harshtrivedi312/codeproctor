import { EventEmitter } from 'node:events';
import type { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import type { Env } from '../config/env';
import type { PrismaService } from '../database/prisma.service';
import { HealthService } from './health.service';

class ConnectingRedis extends EventEmitter {
  status = 'connecting';
  options = { connectTimeout: 500 };
  ping(): Promise<string> {
    return this.status === 'ready'
      ? Promise.resolve('PONG')
      : Promise.reject(new Error('not ready'));
  }
}

describe('HealthService Redis probe (NFR-03, QA-D-04)', () => {
  it('NFR-03: /health during a cold-start connect waits for ready instead of pinging a connecting client', async () => {
    const r = new ConnectingRedis();
    const pool = { query: () => Promise.resolve() } as unknown as Pool;
    const config = { get: () => 500 } as unknown as ConfigService<Env, true>;
    const svc = new HealthService(pool, r as unknown as Redis, config, {
      ping: () => Promise.resolve(),
    } as unknown as PrismaService);
    const report = svc.check();
    process.nextTick(() => {
      r.status = 'ready';
      r.emit('ready');
    });
    await expect(report).resolves.toEqual({
      status: 'ok',
      checks: { postgres: 'up', redis: 'up' },
    });
  });

  const make = (
    ping: () => Promise<void>,
    query: () => Promise<unknown> = () => Promise.resolve(),
  ): HealthService => {
    const r = new ConnectingRedis();
    r.status = 'ready';
    return new HealthService(
      { query } as unknown as Pool,
      r as unknown as Redis,
      { get: () => 300 } as unknown as ConfigService<Env, true>,
      { ping } as unknown as PrismaService,
    );
  };

  it('FU-BE-194 B1: N concurrent /health checks run exactly one Prisma ping, and a check right after reuses it', async () => {
    jest.useFakeTimers();
    try {
      const ping = jest.fn(() => Promise.resolve());
      const svc = make(ping);
      const reports = await Promise.all(Array.from({ length: 25 }, () => svc.check()));
      expect(reports.every((x) => x.status === 'ok')).toBe(true);
      await jest.advanceTimersByTimeAsync(500); // inside the 1 s cache window
      await svc.check();
      expect(ping).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('FU-BE-194 B1: concurrent checks after the cache expires produce exactly one new ping', async () => {
    jest.useFakeTimers();
    try {
      const ping = jest.fn(() => Promise.resolve());
      const svc = make(ping);
      await svc.check();
      await jest.advanceTimersByTimeAsync(1_100);
      await Promise.all(Array.from({ length: 10 }, () => svc.check()));
      expect(ping).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('FU-BE-194 S1: a rejecting ping reports down, and after the cache window a new ping reports up (no stale down)', async () => {
    jest.useFakeTimers();
    try {
      const ping = jest
        .fn<Promise<void>, []>()
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValue(undefined);
      const svc = make(ping);
      expect((await svc.check()).checks.postgres).toBe('down');
      expect((await svc.check()).checks.postgres).toBe('down'); // still inside the cache window
      expect(ping).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1_100);
      expect((await svc.check()).checks.postgres).toBe('up');
      expect(ping).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('FU-BE-194 B1: a ping hung past the cap is abandoned; the next check starts one new ping and reports up once Postgres is back', async () => {
    jest.useFakeTimers();
    try {
      // Cap is DB_CONNECT_TIMEOUT_MS + HEALTH_TIMEOUT_MS = 300 + 300 in this config.
      const ping = jest
        .fn<Promise<void>, []>()
        .mockImplementationOnce(() => new Promise<void>(() => undefined))
        .mockResolvedValue(undefined);
      const svc = make(ping);
      const first = svc.check();
      await jest.advanceTimersByTimeAsync(300); // probe window: down
      expect((await first).checks.postgres).toBe('down');
      const second = svc.check(); // within the cap: shares the hung ping
      await jest.advanceTimersByTimeAsync(300);
      expect((await second).checks.postgres).toBe('down');
      expect(ping).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(100); // now past the cap
      expect((await svc.check()).checks.postgres).toBe('up');
      expect(ping).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('FU-BE-194 B1: a hanging ping is shared, not repeated, by later checks while it is in flight', async () => {
    const ping = jest.fn(() => new Promise<void>(() => undefined));
    const svc = make(ping);
    await svc.check();
    await svc.check();
    expect(ping).toHaveBeenCalledTimes(1);
  });

  it('FU-BE-194 S6: Prisma ping rejecting while the health pool succeeds reports postgres down', async () => {
    const svc = make(() => Promise.reject(new Error('pool timeout')));
    await expect(svc.check()).resolves.toEqual({
      status: 'error',
      checks: { postgres: 'down', redis: 'up' },
    });
  });

  it('FU-BE-194 S6: a hanging Prisma ping reports postgres down within the health timeout', async () => {
    const svc = make(() => new Promise<void>(() => undefined));
    const started = Date.now();
    const report = await svc.check();
    expect(report.checks.postgres).toBe('down');
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
