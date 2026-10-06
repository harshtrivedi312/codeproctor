// Zod-validated environment (NFR-04). The process refuses to start on an invalid environment.
// Secrets needed by later steps (JWT, encryption, S3, email) are added by the step that uses them.
import { z } from 'zod';

const port = z.coerce.number().int().min(1).max(65535);
const positiveInt = z.coerce.number().int().positive();

// AES-256-GCM key: 32 random bytes, base64 encoded.
const aesKey = z
  .string()
  .refine((v) => /^[A-Za-z0-9+/]+={0,2}$/.test(v) && Buffer.from(v, 'base64').length === 32, {
    message: 'must be 32 bytes, base64 encoded',
  });
// HMAC/JWT secrets: at least 32 characters so a placeholder such as change-me is refused.
const secret = z.string().min(32, 'must be at least 32 characters');

/** True for http(s) URLs with no credentials, path (other than "/"), query or fragment. */
function isBareOrigin(value: string): boolean {
  try {
    const u = new URL(value);
    return (
      (u.protocol === 'http:' || u.protocol === 'https:') &&
      u.username === '' &&
      u.password === '' &&
      u.pathname === '/' &&
      u.search === '' &&
      u.hash === ''
    );
  } catch {
    return false;
  }
}

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    APP_ENV: z
      .enum(['development', 'test', 'staging', 'pilot', 'production'])
      .default('development'),
    API_PORT: port.default(4000),
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1),
    // Bare origin of the web app, e.g. https://app.example.com. A trailing slash is normalised away;
    // a path, query, fragment or credentials are refused (FU-BE-11).
    WEB_ORIGIN: z
      .url()
      .refine(isBareOrigin, 'must be a bare http(s) origin such as https://app.example.com')
      .transform((v) => new URL(v).origin),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    // Global default: requests per window per client IP.
    THROTTLE_DEFAULT_LIMIT: positiveInt.default(100),
    // Stricter limits for /auth and /candidate (NFR-04).
    THROTTLE_AUTH_LIMIT: positiveInt.default(10),
    THROTTLE_CANDIDATE_LIMIT: positiveInt.default(30),
    // Browser error reports per window per IP on the public POST /client-errors (C-32).
    CLIENT_ERROR_THROTTLE_LIMIT: positiveInt.default(10),
    // Whole-instance cap on those reports, whoever sends them (C-32).
    CLIENT_ERROR_GLOBAL_LIMIT: positiveInt.default(300),
    // How long a client may take to send the (at most 16 KB) report body (C-32).
    CLIENT_ERROR_BODY_TIMEOUT_MS: positiveInt.default(10_000),
    // Node HTTP server timeouts, the server-wide slowloris defence (FU-BE-98). The headers timeout
    // must be below the request timeout (headers plus body). keepAliveTimeout must exceed the
    // reverse proxy's idle upstream timeout (Caddy: set `keepalive` below it).
    HTTP_HEADERS_TIMEOUT_MS: positiveInt.default(10_000),
    HTTP_REQUEST_TIMEOUT_MS: positiveInt.default(30_000),
    HTTP_KEEPALIVE_TIMEOUT_MS: positiveInt.max(600_000).default(65_000),
    // How often Node checks connections against those timeouts (its own default is 30 s).
    HTTP_TIMEOUT_CHECK_INTERVAL_MS: positiveInt.default(2_000),
    THROTTLE_TTL_MS: positiveInt.default(60_000),
    HEALTH_TIMEOUT_MS: positiveInt.default(2_000),
    // Number of reverse proxies in front of the API (0 locally, 1 behind Caddy). FU-BE-08.
    // Pilot and production (APP_ENV pilot/production, or NODE_ENV production) must set it to at
    // least 1: with 0 every client shares the proxy address and the per-IP throttles collapse into
    // one bucket (FU-BE-97). Staging also runs behind Caddy but is not enforced, matching how the
    // other pilot/production-only guards below treat it. Local, development and test stay at 0.
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
    // Staff invites per organization per hour (FR-103); a stolen admin session cannot mass-create.
    INVITE_RATE_LIMIT_PER_ORG_HOUR: positiveInt.default(20),
    // OpenAPI is opt-in and refused in pilot and production. FU-BE-10.
    ENABLE_API_DOCS: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    // Staff authentication secrets (FR-101, FR-102, FR-104). Never log these.
    JWT_ACCESS_SECRET: secret,
    // Signs the refresh-token cookie.
    COOKIE_SECRET: secret,
    // Encrypts TOTP secrets at rest (AES-256-GCM).
    ENCRYPTION_KEY: aesKey,
    // Issuer label shown in authenticator apps.
    TOTP_ISSUER: z.string().min(1).default('CodeProctor'),
    // Code runner (BE-05, FR-503). Unset means runs fail as "unavailable". Token is a secret.
    JUDGE0_URL: z.url().optional(),
    JUDGE0_AUTH_TOKEN: z.string().min(1).optional(),
    // Judge0 AUTHZ token (X-Auth-User): needed to DELETE submissions after use. Never log.
    JUDGE0_AUTHZ_TOKEN: z.string().min(1).optional(),
    JUDGE0_REQUEST_TIMEOUT_MS: positiveInt.default(10_000),
    JUDGE0_POLL_DEADLINE_MS: positiveInt.default(60_000),
  })
  .superRefine((env, ctx) => {
    const live = isLiveEnv(env);
    if (env.HTTP_HEADERS_TIMEOUT_MS >= env.HTTP_REQUEST_TIMEOUT_MS) {
      ctx.addIssue({
        code: 'custom',
        path: ['HTTP_HEADERS_TIMEOUT_MS'],
        message: 'must be less than HTTP_REQUEST_TIMEOUT_MS',
      });
    }
    if (live) {
      // The code runner holds candidate source and test data: it must be configured, authenticated
      // with a strong token, and not reached over plain HTTP unless it is on this host.
      if (!env.JUDGE0_URL) {
        ctx.addIssue({
          code: 'custom',
          path: ['JUDGE0_URL'],
          message: 'is required in pilot and production',
        });
      } else {
        const url = new URL(env.JUDGE0_URL);
        const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
        if (url.protocol !== 'https:' && !loopback) {
          ctx.addIssue({
            code: 'custom',
            path: ['JUDGE0_URL'],
            message: 'must use https unless it is a loopback address',
          });
        }
      }
      if (!env.JUDGE0_AUTH_TOKEN || env.JUDGE0_AUTH_TOKEN.length < 32) {
        ctx.addIssue({
          code: 'custom',
          path: ['JUDGE0_AUTH_TOKEN'],
          message: 'is required in pilot and production, at least 32 characters',
        });
      }
      if (!env.JUDGE0_AUTHZ_TOKEN || env.JUDGE0_AUTHZ_TOKEN.length < 32) {
        ctx.addIssue({
          code: 'custom',
          path: ['JUDGE0_AUTHZ_TOKEN'],
          message: 'is required in pilot and production, at least 32 characters',
        });
      }
    }
    if (live && !env.WEB_ORIGIN.startsWith('https://')) {
      ctx.addIssue({
        code: 'custom',
        path: ['WEB_ORIGIN'],
        message: 'must be an https origin in pilot and production',
      });
    }
    if (live && env.TRUST_PROXY_HOPS < 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['TRUST_PROXY_HOPS'],
        message: 'must be an integer of at least 1 in pilot and production (API runs behind Caddy)',
      });
    }
    if (live && env.ENABLE_API_DOCS) {
      ctx.addIssue({
        code: 'custom',
        path: ['ENABLE_API_DOCS'],
        message: 'must not be true in pilot or production',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

/** Pilot or production, by the same test the guards above use. */
export function isLiveEnv(env: Pick<Env, 'APP_ENV' | 'NODE_ENV'>): boolean {
  return env.APP_ENV === 'pilot' || env.APP_ENV === 'production' || env.NODE_ENV === 'production';
}

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
