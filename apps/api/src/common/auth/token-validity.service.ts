// Access tokens carry no server-side state, so a role change or deactivation would be undone by
// the next change back (A -> B -> A, or deactivate then reactivate) while a token issued before
// the change is still inside its 15 minutes. This marker closes that: when a user's role changes
// or the user is deactivated, `auth:tokens-valid-after:{userId}` is set to the change time (epoch
// seconds) with a TTL a little longer than the access-token lifetime, and the guard refuses any
// access token whose `iat` is at or before it. A token issued in the same second as the change is
// refused too (the user signs in again): no schema column is needed. Clock assumption: the marker
// time and the token `iat` both come from API server clocks, so API instances must be NTP-synced
// to within about a second (single instance today). A deactivate then reactivate, or A -> B -> A, that finishes entirely
// inside one in-flight sign-in still lets that sign-in open a family: its token reflects the
// current state and valid credentials (acceptable). Redis down means the check
// cannot run, so the request is refused with a 503 (fail closed).
import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../../infrastructure/infrastructure.module';
import { ensureConnected } from '../../infrastructure/redis-ready';
import { ACCESS_TTL_SECONDS } from './access-ttl';

/** The marker outlives any token issued before it: the access lifetime plus a margin. */
export const MARKER_TTL_SECONDS = ACCESS_TTL_SECONDS + 5 * 60;

const RAISE_MARKER = `
local cur = tonumber(redis.call('GET', KEYS[1]))
local now = tonumber(ARGV[1])
if cur == nil or now > cur then redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
else redis.call('EXPIRE', KEYS[1], ARGV[2]) end
return 1`;

const key = (userId: string): string => `auth:tokens-valid-after:${userId.toLowerCase()}`;

@Injectable()
export class TokenValidityService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /** Ends every access token issued up to now for this user. Throws 503 when Redis is down. */
  async invalidateIssuedTokens(userId: string): Promise<void> {
    try {
      await ensureConnected(this.redis);
      // The marker is the current second. Every sign-in (startSession, refresh) signs its access
      // token BEFORE its refresh family commits, and a change that writes this marker first waits
      // for that insert's row lock, so a racing token always has iat <= marker second and is
      // refused (same-clock assumption: API instances NTP-synced to about a second, FU-BE-80).
      // The marker is written before the audit insert and stays if the commit fails (it only
      // forces a sign-in, so it fails safe).
      // max(existing, now) in one script, so an instance with a slow clock can never move the
      // marker backwards and revive a token (FU-BE-80 tracks a clock comparison in the health check).
      await this.redis.eval(
        RAISE_MARKER,
        1,
        key(userId),
        String(Math.floor(Date.now() / 1000)),
        String(MARKER_TTL_SECONDS),
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
