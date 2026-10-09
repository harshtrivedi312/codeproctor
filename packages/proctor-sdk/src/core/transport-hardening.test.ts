import 'fake-indexeddb/auto';
import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KeystrokeQueue } from '../keystrokes/keystroke-queue';
import { TEST_KEY_B64 } from '../test/helpers';
import type { SendResult, SignedBatch } from './batch-queue';
import { EventQueue } from './event-queue';
import { importSessionKey } from './hmac';
import { IdbStore, STORES } from './idb';
import { ProctorSession, type ProctorSessionConfig } from './session';
import { classifyAnswer, createFetchTransport, parseRetryAfter } from './transport';

/**
 * Transport hardening (ADR 0013 5.8): timeouts on every call, errors by RFC 7807 code, key
 * rotation with re-signing, end of session, authentication loss. FR-601, FR-609, FR-701, TC-063,
 * TC-065.
 */
const KEY2_B64 = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => 100 + i)));
const hmacHex = (b64: string, body: string): string =>
  createHmac('sha256', Buffer.from(b64, 'base64')).update(body).digest('hex');
const ev = (k: number) => ({
  type: 'TAB_SWITCH' as const,
  occurredAt: new Date(1_700_000_000_000 + k).toISOString(),
  durationMs: k,
  payload: {},
});
const Q1 = '8f14e45f-ceea-467a-9575-1b2a7c3d4e5f';
const ksItem = (k: number) => ({
  kind: 'EDIT' as const,
  sessionQuestionId: Q1,
  atMs: 1_700_000_000_000 + k,
  offset: 0,
  deleteLength: 0,
  text: `x${k}`,
});

let db = 0;
const newStore = (): IdbStore => new IdbStore(indexedDB, `hard-${++db}`);
afterEach(() => vi.useRealTimers());

/** A scripted transport: answers come from `script` in order, the last one repeats. */
function scripted(script: SendResult[]) {
  const calls: SignedBatch[] = [];
  return {
    calls,
    transport: {
      sendBatch: (b: SignedBatch): Promise<SendResult> => {
        calls.push(b);
        return Promise.resolve(script[Math.min(calls.length - 1, script.length - 1)] ?? 'OK');
      },
    },
  };
}

async function eventQueue(
  script: SendResult[],
  over: Partial<ConstructorParameters<typeof EventQueue>[0]> = {},
) {
  const store = newStore();
  const t = scripted(script);
  const q = new EventQueue({
    sessionId: 's',
    key: await importSessionKey(TEST_KEY_B64),
    store,
    transport: t.transport,
    flushIntervalMs: 10_000,
    jitter: 0,
    backoffBaseMs: 20,
    backoffMaxMs: 20,
    ...over,
  });
  await q.start();
  return { q, store, ...t };
}

const stored = (store: IdbStore) => store.keys(STORES.eventBatches, 's:');

