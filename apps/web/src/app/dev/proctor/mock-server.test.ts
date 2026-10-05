import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_CHUNKS_PER_SESSION,
  MAX_EVIDENCE_ISSUED,
  MAX_MISSING_SHOWN,
  existingSession,
  MAX_SESSIONS,
  batch,
  evidencePresign,
  evidencePut,
  heartbeat,
  hmacHex,
  identityRecheck,
  mediaConfirm,
  mediaPresign,
  mediaPut,
  chunkObjectPath,
  sessionIdFromAuth,
  sessionState,
  store,
  summarize,
  ulid,
  type SessionState,
} from './api/_lib/mock-server';

/**
 * Mock handlers follow ADR 0013 (Proposed, PR #39); provisional.
 */
const enc = new TextEncoder();
const ev = { type: 'TAB_SWITCH', occurredAt: '2026-01-01T00:00:00.000Z', payload: {} };
const body = (seq: number, events: unknown[] = [ev]) => JSON.stringify({ events, seq });
const send = (
  st: SessionState,
  seq: number,
  b = body(seq),
  sig = hmacHex(enc.encode(b)),
  route: 'events' | 'keystrokes' = 'events',
  ct: string | null = 'application/json',
) => batch(route, st, enc.encode(b), sig, ct);
const code = (r: { body: unknown }) => (r.body as { code?: string }).code;

let n = 0;
const fresh = () => sessionState(`t-${++n}`);
afterEach(() => vi.unstubAllEnvs());

