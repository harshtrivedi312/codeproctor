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
    const ping = jest.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
    const svc = make(ping);
    const reports = await Promise.all(Array.from({ length: 25 }, () => svc.check()));
    expect(reports.every((x) => x.status === 'ok')).toBe(true);
    await svc.check();
    expect(ping).toHaveBeenCalledTimes(1);
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