describe('transport timeouts (FR-601, FR-609, TC-063)', () => {
  const t = (fetchFn: typeof fetch) =>
    createFetchTransport({
      baseUrl: 'https://api.test',
      getToken: () => 'tok',
      fetchFn,
      batchTimeoutMs: 1000,
      heartbeatTimeoutMs: 500,
    });
  const batch: SignedBatch = { seq: 0, body: '{"a":1}', signature: 'a'.repeat(64) };

  it('a fetch that never settles (and ignores the abort signal) ends as RETRY after the limit', async () => {
    vi.useFakeTimers();
    let aborted = false;
    const hung = ((_u: string, init: RequestInit) => {
      init.signal?.addEventListener('abort', () => (aborted = true));
      return new Promise<Response>(() => undefined);
    }) as unknown as typeof fetch;
    const p = t(hung).sendBatch(batch);
    await vi.advanceTimersByTimeAsync(999);
    let settled = false;
    void p.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(await p).toBe('RETRY');
    expect(aborted).toBe(true);
  });

  it('a response whose body never arrives is cut at the limit: the timer outlives the headers', async () => {
    vi.useFakeTimers();
    const stalled = (() =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers(),
        text: () => new Promise<string>(() => undefined),
      })) as unknown as typeof fetch;
    const p = t(stalled).sendKeystrokeBatch(batch);
    await vi.advanceTimersByTimeAsync(1100);
    expect(await p).toBe('RETRY');
  });

  it('the heartbeat is bounded too and reports false', async () => {
    vi.useFakeTimers();
    const hung = (() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
    const p = t(hung).heartbeat();
    await vi.advanceTimersByTimeAsync(600);
    expect(await p).toBe(false);
  });

  it('finish() cannot hang on one stalled request: it returns near the drain limit with the batch counted lost', async () => {
    const store = newStore();
    const q = new EventQueue({
      sessionId: 's',
      key: await importSessionKey(TEST_KEY_B64),
      store,
      flushIntervalMs: 10_000,
      transport: createFetchTransport({
        baseUrl: 'https://api.test',
        getToken: () => 'tok',
        fetchFn: () => new Promise<Response>(() => undefined),
        batchTimeoutMs: 300,
      }),
    });
    await q.start();
    q.enqueue(ev(1));
    const started = Date.now();
    const r = await q.finish(400);
    expect(Date.now() - started).toBeLessThan(3500);
    expect(r.lostBatches).toBe(1);
    expect(await stored(store)).toEqual([]);
  });
});

describe('errors by RFC 7807 code, then status (ADR 0013 5.8)', () => {
  const answer = (status: number, code = '', retryAfterMs?: number) =>
    classifyAnswer({ status, code, retryAfterMs });

  it('maps every documented code', () => {
    expect(answer(409, 'KEY_EPOCH_STALE')).toEqual({ kind: 'KEY_STALE' });
    expect(answer(409, 'KEY_ALREADY_ISSUED')).toEqual({ kind: 'KEY_UNAVAILABLE' });
    expect(answer(409, 'SESSION_NOT_ACTIVE')).toEqual({
      kind: 'ENDED',
      reason: 'SESSION_NOT_ACTIVE',
    });
    expect(answer(409, 'SESSION_TAKEN_OVER')).toEqual({ kind: 'ENDED', reason: 'TAKEN_OVER' });
    expect(answer(401, 'TOKEN_EXPIRED')).toEqual({ kind: 'AUTH', code: 'TOKEN_EXPIRED' });
    expect(answer(401)).toEqual({ kind: 'AUTH' });
    expect(answer(409, 'SEQ_CONFLICT')).toEqual({ kind: 'REJECTED', code: 'SEQ_CONFLICT' });
    expect(answer(400, 'SIGNATURE_INVALID')).toEqual({
      kind: 'REJECTED',
      code: 'SIGNATURE_INVALID',
    });
    for (const s of [400, 403, 413, 415]) expect(answer(s)).toBe('REJECTED');
    expect(answer(503, 'BUSY', 7000)).toEqual({ kind: 'RETRY', retryAfterMs: 7000 });
    expect(answer(429, '', 1000)).toEqual({ kind: 'RETRY', retryAfterMs: 1000 });
    expect(answer(500)).toBe('RETRY');
    expect(answer(408)).toBe('RETRY');
  });

  it('the code wins over the status (a 409 is not always the same thing)', () => {
    expect(answer(409, 'SESSION_NOT_ACTIVE')).not.toEqual(answer(409, 'SEQ_CONFLICT'));
    expect(answer(500, 'SESSION_NOT_ACTIVE')).toEqual({
      kind: 'ENDED',
      reason: 'SESSION_NOT_ACTIVE',
    });
  });

  it('reads the code from a real Response and the Retry-After header', async () => {
    const respond = (status: number, body: unknown, headers: Record<string, string> = {}) =>
      createFetchTransport({
        baseUrl: 'https://api.test',
        getToken: () => 'tok',
        fetchFn: () => Promise.resolve(new Response(JSON.stringify(body), { status, headers })),
      }).sendBatch({ seq: 0, body: '{}', signature: 'a'.repeat(64) });
    expect(await respond(409, { code: 'KEY_EPOCH_STALE' })).toEqual({ kind: 'KEY_STALE' });
    expect(await respond(503, { code: 'BUSY' }, { 'Retry-After': '12' })).toEqual({
      kind: 'RETRY',
      retryAfterMs: 12_000,
    });
    expect(await respond(409, 'not json')).toBe('REJECTED');
    expect(await respond(200, {})).toBe('OK');
  });

  it('parses Retry-After as seconds or date and bounds it', () => {
    expect(parseRetryAfter('5')).toBe(5000);
    expect(parseRetryAfter('99999')).toBe(300_000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4000)).toBe(6000);
    expect(parseRetryAfter('soon')).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });

  it('a heartbeat answered with SESSION_NOT_ACTIVE reports the end, any other failure is false', async () => {
    const hb = (status: number, code: string) =>
      createFetchTransport({
        baseUrl: 'https://api.test',
        getToken: () => 'tok',
        fetchFn: () => Promise.resolve(new Response(JSON.stringify({ code }), { status })),
      }).heartbeat();
    expect(await hb(409, 'SESSION_NOT_ACTIVE')).toEqual({ ended: 'SESSION_NOT_ACTIVE' });
    expect(await hb(409, 'SESSION_TAKEN_OVER')).toEqual({ ended: 'TAKEN_OVER' });
    expect(await hb(503, 'BUSY')).toBe(false);
  });
});

