import { afterEach, describe, expect, it, vi } from 'vitest';
import { PHASE_PRODUCTION_BUILD, PHASE_PRODUCTION_SERVER } from 'next/constants';
import config, { assertNoMockingInProductionBuild, nextConfig } from '../../next.config';

describe('FU-FEB-03 (step-1 item 2) a build refuses mock mode', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('FU-FEB-03 throws with mocking enabled', () => {
    expect(() =>
      assertNoMockingInProductionBuild({
        NODE_ENV: 'production',
        NEXT_PUBLIC_API_MOCKING: 'enabled',
      }),
    ).toThrow(/Refusing to build/);
  });
  it('FU-FEB-03 refuses whatever NODE_ENV says (NODE_ENV=development next build)', () => {
    for (const NODE_ENV of ['development', 'test', undefined]) {
      expect(() =>
        assertNoMockingInProductionBuild({
          NODE_ENV,
          NEXT_PUBLIC_API_MOCKING: 'enabled',
        } as NodeJS.ProcessEnv),
      ).toThrow(/Refusing to build/);
    }
  });
  it('FU-FEB-03 allows it only with the explicit override', () => {
    const base = { NODE_ENV: 'production', NEXT_PUBLIC_API_MOCKING: 'enabled' } as const;
    expect(() =>
      assertNoMockingInProductionBuild({
        ...base,
        ALLOW_MOCKING_IN_PRODUCTION_BUILD: 'staging-only',
      }),
    ).not.toThrow();
    expect(() =>
      assertNoMockingInProductionBuild({ ...base, ALLOW_MOCKING_IN_PRODUCTION_BUILD: 'yes' }),
    ).toThrow();
  });
  it('FU-FEB-03 does not block builds without mocking', () => {
    expect(() => assertNoMockingInProductionBuild({ NODE_ENV: 'production' })).not.toThrow();
    expect(() =>
      assertNoMockingInProductionBuild({ NODE_ENV: 'production', NEXT_PUBLIC_API_MOCKING: '' }),
    ).not.toThrow();
  });

  it('FU-FEB-03 values other than the exact string still refuse', () => {
    for (const value of ['true', 'Staging-Only', 'staging-only ', '1', 'staging']) {
      expect(() =>
        assertNoMockingInProductionBuild({
          NODE_ENV: 'production',
          NEXT_PUBLIC_API_MOCKING: 'enabled',
          ALLOW_MOCKING_IN_PRODUCTION_BUILD: value,
        }),
      ).toThrow(/Refusing to build/);
    }
  });

  it('FU-FEB-03 the config function refuses in the production build phase', () => {
    vi.stubEnv('NEXT_PUBLIC_API_MOCKING', 'enabled');
    vi.stubEnv('ALLOW_MOCKING_IN_PRODUCTION_BUILD', '');
    expect(() => config(PHASE_PRODUCTION_BUILD)).toThrow(/Refusing to build/);
  });

  it('FU-FEB-03 the config function returns the config in the production server phase (a built mock image still runs)', () => {
    vi.stubEnv('NEXT_PUBLIC_API_MOCKING', 'enabled');
    vi.stubEnv('ALLOW_MOCKING_IN_PRODUCTION_BUILD', '');
    expect(config(PHASE_PRODUCTION_SERVER)).toBe(nextConfig);
    expect(config('phase-development-server')).toBe(nextConfig);
  });

  it('FU-FEB-03 the override only passes the build phase with the exact string', () => {
    vi.stubEnv('NEXT_PUBLIC_API_MOCKING', 'enabled');
    vi.stubEnv('ALLOW_MOCKING_IN_PRODUCTION_BUILD', 'staging-only');
    expect(config(PHASE_PRODUCTION_BUILD)).toBe(nextConfig);
  });

  it('FU-FEB-03 the override is never exposed to the bundles', () => {
    const env = nextConfig.env ?? {};
    expect(Object.keys(env).filter((k) => /ALLOW|MOCKING_IN_PRODUCTION|STAGING/i.test(k))).toEqual(
      [],
    );
    expect(
      Object.keys(env).filter(
        (k) => k.startsWith('NEXT_PUBLIC_') && k !== 'NEXT_PUBLIC_API_MOCKING',
      ),
    ).toEqual([]);
    expect(Object.values(env)).not.toContain('staging-only');
  });
});
