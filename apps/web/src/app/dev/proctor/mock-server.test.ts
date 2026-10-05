import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  eventBatch,
  evidencePresign,
  heartbeat,
  hmacHex,
  identityRecheck,
  mediaConfirm,
  mediaPresign,
  mediaPut,
  sessionIdFromAuth,
  sessionState,
  store,
  summarize,
} from './api/_lib/mock-server';

const ev = { type: 'TAB_SWITCH', occurredAt: '2026-01-01T00:00:00.000Z', payload: {} };
const body = (seq: number, events: unknown[] = [ev]) => JSON.stringify({ events, seq });
const send = (st: ReturnType<typeof sessionState>, seq: number, b = body(seq), sig = hmacHex(b)) =>
  eventBatch(st, b, sig);

let n = 0;
const fresh = () => sessionState(`t-${++n}`);

afterEach(() => vi.unstubAllEnvs());

describe('mock event endpoint (TC-063, TC-065, FR-801)', () => {
  it('TC-065: rejects a batch whose body was modified after signing', () => {
    const st = fresh();
    const r = eventBatch(st, body(0, [{ ...ev, payload: { x: 1 } }]), hmacHex(body(0)));
    expect(r.status).toBe(400);
    expect(summarize(st).batches.rejected).toBe(1);
    expect(st.accepted.size).toBe(0);
  });

  it('TC-065: same seq with a different signature is a conflict (409)', () => {
    const st = fresh();
    send(st, 0);
    const other = body(0, [{ ...ev, occurredAt: '2026-01-01T00:00:01.000Z' }]);
    expect(send(st, 0, other).status).toBe(409);
    expect(summarize(st).batches.conflict).toBe(1);
  });

  it('TC-063: same seq with the same signature is an idempotent duplicate (200)', () => {
    const st = fresh();
    send(st, 0);
    expect(send(st, 0).body).toEqual({ ok: true, duplicate: true });
    expect(summarize(st).batches).toMatchObject({ accepted: 1, duplicate: 1 });
  });

  it('TC-063: shows a gap while batches are missing and none after they arrive late', () => {
    const st = fresh();
    send(st, 0);
    send(st, 3);
    expect(summarize(st).seq).toEqual({ highest: 3, missing: [1, 2] });
    send(st, 2);
    send(st, 1);
    expect(summarize(st).seq).toEqual({ highest: 3, missing: [] });
    expect(summarize(st).batches.accepted).toBe(4);
  });

  it('FR-801: rejects server-only event types (schema from packages/shared)', () => {
    const st = fresh();
    const b = body(0, [{ ...ev, type: 'PASTE_BURST', payload: {} }]);
    expect(send(st, 0, b).status).toBe(400);
    expect(summarize(st).batches.rejected).toBe(1);
  });

  it('FR-801: counts events by type', () => {
    const st = fresh();
    send(st, 0, body(0, [ev, ev]));
    expect(summarize(st).eventTypes).toEqual({ TAB_SWITCH: 2 });
  });
});

describe('mock media endpoints (FR-701, FR-702, TC-063)', () => {
  const chunk = { stream: 'WEBCAM', segment: 0, seq: 4, bytes: 10, contentType: 'x' };
  it('FR-701: presign, PUT, confirm in order marks the chunk confirmed with its bytes', () => {
    const st = fresh();
    const p = mediaPresign(st, 's', chunk);
    expect((p.body as { url: string }).url).toContain('s/WEBCAM/0/4');
    expect(mediaPut(st, 's/WEBCAM/0/4', 1234).status).toBe(200);
    expect(mediaConfirm(st, 's', chunk).status).toBe(200);
    expect(summarize(st).chunks).toMatchObject({
      presigned: 1,
      uploaded: 1,
      confirmed: 1,
      bytes: { WEBCAM: 1234 },
    });
  });
  it('FR-702: confirm before the PUT is retryable (503), a PUT without presign is refused', () => {
    const st = fresh();
    mediaPresign(st, 's', chunk);
    expect(mediaConfirm(st, 's', chunk).status).toBe(503);
    expect(mediaPut(st, 's/AUDIO/0/0', 1).status).toBe(403);
  });
  it('FR-702: a retry upserts the same chunk instead of counting it twice', () => {
    const st = fresh();
    mediaPresign(st, 's', chunk);
    mediaPresign(st, 's', chunk);
    expect(summarize(st).chunks.presigned).toBe(1);
  });
  it('FR-701: refuses a malformed chunk description', () => {
    expect(
      mediaPresign(fresh(), 's', { stream: 'EVIL', segment: 0, seq: 0, bytes: 1 }).status,
    ).toBe(400);
  });
});

describe('other mock endpoints', () => {
  it('FR-609: heartbeats are counted', () => {
    const st = fresh();
    heartbeat(st);
    heartbeat(st);
    expect(summarize(st).heartbeats.count).toBe(2);
  });
  it('FR-801: evidence presign returns a key that fits the shared key rules', () => {
    const r = evidencePresign(fresh(), 'abc-123').body as { key: string };
    expect(r.key).toMatch(/^[A-Za-z0-9][A-Za-z0-9/_.-]*$/);
  });
  it('FR-606: identity re-check is canned, every third check is a mismatch', () => {
    const st = fresh();
    const out = [1, 2, 3].map(() => (identityRecheck(st).body as { matched: boolean }).matched);
    expect(out).toEqual([true, true, false]);
  });
  it('dev token: only demo tokens identify a session', () => {
    expect(sessionIdFromAuth('Bearer demo-abc-123')).toBe('abc-123');
    expect(sessionIdFromAuth('Bearer eyJhbGciOi')).toBeNull();
    expect(sessionIdFromAuth(null)).toBeNull();
  });
  it('state is per session', () => {
    sessionState('one');
    expect(store().has('one')).toBe(true);
    expect(sessionState('two').heartbeats.count).toBe(0);
  });
});

describe('production lockout (dev-only routes)', () => {
  it('returns 404 from every handler in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const routes = await Promise.all([
      import('./api/heartbeat/route'),
      import('./api/events/route'),
      import('./api/media/presign/route'),
      import('./api/media/confirm/route'),
      import('./api/evidence/presign/route'),
      import('./api/identity/recheck/route'),
    ]);
    const req = () =>
      new Request('http://x/y', {
        method: 'POST',
        headers: { authorization: 'Bearer demo-abc' },
        body: '{}',
      });
    for (const r of routes) expect((await r.POST(req())).status).toBe(404);
    const put = await import('./api/media/put/[...key]/route');
    expect(
      (
        await put.PUT(new Request('http://x', { method: 'PUT', body: 'x' }), {
          params: Promise.resolve({ key: ['a', 'b'] }),
        })
      ).status,
    ).toBe(404);
    const state = await import('./api/state/route');
    expect(state.GET(new Request('http://x/s?session=abc')).status).toBe(404);
    expect(state.DELETE(new Request('http://x/s?session=abc')).status).toBe(404);
  });
});
