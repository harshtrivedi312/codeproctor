import { validateEnv } from './env';

const valid = {
  // APP_ENV is required (DL-55).
  APP_ENV: 'development',
  DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/db',
  REDIS_URL: 'redis://127.0.0.1:6379',
  WEB_ORIGIN: 'http://localhost:3000',
  JWT_ACCESS_SECRET: 'a'.repeat(40),
  COOKIE_SECRET: 'b'.repeat(40),
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
};
const deployed = {
  ...valid,
  APP_ENV: 'pilot',
  WEB_ORIGIN: 'https://assess.example.com',
  TRUST_PROXY_HOPS: '1',
  JUDGE0_URL: 'https://judge0.internal.example',
  JUDGE0_AUTH_TOKEN: 'j'.repeat(40),
  JUDGE0_AUTHZ_TOKEN: 'z'.repeat(40),
  REQUIRE_LEGAL_APPROVED_CONSENT: 'true',
  JWT_CANDIDATE_SECRET: 'c'.repeat(40),
  OTP_PEPPER: 'd'.repeat(40),
  SESSION_KEY_ENC_KEY_k1: Buffer.alloc(32, 5).toString('base64'),
  // Pilot and production require SES (C-31); nothing is sent in this suite.
  EMAIL_PROVIDER: 'ses',
  SES_FROM_ADDRESS: 'no-reply@example.com',
};
const s3 = {
  S3_REGION: 'eu-west-2',
  S3_MEDIA_BUCKET: 'cp-pilot-media',
  S3_ACCESS_KEY_ID: 'AKIATESTKEY',
  S3_SECRET_ACCESS_KEY: 'test-secret-value-not-real',
};

describe('Object storage environment (BE-09, ADR 0001 section 2.1, FR-701)', () => {
  it('NFR-04: storage is optional locally and conditional writes default off', () => {
    const env = validateEnv(valid);
    expect(env.S3_MEDIA_BUCKET).toBeUndefined();
    expect(env.S3_FORCE_PATH_STYLE).toBe(false);
    expect(env.S3_CONDITIONAL_WRITES).toBe(false);
  });

  it('NFR-04: pilot and production require region and bucket', () => {
    expect(() => validateEnv(deployed)).toThrow(/S3_REGION.*S3_MEDIA_BUCKET|S3_MEDIA_BUCKET/);
    expect(validateEnv({ ...deployed, ...s3 }).S3_MEDIA_BUCKET).toBe('cp-pilot-media');
    expect(() =>
      validateEnv({ ...deployed, ...s3, APP_ENV: 'production', S3_REGION: undefined }),
    ).toThrow(/S3_REGION/);
  });

  it('NFR-04: staging may run on R2 with an endpoint, or without storage until configured', () => {
    expect(() => validateEnv({ ...valid, APP_ENV: 'staging' })).not.toThrow();
    const env = validateEnv({
      ...valid,
      APP_ENV: 'staging',
      ...s3,
      S3_REGION: 'auto',
      S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
    });
    expect(env.S3_ENDPOINT).toBe('https://acct.r2.cloudflarestorage.com');
  });

  it('NFR-04: the two keys come together (an instance role means neither), and a live endpoint is https', () => {
    expect(() => validateEnv({ ...valid, S3_ACCESS_KEY_ID: 'AKIATESTKEY' })).toThrow(
      /S3_SECRET_ACCESS_KEY/,
    );
    expect(() =>
      validateEnv({
        ...deployed,
        ...s3,
        S3_ACCESS_KEY_ID: undefined,
        S3_SECRET_ACCESS_KEY: undefined,
      }),
    ).not.toThrow();
    expect(() =>
      validateEnv({ ...deployed, ...s3, S3_ENDPOINT: 'http://storage.example.com' }),
    ).toThrow(/S3_ENDPOINT/);
  });

  it('NFR-04: pilot and production accept only an unset or *.amazonaws.com endpoint, never R2', () => {
    for (const APP_ENV of ['pilot', 'production']) {
      for (const bad of [
        'https://acct.r2.cloudflarestorage.com',
        'https://amazonaws.com.evil.example',
        'http://s3.eu-west-2.amazonaws.com',
      ]) {
        expect(() => validateEnv({ ...deployed, ...s3, APP_ENV, S3_ENDPOINT: bad })).toThrow(
          /S3_ENDPOINT/,
        );
      }
      expect(
        validateEnv({
          ...deployed,
          ...s3,
          APP_ENV,
          S3_ENDPOINT: 'https://s3.eu-west-2.amazonaws.com',
        }).S3_ENDPOINT,
      ).toBe('https://s3.eu-west-2.amazonaws.com');
    }
  });

  it('NFR-04: a bad bucket name is refused and the secret value is never echoed', () => {
    try {
      validateEnv({ ...valid, ...s3, S3_MEDIA_BUCKET: 'Bad_Bucket!' });
      throw new Error('should have thrown');
    } catch (e) {
      const message = String((e as Error).message);
      expect(message).toMatch(/S3_MEDIA_BUCKET/);
      expect(message).not.toContain(s3.S3_SECRET_ACCESS_KEY);
    }
  });
});
