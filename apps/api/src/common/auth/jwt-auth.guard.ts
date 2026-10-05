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
import { OrgContextService } from '../../database/org-context';
import { PrismaService } from '../../database/prisma.service';
import { UserRole } from '../../generated/prisma/client';
import { passwordVersion } from '../../auth/crypto.util';
import type { AuthedRequest, AuthUser, TokenKind } from './auth.types';
import { IS_PUBLIC, ROLES } from './decorators';
import { TokenService } from './token.service';

interface StaffClaims {
  sub: string;
  org: string;
  role: UserRole;
  kind: TokenKind;
  pwv?: unknown;
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
    private readonly prisma: PrismaService,
    private readonly orgContext: OrgContextService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    const isPublic = targets.some((t) => this.reflector.get<boolean | undefined>(IS_PUBLIC, t));
    const hasRoles = targets.some((t) => this.reflector.get<UserRole[] | undefined>(ROLES, t));
    // @Public() and @Roles() on one route is a coding mistake. A class-level @Public() must never
    // silently open a method that declares roles, so refuse the route outright (FU-BE-35).
    if (isPublic && hasRoles) throw new ForbiddenException('Forbidden.');
    if (isPublic) return true;

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

    // The token alone is not enough: re-read the user so a deactivation, role change or password
    // reset takes effect at once instead of after the 15 minute token lifetime (FU-BE-19).
    // One primary-key lookup; any database error propagates and the request is refused.
    // Guards run before the interceptor that sets the org context, and the token's org is exactly
    // what this lookup verifies, so it runs in the auth bootstrap system scope (FU-DB-58).
    const userId = claims.sub;
    const current = await this.orgContext.runSystem('AUTH_BOOTSTRAP', () =>
      this.prisma.client.user.findUnique({
        where: { id: userId },
        select: { isActive: true, role: true, orgId: true, passwordHash: true },
      }),
    );
    if (
      !current?.isActive ||
      !current.passwordHash ||
      current.role !== claims.role ||
      current.orgId !== claims.org ||
      claims.pwv !== passwordVersion(current.passwordHash)
    ) {
      throw new UnauthorizedException('Authentication required.');
    }

    const roles = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES, targets);
    if (!roles || !roles.includes(current.role)) throw new ForbiddenException('Forbidden.');

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
