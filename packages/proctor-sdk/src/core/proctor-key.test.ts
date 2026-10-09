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

  it('the time-seeded high fallback is not used when the server gave the counter, even if IndexedDB cannot be read', async () => {
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
    expect(r.sent[0]?.seq).toBe(12);
    expect(flags).not.toContain('event-seq');
    await s.stop();
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
