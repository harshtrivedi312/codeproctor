// Shared connections used by the health check. Business modules (DB-05 and later) own Prisma.
import { Global, Inject, Injectable, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import type { Env } from '../config/env';

export const PG_POOL = Symbol('PG_POOL');
export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

@Injectable()
class ShutdownService implements OnApplicationShutdown {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([this.pool.end(), this.redis.quit()]);
  }
}

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): Pool => {
        const pool = new Pool({
          connectionString: config.get('DATABASE_URL', { infer: true }),
          max: 2,
          connectionTimeoutMillis: config.get('HEALTH_TIMEOUT_MS', { infer: true }),
        });
        // An idle-client error must not crash the process.
        pool.on('error', () => undefined);
        return pool;
      },
    },
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): Redis => {
        const redis = new Redis(config.get('REDIS_URL', { infer: true }), {
          lazyConnect: true,
          maxRetriesPerRequest: 1,
          enableOfflineQueue: false,
          connectTimeout: config.get('HEALTH_TIMEOUT_MS', { infer: true }),
        });
        redis.on('error', () => undefined);
        return redis;
      },
    },
    ShutdownService,
  ],
  exports: [PG_POOL, REDIS_CLIENT],
})
export class InfrastructureModule {}
