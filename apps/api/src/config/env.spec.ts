import { validateEnv } from './env';

const valid = {
  // APP_ENV has no default (DL-55, FU-BE-224): every fixture sets it.
  APP_ENV: 'development',
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
      QUESTION_OPTION_ID_SECRET: 'q'.repeat(48),
      SESSION_KEY_ENC_KEY_k1: Buffer.alloc(32, 3).toString('base64'),
      REQUIRE_LEGAL_APPROVED_CONSENT: 'true',
      EMAIL_PROVIDER: 'ses',
      SES_FROM_ADDRESS: 'no-reply@example.com',
      // Object storage (BE-09) is required in pilot and production.
      S3_REGION: 'eu-west-2',
      S3_MEDIA_BUCKET: 'cp-pilot-media',
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
      QUESTION_OPTION_ID_SECRET: 'q'.repeat(48),
      REQUIRE_LEGAL_APPROVED_CONSENT: 'true',
      SESSION_KEY_ENC_KEY_k1: Buffer.alloc(32, 3).toString('base64'),
      EMAIL_PROVIDER: 'ses',
      SES_FROM_ADDRESS: 'no-reply@example.com',
      // Object storage (BE-09) is required there too.
      S3_REGION: 'eu-west-2',
      S3_MEDIA_BUCKET: 'cp-pilot-media',
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
      QUESTION_OPTION_ID_SECRET: 'q'.repeat(48),
      REQUIRE_LEGAL_APPROVED_CONSENT: 'true',
      SESSION_KEY_ENC_KEY_k1: Buffer.alloc(32, 3).toString('base64'),
      EMAIL_PROVIDER: 'ses',
      SES_FROM_ADDRESS: 'no-reply@example.com',
      // Object storage (BE-09) is required in pilot and production.
      S3_REGION: 'eu-west-2',
      S3_MEDIA_BUCKET: 'cp-pilot-media',
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
      QUESTION_OPTION_ID_SECRET: 'q'.repeat(48),
      REQUIRE_LEGAL_APPROVED_CONSENT: 'true',
      SESSION_KEY_ENC_KEY_k1: Buffer.alloc(32, 3).toString('base64'),
      EMAIL_PROVIDER: 'ses',
      SES_FROM_ADDRESS: 'no-reply@example.com',
      // Object storage (BE-09) is required in pilot and production too.
      S3_REGION: 'eu-west-2',
      S3_MEDIA_BUCKET: 'cp-pilot-media',
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
    expect(env.DB_IDLE_TIMEOUT_MS).toBe(60_000);
  });

  it.each([
    ['DB_POOL_MAX', ['0', '-1', '1.5', '51', '']],
    ['DB_CONNECT_TIMEOUT_MS', ['0', '-1', '1.5', '60001', '']],
    ['DB_WARMUP_TIMEOUT_MS', ['0', '-1', '1.5', '60001', '']],
    ['DB_IDLE_TIMEOUT_MS', ['0', '-1', '1.5', '300001', '']],
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
      DB_IDLE_TIMEOUT_MS: '300000',
    });
    expect(env.DB_POOL_MAX).toBe(50);
    expect(env.DB_IDLE_TIMEOUT_MS).toBe(300_000);
  });

  describe('DL-52 NFR-04 placeholder secrets', () => {
    const ph = {
      JWT_ACCESS_SECRET: 'change-me-local-access-secret-0000000000',
      COOKIE_SECRET: 'Change-Me-local-cookie-secret-00000000000',
      JWT_CANDIDATE_SECRET: 'change-me-local-candidate-secret-00000000',
      OTP_PEPPER: 'change-me-local-otp-pepper-0000000000000',
      QUESTION_OPTION_ID_SECRET: 'change-me-local-question-option-id-secret-000',
      ENCRYPTION_KEY: Buffer.from('change-me-local-encrypt-key-0001').toString('base64'),
      JUDGE0_AUTH_TOKEN: 'change-me',
      JUDGE0_AUTHZ_TOKEN: 'change-me',
    };
    const sessionKey = Buffer.from('change-me-local-session-key-0001').toString('base64');
    const good = {
      ...valid,
      JWT_CANDIDATE_SECRET: 'c'.repeat(40),
      OTP_PEPPER: 'd'.repeat(40),
      QUESTION_OPTION_ID_SECRET: 'q'.repeat(48),
      SESSION_KEY_ENC_KEY_k1: Buffer.alloc(32, 9).toString('base64'),
    };

    it.each(['staging', 'pilot', 'production'])(
      'DL-52 NFR-04: each placeholder alone is refused in %s, a generated value is accepted',
      (APP_ENV) => {
        const base = { ...good, APP_ENV, ...liveExtras(APP_ENV) };
        expect(() => validateEnv(base)).not.toThrow();
        for (const [name, value] of Object.entries(ph)) {
          expect(() => validateEnv({ ...base, [name]: value })).toThrow(new RegExp(name));
        }
        expect(() => validateEnv({ ...base, SESSION_KEY_ENC_KEY_k1: sessionKey })).toThrow(
          /SESSION_KEY_ENC_KEY_k1/,
        );
        // A non-active kid is checked too.
        expect(() => validateEnv({ ...base, SESSION_KEY_ENC_KEY_k0: sessionKey })).toThrow(
          /SESSION_KEY_ENC_KEY_k0/,
        );
      },
    );

    it('DL-52 NFR-04: NODE_ENV=production is shared whatever APP_ENV says', () => {
      expect(() =>
        validateEnv({
          ...good,
          ...liveExtras('pilot'),
          APP_ENV: 'development',
          NODE_ENV: 'production',
          OTP_PEPPER: ph.OTP_PEPPER,
          SESSION_KEY_ENC_KEY_k1: sessionKey,
        }),
      ).toThrow(/OTP_PEPPER/);
      expect(() =>
        validateEnv({
          ...good,
          ...liveExtras('pilot'),
          APP_ENV: 'development',
          NODE_ENV: 'production',
          SESSION_KEY_ENC_KEY_k1: sessionKey,
        }),
      ).toThrow(/SESSION_KEY_ENC_KEY_k1/);
    });

    it('DL-52 NFR-04: the placeholder match ignores quotes, spaces and offset', () => {
      const base = { ...good, APP_ENV: 'staging' };
      const pad = 'x'.repeat(30);
      expect(() => validateEnv({ ...base, OTP_PEPPER: `"change-me-${pad}` })).toThrow(/OTP_PEPPER/);
      expect(() => validateEnv({ ...base, OTP_PEPPER: `   CHANGE-ME-${pad}` })).toThrow(
        /OTP_PEPPER/,
      );
      expect(() => validateEnv({ ...base, OTP_PEPPER: `${pad}-change-me` })).toThrow(/OTP_PEPPER/);
      const offsetKey = Buffer.from('xx-change-me-local-key-000000000').toString('base64');
      expect(() => validateEnv({ ...base, ENCRYPTION_KEY: offsetKey })).toThrow(/ENCRYPTION_KEY/);
      expect(() => validateEnv({ ...base, SESSION_KEY_ENC_KEY_k1: offsetKey })).toThrow(
        /SESSION_KEY_ENC_KEY_k1/,
      );
    });

    it.each(['development', 'test'])('DL-52 NFR-04: placeholders are accepted in %s', (APP_ENV) => {
      expect(() =>
        validateEnv({ ...valid, ...ph, APP_ENV, SESSION_KEY_ENC_KEY_k1: sessionKey }),
      ).not.toThrow();
    });
  });
});

