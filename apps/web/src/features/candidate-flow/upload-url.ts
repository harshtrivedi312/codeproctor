/**
 * Which presigned upload URLs the candidate pages will PUT to. https is always allowed. Plain http
 * is allowed only for a local host (the local MinIO of the demo returns http://localhost:9000/...)
 * and only in a development build; a mock build (throwaway, never deployed: the build guard in
 * next.config.ts) keeps its old allowance for any http URL. Everything else is refused, so a
 * production page can never be sent to an unencrypted or look-alike host.
 */
const LOCAL_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

export interface UploadUrlEnv {
  /** A development build (`next dev`). */
  development: boolean;
  /** A mock build (NEXT_PUBLIC_API_MOCKING=enabled). */
  mocking: boolean;
}

export function currentUploadUrlEnv(): UploadUrlEnv {
  // process.env.NODE_ENV is inlined by Next at build time: 'production' for next build. Both values
  // are read per call (not via lib/env.ts) so tests can stub them.
  return {
    development: process.env.NODE_ENV === 'development',
    mocking: process.env.NEXT_PUBLIC_API_MOCKING === 'enabled',
  };
}

export function isAllowedUploadUrl(
  value: string,
  env: UploadUrlEnv = currentUploadUrlEnv(),
): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  if (url.protocol !== 'http:') return false;
  if (env.mocking) return true;
  // The parsed hostname, never a prefix of the string: `http://localhost@evil.test/` and
  // `http://localhost.evil.test/` have other hosts.
  return env.development && LOCAL_HOSTS.has(url.hostname);
}