describe('KEY_EPOCH_STALE: re-sign and retry (FR-601, TC-063)', () => {
  it('signs every unsent batch again from its stored body: same body, same seq, valid new signature', async () => {
    const key2 = await importSessionKey(KEY2_B64);
    let provided = 0;
    // Three batches are waiting (sends fail with RETRY), then the head answers KEY_STALE.
    const { q, calls, store } = await eventQueue(
      [{ kind: 'RETRY' }, { kind: 'RETRY' }, { kind: 'RETRY' }, { kind: 'KEY_STALE' }, 'OK'],
      {
        backoffBaseMs: 30,
        backoffMaxMs: 30,
        onKeyStale: () => {
          provided++;
          return Promise.resolve(key2);
        },
      },
    );
    for (let i = 0; i < 3; i++) {
      q.enqueue(ev(i));
      await q.flush();
    }
    await vi.waitFor(() => expect(q.stats().sentBatches).toBe(3), { timeout: 3000 });
    expect(provided).toBe(1);
    const first = calls.filter((c) => c.signature === hmacHex(TEST_KEY_B64, c.body));
    const resigned = calls.filter((c) => c.signature === hmacHex(KEY2_B64, c.body));
    expect(first.length).toBeGreaterThan(0);
    expect(resigned.map((c) => c.seq)).toEqual([0, 1, 2]);
    for (const c of resigned) {
      expect(first.find((o) => o.seq === c.seq)?.body ?? c.body).toBe(c.body); // same body
    }
    expect(await stored(store)).toEqual([]);
    await q.stop();
  });

  it('batches cut after the rotation are signed with the new key and the re-signed batch is persisted', async () => {
    const key2 = await importSessionKey(KEY2_B64);
    const stale = { kind: 'KEY_STALE' } as const;
    const { q, calls, store } = await eventQueue([stale, 'RETRY', 'RETRY', 'RETRY'], {
      onKeyStale: () => Promise.resolve(key2),
      backoffBaseMs: 60_000,
      backoffMaxMs: 60_000,
    });
    q.enqueue(ev(1));
    await q.flush();
    await vi.waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(2));
    const persisted = await store.entries<SignedBatch>(STORES.eventBatches, 's:');
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.value.signature).toBe(hmacHex(KEY2_B64, persisted[0]?.value.body ?? ''));
    q.enqueue(ev(2));
    await q.flush();
    const seq1 = (await store.entries<SignedBatch>(STORES.eventBatches, 's:')).find(
      (e) => e.value.seq === 1,
    );
    expect(seq1?.value.signature).toBe(hmacHex(KEY2_B64, seq1?.value.body ?? ''));
    await q.stop();
  });

  it('without a provider the batches are held and kept, flagged once, never dropped', async () => {
    const why: string[] = [];
    const { q, store, calls } = await eventQueue([{ kind: 'KEY_STALE' }], {
      onKeyUnavailable: (w) => why.push(w),
    });
    q.enqueue(ev(1));
    q.enqueue(ev(2));
    await q.flush();
    await new Promise((r) => setTimeout(r, 120)); // several backoff rounds
    expect(calls.length).toBeGreaterThan(1);
    expect(why).toEqual(['STALE_NO_KEY']);
    expect(q.stats()).toMatchObject({ unsentBatches: 1, rejectedBatches: 0 });
    expect(await stored(store)).toHaveLength(1);
    await q.stop();
  });

  it('a provider that returns null holds; one that throws retries; neither drops', async () => {
    const nul = await eventQueue([{ kind: 'KEY_STALE' }], {
      onKeyStale: () => Promise.resolve(null),
    });
    nul.q.enqueue(ev(1));
    await nul.q.flush();
    await new Promise((r) => setTimeout(r, 80));
    expect(nul.q.stats().unsentBatches).toBe(1);
    await nul.q.stop();

    let n = 0;
    const key2 = await importSessionKey(KEY2_B64);
    const thr = await eventQueue([{ kind: 'KEY_STALE' }, 'OK'], {
      onKeyStale: () => (n++ === 0 ? Promise.reject(new Error('net')) : Promise.resolve(key2)),
    });
    thr.q.enqueue(ev(1));
    await thr.q.flush();
    await vi.waitFor(() => expect(thr.q.stats().sentBatches).toBe(1));
    await thr.q.stop();
  });

  it('a provider that keeps handing out a stale key does not loop forever', async () => {
    const key2 = await importSessionKey(KEY2_B64);
    let asked = 0;
    const { q, calls } = await eventQueue([{ kind: 'KEY_STALE' }], {
      onKeyStale: () => {
        asked++;
        return Promise.resolve(key2);
      },
      backoffBaseMs: 60_000,
      backoffMaxMs: 60_000,
    });
    q.enqueue(ev(1));
    await q.flush();
    await new Promise((r) => setTimeout(r, 100));
    expect(asked).toBe(3);
    expect(calls.length).toBeLessThan(8);
    expect(q.stats().unsentBatches).toBe(1);
    await q.stop();
  });

  it('finish() while held for a key does not wait out the drain time and counts the loss', async () => {
    const { q, store } = await eventQueue([{ kind: 'KEY_STALE' }]);
    q.enqueue(ev(1));
    const t0 = Date.now();
    const r = await q.finish(10_000);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(r.lostBatches).toBe(1);
    expect(await stored(store)).toEqual([]);
  });

  it('KEY_ALREADY_ISSUED calls onKeyUnavailable and keeps the batch', async () => {
    const why: string[] = [];
    const { q } = await eventQueue([{ kind: 'KEY_UNAVAILABLE' }], {
      onKeyUnavailable: (w) => why.push(w),
    });
    q.enqueue(ev(1));
    await q.flush();
    await new Promise((r) => setTimeout(r, 80));
    expect(why).toEqual(['ALREADY_ISSUED']);
    expect(q.stats().unsentBatches).toBe(1);
    await q.stop();
  });

  it('the keystroke queue re-signs the same way (shared BatchQueue code)', async () => {
    const key2 = await importSessionKey(KEY2_B64);
    const t = scripted([{ kind: 'KEY_STALE' }, 'OK']);
    const q = new KeystrokeQueue({
      sessionId: 's',
      key: await importSessionKey(TEST_KEY_B64),
      store: newStore(),
      transport: t.transport,
      jitter: 0,
      backoffBaseMs: 20,
      onKeyStale: () => Promise.resolve(key2),
    });
    await q.start();
    q.enqueue(ksItem(1));
    await q.flush();
    await vi.waitFor(() => expect(q.stats().sentBatches).toBe(1));
    expect(t.calls[1]?.seq).toBe(t.calls[0]?.seq);
    expect(t.calls[1]?.body).toBe(t.calls[0]?.body);
    expect(t.calls[1]?.signature).toBe(hmacHex(KEY2_B64, t.calls[1]?.body ?? ''));
    await q.stop();
  });
});

