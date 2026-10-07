import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import type { Env } from '../config/env';
import { PrismaService } from '../database/prisma.service';
import { ensureConnected } from '../infrastructure/redis-ready';
import { PG_POOL, REDIS_CLIENT } from '../infrastructure/infrastructure.module';

/** How long a finished Prisma ping answers later /health calls. */
const PING_CACHE_MS = 1_000;

export type DependencyState = 'up' | 'down';
export interface HealthReport {
  status: 'ok' | 'error';
  checks: { postgres: DependencyState; redis: DependencyState };
}

@Injectable()
export class HealthService {
  private readonly timeoutMs: number;
  private lastPing?: { at: number; result: Promise<void> };
  private pingInFlight = false;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
  ) {
    this.timeoutMs = config.get('HEALTH_TIMEOUT_MS', { infer: true });
  }

  async check(): Promise<HealthReport> {
    const [postgres, redis] = await Promise.all([
      this.probe(async () => {
        await this.pool.query('SELECT 1');
        // Also through Prisma's own pool and query path, which serves every request: the app is
        // only ready when that path works, and the probe warms it after a boot (FU-BE-194).
        await this.pingPrisma();
      }),
      this.probe(async () => {
        await ensureConnected(this.redis);
        await this.redis.ping();
      }),
    ]);
    return {
      status: postgres === 'up' && redis === 'up' ? 'ok' : 'error',
      checks: { postgres, redis },
    };
  }

  /**
   * Single-flight with a short cache: /health is public and unthrottled, so a flood must not queue
   * pings on the request pool. At most one ping is in flight (a timed-out ping stays in pg-pool's
   * queue until DB_CONNECT_TIMEOUT_MS, so it is shared, not repeated), and its outcome is reused
   * for PING_CACHE_MS (B1).
   */
  private pingPrisma(): Promise<void> {
    const now = Date.now();
    if (this.lastPing && (this.pingInFlight || now - this.lastPing.at < PING_CACHE_MS)) {
      return this.lastPing.result;
    }
    const result = this.prisma.ping();
    const entry = { at: now, result };
    this.lastPing = entry;
    this.pingInFlight = true;
    const done = (): void => {
      this.pingInFlight = false;
      entry.at = Date.now();
    };
    result.then(done, done);
    return result;
  }

  private async probe(fn: () => Promise<void>): Promise<DependencyState> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        fn(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), this.timeoutMs);
        }),
      ]);
      return 'up';
    } catch {
      return 'down';
    } finally {
      clearTimeout(timer);
    }
  }
}
