import type { UserRole } from '../../generated/prisma/client';

/** Kind of staff JWT: a full access token, or a short-lived token that only finishes 2FA. */
export type TokenKind = 'access' | 'challenge';

export interface AuthUser {
  id: string;
  orgId: string;
  role: UserRole;
  kind: TokenKind;
}

/** An Express request after JwtAuthGuard has authenticated it. */
export type AuthedRequest = import('express').Request & { user?: AuthUser };
