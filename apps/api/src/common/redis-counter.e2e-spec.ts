// FU-BE-64: windowed counters are one atomic script, against a real Redis.
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import { hitWindowCounter } from './redis-counter';

describe('hitWindowCounter (FU-BE-64, NFR-04)', () => {
  let container: StartedRedisContainer;
  let redis: Redis;
  let n = 0;
  const fresh = (): string => `counter:${Date.now()}-${n++}`;

  beforeAll(async () => {
    container = await new RedisContainer('redis:8.8').start();
    redis = new Redis(container.getConnectionUrl());
  });
  afterAll(async () => {
    redis.disconnect();
    await container?.stop();
  });

  it('FU-BE-64: the first hit creates the counter with its TTL, later hits keep counting', async () => {
    const key = fresh();
    const first = await hitWindowCounter(redis, key, 60);
    expect(first.count).toBe(1);
    expect(first.ttlSeconds).toBe(60);
    expect(await redis.ttl(key)).toBeGreaterThan(0);
    const second = await hitWindowCounter(redis, key, 60);
    expect(second.count).toBe(2);
    expect(second.ttlSeconds).toBeGreaterThan(0);
    expect(second.ttlSeconds).toBeLessThanOrEqual(60);
  });

  it('FU-BE-64: a later hit does not extend the window (fixed window)', async () => {
    const key = fresh();
    await hitWindowCounter(redis, key, 60);
    await redis.expire(key, 10);
    await hitWindowCounter(redis, key, 60);
    expect(await redis.ttl(key)).toBeLessThanOrEqual(10);
  });

  it('FU-BE-64: a counter that exists without a TTL is repaired by the next hit', async () => {
    const key = fresh();
    // What a dropped connection between INCR and EXPIRE used to leave behind.
    await redis.set(key, '7');
    expect(await redis.ttl(key)).toBe(-1);
    const hit = await hitWindowCounter(redis, key, 120);
    expect(hit.count).toBe(8);
    expect(hit.ttlSeconds).toBe(120);
    const ttl = await redis.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(120);
  });

  it('FU-BE-64: 50 parallel hits count exactly and leave one TTL', async () => {
    const key = fresh();
    const hits = await Promise.all(
      Array.from({ length: 50 }, () => hitWindowCounter(redis, key, 60)),
    );
    expect(hits.map((h) => h.count).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 50 }, (_, i) => i + 1),
    );
    expect(await redis.get(key)).toBe('50');
    expect(await redis.ttl(key)).toBeGreaterThan(0);
  });

  it('FU-BE-64: the window expires and the count restarts at 1 with a TTL', async () => {
    const key = fresh();
    await hitWindowCounter(redis, key, 1);
    await new Promise((r) => setTimeout(r, 1200));
    const again = await hitWindowCounter(redis, key, 1);
    expect(again.count).toBe(1);
    expect(again.ttlSeconds).toBeGreaterThan(0);
    expect(again.ttlSeconds).toBeLessThanOrEqual(1);
    expect(await redis.ttl(key)).toBeGreaterThan(0);
  });

  it('FU-BE-64: a Redis error is thrown to the caller (it chooses 503 or fail closed)', async () => {
    const down = new Redis(container.getConnectionUrl(), { lazyConnect: true });
    down.disconnect();
    await expect(hitWindowCounter(down, fresh(), 60)).rejects.toThrow();
  });
});
