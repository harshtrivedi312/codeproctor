/**
 * Content Security Policy builder (NFR-04, FE-01).
 *
 * Pure function so it can be unit-tested; src/middleware.ts calls it once per request with a fresh
 * nonce. Only Web APIs are used so it also runs on the edge runtime (Cloudflare Pages, R-08).
 */

export interface CspOptions {
  /** Per-request nonce, base64. Next.js applies it to its own scripts. */
  nonce: string;
  /** Origin of the API (NEXT_PUBLIC_API_URL). */
  apiOrigin: string;
  /**
   * Origins that accept direct uploads from the browser: Cloudflare R2 on staging, AWS S3 on pilot
   * and production (NEXT_PUBLIC_UPLOAD_ORIGINS, comma or space separated). Empty until Step 7+.
   */
  uploadOrigins?: readonly string[];
  /** `next dev` only: adds the minimum Next.js and React dev tooling needs. */
  isDev?: boolean;
  /**
   * Adds 'wasm-unsafe-eval' to script-src. Only the candidate test route gets it (see
   * `isCandidateTestPath`); every other route stays without it.
   */
  allowWasm?: boolean;
}

/**
 * The candidate test screen, /t/[token]/test, and nothing else (D-45 (P-05)). The pre-test
 * stepper and every other route do not match. A document keeps the CSP it was loaded with, so
 * entry to /t/[token]/test must be a full document navigation (window.location.assign or a server
 * redirect), not a client-side router push from another candidate page. The reverse holds too:
 * a client-side navigation out of the test route keeps the allowance, so keep links out of it.
 */
export function isCandidateTestPath(pathname: string): boolean {
  return /^\/t\/[^/]+\/test\/?$/.test(pathname);
}

/** Reduces a URL to its origin; returns null for anything that is not an http(s) URL. */
export function toOrigin(value: string): string | null {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

export function parseOrigins(list: string | undefined): string[] {
  if (!list) return [];
  return list
    .split(/[\s,]+/)
    .map(toOrigin)
    .filter((origin): origin is string => origin !== null);
}

export function buildCsp({
  nonce,
  apiOrigin,
  uploadOrigins = [],
  isDev = false,
  allowWasm = false,
}: CspOptions): string {
  const api = toOrigin(apiOrigin);

  // connect-src: the web origin itself (Next.js fetches RSC payloads from it), the API, and the
  // object-storage upload endpoint. Nothing else.
  const connect = ["'self'", ...(api ? [api] : []), ...uploadOrigins];
  // Dev only: Turbopack/webpack hot reload talks to the dev server over a WebSocket.
  if (isDev) connect.push('ws://localhost:*', 'ws://127.0.0.1:*');

  const script = [`'self'`, `'nonce-${nonce}'`, "'strict-dynamic'"];
  // Dev only: React in development uses eval to rebuild server call stacks in the browser.
  // Never emitted in production builds.
  if (isDev) script.push("'unsafe-eval'");
  // D-45 (P-05): the in-browser detectors (MediaPipe, onnxruntime-web and the tfjs wasm backends)
  // must compile WebAssembly, which needs 'wasm-unsafe-eval'. It allows WebAssembly compilation
  // only, not eval() or new Function(), and is added for the candidate test route only. Model
  // files are served from our own origin, so connect-src and script-src gain nothing else.
  if (allowWasm) script.push("'wasm-unsafe-eval'");

  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': script,
    // 'unsafe-inline' for styles only: Monaco and Radix inject style attributes at runtime and
    // cannot carry a nonce. Scripts stay nonce-only. Revisit with Monaco's CSP guidance (R-08).
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:'],
    'font-src': ["'self'", 'data:'],
    'connect-src': connect,
    // Monaco spawns its language workers from blob: URLs. Also the MSW service worker (mock mode).
    'worker-src': ["'self'", 'blob:'],
    'media-src': ["'self'", 'blob:'],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'none'"],
    'frame-src': ["'none'"],
  };

  const parts = Object.entries(directives).map(([name, values]) => `${name} ${values.join(' ')}`);
  if (!isDev) parts.push('upgrade-insecure-requests');
  return parts.join('; ');
}

export function generateNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