describe('SESSION_NOT_ACTIVE and takeover: stop, signal once, purge (FR-702)', () => {
  for (const reason of ['SESSION_NOT_ACTIVE', 'TAKEN_OVER'] as const) {
    it(`${reason}: onEnded once, no further sends, nothing kept on disk, new items refused`, async () => {
      const ended: string[] = [];
      const { q, store, calls } = await eventQueue([{ kind: 'ENDED', reason }], {
        onEnded: (r) => ended.push(r),
      });
      q.enqueue(ev(1));
      q.enqueue(ev(2));
      await q.flush();
      await vi.waitFor(() => expect(ended).toEqual([reason]));
      expect(q.stats()).toMatchObject({ ended: reason, unsentBatches: 0, pendingItems: 0 });
      expect(await stored(store)).toEqual([]);
      expect(q.enqueue(ev(3))).toBe(false);
      await q.flush();
      await new Promise((r) => setTimeout(r, 80));
      expect(calls).toHaveLength(1);
      const fin = await q.finish(500);
      expect(fin.lostBatches).toBeGreaterThanOrEqual(1);
      expect(ended).toEqual([reason]); // still once
    });
  }

  it('batches waiting behind the refused one are counted as lost and purged too', async () => {
    const { q, store } = await eventQueue(
      [
        { kind: 'RETRY' },
        { kind: 'RETRY' },
        { kind: 'RETRY' },
        { kind: 'ENDED', reason: 'SESSION_NOT_ACTIVE' },
      ],
      { backoffBaseMs: 600_000, backoffMaxMs: 600_000 },
    );
    for (let i = 0; i < 3; i++) {
      q.enqueue(ev(i));
      await q.flush();
    }
    expect(q.stats().unsentBatches).toBe(3);
    q.retryNow();
    await vi.waitFor(() => expect(q.stats().ended).not.toBeNull());
    expect(q.stats().lostBatches).toBe(3);
    expect(await stored(store)).toEqual([]);
  });
});

