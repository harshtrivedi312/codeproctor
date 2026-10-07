import { MAX_EXTRA_TIME_PCT, extraTimePct, readExtraTime, scaledMs } from './accommodations';

describe('Accommodation extra time (FR-305, TC-024)', () => {
  it('FR-305: the cap is the 300 per cent BE-06 allows', () => {
    expect(MAX_EXTRA_TIME_PCT).toBe(300);
  });

  it('FR-305: valid values are used as given and are not flagged', () => {
    for (const pct of [0, 25, 50, 300]) {
      expect(readExtraTime({ extraTimePct: pct })).toEqual({ pct, ignored: false });
    }
    expect(readExtraTime({})).toEqual({ pct: 0, ignored: false });
    expect(readExtraTime(null)).toEqual({ pct: 0, ignored: false });
  });

  it('FR-305: a malformed, negative or over-cap value means no extra time and is flagged', () => {
    for (const bad of [301, 5000, -1, 'lots', NaN, Infinity, {}, [], true]) {
      expect(readExtraTime({ extraTimePct: bad })).toEqual({ pct: 0, ignored: true });
      expect(extraTimePct({ extraTimePct: bad })).toBe(0);
    }
  });

  it('TC-024: +50% turns 60 minutes into 90 and 20 into 30', () => {
    expect(scaledMs(60, 50)).toBe(90 * 60_000);
    expect(scaledMs(20, 50)).toBe(30 * 60_000);
  });
});
