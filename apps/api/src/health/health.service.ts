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

interface PingEntry {
  startedAt: number;
  settledAt?: number;
  result: Promise<void>;
}

export type DependencyState = 'up' | 'down';
export interface HealthReport {
  status: 'ok' | 'error';
  checks: { postgres: DependencyState; redis: DependencyState };
}

@Injectable()
export class HealthService {
  private readonly timeoutMs: number;
  private readonly maxPingAgeMs: number;
  private ping?: PingEntry;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
  ) {
    this.timeoutMs = config.get('HEALTH_TIMEOUT_MS', { infer: true });
    this.maxPingAgeMs = this.timeoutMs + config.get('DB_CONNECT_TIMEOUT_MS', { infer: true });
  }

  async check(): Promise<HealthReport> {
    const [postgres, redis] = await Promise.all([
      this.probe(async () => {
        await this.pool.query('SELECT 1');
        // Also through Prisma's own pool and query path, which serves every request: the app is
        // only ready when that path works (FU-BE-194). It keeps the pool's connection warm only if
        // the health interval is below DB_IDLE_TIMEOUT_MS; do not rely on it for that.
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
   * pings on the request pool. Callers within a window share one promise: an unsettled ping for up
   * to `maxPingAgeMs`, a settled one for PING_CACHE_MS. A ping that is still unsettled after
   * `maxPingAgeMs` (DB_CONNECT_TIMEOUT_MS + HEALTH_TIMEOUT_MS: one full connect or pool-slot wait
   * plus one full probe window) is abandoned and one new ping starts, because the connect timeout
   * is not a query timeout: a ping that got a connection and never gets an answer (blackholed
   * network, paused DB host) would otherwise pin /health at "down" after Postgres recovers. Only
   * while a ping waits for a pool slot or a connection does it end at DB_CONNECT_TIMEOUT_MS.
   */
  private pingPrisma(): Promise<void> {
    const now = performance.now();
    const current = this.ping;
    if (current) {
      const fresh =
        current.settledAt === undefined
          ? now - current.startedAt < this.maxPingAgeMs
          : now - current.settledAt < PING_CACHE_MS;
      if (fresh) return current.result;
    }
    const entry: PingEntry = { startedAt: now, result: this.prisma.ping() };
    this.ping = entry;
    // Per entry: an abandoned ping settling late must not touch the entry that replaced it.
    const settled = (): void => {
      entry.settledAt = performance.now();
    };
    entry.result.then(settled, settled);
    return entry.result;
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
