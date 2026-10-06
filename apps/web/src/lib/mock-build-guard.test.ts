import { describe, expect, it } from 'vitest';
import { assertNoMockingInProductionBuild } from '../../next.config';

describe('FR-505 production build refuses mock mode', () => {
  it('FR-505 throws for a production build with mocking enabled', () => {
    expect(() =>
      assertNoMockingInProductionBuild({
        NODE_ENV: 'production',
        NEXT_PUBLIC_API_MOCKING: 'enabled',
      }),
    ).toThrow(/Refusing to build/);
  });
  it('FR-505 allows it only with the explicit staging-only override', () => {
    expect(() =>
      assertNoMockingInProductionBuild({
        NODE_ENV: 'production',
        NEXT_PUBLIC_API_MOCKING: 'enabled',
        ALLOW_MOCKING_IN_PRODUCTION_BUILD: 'staging-only',
      }),
    ).not.toThrow();
    expect(() =>
      assertNoMockingInProductionBuild({
        NODE_ENV: 'production',
        NEXT_PUBLIC_API_MOCKING: 'enabled',
        ALLOW_MOCKING_IN_PRODUCTION_BUILD: 'yes',
      }),
    ).toThrow();
  });
  it('FR-505 does not block builds without mocking or non-production runs', () => {
    expect(() => assertNoMockingInProductionBuild({ NODE_ENV: 'production' })).not.toThrow();
    expect(() =>
      assertNoMockingInProductionBuild({
        NODE_ENV: 'development',
        NEXT_PUBLIC_API_MOCKING: 'enabled',
      }),
    ).not.toThrow();
  });
});