describe('DL-55 FU-BE-224 NFR-04 APP_ENV is required, with no default', () => {
  const { APP_ENV: _unused, ...withoutAppEnv } = valid;
  void _unused;
  const good = {
    ...withoutAppEnv,
    JWT_CANDIDATE_SECRET: 'c'.repeat(40),
    OTP_PEPPER: 'd'.repeat(40),
    QUESTION_OPTION_ID_SECRET: 'q'.repeat(48),
    SESSION_KEY_ENC_KEY_k1: Buffer.alloc(32, 9).toString('base64'),
  };

  it('DL-55 FU-BE-224: an unset APP_ENV refuses to boot and the message names APP_ENV', () => {
    expect(() => validateEnv(good)).toThrow(/APP_ENV/);
    expect(() => validateEnv({ ...good, APP_ENV: undefined })).toThrow(/APP_ENV/);
  });

  it.each(['', 'prod', 'Production', 'dev', 'PRODUCTION', ' production', 'production ', 'live'])(
    'DL-55 FU-BE-224: APP_ENV %j refuses to boot, names APP_ENV and does not echo the value',
    (APP_ENV) => {
      let message = '';
      try {
        validateEnv({ ...good, APP_ENV });
      } catch (e) {
        message = String(e);
      }
      expect(message).toMatch(/APP_ENV/);
      // The fixed list of allowed values is the only place a value may appear; the received one is not.
      const rest = message.replace('development, test, staging, pilot, production', '');
      if (APP_ENV !== '') expect(rest).not.toContain(APP_ENV);
    },
  );

  it('DL-55 FU-BE-224: the error message echoes no secret value', () => {
    let message = '';
    try {
      validateEnv({ ...good, APP_ENV: 'prod' });
    } catch (e) {
      message = String(e);
    }
    expect(message).toMatch(/APP_ENV/);
    for (const v of [
      good.JWT_ACCESS_SECRET,
      good.COOKIE_SECRET,
      good.ENCRYPTION_KEY,
      good.OTP_PEPPER,
      good.SESSION_KEY_ENC_KEY_k1,
      good.DATABASE_URL,
    ]) {
      expect(message).not.toContain(v);
    }
  });

  it('DL-55 FU-BE-224: an unset, empty or misspelled APP_ENV still reports placeholder secrets (fails closed)', () => {
    const ph = { OTP_PEPPER: 'change-me-local-otp-pepper-0000000000000' };
    for (const APP_ENV of [undefined, '', 'prod', 'Production']) {
      expect(() => validateEnv({ ...good, ...ph, APP_ENV })).toThrow(/APP_ENV/);
      expect(() =>
        validateEnv({
          ...good,
          APP_ENV,
          SESSION_KEY_ENC_KEY_k1: Buffer.from('change-me-local-session-key-0001').toString(
            'base64',
          ),
        }),
      ).toThrow(/SESSION_KEY_ENC_KEY_k1/);
    }
  });

  it.each(['development', 'test', 'staging', 'pilot', 'production'])(
    'DL-55 FU-BE-224: APP_ENV=%s boots with the rest of a valid environment',
    (APP_ENV) => {
      expect(validateEnv({ ...good, APP_ENV, ...liveExtras(APP_ENV) }).APP_ENV).toBe(APP_ENV);
    },
  );

  it.each(['development', 'test', 'production'])(
    'DL-55 FU-BE-224: NODE_ENV=%s never relaxes a pilot or production APP_ENV',
    (NODE_ENV) => {
      for (const APP_ENV of ['pilot', 'production']) {
        const base = { ...good, APP_ENV, NODE_ENV, ...liveExtras(APP_ENV) };
        expect(() => validateEnv(base)).not.toThrow();
        // The live-only guards still apply: no wrapping key, http origin, API docs on.
        expect(() => validateEnv({ ...base, SESSION_KEY_ENC_KEY_k1: undefined })).toThrow(
          /SESSION_KEY_ENC_KEY_k1/,
        );
        expect(() => validateEnv({ ...base, WEB_ORIGIN: 'http://app.example.com' })).toThrow(
          /WEB_ORIGIN/,
        );
        expect(() => validateEnv({ ...base, ENABLE_API_DOCS: 'true' })).toThrow(/ENABLE_API_DOCS/);
      }
    },
  );

  it('DL-55 FU-BE-224: NODE_ENV stays optional (APP_ENV is the single authority)', () => {
    expect(validateEnv({ ...good, APP_ENV: 'development' }).NODE_ENV).toBe('development');
  });
});