describe('mock batch endpoints (TC-063, TC-065, FR-801)', () => {
  it('TC-065: a body modified after signing is 403 SIGNATURE_INVALID', () => {
    const st = fresh();
    const r = batch(
      'events',
      st,
      enc.encode(body(0, [{ ...ev, payload: { x: 1 } }])),
      hmacHex(enc.encode(body(0))),
      'application/json',
    );
    expect([r.status, code(r)]).toEqual([403, 'SIGNATURE_INVALID']);
    expect(st.accepted.size).toBe(0);
    expect(summarize(st).batches.rejected).toBe(1);
  });

  it('TC-065: signatures must be lowercase 64-char hex', () => {
    const st = fresh();
    const b = body(0);
    expect(send(st, 0, b, hmacHex(enc.encode(b)).toUpperCase()).status).toBe(403);
    expect(send(st, 0, b, 'abc').status).toBe(403);
  });

  it('TC-065: same seq with a different body is 409 SEQ_CONFLICT', () => {
    const st = fresh();
    send(st, 0);
    const other = body(0, [{ ...ev, occurredAt: '2026-01-01T00:00:01.000Z' }]);
    const r = send(st, 0, other);
    expect([r.status, code(r)]).toEqual([409, 'SEQ_CONFLICT']);
    expect(summarize(st).batches.conflict).toBe(1);
  });

  it('TC-065: an identical replay is 200 duplicate:true and stores nothing twice', () => {
    const st = fresh();
    send(st, 0, body(0, [ev, ev]));
    const r = send(st, 0, body(0, [ev, ev]));
    expect(r.body).toEqual({ seq: 0, duplicate: true });
    expect(summarize(st).eventTypes).toEqual({ TAB_SWITCH: 2 });
  });

  it('TC-063: shows a gap while batches are missing and none once they arrive late', () => {
    const st = fresh();
    send(st, 0);
    send(st, 3);
    expect(summarize(st).seq).toEqual({ highest: 3, missing: [1, 2], missingCount: 2 });
    send(st, 2);
    send(st, 1);
    expect(summarize(st).seq).toEqual({ highest: 3, missing: [], missingCount: 0 });
    expect(summarize(st).batches.accepted).toBe(4);
  });

  it('FR-801: verifies the received bytes, not a canonical re-serialisation', () => {
    const st = fresh();
    const spaced = `{ "seq": 0,\n "events": [ ${JSON.stringify(ev)} ] }`;
    expect(send(st, 0, spaced).status).toBe(200);
  });

  it('FR-801: server-only event types and invalid UTF-8 are 400 VALIDATION_FAILED', () => {
    const st = fresh();
    const r = send(st, 0, body(0, [{ ...ev, type: 'PASTE_BURST', payload: {} }]));
    expect([r.status, code(r)]).toEqual([400, 'VALIDATION_FAILED']);
    const bad = new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]);
    expect(code(batch('events', st, bad, hmacHex(bad), 'application/json'))).toBe(
      'VALIDATION_FAILED',
    );
  });

  it('FR-801: 415 for a wrong content type, 413 above 256 KiB, never echoing values', () => {
    const st = fresh();
    expect(send(st, 0, body(0), undefined, 'events', 'text/plain').status).toBe(415);
    const huge = body(0, [{ ...ev, payload: { pad: 'x'.repeat(300 * 1024) } }]);
    const r = send(st, 0, huge);
    expect([r.status, code(r)]).toEqual([413, 'PAYLOAD_TOO_LARGE']);
    expect(JSON.stringify(r.body)).not.toContain('xxxx');
  });

  it('FR-801: errors are RFC 7807 problems with a code', () => {
    const r = send(fresh(), 0, body(0), 'bad');
    expect(r.headers?.['Content-Type']).toBe('application/problem+json');
    expect(r.body).toMatchObject({ type: 'about:blank', status: 403, code: 'SIGNATURE_INVALID' });
  });

  it('FR-608/FR-801: keystroke batches use the same signing and their own schema and seq space', () => {
    const st = fresh();
    const ks = JSON.stringify({
      events: [{ kind: 'RESET', language: 'python', t: 0, text: 'x = 1' }],
      seq: 0,
      sessionQuestionId: '8f14e45f-ceea-467a-9575-1b2a7c3d4e5f',
      startedAt: '2026-01-01T00:00:00.000Z',
    });
    const r = send(st, 0, ks, undefined, 'keystrokes');
    expect(r.status).toBe(200);
    expect(send(st, 0, ks, undefined, 'events').status).toBe(400); // wrong schema for events
    expect(send(st, 0).status).toBe(200); // events seq 0 is separate from keystrokes seq 0
  });

  it('FR-801: counts evidence names that were never issued (the batch still succeeds)', () => {
    const st = fresh();
    const r = send(
      st,
      0,
      body(0, [{ ...ev, evidenceKey: 'evidence/01ARZ3NDEKTSV4RRFFQ69G5FAV.jpg' }]),
    );
    expect(r.status).toBe(200);
    expect(st.evidence.namesDropped).toBe(1);
  });
});