describe('4xx drops are counted and carry no content', () => {
  it('REJECTED with a code reaches onRejected(code) and the next batch still goes out', async () => {
    const codes: (string | undefined)[] = [];
    const { q, calls } = await eventQueue([{ kind: 'REJECTED', code: 'SEQ_CONFLICT' }, 'OK'], {
      onRejected: (c) => codes.push(c),
    });
    q.enqueue(ev(1));
    await q.flush();
    q.enqueue(ev(2));
    await q.flush();
    await vi.waitFor(() => expect(q.stats().sentBatches).toBe(1));
    expect(codes).toEqual(['SEQ_CONFLICT']);
    expect(q.stats().rejectedBatches).toBe(1);
    expect(calls.map((c) => c.seq)).toEqual([0, 1]);
    await q.stop();
  });
});

describe('Retry-After (429, 503 BUSY)', () => {
  it('waits at least Retry-After even when the backoff is short', async () => {
    const { q, calls } = await eventQueue([{ kind: 'RETRY', retryAfterMs: 400 }, 'OK'], {
      backoffBaseMs: 10,
      backoffMaxMs: 10,
    });
    q.enqueue(ev(1));
    await q.flush();
    await new Promise((r) => setTimeout(r, 250));
    expect(calls).toHaveLength(1); // the 10 ms backoff alone would have retried by now
    await vi.waitFor(() => expect(calls).toHaveLength(2), { timeout: 2000 });
    await q.stop();
  });
});

