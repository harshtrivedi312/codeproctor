import { SetMetadata } from '@nestjs/common';
import type { UserRole } from '../../generated/prisma/client';

export const IS_PUBLIC = 'auth:public';
export const ROLES = 'auth:roles';

/** Explicit opt-out of authentication. Every other route is deny-by-default. */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);

/** Roles allowed on a route. A route with neither @Public() nor @Roles() is refused. */
export const Roles = (...roles: UserRole[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES, roles);