describe('mock media endpoints (FR-701, FR-702, TC-063)', () => {
  const chunk = (o: Record<string, unknown> = {}) => ({
    stream: 'WEBCAM',
    segment: 0,
    seq: 4,
    bytes: 10,
    contentType: 'video/webm',
    startedAt: '2026-01-01T00:00:00.000Z',
    durationMs: 10_000,
    ...o,
  });
  const put = (
    st: SessionState,
    sid: string,
    bytes: number,
    ct = 'video/webm',
    seg = 0,
    seq = 4,
    stream = 'WEBCAM',
  ) => mediaPut(st, sid, chunkObjectPath(sid, stream, seg, seq), bytes, ct);
  const confirm = (st: SessionState, seg = 0, seq = 4) =>
    mediaConfirm(st, { stream: 'WEBCAM', segment: seg, seq });

  it('FR-701: presign, PUT, confirm marks the chunk confirmed with its size', () => {
    const st = fresh();
    const p = mediaPresign(st, 's1', chunk());
    expect(p.body).toMatchObject({ method: 'PUT', headers: { 'Content-Type': 'video/webm' } });
    expect((p.body as { url: string }).url).toContain(
      'orgs/demo/sessions/s1/media/WEBCAM/000000/00000004.webm',
    );
    expect(put(st, 's1', 10).status).toBe(200);
    expect(confirm(st).body).toEqual({ uploaded: true, sizeBytes: 10 });
    expect(confirm(st).status).toBe(200); // idempotent
    expect(summarize(st).chunks).toMatchObject({
      presigned: 1,
      uploaded: 1,
      confirmed: 1,
      bytes: { WEBCAM: 10 },
    });
  });

  it('FR-702: presign after confirm says alreadyUploaded', () => {
    const st = fresh();
    mediaPresign(st, 's1', chunk());
    put(st, 's1', 10);
    confirm(st);
    expect(mediaPresign(st, 's1', chunk()).body).toEqual({ alreadyUploaded: true });
  });

  it('FR-702: confirm before the PUT is 409 UPLOAD_NOT_FOUND; unknown chunk is 404 CHUNK_NOT_PRESIGNED', () => {
    const st = fresh();
    mediaPresign(st, 's1', chunk());
    expect(code(confirm(st))).toBe('UPLOAD_NOT_FOUND');
    expect(code(confirm(st, 0, 99))).toBe('CHUNK_NOT_PRESIGNED');
  });

  it('FR-702: a size or type mismatch is 422 UPLOAD_MISMATCH, the object is discarded, a retry succeeds', () => {
    const st = fresh();
    mediaPresign(st, 's1', chunk());
    put(st, 's1', 11);
    expect(confirm(st).status).toBe(422);
    expect(code(confirm(st))).toBe('UPLOAD_NOT_FOUND');
    put(st, 's1', 10, 'video/webm;codecs=vp8');
    expect(code(confirm(st))).toBe('UPLOAD_MISMATCH');
    put(st, 's1', 10);
    expect(confirm(st).status).toBe(200);
  });

  it('FR-701: a PUT that was never presigned is refused', () => {
    expect(put(fresh(), 's1', 1).status).toBe(403);
  });

  it('FR-701: validates stream, content type (no codecs), bytes, durationMs and startedAt', () => {
    const st = fresh();
    const bad = [
      chunk({ stream: 'EVIL' }),
      chunk({ contentType: 'video/webm;codecs=vp8' }),
      chunk({ contentType: 'image/png' }),
      chunk({ bytes: 0 }),
      chunk({ bytes: -1 }),
      chunk({ durationMs: 0 }),
      chunk({ durationMs: 60_001 }),
      chunk({ seq: 1.5 }),
      chunk({ segment: -1 }),
      chunk({ startedAt: 'yesterday' }),
      chunk({ stream: 'AUDIO', contentType: 'audio/webm', bytes: 5 * 1024 * 1024 }),
      chunk({ bytes: 17 * 1024 * 1024 }),
    ];
    for (const b of bad) expect(mediaPresign(st, 's1', b).status).toBe(400);
    expect(st.chunks.size).toBe(0);
  });

  it('FR-701: the same seq under another segment is 409 SEQ_CONFLICT (seq is unique per stream)', () => {
    const st = fresh();
    mediaPresign(st, 's1', chunk({ segment: 0, seq: 0 }));
    const r = mediaPresign(st, 's1', chunk({ segment: 1, seq: 0 }));
    expect([r.status, code(r)]).toEqual([409, 'SEQ_CONFLICT']);
    expect(mediaPresign(st, 's1', chunk({ segment: 1, seq: 1 })).status).toBe(200);
  });

  it('FR-702: a retried presign upserts the same chunk', () => {
    const st = fresh();
    mediaPresign(st, 's1', chunk());
    mediaPresign(st, 's1', chunk());
    expect(summarize(st).chunks.presigned).toBe(1);
  });

  it('FR-702: chunks per session are capped so the mock cannot grow without bound', () => {
    const st = fresh();
    for (let i = 0; i < MAX_CHUNKS_PER_SESSION; i++) {
      st.chunks.set(`WEBCAM/0/${i}`, {
        stream: 'WEBCAM',
        segment: 0,
        seq: i,
        declaredBytes: 1,
        contentType: 'video/webm',
        putBytes: null,
        putType: null,
        confirmed: false,
      });
    }
    expect(code(mediaPresign(st, 's1', chunk({ seq: 99_999 })))).toBe('RATE_LIMITED');
  });
});

