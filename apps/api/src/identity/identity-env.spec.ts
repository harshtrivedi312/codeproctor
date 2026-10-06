// WORKER_* settings (BE-08b; ADR 0014 4.3, 4.4). Requiring them in pilot and production is a go-live
// check (DEP-02, FU-INB-36), not enforced here: other tracks' live-environment specs would need it.
import { randomBytes } from 'node:crypto';
import { validateEnv } from '../config/env';

const base = {
  DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/db',
  REDIS_URL: 'redis://127.0.0.1:6379',
  WEB_ORIGIN: 'http://localhost:3000',
  JWT_ACCESS_SECRET: 'a'.repeat(40),
  COOKIE_SECRET: 'b'.repeat(40),
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
};
const key = randomBytes(32).toString('base64');
const worker = {
  WORKER_BASE_URL: 'http://worker:8000',
  WORKER_HMAC_KEY_ID: 'k1',
  WORKER_HMAC_KEY: key,
};

describe('Identity worker settings (FR-403, ADR 0014 4.3, 4.4)', () => {
  it('FR-403: all three unset is fine locally; all three set is accepted', () => {
    expect(validateEnv(base).WORKER_BASE_URL).toBeUndefined();
    expect(validateEnv({ ...base, ...worker }).WORKER_BASE_URL).toBe('http://worker:8000');
  });

  it('FR-403: setting only some of the three is refused, and a short key is refused without echoing it', () => {
    expect(() => validateEnv({ ...base, WORKER_BASE_URL: worker.WORKER_BASE_URL })).toThrow(
      /must be set together/,
    );
    try {
      validateEnv({ ...base, ...worker, WORKER_HMAC_KEY: 'c2hvcnQ=' });
      fail('expected throw');
    } catch (e) {
      expect(String(e)).toContain('WORKER_HMAC_KEY');
      expect(String(e)).not.toContain('c2hvcnQ=');
    }
  });

  it('ADR 0014 4.4: the worker URL is an origin, and plain http is refused off the host network in production', () => {
    for (const WORKER_BASE_URL of [
      'http://worker:8000/v1',
      'http://u:p@worker:8000',
      'http://worker:8000/?x=1',
      'ftp://worker:8000',
    ]) {
      expect(() => validateEnv({ ...base, ...worker, WORKER_BASE_URL })).toThrow(/WORKER_BASE_URL/);
    }
    const prod = {
      ...base,
      ...worker,
      NODE_ENV: 'production',
      APP_ENV: 'staging',
      WEB_ORIGIN: 'https://app.example.test',
      TRUST_PROXY_HOPS: '1',
      REQUIRE_LEGAL_APPROVED_CONSENT: 'true',
      JUDGE0_URL: 'https://judge0.internal.example.test',
      JUDGE0_AUTH_TOKEN: 'j'.repeat(40),
      JUDGE0_AUTHZ_TOKEN: 'z'.repeat(40),
      JWT_CANDIDATE_SECRET: 'c'.repeat(40),
      OTP_PEPPER: 'o'.repeat(40),
      S3_REGION: 'us-east-1',
      S3_MEDIA_BUCKET: 'cp-test-media',
      SESSION_KEY_ENC_ACTIVE_KID: 'k1',
      SESSION_KEY_ENC_KEY_k1: randomBytes(32).toString('base64'),
    };
    expect(() =>
      validateEnv({ ...prod, WORKER_BASE_URL: 'http://worker.example.test:8000' }),
    ).toThrow(/https/);
    expect(validateEnv({ ...prod, WORKER_BASE_URL: 'https://worker.example.test' })).toBeDefined();
    expect(validateEnv({ ...prod, WORKER_BASE_URL: 'http://worker:8000' })).toBeDefined();
  });
});
