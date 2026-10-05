// Access tokens carry no server-side state, so a role change or deactivation would be undone by
// the next change back (A -> B -> A, or deactivate then reactivate) while a token issued before
// the change is still inside its 15 minutes. This marker closes that: when a user's role changes
// or the user is deactivated, `auth:tokens-valid-after:{userId}` is set to the change time (epoch
// seconds) with a TTL a little longer than the access-token lifetime, and the guard refuses any
// access token whose `iat` is at or before it. A token issued in the same second as the change is
// refused too (the user signs in again): no schema column is needed. Redis down means the check
// cannot run, so the request is refused with a 503 (fail closed).
import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../../infrastructure/infrastructure.module';
import { ensureConnected } from '../../infrastructure/redis-ready';

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const MARKER_TTL_SECONDS = ACCESS_TOKEN_TTL_SECONDS + 5 * 60;

const key = (userId: string): string => `auth:tokens-valid-after:${userId.toLowerCase()}`;

@Injectable()
export class TokenValidityService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /** Ends every access token issued up to now for this user. Throws 503 when Redis is down. */
  async invalidateIssuedTokens(userId: string): Promise<void> {
    try {
      await ensureConnected(this.redis);
      await this.redis.set(
        key(userId),
        String(Math.floor(Date.now() / 1000)),
        'EX',
        MARKER_TTL_SECONDS,
      );
    } catch {
      throw new ServiceUnavailableException('Verification is temporarily unavailable.');
    }
  }

  /** True when the token was issued after the last invalidation (or there was none). */
  async isFresh(userId: string, issuedAt: number): Promise<boolean> {
    let raw: string | null;
    try {
      await ensureConnected(this.redis);
      raw = await this.redis.get(key(userId));
    } catch {
      throw new ServiceUnavailableException('Verification is temporarily unavailable.');
    }
    if (raw === null) return true;
    const marker = Number(raw);
    return Number.isFinite(marker) && issuedAt > marker;
  }
}
