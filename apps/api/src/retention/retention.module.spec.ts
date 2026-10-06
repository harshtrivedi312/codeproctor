// RetentionModule.forRoot (FR-704, NFR-05, OQ-10): a legal hold that is switched on but has no port
// bound would delete anyway, so the module refuses to be built.
import { Module } from '@nestjs/common';
import { RetentionModule } from './retention.module';

@Module({})
class StoreModule {}
@Module({})
class HoldModule {}

describe('RetentionModule.forRoot', () => {
  const names = ['RETENTION_LEGAL_HOLD', 'RETENTION_VERSIONING_CHECK', 'APP_ENV', 'NODE_ENV'];
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  beforeEach(() => {
    // The test must not depend on the CI environment.
    for (const n of names.filter((x) => x !== 'NODE_ENV')) delete process.env[n];
  });
  afterEach(() => {
    for (const n of names) {
      if (saved[n] === undefined) delete process.env[n];
      else process.env[n] = saved[n];
    }
  });

  it('FR-704: builds with an object store module and no legal hold switched on', () => {
    delete process.env.RETENTION_LEGAL_HOLD;
    expect(RetentionModule.forRoot({ objectStore: StoreModule }).exports).toBeDefined();
  });

  it('NFR-05, OQ-10: refuses to build when RETENTION_LEGAL_HOLD is on and no legalHold module is given', () => {
    process.env.RETENTION_LEGAL_HOLD = 'true';
    expect(() => RetentionModule.forRoot({ objectStore: StoreModule })).toThrow(
      /no legalHold module/,
    );
    expect(
      RetentionModule.forRoot({ objectStore: StoreModule, legalHold: HoldModule }).imports,
    ).toContain(HoldModule);
  });
});
