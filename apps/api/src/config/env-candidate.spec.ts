import { validateEnv } from './env';

const valid = {
  DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/db',
  REDIS_URL: 'redis://127.0.0.1:6379',
  WEB_ORIGIN: 'http://localhost:3000',
  JWT_ACCESS_SECRET: 'a'.repeat(40),
  COOKIE_SECRET: 'b'.repeat(40),
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
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
    expect(validateEnv({ ...valid, ...candidate }).JWT_CANDIDATE_SECRET).toBe(candidate.JWT_CANDIDATE_SECRET);
  });

  it('NFR-04: placeholder candidate secrets are refused without echoing them', () => {
    expect(() => validateEnv({ ...valid, ...candidate, JWT_CANDIDATE_SECRET: 'change-me' })).toThrow(
      /JWT_CANDIDATE_SECRET/,
    );
    try {
      validateEnv({ ...valid, ...candidate, OTP_PEPPER: 'short-secret' });
      fail('expected throw');
    } catch (e) {
      expect(String(e)).toMatch(/OTP_PEPPER/);
      expect(String(e)).not.toContain('short-secret');
    }
  });

  it('NFR-04: pilot and production require the candidate secrets and Legal-approved consent', () => {
    // The code runner settings (FR-503) are required in these environments too.
    const judge0 = {
      JUDGE0_URL: 'https://judge0.example.com',
      JUDGE0_AUTH_TOKEN: 't'.repeat(32),
      JUDGE0_AUTHZ_TOKEN: 'z'.repeat(32),
    };
    for (const APP_ENV of ['pilot', 'production']) {
      expect(() => validateEnv({ ...valid, ...judge0, APP_ENV, REQUIRE_LEGAL_APPROVED_CONSENT: 'true' })).toThrow(
        /JWT_CANDIDATE_SECRET/,
      );
      expect(() => validateEnv({ ...valid, ...judge0, ...candidate, APP_ENV })).toThrow(
        /REQUIRE_LEGAL_APPROVED_CONSENT/,
      );
      expect(
        validateEnv({ ...valid, ...judge0, ...candidate, APP_ENV, REQUIRE_LEGAL_APPROVED_CONSENT: 'true' }).APP_ENV,
      ).toBe(APP_ENV);
    }
  });

  it('FR-609: the token lifetime and the ingest grace are bounded', () => {
    expect(() => validateEnv({ ...valid, CANDIDATE_TOKEN_TTL_SECONDS: '10' })).toThrow(/CANDIDATE_TOKEN_TTL_SECONDS/);
    expect(() => validateEnv({ ...valid, CANDIDATE_TOKEN_TTL_SECONDS: '999999' })).toThrow(/CANDIDATE_TOKEN_TTL_SECONDS/);
    expect(() => validateEnv({ ...valid, SESSION_KEY_ENC_ACTIVE_KID: 'bad kid' })).toThrow(/SESSION_KEY_ENC_ACTIVE_KID/);
    expect(validateEnv({ ...valid, CANDIDATE_TOKEN_TTL_SECONDS: '600' }).CANDIDATE_TOKEN_TTL_SECONDS).toBe(600);
  });
});
