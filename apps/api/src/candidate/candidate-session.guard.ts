// CandidateSessionGuard (ADR 0013 section 5.10, matching ADR 0006 section 8.4): runs on every
// /candidate/* route except the pre-token ones (link, otp, start).
//   1. Verify the candidate JWT (own secret, HS256, iss, aud, exp, typ).
//   2. Load the session named by the token INSIDE the token's org. A session in another org is
//      simply not found, so a forged or foreign token answers 401 and no cross-org read happens.
//   3. Compare the token's epoch with sessions.auth_epoch: lower means another device passed the
//      OTP, 401 SESSION_TAKEN_OVER (ADR 0002 L-2).
//   4. Put a CandidateContext on the request. The session id used by the handler comes from it.
// Staff tokens fail step 1 (different secret), so they are refused here with 401.
import {
  CanActivate,
  ExecutionContext,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { CodedHttpException } from '../common/coded.exception';
import { PrismaService } from '../database/prisma.service';
import { CandidateScope } from './candidate-scope';
import { CandidateTokenError, CandidateTokenService } from './candidate-token.service';
import type { CandidateRequest } from './candidate.types';

function unauthorized(code?: 'TOKEN_EXPIRED' | 'SESSION_TAKEN_OVER'): never {
  if (code === undefined) throw new UnauthorizedException('Authentication required.');
  throw new CodedHttpException(HttpStatus.UNAUTHORIZED, 'Authentication required.', code);
}

@Injectable()
export class CandidateSessionGuard implements CanActivate {
  constructor(
    private readonly tokens: CandidateTokenService,
    private readonly prisma: PrismaService,
    private readonly scope: CandidateScope,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<CandidateRequest>();
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) unauthorized();

    let claims;
    try {
      claims = this.tokens.verify(header.slice(7));
    } catch (e) {
      if (e instanceof CandidateTokenError && e.reason === 'expired') unauthorized('TOKEN_EXPIRED');
      if (e instanceof CandidateTokenError) unauthorized();
      throw e;
    }

    // The org comes from the verified claims; the scoped client then adds `org_id = oid` itself.
    const session = await this.scope.enter({ orgId: claims.oid, sessionId: claims.sid }, () =>
      this.prisma.client.session.findUnique({
        where: { id: claims.sid },
        select: {
          id: true,
          orgId: true,
          invitationId: true,
          status: true,
          authEpoch: true,
          pauseReasons: true,
        },
      }),
    );
    if (session === null) unauthorized();
    if (claims.epoch < session.authEpoch) unauthorized('SESSION_TAKEN_OVER');
    if (claims.epoch !== session.authEpoch) unauthorized();

    req.candidate = {
      sessionId: session.id,
      orgId: session.orgId,
      invitationId: session.invitationId,
      epoch: session.authEpoch,
      status: session.status,
      pauseReasons: session.pauseReasons,
      tokenExpiresAt: new Date(claims.exp * 1000),
    };
    return true;
  }
}
