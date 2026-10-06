import { SessionStatus } from '../generated/prisma/enums.js';
import { candidateVisibleStatus } from './candidate-visible-status';

describe('candidateVisibleStatus (hub decision Q17, FR-401)', () => {
  const EXPECTED: Record<SessionStatus, SessionStatus> = {
    INVITED: 'INVITED',
    OPENED: 'OPENED',
    CONSENTED: 'CONSENTED',
    VERIFIED: 'VERIFIED',
    IN_PROGRESS: 'IN_PROGRESS',
    PAUSED: 'PAUSED',
    SUBMITTED: 'SUBMITTED',
    GRADED: 'SUBMITTED',
    UNDER_REVIEW: 'SUBMITTED',
    COMPLETED: 'SUBMITTED',
    APPEALED: 'SUBMITTED',
    EXPIRED: 'EXPIRED',
    DECLINED: 'DECLINED',
    // After SUBMITTED, so shown as SUBMITTED until the hub's contract PR decides ERASED handling (FU-BEB-132).
    ERASED: 'SUBMITTED',
  };

  it('Q17: every status maps as decided; review and outcome statuses all read SUBMITTED', () => {
    for (const status of Object.values(SessionStatus)) {
      expect([status, candidateVisibleStatus(status)]).toEqual([status, EXPECTED[status]]);
    }
    expect(Object.keys(EXPECTED).sort()).toEqual(Object.values(SessionStatus).sort());
  });

  it('Q17: a status added later is after SUBMITTED, so it is hidden too', () => {
    expect(candidateVisibleStatus('SOMETHING_NEW' as SessionStatus)).toBe('SUBMITTED');
  });
});
