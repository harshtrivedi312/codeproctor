// Windowed counters in Redis (FU-BE-64). INCR and the expiry are ONE Lua script, so a dropped
// connection or a crash between two commands can never leave a counter without a TTL (which
// would rate-limit the caller forever), and parallel hits count exactly. A key that already has
// no TTL (left by an older build, or any other cause) gets its expiry from the next hit. Same
// idea as the throttler store (src/throttle/redis-throttler-storage.ts). Callers keep their own
// Redis-down convention: this function throws, and they map that (503, or fail closed).
import type { Redis } from 'ioredis';

// KEYS[1] counter. ARGV[1] window seconds. Returns {count, ttl seconds}.
export const WINDOW_COUNTER_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('TTL', KEYS[1])
if count == 1 or ttl < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}`;

export interface WindowHit {
  count: number;
  ttlSeconds: number;
}

/** Counts one hit in the window. Throws when Redis fails or answers unexpectedly. */
export async function hitWindowCounter(
  redis: Redis,
  key: string,
  windowSeconds: number,
): Promise<WindowHit> {
  const reply: unknown = await redis.eval(WINDOW_COUNTER_SCRIPT, 1, key, String(windowSeconds));
  if (!Array.isArray(reply) || reply.length !== 2) {
    throw new Error('Unexpected counter reply');
  }
  const [count, ttlSeconds] = reply.map(Number);
  if (
    count === undefined ||
    ttlSeconds === undefined ||
    !Number.isFinite(count) ||
    !Number.isFinite(ttlSeconds)
  ) {
    throw new Error('Unexpected counter reply');
  }
  return { count, ttlSeconds };
}

// KEYS[1] counter. Gives one hit back, never below zero, and never creates the key.
export const WINDOW_REFUND_SCRIPT = `
local v = tonumber(redis.call('GET', KEYS[1]))
if v and v > 0 then return redis.call('DECR', KEYS[1]) end
return 0`;

/**
 * Gives back one hit of a window counter (a slot taken for an attempt that failed for a reason
 * the caller could not control, such as database lock contention, DL-37). Best effort: a Redis
 * failure is swallowed so it never masks the error being propagated. Never use it on a counter
 * that records a failed authentication.
 */
export async function refundWindowCounter(redis: Redis, key: string): Promise<void> {
  try {
    await redis.eval(WINDOW_REFUND_SCRIPT, 1, key);
  } catch {
    // The slot stays taken until the window ends; the original error is what matters.
  }
}