describe('DL-55 FU-BE-225 NFR-04 placeholder database password', () => {
  const good = {
    ...valid,
    JWT_CANDIDATE_SECRET: 'c'.repeat(40),
    OTP_PEPPER: 'd'.repeat(40),
    QUESTION_OPTION_ID_SECRET: 'q'.repeat(48),
    SESSION_KEY_ENC_KEY_k1: Buffer.alloc(32, 9).toString('base64'),
  };
  const bad = 'postgresql://app_user:Change-Me@db.internal:5432/secretdb';
  const generated = 'postgresql://app_user:x7Kq9ZpL2mVw@db.internal:5432/secretdb';

  it.each(['staging', 'pilot', 'production'])(
    'DL-55 FU-BE-225: %s refuses a change-me DATABASE_URL password, names only the variable',
    (APP_ENV) => {
      const base = { ...good, APP_ENV, ...liveExtras(APP_ENV) };
      let message = '';
      try {
        validateEnv({ ...base, DATABASE_URL: bad });
      } catch (e) {
        message = String(e);
      }
      expect(message).toMatch(/DATABASE_URL/);
      for (const part of ['Change-Me', 'app_user', 'db.internal', 'secretdb'])
        expect(message).not.toContain(part);
      expect(() => validateEnv({ ...base, DATABASE_URL: generated })).not.toThrow();
      // An encoded placeholder is decoded before the check.
      expect(() =>
        validateEnv({ ...base, DATABASE_URL: 'postgresql://u:change%2Dme@db:5432/d' }),
      ).toThrow(/DATABASE_URL/);
    },
  );

  it('DL-55 FU-BE-225: NODE_ENV=production refuses it whatever APP_ENV says', () => {
    expect(() =>
      validateEnv({
        ...good,
        APP_ENV: 'development',
        NODE_ENV: 'production',
        ...liveExtras('pilot'),
        DATABASE_URL: bad,
      }),
    ).toThrow(/DATABASE_URL/);
  });

  it.each(['development', 'test'])(
    'DL-55 FU-BE-225: %s accepts the template password',
    (APP_ENV) => {
      expect(validateEnv({ ...good, APP_ENV, DATABASE_URL: bad }).APP_ENV).toBe(APP_ENV);
    },
  );

  // Each of these is a way the runtime driver (pg) would still end up with a change-me password.
  const bypasses: Record<string, string> = {
    'undecodable password refused': 'postgresql://u:change-me%ZZ@db.internal/secretdb',
    'encoded letter plus an invalid escape (pg restores %63)':
      'postgresql://u:%63hange-me%ZZ@db.internal/secretdb',
    'password query parameter, no userinfo password':
      'postgresql://app_user@db.internal:5432/secretdb?password=change-me',
    'password query parameter over a strong userinfo password':
      'postgresql://u:strongpw@db.internal/secretdb?password=change-me',
    'any password query parameter, even a strong one':
      'postgresql://u@db.internal/secretdb?password=x7Kq9ZpL2mVw',
    'unparseable URL (dummy-host fallback in pg)': 'postgresql://u:change-me@/secretdb',
  };
  const sharedCases: Array<[string, Record<string, string>]> = [
    ['staging', { APP_ENV: 'staging' }],
    ['pilot', { APP_ENV: 'pilot' }],
    ['production', { APP_ENV: 'production' }],
    ['NODE_ENV=production', { APP_ENV: 'development', NODE_ENV: 'production' }],
  ];

  describe.each(sharedCases)('DL-55 FU-BE-225 NFR-04 shared env %s', (_label, envVars) => {
    const base = { ...good, ...liveExtras('pilot'), ...envVars };

    it.each(Object.entries(bypasses))(
      'DL-55 FU-BE-225: refuses %s, naming DATABASE_URL and echoing no URL part',
      (_name, url) => {
        let message = '';
        try {
          validateEnv({ ...base, DATABASE_URL: url });
        } catch (e) {
          message = String(e);
        }
        expect(message).toMatch(/DATABASE_URL/);
        for (const part of ['change-me', 'app_user', 'db.internal', 'secretdb', 'strongpw'])
          expect(message).not.toContain(part);
      },
    );

    it('DL-55 FU-BE-225: a generated userinfo password and no password parameter is accepted', () => {
      expect(() =>
        validateEnv({ ...base, DATABASE_URL: `${generated}?sslmode=require` }),
      ).not.toThrow();
      expect(() =>
        validateEnv({
          ...base,
          DATABASE_URL: `${generated}?sslmode=require&application_name=x`,
        }),
      ).not.toThrow();
      // pg matches the parameter name case-sensitively, so Password=x is not a password override.
      expect(() => validateEnv({ ...base, DATABASE_URL: `${generated}?Password=x` })).not.toThrow();
    });

    it('DL-55 FU-BE-225: refuses a change-me PGPASSWORD, naming only the variable', () => {
      let message = '';
      try {
        validateEnv({ ...base, PGPASSWORD: 'Change-Me-pg-secret' });
      } catch (e) {
        message = String(e);
      }
      expect(message).toMatch(/PGPASSWORD/);
      expect(message).not.toContain('Change-Me');
      expect(() => validateEnv({ ...base, PGPASSWORD: 'x7Kq9ZpL2mVw' })).not.toThrow();
    });
  });

  it('DL-55 FU-BE-225: an invalid APP_ENV (fails closed) also reports a bad DATABASE_URL by name', () => {
    expect(() =>
      validateEnv({ ...good, APP_ENV: 'prod', DATABASE_URL: 'postgresql://u:change-me@/d' }),
    ).toThrow(/DATABASE_URL/);
  });

  it('DL-55 FU-BE-225: an invalid APP_ENV (fails closed) still refuses a change-me PGPASSWORD by name', () => {
    expect(() => validateEnv({ ...good, APP_ENV: 'prod', PGPASSWORD: 'change-me' })).toThrow(
      /PGPASSWORD/,
    );
  });

  it.each(['development', 'test'])(
    'DL-55 FU-BE-225: %s keeps accepting the template URL, a password parameter, an unparseable URL and PGPASSWORD',
    (APP_ENV) => {
      for (const DATABASE_URL of Object.values(bypasses))
        expect(validateEnv({ ...good, APP_ENV, DATABASE_URL }).APP_ENV).toBe(APP_ENV);
      expect(() => validateEnv({ ...good, APP_ENV, PGPASSWORD: 'change-me' })).not.toThrow();
    },
  );
});

/** Settings pilot and production need besides the secrets, so only the placeholders can fail. */
function liveExtras(appEnv: string): Record<string, string> {
  if (appEnv === 'staging') return {};
  return {
    JUDGE0_URL: 'http://127.0.0.1:2358',
    JUDGE0_AUTH_TOKEN: 'j'.repeat(40),
    JUDGE0_AUTHZ_TOKEN: 'k'.repeat(40),
    EMAIL_PROVIDER: 'ses',
    SES_FROM_ADDRESS: 'no-reply@example.com',
    WEB_ORIGIN: 'https://app.example.com',
    TRUST_PROXY_HOPS: '1',
    REQUIRE_LEGAL_APPROVED_CONSENT: 'true',
    // Object storage (BE-09) is required in pilot and production.
    S3_REGION: 'eu-west-2',
    S3_MEDIA_BUCKET: 'cp-pilot-media',
  };
}
