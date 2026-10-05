// Throwaway Postgres 16 and Redis for tests via Testcontainers. Never touches the dev database.
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
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
  // Settings from an earlier test app must not leak into this one.
  for (const key of ['ENABLE_API_DOCS', 'TRUST_PROXY_HOPS', 'THROTTLE_AUTH_LIMIT'])
    delete process.env[key];
  Object.assign(process.env, {
    NODE_ENV: 'test',
    APP_ENV: 'test',
    LOG_LEVEL: 'silent',
    WEB_ORIGIN: 'http://localhost:3000',
    DATABASE_URL: infra.postgres.getConnectionUri(),
    REDIS_URL: infra.redis.getConnectionUrl(),
    HEALTH_TIMEOUT_MS: '1500',
    // Test-only secrets, generated per run. Never real credentials.
    JWT_ACCESS_SECRET: randomBytes(32).toString('base64'),
    COOKIE_SECRET: randomBytes(32).toString('base64'),
    ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    ...overrides,
  });
}

/**
 * Applies every prisma/migrations/*\/migration.sql in order against the throwaway container, which
 * is what `prisma migrate deploy` does on an empty database. Never touches the dev database.
 */
export async function applyMigrations(infra: TestInfra): Promise<void> {
  const root = join(__dirname, '../../../../prisma/migrations');
  const client = new Client({ connectionString: infra.postgres.getConnectionUri() });
  await client.connect();
  try {
    for (const dir of readdirSync(root).sort()) {
      if (!/^\d+_/.test(dir)) continue;
      await client.query(readFileSync(join(root, dir, 'migration.sql'), 'utf8'));
    }
  } finally {
    await client.end();
  }
}
