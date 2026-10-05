// Staff access tokens as BE-02's AuthService mints them, for tests that go through the real
// JwtAuthGuard. The guard checks the signature and expiry, then re-reads the user on every request
// (FU-BE-19): the user must exist, be active, and match the token's role and org, and the token's
// `pwv` claim must equal passwordVersion(user.passwordHash). So a token is only as good as the user
// row behind it: mint it from the same fields the user was created with.
import { passwordVersion } from '../../auth/crypto.util';
import type { TokenService } from '../../common/auth/token.service';
import type { UserRole } from '../../generated/prisma/enums.js';

export interface TokenUser {
  readonly userId: string;
  readonly orgId: string;
  readonly userRole: UserRole;
  readonly passwordHash: string;
}

/** `Bearer <jwt>` with the claims of AuthService.authenticated: sub, org, role, kind and pwv. */
export function staffBearer(
  tokens: TokenService,
  user: TokenUser,
  kind: 'access' | 'challenge' = 'access',
  ttlSeconds = 300,
): string {
  const token = tokens.sign(
    {
      sub: user.userId,
      org: user.orgId,
      role: user.userRole,
      kind,
      pwv: passwordVersion(user.passwordHash),
    },
    ttlSeconds,
  );
  return `Bearer ${token}`;
}