describe('mock evidence, identity and heartbeat (FR-606, FR-609, FR-801)', () => {
  const ev1 = { purpose: 'EVENT', contentType: 'image/jpeg', bytes: 1000 };
  const idc = { purpose: 'IDENTITY_RECHECK', contentType: 'image/jpeg', bytes: 1000 };

  it('FR-801: evidence presign returns evidence/<ULID>.jpg that fits the shared key rules', () => {
    const st = fresh();
    const r = evidencePresign(st, 's1', ev1).body as { evidenceKey: string; method: string };
    expect(r.evidenceKey).toMatch(/^evidence\/[0-9A-HJKMNP-TV-Z]{26}\.jpg$/);
    expect(r.evidenceKey).toMatch(/^[A-Za-z0-9][A-Za-z0-9/_.-]*$/);
    expect(r.method).toBe('PUT');
    expect(evidencePut(st).status).toBe(200);
    // an issued name in an event is accepted, not counted as dropped
    send(st, 0, body(0, [{ ...ev, evidenceKey: r.evidenceKey }]));
    expect(st.evidence.namesDropped).toBe(0);
  });

  it('FR-801: validates purpose, content type and size (1 byte to 1 MiB)', () => {
    const st = fresh();
    for (const b of [
      { ...ev1, purpose: 'X' },
      { ...ev1, contentType: 'image/png' },
      { ...ev1, bytes: 0 },
      { ...ev1, bytes: 1024 * 1024 + 1 },
    ]) {
      expect(evidencePresign(st, 's1', b).status).toBe(400);
    }
  });

  it('FR-606: identity re-check is 202 with no result; wrong-purpose or unknown names are 400', () => {
    const st = fresh();
    const evName = (evidencePresign(st, 's1', ev1).body as { evidenceKey: string }).evidenceKey;
    const idName = (evidencePresign(st, 's1', idc).body as { evidenceKey: string }).evidenceKey;
    expect(identityRecheck(st, { evidenceKey: evName, capturedAt: 'x' }).status).toBe(400);
    expect(identityRecheck(st, { evidenceKey: 'evidence/NOPE.jpg', capturedAt: 'x' }).status).toBe(
      400,
    );
    const r = identityRecheck(st, { evidenceKey: idName, capturedAt: '2026-01-01T00:00:00Z' });
    expect([r.status, r.body]).toEqual([202, { accepted: true }]);
    expect(JSON.stringify(r.body)).not.toMatch(/match|similar|score/i);
  });

  it('FR-606: re-checks are limited to 1 per 60 s, and the server writes FACE_MISMATCH on every third', () => {
    const st = fresh();
    const name = () => (evidencePresign(st, 's1', idc).body as { evidenceKey: string }).evidenceKey;
    let t = 1_000_000;
    const check = () => identityRecheck(st, { evidenceKey: name(), capturedAt: 'x' }, t);
    expect(check().status).toBe(202);
    t += 30_000;
    const limited = check();
    expect([limited.status, code(limited), limited.headers?.['Retry-After']]).toEqual([
      429,
      'RATE_LIMITED',
      '60',
    ]);
    for (let i = 0; i < 2; i++) {
      t += 61_000;
      expect(check().status).toBe(202);
    }
    expect(summarize(st).identity).toEqual({ accepted: 3, serverFaceMismatch: 1 });
  });

  it('FR-609: heartbeats are counted and recorder/queue health bodies are kept', () => {
    const st = fresh();
    expect(heartbeat(st, null).body).toMatchObject({ status: 'IN_PROGRESS', pauseReasons: [] });
    heartbeat(st, { recorder: { streams: [] }, queue: { pendingEventBatches: 2 } });
    const s = summarize(st).heartbeats;
    expect([s.count, s.withHealth]).toEqual([2, 1]);
    expect(s.lastQueue).toEqual({ pendingEventBatches: 2 });
  });

  it('ulid: 26 Crockford characters, time-ordered', () => {
    const a = ulid(1_000_000);
    const b = ulid(2_000_000);
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a.slice(0, 10) < b.slice(0, 10)).toBe(true);
  });
});

