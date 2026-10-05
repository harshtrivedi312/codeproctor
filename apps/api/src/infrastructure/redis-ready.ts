// One shared connect promise per Redis client (FU-BE-33, QA-D-04). The client is lazy and has no
// offline queue, so a command sent while the client is still connecting fails fast. Every caller
// therefore waits for the in-flight connect (or an auto-reconnect) to reach 'ready', bounded by
// the client's connect timeout, and a genuinely down Redis still fails closed quickly.
import type { Redis } from 'ioredis';

const connecting = new WeakMap<Redis, Promise<void>>();
const DEFAULT_TIMEOUT_MS = 10_000;

function waitForReady(redis: Redis): Promise<void> {
  const timeoutMs = redis.options?.connectTimeout ?? DEFAULT_TIMEOUT_MS;
  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      redis.off('ready', onReady);
      redis.off('error', onFail);
      redis.off('end', onFail);
    };
    const onReady = (): void => {
      cleanup();
      resolve();
    };
    const onFail = (e?: Error): void => {
      cleanup();
      reject(e instanceof Error ? e : new Error('Redis connection ended'));
    };
    const timer = setTimeout(() => onFail(new Error('Redis ready timeout')), timeoutMs);
    redis.on('ready', onReady);
    redis.on('error', onFail);
    redis.on('end', onFail);
    // The client may have become ready between the status check and the listeners.
    if (redis.status === 'ready') onReady();
  });
}

export function ensureConnected(redis: Redis): Promise<void> {
  if (redis.status === 'ready') return Promise.resolve();
  const existing = connecting.get(redis);
  if (existing) return existing;
  const pending: Promise<void> =
    redis.status === 'wait' || redis.status === 'end' ? redis.connect() : waitForReady(redis); // 'connecting' | 'connect' | 'reconnecting' | 'close' without our promise
  const tracked = pending.finally(() => {
    if (connecting.get(redis) === tracked) connecting.delete(redis);
  });
  connecting.set(redis, tracked);
  return tracked;
}
