// One shared ready-wait per Redis client (FU-BE-33, QA-D-04). The client is lazy and has no
// offline queue, so a command sent while the client is still connecting fails fast. Every caller
// therefore waits for the in-flight connect (or an auto-reconnect) to reach 'ready', all bounded
// by one timer, so a Redis that accepts TCP but never finishes the handshake (or is stuck LOADING)
// cannot hang callers. Any 'error' or 'end' during the wait rejects at once on purpose: this fails
// closed (NFR-04). Do not turn it into retry-until-timeout without a security check.
import type { Redis } from 'ioredis';

const waiting = new WeakMap<Redis, Promise<void>>();
const DEFAULT_TIMEOUT_MS = 10_000;

function waitForReady(redis: Redis): Promise<void> {
  // 0 means "disabled" in ioredis; never allow an unbounded wait.
  const timeoutMs = redis.options?.connectTimeout || DEFAULT_TIMEOUT_MS;
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
  const existing = waiting.get(redis);
  if (existing) return existing;
  // 'wait' and 'end' need a connect() (swallowed: ioredis emits 'error', which the waiter sees);
  // every other status is an in-flight connect or an auto-reconnect.
  if (redis.status === 'wait' || redis.status === 'end') redis.connect().catch(() => undefined);
  const tracked = waitForReady(redis).finally(() => {
    if (waiting.get(redis) === tracked) waiting.delete(redis);
  });
  waiting.set(redis, tracked);
  return tracked;
}