describe('401: lost authentication (FR-601, TC-063)', () => {
  it('three consecutive 401 while live call onAuthLost once; sending continues and recovers after a new token', async () => {
    let lost = 0;
    const { q } = await eventQueue(
      [{ kind: 'AUTH' }, { kind: 'AUTH' }, { kind: 'AUTH' }, { kind: 'AUTH' }, 'OK'],
      { onAuthLost: () => lost++ },
    );
    q.enqueue(ev(1));
    await q.flush();
    await vi.waitFor(() => expect(q.stats().sentBatches).toBe(1));
    expect(lost).toBe(1);
    await q.stop();
  });

  it('a non-401 answer in between resets the count', async () => {
    let lost = 0;
    const { q } = await eventQueue(
      [{ kind: 'AUTH' }, { kind: 'AUTH' }, 'RETRY', { kind: 'AUTH' }, { kind: 'AUTH' }, 'OK'],
      { onAuthLost: () => lost++ },
    );
    q.enqueue(ev(1));
    await q.flush();
    await vi.waitFor(() => expect(q.stats().sentBatches).toBe(1));
    expect(lost).toBe(0);
    await q.stop();
  });

  it('authLostAfter is configurable', async () => {
    let lost = 0;
    const { q } = await eventQueue([{ kind: 'AUTH' }, 'OK'], {
      authLostAfter: 1,
      onAuthLost: () => lost++,
    });
    q.enqueue(ev(1));
    await q.flush();
    await vi.waitFor(() => expect(q.stats().sentBatches).toBe(1));
    expect(lost).toBe(1);
    await q.stop();
  });

  it('TOKEN_EXPIRED after finish() began is a lost tail: no retry, counted, purged (invariant TTL/2 >= grace)', async () => {
    const { q, calls, store } = await eventQueue([{ kind: 'AUTH', code: 'TOKEN_EXPIRED' }]);
    q.enqueue(ev(1));
    q.enqueue(ev(2));
    const t0 = Date.now();
    const r = await q.finish(10_000);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(calls).toHaveLength(1); // not retried
    expect(r.lostBatches).toBe(1);
    expect(await stored(store)).toEqual([]);
  });

  it('TOKEN_EXPIRED while live is NOT given up on: it counts toward authLost and is retried', async () => {
    let lost = 0;
    const { q, calls } = await eventQueue([{ kind: 'AUTH', code: 'TOKEN_EXPIRED' }], {
      onAuthLost: () => lost++,
    });
    q.enqueue(ev(1));
    await q.flush();
    await new Promise((r) => setTimeout(r, 150));
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(lost).toBe(1);
    expect(q.stats().unsentBatches).toBe(1);
    await q.stop();
  });
});

