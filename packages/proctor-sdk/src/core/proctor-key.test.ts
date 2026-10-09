import 'fake-indexeddb/auto';
import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TEST_KEY_B64 } from '../test/helpers';
import type { BatchQueueOptions, SendResult, SignedBatch } from './batch-queue';
import { KeystrokeQueue } from '../keystrokes/keystroke-queue';
import { EventQueue } from './event-queue';
import { IdbStore, STORES } from './idb';
import { hmacKeyName, IdbKeyStore, type KeyStore, type StoredKey } from './key-store';
import { ProctorKeyError, ProctorKeyProvider } from './proctor-key';
import { ProctorSession, type ProctorSessionConfig } from './session';
import { importSessionKey } from './hmac';
import { sweepStaleSessions } from './sweep';

/**
 * proctor-key flow (ADR 0013 sections 2 and 4): the helper, the key store, the counters, setKey.
 * FR-601, FR-609, FR-702, TC-063, TC-065, NFR-04.
 */
const KEY2_B64 = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => 100 + i)));
const TOKEN = 'candidate-token-SECRET-123';
const hmacHex = (b64: string, body: string): string =>
  createHmac('sha256', Buffer.from(b64, 'base64')).update(body).digest('hex');
const Q1 = '8f14e45f-ceea-467a-9575-1b2a7c3d4e5f';
let db = 0;
const newStore = (): IdbStore => new IdbStore(indexedDB, `pk-${++db}`);
afterEach(() => vi.restoreAllMocks());

const keyBody = (over: Record<string, unknown> = {}) => ({
  alg: 'HMAC-SHA256',
  key: KEY2_B64,
  keyEpoch: 3,
  counters: {
    eventSeqStart: 10,
    keystrokeSeqStart: 4,
    media: { WEBCAM: { nextSeq: 7, nextSegment: 2 } },
  },
  ...over,
});
const reply = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });

function provider(
  fetchFn: typeof fetch,
  over: Partial<ConstructorParameters<typeof ProctorKeyProvider>[0]> = {},
) {
  const sleeps: number[] = [];
  const p = new ProctorKeyProvider({
    baseUrl: 'https://api.test/v1',
    sessionId: 'sess',
    getToken: () => TOKEN,
    store: newStore(),
    fetchFn,
    backoffBaseMs: 100,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    ...over,
  });
  return { p, sleeps };
}

