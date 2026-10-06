import { afterEach, describe, expect, it, vi } from 'vitest';
import { unstable_getResponseFromNextConfig } from 'next/experimental/testing/server';
import { nextConfig } from '../next.config';

type Rule = { source: string; headers: { key: string; value: string }[] };

async function rules(): Promise<Rule[]> {
  return (await nextConfig.headers?.()) as Rule[];
}
const policy = (r: Rule | undefined) =>
  r?.headers.find((h) => h.key === 'Permissions-Policy')?.value;

afterEach(() => vi.unstubAllEnvs());

describe('Permissions-Policy for /dev/proctor (FR-607, dev-only override)', () => {
  it('FR-607: production has no /dev/proctor override and keeps microphone=() globally', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const rs = await rules();
    expect(rs.some((r) => r.source === '/dev/proctor')).toBe(false);
    expect(policy(rs.find((r) => r.source === '/:path*'))).toContain('microphone=()');
  });

  it('FR-607: development lists the override after the global rule, with microphone=(self)', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const rs = await rules();
    const global = rs.findIndex((r) => r.source === '/:path*');
    const dev = rs.findIndex((r) => r.source === '/dev/proctor');
    expect(dev).toBeGreaterThan(global);
    expect(policy(rs[dev])).toContain('microphone=(self)');
    expect(policy(rs[global])).toContain('microphone=()');
  });
});

// DL-28: the microphone is allowed on the candidate routes only (FR-402, FR-607, FR-701). These
// tests run each URL through Next's own header matching, so they check the policy a browser gets.
describe('Permissions-Policy: microphone on candidate routes only (DL-28)', () => {
  const effective = async (path: string): Promise<string | null> => {
    const response = await unstable_getResponseFromNextConfig({
      url: `https://app.example.test${path}`,
      nextConfig,
    });
    return response.headers.get('Permissions-Policy');
  };

  it('FR-402: /t/<token> and /t/<token>/test allow the microphone for the site itself', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    for (const path of ['/t/abc123', '/t/abc123/test', '/t/abc123/consent']) {
      expect(await effective(path), path).toBe(
        'camera=(self), microphone=(self), display-capture=(self), fullscreen=(self)',
      );
    }
  });

  it('FR-402: the staff area, the landing page and every other route keep microphone=()', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    for (const path of [
      '/',
      '/admin',
      '/admin/login',
      '/admin/security',
      '/admin/settings/users',
      '/admin/questions',
      '/errors/expired',
      '/t',
      '/x/t/abc123',
      '/dev/proctor',
    ]) {
      expect(await effective(path), path).toBe(
        'camera=(self), microphone=(), display-capture=(self), fullscreen=(self)',
      );
    }
  });

  it('DL-28: only the microphone differs between the candidate and the global policy', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const candidate = await effective('/t/abc123');
    const global = await effective('/admin');
    expect(candidate?.replace('microphone=(self)', 'microphone=()')).toBe(global);
  });
});
