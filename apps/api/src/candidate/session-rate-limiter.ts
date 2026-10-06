// Per-session fixed-window rate limits in Redis (ADR 0013 section 5.1): `rl:{route}:{sessionId}`.
// The key is built from the session id of the CandidateContext, never from client input (CS-3).
// One Lua script does INCR and EXPIRE together, so a crash between them cannot leave a counter
// without an expiry. Over the limit answers 429 RATE_LIMITED with Retry-After.
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { CodedHttpException } from '../common/coded.exception';
import { REDIS_CLIENT } from '../infrastructure/infrastructure.module';
import { ensureConnected } from '../infrastructure/redis-ready';
import { isBusyLockError } from './busy-lock-error';

const SCRIPT = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('TTL', KEYS[1])
if ttl < 0 then redis.call('EXPIRE', KEYS[1], ARGV[1]); ttl = tonumber(ARGV[1]) end
return {n, ttl}
`;

@Injectable()
export class SessionRateLimiter {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /** Counts one request; throws 429 when `limit` per `windowSeconds` is exceeded. */
  async hit(route: string, sessionId: string, limit: number, windowSeconds: number): Promise<void> {
    await ensureConnected(this.redis);
    const [count, ttl] = (await this.redis.eval(
      SCRIPT,
      1,
      `rl:${route}:${sessionId}`,
      String(windowSeconds),
    )) as [number, number];
    if (count > limit) {
      throw new CodedHttpException(
        HttpStatus.TOO_MANY_REQUESTS,
        'Too many requests. Try again shortly.',
        'RATE_LIMITED',
        { retryAfterSeconds: Math.max(1, ttl) },
      );
    }
  }

  /** Gives back one slot taken by `hit` (never below zero). */
  async release(route: string, sessionId: string): Promise<void> {
    try {
      await ensureConnected(this.redis);
      await this.redis.eval(
        "local n = tonumber(redis.call('GET', KEYS[1])) if n and n > 0 then redis.call('DECR', KEYS[1]) end",
        1,
        `rl:${route}:${sessionId}`,
      );
    } catch {
      // Best effort: the window expires by itself.
    }
  }

  /**
   * `hit`, then `fn`. When `fn` fails because the session row is busy (lock timeout, deadlock),
   * the slot is given back and the error is rethrown unchanged, so a 503 the client retries does
   * not use up its rate limit (DL-37). Any other error keeps the slot.
   */
  async guarded<T>(
    route: string,
    sessionId: string,
    limit: number,
    windowSeconds: number,
    fn: () => Promise<T>,
  ): Promise<T> {
    await this.hit(route, sessionId, limit, windowSeconds);
    try {
      return await fn();
    } catch (e) {
      if (isBusyLockError(e)) await this.release(route, sessionId);
      throw e;
    }
  }
}
