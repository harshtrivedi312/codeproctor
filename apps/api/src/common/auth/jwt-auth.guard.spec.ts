import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '../../generated/prisma/client';
import type { PrismaService } from '../../database/prisma.service';
import { passwordVersion } from '../../auth/crypto.util';
import { OrgContextService } from '../../database/org-context';
import { Public, Roles } from './decorators';
import { JwtAuthGuard } from './jwt-auth.guard';
import type { TokenService } from './token.service';
import type { TokenValidityService } from './token-validity.service';

const orgContext = new OrgContextService();
const ORG_1 = '11111111-1111-4111-8111-111111111111';
const ORG_2 = '22222222-2222-4222-8222-222222222222';
const USER_1 = '33333333-3333-4333-8333-333333333333';

function contextFor(cls: new () => object, method: string): ExecutionContext {
  const handler = (cls.prototype as Record<string, () => void>)[method] as () => void;
  return {
    getHandler: () => handler,
    getClass: () => cls,
    switchToHttp: () => ({ getRequest: () => ({ headers: {} }) }),
  } as unknown as ExecutionContext;
}

@Public()
class PublicClassWithRoleMethod {
  @Roles(UserRole.SUPER_ADMIN)
  secret(): void {}
  open(): void {}
}

@Roles(UserRole.SUPER_ADMIN)
class RoleClassWithPublicMethod {
  @Public()
  oops(): void {}
}

class BothOnMethod {
  @Public()
  @Roles(UserRole.SUPER_ADMIN)
  both(): void {}
}

describe('JwtAuthGuard decorator conflicts (FR-103, FU-BE-35)', () => {
  const guard = new JwtAuthGuard(
    new Reflector(),
    {} as TokenService,
    {} as PrismaService,
    orgContext,
    {} as TokenValidityService,
  );

  it('FR-103: a class-level @Public() does not open a method that declares @Roles()', async () => {
    await expect(
      guard.canActivate(contextFor(PublicClassWithRoleMethod, 'secret')),
    ).rejects.toThrow(ForbiddenException);
  });

  it('FR-103: @Public() on a method of a @Roles() class fails closed', async () => {
    await expect(guard.canActivate(contextFor(RoleClassWithPublicMethod, 'oops'))).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('FR-103: @Public() and @Roles() on the same method fails closed', async () => {
    await expect(guard.canActivate(contextFor(BothOnMethod, 'both'))).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('FR-103: a @Public() route without roles stays open', async () => {
    await expect(guard.canActivate(contextFor(PublicClassWithRoleMethod, 'open'))).resolves.toBe(
      true,
    );
  });
});

@Roles(UserRole.RECRUITER)
class Protected {
  handle(): void {}
}

describe('JwtAuthGuard user re-check (FR-103, FR-104, FU-BE-19)', () => {
  const HASH = '$argon2id$v=19$m=19456,t=2,p=1$salt$hash';
  const claims = {
    sub: USER_1,
    org: ORG_1,
    role: UserRole.RECRUITER,
    kind: 'access',
    pwv: passwordVersion(HASH),
    iat: 1000,
  };
  let fresh = true;
  const validity = { isFresh: () => Promise.resolve(fresh) } as unknown as TokenValidityService;
  beforeEach(() => {
    fresh = true;
  });
  const tokens = { verify: () => claims } as unknown as TokenService;
  const protectedContext = (): ExecutionContext => {
    const handler = (Protected.prototype as unknown as Record<string, () => void>)
      .handle as () => void;
    return {
      getHandler: () => handler,
      getClass: () => Protected,
      switchToHttp: () => ({ getRequest: () => ({ headers: { authorization: 'Bearer t' } }) }),
    } as unknown as ExecutionContext;
  };
  const guardWith = (findUnique: jest.Mock): JwtAuthGuard =>
    new JwtAuthGuard(
      new Reflector(),
      tokens,
      { client: { user: { findUnique } } } as unknown as PrismaService,
      orgContext,
      validity,
    );
  const current = { isActive: true, role: UserRole.RECRUITER, orgId: ORG_1, passwordHash: HASH };

  it('FR-103: a user that still matches the token is let in', async () => {
    await expect(
      guardWith(jest.fn().mockResolvedValue(current)).canActivate(protectedContext()),
    ).resolves.toBe(true);
  });

  it('FR-104: a database error refuses the request instead of trusting the token', async () => {
    const guard = guardWith(jest.fn().mockRejectedValue(new Error('db down')));
    await expect(guard.canActivate(protectedContext())).rejects.toThrow('db down');
  });

  it('FR-104: a token issued before a role change or deactivation is refused even if the user is back as before (S1)', async () => {
    fresh = false;
    await expect(
      guardWith(jest.fn().mockResolvedValue(current)).canActivate(protectedContext()),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('FR-104: an access token with no iat claim is refused', async () => {
    const noIat = { ...claims } as Record<string, unknown>;
    delete noIat.iat;
    const guard = new JwtAuthGuard(
      new Reflector(),
      { verify: () => noIat } as unknown as TokenService,
      {
        client: { user: { findUnique: jest.fn().mockResolvedValue(current) } },
      } as unknown as PrismaService,
      orgContext,
      validity,
    );
    await expect(guard.canActivate(protectedContext())).rejects.toThrow(UnauthorizedException);
  });

  it('FR-103: a malformed org claim is a 401, not a server error (FU-DB-102)', async () => {
    const guard = new JwtAuthGuard(
      new Reflector(),
      { verify: () => ({ ...claims, org: 'not-a-uuid' }) } as unknown as TokenService,
      { client: { user: { findUnique: jest.fn() } } } as unknown as PrismaService,
      orgContext,
      validity,
    );
    await expect(guard.canActivate(protectedContext())).rejects.toThrow(UnauthorizedException);
  });

  it('FR-103: the re-check runs in the claimed org scope and sends one lookup (FU-DB-102)', async () => {
    let scope: string | undefined;
    const findUnique = jest.fn().mockImplementation(() => {
      const s = orgContext.current()?.scope;
      scope = s?.kind === 'org' ? s.orgId : s?.kind;
      return Promise.resolve(current);
    });
    await expect(guardWith(findUnique).canActivate(protectedContext())).resolves.toBe(true);
    expect(scope).toBe(ORG_1);
    expect(findUnique).toHaveBeenCalledTimes(1);
    // The guard's scope has ended when it returns, before the interceptor enters its own.
    expect(orgContext.current()?.scope).toBeUndefined();
  });

  it('FR-103: a token whose user has since moved to another organization is refused', async () => {
    const guard = guardWith(jest.fn().mockResolvedValue({ ...current, orgId: ORG_2 }));
    await expect(guard.canActivate(protectedContext())).rejects.toThrow(UnauthorizedException);
  });
});
