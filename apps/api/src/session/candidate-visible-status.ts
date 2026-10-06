// What a candidate may learn about the session status (hub decision Q17). Everything from SUBMITTED
// onward (GRADED, UNDER_REVIEW, COMPLETED, APPEALED and any later status such as ERASED) is shown as
// SUBMITTED, so a candidate never sees whether review has started or what its outcome is. EXPIRED and
// DECLINED are shown as they are, and so is every earlier status. Every candidate-facing status goes
// through this one function: the state route, the start and heartbeat responses and the
// `sessionStatus` of a problem body.
import type { SessionStatus } from '../generated/prisma/enums.js';

const SHOWN_AS_IS: ReadonlySet<string> = new Set<SessionStatus>([
  'INVITED',
  'OPENED',
  'CONSENTED',
  'VERIFIED',
  'IN_PROGRESS',
  'PAUSED',
  'SUBMITTED',
  'EXPIRED',
  'DECLINED',
]);

export function candidateVisibleStatus(status: SessionStatus): SessionStatus {
  // Anything not listed (a status added later, ERASED) is after SUBMITTED, so it is hidden too.
  return SHOWN_AS_IS.has(status) ? status : 'SUBMITTED';
}
