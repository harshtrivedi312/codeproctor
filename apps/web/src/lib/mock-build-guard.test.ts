import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertNoMockingInProductionBuild } from '../../next.config';

describe('FU-FEB-03 (step-1 item 2) a build refuses mock mode', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
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

  it('FU-FEB-03 loading next.config with argv "build" and mocking enabled rejects', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_MOCKING', 'enabled');
    vi.stubEnv('ALLOW_MOCKING_IN_PRODUCTION_BUILD', '');
    vi.stubEnv('NODE_ENV', 'development');
    const argv = vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', 'next', 'build']);
    vi.resetModules();
    await expect(import('../../next.config')).rejects.toThrow(/Refusing to build/);
    argv.mockRestore();
  });
  it('FU-FEB-03 loading next.config with argv "start" does not throw (a built mock image still runs)', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_MOCKING', 'enabled');
    vi.stubEnv('ALLOW_MOCKING_IN_PRODUCTION_BUILD', '');
    const argv = vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', 'next', 'start']);
    vi.resetModules();
    await expect(import('../../next.config')).resolves.toBeDefined();
    argv.mockRestore();
  });
});
