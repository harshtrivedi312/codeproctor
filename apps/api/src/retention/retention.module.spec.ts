// RetentionModule.forRoot (FR-704, NFR-05, OQ-10): a legal hold that is switched on but has no port
// bound would delete anyway, so the module refuses to be built.
import { Module } from '@nestjs/common';
import { RetentionModule } from './retention.module';

@Module({})
class StoreModule {}
@Module({})
class HoldModule {}

describe('RetentionModule.forRoot', () => {
  const saved = process.env.RETENTION_LEGAL_HOLD;
  afterEach(() => {
    if (saved === undefined) delete process.env.RETENTION_LEGAL_HOLD;
    else process.env.RETENTION_LEGAL_HOLD = saved;
  });

  it('builds with an object store module and no legal hold switched on', () => {
    delete process.env.RETENTION_LEGAL_HOLD;
    expect(RetentionModule.forRoot({ objectStore: StoreModule }).exports).toBeDefined();
  });

  it('refuses to build when RETENTION_LEGAL_HOLD is on and no legalHold module is given', () => {
    process.env.RETENTION_LEGAL_HOLD = 'true';
    expect(() => RetentionModule.forRoot({ objectStore: StoreModule })).toThrow(
      /no legalHold module/,
    );
    expect(
      RetentionModule.forRoot({ objectStore: StoreModule, legalHold: HoldModule }).imports,
    ).toContain(HoldModule);
  });
});
