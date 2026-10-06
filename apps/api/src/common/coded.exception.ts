import { ConflictException, ForbiddenException } from '@nestjs/common';

/** Machine-readable codes the problem filter copies into the RFC 7807 body as `code`. */
export const PROBLEM_CODES = [
  'REAUTH_FAILED',
  'TWO_FACTOR_REQUIRED_FOR_ROLE',
  'SETTINGS_CONFLICT',
  'VARIANT_HAS_AI_REFERENCES',
  // The 503 for database lock contention (DL-37); only ProblemFilter's lock path sets it.
  'BUSY',
] as const;
export type ProblemCode = (typeof PROBLEM_CODES)[number];
/** The codes a coded exception may carry: BUSY belongs to the lock path of ProblemFilter alone. */
export type ExceptionProblemCode = Exclude<ProblemCode, 'BUSY'>;

/** A 403 that carries a stable machine code, so clients never have to match on `detail`. */
export class CodedForbiddenException extends ForbiddenException {
  constructor(
    message: string,
    readonly code: ExceptionProblemCode,
  ) {
    super({ message, code });
  }
}

/** A 409 that carries a stable machine code (e.g. SETTINGS_CONFLICT after a lost compare-and-set). */
export class CodedConflictException extends ConflictException {
  constructor(
    message: string,
    readonly code: ExceptionProblemCode,
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

/**
 * Every refusal on POST /auth/2fa/disable (wrong password, wrong or replayed code, locked
 * account, password changed meanwhile) carries this one detail, so it never says which factor was
 * wrong and never tells the user to retype a password that was right (FU-BE-58). Status and code
 * stay 403 REAUTH_FAILED. A code that already signed the user in is a replay: wait for the next one.
 */
export const DISABLE_REFUSED_DETAIL = 'The password or code is incorrect.';
export function disableRefused(): CodedForbiddenException {
  return new CodedForbiddenException(DISABLE_REFUSED_DETAIL, 'REAUTH_FAILED');
}
