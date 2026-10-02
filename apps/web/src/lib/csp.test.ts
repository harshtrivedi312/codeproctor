import { describe, expect, it } from 'vitest';
import { buildCsp, parseOrigins } from './csp';

describe('CSP (NFR-04)', () => {
  const base = { nonce: 'abc123', apiOrigin: 'https://api.example.com/v1' };

  it('uses the nonce for scripts and never allows inline or eval scripts in production', () => {
    const csp = buildCsp(base);
    expect(csp).toContain("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-(inline|eval)/);
    expect(csp).toContain('upgrade-insecure-requests');
  });
  it('limits connect-src to the web origin, the API and the upload endpoints', () => {
    const csp = buildCsp({
      ...base,
      uploadOrigins: parseOrigins(
        'https://acct.r2.cloudflarestorage.com, https://bucket.s3.eu-west-1.amazonaws.com/x',
      ),
    });
    expect(csp).toContain(
      "connect-src 'self' https://api.example.com https://acct.r2.cloudflarestorage.com https://bucket.s3.eu-west-1.amazonaws.com;",
    );
  });
  it('adds only the dev allowances in development', () => {
    const csp = buildCsp({ ...base, isDev: true });
    expect(csp).toContain("'unsafe-eval'");
    expect(csp).toContain('ws://localhost:*');
    expect(csp).not.toContain('upgrade-insecure-requests');
  });
  it('drops values that are not http(s) origins', () => {
    expect(parseOrigins('javascript:alert(1) not-a-url https://ok.example.com')).toEqual([
      'https://ok.example.com',
    ]);
  });
  it('blocks framing, plugins and base tag tricks', () => {
    const csp = buildCsp(base);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
  });
});
