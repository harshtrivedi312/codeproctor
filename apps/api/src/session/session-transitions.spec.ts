import { SessionStatus } from '../generated/prisma/enums.js';
import {
  LIVE_STATUSES,
  PRE_START_STATUSES,
  SESSION_STATUSES,
  TERMINAL_STATUSES,
  TRANSITIONS,
  USED_STATUSES,
  isAllowedTransition,
  stampsRetentionAnchor,
  stampsSubmittedAt,
} from './session-transitions';

// The full map of fsd.md section 3 and ADR 0002 section 2, with C-28 applied. Written out here
// independently of the implementation so a change to the table must change this list too.
const ALLOWED: ReadonlyArray<readonly [SessionStatus, SessionStatus]> = [
  ['INVITED', 'OPENED'],
  ['INVITED', 'EXPIRED'],
  ['OPENED', 'CONSENTED'],
  ['OPENED', 'DECLINED'],
  ['OPENED', 'EXPIRED'],
  ['CONSENTED', 'VERIFIED'],
  ['CONSENTED', 'EXPIRED'],
  ['VERIFIED', 'IN_PROGRESS'],
  ['VERIFIED', 'EXPIRED'],
  ['IN_PROGRESS', 'PAUSED'],
  ['IN_PROGRESS', 'SUBMITTED'],
  ['PAUSED', 'IN_PROGRESS'],
  ['PAUSED', 'SUBMITTED'],
  ['SUBMITTED', 'GRADED'],
  ['GRADED', 'UNDER_REVIEW'],
  ['UNDER_REVIEW', 'COMPLETED'],
  ['COMPLETED', 'APPEALED'],
  ['APPEALED', 'COMPLETED'],
];

describe('Session state machine table (fsd.md section 3, ADR 0002, C-28)', () => {
  it('FR-106: every allowed transition is allowed', () => {
    for (const [from, to] of ALLOWED) {
      expect(isAllowedTransition(from, to)).toBe(true);
    }
  });

  it('FR-106: every other pair of states is forbidden (unit test of every forbidden transition)', () => {
    const allowed = new Set(ALLOWED.map(([a, b]) => `${a}>${b}`));
    let forbidden = 0;
    for (const from of SESSION_STATUSES) {
      for (const to of SESSION_STATUSES) {
        if (allowed.has(`${from}>${to}`)) continue;
        forbidden += 1;
        expect({ from, to, ok: isAllowedTransition(from, to) }).toEqual({ from, to, ok: false });
      }
    }
    expect(forbidden).toBe(SESSION_STATUSES.length ** 2 - ALLOWED.length);
  });

  it('FR-106: the table has exactly the allowed edges and covers every status', () => {
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...SESSION_STATUSES].sort());
    const edges = Object.entries(TRANSITIONS).flatMap(([from, tos]) =>
      tos.map((to) => `${from}>${to}`),
    );
    expect(edges.sort()).toEqual(ALLOWED.map(([a, b]) => `${a}>${b}`).sort());
  });

  it('FR-805, C-28: GRADED never goes straight to COMPLETED; every session ends UNDER_REVIEW', () => {
    expect(isAllowedTransition('GRADED', 'COMPLETED')).toBe(false);
    expect(TRANSITIONS.GRADED).toEqual(['UNDER_REVIEW']);
    // The only way into COMPLETED from the review path is UNDER_REVIEW (or an appeal).
    const into = SESSION_STATUSES.filter((s) => TRANSITIONS[s].includes('COMPLETED'));
    expect(into.sort()).toEqual(['APPEALED', 'UNDER_REVIEW']);
  });

  it('FR-401, D-17: EXPIRED and DECLINED are terminal; a declined session never continues', () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual(['DECLINED', 'ERASED', 'EXPIRED']);
    for (const to of SESSION_STATUSES) {
      expect(isAllowedTransition('DECLINED', to)).toBe(false);
      expect(isAllowedTransition('EXPIRED', to)).toBe(false);
    }
  });

  it('FR-303: EXPIRED is reachable only before the test starts (ADR 0002 section 2)', () => {
    const into = SESSION_STATUSES.filter((s) => TRANSITIONS[s].includes('EXPIRED'));
    expect(into.sort()).toEqual([...PRE_START_STATUSES].sort());
  });

  it('FR-505: IN_PROGRESS is entered only from VERIFIED or PAUSED', () => {
    const into = SESSION_STATUSES.filter((s) => TRANSITIONS[s].includes('IN_PROGRESS'));
    expect(into.sort()).toEqual(['PAUSED', 'VERIFIED']);
  });

  it('FR-704, ADR 0004 R-1: the retention anchor is stamped on COMPLETED, EXPIRED and DECLINED only', () => {
    const stamped = SESSION_STATUSES.filter(stampsRetentionAnchor);
    expect(stamped.sort()).toEqual(['COMPLETED', 'DECLINED', 'EXPIRED']);
    expect(SESSION_STATUSES.filter(stampsSubmittedAt)).toEqual(['SUBMITTED']);
  });

  it('TC-021: SUBMITTED and later are "Already used"; LIVE and PRE_START do not overlap them', () => {
    for (const s of USED_STATUSES) {
      expect(PRE_START_STATUSES).not.toContain(s);
      expect(LIVE_STATUSES).not.toContain(s);
    }
    expect(Object.values(SessionStatus).length).toBe(SESSION_STATUSES.length);
  });

  it('NFR-05, ADR 0004 section 9: ERASED has no exit and nothing in the table moves a session into it (the erasure fence does, outside this table)', () => {
    expect(TRANSITIONS.ERASED).toEqual([]);
    for (const to of SESSION_STATUSES) expect(isAllowedTransition('ERASED', to)).toBe(false);
    for (const from of SESSION_STATUSES) expect(isAllowedTransition(from, 'ERASED')).toBe(false);
    expect(SESSION_STATUSES).toContain('ERASED');
  });

  it('TC-021: an ERASED session is a used link (no OTP, no new session)', () => {
    expect(USED_STATUSES).toContain('ERASED');
  });
});
