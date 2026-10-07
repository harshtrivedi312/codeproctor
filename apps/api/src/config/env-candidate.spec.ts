import { validateEnv } from './env';

const valid = {
  DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/db',
  REDIS_URL: 'redis://127.0.0.1:6379',
  WEB_ORIGIN: 'http://localhost:3000',
  JWT_ACCESS_SECRET: 'a'.repeat(40),
  COOKIE_SECRET: 'b'.repeat(40),
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
};
// Settings pilot and production need besides the candidate ones (FR-503, FU-BE-97).
const judge0 = {
  EMAIL_PROVIDER: 'ses',
  SES_FROM_ADDRESS: 'no-reply@example.com',
  WEB_ORIGIN: 'https://app.example.com',
  TRUST_PROXY_HOPS: '1',
  JUDGE0_URL: 'https://judge0.example.com',
  // Object storage (BE-09) is required in pilot and production too.
  S3_REGION: 'eu-west-2',
  S3_MEDIA_BUCKET: 'cp-pilot-media',
  JUDGE0_AUTH_TOKEN: 't'.repeat(32),
  JUDGE0_AUTHZ_TOKEN: 'z'.repeat(32),
};
const candidate = {
  JWT_CANDIDATE_SECRET: 'c'.repeat(40),
  OTP_PEPPER: 'd'.repeat(40),
};

describe('Candidate session environment (BE-07, ADR 0003, ADR 0007 section 6, ADR 0013 section 2)', () => {
  it('NFR-04: the candidate secrets are optional locally and the defaults are the documented ones', () => {
    const env = validateEnv(valid);
    expect(env.JWT_CANDIDATE_SECRET).toBeUndefined();
    expect(env.OTP_PEPPER).toBeUndefined();
    expect(env.SESSION_KEY_ENC_ACTIVE_KID).toBe('k1');
    expect(env.CANDIDATE_TOKEN_TTL_SECONDS).toBe(900);
    expect(env.PROCTOR_INGEST_GRACE_SECONDS).toBe(300);
    expect(env.REQUIRE_LEGAL_APPROVED_CONSENT).toBe(false);
  });

  it('NFR-04: the candidate JWT secret must differ from the staff secret, so a staff token never verifies', () => {
    expect(() =>
      validateEnv({ ...valid, ...candidate, JWT_CANDIDATE_SECRET: valid.JWT_ACCESS_SECRET }),
    ).toThrow(/JWT_CANDIDATE_SECRET/);
    expect(validateEnv({ ...valid, ...candidate }).JWT_CANDIDATE_SECRET).toBe(
      candidate.JWT_CANDIDATE_SECRET,
    );
  });

  it('NFR-04: placeholder candidate secrets are refused without echoing them', () => {
    expect(() =>
      validateEnv({ ...valid, ...candidate, JWT_CANDIDATE_SECRET: 'change-me' }),
    ).toThrow(/JWT_CANDIDATE_SECRET/);
    try {
      validateEnv({ ...valid, ...candidate, OTP_PEPPER: 'short-secret' });
      fail('expected throw');
    } catch (e) {
      expect(String(e)).toMatch(/OTP_PEPPER/);
      expect(String(e)).not.toContain('short-secret');
    }
  });

  it('NFR-04: pilot and production require the candidate secrets and Legal-approved consent', () => {
    for (const APP_ENV of ['pilot', 'production']) {
      expect(() =>
        validateEnv({ ...valid, ...judge0, APP_ENV, REQUIRE_LEGAL_APPROVED_CONSENT: 'true' }),
      ).toThrow(/JWT_CANDIDATE_SECRET/);
      expect(() => validateEnv({ ...valid, ...judge0, ...candidate, APP_ENV })).toThrow(
        /REQUIRE_LEGAL_APPROVED_CONSENT/,
      );
      expect(
        validateEnv({
          ...valid,
          ...judge0,
          ...candidate,
          APP_ENV,
          REQUIRE_LEGAL_APPROVED_CONSENT: 'true',
          SESSION_KEY_ENC_KEY_k1: Buffer.alloc(32, 4).toString('base64'),
        }).APP_ENV,
      ).toBe(APP_ENV);
    }
  });

  it('NFR-04: pilot and production refuse to start without a valid wrapping key for the active kid', () => {
    const live = {
      ...valid,
      ...candidate,
      ...judge0,
      APP_ENV: 'pilot',
      REQUIRE_LEGAL_APPROVED_CONSENT: 'true',
    };
    const key = Buffer.alloc(32, 5).toString('base64');
    expect(() => validateEnv(live)).toThrow(/SESSION_KEY_ENC_KEY_k1/);
    expect(() => validateEnv({ ...live, SESSION_KEY_ENC_KEY_k1: 'c2hvcnQ=' })).toThrow(
      /SESSION_KEY_ENC_KEY_k1/,
    );
    expect(() =>
      validateEnv({ ...live, SESSION_KEY_ENC_ACTIVE_KID: 'k2', SESSION_KEY_ENC_KEY_k1: key }),
    ).toThrow(/SESSION_KEY_ENC_KEY_k2/);
    try {
      validateEnv({ ...live, SESSION_KEY_ENC_KEY_k1: 'not-the-key-just-some-text' });
      fail('expected throw');
    } catch (e) {
      expect(String(e)).not.toContain('not-the-key-just-some-text');
    }
    expect(validateEnv({ ...live, SESSION_KEY_ENC_KEY_k1: key }).APP_ENV).toBe('pilot');
    expect(
      validateEnv({
        ...live,
        APP_ENV: 'production',
        SESSION_KEY_ENC_ACTIVE_KID: 'k2',
        SESSION_KEY_ENC_KEY_k2: key,
      }).APP_ENV,
    ).toBe('production');
    // Development and test do not need it at start.
    expect(validateEnv(valid).APP_ENV).toBe('development');
  });

  it('FR-609: the token lifetime and the ingest grace are bounded', () => {
    expect(() => validateEnv({ ...valid, CANDIDATE_TOKEN_TTL_SECONDS: '10' })).toThrow(
      /CANDIDATE_TOKEN_TTL_SECONDS/,
    );
    expect(() => validateEnv({ ...valid, CANDIDATE_TOKEN_TTL_SECONDS: '999999' })).toThrow(
      /CANDIDATE_TOKEN_TTL_SECONDS/,
    );
    expect(() => validateEnv({ ...valid, SESSION_KEY_ENC_ACTIVE_KID: 'bad kid' })).toThrow(
      /SESSION_KEY_ENC_ACTIVE_KID/,
    );
    expect(
      validateEnv({ ...valid, CANDIDATE_TOKEN_TTL_SECONDS: '600' }).CANDIDATE_TOKEN_TTL_SECONDS,
    ).toBe(600);
  });
});