describe('dev token and bounded state', () => {
  it('FR-801: only demo tokens identify a session', () => {
    expect(sessionIdFromAuth('Bearer demo-abc-123')).toBe('abc-123');
    expect(sessionIdFromAuth('Bearer eyJhbGciOi')).toBeNull();
    expect(sessionIdFromAuth(null)).toBeNull();
  });
  it('FR-801: state is per session and the number of sessions is capped (oldest evicted)', () => {
    store().clear();
    for (let i = 0; i < MAX_SESSIONS + 5; i++) sessionState(`cap-${i}`);
    expect(store().size).toBe(MAX_SESSIONS);
    expect(store().has('cap-0')).toBe(false);
    expect(store().has(`cap-${MAX_SESSIONS + 4}`)).toBe(true);
  });
});

describe('production lockout and auth (dev-only routes)', () => {
  const post = (auth = 'Bearer demo-abc') =>
    new Request('http://x/y', {
      method: 'POST',
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: '{}',
    });

  it('NFR-04: returns 404 from every handler in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const routes = await Promise.all([
      import('./api/heartbeat/route'),
      import('./api/events/route'),
      import('./api/keystrokes/route'),
      import('./api/media/presign/route'),
      import('./api/media/confirm/route'),
      import('./api/evidence/presign/route'),
      import('./api/identity/recheck/route'),
    ]);
    for (const r of routes) expect((await r.POST(post())).status).toBe(404);
    const putRoute = await import('./api/media/put/[...key]/route');
    const res = await putRoute.PUT(new Request('http://x', { method: 'PUT', body: 'x' }), {
      params: Promise.resolve({ key: ['a', 'b'] }),
    });
    expect(res.status).toBe(404);
    const state = await import('./api/state/route');
    expect(state.GET(new Request('http://x/s?session=abc')).status).toBe(404);
    expect(state.DELETE(new Request('http://x/s?session=abc')).status).toBe(404);
  });

  it('FR-801: outside production a missing dev token is 401 problem+json', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const { POST } = await import('./api/heartbeat/route');
    const res = await POST(new Request('http://x/y', { method: 'POST', body: '{}' }));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe('UNAUTHENTICATED');
  });

  it('FR-701: the PUT target refuses a path that no presign issued', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const { PUT } = await import('./api/media/put/[...key]/route');
    const bad = await PUT(new Request('http://x', { method: 'PUT', body: 'x' }), {
      params: Promise.resolve({
        key: ['orgs', 'demo', 'sessions', 'zz', 'media', 'WEBCAM', '000000', '00000001.webm'],
      }),
    });
    expect(bad.status).toBe(403);
    const junk = await PUT(new Request('http://x', { method: 'PUT', body: 'x' }), {
      params: Promise.resolve({ key: ['../etc/passwd'] }),
    });
    expect(junk.status).toBe(400);
  });
});

