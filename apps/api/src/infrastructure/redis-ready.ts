// One shared connect promise per Redis client (FU-BE-33). The client is lazy, so several requests
// arriving before the first connect would each call connect() and all but one would throw.
import type { Redis } from 'ioredis';

const connecting = new WeakMap<Redis, Promise<void>>();

export function ensureConnected(redis: Redis): Promise<void> {
  if (redis.status !== 'wait' && redis.status !== 'end') return Promise.resolve();
  let pending = connecting.get(redis);
  if (!pending) {
    pending = redis.connect().finally(() => connecting.delete(redis));
    connecting.set(redis, pending);
  }
  return pending;
}
