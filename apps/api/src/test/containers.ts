// Throwaway Postgres 16 and Redis for tests via Testcontainers. Never touches the dev database.
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';

export interface TestInfra {
  postgres: StartedPostgreSqlContainer;
  redis: StartedRedisContainer;
  stop(): Promise<void>;
}

export async function startInfra(): Promise<TestInfra> {
  const [postgres, redis] = await Promise.all([
    new PostgreSqlContainer('postgres:16').start(),
    new RedisContainer('redis:8.8').start(),
  ]);
  return {
    postgres,
    redis,
    stop: async () => {
      await Promise.allSettled([postgres.stop(), redis.stop()]);
    },
  };
}

export function applyEnv(infra: TestInfra, overrides: Record<string, string> = {}): void {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    APP_ENV: 'test',
    LOG_LEVEL: 'silent',
    WEB_ORIGIN: 'http://localhost:3000',
    DATABASE_URL: infra.postgres.getConnectionUri(),
    REDIS_URL: infra.redis.getConnectionUrl(),
    HEALTH_TIMEOUT_MS: '1500',
    ...overrides,
  });
}
