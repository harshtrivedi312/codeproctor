import { NextRequest } from 'next/server';
// Experimental Next API; rename here if a Next upgrade moves it.
import { unstable_doesMiddlewareMatch as doesMiddlewareMatch } from 'next/experimental/testing/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { config, middleware } from './middleware';

const cspFor = (path: string): string => {
  const response = middleware(new NextRequest(`https://app.example.test${path}`));
  return response.headers.get('Content-Security-Policy') ?? '';
};

afterEach(() => vi.unstubAllEnvs());

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

  it('matches the route from the parsed pathname, not the raw URL (query, dot segments, encoding)', () => {
    // The query string is not part of the path.
    expect(cspFor('/t/abc123/test?x=y')).toContain("'wasm-unsafe-eval'");
    // The URL parser resolves dot segments before the middleware sees them; neither resolves to
    // /t/<token>/test.
    expect(cspFor('/t/abc123/test/..')).not.toContain('wasm-unsafe-eval');
    expect(cspFor('/t/%2e%2e/test')).not.toContain('wasm-unsafe-eval');
    // An encoded slash stays in the token segment; it still routes to the test page.
    expect(cspFor('/t/a%2Fb/test')).toContain("'wasm-unsafe-eval'");
    // Case differences, repeated slashes and suffixes do not match (redirected or 404, always under
    // the strict policy).
    for (const path of [
      '/T/abc123/test',
      '/t/abc123/TEST',
      '//t/abc123/test',
      '/t/abc123//test',
      '/t/abc123/test%2F',
      '/t/abc123/test;x',
      '/t/abc123/testing',
    ]) {
      expect(cspFor(path), path).not.toContain('wasm-unsafe-eval');
    }
  });

  it("never allows 'unsafe-eval' or inline scripts in production, on any route", () => {
    vi.stubEnv('NODE_ENV', 'production');
    for (const path of ['/t/abc123/test', '/admin', '/']) {
      expect(cspFor(path), path).not.toMatch(/(?<!wasm-)unsafe-eval/);
      expect(cspFor(path), path).not.toMatch(/script-src[^;]*unsafe-inline/);
      expect(cspFor(path), path).toContain('upgrade-insecure-requests');
    }
  });

  it("allows 'unsafe-eval' in development only", () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect(cspFor('/admin')).toMatch(/script-src[^;]*'unsafe-eval'/);
    vi.stubEnv('NODE_ENV', 'production');
    expect(cspFor('/admin')).not.toMatch(/(?<!wasm-)unsafe-eval/);
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

describe('CSP middleware matcher (NFR-04)', () => {
  const runsFor = (url: string, headers?: Record<string, string>) =>
    doesMiddlewareMatch({ config, url, headers });

  it('runs on pages, including the candidate test route', () => {
    for (const url of ['/', '/admin', '/admin/login', '/t/abc123', '/t/abc123/test']) {
      expect(runsFor(url), url).toBe(true);
    }
  });

  it('skips static assets and router prefetches', () => {
    expect(runsFor('/_next/static/chunks/x.js')).toBe(false);
    expect(runsFor('/monaco/vs/loader.js')).toBe(false);
    expect(runsFor('/_next/image?url=%2Fx.png&w=64&q=75')).toBe(false);
    expect(runsFor('/mockServiceWorker.js')).toBe(false);
    expect(runsFor('/favicon.ico')).toBe(false);
    expect(runsFor('/t/abc123/test', { 'next-router-prefetch': '1' })).toBe(false);
    expect(runsFor('/t/abc123/test', { purpose: 'prefetch' })).toBe(false);
  });
});
