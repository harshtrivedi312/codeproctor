import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  turbopack: {
    // msw/browser has "node": null in its exports, which breaks the server pass of the bundler even
    // though the worker only ever starts in the browser. Serve a stub on the server pass.
    resolveAlias: {
      'msw/browser': { browser: 'msw/browser', default: './src/mocks/browser-stub.ts' },
    },
  },
  // The CSP (with a per-request nonce) is set in src/middleware.ts, not here.
  headers() {
    return Promise.resolve([
      {
        // Pages reached from an emailed single-use link (FR-107, ADR 0003 section 4): the token must
        // never leave in a Referer header or be cached. Repeated on purpose so a change to the
        // global policy cannot weaken it.
        source: '/admin/:page(reset-password|set-password)',
        headers: [
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'Cache-Control', value: 'no-store' },
        ],
      },
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Frame-Options', value: 'DENY' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(self), microphone=(), display-capture=(self), fullscreen=(self)',
          },
        ],
      },
    ]);
  },
};

export default nextConfig;
