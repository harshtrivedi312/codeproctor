// Per-session fixed-window rate limits in Redis (ADR 0013 section 5.1): `rl:{route}:{sessionId}`.
// The key is built from the session id of the CandidateContext, never from client input (CS-3).
// One Lua script does INCR and EXPIRE together, so a crash between them cannot leave a counter
// without an expiry. Over the limit answers 429 RATE_LIMITED with Retry-After.
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { CodedHttpException } from '../common/coded.exception';
import { REDIS_CLIENT } from '../infrastructure/infrastructure.module';
import { ensureConnected } from '../infrastructure/redis-ready';

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
}
