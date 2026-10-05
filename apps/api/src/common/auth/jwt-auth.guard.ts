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
import { TokenValidityService } from './token-validity.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface StaffClaims {
  sub: string;
  org: string;
  role: UserRole;
  kind: TokenKind;
  pwv?: unknown;
  iat?: unknown;
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
    private readonly validity: TokenValidityService,
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
    // The org is known from the verified token, so the re-check runs in that org's scope, not in
    // an unfiltered one (FU-DB-102): another org's user is simply not found. The scope ends here,
    // before OrgContextInterceptor enters runAsUser. A malformed org claim is a 401, not a 500.
    const userId = claims.sub;
    if (!UUID.test(claims.org) || !UUID.test(userId)) {
      throw new UnauthorizedException('Authentication required.');
    }
    const current = await this.orgContext.runInOrg(claims.org, () =>
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

    // A role change or deactivation after this token was issued ends it for good, even if the
    // user later gets the old role or account back (Redis marker; 503 when Redis is down).
    if (typeof claims.iat !== 'number' || !(await this.validity.isFresh(claims.sub, claims.iat))) {
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
