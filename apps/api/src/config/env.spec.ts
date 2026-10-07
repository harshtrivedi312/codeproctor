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
      // Candidate settings (BE-07) are also required in pilot and production.
      JWT_CANDIDATE_SECRET: 'c'.repeat(48),
      OTP_PEPPER: 'p'.repeat(48),
      SESSION_KEY_ENC_KEY_k1: Buffer.alloc(32, 3).toString('base64'),
      REQUIRE_LEGAL_APPROVED_CONSENT: 'true',
      EMAIL_PROVIDER: 'ses',
      SES_FROM_ADDRESS: 'no-reply@example.com',
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
      // Candidate settings (BE-07) are also required in pilot and production.
      JWT_CANDIDATE_SECRET: 'c'.repeat(48),
      OTP_PEPPER: 'p'.repeat(48),
      REQUIRE_LEGAL_APPROVED_CONSENT: 'true',
      SESSION_KEY_ENC_KEY_k1: Buffer.alloc(32, 3).toString('base64'),
      EMAIL_PROVIDER: 'ses',
      SES_FROM_ADDRESS: 'no-reply@example.com',
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
      // Candidate settings (BE-07) are also required in pilot and production.
      JWT_CANDIDATE_SECRET: 'c'.repeat(48),
      OTP_PEPPER: 'p'.repeat(48),
      REQUIRE_LEGAL_APPROVED_CONSENT: 'true',
      SESSION_KEY_ENC_KEY_k1: Buffer.alloc(32, 3).toString('base64'),
      EMAIL_PROVIDER: 'ses',
      SES_FROM_ADDRESS: 'no-reply@example.com',
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
  describe('C-31 email settings', () => {
    const live = {
      ...valid,
      APP_ENV: 'pilot',
      WEB_ORIGIN: 'https://app.example.com',
      TRUST_PROXY_HOPS: '1',
      JUDGE0_URL: 'https://judge0.example.com',
      JUDGE0_AUTH_TOKEN: 't'.repeat(32),
      JUDGE0_AUTHZ_TOKEN: 'z'.repeat(32),
      // Candidate settings (BE-07) are also required in pilot and production.
      JWT_CANDIDATE_SECRET: 'c'.repeat(48),
      OTP_PEPPER: 'p'.repeat(48),
      REQUIRE_LEGAL_APPROVED_CONSENT: 'true',
      SESSION_KEY_ENC_KEY_k1: Buffer.alloc(32, 3).toString('base64'),
      EMAIL_PROVIDER: 'ses',
      SES_FROM_ADDRESS: 'no-reply@example.com',
    };

    it('C-31: defaults to noop and us-east-1 locally', () => {
      const env = validateEnv(valid);
      expect(env.EMAIL_PROVIDER).toBe('noop');
      expect(env.AWS_REGION).toBe('us-east-1');
      expect(env.SES_FROM_ADDRESS).toBeUndefined();
    });

    it('C-31: pilot and production require ses and name the variable', () => {
      for (const APP_ENV of ['pilot', 'production']) {
        expect(validateEnv({ ...live, APP_ENV }).EMAIL_PROVIDER).toBe('ses');
        expect(() => validateEnv({ ...live, APP_ENV, EMAIL_PROVIDER: 'noop' })).toThrow(
          /EMAIL_PROVIDER/,
        );
        expect(() => validateEnv({ ...live, APP_ENV, EMAIL_PROVIDER: undefined })).toThrow(
          /EMAIL_PROVIDER/,
        );
      }
      expect(() =>
        validateEnv({
          ...live,
          APP_ENV: 'development',
          NODE_ENV: 'production',
          EMAIL_PROVIDER: 'noop',
        }),
      ).toThrow(/EMAIL_PROVIDER/);
    });

    it('C-31: empty optional SES settings count as unset when the provider is noop', () => {
      const env = validateEnv({
        ...valid,
        SES_FROM_ADDRESS: '',
        SES_CONFIGURATION_SET: '',
        SES_ENDPOINT: '',
      });
      expect(env.SES_FROM_ADDRESS).toBeUndefined();
      expect(env.SES_CONFIGURATION_SET).toBeUndefined();
      expect(env.SES_ENDPOINT).toBeUndefined();
    });

    it('C-31: an empty SES_FROM_ADDRESS fails with ses and in live environments, naming only the variable', () => {
      expect(() => validateEnv({ ...valid, EMAIL_PROVIDER: 'ses', SES_FROM_ADDRESS: '' })).toThrow(
        /SES_FROM_ADDRESS/,
      );
      for (const APP_ENV of ['pilot', 'production']) {
        expect(() => validateEnv({ ...live, APP_ENV, SES_FROM_ADDRESS: '' })).toThrow(
          /SES_FROM_ADDRESS/,
        );
      }
    });

    it('C-31: an empty SES_ENDPOINT or SES_CONFIGURATION_SET is unset, a non-empty endpoint is still refused in live', () => {
      const ok = validateEnv({ ...live, SES_ENDPOINT: '', SES_CONFIGURATION_SET: '' });
      expect(ok.SES_ENDPOINT).toBeUndefined();
      expect(ok.SES_CONFIGURATION_SET).toBeUndefined();
      expect(() => validateEnv({ ...live, SES_ENDPOINT: 'http://127.0.0.1:4566' })).toThrow(
        /SES_ENDPOINT/,
      );
    });

    it('C-31: whitespace-only SES settings are invalid, never echoed; mixed-case http endpoint is refused in live', () => {
      for (const env of [
        { ...valid, EMAIL_PROVIDER: 'ses', SES_FROM_ADDRESS: ' ' },
        { ...live, SES_FROM_ADDRESS: ' ' },
      ]) {
        let text = '';
        try {
          validateEnv(env);
        } catch (e) {
          text = String(e);
        }
        expect(text).toContain('SES_FROM_ADDRESS');
        expect(text).not.toContain('SES_FROM_ADDRESS: " "');
      }
      expect(() => validateEnv({ ...valid, SES_ENDPOINT: ' ' })).toThrow(/SES_ENDPOINT/);
      expect(() => validateEnv({ ...live, SES_ENDPOINT: 'HTTP://127.0.0.1:4566' })).toThrow(
        /SES_ENDPOINT/,
      );
    });

    it('C-31: each refused AWS variable set to a space is refused in live, set to empty is accepted', () => {
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
      ]) {
        expect(() => validateEnv({ ...live, [name]: ' ' })).toThrow(new RegExp(name));
        expect(() => validateEnv({ ...live, [name]: '' })).not.toThrow();
      }
    });

    it('C-31: ses needs a valid SES_FROM_ADDRESS', () => {
      expect(() => validateEnv({ ...live, SES_FROM_ADDRESS: undefined })).toThrow(
        /SES_FROM_ADDRESS/,
      );
      expect(() => validateEnv({ ...live, SES_FROM_ADDRESS: 'not-an-address' })).toThrow(
        /SES_FROM_ADDRESS/,
      );
      expect(() =>
        validateEnv({ ...valid, EMAIL_PROVIDER: 'ses', SES_FROM_ADDRESS: undefined }),
      ).toThrow(/SES_FROM_ADDRESS/);
    });

    it('C-31: SES_ENDPOINT is refused in staging, pilot and production, allowed in development and test', () => {
      const endpoint = 'http://127.0.0.1:4566';
      for (const APP_ENV of ['staging', 'pilot', 'production']) {
        expect(() => validateEnv({ ...live, APP_ENV, SES_ENDPOINT: endpoint })).toThrow(
          /SES_ENDPOINT/,
        );
      }
      expect(() =>
        validateEnv({ ...valid, NODE_ENV: 'production', SES_ENDPOINT: endpoint }),
      ).toThrow(/SES_ENDPOINT/);
      for (const APP_ENV of ['development', 'test']) {
        expect(validateEnv({ ...valid, APP_ENV, SES_ENDPOINT: endpoint }).SES_ENDPOINT).toBe(
          endpoint,
        );
      }
    });

    it('C-31: static AWS credentials are refused in live environments, naming only the variable', () => {
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
      ]) {
        for (const APP_ENV of ['pilot', 'production']) {
          let text = '';
          try {
            validateEnv({ ...live, APP_ENV, [name]: 'SUPERSECRETVALUE' });
          } catch (e) {
            text = String(e);
          }
          expect(text).toContain(name);
          expect(text).not.toContain('SUPERSECRETVALUE');
        }
        // Developers may hold credentials locally.
        expect(() => validateEnv({ ...valid, [name]: 'x' })).not.toThrow();
      }
    });

    it('C-31: AWS_REGION must look like a region and is pinned to us-east-1 in live environments', () => {
      for (const bad of ['us_east_1', 'US-EAST-1', 'useast1', 'us-east', '']) {
        expect(() => validateEnv({ ...valid, AWS_REGION: bad })).toThrow(/AWS_REGION/);
      }
      expect(validateEnv({ ...valid, AWS_REGION: 'eu-west-1' }).AWS_REGION).toBe('eu-west-1');
      for (const APP_ENV of ['pilot', 'production']) {
        expect(() => validateEnv({ ...live, APP_ENV, AWS_REGION: 'eu-west-1' })).toThrow(
          /AWS_REGION/,
        );
        expect(validateEnv({ ...live, APP_ENV, AWS_REGION: 'us-east-1' }).AWS_REGION).toBe(
          'us-east-1',
        );
      }
    });
  });
});

