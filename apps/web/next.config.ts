import type { NextConfig } from 'next';

/**
 * Mock mode must never be baked into a production build: it would serve fake data and unlock demo
 * routes. NEXT_PUBLIC_API_MOCKING is inlined at build time, so the build is the place to stop it.
 * The one allowed exception is a throwaway build for CI or QA that sets
 * ALLOW_MOCKING_IN_PRODUCTION_BUILD=staging-only. Never use it for any image that gets deployed.
 */
export function assertNoMockingInProductionBuild(env: NodeJS.ProcessEnv): void {
  // No NODE_ENV condition: the flag is inlined into the bundles whatever NODE_ENV says (for
  // example `NODE_ENV=development next build`), so any build with it enabled is refused.
  if (
    env.NEXT_PUBLIC_API_MOCKING === 'enabled' &&
    env.ALLOW_MOCKING_IN_PRODUCTION_BUILD !== 'staging-only'
  ) {
    throw new Error(
      'Refusing to build: NEXT_PUBLIC_API_MOCKING=enabled in a build. ' +
        'Unset NEXT_PUBLIC_API_MOCKING. For a CI or QA throwaway build only, set ' +
        'ALLOW_MOCKING_IN_PRODUCTION_BUILD=staging-only.',
    );
  }
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Always inline the mock flag, even when it is unset at build time. An unset NEXT_PUBLIC_ variable
  // is otherwise NOT replaced: server code would read the runtime environment (so a runtime
  // NEXT_PUBLIC_API_MOCKING=enabled could unlock the demo test page) and the mock chunks would stay
  // in the bundle. Inlined as '', the mock code is dropped from the build.
  env: { NEXT_PUBLIC_API_MOCKING: process.env.NEXT_PUBLIC_API_MOCKING ?? '' },
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

// Only for `next build` (Next does not set NEXT_PHASE while loading this file): `next start` of an
// already built (allowed) mock build must still run, and tests import this file.
if (process.argv.includes('build')) assertNoMockingInProductionBuild(process.env);

export default nextConfig;
