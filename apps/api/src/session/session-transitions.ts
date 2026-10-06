// The session state machine as data (fsd.md section 3, ADR 0002 section 2, C-28). One table says
// which transitions exist and what each one stamps; SessionStateService is the only code that
// applies it. Nothing here touches the database.
import { SessionStatus } from '../generated/prisma/enums.js';

export const SESSION_STATUSES: readonly SessionStatus[] = Object.values(SessionStatus);

/**
 * Allowed next states for each state. Differences from the prose in fsd.md section 3:
 * - GRADED goes only to UNDER_REVIEW: owner decision C-28 (2026-10-05) says a person reviews every
 *   session, so nothing is cleared automatically and there is no GRADED to COMPLETED edge.
 * - DISCONNECTED, FOCUS_LOST and TAB_SWITCH are events, not states (ADR 0002 section 2).
 */
export const TRANSITIONS: Readonly<Record<SessionStatus, readonly SessionStatus[]>> = {
  INVITED: ['OPENED', 'EXPIRED'],
  OPENED: ['CONSENTED', 'DECLINED', 'EXPIRED'],
  CONSENTED: ['VERIFIED', 'EXPIRED'],
  VERIFIED: ['IN_PROGRESS', 'EXPIRED'],
  IN_PROGRESS: ['PAUSED', 'SUBMITTED'],
  PAUSED: ['IN_PROGRESS', 'SUBMITTED'],
  SUBMITTED: ['GRADED'],
  GRADED: ['UNDER_REVIEW'],
  UNDER_REVIEW: ['COMPLETED'],
  COMPLETED: ['APPEALED'],
  APPEALED: ['COMPLETED'],
  EXPIRED: [],
  DECLINED: [],
  // Terminal, no exit (ADR 0004 section 9, ADR 0013 section 5.7). Nothing here moves a session INTO
  // ERASED: the erasure fence does (SessionStateService.closeIngest, a later step), which keeps or
  // sets the retention anchor itself. No appeal, review or resume can follow.
  ERASED: [],
};

export function isAllowedTransition(from: SessionStatus, to: SessionStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** States in which a session has ended and no further status change is possible. */
export const TERMINAL_STATUSES: readonly SessionStatus[] = SESSION_STATUSES.filter(
  (s) => TRANSITIONS[s].length === 0,
);

/** The states before the test starts: the 5-wrong-OTP block applies here (ADR 0003 section 6). */
export const PRE_START_STATUSES: readonly SessionStatus[] = [
  'INVITED',
  'OPENED',
  'CONSENTED',
  'VERIFIED',
];

/** The states in which the test is running (heartbeat, key, question and draft writes). */
export const LIVE_STATUSES: readonly SessionStatus[] = ['IN_PROGRESS', 'PAUSED'];

/** SUBMITTED or later, ERASED included: the link shows "Already used" (ADR 0002 L-3, TC-021). */
export const USED_STATUSES: readonly SessionStatus[] = [
  'SUBMITTED',
  'GRADED',
  'UNDER_REVIEW',
  'COMPLETED',
  'APPEALED',
  // An erased session is a used link too: no OTP, no new session (ADR 0002 L-3).
  'ERASED',
];

/** Statuses whose entry stamps `retention_anchor_at` (ADR 0004 R-1, ADR 0002 section 9). */
const ANCHORED: readonly SessionStatus[] = ['COMPLETED', 'EXPIRED', 'DECLINED'];

export function stampsRetentionAnchor(to: SessionStatus): boolean {
  return ANCHORED.includes(to);
}

export function stampsSubmittedAt(to: SessionStatus): boolean {
  return to === 'SUBMITTED';
}
