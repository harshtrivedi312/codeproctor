import { candidateVisibleStatus } from './candidate-visible-status';
// assertWritable (DL-17, ADR 0002 P-2, ADR 0013 section 5.10 CS-4.6): the one check every question
// and draft write route runs first. BE-11 (run, draft, answer, submit) calls it; BE-07 ships it.
//
// While the session is paused for a reason that must not be worked through, writes answer 409
// SESSION_PAUSED. The client keeps its unsaved draft and retries after resume, so no code is lost.
//   - PROCTOR: the pause stops the clock and is credited on resume, so editing during it would be
//     free time (ADR 0013 CS-4.6).
//   - SCREEN_SHARE_STOPPED, SIDE_CAMERA_LOST: DL-17, the server learns these from signed events.
//   - FULLSCREEN_EXIT is not enforced here: the server's state lags this frequent, accessibility
//     sensitive event, so refusing on it would reject legitimate autosaves (DL-17).
// Reads stay allowed in every pause.
import {
  CanActivate,
  ExecutionContext,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { CodedHttpException } from '../common/coded.exception';
import type { PauseReason, SessionStatus } from '../generated/prisma/enums.js';
import { LIVE_STATUSES } from './session-transitions';

export const WRITE_BLOCKING_PAUSE_REASONS: readonly PauseReason[] = [
  'PROCTOR',
  'SCREEN_SHARE_STOPPED',
  'SIDE_CAMERA_LOST',
];

export interface WritableSession {
  readonly status: SessionStatus;
  readonly pauseReasons: readonly PauseReason[];
}

export function sessionNotActive(status: SessionStatus): CodedHttpException {
  return new CodedHttpException(
    HttpStatus.CONFLICT,
    'The session is not running.',
    'SESSION_NOT_ACTIVE',
    { sessionStatus: candidateVisibleStatus(status) },
  );
}

/** Throws 409 SESSION_NOT_ACTIVE when the test is not running, 409 SESSION_PAUSED when blocked. */
export function assertWritable(session: WritableSession): void {
  if (!LIVE_STATUSES.includes(session.status)) throw sessionNotActive(session.status);
  const blocking = session.pauseReasons.filter((r) => WRITE_BLOCKING_PAUSE_REASONS.includes(r));
  if (blocking.length > 0) {
    throw new CodedHttpException(
      HttpStatus.CONFLICT,
      'The test is paused. Your work is kept; continue when the pause ends.',
      'SESSION_PAUSED',
      { sessionStatus: candidateVisibleStatus(session.status) },
    );
  }
}

interface RequestWithSession {
  candidate?: WritableSession;
}

/**
 * Route guard form of assertWritable. Put it after CandidateSessionGuard, which sets
 * `request.candidate` from the session row it just loaded:
 * `@UseGuards(CandidateSessionGuard, SessionWritableGuard)`.
 */
@Injectable()
export class SessionWritableGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const candidate = context.switchToHttp().getRequest<RequestWithSession>().candidate;
    // Without the candidate guard in front there is no session to judge: refuse, never allow.
    if (candidate === undefined) throw new UnauthorizedException('Authentication required.');
    assertWritable(candidate);
    return true;
  }
}
