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
// HMAC/JWT secrets: at least 32 characters. Length alone does not refuse placeholders (the local
// template in .env.example uses long change-me-local-... values); shared environments also refuse
// the change-me prefix (see isSharedEnv and the superRefine below).
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

/** Optional setting where '' means "not set". */
function emptyAsUnset<T extends z.ZodType>(schema: T) {
  return z.preprocess((v) => (v === '' ? undefined : v), schema.optional());
}

export const envSchema = z
  .object({
    // NODE_ENV is a library hint only (it can add strictness, never remove it): APP_ENV is the one
    // authority for what the deployment is (DL-55). It has a default and can only add strictness.
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    // Required, no default (DL-55, FU-BE-224, NFR-04): an unset, empty or misspelled value refuses
    // to boot, so a forgotten APP_ENV cannot make a shared deployment behave like development.
    APP_ENV: z.enum(['development', 'test', 'staging', 'pilot', 'production'], {
      error: 'is required and must be one of development, test, staging, pilot, production',
    }),
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
    // Prisma's pg pool (FU-BE-194). pg's own default waits forever for a connection (timeout 0), so
    // an unreachable or full Postgres hung requests with no error. In pg-pool the connect timeout
    // bounds both opening one connection and waiting for a free slot when all `max` connections
    // are busy; it is NOT a query timeout. Requests that used to queue behind slow queries now fail
    // after it. Size Postgres max_connections above DB_POOL_MAX times the API instances running at
    // once (two during a rolling or blue-green deploy) plus the health pool (2) and the worker.
    DB_POOL_MAX: positiveInt.max(50).default(10),
    DB_CONNECT_TIMEOUT_MS: positiveInt.max(60_000).default(5_000),
    // How long an idle pooled connection stays open. pg-pool's own default is 10 s, which would close
    // the warmed-up connection 10 s after boot and bring the cold connect back for the first user
    // after a quiet spell (C-43). Keep it below any NAT or proxy idle timeout in the database path.
    DB_IDLE_TIMEOUT_MS: positiveInt.max(300_000).default(60_000),
    // Upper bound of the best-effort start-up warm-up query; it never fails boot (NFR-09).
    DB_WARMUP_TIMEOUT_MS: positiveInt.max(60_000).default(5_000),
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
    // JUDGE0_MODE=stub (DL-56) swaps in an in-process fake that runs nothing. Local development only
    // (localAdapterProblem); it needs no JUDGE0_URL or tokens.
    JUDGE0_MODE: z.enum(['real', 'stub']).default('real'),
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
    // Email (C-31): Amazon SES, or noop (drops mail) for local and test. Pilot and production
    // require ses. No secrets here: credentials come from the AWS SDK default chain (instance
    // role). SES_ENDPOINT is for tests only and is refused outside development and test.
    EMAIL_PROVIDER: z.enum(['ses', 'noop', 'smtp-dev']).default('noop'),
    // smtp-dev (DL-54): plain SMTP, no auth, no TLS, to a local Mailpit. Local development only: the
    // guard in localAdapterProblem refuses it unless APP_ENV is exactly development.
    SMTP_DEV_HOST: z.string().min(1).default('127.0.0.1'),
    SMTP_DEV_PORT: port.default(1025),
    AWS_REGION: z
      .string()
      .regex(/^[a-z]{2}(-[a-z]+)+-\d+$/, 'must look like us-east-1')
      .default('us-east-1'),
    // Static AWS credentials are refused in pilot and production (instance role only). Declared
    // here only so the guard below can see them; nothing reads their values.
    AWS_ACCESS_KEY_ID: z.string().optional(),
    AWS_SECRET_ACCESS_KEY: z.string().optional(),
    AWS_SESSION_TOKEN: z.string().optional(),
    // Profile and credential-file settings would also bypass the instance role.
    AWS_PROFILE: z.string().optional(),
    AWS_SHARED_CREDENTIALS_FILE: z.string().optional(),
    AWS_CONFIG_FILE: z.string().optional(),
    // Container and web-identity credential sources (ECS, EKS). C-31 says instance role only (EC2
    // instance profile), so pilot and production refuse them; relax if the hub moves to ECS.
    AWS_CONTAINER_CREDENTIALS_FULL_URI: z.string().optional(),
    AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: z.string().optional(),
    AWS_CONTAINER_AUTHORIZATION_TOKEN: z.string().optional(),
    AWS_WEB_IDENTITY_TOKEN_FILE: z.string().optional(),
    AWS_ROLE_ARN: z.string().optional(),
    // An empty value (a copied .env template line such as `SES_FROM_ADDRESS=`) counts as unset;
    // the checks below still require a non-empty valid SES_FROM_ADDRESS when the provider is ses.
    SES_FROM_ADDRESS: emptyAsUnset(z.email()),
    SES_CONFIGURATION_SET: emptyAsUnset(z.string().min(1)),
    SES_ENDPOINT: emptyAsUnset(z.url()),
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
    if (live && env.JUDGE0_MODE === 'real') {
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
    if (isSharedEnv(env)) {
      for (const name of [
        'JWT_ACCESS_SECRET',
        'COOKIE_SECRET',
        'JWT_CANDIDATE_SECRET',
        'OTP_PEPPER',
        'JUDGE0_AUTH_TOKEN',
        'JUDGE0_AUTHZ_TOKEN',
      ] as const) {
        const value = env[name];
        if (value !== undefined && isPlaceholderText(value)) {
          ctx.addIssue({
            code: 'custom',
            path: [name],
            message: 'is a local placeholder and is refused in staging, pilot and production',
          });
        }
      }
      const urlProblem = databaseUrlProblem(env.DATABASE_URL);
      if (urlProblem !== undefined) {
        ctx.addIssue({ code: 'custom', path: ['DATABASE_URL'], message: urlProblem });
      }
      if (isPlaceholderKey(env.ENCRYPTION_KEY)) {
        ctx.addIssue({
          code: 'custom',
          path: ['ENCRYPTION_KEY'],
          message: 'is a local placeholder and is refused in staging, pilot and production',
        });
      }
    }
    const emailProblem = localAdapterProblem(env.EMAIL_PROVIDER === 'smtp-dev', env, 'smtp-dev');
    if (emailProblem !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['EMAIL_PROVIDER'], message: emailProblem });
    }
    const judgeProblem = localAdapterProblem(env.JUDGE0_MODE === 'stub', env, 'stub');
    if (judgeProblem !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['JUDGE0_MODE'], message: judgeProblem });
    }
    if (live && env.EMAIL_PROVIDER !== 'ses') {
      ctx.addIssue({
        code: 'custom',
        path: ['EMAIL_PROVIDER'],
        message: 'must be ses in pilot and production',
      });
    }
    if (live && env.AWS_REGION !== 'us-east-1') {
      ctx.addIssue({
        code: 'custom',
        path: ['AWS_REGION'],
        message: 'must be us-east-1 in pilot and production (C-31)',
      });
    }
    if (live) {
      for (const name of [
        'AWS_ACCESS_KEY_ID',
        'AWS_SECRET_ACCESS_KEY',
        'AWS_SESSION_TOKEN',
        'AWS_PROFILE',
        'AWS_SHARED_CREDENTIALS_FILE',
        'AWS_CONFIG_FILE',
        'AWS_CONTAINER_CREDENTIALS_FULL_URI',
        'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
        'AWS_CONTAINER_AUTHORIZATION_TOKEN',
        'AWS_WEB_IDENTITY_TOKEN_FILE',
        'AWS_ROLE_ARN',
      ] as const) {
        // `!== ''` mirrors the AWS SDK's own truthiness checks: an empty value is ignored by the
        // SDK, a whitespace one is not. Do not turn this into a trim.
        if (env[name] !== undefined && env[name] !== '') {
          ctx.addIssue({
            code: 'custom',
            path: [name],
            message:
              'must not be set in pilot or production (C-31: EC2 instance role only; container and web-identity credentials are refused until the hub allows ECS)',
          });
        }
      }
    }
    if (env.EMAIL_PROVIDER === 'ses' && !env.SES_FROM_ADDRESS) {
      ctx.addIssue({
        code: 'custom',
        path: ['SES_FROM_ADDRESS'],
        message: 'is required when EMAIL_PROVIDER is ses',
      });
    }
    if (env.SES_ENDPOINT && (live || env.APP_ENV === 'staging')) {
      ctx.addIssue({
        code: 'custom',
        path: ['SES_ENDPOINT'],
        message: 'is for tests only and must not be set in staging, pilot or production',
      });
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

/** Pilot or production, by the same test the guards above use. */
export function isLiveEnv(env: Pick<Env, 'APP_ENV' | 'NODE_ENV'>): boolean {
  return env.APP_ENV === 'pilot' || env.APP_ENV === 'production' || env.NODE_ENV === 'production';
}

/** Local values only. Anything else, including a misspelling, counts as shared (allowlist). */
const LOCAL_APP_ENVS: readonly string[] = ['development', 'test'];

/** True unless APP_ENV is a local value; NODE_ENV=production is always shared. */
export function isSharedEnv(env: { APP_ENV?: string; NODE_ENV?: string }): boolean {
  return (
    env.NODE_ENV === 'production' ||
    env.APP_ENV === undefined ||
    !LOCAL_APP_ENVS.includes(env.APP_ENV)
  );
}

/**
 * Local-only adapters (smtp-dev mail, Judge0 stub; DL-54, DL-56, NFR-04) are an allowlist: only
 * APP_ENV exactly 'development' may use them, and NODE_ENV=production always refuses. Unset,
 * misspelled, test, staging, pilot and production all refuse. Fixed message, no values.
 */
export function localAdapterProblem(
  active: boolean,
  env: { APP_ENV?: string; NODE_ENV?: string },
  value: string,
): string | undefined {
  if (!active) return undefined;
  if (env.APP_ENV === 'development' && env.NODE_ENV !== 'production') return undefined;
  return `${value} is allowed only when APP_ENV is exactly development (local use only)`;
}

/** Matches change-me anywhere, ignoring case, surrounding spaces and leading quotes. */
function isPlaceholderText(value: string): boolean {
  return value
    .trim()
    .replace(/^['"]+/, '')
    .toLowerCase()
    .includes('change-me');
}

/**
 * Why a DATABASE_URL is refused in a shared environment, or undefined when it is acceptable. It
 * mirrors what the runtime driver (pg via pg-connection-string) would use, and fails closed:
 * - an unparseable URL is refused (pg has fallbacks, such as a dummy host, that `new URL` lacks);
 * - any `password` query parameter is refused (pg copies search params first, so it would override
 *   the userinfo password);
 * - the userinfo password is checked decoded; one that is not valid percent-encoding is refused;
 * - a Unix-socket DATABASE_URL (starts with `/`) is refused, as `new URL` cannot parse it.
 * Returns a fixed message; never any part of the URL.
 */
function databaseUrlProblem(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'cannot be parsed as a URL, which is refused in staging, pilot and production';
  }
  if (parsed.searchParams.has('password')) {
    return 'must not carry a password query parameter in staging, pilot and production; put the password in the userinfo';
  }
  // pg re-encodes a URL with a bad % sequence (restoring two-digit escapes such as %63 for c), so
  // a password that does not decode cleanly cannot be judged here: refuse it outright.
  let decoded: string;
  try {
    decoded = decodeURIComponent(parsed.password);
  } catch {
    return 'the password is not valid percent-encoding, refused in staging, pilot and production';
  }
  if (isPlaceholderText(decoded)) {
    return 'has a local placeholder password, refused in staging, pilot and production';
  }
  return undefined;
}

/** A base64 key whose bytes spell a change-me placeholder (the .env.example values). */
function isPlaceholderKey(value: string): boolean {
  return (
    isPlaceholderText(value) || isPlaceholderText(Buffer.from(value, 'base64').toString('latin1'))
  );
}

/** Names of configured SESSION_KEY_ENC_KEY_<kid> values that are local placeholders (never values). */
function placeholderSessionKeys(raw: Record<string, unknown>): string[] {
  return Object.entries(raw)
    .filter(
      ([name, value]) =>
        name.startsWith('SESSION_KEY_ENC_KEY_') &&
        typeof value === 'string' &&
        isPlaceholderKey(value),
    )
    .map(([name]) => name);
}

/**
 * PGPASSWORD is not in the schema, but pg falls back to it when the DATABASE_URL has no password,
 * so a change-me value there is the same hazard. Names only, never the value.
 */
function placeholderPgPassword(raw: Record<string, unknown>): string[] {
  const value = raw['PGPASSWORD'];
  return typeof value === 'string' && isPlaceholderText(value) ? ['PGPASSWORD'] : [];
}

const PLACEHOLDER_MESSAGE =
  'is a local placeholder and is refused in staging, pilot and production';

export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    // Report variable names and reasons only, never the received values (they may be secrets).
    const problems = result.error.issues.map(
      (i) => `${i.path.join('.') || '(root)'}: ${i.message}`,
    );
    // Fails closed (DL-55, FU-BE-224): an unset, empty or misspelled APP_ENV is not a local value,
    // so it counts as shared and the placeholder checks still run before this throws.
    const appEnv = typeof raw['APP_ENV'] === 'string' ? raw['APP_ENV'] : undefined;
    const nodeEnv = typeof raw['NODE_ENV'] === 'string' ? raw['NODE_ENV'] : undefined;
    if (isSharedEnv({ APP_ENV: appEnv, NODE_ENV: nodeEnv })) {
      for (const name of [...placeholderSessionKeys(raw), ...placeholderPgPassword(raw)])
        problems.push(`${name}: ${PLACEHOLDER_MESSAGE}`);
      const url = raw['DATABASE_URL'];
      const urlProblem =
        typeof url === 'string' && url !== '' ? databaseUrlProblem(url) : undefined;
      if (urlProblem !== undefined) problems.push(`DATABASE_URL: ${urlProblem}`);
    }
    // The schema may have stopped before its own refinements ran, so repeat the local-adapter guard
    // here: an unset or misspelled APP_ENV must still name the variables (DL-54, DL-56).
    const emailProblem = localAdapterProblem(
      raw['EMAIL_PROVIDER'] === 'smtp-dev',
      { APP_ENV: appEnv, NODE_ENV: nodeEnv },
      'smtp-dev',
    );
    const judgeProblem = localAdapterProblem(
      raw['JUDGE0_MODE'] === 'stub',
      { APP_ENV: appEnv, NODE_ENV: nodeEnv },
      'stub',
    );
    if (emailProblem !== undefined && !problems.some((x) => x.startsWith('EMAIL_PROVIDER: ')))
      problems.push(`EMAIL_PROVIDER: ${emailProblem}`);
    if (judgeProblem !== undefined && !problems.some((x) => x.startsWith('JUDGE0_MODE: ')))
      problems.push(`JUDGE0_MODE: ${judgeProblem}`);
    throw new Error(`Invalid environment: ${problems.join('; ')}`);
  }
  // The wrapping key is named by the active kid (SESSION_KEY_ENC_KEY_<kid>), so the schema cannot
  // list it. Pilot and production must not start without a valid one: without it every test start
  // would fail at the candidate's first click (ADR 0013 section 2). Names only, never values.
  const env = result.data;
  // The parsed APP_ENV is always one of the five values (it has no default, DL-55).
  if (isSharedEnv(env)) {
    // Every configured wrapping key, not only the active kid: an old kid is still used to unwrap.
    const bad = [...placeholderSessionKeys(raw), ...placeholderPgPassword(raw)];
    if (bad.length > 0) {
      throw new Error(
        `Invalid environment: ${bad.map((n) => `${n}: ${PLACEHOLDER_MESSAGE}`).join('; ')}`,
      );
    }
  }
  if (isLiveEnv(env)) {
    const name = `SESSION_KEY_ENC_KEY_${env.SESSION_KEY_ENC_ACTIVE_KID}`;
    const value = raw[name];
    if (typeof value !== 'string' || !aesKey.safeParse(value).success) {
      throw new Error(`Invalid environment: ${name}: must be 32 bytes, base64 encoded`);
    }
  }
  return env;
}
