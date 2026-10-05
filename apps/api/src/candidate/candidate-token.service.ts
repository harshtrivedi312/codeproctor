// Candidate JWTs (ADR 0013 section 5.10, C-4). Signed with their own secret (JWT_CANDIDATE_SECRET),
// never the staff secret, so a staff token cannot verify here and a candidate token cannot verify on
// a staff route. The algorithm is pinned to HS256 and iss, aud and exp are checked. The token binds
// one session (sid), its org (oid) and the auth epoch (ADR 0002 L-2). Never log a token.
import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import jwt from 'jsonwebtoken';
import { CodedHttpException } from '../common/coded.exception';
import type { Env } from '../config/env';
import type { CandidateClaims } from './candidate.types';

export const CANDIDATE_ISSUER = 'codeproctor-api';
export const CANDIDATE_AUDIENCE = 'codeproctor-candidate';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CandidateTokenFailure = 'expired' | 'invalid';

export class CandidateTokenError extends Error {
  constructor(readonly reason: CandidateTokenFailure) {
    super(`Candidate token ${reason}`);
  }
}

export interface IssuedToken {
  readonly token: string;
  readonly expiresAt: Date;
}

@Injectable()
export class CandidateTokenService {
  constructor(private readonly config: ConfigService<Env, true>) {}

  get ttlSeconds(): number {
    return this.config.get('CANDIDATE_TOKEN_TTL_SECONDS', { infer: true });
  }

  private secret(): string {
    const secret = this.config.get('JWT_CANDIDATE_SECRET', { infer: true });
    if (secret === undefined) {
      throw new CodedHttpException(
        HttpStatus.SERVICE_UNAVAILABLE,
        'The candidate portal is not configured.',
        'CANDIDATE_PORTAL_UNCONFIGURED',
      );
    }
    return secret;
  }

  sign(claims: { sid: string; oid: string; epoch: number }, now: Date = new Date()): IssuedToken {
    const ttl = this.ttlSeconds;
    const iat = Math.floor(now.getTime() / 1000);
    const token = jwt.sign(
      { typ: 'candidate', sid: claims.sid, oid: claims.oid, epoch: claims.epoch, iat },
      this.secret(),
      { algorithm: 'HS256', expiresIn: ttl, issuer: CANDIDATE_ISSUER, audience: CANDIDATE_AUDIENCE },
    );
    return { token, expiresAt: new Date((iat + ttl) * 1000) };
  }

  /** Throws CandidateTokenError('expired') or ('invalid'). Never returns a half-checked payload. */
  verify(token: string): CandidateClaims {
    let payload: unknown;
    try {
      payload = jwt.verify(token, this.secret(), {
        algorithms: ['HS256'],
        issuer: CANDIDATE_ISSUER,
        audience: CANDIDATE_AUDIENCE,
      });
    } catch (e) {
      if (e instanceof jwt.TokenExpiredError) throw new CandidateTokenError('expired');
      if (e instanceof CodedHttpException) throw e;
      throw new CandidateTokenError('invalid');
    }
    if (typeof payload !== 'object' || payload === null) throw new CandidateTokenError('invalid');
    const c = payload as Record<string, unknown>;
    if (
      c.typ !== 'candidate' ||
      typeof c.sid !== 'string' ||
      !UUID.test(c.sid) ||
      typeof c.oid !== 'string' ||
      !UUID.test(c.oid) ||
      typeof c.epoch !== 'number' ||
      !Number.isInteger(c.epoch) ||
      c.epoch < 0 ||
      typeof c.exp !== 'number'
    ) {
      throw new CandidateTokenError('invalid');
    }
    return { sid: c.sid.toLowerCase(), oid: c.oid.toLowerCase(), epoch: c.epoch, exp: c.exp };
  }
}
