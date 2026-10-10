import { describe, expect, it } from 'vitest';
import { buildCsp, isCandidateTestPath, parseOrigins, uploadOriginsFor } from './csp';

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
  it('FR-703: a dev server with no configured upload origin allows the local MinIO; production never does', () => {
    expect(uploadOriginsFor([], true)).toEqual(['http://127.0.0.1:9000']);
    expect(uploadOriginsFor([], false)).toEqual([]);
    expect(uploadOriginsFor(['https://s3.example.com'], true)).toEqual(['https://s3.example.com']);
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

  it('D-45 (P-05): script-src has no wasm-unsafe-eval unless asked for', () => {
    expect(buildCsp(base)).not.toContain('wasm-unsafe-eval');
    expect(buildCsp({ ...base, allowWasm: false })).not.toContain('wasm-unsafe-eval');
  });
  it("D-45 (P-05): allowWasm adds 'wasm-unsafe-eval' to script-src only, never 'unsafe-eval'", () => {
    const csp = buildCsp({ ...base, allowWasm: true });
    expect(csp).toContain("script-src 'self' 'nonce-abc123' 'strict-dynamic' 'wasm-unsafe-eval';");
    expect(csp.match(/wasm-unsafe-eval/g)).toHaveLength(1);
    expect(csp).not.toMatch(/(?<!wasm-)unsafe-eval/);
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    // Every other directive is identical to the strict policy.
    const strip = (value: string) => value.replace(" 'wasm-unsafe-eval'", '');
    expect(strip(csp)).toBe(buildCsp(base));
  });
  it("D-45 (P-05): development keeps 'unsafe-eval' and gains 'wasm-unsafe-eval' only when asked", () => {
    const csp = buildCsp({ ...base, isDev: true, allowWasm: true });
    expect(csp).toMatch(/script-src[^;]*'unsafe-eval'/);
    expect(csp).toMatch(/script-src[^;]*'wasm-unsafe-eval'/);
    expect(buildCsp({ ...base, isDev: true })).not.toContain('wasm-unsafe-eval');
  });
  it('D-45 (P-05): only /t/link and /t/[token]/test count as the candidate test document', () => {
    for (const path of [
      '/t/abc123/test',
      '/t/abc123/test/',
      '/t/demo/test',
      '/t/link',
      '/t/link/',
    ]) {
      expect(isCandidateTestPath(path)).toBe(true);
    }
    for (const path of [
      '/',
      '/admin',
      '/admin/login',
      '/admin/security',
      '/t/abc123',
      '/t/abc123/',
      '/t/abc123/consent',
      '/t/abc123/test/extra',
      '/t//test',
      '/t/a/b/test',
      '/x/t/abc123/test',
      '/t/abc123/testing',
      '/t/start',
      '/t/phone',
      '/t/link/extra',
      '/t/linkx',
      '/T/link',
      '/t/link;x',
      '/errors/expired',
      '/dev/proctor',
    ]) {
      expect(isCandidateTestPath(path)).toBe(false);
    }
  });
});
