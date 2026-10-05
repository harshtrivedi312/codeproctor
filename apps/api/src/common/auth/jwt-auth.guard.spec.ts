import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '../../generated/prisma/client';
import type { PrismaService } from '../../database/prisma.module';
import { passwordVersion } from '../../auth/crypto.util';
import { Public, Roles } from './decorators';
import { JwtAuthGuard } from './jwt-auth.guard';
import type { TokenService } from './token.service';

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
  const guard = new JwtAuthGuard(new Reflector(), {} as TokenService, {} as PrismaService);

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
    sub: 'user-1',
    org: 'org-1',
    role: UserRole.RECRUITER,
    kind: 'access',
    pwv: passwordVersion(HASH),
  };
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
    new JwtAuthGuard(new Reflector(), tokens, {
      client: { user: { findUnique } },
    } as unknown as PrismaService);
  const current = { isActive: true, role: UserRole.RECRUITER, orgId: 'org-1', passwordHash: HASH };

  it('FR-103: a user that still matches the token is let in', async () => {
    await expect(
      guardWith(jest.fn().mockResolvedValue(current)).canActivate(protectedContext()),
    ).resolves.toBe(true);
  });

  it('FR-104: a database error refuses the request instead of trusting the token', async () => {
    const guard = guardWith(jest.fn().mockRejectedValue(new Error('db down')));
    await expect(guard.canActivate(protectedContext())).rejects.toThrow('db down');
  });

  it('FR-103: a token whose user has since moved to another organization is refused', async () => {
    const guard = guardWith(jest.fn().mockResolvedValue({ ...current, orgId: 'org-2' }));
    await expect(guard.canActivate(protectedContext())).rejects.toThrow(UnauthorizedException);
  });
});
