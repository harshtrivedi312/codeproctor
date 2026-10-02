import { validateEnv } from './env';

const valid = {
  DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/db',
  REDIS_URL: 'redis://127.0.0.1:6379',
  WEB_ORIGIN: 'http://localhost:3000',
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
});
