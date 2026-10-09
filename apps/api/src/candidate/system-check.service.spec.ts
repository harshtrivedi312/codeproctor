import { brandsOfSecChUa, evaluateSystemCheck, MIN_CHROMIUM_MAJOR } from './system-check.service';
import { systemCheckBodySchema } from './system-check.schema';

const base = {
  browser: { brand: 'Google Chrome', majorVersion: 124 },
  devices: { camera: true, microphone: true, screenShare: 'MONITOR' as const },
  findings: [],
  capabilities: [],
};
const parse = (b: object) => systemCheckBodySchema.parse(b);

describe('System check evaluation (FR-402, FR-605, FR-610, ADR 0013 section 5.4)', () => {
  it('FR-402: Chromium at the minimum version with a camera, a microphone and a monitor share passes', () => {
    expect(evaluateSystemCheck(parse(base))).toEqual([]);
    expect(
      evaluateSystemCheck(
        parse({ ...base, browser: { brand: 'Microsoft Edge', majorVersion: MIN_CHROMIUM_MAJOR } }),
      ),
    ).toEqual([]);
  });

  it('FR-402: an older Chromium, Firefox and Safari are BROWSER_UNSUPPORTED', () => {
    for (const browser of [
      { brand: 'Google Chrome', majorVersion: MIN_CHROMIUM_MAJOR - 1 },
      { brand: 'Firefox', majorVersion: 130 },
      { brand: 'Safari', majorVersion: 18 },
    ]) {
      expect(evaluateSystemCheck(parse({ ...base, browser }))).toEqual(['BROWSER_UNSUPPORTED']);
    }
  });

  it('FR-610, ADR 0013 section 5.8: VIRTUAL_CAMERA and an UNVERIFIABLE share surface do not block', () => {
    const body = parse({
      ...base,
      devices: { camera: true, microphone: true, screenShare: 'UNVERIFIABLE' },
      findings: [
        {
          type: 'VIRTUAL_CAMERA',
          occurredAt: '2026-10-09T10:00:00.000Z',
          payload: { deviceLabel: 'OBS' },
        },
      ],
    });
    expect(evaluateSystemCheck(body)).toEqual([]);
  });

  it('FR-402: Sec-CH-UA brands are read from the header; a missing or empty header is null', () => {
    expect(
      brandsOfSecChUa('"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"'),
    ).toEqual(['chromium', 'google chrome', 'not-a.brand']);
    expect(brandsOfSecChUa(undefined)).toBeNull();
    expect(brandsOfSecChUa('  ')).toBeNull();
    expect(brandsOfSecChUa('garbage')).toBeNull();
  });
});
