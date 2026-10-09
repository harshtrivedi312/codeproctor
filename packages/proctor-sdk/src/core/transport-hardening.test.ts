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

const eventsOf = (b: SignedBatch): number[] =>
  (JSON.parse(b.body) as { events: { durationMs: number }[] }).events.map((e) => e.durationMs);
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

describe('errors by RFC 7807 code, then status (ADR 0013 5.8; FR-601, TC-063)', () => {
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
    // seq i carries event i: the body was not rebuilt, only signed again
    for (const c of resigned) expect(eventsOf(c)).toEqual([c.seq]);
    expect(eventsOf(first[0] as SignedBatch)).toEqual([first[0]?.seq]);
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

describe('4xx drops are counted and carry no content (FR-601, TC-063)', () => {
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

describe('Retry-After (429, 503 BUSY; FR-601, TC-063)', () => {
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

describe('401: lost authentication (FR-601, TC-063, ADR 0013 5.2)', () => {
  it('three consecutive 401 STOP the queue: onReauthRequired once, no more retries, batches stay persisted', async () => {
    const reasons: string[] = [];
    const { q, calls, store } = await eventQueue([{ kind: 'AUTH' }], {
      onReauthRequired: (r) => reasons.push(r),
    });
    q.enqueue(ev(1));
    await q.flush();
    await new Promise((r) => setTimeout(r, 250));
    expect(reasons).toEqual(['UNAUTHENTICATED']);
    const n = calls.length;
    expect(n).toBe(3);
    await new Promise((r) => setTimeout(r, 150));
    expect(calls).toHaveLength(n); // never retries forever
    expect(await stored(store)).toHaveLength(1);
    // online events and new flushes do not clear the hold
    q.retryNow();
    q.enqueue(ev(2));
    await q.flush();
    expect(calls).toHaveLength(n);
    await q.stop();
  });

  it('resume() after the token was refreshed sends again', async () => {
    let n = 0;
    const calls: SignedBatch[] = [];
    const { q } = await eventQueue([], {
      transport: {
        sendBatch: (b) => {
          calls.push(b);
          return Promise.resolve(++n <= 3 ? { kind: 'AUTH', code: 'TOKEN_EXPIRED' } : 'OK');
        },
      },
      onReauthRequired: () => undefined,
    });
    q.enqueue(ev(1));
    await q.flush();
    await new Promise((r) => setTimeout(r, 200));
    expect(q.stats().sentBatches).toBe(0);
    q.resume();
    await vi.waitFor(() => expect(q.stats().sentBatches).toBe(1));
    await q.stop();
  });

  it('TOKEN_EXPIRED reports its reason', async () => {
    const reasons: string[] = [];
    const { q } = await eventQueue([{ kind: 'AUTH', code: 'TOKEN_EXPIRED' }], {
      authLostAfter: 1,
      onReauthRequired: (r) => reasons.push(r),
    });
    q.enqueue(ev(1));
    await q.flush();
    await vi.waitFor(() => expect(reasons).toEqual(['TOKEN_EXPIRED']));
    await q.stop();
  });

  it('a non-401 answer in between resets the count', async () => {
    let lost = 0;
    const { q } = await eventQueue(
      [{ kind: 'AUTH' }, { kind: 'AUTH' }, 'RETRY', { kind: 'AUTH' }, { kind: 'AUTH' }, 'OK'],
      { onReauthRequired: () => lost++ },
    );
    q.enqueue(ev(1));
    await q.flush();
    await vi.waitFor(() => expect(q.stats().sentBatches).toBe(1));
    expect(lost).toBe(0);
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

  it('finish() while held after repeated 401 returns at once and counts the loss', async () => {
    const { q, store } = await eventQueue([{ kind: 'AUTH' }], { authLostAfter: 1 });
    q.enqueue(ev(1));
    await q.flush();
    const t0 = Date.now();
    const r = await q.finish(10_000);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(r.lostBatches).toBe(1);
    expect(await stored(store)).toEqual([]);
  });
});

describe('Retry-After binds every caller (FR-601, TC-063)', () => {
  it('retryNow(), a new flush and finish() nudges do not send before Retry-After', async () => {
    const { q, calls } = await eventQueue([{ kind: 'RETRY', retryAfterMs: 500 }, 'OK'], {
      backoffBaseMs: 10,
      backoffMaxMs: 10,
    });
    q.enqueue(ev(1));
    await q.flush();
    expect(calls).toHaveLength(1);
    q.retryNow();
    q.enqueue(ev(2));
    await q.flush();
    await new Promise((r) => setTimeout(r, 200));
    expect(calls).toHaveLength(1);
    await vi.waitFor(() => expect(q.stats().sentBatches).toBe(2), { timeout: 3000 });
    await q.stop();
  });
});

describe('re-sign uses the key each batch was signed with (ADR 0013 section 2; FR-601, TC-063)', () => {
  it('(a) batches stored under an old key and a queue that already has the new key: re-signed without asking the provider', async () => {
    const store = newStore();
    const key1 = await importSessionKey(TEST_KEY_B64);
    const key2 = await importSessionKey(KEY2_B64);
    // First page load: K1, offline, two batches persisted.
    const off = new EventQueue({
      sessionId: 's',
      key: key1,
      store,
      transport: scripted(['RETRY']).transport,
      jitter: 0,
      backoffBaseMs: 600_000,
      flushIntervalMs: 10_000,
    });
    await off.start();
    off.enqueue(ev(0));
    await off.flush();
    off.enqueue(ev(1));
    await off.flush();
    await off.stop();
    // Reload after an OTP resume: the queue is built with K2; the server calls K1 batches stale.
    let asked = 0;
    const sent: SignedBatch[] = [];
    const q = new EventQueue({
      sessionId: 's',
      key: key2,
      store,
      transport: {
        sendBatch: (b) => {
          sent.push(b);
          return Promise.resolve(
            b.signature === hmacHex(KEY2_B64, b.body) ? 'OK' : { kind: 'KEY_STALE' },
          );
        },
      },
      onKeyStale: () => {
        asked++;
        return Promise.resolve(null); // the real server answers KEY_ALREADY_ISSUED
      },
      onKeyUnavailable: () => undefined,
      jitter: 0,
      backoffBaseMs: 20,
    });
    await q.start();
    await vi.waitFor(() => expect(q.stats().sentBatches).toBe(2), { timeout: 3000 });
    expect(asked).toBe(0);
    expect(sent.filter((b) => b.signature === hmacHex(KEY2_B64, b.body)).map((b) => b.seq)).toEqual(
      [0, 1],
    );
    expect(q.stats().lostBatches).toBe(0);
    await q.stop();
  });

  it('only a batch signed with the CURRENT key that is itself stale asks the provider, passing that key', async () => {
    const key1 = await importSessionKey(TEST_KEY_B64);
    const key2 = await importSessionKey(KEY2_B64);
    const seen: CryptoKey[] = [];
    const { q } = await eventQueue([{ kind: 'KEY_STALE' }, 'OK'], {
      key: key1,
      onKeyStale: (k) => {
        seen.push(k);
        return Promise.resolve(key2);
      },
    });
    q.enqueue(ev(1));
    await q.flush();
    await vi.waitFor(() => expect(q.stats().sentBatches).toBe(1));
    expect(seen).toEqual([key1]);
    await q.stop();
  });

  it('(b) a key change while a batch is being signed: the batch joins the outbox signed with the NEW key', async () => {
    const key2 = await importSessionKey(KEY2_B64);
    const { q, calls } = await eventQueue(['OK']);
    // Hold the next sign() so the key can change while the cut is in its awaits.
    const realSign = crypto.subtle.sign.bind(crypto.subtle);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let held = false;
    vi.spyOn(crypto.subtle, 'sign').mockImplementation(async (...a) => {
      if (!held) {
        held = true;
        await gate;
      }
      return realSign(...a);
    });
    q.enqueue(ev(1));
    const flushing = q.flush();
    await new Promise((r) => setTimeout(r, 20));
    const swapped = q.setKey(key2); // while the cut is mid-signing with the old key
    release();
    await Promise.all([flushing, swapped]);
    await vi.waitFor(() => expect(q.stats().sentBatches).toBe(1));
    vi.restoreAllMocks();
    expect(calls[0]?.signature).toBe(hmacHex(KEY2_B64, calls[0]?.body ?? ''));
    await q.stop();
  });

  it('(c) a signing failure halfway through the re-sign leaves nothing dropped and every batch ends up valid', async () => {
    const key2 = await importSessionKey(KEY2_B64);
    const { q, calls } = await eventQueue(
      [{ kind: 'RETRY' }, { kind: 'RETRY' }, { kind: 'RETRY' }, 'OK'],
      { backoffBaseMs: 600_000, backoffMaxMs: 600_000 },
    );
    for (let i = 0; i < 3; i++) {
      q.enqueue(ev(i));
      await q.flush();
    }
    const real = crypto.subtle.sign.bind(crypto.subtle);
    let n = 0;
    vi.spyOn(crypto.subtle, 'sign').mockImplementation((...a) => {
      if (++n === 2) return Promise.reject(new Error('boom'));
      return real(...a);
    });
    await q.setKey(key2); // seq 0 re-signed, seq 1 fails
    vi.restoreAllMocks();
    expect(q.stats().sentBatches).toBe(0);
    // The server rejects whatever is still signed with the old key; the head check re-signs the rest.
    q.retryNow();
    await new Promise((r) => setTimeout(r, 50));
    expect(q.stats().rejectedBatches).toBe(0);
    expect(calls.length).toBeGreaterThan(3);
    await q.stop();
  });

  it('a hung key provider is given up and the batch is kept (timeout)', async () => {
    const { q } = await eventQueue([{ kind: 'KEY_STALE' }], {
      keyProviderTimeoutMs: 50,
      onKeyStale: () => new Promise<CryptoKey | null>(() => undefined),
    });
    q.enqueue(ev(1));
    await q.flush();
    await new Promise((r) => setTimeout(r, 200));
    expect(q.stats().unsentBatches).toBe(1);
    await q.stop();
  });
});

describe('end of session and stop() (FR-702, TC-063)', () => {
  it('SESSION_TAKEN_OVER arriving after stop() does not delete the outbox kept for the next load', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const { q, store } = await eventQueue([], {
      transport: {
        sendBatch: async (): Promise<SendResult> => {
          calls++;
          if (calls === 1) return 'RETRY';
          await gate; // the retry-timer send is still in flight when stop() runs
          return { kind: 'ENDED', reason: 'TAKEN_OVER' };
        },
      },
    });
    q.enqueue(ev(1));
    await q.flush();
    await vi.waitFor(() => expect(calls).toBe(2));
    await q.stop();
    release();
    await new Promise((r) => setTimeout(r, 50));
    expect(await stored(store)).toHaveLength(1);
    expect(q.stats().ended).toBeNull();
  });
});

describe('session wiring (FR-601, FR-609, FR-702, TC-063)', { timeout: 15_000 }, () => {
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

  /** A detector that exposes ctx.emit so a test can produce an event batch. */
  function emitter() {
    let emit: (() => void) | null = null;
    const detector = {
      id: 'test-emitter',
      start: (ctx: Parameters<import('./types').Detector['start']>[0]) => {
        emit = () => ctx.emit('TAB_SWITCH', {}, { durationMs: 1 });
      },
      stop: () => undefined,
    };
    return { detector, fire: () => emit?.() };
  }

  it('one key refresh serves both queues: the event and the keystroke queue hit KEY_STALE, the provider is asked once', async () => {
    let asked = 0;
    const em = emitter();
    const r = rig({
      detectors: [em.detector],
      keyProvider: {
        getKey: async () => {
          asked++;
          await new Promise((x) => setTimeout(x, 30));
          return KEY2_B64;
        },
      },
    });
    const staleIfOld = (b: SignedBatch): SendResult =>
      b.signature === hmacHex(TEST_KEY_B64, b.body) ? { kind: 'KEY_STALE' } : 'OK';
    r.cfg.transport.sendBatch = (b) => {
      r.sent.push(b);
      return Promise.resolve(staleIfOld(b));
    };
    r.cfg.transport.sendKeystrokeBatch = (b) => {
      r.ksSent.push(b);
      return Promise.resolve(staleIfOld(b));
    };
    const s = new ProctorSession();
    await s.start(r.cfg);
    em.fire();
    s.keystrokes?.reset(Q1, 'python', 'a');
    await vi.waitFor(
      () => {
        expect(s.getKeystrokeStats()?.sentBatches).toBe(1);
        expect(s.getQueueStats()?.sentBatches).toBe(1);
      },
      { timeout: 6000 },
    );
    expect(asked).toBe(1);
    await s.stop();
  });

  it('setKey() hands a new key to both queues; onKeyStale is raised when no provider exists (ADR 0013 section 2)', async () => {
    const em = emitter();
    let staleCalls = 0;
    const r = rig({ detectors: [em.detector], onKeyStale: () => staleCalls++ });
    r.cfg.transport.sendBatch = (b) => {
      r.sent.push(b);
      return Promise.resolve(
        b.signature === hmacHex(KEY2_B64, b.body) ? 'OK' : { kind: 'KEY_STALE' },
      );
    };
    const s = new ProctorSession();
    await s.start(r.cfg);
    em.fire();
    await vi.waitFor(() => expect(staleCalls).toBe(1), { timeout: 6000 });
    expect(s.getQueueStats()?.unsentBatches).toBe(1);
    await s.setKey(KEY2_B64);
    await vi.waitFor(() => expect(s.getQueueStats()?.sentBatches).toBe(1), { timeout: 6000 });
    await s.stop();
  });

  it('a throwing getKey() does not stick: the next KEY_STALE asks again', async () => {
    const em = emitter();
    let asked = 0;
    const r = rig({
      detectors: [em.detector],
      keyProvider: {
        getKey: () => {
          asked++;
          if (asked === 1) throw new Error('sync boom');
          return Promise.resolve(KEY2_B64);
        },
      },
    });
    r.cfg.transport.sendBatch = (b) => {
      r.sent.push(b);
      return Promise.resolve(
        b.signature === hmacHex(KEY2_B64, b.body) ? 'OK' : { kind: 'KEY_STALE' },
      );
    };
    const s = new ProctorSession();
    await s.start(r.cfg);
    em.fire();
    await vi.waitFor(() => expect(s.getQueueStats()?.sentBatches).toBe(1), { timeout: 8000 });
    expect(asked).toBe(2);
    await s.stop();
  });

  it('SESSION_NOT_ACTIVE on a keystroke batch: one ended event, heartbeat stops, recorder closed', async () => {
    const r = rig({}, () => ({ kind: 'ENDED', reason: 'SESSION_NOT_ACTIVE' }));
    const s = new ProctorSession();
    const ended: string[] = [];
    s.on('ended', (e) => ended.push(e.reason));
    await s.start(r.cfg);
    s.keystrokes?.reset(Q1, 'python', 'a');
    const flags: string[] = [];
    s.on('capability', (f) => flags.push(f.id));
    await vi.waitFor(() => expect(ended).toEqual(['SESSION_NOT_ACTIVE']), { timeout: 6000 });
    expect(flags).toContain('batches-lost');
    const beats = r.heartbeat.mock.calls.length;
    await new Promise((x) => setTimeout(x, 120));
    expect(r.heartbeat.mock.calls.length).toBe(beats);
    expect(s.getKeystrokeStats()?.ended).toBe('SESSION_NOT_ACTIVE');
    expect(ended).toHaveLength(1);
    await s.stop();
  });

  it('a heartbeat that learns the session was taken over ends both queues and asks for re-authentication', async () => {
    const r = rig();
    r.heartbeat.mockImplementation(() => Promise.resolve({ ended: 'TAKEN_OVER' as const }));
    const reauth: string[] = [];
    r.cfg.onReauthRequired = (x) => reauth.push(x);
    const s = new ProctorSession();
    const ended: string[] = [];
    s.on('ended', (e) => ended.push(e.reason));
    await s.start(r.cfg);
    await vi.waitFor(() => expect(ended).toEqual(['TAKEN_OVER']));
    expect(s.getKeystrokeStats()?.ended).toBe('TAKEN_OVER');
    expect(reauth).toEqual(['SESSION_TAKEN_OVER']);
    await s.stop();
  });

  it('a heartbeat SESSION_NOT_ACTIVE stops the heartbeat and fires ended but the queued batches STILL go out (post-submit grace)', async () => {
    const em = emitter();
    // Batches fail (offline) until the heartbeat has reported the end; then the grace accepts them.
    let accept = false;
    const r = rig({ detectors: [em.detector] }, () => (accept ? 'OK' : 'RETRY'));
    const s = new ProctorSession();
    const ended: { reason: string; lostBatches: number }[] = [];
    s.on('ended', (e) => ended.push(e));
    await s.start(r.cfg);
    em.fire();
    s.keystrokes?.reset(Q1, 'python', 'a');
    await vi.waitFor(() => expect(r.sent.length).toBeGreaterThan(0), { timeout: 6000 });
    r.heartbeat.mockImplementation(() => Promise.resolve({ ended: 'SESSION_NOT_ACTIVE' as const }));
    await vi.waitFor(() => expect(ended).toHaveLength(1), { timeout: 3000 });
    expect(ended[0]).toEqual({ reason: 'SESSION_NOT_ACTIVE', lostBatches: 0 });
    expect(s.getQueueStats()?.unsentBatches).toBe(1); // not purged
    expect(s.getQueueStats()?.ended).toBeNull();
    accept = true;
    await vi.waitFor(() => expect(s.getQueueStats()?.sentBatches).toBe(1), { timeout: 6000 });
    await s.stop();
  });

  it('a late takeover after stop() leaves the kept outbox alone and fires nothing', async () => {
    const r = rig();
    const s = new ProctorSession();
    const ended: string[] = [];
    s.on('ended', (e) => ended.push(e.reason));
    await s.start(r.cfg);
    await s.stop();
    r.heartbeat.mockImplementation(() => Promise.resolve({ ended: 'TAKEN_OVER' as const }));
    await new Promise((x) => setTimeout(x, 100));
    expect(ended).toEqual([]);
  });

  it('repeated 401 raises onReauthRequired; rejected batches raise counted flags without content', async () => {
    const lost: string[] = [];
    const r = rig({ authLostAfter: 2, onReauthRequired: (x) => lost.push(x) }, () => ({
      kind: 'AUTH',
    }));
    const s = new ProctorSession();
    await s.start(r.cfg);
    s.keystrokes?.reset(Q1, 'python', 'secret code');
    await vi.waitFor(() => expect(lost).toEqual(['UNAUTHENTICATED']), { timeout: 6000 });
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
