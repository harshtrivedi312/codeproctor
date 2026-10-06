// The switches for the owner's open questions (FR-704; OQ-10, OQ-11, OQ-12, OQ-18, OQ-19, OQ-20, C-17).
import { loadRetentionConfig } from './retention.config';

describe('loadRetentionConfig', () => {
  it('FR-704: the defaults are the ADR 0004 section 9 behaviour (evidence frames stay with the media tier: OQ-19 is open)', () => {
    expect(loadRetentionConfig({})).toEqual({
      RETENTION_LEGAL_HOLD: false,
      RETENTION_DECLINED_CONSENTS_EXPIRE: true,
      RETENTION_REDUCE_ACCOMMODATIONS: true,
      RETENTION_MEDIA_CAP_DAYS: undefined,
      RETENTION_EVIDENCE_IN_FACE_TIER: false,
      RETENTION_RESULTS_CLOCK: 'anchor',
      RETENTION_CONSENT_THROUGH_ERASURE: 'keep',
      RETENTION_VERSIONING_CHECK: 'enforce',
      RETENTION_BATCH_SIZE: 200,
    });
  });

  it('every switch can be changed from the environment', () => {
    const config = loadRetentionConfig({
      RETENTION_LEGAL_HOLD: 'true',
      RETENTION_DECLINED_CONSENTS_EXPIRE: 'false',
      RETENTION_REDUCE_ACCOMMODATIONS: 'false',
      RETENTION_MEDIA_CAP_DAYS: '90',
      RETENTION_EVIDENCE_IN_FACE_TIER: 'false',
      RETENTION_RESULTS_CLOCK: 'submitted',
      RETENTION_VERSIONING_CHECK: 'skip',
      APP_ENV: 'staging',
      RETENTION_BATCH_SIZE: '50',
    });
    expect(config).toMatchObject({
      RETENTION_LEGAL_HOLD: true,
      RETENTION_DECLINED_CONSENTS_EXPIRE: false,
      RETENTION_REDUCE_ACCOMMODATIONS: false,
      RETENTION_MEDIA_CAP_DAYS: 90,
      RETENTION_EVIDENCE_IN_FACE_TIER: false,
      RETENTION_RESULTS_CLOCK: 'submitted',
      RETENTION_VERSIONING_CHECK: 'skip',
      RETENTION_BATCH_SIZE: 50,
    });
  });

  it('NFR-05: the versioning check can be skipped on staging only, never in pilot or production (ADR 0004 9.2)', () => {
    expect(
      loadRetentionConfig({ RETENTION_VERSIONING_CHECK: 'skip', APP_ENV: 'staging' })
        .RETENTION_VERSIONING_CHECK,
    ).toBe('skip');
    for (const env of [
      { APP_ENV: 'pilot' },
      { APP_ENV: 'production' },
      { NODE_ENV: 'production' },
    ]) {
      expect(() => loadRetentionConfig({ RETENTION_VERSIONING_CHECK: 'skip', ...env })).toThrow(
        /allowed only with APP_ENV/,
      );
    }
    expect(loadRetentionConfig({ APP_ENV: 'pilot' }).RETENTION_VERSIONING_CHECK).toBe('enforce');
    // Fail closed: an unset or misspelled environment is not "safe" (a denylist would let it through).
    for (const env of [
      {},
      { APP_ENV: 'prod' },
      { APP_ENV: 'pilot-1' },
      { APP_ENV: '' },
      { APP_ENV: 'staging', NODE_ENV: 'production' },
    ]) {
      expect(() => loadRetentionConfig({ RETENTION_VERSIONING_CHECK: 'skip', ...env })).toThrow(
        /allowed only with APP_ENV/,
      );
    }
    for (const appEnv of ['development', 'test', 'staging']) {
      expect(
        loadRetentionConfig({ RETENTION_VERSIONING_CHECK: 'skip', APP_ENV: appEnv })
          .RETENTION_VERSIONING_CHECK,
      ).toBe('skip');
    }
  });

  it('NFR-05: an invalid value stops the process instead of silently using a default', () => {
    for (const bad of [
      { RETENTION_LEGAL_HOLD: 'yes' },
      { RETENTION_MEDIA_CAP_DAYS: '6' },
      { RETENTION_MEDIA_CAP_DAYS: '9999' },
      { RETENTION_RESULTS_CLOCK: 'test-date' },
      { RETENTION_CONSENT_THROUGH_ERASURE: 'maybe' },
      { RETENTION_BATCH_SIZE: '0' },
    ]) {
      expect(() => loadRetentionConfig(bad)).toThrow();
    }
  });
});