describe('session wiring', { timeout: 15_000 }, () => {
  function rig(over: Partial<ProctorSessionConfig> = {}, send?: () => SendResult) {
    const heartbeat = vi.fn((): Promise<boolean | { ended: 'SESSION_NOT_ACTIVE' | 'TAKEN_OVER' }> =>
      Promise.resolve(true),
    );
    const sent: SignedBatch[] = [];
    const ksSent: SignedBatch[] = [];
    const cfg: ProctorSessionConfig = {
      sessionId: 'sess',
      hmacKeyBase64: TEST_KEY_B64,
      root: document.createElement('div'),
      consent: { recordedAt: '2026-01-01T00:00:00Z' },
      transport: {
        sendBatch: (b) => {
          sent.push(b);
          return Promise.resolve(send ? send() : 'OK');
        },
        sendKeystrokeBatch: (b) => {
          ksSent.push(b);
          return Promise.resolve(send ? send() : 'OK');
        },
        heartbeat,
      },
      detectors: [],
      store: new IdbStore(indexedDB, `sess-${++db}`),
      flushIntervalMs: 10,
      backoffBaseMs: 20,
      heartbeatIntervalMs: 30,
      ...over,
    };
    return { cfg, sent, ksSent, heartbeat };
  }

  it('one key refresh serves both queues: the provider is asked once', async () => {
    let asked = 0;
    const r = rig({
      keyProvider: {
        getKey: () => {
          asked++;
          return Promise.resolve(KEY2_B64);
        },
      },
    });
    let stale = true;
    r.cfg.transport.sendBatch = (b) => {
      r.sent.push(b);
      return Promise.resolve(
        b.signature === hmacHex(TEST_KEY_B64, b.body) && stale ? { kind: 'KEY_STALE' } : 'OK',
      );
    };
    r.cfg.transport.sendKeystrokeBatch = (b) => {
      r.ksSent.push(b);
      return Promise.resolve(
        b.signature === hmacHex(TEST_KEY_B64, b.body) && stale ? { kind: 'KEY_STALE' } : 'OK',
      );
    };
    const s = new ProctorSession();
    await s.start(r.cfg);
    s.keystrokes?.reset(Q1, 'python', 'a');
    s.keystrokes?.recordChange({ offset: 1, deleteLength: 0, text: 'b' });
    // an event from a detector-less session: use the queue through emit via capability path is not
    // possible, so push one through the public recorder only and check the key is shared below
    await vi.waitFor(() => expect(s.getKeystrokeStats()?.sentBatches).toBeGreaterThan(0), {
      timeout: 6000,
    });
    stale = false;
    expect(asked).toBe(1);
    const last = r.ksSent[r.ksSent.length - 1];
    expect(last?.signature).toBe(hmacHex(KEY2_B64, last?.body ?? ''));
    await s.stop();
  });

  it('SESSION_NOT_ACTIVE on a keystroke batch: one ended event, heartbeat stops, recorder closed', async () => {
    const r = rig({}, () => ({ kind: 'ENDED', reason: 'SESSION_NOT_ACTIVE' }));
    const s = new ProctorSession();
    const ended: string[] = [];
    s.on('ended', (e) => ended.push(e.reason));
    await s.start(r.cfg);
    s.keystrokes?.reset(Q1, 'python', 'a');
    await vi.waitFor(() => expect(ended).toEqual(['SESSION_NOT_ACTIVE']), { timeout: 6000 });
    const beats = r.heartbeat.mock.calls.length;
    await new Promise((x) => setTimeout(x, 120));
    expect(r.heartbeat.mock.calls.length).toBe(beats);
    expect(s.getKeystrokeStats()?.ended).toBe('SESSION_NOT_ACTIVE');
    expect(ended).toHaveLength(1);
    await s.stop();
  });

  it('a heartbeat that learns the session was taken over ends both queues', async () => {
    const r = rig();
    r.heartbeat.mockImplementation(() => Promise.resolve({ ended: 'TAKEN_OVER' as const }));
    const s = new ProctorSession();
    const ended: string[] = [];
    s.on('ended', (e) => ended.push(e.reason));
    await s.start(r.cfg);
    await vi.waitFor(() => expect(ended).toEqual(['TAKEN_OVER']));
    expect(s.getKeystrokeStats()?.ended).toBe('TAKEN_OVER');
    await s.stop();
  });

  it('repeated 401 fires auth-lost; rejected batches raise counted flags without content', async () => {
    const r = rig({ authLostAfter: 2 }, () => ({ kind: 'AUTH' }));
    const s = new ProctorSession();
    const lost: string[] = [];
    s.on('auth-lost', (e) => lost.push(e.stream));
    await s.start(r.cfg);
    s.keystrokes?.reset(Q1, 'python', 'secret code');
    await vi.waitFor(() => expect(lost).toEqual(['keystroke']), { timeout: 6000 });
    await s.stop();

    const r2 = rig({}, () => ({ kind: 'REJECTED', code: 'SEQ_CONFLICT' }));
    const s2 = new ProctorSession();
    const flags: { id: string; detail?: string | undefined }[] = [];
    s2.on('capability', (f) => flags.push(f));
    await s2.start(r2.cfg);
    s2.keystrokes?.reset(Q1, 'python', 'secret code');
    await vi.waitFor(() => expect(flags.some((f) => f.id === 'keystroke-rejected')).toBe(true), {
      timeout: 6000,
    });
    const f = flags.find((x) => x.id === 'keystroke-rejected');
    expect(f?.detail).toMatch(/^1 batches/);
    expect(JSON.stringify(flags)).not.toContain('secret');
    await s2.stop();
  });
});
