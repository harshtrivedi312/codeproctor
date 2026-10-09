// DL-54 (smtp-dev mail) and DL-56 (Judge0 stub): local-only adapters, allowed solely when APP_ENV
// is exactly 'development' (NFR-04, allowlist).
import { validateEnv } from './env';

const base = {
  DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/db',
  REDIS_URL: 'redis://127.0.0.1:6379',
  WEB_ORIGIN: 'http://localhost:3000',
  JWT_ACCESS_SECRET: 'a'.repeat(40),
  COOKIE_SECRET: 'b'.repeat(40),
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
};

const FIXED = 'allowed only when APP_ENV is exactly development';

const settings = [
  { name: 'EMAIL_PROVIDER', value: 'smtp-dev', adapter: 'DL-54 smtp-dev' },
  { name: 'JUDGE0_MODE', value: 'stub', adapter: 'DL-56 judge0 stub' },
] as const;

// [label, extra env]. APP_ENV missing is the "unset" case.
const refused: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  ['APP_ENV unset', {}],
  ['APP_ENV empty', { APP_ENV: '' }],
  ['APP_ENV dev', { APP_ENV: 'dev' }],
  ['APP_ENV Development', { APP_ENV: 'Development' }],
  ['APP_ENV test', { APP_ENV: 'test' }],
  ['APP_ENV staging', { APP_ENV: 'staging' }],
  ['APP_ENV pilot', { APP_ENV: 'pilot' }],
  ['APP_ENV production', { APP_ENV: 'production' }],
  ['development with NODE_ENV production', { APP_ENV: 'development', NODE_ENV: 'production' }],
];

describe.each(settings)('$adapter local-only guard', ({ name, value }) => {
  it.each(refused)(
    `DL-54/DL-56: ${'%s'} refuses ${'$name'} boot, naming only the variable`,
    (_l, extra) => {
      let message = '';
      try {
        validateEnv({ ...base, ...extra, [name]: value });
      } catch (e) {
        message = String(e);
      }
      expect(message).toContain(`${name}: ${value} is ${FIXED}`);
    },
  );

  it(`DL-54/DL-56: APP_ENV exactly development allows ${name}=${value}`, () => {
    const env = validateEnv({ ...base, APP_ENV: 'development', [name]: value });
    expect(env[name]).toBe(value);
  });

  it(`DL-54/DL-56: ${name} default is not a local adapter and passes everywhere it did before`, () => {
    expect(() => validateEnv({ ...base, APP_ENV: 'staging' })).not.toThrow();
  });
});

describe('DL-54/DL-56 defaults and stub needs', () => {
  it('DL-54: SMTP_DEV_HOST and SMTP_DEV_PORT default to 127.0.0.1 and 1025', () => {
    const env = validateEnv({ ...base, APP_ENV: 'development', EMAIL_PROVIDER: 'smtp-dev' });
    expect(env.SMTP_DEV_HOST).toBe('127.0.0.1');
    expect(env.SMTP_DEV_PORT).toBe(1025);
  });

  it('DL-56: JUDGE0_MODE defaults to real; stub needs no JUDGE0_URL or tokens', () => {
    expect(validateEnv({ ...base, APP_ENV: 'development' }).JUDGE0_MODE).toBe('real');
    const env = validateEnv({ ...base, APP_ENV: 'development', JUDGE0_MODE: 'stub' });
    expect(env.JUDGE0_URL).toBeUndefined();
  });

  it('DL-56: the refusal message never echoes secret values', () => {
    let message = '';
    try {
      validateEnv({
        ...base,
        APP_ENV: 'production',
        JUDGE0_MODE: 'stub',
        JUDGE0_AUTH_TOKEN: 'super-secret-token-value-0123456789abcdef',
      });
    } catch (e) {
      message = String(e);
    }
    expect(message).toContain('JUDGE0_MODE');
    expect(message).not.toContain('super-secret-token-value');
  });
});
