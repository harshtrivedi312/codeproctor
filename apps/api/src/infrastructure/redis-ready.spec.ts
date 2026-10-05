import { EventEmitter } from 'node:events';
import type { Redis } from 'ioredis';
import { ensureConnected } from './redis-ready';

type Status = 'wait' | 'connecting' | 'reconnecting' | 'ready' | 'end';

/** A minimal ioredis stand-in: an emitter with a status, options and a connect() spy. */
class FakeRedis extends EventEmitter {
  status: Status = 'wait';
  options = { connectTimeout: 200 };
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
    this.status = 'ready';
    this.settle?.resolve();
    this.emit('ready');
  }

  fail(e: Error): void {
    this.status = 'end';
    this.settle?.reject(e);
  }

  asRedis(): Redis {
    return this as unknown as Redis;
  }
}

describe('ensureConnected (FR-102, TC-003, NFR-09: QA-D-04 cold start)', () => {
  it('TC-003: N concurrent callers during connecting all resolve once ready with one connect() call', async () => {
    const r = new FakeRedis();
    const calls = Array.from({ length: 8 }, () => ensureConnected(r.asRedis()));
    expect(r.connectCalls).toBe(1);
    r.becomeReady();
    await expect(Promise.all(calls)).resolves.toHaveLength(8);
    expect(r.connectCalls).toBe(1);
  });

  it('TC-003: a caller arriving while status is connecting (promise pending) waits and resolves', async () => {
    const r = new FakeRedis();
    const first = ensureConnected(r.asRedis());
    expect(r.status).toBe('connecting');
    let late = false;
    const second = ensureConnected(r.asRedis()).then(() => {
      late = true;
    });
    await Promise.resolve();
    expect(late).toBe(false);
    r.becomeReady();
    await Promise.all([first, second]);
    expect(late).toBe(true);
    expect(r.connectCalls).toBe(1);
  });

  it('TC-003: a client auto-reconnecting with no stored promise waits for ready without calling connect()', async () => {
    const r = new FakeRedis();
    r.status = 'reconnecting';
    const waiting = ensureConnected(r.asRedis());
    r.status = 'ready';
    r.emit('ready');
    await expect(waiting).resolves.toBeUndefined();
    expect(r.connectCalls).toBe(0);
  });

  it('TC-003: an already ready client returns immediately', async () => {
    const r = new FakeRedis();
    r.status = 'ready';
    await expect(ensureConnected(r.asRedis())).resolves.toBeUndefined();
    expect(r.connectCalls).toBe(0);
  });

  it('NFR-09: a Redis that never becomes ready rejects within the timeout (fails closed)', async () => {
    const r = new FakeRedis();
    r.status = 'connecting';
    const started = Date.now();
    await expect(ensureConnected(r.asRedis())).rejects.toThrow('Redis ready timeout');
    expect(Date.now() - started).toBeLessThan(1000);
    expect(r.listenerCount('ready')).toBe(0);
  });

  it('NFR-09: a reconnecting client that errors rejects the waiter', async () => {
    const r = new FakeRedis();
    r.status = 'reconnecting';
    const waiting = ensureConnected(r.asRedis());
    r.emit('error', new Error('ECONNREFUSED'));
    await expect(waiting).rejects.toThrow('ECONNREFUSED');
  });

  it('NFR-09: a connect failure rejects all waiters and a later call retries', async () => {
    const r = new FakeRedis();
    const calls = Array.from({ length: 4 }, () => ensureConnected(r.asRedis()));
    const settled = Promise.allSettled(calls);
    r.fail(new Error('ECONNREFUSED'));
    const results = await settled;
    expect(results.every((x) => x.status === 'rejected')).toBe(true);
    expect(r.connectCalls).toBe(1);

    const retry = ensureConnected(r.asRedis());
    expect(r.connectCalls).toBe(2);
    r.becomeReady();
    await expect(retry).resolves.toBeUndefined();
  });
});
