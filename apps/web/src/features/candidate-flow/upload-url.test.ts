import { afterEach, describe, expect, it, vi } from 'vitest';
import { isAllowedUploadUrl } from './upload-url';
import { mediaPresignSchema, presignSchema } from './wire';

const prod = { development: false, mocking: false };
const dev = { development: true, mocking: false };
const mock = { development: false, mocking: true };

describe('upload URL rule (FR-402, FR-403, FR-701; D-61 local MinIO demo)', () => {
  it('FR-701: https is allowed everywhere', () => {
    for (const env of [prod, dev, mock]) {
      expect(isAllowedUploadUrl('https://bucket.s3.amazonaws.com/x?sig=1', env)).toBe(true);
    }
  });

  it('FR-701: http to localhost, 127.0.0.1 and [::1] is allowed in a development build only', () => {
    for (const u of [
      'http://localhost:9000/bucket/identity/1/id-1.jpg',
      'http://127.0.0.1:9000/bucket/x',
      'http://[::1]:9000/bucket/x',
    ]) {
      expect(isAllowedUploadUrl(u, dev)).toBe(true);
      expect(isAllowedUploadUrl(u, prod)).toBe(false);
    }
  });

  it('FR-701: http to any other host is refused even in a development build', () => {
    for (const u of [
      'http://example.com/bucket/x',
      'http://localhost.evil.test/x',
      'http://localhost@evil.test/x',
      'http://127.0.0.1.evil.test/x',
      'http://192.168.0.13:9000/x',
      'http://0.0.0.0:9000/x',
      'http://localhost:9000@evil.test/x',
      'http://localhost./x',
      'http://[::ffff:127.0.0.1]/x',
      'http://evil.test\\@localhost/x',
      'http:\\\\evil.test\\x',
      'http://127.0.0.2/x',
    ]) {
      expect(isAllowedUploadUrl(u, dev)).toBe(false);
      expect(isAllowedUploadUrl(u, prod)).toBe(false);
    }
  });

  it('FR-701: loopback spellings the URL parser normalises are allowed in a development build', () => {
    for (const u of ['http://LOCALHOST:9000/x', 'http://[0:0:0:0:0:0:0:1]:9000/x']) {
      expect(isAllowedUploadUrl(u, dev)).toBe(true);
    }
  });

  it('FR-701: other schemes and junk are refused', () => {
    for (const u of [
      'ftp://localhost/x',
      'javascript:alert(1)',
      'file:///etc/passwd',
      'not a url',
      '',
    ]) {
      expect(isAllowedUploadUrl(u, dev)).toBe(false);
    }
  });

  it('FR-701: a mock build keeps allowing http (throwaway build, guarded in next.config.ts)', () => {
    expect(isAllowedUploadUrl('http://localhost:4000/mock-upload/1', mock)).toBe(true);
  });
});

describe('the presign schemas apply the rule (FR-701, D-61)', () => {
  afterEach(() => vi.unstubAllEnvs());
  const headers = { 'Content-Type': 'image/jpeg' };
  const identity = (url: string) =>
    presignSchema.safeParse({
      url,
      method: 'PUT',
      headers,
      evidenceKey: 'identity/1/id-01.jpg',
      expiresAt: '2026-10-09T10:00:00.000Z',
    }).success;
  const media = (url: string) =>
    mediaPresignSchema.safeParse({
      url,
      method: 'PUT',
      headers: { 'Content-Type': 'video/webm' },
      expiresAt: '2026-10-09T10:00:00.000Z',
    }).success;

  it('FR-701: in a development build local MinIO http URLs are accepted, other http hosts are refused', () => {
    vi.stubEnv('NODE_ENV', 'development');
    for (const check of [identity, media]) {
      expect(check('http://localhost:9000/bucket/identity/1/id-1.jpg?X-Amz-Signature=1')).toBe(
        true,
      );
      expect(check('https://bucket.s3.amazonaws.com/x')).toBe(true);
      expect(check('http://example.com/bucket/x')).toBe(false);
      expect(check('http://localhost.evil.test/x')).toBe(false);
    }
  });

  it('FR-701: a mock build keeps accepting its http mock-upload URLs through the schemas', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_API_MOCKING', 'enabled');
    for (const check of [identity, media]) {
      expect(check('http://localhost:4000/mock-upload/1')).toBe(true);
    }
  });

  it('FR-701: in a production build http is refused, localhost included', () => {
    vi.stubEnv('NODE_ENV', 'production');
    for (const check of [identity, media]) {
      expect(check('http://localhost:9000/bucket/x')).toBe(false);
      expect(check('https://bucket.s3.amazonaws.com/x')).toBe(true);
    }
  });
});
