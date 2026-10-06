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

  it('FU-BE-97: pilot and production refuse TRUST_PROXY_HOPS of 0 or missing, and name only the variable', () => {
    const live = {
      WEB_ORIGIN: 'https://app.example.com',
      JUDGE0_URL: 'https://judge0.example.com',
      JUDGE0_AUTH_TOKEN: 't'.repeat(32),
      JUDGE0_AUTHZ_TOKEN: 'z'.repeat(32),
    };
    for (const APP_ENV of ['pilot', 'production']) {
      const base = { ...valid, ...live, APP_ENV };
      expect(() => validateEnv(base)).toThrow(/TRUST_PROXY_HOPS/);
      expect(() => validateEnv({ ...base, TRUST_PROXY_HOPS: '0' })).toThrow(/TRUST_PROXY_HOPS/);
      expect(validateEnv({ ...base, TRUST_PROXY_HOPS: '1' }).TRUST_PROXY_HOPS).toBe(1);
      expect(validateEnv({ ...base, TRUST_PROXY_HOPS: '2' }).TRUST_PROXY_HOPS).toBe(2);
    }
    expect(() =>
      validateEnv({ ...valid, ...live, NODE_ENV: 'production', TRUST_PROXY_HOPS: '0' }),
    ).toThrow(/TRUST_PROXY_HOPS/);
    let text = '';
    expect(() => {
      try {
        validateEnv({ ...valid, ...live, APP_ENV: 'pilot', TRUST_PROXY_HOPS: '0' });
      } catch (e) {
        text = String(e);
        throw e;
      }
    }).toThrow(/TRUST_PROXY_HOPS/);
    expect(text).not.toContain(valid.JWT_ACCESS_SECRET);
    expect(text).not.toContain(valid.DATABASE_URL);
  });

  it('FU-BE-97: local, development and test keep TRUST_PROXY_HOPS at 0; staging is not enforced (like the other pilot/production guards)', () => {
    for (const APP_ENV of ['development', 'test', 'staging']) {
      expect(validateEnv({ ...valid, APP_ENV }).TRUST_PROXY_HOPS).toBe(0);
    }
    expect(
      validateEnv({ ...valid, NODE_ENV: 'test', TRUST_PROXY_HOPS: '0' }).TRUST_PROXY_HOPS,
    ).toBe(0);
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

  it('FR-503: JUDGE0 settings are optional locally and required, strong and https in pilot and production', () => {
    expect(validateEnv(valid).JUDGE0_URL).toBeUndefined();
    const token = 't'.repeat(32);
    const live = {
      ...valid,
      APP_ENV: 'pilot',
      WEB_ORIGIN: 'https://app.example.com',
      TRUST_PROXY_HOPS: '1',
      JUDGE0_URL: 'https://judge0.example.com',
      JUDGE0_AUTH_TOKEN: token,
      JUDGE0_AUTHZ_TOKEN: 'z'.repeat(32),
    };
    expect(validateEnv(live).JUDGE0_URL).toBe('https://judge0.example.com');
    expect(() => validateEnv({ ...live, JUDGE0_URL: undefined })).toThrow(/JUDGE0_URL/);
    expect(() => validateEnv({ ...live, JUDGE0_AUTHZ_TOKEN: undefined })).toThrow(
      /JUDGE0_AUTHZ_TOKEN/,
    );
    expect(() => validateEnv({ ...live, JUDGE0_AUTHZ_TOKEN: 'short-authz' })).toThrow(
      /JUDGE0_AUTHZ_TOKEN/,
    );
    expect(() => validateEnv({ ...live, JUDGE0_AUTH_TOKEN: undefined })).toThrow(
      /JUDGE0_AUTH_TOKEN/,
    );
    expect(() =>
      validateEnv({ ...live, APP_ENV: 'production', JUDGE0_AUTH_TOKEN: 'change-me' }),
    ).toThrow(/JUDGE0_AUTH_TOKEN/);
    expect(() => validateEnv({ ...live, JUDGE0_URL: 'http://judge0.example.com:2358' })).toThrow(
      /https/,
    );
    expect(validateEnv({ ...live, JUDGE0_URL: 'http://127.0.0.1:2358' }).JUDGE0_URL).toBe(
      'http://127.0.0.1:2358',
    );
    try {
      validateEnv({ ...live, JUDGE0_AUTH_TOKEN: 'short-secret-token' });
      fail('expected throw');
    } catch (e) {
      expect(String(e)).not.toContain('short-secret-token');
    }
    expect(
      validateEnv({ ...valid, APP_ENV: 'staging', JUDGE0_URL: 'http://judge0-server:2358' })
        .APP_ENV,
    ).toBe('staging');
  });

  it('FU-BE-11: WEB_ORIGIN is normalised to a bare origin; paths, queries and credentials are refused', () => {
    expect(validateEnv({ ...valid, WEB_ORIGIN: 'https://app.example.com/' }).WEB_ORIGIN).toBe(
      'https://app.example.com',
    );
    expect(validateEnv({ ...valid, WEB_ORIGIN: 'HTTPS://App.Example.com:8443' }).WEB_ORIGIN).toBe(
      'https://app.example.com:8443',
    );
    for (const bad of [
      'https://app.example.com/app',
      'https://app.example.com/?x=1',
      'https://app.example.com/#f',
      'https://user:pw@app.example.com',
      'ftp://app.example.com',
    ]) {
      expect(() => validateEnv({ ...valid, WEB_ORIGIN: bad })).toThrow(/WEB_ORIGIN/);
    }
  });

  it('FU-BE-98: HTTP server timeouts have bounded defaults, and headers must be below request', () => {
    const env = validateEnv(valid);
    expect(env.HTTP_HEADERS_TIMEOUT_MS).toBe(10_000);
    expect(env.HTTP_REQUEST_TIMEOUT_MS).toBe(30_000);
    expect(env.HTTP_KEEPALIVE_TIMEOUT_MS).toBe(65_000);
    expect(env.HTTP_HEADERS_TIMEOUT_MS).toBeLessThan(env.HTTP_REQUEST_TIMEOUT_MS);
    expect(() =>
      validateEnv({ ...valid, HTTP_HEADERS_TIMEOUT_MS: '30000', HTTP_REQUEST_TIMEOUT_MS: '30000' }),
    ).toThrow(/HTTP_HEADERS_TIMEOUT_MS/);
    expect(() => validateEnv({ ...valid, HTTP_KEEPALIVE_TIMEOUT_MS: '0' })).toThrow(
      /HTTP_KEEPALIVE_TIMEOUT_MS/,
    );
    expect(() => validateEnv({ ...valid, HTTP_KEEPALIVE_TIMEOUT_MS: '9999999' })).toThrow(
      /HTTP_KEEPALIVE_TIMEOUT_MS/,
    );
  });

  it('FU-BE-11: pilot and production require an https WEB_ORIGIN; local http stays valid', () => {
    const live = {
      ...valid,
      TRUST_PROXY_HOPS: '1',
      JUDGE0_URL: 'https://judge0.example.com',
      JUDGE0_AUTH_TOKEN: 't'.repeat(32),
      JUDGE0_AUTHZ_TOKEN: 'z'.repeat(32),
    };
    for (const APP_ENV of ['pilot', 'production']) {
      expect(() => validateEnv({ ...live, APP_ENV, WEB_ORIGIN: 'http://app.example.com' })).toThrow(
        /WEB_ORIGIN/,
      );
      expect(
        validateEnv({ ...live, APP_ENV, WEB_ORIGIN: 'https://app.example.com' }).WEB_ORIGIN,
      ).toBe('https://app.example.com');
    }
    expect(validateEnv(valid).WEB_ORIGIN).toBe('http://localhost:3000');
  });
});
