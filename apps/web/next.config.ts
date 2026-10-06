import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // The SDK is consumed as TypeScript source (workspace package).
  transpilePackages: ['@codeproctor/proctor-sdk'],
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
      // DL-28: the candidate routes need the microphone (FR-402 mic check, FR-607 voice detector,
      // FR-701 audio recording; the consent document covers it). Listed after the global rule so it
      // overrides it for /t/<token> and below only. Camera, display-capture and fullscreen are
      // unchanged; staff pages and every other route keep microphone=().
      {
        source: '/t/:path+',
        headers: [
          {
            key: 'Permissions-Policy',
            value: 'camera=(self), microphone=(self), display-capture=(self), fullscreen=(self)',
          },
        ],
      },
      // Dev only, listed last so it overrides the global policy for this one path. The
      // /dev/proctor demo needs the microphone for the voice detector, which the global policy
      // blocks. Not emitted in production builds; every other route is unchanged.
      ...(process.env.NODE_ENV === 'production'
        ? []
        : [
            {
              source: '/dev/proctor',
              headers: [
                {
                  key: 'Permissions-Policy',
                  value:
                    'camera=(self), microphone=(self), display-capture=(self), fullscreen=(self)',
                },
              ],
            },
          ]),
    ]);
  },
};

export default nextConfig;
