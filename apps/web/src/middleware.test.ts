import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { middleware } from './middleware';

const cspFor = (path: string): string => {
  const response = middleware(new NextRequest(`https://app.example.test${path}`));
  return response.headers.get('Content-Security-Policy') ?? '';
};

describe('CSP middleware (D-45 (P-05))', () => {
  it("adds 'wasm-unsafe-eval' on the candidate test route", () => {
    expect(cspFor('/t/abc123/test')).toContain("'wasm-unsafe-eval'");
  });

  it("does not add 'wasm-unsafe-eval' on staff pages or any other route", () => {
    for (const path of [
      '/',
      '/admin',
      '/admin/login',
      '/admin/security',
      '/admin/settings/users',
      '/t/abc123',
      '/t/abc123/consent',
      '/t/abc123/test/extra',
      '/errors/expired',
    ]) {
      expect(cspFor(path), path).not.toContain('wasm-unsafe-eval');
    }
  });

  it("never allows 'unsafe-eval' or inline scripts in production, on any route", () => {
    for (const path of ['/t/abc123/test', '/admin', '/']) {
      expect(cspFor(path), path).not.toMatch(/(?<!wasm-)unsafe-eval/);
      expect(cspFor(path), path).not.toMatch(/script-src[^;]*unsafe-inline/);
    }
  });

  it('uses a fresh nonce for every request', () => {
    const nonceOf = (csp: string) => /'nonce-([^']+)'/.exec(csp)?.[1];
    const first = nonceOf(cspFor('/t/abc123/test'));
    const second = nonceOf(cspFor('/t/abc123/test'));
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(first).not.toBe(second);
  });
});
