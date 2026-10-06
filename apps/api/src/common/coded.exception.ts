import { ConflictException, ForbiddenException } from '@nestjs/common';

/** Machine-readable codes the problem filter copies into the RFC 7807 body as `code`. */
export const PROBLEM_CODES = [
  'REAUTH_FAILED',
  'TWO_FACTOR_REQUIRED_FOR_ROLE',
  'SETTINGS_CONFLICT',
] as const;
export type ProblemCode = (typeof PROBLEM_CODES)[number];

/** A 403 that carries a stable machine code, so clients never have to match on `detail`. */
export class CodedForbiddenException extends ForbiddenException {
  constructor(
    message: string,
    readonly code: ProblemCode,
  ) {
    super({ message, code });
  }
}

/** A 409 that carries a stable machine code (e.g. SETTINGS_CONFLICT after a lost compare-and-set). */
export class CodedConflictException extends ConflictException {
  constructor(
    message: string,
    readonly code: ProblemCode,
  ) {
    super({ message, code });
  }
}

/**
 * Re-authentication failed on a route that needs the current password. A 403, not a 401, so the
 * web app does not treat it as an expired session. Wrong password, locked account and every
 * equal-work path return exactly this body, so no lock state is ever revealed.
 */
export const REAUTH_FAILED_DETAIL = 'The current password is incorrect.';
export function reauthFailed(): CodedForbiddenException {
  return new CodedForbiddenException(REAUTH_FAILED_DETAIL, 'REAUTH_FAILED');
}
