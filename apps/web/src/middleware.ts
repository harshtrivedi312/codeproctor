import { NextResponse, type NextRequest } from 'next/server';
import { buildCsp, generateNonce, parseOrigins } from '@/lib/csp';

/**
 * Sets a strict CSP with a per-request nonce on every page response (NFR-04). Next.js reads the
 * nonce from the request's CSP header and stamps it on its own inline and bootstrap scripts.
 */
export function middleware(request: NextRequest): NextResponse {
  const nonce = generateNonce();
  const csp = buildCsp({
    nonce,
    apiOrigin: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000',
    uploadOrigins: parseOrigins(process.env.NEXT_PUBLIC_UPLOAD_ORIGINS),
    isDev: process.env.NODE_ENV === 'development',
  });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  matcher: [
    {
      // Skip static assets (Monaco, the MSW worker, Next static files). Prefetches keep the CSP.
      source: '/((?!_next/static|_next/image|monaco/|mockServiceWorker\\.js|favicon\\.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
