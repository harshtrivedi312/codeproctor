// Zod-validated environment (NFR-04). The process refuses to start on an invalid environment.
// Secrets needed by later steps (JWT, encryption, S3, email) are added by the step that uses them.
import { z } from 'zod';

const port = z.coerce.number().int().min(1).max(65535);
const positiveInt = z.coerce.number().int().positive();

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_ENV: z.enum(['development', 'test', 'staging', 'pilot', 'production']).default('development'),
  API_PORT: port.default(4000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  WEB_ORIGIN: z.url(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  // Global default: requests per window per client IP.
  THROTTLE_DEFAULT_LIMIT: positiveInt.default(100),
  // Stricter limits for /auth and /candidate (NFR-04).
  THROTTLE_AUTH_LIMIT: positiveInt.default(10),
  THROTTLE_CANDIDATE_LIMIT: positiveInt.default(30),
  THROTTLE_TTL_MS: positiveInt.default(60_000),
  HEALTH_TIMEOUT_MS: positiveInt.default(2_000),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    // Report variable names and reasons only, never the received values (they may be secrets).
    const problems = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid environment: ${problems}`);
  }
  return result.data;
}
