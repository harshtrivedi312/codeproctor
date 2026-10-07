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
});
