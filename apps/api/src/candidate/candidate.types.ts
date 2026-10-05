import type { Request } from 'express';
import type { PauseReason, SessionStatus } from '../generated/prisma/enums.js';

/**
 * What every guarded candidate route may rely on. It is built by CandidateSessionGuard from the
 * verified token and the session row it just loaded inside the token's org (ADR 0013 section 5.10).
 * The session id comes only from here (rule CS-1): no candidate route has a `:sessionId` parameter.
 */
export interface CandidateContext {
  readonly sessionId: string;
  readonly orgId: string;
  readonly invitationId: string;
  /** The token's epoch, equal to sessions.auth_epoch when the guard let the request in. */
  readonly epoch: number;
  readonly status: SessionStatus;
  readonly pauseReasons: readonly PauseReason[];
  /** When the presented token expires (server clock), for renewal on the heartbeat. */
  readonly tokenExpiresAt: Date;
}

export type CandidateRequest = Request & { candidate?: CandidateContext };

/** Claims of a candidate JWT (ADR 0013 section 5.10). */
export interface CandidateClaims {
  readonly sid: string;
  readonly oid: string;
  readonly epoch: number;
  readonly exp: number;
}
