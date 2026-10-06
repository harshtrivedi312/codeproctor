import { ForbiddenException, HttpException } from '@nestjs/common';

/** Machine-readable codes the problem filter copies into the RFC 7807 body as `code`. */
export const PROBLEM_CODES = ['REAUTH_FAILED', 'TWO_FACTOR_REQUIRED_FOR_ROLE'] as const;

/**
 * Codes of the candidate session routes (BE-07, ADR 0013 section 5.1 and 5.10). Clients branch on
 * these, never on the status alone or on `detail`.
 */
export const CANDIDATE_PROBLEM_CODES = [
  'TOKEN_EXPIRED',
  'SESSION_TAKEN_OVER',
  'INVALID_LINK',
  'OTP_INVALID',
  'OTP_NOT_REQUESTED',
  'OTP_COOLDOWN',
  'LINK_BLOCKED',
  'LINK_ALREADY_USED',
  'LINK_EXPIRED',
  'LINK_DECLINED',
  'WINDOW_NOT_OPEN',
  'SESSION_NOT_ACTIVE',
  'SESSION_PAUSED',
  'ILLEGAL_TRANSITION',
  'SESSION_STATE_CONFLICT',
  'CONSENT_NOT_CONFIGURED',
  'CONSENT_NOT_APPROVED',
  'CONSENT_TEXT_CHANGED',
  'ALREADY_SIGNED',
  'AGE_CONFIRMATION_REQUIRED',
  'SIGNED_NAME_INVALID',
  'SYSTEM_CHECK_BLOCKED',
  'RANDOM_RULE_UNSATISFIABLE',
  'KEY_ALREADY_ISSUED',
  'KEY_UNAVAILABLE',
  'RATE_LIMITED',
  'CANDIDATE_PORTAL_UNCONFIGURED',
  'MAIL_UNAVAILABLE',
  // Media presign and confirm (BE-09, ADR 0013 section 5.5).
  'SEQ_CONFLICT',
  'CHUNK_NOT_PRESIGNED',
  'UPLOAD_NOT_FOUND',
  'UPLOAD_MISMATCH',
  'PRESIGN_QUOTA_EXCEEDED',
  'STORAGE_UNCONFIGURED',
  'STORAGE_UNAVAILABLE',
  // Identity check (BE-08b, ADR 0013 5.6, ADR 0015 section 3, ADR 0004 section 1).
  'IDENTITY_CHECK_WAIVED',
  'IDENTITY_CHECK_PENDING',
  'IDENTITY_ATTEMPTS_EXHAUSTED',
  'IDENTITY_NAME_INVALID',
  'IDENTITY_IMAGE_REJECTED',
] as const;
export type CandidateProblemCode = (typeof CANDIDATE_PROBLEM_CODES)[number];
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
 * Any 4xx or 503 that carries a stable machine code (ADR 0013 section 5.1). `extensions` are extra
 * RFC 7807 members such as `status` (SESSION_NOT_ACTIVE) or `retryAfterSeconds`; they hold facts
 * about the caller's own session only, never secrets.
 */
export class CodedHttpException extends HttpException {
  constructor(
    status: number,
    message: string,
    readonly code: CandidateProblemCode,
    readonly extensions: Readonly<Record<string, string | number | null>> = {},
  ) {
    super({ message, code }, status);
  }
}
