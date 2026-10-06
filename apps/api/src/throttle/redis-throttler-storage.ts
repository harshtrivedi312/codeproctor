// Redis-backed throttler storage (FU-BE-1, NFR-04). The default Nest store is per process and
// resets on restart, so limits would multiply with every API instance. Each hit is ONE atomic Lua
// script (INCR, PEXPIRE on the first hit, block handling), so a dropped connection or a crash can
// never leave a counter without a TTL (the failure mode of FU-BE-64) and parallel hits across
// instances count exactly. No extra dependency: it speaks the ioredis client the API already has.
//
// Fixed window: a client can land up to 2x the limit across a window boundary, unlike the in-memory
// sliding log. That is acceptable because the per-account lockout is the real defense for the
// 2FA and password routes; this throttle is a volume brake.
//
// Key names are `throttle:{throttler}:{sha256(key)}`, so IPs and emails never appear in Redis.
// Redis down: increment() rejects with ThrottleBackendUnavailableError; the guard turns that into
// 503 for throttled routes (fail closed, like the other Redis-dependent routes) and /health is
// @SkipThrottle(), so the probe still reports the outage.
import { Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { ThrottlerStorage } from '@nestjs/throttler';
import type { Redis } from 'ioredis';
import { ensureConnected } from '../infrastructure/redis-ready';

export interface ThrottlerRecord {
  totalHits: number;
  timeToExpire: number;
  isBlocked: boolean;
  timeToBlockExpire: number;
}

export class ThrottleBackendUnavailableError extends Error {
  constructor() {
    super('Throttle store is unavailable');
    this.name = 'ThrottleBackendUnavailableError';
  }
}

// KEYS[1] hit counter, KEYS[2] block marker. ARGV: ttl ms, limit, block duration ms.
// Returns {totalHits, ttl ms, isBlocked (0/1), block ms left}.
// - While a block marker lives, hits are not counted and the caller stays blocked.
// - The TTL is set whenever the counter has none (first hit, or a repaired key), in the same script.
// - With a block duration, the hit over the limit sets the block marker and aligns the counter's
//   expiry with it, so the window restarts clean when the block ends.
// - Without one, the caller is blocked while the window holds more than `limit` hits.
export const THROTTLE_SCRIPT = `
local blockLeft = redis.call('PTTL', KEYS[2])
if blockLeft > 0 then
  local current = tonumber(redis.call('GET', KEYS[1]) or '0')
  return {current, blockLeft, 1, blockLeft}
end
local ttl = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local block = tonumber(ARGV[3])
local hits = redis.call('INCR', KEYS[1])
local left = redis.call('PTTL', KEYS[1])
if hits == 1 or left < 0 then
  redis.call('PEXPIRE', KEYS[1], ttl)
  left = ttl
end
if block > 0 then
  if hits > limit then
    redis.call('SET', KEYS[2], '1', 'PX', block)
    redis.call('PEXPIRE', KEYS[1], block)
    return {hits, block, 1, block}
  end
  return {hits, left, 0, 0}
end
if hits > limit then
  return {hits, left, 1, left}
end
return {hits, left, 0, 0}
`;

const SCRIPT_SHA = createHash('sha1').update(THROTTLE_SCRIPT).digest('hex');
const WARN_EVERY_MS = 60_000;
const logger = new Logger('ThrottleStore');
let lastWarn = 0;

// Fixed text only, at most once a minute: never the key, the address or the driver error.
function warnUnavailable(): void {
  const now = Date.now();
  if (now - lastWarn < WARN_EVERY_MS) return;
  lastWarn = now;
  logger.warn('Throttle store is unavailable; throttled routes answer 503');
}

const toSeconds = (ms: number): number => Math.max(0, Math.ceil(ms / 1000));

export class RedisThrottlerStorage implements ThrottlerStorage {
  constructor(private readonly redis: Redis) {}

  static keys(throttlerName: string, key: string): [string, string] {
    const digest = createHash('sha256').update(key).digest('hex');
    const base = `throttle:${throttlerName}:${digest}`;
    return [base, `${base}:block`];
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerRecord> {
    const [hitKey, blockKey] = RedisThrottlerStorage.keys(throttlerName, key);
    let reply: unknown;
    try {
      await ensureConnected(this.redis);
      const args = [hitKey, blockKey, Math.ceil(ttl), limit, Math.max(0, Math.ceil(blockDuration))];
      try {
        // EVALSHA keeps the request small; a server that has not cached the script gets it once.
        reply = await this.redis.evalsha(SCRIPT_SHA, 2, ...args);
      } catch (e) {
        if (!(e instanceof Error) || !e.message.includes('NOSCRIPT')) throw e;
        reply = await this.redis.eval(THROTTLE_SCRIPT, 2, ...args);
      }
    } catch {
      warnUnavailable();
      throw new ThrottleBackendUnavailableError();
    }
    if (!Array.isArray(reply) || reply.length !== 4) {
      warnUnavailable();
      throw new ThrottleBackendUnavailableError();
    }
    const [totalHits = 0, ttlMs = 0, blocked = 0, blockMs = 0] = reply.map(Number);
    return {
      totalHits,
      timeToExpire: toSeconds(ttlMs),
      isBlocked: blocked === 1,
      timeToBlockExpire: blocked === 1 ? toSeconds(blockMs) : 0,
    };
  }
}