describe('FU-BE-194 database pool settings', () => {
  it('FU-BE-194: defaults apply', () => {
    const env = validateEnv(valid);
    expect(env.DB_POOL_MAX).toBe(10);
    expect(env.DB_CONNECT_TIMEOUT_MS).toBe(5_000);
    expect(env.DB_WARMUP_TIMEOUT_MS).toBe(5_000);
  });

  it.each([
    ['DB_POOL_MAX', ['0', '-1', '1.5', '51', '']],
    ['DB_CONNECT_TIMEOUT_MS', ['0', '-1', '1.5', '60001', '']],
    ['DB_WARMUP_TIMEOUT_MS', ['0', '-1', '1.5', '60001', '']],
  ])('FU-BE-194: %s refuses 0, negatives, fractions, above-max and an empty value', (name, bad) => {
    for (const value of bad) {
      expect(() => validateEnv({ ...valid, [name]: value })).toThrow(new RegExp(name));
    }
  });

  it('FU-BE-194: the maximum values are accepted', () => {
    const env = validateEnv({
      ...valid,
      DB_POOL_MAX: '50',
      DB_CONNECT_TIMEOUT_MS: '60000',
      DB_WARMUP_TIMEOUT_MS: '60000',
    });
    expect(env.DB_POOL_MAX).toBe(50);
  });
});
