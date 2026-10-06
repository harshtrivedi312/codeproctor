import { candidateVisibleStatus } from './candidate-visible-status';
import { HttpStatus } from '@nestjs/common';
import { CodedHttpException } from '../common/coded.exception';
import type { SessionStatus } from '../generated/prisma/enums.js';

/** The requested transition is not in the table: a programming error or a forged request. */
export class IllegalTransitionError extends CodedHttpException {
  constructor(from: SessionStatus, to: SessionStatus) {
    super(
      HttpStatus.CONFLICT,
      `A session cannot move from ${from} to ${to}.`,
      'ILLEGAL_TRANSITION',
      {
        sessionStatus: candidateVisibleStatus(from),
      },
    );
  }
}

/** The compare-and-set lost: the session was no longer in the expected state. */
export class SessionStateConflictError extends CodedHttpException {
  constructor(current: SessionStatus | null) {
    super(
      HttpStatus.CONFLICT,
      'The session is not in the expected state.',
      'SESSION_STATE_CONFLICT',
      { sessionStatus: current === null ? null : candidateVisibleStatus(current) },
    );
  }
}
