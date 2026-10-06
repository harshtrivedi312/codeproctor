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

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    APP_ENV: z
      .enum(['development', 'test', 'staging', 'pilot', 'production'])
      .default('development'),
    API_PORT: port.default(4000),
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1),
    WEB_ORIGIN: z.url(),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    // Global default: requests per window per client IP.
    THROTTLE_DEFAULT_LIMIT: positiveInt.default(100),
    // Stricter limits for /auth and /candidate (NFR-04).
    THROTTLE_AUTH_LIMIT: positiveInt.default(10),
    THROTTLE_CANDIDATE_LIMIT: positiveInt.default(30),
    THROTTLE_TTL_MS: positiveInt.default(60_000),
    HEALTH_TIMEOUT_MS: positiveInt.default(2_000),
    // Number of reverse proxies in front of the API (0 locally, 1 behind Caddy). FU-BE-08.
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
    // Candidate session (BE-07, ADR 0013 section 5.10, ADR 0003). The three secrets are optional so
    // the staff-only suites and local tooling start without them; the candidate routes then answer
    // 503 (CandidateConfig). Pilot and production must set them (superRefine below).
    // Signs candidate JWTs; must differ from JWT_ACCESS_SECRET so a staff token never verifies.
    JWT_CANDIDATE_SECRET: secret.optional(),
    // Keys the HMAC that protects the 6-digit email OTP in Redis (ADR 0003 section 2).
    OTP_PEPPER: secret.optional(),
    // kid of the AES-256-GCM key (SESSION_KEY_ENC_KEY_<kid>, 32 bytes base64) that wraps the
    // per-session HMAC master key (ADR 0013 section 2). Older kids stay configured until their rows
    // are destroyed; the key itself is read from the environment by SessionKeyService.
    SESSION_KEY_ENC_ACTIVE_KID: z
      .string()
      .regex(/^[A-Za-z0-9]{1,16}$/, 'must be 1 to 16 letters or digits')
      .default('k1'),
    // Candidate JWT lifetime. The heartbeat renews it when less than half is left.
    CANDIDATE_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
    // Seconds after submission during which proctor batches are still accepted (ADR 0013 section 2).
    PROCTOR_INGEST_GRACE_SECONDS: z.coerce.number().int().min(0).max(3600).default(300),
    // When true the API refuses to serve a consent text without Legal approval (ADR 0007 section 6).
    REQUIRE_LEGAL_APPROVED_CONSENT: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
  })
  .superRefine((env, ctx) => {
    const live = env.APP_ENV === 'pilot' || env.APP_ENV === 'production';
    if (live || env.NODE_ENV === 'production') {
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
    if ((live || env.NODE_ENV === 'production') && env.ENABLE_API_DOCS) {
      ctx.addIssue({
        code: 'custom',
        path: ['ENABLE_API_DOCS'],
        message: 'must not be true in pilot or production',
      });
    }
    if (live && !env.REQUIRE_LEGAL_APPROVED_CONSENT) {
      ctx.addIssue({
        code: 'custom',
        path: ['REQUIRE_LEGAL_APPROVED_CONSENT'],
        message: 'must be true in pilot and production (ADR 0007 section 6)',
      });
    }
    // Staging is not listed: the candidate routes answer 503 there until the secrets are set.
    const deployed = live || env.NODE_ENV === 'production';
    if (deployed) {
      for (const key of ['JWT_CANDIDATE_SECRET', 'OTP_PEPPER'] as const) {
        if (env[key] === undefined) {
          ctx.addIssue({ code: 'custom', path: [key], message: 'is required outside development' });
        }
      }
    }
    if (
      env.JWT_CANDIDATE_SECRET !== undefined &&
      env.JWT_CANDIDATE_SECRET === env.JWT_ACCESS_SECRET
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_CANDIDATE_SECRET'],
        message: 'must differ from JWT_ACCESS_SECRET',
      });
    }
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
