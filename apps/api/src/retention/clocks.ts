// The retention clocks as pure functions (ADR 0004 section 9, C-04, C-06, C-26, C-27, C-35). UTC
// calendar arithmetic, the same as PostgreSQL's `+ interval '1 year'`. Nothing here reads the
// database or the clock: callers pass the dates.
import {
  CONSENT_YEARS,
  ERASURE_ALERT_DAY,
  ERASURE_ANONYMISE_DAY,
  ERASURE_DEADLINE_DAYS,
  FACE_CAP_DAYS,
  RESULTS_YEARS,
} from './retention.constants';
import type { RetentionConfig } from './retention.config';

export const addDays = (date: Date, days: number): Date => {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
};

/** Adds calendar years in UTC; 29 February clamps to 28 February like PostgreSQL's interval arithmetic. */
export const addYears = (date: Date, years: number): Date => {
  const d = new Date(date.getTime());
  const month = d.getUTCMonth();
  d.setUTCFullYear(d.getUTCFullYear() + years);
  if (d.getUTCMonth() !== month) d.setUTCDate(0); // rolled into the next month: back to its last day
  return d;
};

/**
 * The face clock (ADR 0004 9.2): submission, else the latest capture, else the first terminal
 * transition, else creation. Never `updated_at`. `latestCapture` is the newest identity check or
 * FACE_MISMATCH event time. Face images stay at most this clock + 90 days whatever any review hold
 * says (C-35), so the anchor is not an input.
 */
export function faceClock(input: {
  submittedAt: Date | null;
  latestCapture: Date | null;
  firstTerminalAt: Date | null;
  createdAt: Date;
}): Date {
  return input.submittedAt ?? input.latestCapture ?? input.firstTerminalAt ?? input.createdAt;
}

/** The face tier is due at face clock + LEAST(retention_days, 90) (C-27); no hold applies (C-35). */
export function faceDue(clock: Date, retentionDays: number): Date {
  return addDays(clock, Math.min(retentionDays, FACE_CAP_DAYS));
}

/**
 * The media tier (R-4) is due at anchor + retention_days, or LEAST with the cap when OQ-18 is on.
 * A NULL anchor means a hold (a review or appeal is open): never due.
 */
export function mediaDue(
  anchor: Date | null,
  retentionDays: number,
  config: Pick<RetentionConfig, 'RETENTION_MEDIA_CAP_DAYS'>,
): Date | null {
  if (anchor === null) return null;
  const days = Math.min(retentionDays, config.RETENTION_MEDIA_CAP_DAYS ?? retentionDays);
  return addDays(anchor, days);
}

/** The results tier (R-10) is due 1 year after the anchor (C-26, OQ-20), or after submission. */
export function resultsDue(
  anchor: Date | null,
  submittedAt: Date | null,
  config: Pick<RetentionConfig, 'RETENTION_RESULTS_CLOCK'>,
): Date | null {
  const start = config.RETENTION_RESULTS_CLOCK === 'submitted' ? submittedAt : anchor;
  return start === null ? null : addYears(start, RESULTS_YEARS);
}

/** A signed or declined consent record is due 3 years after signing or declining (C-04, C-17, OQ-11). */
export const consentDue = (signedOrDeclinedAt: Date): Date =>
  addYears(signedOrDeclinedAt, CONSENT_YEARS);

/** The erasure deadline: 30 days from the request, or from the close of a hold if later (C-06). */
export function erasureDeadline(requestedAt: Date, holdClosedAt: Date | null): Date {
  const start = holdClosedAt !== null && holdClosedAt > requestedAt ? holdClosedAt : requestedAt;
  return addDays(start, ERASURE_DEADLINE_DAYS);
}

/** Day 25 and day 28 of the deadline's 30 days (ADR 0004 9.5 step 9). */
export function erasureAlertAt(deadline: Date): Date {
  return addDays(deadline, ERASURE_ALERT_DAY - ERASURE_DEADLINE_DAYS);
}
export function erasureAnonymiseAt(deadline: Date): Date {
  return addDays(deadline, ERASURE_ANONYMISE_DAY - ERASURE_DEADLINE_DAYS);
}