describe('ProctorKeyProvider (FR-601, TC-063, ADR 0013 section 4)', () => {
  it('fetches the key once, imports it NON-extractable, stores it with its epoch, parses the counters', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const store = newStore();
    const { p } = provider(
      ((url: string, init: RequestInit) => {
        calls.push({ url, init });
        return Promise.resolve(reply(200, keyBody()));
      }) as unknown as typeof fetch,
      { store },
    );
    const r = await p.ensureKey();
    expect(r.source).toBe('NETWORK');
    expect(r.epoch).toBe(3);
    expect(r.key.extractable).toBe(false);
    expect(r.persisted).toBe(true);
    expect(r.counters).toEqual({
      eventSeqStart: 10,
      keystrokeSeqStart: 4,
      media: { WEBCAM: { nextSeq: 7, nextSegment: 2 } },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.test/v1/candidate/session/proctor-key');
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.body).toBeUndefined();
    expect((calls[0]?.init.headers as Record<string, string>)['Authorization']).toBe(
      `Bearer ${TOKEN}`,
    );
    // The row is in the SDK database next to the counters, the token is nowhere in it.
    const row = await store.get<StoredKey>(STORES.meta, hmacKeyName('sess'));
    expect(row?.epoch).toBe(3);
    expect(row?.key.extractable).toBe(false);
    expect(JSON.stringify(row)).not.toContain(TOKEN);
    // And it signs.
    const sig = Buffer.from(
      await crypto.subtle.sign('HMAC', r.key, new TextEncoder().encode('x')),
    ).toString('hex');
    expect(sig).toBe(hmacHex(KEY2_B64, 'x'));
  });

  it('a reload loads the stored key without a network call; another epoch is not returned', async () => {
    const store = newStore();
    const first = provider(() => Promise.resolve(reply(200, keyBody())), {
      store,
    });
    await first.p.ensureKey();
    const fetchFn = vi.fn();
    const { p } = provider(fetchFn, { store });
    const r = await p.ensureKey(3);
    expect(r).toMatchObject({ source: 'STORE', epoch: 3, counters: null });
    expect(r.key.extractable).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(await p.loadStoredKey(4)).toBeNull(); // a new epoch needs a new key
    expect(await ProctorSession.loadStoredKey('sess', store)).toEqual({ epoch: 3 });
  });

  it('KEY_ALREADY_ISSUED is final: no retry, onKeyUnavailable("ALREADY_ISSUED"), the app runs the OTP resume', async () => {
    const fetchFn = vi.fn(() =>
      Promise.resolve(reply(409, { code: 'KEY_ALREADY_ISSUED', detail: 'secret detail' })),
    );
    const why: string[] = [];
    const { p, sleeps } = provider(fetchFn, {
      onKeyUnavailable: (w) => why.push(w),
    });
    const err = await p.fetchKey().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProctorKeyError);
    expect((err as ProctorKeyError).kind).toBe('ALREADY_ISSUED');
    expect((err as ProctorKeyError).code).toBe('KEY_ALREADY_ISSUED');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
    expect(why).toEqual(['ALREADY_ISSUED']);
    expect(await p.getKey()).toBeNull(); // the session's pull alias: no key, hook already told the app
  });

  it('SESSION_NOT_ACTIVE and 401 are final too, and the errors never carry the token or response text', async () => {
    for (const [status, code, kind] of [
      [409, 'SESSION_NOT_ACTIVE', 'NOT_ACTIVE'],
      [401, 'TOKEN_EXPIRED', 'UNAUTHENTICATED'],
    ] as const) {
      const fetchFn = vi.fn(() => Promise.resolve(reply(status, { code, detail: TOKEN })));
      const { p } = provider(fetchFn);
      const err = (await p.fetchKey().catch((e: unknown) => e)) as ProctorKeyError;
      expect(err.kind).toBe(kind);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(`${err.message} ${JSON.stringify(err)} ${err.stack ?? ''}`).not.toContain(TOKEN);
    }
  });

  it('429 / 503 / network errors back off (Retry-After wins) and then succeed; attempts are bounded', async () => {
    const answers = [
      () => Promise.resolve(reply(429, { code: 'RATE_LIMITED' }, { 'Retry-After': '7' })),
      () => Promise.reject(new TypeError('offline')),
      () => Promise.resolve(reply(503, { code: 'BUSY' })),
      () => Promise.resolve(reply(200, keyBody())),
    ];
    let i = 0;
    const { p, sleeps } = provider(() => (answers[i++] ?? answers[3])!());
    const r = await p.fetchKey();
    expect(r.epoch).toBe(3);
    expect(i).toBe(4);
    expect(sleeps[0]).toBe(7000); // Retry-After
    expect(sleeps[1]).toBe(200); // exponential backoff
    expect(sleeps[2]).toBe(400);

    const down = vi.fn(() => Promise.resolve(reply(503, { code: 'BUSY' })));
    const b = provider(down, { maxAttempts: 3 });
    const err = (await b.p.fetchKey().catch((e: unknown) => e)) as ProctorKeyError;
    expect(err.kind).toBe('UNAVAILABLE');
    expect(down).toHaveBeenCalledTimes(3);
    expect(await b.p.getKey().catch((e: unknown) => e)).toBeInstanceOf(ProctorKeyError); // transient: thrown, the queue retries
  });

  it('a hung request is cut by the timeout (also when fetch ignores the abort signal) and counted as transient', async () => {
    const hung = vi.fn(() => new Promise<Response>(() => undefined));
    const { p } = provider(hung, { timeoutMs: 30, maxAttempts: 2 });
    const err = (await p.fetchKey().catch((e: unknown) => e)) as ProctorKeyError;
    expect(err.kind).toBe('UNAVAILABLE');
    expect(hung).toHaveBeenCalledTimes(2);
  });

  it('concurrent fetches share one request (the server issues the key once)', async () => {
    const fetchFn = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return reply(200, keyBody());
    });
    const { p } = provider(fetchFn);
    const [a, b] = await Promise.all([p.fetchKey(), p.fetchKey()]);
    expect(a.key).toBe(b.key);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('a malformed answer is BAD_RESPONSE and nothing is stored', async () => {
    const store = newStore();
    for (const body of [
      keyBody({ key: 'AAAA' }),
      keyBody({ alg: 'HS1' }),
      keyBody({ keyEpoch: -1 }),
      'not json',
    ]) {
      const { p } = provider(() => Promise.resolve(reply(200, body)), {
        store,
      });
      const err = (await p.fetchKey().catch((e: unknown) => e)) as ProctorKeyError;
      expect(err.kind).toBe('BAD_RESPONSE');
    }
    expect(await store.keys(STORES.meta, 'sess:')).toEqual([]);
  });

  it('if IndexedDB refuses the key it still works in memory and says persisted=false', async () => {
    const failing: KeyStore = {
      get: () => Promise.resolve(null),
      put: () => Promise.reject(new Error('quota')),
      delete: () => Promise.resolve(),
    };
    const { p } = provider(() => Promise.resolve(reply(200, keyBody())), {
      store: failing,
    });
    const r = await p.fetchKey();
    expect(r.persisted).toBe(false);
    expect(r.key.extractable).toBe(false);
  });

  it('only a non-extractable secret key row is accepted back from IndexedDB', async () => {
    const store = newStore();
    const extractable = await crypto.subtle.importKey(
      'raw',
      Buffer.from(KEY2_B64, 'base64'),
      { name: 'HMAC', hash: 'SHA-256' },
      true,
      ['sign'],
    );
    await store.put(STORES.meta, hmacKeyName('sess'), { key: extractable, epoch: 1 });
    expect(await new IdbKeyStore(store).get('sess')).toBeNull();
    await store.put(STORES.meta, hmacKeyName('sess'), { key: 'raw-bytes', epoch: 1 });
    expect(await new IdbKeyStore(store).get('sess')).toBeNull();
  });
});

