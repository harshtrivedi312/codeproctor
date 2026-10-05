import { EventEmitter } from 'node:events';
import type { Redis } from 'ioredis';
import { ensureConnected } from './redis-ready';

type Status = 'wait' | 'connecting' | 'reconnecting' | 'ready' | 'end';

/** An ioredis stand-in: status events fire on the next tick, a failed connect goes to reconnecting. */
class FakeRedis extends EventEmitter {
  status: Status = 'wait';
  options: { connectTimeout?: number } = { connectTimeout: 200 };
  connectCalls = 0;
  private settle: { resolve: () => void; reject: (e: Error) => void } | null = null;

  connect(): Promise<void> {
    this.connectCalls += 1;
    this.status = 'connecting';
    return new Promise<void>((resolve, reject) => {
      this.settle = { resolve, reject };
    });
  }

  becomeReady(): void {
    process.nextTick(() => {
      this.status = 'ready';
      this.emit('ready');
      this.settle?.resolve();
    });
  }

  fail(e: Error): void {
    process.nextTick(() => {
      this.status = 'reconnecting';
      this.emit('error', e);
      this.settle?.reject(e);
    });
  }

  asRedis(): Redis {
    return this as unknown as Redis;
  }
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

function track(p: Promise<void>): { done: () => boolean } {
  let done = false;
  p.then(
    () => (done = true),
    () => (done = true),
  );
  return { done: () => done };
}

describe('ensureConnected (FR-102, TC-003, NFR-03, NFR-04: QA-D-04 cold start)', () => {
  it('TC-003: N concurrent callers during connecting all wait, then resolve once ready with one connect() call', async () => {
    const r = new FakeRedis();
    const calls = Array.from({ length: 8 }, () => ensureConnected(r.asRedis()));
    const probes = calls.map(track);
    await tick();
    expect(probes.some((p) => p.done())).toBe(false);
    r.becomeReady();
    await expect(Promise.all(calls)).resolves.toHaveLength(8);
    expect(r.connectCalls).toBe(1);
  });

  it('TC-003: a caller arriving while status is connecting waits and resolves', async () => {
    const r = new FakeRedis();
    const first = ensureConnected(r.asRedis());
    expect(r.status).toBe('connecting');
    const second = ensureConnected(r.asRedis());
    const probe = track(second);
    await tick();
    expect(probe.done()).toBe(false);
    r.becomeReady();
    await Promise.all([first, second]);
    expect(r.connectCalls).toBe(1);
  });

  it('TC-003: a client auto-reconnecting with no stored promise waits for ready without calling connect()', async () => {
    const r = new FakeRedis();
    r.status = 'reconnecting';
    const waiting = ensureConnected(r.asRedis());
    const probe = track(waiting);
    await tick();
    expect(probe.done()).toBe(false);
    r.becomeReady();
    await expect(waiting).resolves.toBeUndefined();
    expect(r.connectCalls).toBe(0);
  });

  it('TC-003: an already ready client returns immediately', async () => {
    const r = new FakeRedis();
    r.status = 'ready';
    await expect(ensureConnected(r.asRedis())).resolves.toBeUndefined();
    expect(r.connectCalls).toBe(0);
  });

  it('NFR-04: a connect() that never settles (stuck handshake) rejects within the timeout and leaves no listeners', async () => {
    const r = new FakeRedis();
    const started = Date.now();
    await expect(ensureConnected(r.asRedis())).rejects.toThrow('Redis ready timeout');
    expect(Date.now() - started).toBeLessThan(1000);
    for (const ev of ['ready', 'error', 'end']) expect(r.listenerCount(ev)).toBe(0);
  });

  it('NFR-04: a client stuck in connecting with no promise rejects within the timeout', async () => {
    const r = new FakeRedis();
    r.status = 'connecting';
    await expect(ensureConnected(r.asRedis())).rejects.toThrow('Redis ready timeout');
    expect(r.listenerCount('ready')).toBe(0);
  });

  it('NFR-04: connectTimeout 0 (disabled in ioredis) still gets a bounded default wait', async () => {
    jest.useFakeTimers();
    try {
      const r = new FakeRedis();
      r.options = { connectTimeout: 0 };
      const p = ensureConnected(r.asRedis());
      const assertion = expect(p).rejects.toThrow('Redis ready timeout');
      await jest.advanceTimersByTimeAsync(10_000);
      await assertion;
    } finally {
      jest.useRealTimers();
    }
  });

  it('NFR-04: a reconnecting client that errors rejects the waiter at once', async () => {
    const r = new FakeRedis();
    r.status = 'reconnecting';
    const waiting = ensureConnected(r.asRedis());
    r.emit('error', new Error('ECONNREFUSED'));
    await expect(waiting).rejects.toThrow('ECONNREFUSED');
  });

  it('NFR-04: a connect failure (client goes to reconnecting) rejects all waiters and a later call retries', async () => {
    const r = new FakeRedis();
    const calls = Array.from({ length: 4 }, () => ensureConnected(r.asRedis()));
    const settled = Promise.allSettled(calls);
    r.fail(new Error('ECONNREFUSED'));
    const results = await settled;
    expect(results.every((x) => x.status === 'rejected')).toBe(true);
    expect(r.connectCalls).toBe(1);

    r.status = 'wait';
    const retry = ensureConnected(r.asRedis());
    expect(r.connectCalls).toBe(2);
    r.becomeReady();
    await expect(retry).resolves.toBeUndefined();
  });
});
