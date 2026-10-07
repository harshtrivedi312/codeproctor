import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import type { Env } from '../config/env';
import { PrismaService } from '../database/prisma.service';
import { ensureConnected } from '../infrastructure/redis-ready';
import { PG_POOL, REDIS_CLIENT } from '../infrastructure/infrastructure.module';

export type DependencyState = 'up' | 'down';
export interface HealthReport {
  status: 'ok' | 'error';
  checks: { postgres: DependencyState; redis: DependencyState };
}

@Injectable()
export class HealthService {
  private readonly timeoutMs: number;

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
        await this.prisma.ping();
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
