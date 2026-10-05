import { afterEach, describe, expect, it, vi } from 'vitest';
import nextConfig from '../next.config';

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
