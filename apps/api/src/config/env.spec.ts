import { validateEnv } from './env';

const valid = {
  DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/db',
  REDIS_URL: 'redis://127.0.0.1:6379',
  WEB_ORIGIN: 'http://localhost:3000',
  JWT_ACCESS_SECRET: 'a'.repeat(40),
  COOKIE_SECRET: 'b'.repeat(40),
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
};

describe('NFR-04 environment validation', () => {
  it('NFR-04: applies defaults for a minimal valid environment', () => {
    const env = validateEnv(valid);
    expect(env.API_PORT).toBe(4000);
    expect(env.THROTTLE_AUTH_LIMIT).toBeLessThan(env.THROTTLE_DEFAULT_LIMIT);
  });

  it('NFR-04: rejects a missing variable and does not echo secret values', () => {
    expect(() => validateEnv({ ...valid, DATABASE_URL: undefined })).toThrow(/DATABASE_URL/);
    try {
      validateEnv({ ...valid, WEB_ORIGIN: 'super-secret-not-a-url' });
      fail('expected throw');
    } catch (e) {
      expect(String(e)).not.toContain('super-secret-not-a-url');
    }
  });

  it('NFR-04: refuses placeholder or malformed auth secrets without echoing them', () => {
    expect(() => validateEnv({ ...valid, JWT_ACCESS_SECRET: 'change-me' })).toThrow(
      /JWT_ACCESS_SECRET/,
    );
    expect(() => validateEnv({ ...valid, COOKIE_SECRET: undefined })).toThrow(/COOKIE_SECRET/);
    expect(() => validateEnv({ ...valid, ENCRYPTION_KEY: 'c2hvcnQ=' })).toThrow(/ENCRYPTION_KEY/);
    try {
      validateEnv({ ...valid, ENCRYPTION_KEY: 'not-the-key-just-a-secret-value' });
      fail('expected throw');
    } catch (e) {
      expect(String(e)).not.toContain('not-the-key-just-a-secret-value');
    }
  });

  it('FU-BE-08: TRUST_PROXY_HOPS defaults to 0 and must be a small non-negative integer', () => {
    expect(validateEnv(valid).TRUST_PROXY_HOPS).toBe(0);
    expect(validateEnv({ ...valid, TRUST_PROXY_HOPS: '1' }).TRUST_PROXY_HOPS).toBe(1);
    expect(() => validateEnv({ ...valid, TRUST_PROXY_HOPS: '-1' })).toThrow(/TRUST_PROXY_HOPS/);
  });

  it('FU-BE-10: API docs are off by default and refused in pilot and production', () => {
    expect(validateEnv(valid).ENABLE_API_DOCS).toBe(false);
    expect(
      validateEnv({ ...valid, ENABLE_API_DOCS: 'true', APP_ENV: 'staging' }).ENABLE_API_DOCS,
    ).toBe(true);
    for (const APP_ENV of ['pilot', 'production']) {
      expect(() => validateEnv({ ...valid, ENABLE_API_DOCS: 'true', APP_ENV })).toThrow(
        /ENABLE_API_DOCS/,
      );
    }
    expect(() =>
      validateEnv({ ...valid, ENABLE_API_DOCS: 'true', NODE_ENV: 'production' }),
    ).toThrow(/ENABLE_API_DOCS/);
  });
});
