// The retention clocks (FR-704, NFR-05; TC-072; C-04, C-06, C-26, C-27, C-35).
import {
  addDays,
  addYears,
  consentDue,
  erasureAlertAt,
  erasureAnonymiseAt,
  erasureDeadline,
  faceClock,
  faceDue,
  mediaDue,
  resultsDue,
} from './clocks';

const d = (iso: string): Date => new Date(iso);

describe('retention clocks', () => {
  describe('face clock and face tier (C-27, C-35)', () => {
    const created = d('2026-01-01T00:00:00Z');

    it('FR-704: submission wins, then latest capture, then first terminal transition, then creation', () => {
      const submittedAt = d('2026-02-01T00:00:00Z');
      const latestCapture = d('2026-01-20T00:00:00Z');
      const firstTerminalAt = d('2026-01-10T00:00:00Z');
      expect(
        faceClock({ submittedAt, latestCapture, firstTerminalAt, createdAt: created }),
      ).toEqual(submittedAt);
      expect(
        faceClock({ submittedAt: null, latestCapture, firstTerminalAt, createdAt: created }),
      ).toEqual(latestCapture);
      expect(
        faceClock({ submittedAt: null, latestCapture: null, firstTerminalAt, createdAt: created }),
      ).toEqual(firstTerminalAt);
      expect(
        faceClock({
          submittedAt: null,
          latestCapture: null,
          firstTerminalAt: null,
          createdAt: created,
        }),
      ).toEqual(created);
    });

    it('C-27: due at face clock + LEAST(retention_days, 90): a long org setting never extends it', () => {
      const clock = d('2026-03-01T00:00:00Z');
      expect(faceDue(clock, 730)).toEqual(addDays(clock, 90));
      expect(faceDue(clock, 90)).toEqual(addDays(clock, 90));
      expect(faceDue(clock, 30)).toEqual(addDays(clock, 30));
      expect(faceDue(clock, 7)).toEqual(addDays(clock, 7));
    });
  });

  describe('media tier (R-4, OQ-18)', () => {
    const anchor = d('2026-03-01T00:00:00Z');
    it('NFR-05: a NULL anchor (a hold) is never due', () => {
      expect(mediaDue(null, 90, { RETENTION_MEDIA_CAP_DAYS: undefined })).toBeNull();
    });
    it('TC-072: due at anchor + retention_days', () => {
      expect(mediaDue(anchor, 7, { RETENTION_MEDIA_CAP_DAYS: undefined })).toEqual(
        addDays(anchor, 7),
      );
      expect(mediaDue(anchor, 730, { RETENTION_MEDIA_CAP_DAYS: undefined })).toEqual(
        addDays(anchor, 730),
      );
    });
    it('OQ-18: the optional cap makes it LEAST(retention_days, cap)', () => {
      expect(mediaDue(anchor, 730, { RETENTION_MEDIA_CAP_DAYS: 90 })).toEqual(addDays(anchor, 90));
      expect(mediaDue(anchor, 30, { RETENTION_MEDIA_CAP_DAYS: 90 })).toEqual(addDays(anchor, 30));
    });
  });

  describe('results tier (R-10, C-26, OQ-20)', () => {
    const anchor = d('2026-03-01T00:00:00Z');
    const submitted = d('2026-02-01T00:00:00Z');
    it('FR-704: one year after the anchor by default', () => {
      expect(resultsDue(anchor, submitted, { RETENTION_RESULTS_CLOCK: 'anchor' })).toEqual(
        d('2027-03-01T00:00:00Z'),
      );
    });
    it('OQ-20: or one year after submission when the switch says so', () => {
      expect(resultsDue(anchor, submitted, { RETENTION_RESULTS_CLOCK: 'submitted' })).toEqual(
        d('2027-02-01T00:00:00Z'),
      );
    });
    it('NFR-05: no anchor (a hold) means never due on the anchor clock', () => {
      expect(resultsDue(null, submitted, { RETENTION_RESULTS_CLOCK: 'anchor' })).toBeNull();
      expect(resultsDue(anchor, null, { RETENTION_RESULTS_CLOCK: 'submitted' })).toEqual(
        d('2027-03-01T00:00:00Z'),
      ); // falls back to the anchor
      expect(resultsDue(null, null, { RETENTION_RESULTS_CLOCK: 'submitted' })).toBeNull();
    });
  });

  it('C-04, C-17: a consent record is due 3 years after signing; 29 February clamps like PostgreSQL', () => {
    expect(consentDue(d('2026-10-05T10:00:00Z'))).toEqual(d('2029-10-05T10:00:00Z'));
    expect(addYears(d('2028-02-29T00:00:00Z'), 1)).toEqual(d('2029-02-28T00:00:00Z'));
    expect(addYears(d('2028-02-29T10:30:00Z'), 4)).toEqual(d('2032-02-29T10:30:00Z'));
  });

  describe('erasure deadline (C-06, TC-094)', () => {
    const requested = d('2026-10-01T00:00:00Z');
    it('30 days from the request', () => {
      expect(erasureDeadline(requested, null)).toEqual(d('2026-10-31T00:00:00Z'));
    });
    it('or from the close of a hold, whichever is later', () => {
      expect(erasureDeadline(requested, d('2026-11-10T00:00:00Z'))).toEqual(
        d('2026-12-10T00:00:00Z'),
      );
      expect(erasureDeadline(requested, d('2026-09-01T00:00:00Z'))).toEqual(
        d('2026-10-31T00:00:00Z'),
      );
    });
    it('day 25 raises the alert and day 28 anonymises (ADR 0004 9.5 step 9)', () => {
      const deadline = erasureDeadline(requested, null);
      expect(erasureAlertAt(deadline)).toEqual(d('2026-10-26T00:00:00Z'));
      expect(erasureAnonymiseAt(deadline)).toEqual(d('2026-10-29T00:00:00Z'));
    });
  });
});