function sessionRig(over: Partial<ProctorSessionConfig> = {}) {
  const sent: SignedBatch[] = [];
  const ksSent: SignedBatch[] = [];
  const heartbeat = vi.fn(() => Promise.resolve<boolean>(true));
  let emit: (() => void) | null = null;
  const cfg: ProctorSessionConfig = {
    sessionId: 'sess',
    root: document.createElement('div'),
    consent: { recordedAt: '2026-01-01T00:00:00Z' },
    transport: {
      sendBatch: (b) => {
        sent.push(b);
        return Promise.resolve<SendResult>('OK');
      },
      sendKeystrokeBatch: (b) => {
        ksSent.push(b);
        return Promise.resolve<SendResult>('OK');
      },
      heartbeat,
    },
    detectors: [
      {
        id: 'emitter',
        start: (ctx) => {
          emit = () => ctx.emit('TAB_SWITCH', {}, { durationMs: 1 });
        },
        stop: () => undefined,
      },
    ],
    store: newStore(),
    flushIntervalMs: 10,
    backoffBaseMs: 20,
    heartbeatIntervalMs: 30,
    ...over,
  };
  return { cfg, sent, ksSent, heartbeat, fire: () => emit?.() };
}

describe('counters from the key response (ADR 0013 section 2; FR-601, FR-608, TC-063, NFR-04)', () => {
  it('start with signingKey seeds the event and keystroke sequences BEFORE anything is cut', async () => {
    const key = await importSessionKey(KEY2_B64);
    const r = sessionRig({
      signingKey: { key, epoch: 3, counters: { eventSeqStart: 7, keystrokeSeqStart: 3 } },
    });
    const s = new ProctorSession();
    await s.start(r.cfg);
    r.fire();
    s.keystrokes?.reset(Q1, 'python', 'a');
    await vi.waitFor(() => expect(r.sent.length).toBeGreaterThan(0), { timeout: 6000 });
    await vi.waitFor(() => expect(r.ksSent.length).toBeGreaterThan(0), { timeout: 6000 });
    expect(r.sent[0]?.seq).toBe(7);
    expect(r.ksSent[0]?.seq).toBe(3);
    expect(r.sent[0]?.signature).toBe(hmacHex(KEY2_B64, r.sent[0]?.body ?? ''));
    expect(await ProctorSession.loadStoredKey('sess', r.cfg.store as IdbStore)).toEqual({
      epoch: 3,
    });
    await s.stop();
  });

  it('max(local, server) for the event and the keystroke queue: a higher local counter wins, a higher server counter wins', async () => {
    const key = await importSessionKey(KEY2_B64);
    const ev = (k: number) => ({
      type: 'TAB_SWITCH' as const,
      occurredAt: new Date(1_700_000_000_000 + k).toISOString(),
      durationMs: k,
      payload: {},
    });
    const ks = (k: number) => ({
      kind: 'EDIT' as const,
      sessionQuestionId: Q1,
      atMs: 1_700_000_000_000 + k,
      offset: 0,
      deleteLength: 0,
      text: 'x',
    });
    const run = async (
      make: typeof EventQueue | typeof KeystrokeQueue,
      item: (k: number) => unknown,
    ) => {
      const store = newStore();
      const mk = (initialSeq?: number) =>
        new make({
          sessionId: 'sess',
          key,
          store,
          transport: {
            sendBatch: () => Promise.resolve<SendResult>('RETRY'),
          },
          backoffBaseMs: 600_000,
          ...(initialSeq === undefined ? {} : { initialSeq }),
        } satisfies BatchQueueOptions);
      const local = mk();
      await local.start();
      for (let i = 0; i < 3; i++) {
        local.enqueue(item(i));
        await local.flush();
      }
      await local.stop(); // local counter is 3
      // Server behind local: local wins.
      const behind = mk(1);
      await behind.start();
      expect(behind.stats().nextSeq).toBe(3);
      await behind.stop();
      // Server ahead of local: server wins and is persisted for the next load.
      const ahead = mk(50);
      await ahead.start();
      expect(ahead.stats().nextSeq).toBe(50);
      ahead.enqueue(item(9));
      await ahead.flush();
      expect(ahead.stats().nextSeq).toBe(51); // the first new batch took 50
      await ahead.stop();
      const again = mk();
      await again.start();
      expect(again.stats().nextSeq).toBe(51);
      await again.stop();
    };
    await run(EventQueue, ev);
    await run(KeystrokeQueue, ks);
  });

  it('an unreadable counter still takes the time seed (holes, no collisions) even when the server gave one; the server counter only raises', async () => {
    const key = await importSessionKey(KEY2_B64);
    const broken = newStore();
    vi.spyOn(broken, 'entries').mockRejectedValue(new Error('idb'));
    vi.spyOn(broken, 'get').mockRejectedValue(new Error('idb'));
    const flags: string[] = [];
    const r = sessionRig({ store: broken, signingKey: { key, counters: { eventSeqStart: 12 } } });
    const s = new ProctorSession();
    s.on('capability', (f) => flags.push(f.id));
    await s.start(r.cfg);
    r.fire();
    await vi.waitFor(() => expect(r.sent.length).toBeGreaterThan(0), { timeout: 6000 });
    // Batches of an earlier load may sit above the server's counter: the time seed wins, which is
    // above any plausible value; the keystroke queue in this rig takes it too.
    expect(r.sent[0]?.seq).toBeGreaterThan(10_000_000);
    expect(flags).toContain('event-seq');
    await s.stop();
  });

  it('server counters of 2^31 - 1 or more are ignored (the next cut would be an invalid counter)', async () => {
    const q = new EventQueue({
      sessionId: 'sess',
      key: await importSessionKey(KEY2_B64),
      store: newStore(),
      transport: { sendBatch: () => Promise.resolve<SendResult>('OK') },
      initialSeq: 2 ** 31 - 1,
    });
    await q.start();
    expect(q.stats().nextSeq).toBe(0);
    await q.seedSeq(2 ** 31 - 1);
    expect(q.stats().nextSeq).toBe(0);
    await q.seedSeq(2 ** 31 - 2);
    expect(q.stats().nextSeq).toBe(2 ** 31 - 2);
    await q.stop();
  });

  it('the media counters of the response are exactly what pipeline.seedCounters takes', async () => {
    const { p } = provider(() => Promise.resolve(reply(200, keyBody())));
    const r = await p.fetchKey();
    const media: Parameters<import('../recording/pipeline').RecordingPipeline['seedCounters']>[0] =
      r.counters?.media ?? {};
    expect(media).toEqual({ WEBCAM: { nextSeq: 7, nextSegment: 2 } });
  });
});

