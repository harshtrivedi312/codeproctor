import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '../../generated/prisma/client';
import type { PrismaService } from '../../database/prisma.module';
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
