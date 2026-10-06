// FU-BE-1 (and the TTL pattern of FU-BE-64): the Redis throttler storage against a real Redis.
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { ThrottleBackendUnavailableError, RedisThrottlerStorage } from './redis-throttler-storage';

describe('RedisThrottlerStorage (FU-BE-1, NFR-04)', () => {
  let container: StartedRedisContainer;
  let redis: Redis;
  let storage: RedisThrottlerStorage;
  let n = 0;
  const fresh = (): string => `tracker-${Date.now()}-${n++}`;

  beforeAll(async () => {
    container = await new RedisContainer('redis:8.8').start();
    redis = new Redis(container.getConnectionUrl());
    storage = new RedisThrottlerStorage(redis);
  });
  afterAll(async () => {
    redis.disconnect();
    await container?.stop();
  });

  it('FU-BE-1: counts hits and reports blocked only above the limit', async () => {
    const key = fresh();
    for (let i = 1; i <= 3; i++) {
      const r = await storage.increment(key, 60_000, 3, 0, 'auth');
      expect(r).toMatchObject({ totalHits: i, isBlocked: false, timeToBlockExpire: 0 });
    }
    const over = await storage.increment(key, 60_000, 3, 0, 'auth');
    expect(over.totalHits).toBe(4);
    expect(over.isBlocked).toBe(true);
    expect(over.timeToBlockExpire).toBeGreaterThan(0);
  });

  it('FU-BE-1: the first increment sets the TTL in the same script, so no key lacks one', async () => {
    const key = fresh();
    await storage.increment(key, 60_000, 3, 0, 'auth');
    const [hitKey] = RedisThrottlerStorage.keys('auth', key);
    const pttl = await redis.pttl(hitKey);
    expect(pttl).toBeGreaterThan(0);
    expect(pttl).toBeLessThanOrEqual(60_000);
    // A counter that somehow lost its TTL is repaired by the next hit.
    await redis.persist(hitKey);
    await storage.increment(key, 60_000, 3, 0, 'auth');
    expect(await redis.pttl(hitKey)).toBeGreaterThan(0);
  });

  it('FU-BE-1: the window expires and the count restarts', async () => {
    const key = fresh();
    await storage.increment(key, 300, 1, 0, 'auth');
    expect((await storage.increment(key, 300, 1, 0, 'auth')).isBlocked).toBe(true);
    await new Promise((r) => setTimeout(r, 450));
    const again = await storage.increment(key, 300, 1, 0, 'auth');
    expect(again).toMatchObject({ totalHits: 1, isBlocked: false });
  });

  it('FU-BE-1: a block duration blocks without counting, then the window restarts clean', async () => {
    const key = fresh();
    await storage.increment(key, 5_000, 2, 400, 'auth');
    await storage.increment(key, 5_000, 2, 400, 'auth');
    const tripped = await storage.increment(key, 5_000, 2, 400, 'auth');
    expect(tripped.isBlocked).toBe(true);
    expect(tripped.timeToBlockExpire).toBe(1);
    const stillBlocked = await storage.increment(key, 5_000, 2, 400, 'auth');
    expect(stillBlocked.isBlocked).toBe(true);
    expect(stillBlocked.totalHits).toBe(3);
    await new Promise((r) => setTimeout(r, 550));
    const after = await storage.increment(key, 5_000, 2, 400, 'auth');
    expect(after).toMatchObject({ totalHits: 1, isBlocked: false });
  });

  it('FU-BE-1: parallel increments count exactly', async () => {
    const key = fresh();
    const results = await Promise.all(
      Array.from({ length: 50 }, () => storage.increment(key, 60_000, 30, 0, 'candidate')),
    );
    expect(results.map((r) => r.totalHits).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 50 }, (_, i) => i + 1),
    );
    expect(results.filter((r) => r.isBlocked)).toHaveLength(20);
  });

  it('FU-BE-1: throttler names and keys do not share counters', async () => {
    const key = fresh();
    await storage.increment(key, 60_000, 5, 0, 'auth');
    expect((await storage.increment(key, 60_000, 5, 0, 'candidate')).totalHits).toBe(1);
    expect((await storage.increment(fresh(), 60_000, 5, 0, 'auth')).totalHits).toBe(1);
  });

  it('FU-BE-1: raw trackers (IPs, emails) never appear in key names', async () => {
    const tracker = `203.0.113.${Date.now() % 250}-person@example.com`;
    await storage.increment(tracker, 60_000, 5, 0, 'auth');
    const [hitKey] = RedisThrottlerStorage.keys('auth', tracker);
    expect(hitKey).toMatch(/^throttle:auth:[0-9a-f]{64}$/);
    expect(hitKey).not.toContain('person');
    expect(hitKey).not.toContain('203.0.113');
    expect(await redis.exists(hitKey)).toBe(1);
  });

  it('FU-BE-1: an unreachable Redis rejects with ThrottleBackendUnavailableError, no detail leaked', async () => {
    // A port nothing listens on.
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address() as AddressInfo;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const dead = new Redis({
      host: '127.0.0.1',
      port,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 500,
    });
    dead.on('error', () => undefined);
    try {
      const err: unknown = await new RedisThrottlerStorage(dead)
        .increment('k', 1000, 1, 0, 'auth')
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ThrottleBackendUnavailableError);
      expect(String((err as Error).message)).not.toContain(String(port));
    } finally {
      dead.disconnect();
    }
  });
});
