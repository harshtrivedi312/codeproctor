// Global guard (FR-103 foundation, completed by Step 3): deny by default. A route must be
// @Public() or declare @Roles(...). The bearer token is a staff JWT signed with JWT_ACCESS_SECRET.
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '../../generated/prisma/client';
import type { AuthedRequest, AuthUser, TokenKind } from './auth.types';
import { IS_PUBLIC, ROLES } from './decorators';
import { TokenService } from './token.service';

interface StaffClaims {
  sub: string;
  org: string;
  role: UserRole;
  kind: TokenKind;
}

function isClaims(v: unknown): v is StaffClaims {
  if (typeof v !== 'object' || v === null) return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.sub === 'string' &&
    typeof c.org === 'string' &&
    typeof c.role === 'string' &&
    Object.values(UserRole).includes(c.role as UserRole) &&
    (c.kind === 'access' || c.kind === 'challenge')
  );
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, targets)) return true;

    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      throw new UnauthorizedException('Authentication required.');
    }
    let claims: unknown;
    try {
      claims = this.tokens.verify(header.slice(7));
    } catch {
      throw new UnauthorizedException('Authentication required.');
    }
    if (!isClaims(claims)) throw new UnauthorizedException('Authentication required.');
    // A 2FA challenge token is never a session.
    if (claims.kind !== 'access') throw new UnauthorizedException('Authentication required.');

    const roles = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES, targets);
    if (!roles || !roles.includes(claims.role)) throw new ForbiddenException('Forbidden.');

    const user: AuthUser = {
      id: claims.sub,
      orgId: claims.org,
      role: claims.role,
      kind: claims.kind,
    };
    req.user = user;
    return true;
  }
}