describe('bounds and body limits (FR-609, FR-701, NFR-04)', () => {
  it('TC-063 NFR-08: one signed batch with a huge seq does not hang the state scan; gaps are capped and counted', () => {
    const st = fresh();
    send(st, 0);
    send(st, 2_147_483_647);
    const t0 = Date.now();
    const s = summarize(st);
    expect(Date.now() - t0).toBeLessThan(500);
    expect(s.seq.highest).toBe(2_147_483_647);
    expect(s.seq.missing).toHaveLength(MAX_MISSING_SHOWN);
    expect(s.seq.missing[0]).toBe(1);
    expect(s.seq.missingCount).toBe(2_147_483_646);
  });

  it('TC-063 NFR-08: a normal gap still lists the missing seqs and counts them', () => {
    const st = fresh();
    send(st, 0);
    send(st, 4);
    expect(summarize(st).seq).toEqual({ highest: 4, missing: [1, 2, 3], missingCount: 3 });
  });

  it('FR-801: issued evidence names are capped (oldest dropped), also for EVENT purpose', () => {
    const st = fresh();
    for (let i = 0; i < MAX_EVIDENCE_ISSUED + 50; i++) {
      evidencePresign(st, 's1', { purpose: 'EVENT', contentType: 'image/jpeg', bytes: 10 });
    }
    expect(st.evidenceIssued.size).toBe(MAX_EVIDENCE_ISSUED);
  });

  it('FR-609: oversized heartbeat health objects are counted but not stored', () => {
    const st = fresh();
    heartbeat(st, { recorder: { pad: 'x'.repeat(20_000) }, queue: { pendingEventBatches: 1 } });
    expect(st.heartbeats.lastRecorder).toBeNull();
    expect(st.heartbeats.lastQueue).toEqual({ pendingEventBatches: 1 });
    expect(st.heartbeats.withHealth).toBe(1);
  });

  it('FR-801: only exactly application/json (optionally with parameters) is accepted', () => {
    const st = fresh();
    expect(send(st, 0, body(0), undefined, 'events', 'application/jsonx').status).toBe(415);
    expect(
      send(st, 0, body(0), undefined, 'events', 'application/json; charset=utf-8').status,
    ).toBe(200);
  });

  it('NFR-04: routes refuse on Content-Length before reading the body (413)', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const big = (n: number) => ({
      method: 'POST',
      headers: {
        authorization: 'Bearer demo-cl',
        'content-type': 'application/json',
        'content-length': String(n),
      },
      body: '{}',
    });
    const arrayBuffer = vi.spyOn(Request.prototype, 'arrayBuffer');
    const events = await import('./api/events/route');
    expect((await events.POST(new Request('http://x/e', big(300 * 1024)))).status).toBe(413);
    const ks = await import('./api/keystrokes/route');
    expect((await ks.POST(new Request('http://x/k', big(3 * 1024 * 1024)))).status).toBe(413);
    const hb = await import('./api/heartbeat/route');
    expect((await hb.POST(new Request('http://x/h', big(20 * 1024)))).status).toBe(413);
    sessionState('cl');
    const put = await import('./api/media/put/[...key]/route');
    const key = ['orgs', 'demo', 'sessions', 'cl', 'media', 'WEBCAM', '000000', '00000001.webm'];
    const res = await put.PUT(
      new Request('http://x/p', {
        method: 'PUT',
        headers: { 'content-length': String(17 * 1024 * 1024) },
        body: 'x',
      }),
      { params: Promise.resolve({ key }) },
    );
    expect(res.status).toBe(413);
    expect(arrayBuffer).not.toHaveBeenCalled(); // never read
  });

  it('NFR-04: the PUT target does not create session state from an unauthenticated URL', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const put = await import('./api/media/put/[...key]/route');
    const key = [
      'orgs',
      'demo',
      'sessions',
      'never-seen',
      'media',
      'WEBCAM',
      '000000',
      '00000001.webm',
    ];
    const res = await put.PUT(new Request('http://x/p', { method: 'PUT', body: 'x' }), {
      params: Promise.resolve({ key }),
    });
    expect(res.status).toBe(403);
    expect(existingSession('never-seen')).toBeUndefined();
  });
});