describe('setKey with epoch and counters; purge; sweep (FR-702, TC-063, TC-065)', () => {
  it('setKey(key, epoch, counters) stores the key, raises the counters, re-signs both outboxes with the same seqs', async () => {
    const em = sessionRig({ hmacKeyBase64: TEST_KEY_B64 });
    let live = false;
    em.cfg.transport.sendBatch = (b) => {
      em.sent.push(b);
      return Promise.resolve(
        !live ? 'RETRY' : b.signature === hmacHex(KEY2_B64, b.body) ? 'OK' : { kind: 'KEY_STALE' },
      );
    };
    const s = new ProctorSession();
    await s.start(em.cfg);
    em.fire();
    await vi.waitFor(() => expect(em.sent.length).toBeGreaterThan(0), { timeout: 6000 });
    const firstBody = em.sent[0]?.body;
    live = true;
    const key2 = await importSessionKey(KEY2_B64);
    await s.setKey(key2, 5, { eventSeqStart: 20 });
    await vi.waitFor(() => expect(s.getQueueStats()?.sentBatches).toBe(1), { timeout: 6000 });
    const ok = em.sent.filter((b) => b.signature === hmacHex(KEY2_B64, b.body));
    expect(ok[0]?.seq).toBe(0);
    expect(ok[0]?.body).toBe(firstBody);
    expect(s.getQueueStats()?.nextSeq).toBe(20); // the counter jumped, no seq is reused
    expect(await ProctorSession.loadStoredKey('sess', em.cfg.store as IdbStore)).toEqual({
      epoch: 5,
    });
    await s.stop();
  });

  it('stop() keeps the key for the reload; finish() purges it with the data', async () => {
    const key = await importSessionKey(KEY2_B64);
    const store = newStore();
    const r = sessionRig({ store, signingKey: { key, epoch: 2 } });
    const s = new ProctorSession();
    await s.start(r.cfg);
    await s.stop();
    expect(await store.get(STORES.meta, hmacKeyName('sess'))).toBeDefined();
    const r2 = sessionRig({ store, signingKey: { key, epoch: 2 } });
    const s2 = new ProctorSession();
    await s2.start(r2.cfg);
    await s2.finish(500);
    expect(await store.get(STORES.meta, hmacKeyName('sess'))).toBeUndefined();
  });

  it('a TAKEN_OVER session purges the key too', async () => {
    const key = await importSessionKey(KEY2_B64);
    const store = newStore();
    const r = sessionRig({ store, signingKey: { key, epoch: 2 } });
    r.heartbeat.mockImplementation(() => Promise.resolve({ ended: 'TAKEN_OVER' } as never));
    const s = new ProctorSession();
    await s.start(r.cfg);
    await vi.waitFor(async () =>
      expect(await store.get(STORES.meta, hmacKeyName('sess'))).toBeUndefined(),
    );
    await s.stop();
  });

  it('the stale sweep removes the key row of an old foreign session but never a live session, even after a long outage', async () => {
    const store = newStore();
    const key = await importSessionKey(KEY2_B64);
    const keys = new IdbKeyStore(store);
    const t0 = 1_800_000_000_000;
    const now = vi.spyOn(Date, 'now').mockReturnValue(t0);
    await keys.put('old', { key, epoch: 1 });
    await store.put(STORES.meta, 'lastseen:old', t0);
    const r = sessionRig({ store, signingKey: { key, epoch: 2 }, heartbeatIntervalMs: 20 });
    const s = new ProctorSession();
    await s.start(r.cfg);
    // 30 hours pass with the page open and the network down: the heartbeat keeps the mark fresh.
    now.mockReturnValue(t0 + 30 * 3600_000);
    await vi.waitFor(async () =>
      expect(await store.get<number>(STORES.meta, 'lastseen:sess')).toBe(t0 + 30 * 3600_000),
    );
    // Another tab (another session id) sweeps now.
    const res = await sweepStaleSessions(store, 'other', t0 + 30 * 3600_000);
    expect(res.sessionsRemoved).toBe(1);
    expect(await keys.get('old')).toBeNull();
    expect(await keys.get('sess')).not.toBeNull();
    // The key row does not confuse the session-id parsing of the sweep.
    expect(await store.keys(STORES.meta, 'sess:')).toContain(hmacKeyName('sess'));
    now.mockRestore();
    await s.stop();
  });

  it('KEY_EPOCH_STALE with the helper as keyProvider: fetches the new epoch once, re-signs, stores it', async () => {
    const store = newStore();
    const fetchFn = vi.fn(() => Promise.resolve(reply(200, keyBody({ keyEpoch: 9 }))));
    const helper = new ProctorKeyProvider({
      baseUrl: 'https://api.test/v1',
      sessionId: 'sess',
      getToken: () => TOKEN,
      store,
      fetchFn: fetchFn,
    });
    const r = sessionRig({ store, hmacKeyBase64: TEST_KEY_B64, keyProvider: helper });
    r.cfg.transport.sendBatch = (b) => {
      r.sent.push(b);
      return Promise.resolve(
        b.signature === hmacHex(KEY2_B64, b.body) ? 'OK' : { kind: 'KEY_STALE' },
      );
    };
    const s = new ProctorSession();
    await s.start(r.cfg);
    r.fire();
    await vi.waitFor(() => expect(s.getQueueStats()?.sentBatches).toBe(1), { timeout: 6000 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(await ProctorSession.loadStoredKey('sess', store)).toEqual({ epoch: 9 });
    await s.stop();
  });

  it('no token or key appears in any capability flag or event the session raises', async () => {
    const key = await importSessionKey(KEY2_B64);
    const r = sessionRig({ signingKey: { key, epoch: 1 } });
    const seen: string[] = [];
    const s = new ProctorSession();
    s.on('capability', (f) => seen.push(JSON.stringify(f)));
    s.on('ended', (e) => seen.push(JSON.stringify(e)));
    await s.start(r.cfg);
    r.fire();
    await s.stop();
    const all = seen.join(' ');
    expect(all).not.toContain(KEY2_B64);
    expect(all).not.toContain(TOKEN);
  });
});

describe('the key is never written after a purge, never extractable (ADR 0013 section 2; FR-702, TC-063)', () => {
  const deferred = <T>() => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  };
  const rowOf = (store: IdbStore) => store.get(STORES.meta, hmacKeyName('sess'));

  it('(i) a refresh that resolves during the finish drain re-signs in memory but stores nothing', async () => {
    const key1 = await importSessionKey(TEST_KEY_B64);
    const key2 = await importSessionKey(KEY2_B64);
    const store = newStore();
    const later = deferred<{ key: CryptoKey; epoch: number }>();
    const r = sessionRig({
      store,
      signingKey: { key: key1, epoch: 1 },
      keyProvider: { getKey: () => later.promise },
    });
    r.cfg.transport.sendBatch = (b) => {
      r.sent.push(b);
      return Promise.resolve(
        b.signature === hmacHex(KEY2_B64, b.body) ? 'OK' : { kind: 'KEY_STALE' },
      );
    };
    const s = new ProctorSession();
    await s.start(r.cfg);
    r.fire();
    await vi.waitFor(() => expect(r.sent.length).toBeGreaterThan(0), { timeout: 6000 });
    const finishing = s.finish(3000);
    await new Promise((x) => setTimeout(x, 30));
    later.resolve({ key: key2, epoch: 4 }); // the provider answers while finish() drains
    const res = await finishing;
    expect(res.lostBatches).toBe(0); // the tail was re-signed and sent
    expect(await rowOf(store)).toBeUndefined();
  });

  it('(ii) a provider answer after TAKEN_OVER and a setKey() after the purge store nothing', async () => {
    const key1 = await importSessionKey(TEST_KEY_B64);
    const key2 = await importSessionKey(KEY2_B64);
    const store = newStore();
    const later = deferred<{ key: CryptoKey; epoch: number }>();
    const r = sessionRig({
      store,
      signingKey: { key: key1, epoch: 1 },
      keyProvider: { getKey: () => later.promise },
    });
    r.cfg.transport.sendBatch = (b) => {
      r.sent.push(b);
      return Promise.resolve({ kind: 'KEY_STALE' });
    };
    const s = new ProctorSession();
    await s.start(r.cfg);
    r.fire();
    await vi.waitFor(() => expect(r.sent.length).toBeGreaterThan(0), { timeout: 6000 });
    r.heartbeat.mockImplementation(() => Promise.resolve({ ended: 'TAKEN_OVER' } as never));
    await vi.waitFor(async () => expect(await rowOf(store)).toBeUndefined(), { timeout: 3000 });
    later.resolve({ key: key2, epoch: 4 });
    await new Promise((x) => setTimeout(x, 50));
    await s.setKey(key2, 5);
    expect(await rowOf(store)).toBeUndefined();
    await s.stop();
  });

  it('(iii) forget() while the helper request is in flight: the late answer is not stored', async () => {
    const store = newStore();
    const gate = deferred<Response>();
    const { p } = provider(() => gate.promise, { store });
    const pending = p.fetchKey();
    await new Promise((x) => setTimeout(x, 10));
    await p.forget();
    gate.resolve(reply(200, keyBody()));
    const res = await pending;
    expect(res.persisted).toBe(false);
    expect(await rowOf(store)).toBeUndefined();
  });

  it('(iv) the helper has its own store: the session purge reaches it through forget()', async () => {
    const helperStore = newStore();
    const { p } = provider(() => Promise.resolve(reply(200, keyBody())), {
      store: helperStore,
    });
    const got = await p.fetchKey();
    expect(await rowOf(helperStore)).toBeDefined();
    const r = sessionRig({ signingKey: got, keyProvider: p }); // session uses ANOTHER IdbStore
    const s = new ProctorSession();
    await s.start(r.cfg);
    await s.finish(500);
    expect(await rowOf(helperStore)).toBeUndefined();
  });

  it('S-c (TC-063, FR-702): a store put still pending across purge, stop() and a new start() is removed when it lands', async () => {
    const real = newStore();
    const inner = new IdbKeyStore(real);
    const gate = deferred<void>();
    let gated = false;
    const keyStore: KeyStore = {
      get: (sid) => inner.get(sid),
      put: async (sid, v) => {
        if (!gated) {
          gated = true;
          await gate.promise; // the first put (setKey) hangs
        }
        return inner.put(sid, v);
      },
      delete: (sid) => inner.delete(sid),
    };
    const key = await importSessionKey(KEY2_B64);
    const r = sessionRig({ store: real, keyStore, signingKey: { key } });
    const s = new ProctorSession();
    await s.start(r.cfg);
    const pending = s.setKey(key, 9); // persistKey waits in the gated put
    await vi.waitFor(() => expect(gated).toBe(true));
    r.heartbeat.mockImplementation(() => Promise.resolve({ ended: 'TAKEN_OVER' } as never));
    await new Promise((x) => setTimeout(x, 100)); // TAKEN_OVER -> purgeKey() while the put hangs
    await s.stop();
    const again = sessionRig({ store: real, keyStore, signingKey: { key } }); // a NEW start()
    await s.start(again.cfg);
    gate.resolve(); // the old put lands now
    await pending.catch(() => undefined);
    await new Promise((x) => setTimeout(x, 30));
    expect(await rowOf(real)).toBeUndefined();
    await s.stop();
  });

  it('B2: an extractable or non-HMAC key is refused by start, setKey and the store, and a provider that returns one gets no adoption', async () => {
    const extractable = await crypto.subtle.importKey(
      'raw',
      Buffer.from(KEY2_B64, 'base64'),
      { name: 'HMAC', hash: 'SHA-256' },
      true,
      ['sign'],
    );
    const store = newStore();
    await expect(
      new IdbKeyStore(store).put('sess', { key: extractable, epoch: 1 }),
    ).rejects.toThrow();
    const s = new ProctorSession();
    await expect(
      s.start(sessionRig({ signingKey: { key: extractable, epoch: 1 } }).cfg),
    ).rejects.toThrow(/non-extractable/);
    const ok = await importSessionKey(KEY2_B64);
    const r = sessionRig({ signingKey: { key: ok } });
    const s2 = new ProctorSession();
    await s2.start(r.cfg);
    await expect(s2.setKey(extractable, 2)).rejects.toThrow(/non-extractable/);
    await s2.stop();

    // A provider that hands out an extractable CryptoKey is not adopted: the queue holds.
    const em = sessionRig({
      hmacKeyBase64: TEST_KEY_B64,
      keyProvider: { getKey: () => Promise.resolve(extractable) },
    });
    em.cfg.transport.sendBatch = (b) => {
      em.sent.push(b);
      return Promise.resolve({ kind: 'KEY_STALE' });
    };
    const flags: string[] = [];
    const s3 = new ProctorSession();
    s3.on('capability', (f) => flags.push(f.id));
    await s3.start(em.cfg);
    em.fire();
    await vi.waitFor(() => expect(flags).toContain('signing-key'), { timeout: 6000 });
    expect(s3.getQueueStats()?.unsentBatches).toBe(1);
    await s3.stop();
  });

  it('S3: a key that cannot be stored raises the ADR flag idb: UNSUPPORTED', async () => {
    const key = await importSessionKey(KEY2_B64);
    const flags: { id: string; status: string }[] = [];
    const s = new ProctorSession();
    s.on('capability', (f) => flags.push(f));
    await s.start(sessionRig({ signingKey: { key, epoch: 1, persisted: false } }).cfg);
    expect(flags).toContainEqual(expect.objectContaining({ id: 'idb', status: 'UNSUPPORTED' }));
    await s.stop();
    const failing: KeyStore = {
      get: () => Promise.resolve(null),
      put: () => Promise.reject(new Error('quota')),
      delete: () => Promise.resolve(),
    };
    const flags2: string[] = [];
    const s2 = new ProctorSession();
    s2.on('capability', (f) => flags2.push(f.id));
    await s2.start(sessionRig({ signingKey: { key, epoch: 1 }, keyStore: failing }).cfg);
    expect(flags2).toContain('idb');
    await s2.stop();
  });

  it('a provider of another session is refused at start', async () => {
    const { p } = provider(() => Promise.resolve(reply(200, keyBody())), {
      sessionId: 'someone-else',
    });
    const key = await importSessionKey(KEY2_B64);
    const s = new ProctorSession();
    await expect(s.start(sessionRig({ signingKey: { key }, keyProvider: p }).cfg)).rejects.toThrow(
      /another session/,
    );
  });
});

describe('cross-tab lock and helper nits (ADR 0013 section 2; FR-601, TC-063)', () => {
  /** A lock manager stub that runs requests of one name one after the other. */
  function lockStub() {
    let tail: Promise<unknown> = Promise.resolve();
    const names: string[] = [];
    return {
      names,
      locks: {
        request<T>(name: string, _o: { signal?: AbortSignal }, cb: () => Promise<T>): Promise<T> {
          names.push(name);
          const run = tail.then(cb);
          tail = run.catch(() => undefined);
          return run;
        },
      },
    };
  }

  it('S1: two tabs asking at once make ONE request; the second finds the key the first stored', async () => {
    const store = newStore();
    const l = lockStub();
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return reply(200, keyBody());
    }) as unknown as typeof fetch;
    const a = provider(fetchFn, { store, locks: l.locks }).p;
    const b = provider(fetchFn, { store, locks: l.locks }).p;
    const [ra, rb] = await Promise.all([a.fetchKey(), b.fetchKey()]);
    expect(calls).toBe(1);
    expect(ra.source).toBe('NETWORK');
    expect(rb).toMatchObject({ source: 'STORE', epoch: 3 });
    expect(l.names).toEqual(['cp-key:sess', 'cp-key:sess']);
  });

  it('B1: forget() while the request waits for the Web Lock: no POST, no row', async () => {
    const store = newStore();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let tail: Promise<unknown> = held; // another tab holds cp-key:<sid>
    const locks = {
      request<T>(_n: string, _o: { signal?: AbortSignal }, cb: () => Promise<T>): Promise<T> {
        const run = tail.then(cb);
        tail = run.catch(() => undefined);
        return run;
      },
    };
    const fetchFn = vi.fn(() => Promise.resolve(reply(200, keyBody())));
    const { p } = provider(fetchFn, { store, locks });
    const pending = p.fetchKey().catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 20));
    await p.forget(); // finish() / TAKEN_OVER purge while the request is queued
    release(); // the lock is granted now
    const err = (await pending) as ProctorKeyError;
    expect(err).toBeInstanceOf(ProctorKeyError);
    expect(err.kind).toBe('CANCELLED'); // final: nobody retries after finish or purge
    expect(fetchFn).not.toHaveBeenCalled(); // the one-time issuance is not burned
    expect(await store.get(STORES.meta, hmacKeyName('sess'))).toBeUndefined();
  });

  it('the lock is released between attempts (a long Retry-After does not park other tabs)', async () => {
    const held: boolean[] = [];
    let inLock = false;
    const locks = {
      request<T>(_n: string, _o: { signal?: AbortSignal }, cb: () => Promise<T>): Promise<T> {
        inLock = true;
        return cb().finally(() => {
          inLock = false;
        });
      },
    };
    let n = 0;
    const { p } = provider(
      () =>
        Promise.resolve(
          ++n === 1 ? reply(429, { code: 'RATE' }, { 'Retry-After': '9' }) : reply(200, keyBody()),
        ),
      {
        locks,
        sleep: () => {
          held.push(inLock);
          return Promise.resolve();
        },
      },
    );
    await p.fetchKey();
    expect(held).toEqual([false]); // the backoff ran outside the lock
  });

  it("lock: 'none' for a caller that already holds cp-key:<sid>; and a frozen lock holder ends as UNAVAILABLE", async () => {
    const never = {
      request<T>(_n: string, o: { signal?: AbortSignal }): Promise<T> {
        return new Promise<T>((_r, reject) => {
          o.signal?.addEventListener('abort', () => reject(new DOMException('x', 'AbortError')));
        });
      },
    };
    const f = (() => Promise.resolve(reply(200, keyBody()))) as unknown as typeof fetch;
    const inner = provider(f, { locks: never }).p;
    expect((await inner.fetchKey(undefined, { lock: 'none' })).epoch).toBe(3); // no nested request
    const frozen = provider(f, { locks: never, lockTimeoutMs: 30 }).p;
    const err = (await frozen.fetchKey().catch((e: unknown) => e)) as ProctorKeyError;
    expect(err.kind).toBe('UNAVAILABLE');
  });

  it('S-b: a failed read of the store before the lock is "unknown": a stored key is only taken when it is of the expected epoch', async () => {
    const store = newStore();
    const key = await importSessionKey(KEY2_B64);
    await new IdbKeyStore(store).put('sess', { key, epoch: 1 });
    let reads = 0;
    const flaky: KeyStore = {
      get: (sid) =>
        ++reads === 1 ? Promise.reject(new Error('idb')) : new IdbKeyStore(store).get(sid),
      put: (sid, v) => new IdbKeyStore(store).put(sid, v),
      delete: (sid) => new IdbKeyStore(store).delete(sid),
    };
    const fetchFn = vi.fn(() => Promise.resolve(reply(200, keyBody({ keyEpoch: 7 }))));
    const { p } = provider(fetchFn, { store: flaky });
    const r = await p.fetchKey(); // no expected epoch: the old row must not be taken
    expect(r.source).toBe('NETWORK');
    expect(r.epoch).toBe(7);
    reads = 0;
    const fetch2 = vi.fn();
    const q = provider(fetch2, { store: flaky }).p;
    await new IdbKeyStore(store).put('sess', { key, epoch: 7 });
    const r2 = await q.fetchKey(7); // expected epoch matches the stored row
    expect(r2.source).toBe('STORE');
    expect(fetch2).not.toHaveBeenCalled();
  });

  it('S-d: if removing the row after a raced put throws, it is retried and no storage failure is reported', async () => {
    const real = newStore();
    const inner = new IdbKeyStore(real);
    let deletes = 0;
    const gate = (() => {
      let r!: () => void;
      const promise = new Promise<void>((x) => (r = x));
      return { promise, release: r };
    })();
    const store: KeyStore = {
      get: (sid) => inner.get(sid),
      put: async (sid, v) => {
        await gate.promise;
        return inner.put(sid, v);
      },
      delete: async (sid) => {
        if (++deletes === 1) throw new Error('flaky');
        return inner.delete(sid);
      },
    };
    let unavailable = 0;
    const { p } = provider(() => Promise.resolve(reply(200, keyBody())), {
      store,
      onStorageUnavailable: () => unavailable++,
    });
    const pending = p.fetchKey();
    await new Promise((r) => setTimeout(r, 30)); // the put is waiting on the gate
    // forget() bumps the generation, its own delete is the first (failing) one
    const forgetting = p.forget().catch(() => undefined);
    gate.release();
    const res = await pending;
    await forgetting;
    expect(res.persisted).toBe(false);
    expect(unavailable).toBe(0);
    expect(await real.get(STORES.meta, hmacKeyName('sess'))).toBeUndefined();
  });

  it('a getToken() that throws is final (UNAUTHENTICATED), not retried', async () => {
    const fetchFn = vi.fn();
    const { p } = provider(fetchFn, {
      getToken: () => {
        throw new Error('no token');
      },
    });
    const err = (await p.fetchKey().catch((e: unknown) => e)) as ProctorKeyError;
    expect(err.kind).toBe('UNAUTHENTICATED');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('an unreadable store is "unknown": loadStoredKey returns null, ensureKey falls through to the server, no detail leaks', async () => {
    const real = newStore();
    vi.spyOn(real, 'get').mockRejectedValue(new Error(`secret ${TOKEN}`));
    const fetchFn = vi.fn(() => Promise.resolve(reply(200, keyBody())));
    const { p } = provider(fetchFn, { store: real });
    expect(await p.loadStoredKey()).toBeNull();
    const r = await p.ensureKey();
    expect(r.source).toBe('NETWORK');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    // IdbKeyStore itself rejects on a failed read (it is not "known empty"), and on a failed delete.
    await expect(new IdbKeyStore(real).get('sess')).rejects.toThrow();
    vi.spyOn(real, 'delete').mockRejectedValue(new Error('idb'));
    await expect(new IdbKeyStore(real).delete('sess')).rejects.toThrow();
    expect(await ProctorSession.loadStoredKey('sess', real)).toBeNull();
  });

  it('a 200 whose key import fails is final BAD_RESPONSE (the server already issued the key): one POST, no retry', async () => {
    vi.spyOn(crypto.subtle, 'importKey').mockRejectedValue(new Error('no subtle'));
    const fetchFn = vi.fn(() => Promise.resolve(reply(200, keyBody())));
    const { p, sleeps } = provider(fetchFn);
    const err = (await p.fetchKey().catch((e: unknown) => e)) as ProctorKeyError;
    expect(err.kind).toBe('BAD_RESPONSE');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it('attempt 1 gets 429, another tab stores the key during the backoff: attempt 2 returns it from the store, no second POST', async () => {
    const store = newStore();
    const key = await importSessionKey(KEY2_B64);
    const fetchFn = vi.fn(() =>
      Promise.resolve(reply(429, { code: 'RATE_LIMITED' }, { 'Retry-After': '1' })),
    );
    const { p } = provider(fetchFn, {
      store,
      sleep: async () => {
        await new IdbKeyStore(store).put('sess', { key, epoch: 6 }); // the other tab got it
      },
    });
    const r = await p.fetchKey();
    expect(r).toMatchObject({ source: 'STORE', epoch: 6 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
