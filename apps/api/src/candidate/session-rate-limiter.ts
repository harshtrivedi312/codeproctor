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

/** Slots one route may take back per window. */
export const MAX_RELEASES_PER_WINDOW = 2;

// KEYS: 1 counter, 2 released-so-far. ARGV: 1 ms left in the window, 2 max releases.
const RELEASE = `
local n = tonumber(redis.call('GET', KEYS[1]))
if not n or n <= 0 then return 0 end
local done = redis.call('INCR', KEYS[2])
if done == 1 then redis.call('PEXPIRE', KEYS[2], ARGV[1]) end
if done > tonumber(ARGV[2]) then return 0 end
redis.call('DECR', KEYS[1])
return 1
`;

@Injectable()
export class SessionRateLimiter {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /**
   * Counts one request; throws 429 when `limit` per `windowSeconds` is exceeded. Returns the seconds
   * left in the counter's window, which `guarded` uses to refuse a late release.
   */
  async hit(
    route: string,
    sessionId: string,
    limit: number,
    windowSeconds: number,
  ): Promise<number> {
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
    return ttl;
  }

  /**
   * Gives back one slot taken by `hit`, at most MAX_RELEASES_PER_WINDOW times per window (a route
   * that keeps failing busy cannot be turned into a free retry loop), never below zero, and not at
   * all after the window the slot was taken in has ended (`windowEndsAt`): a late release must not
   * take a slot off the new window.
   */
  async release(route: string, sessionId: string, windowEndsAt: number): Promise<void> {
    const left = windowEndsAt - Date.now();
    if (left <= 0) return;
    try {
      await ensureConnected(this.redis);
      await this.redis.eval(
        RELEASE,
        2,
        `rl:${route}:${sessionId}`,
        `rl-released:${route}:${sessionId}`,
        String(left),
        String(MAX_RELEASES_PER_WINDOW),
      );
    } catch {
      // Best effort: the window expires by itself.
    }
  }

  /**
   * `hit`, then `fn`. When `fn` fails because the session row is busy (lock timeout, deadlock), the
   * slot is given back (capped, see release) and the error is rethrown unchanged, so a 503 the
   * client retries does not use up its rate limit (DL-37). Any other error keeps the slot. Do not
   * use it for the heartbeat: the next beat is the retry.
   */
  async guarded<T>(
    route: string,
    sessionId: string,
    limit: number,
    windowSeconds: number,
    fn: () => Promise<T>,
  ): Promise<T> {
    const ttl = await this.hit(route, sessionId, limit, windowSeconds);
    const windowEndsAt = Date.now() + ttl * 1000;
    try {
      return await fn();
    } catch (e) {
      if (isBusyLockError(e)) await this.release(route, sessionId, windowEndsAt);
      throw e;
    }
  }
}
