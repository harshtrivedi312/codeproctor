import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectorPolicy, parseCandidateAccommodations } from '../core/accommodations';
import { EvidenceError, createEvidenceClient } from './evidence-client';
import { IdentityScheduler } from './identity';

/**
 * Evidence presign, identity re-check and waivers (FR-606 TC-057..059, FR-305, ADR 0013 5.6,
 * ADR 0015, owner decisions C-08, C-25, C-34). Privacy: a frame is never persisted or logged.
 */
const TOKEN = 'candidate-token-SECRET';
const NAME = 'evidence/01HZX3Q8Y2K4M6N8P0R2S4T6V8.jpg';
afterEach(() => vi.restoreAllMocks());

const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

function client(handler: (path: string, body: unknown) => Response, puts?: number[]) {
  const calls: { path: string; body: unknown; auth: string }[] = [];
  const c = createEvidenceClient({
    baseUrl: 'https://api.test',
    getToken: () => TOKEN,
    fetchFn: ((url: string, init: RequestInit) => {
      const path = url.replace('https://api.test', '');
      const body = JSON.parse(init.body as string) as unknown;
      calls.push({
        path,
        body,
        auth: (init.headers as Record<string, string>)['Authorization'] ?? '',
      });
      return Promise.resolve(handler(path, body));
    }) as unknown as typeof fetch,
    put: (_url, body, headers) => {
      puts?.push(body.size);
      expect(headers['Content-Type']).toBe('image/jpeg');
      return Promise.resolve(200);
    },
  });
  return { c, calls };
}

const presignOk = () =>
  reply(200, {
    url: 'https://store.invalid/put',
    method: 'PUT',
    headers: { 'If-None-Match': '*' },
    evidenceKey: NAME,
    expiresAt: '2026-01-01T00:01:00Z',
  });

describe('evidence presign (ADR 0013 5.6; FR-801)', () => {
  it('sends the purpose, accepts only evidence/<ULID>.jpg, returns the headers', async () => {
    const { c, calls } = client(() => presignOk());
    const r = await c.presign({ purpose: 'EVENT', contentType: 'image/jpeg', bytes: 1234 });
    expect(r).toEqual({
      url: 'https://store.invalid/put',
      evidenceKey: NAME,
      headers: { 'If-None-Match': '*' },
    });
    expect(calls[0]).toMatchObject({
      path: '/candidate/session/evidence/presign',
      body: { purpose: 'EVENT', contentType: 'image/jpeg', bytes: 1234 },
      auth: `Bearer ${TOKEN}`,
    });
    const bad = client(() => reply(200, { url: 'https://x', evidenceKey: 'evidence/../x.jpg' }));
    await expect(
      bad.c.presign({ purpose: 'EVENT', contentType: 'image/jpeg', bytes: 1 }),
    ).rejects.toBeInstanceOf(EvidenceError);
  });

  it('maps the documented codes and never leaks the token or a URL into the error', async () => {
    const cases: [number, string, string][] = [
      [409, 'IDENTITY_CHECK_WAIVED', 'WAIVED'],
      [409, 'DETECTOR_DISABLED', 'DETECTOR_DISABLED'],
      [409, 'QUOTA_EXCEEDED', 'QUOTA_EXCEEDED'],
      [409, 'SESSION_NOT_ACTIVE', 'NOT_ACTIVE'],
      [401, 'TOKEN_EXPIRED', 'UNAUTHENTICATED'],
      [429, 'RATE_LIMITED', 'RATE_LIMITED'],
      [503, 'BUSY', 'UNAVAILABLE'],
      [400, 'VALIDATION', 'REJECTED'],
    ];
    for (const [status, code, kind] of cases) {
      const { c } = client(() =>
        reply(status, { code, detail: `${TOKEN} https://store.invalid/x` }, { 'Retry-After': '7' }),
      );
      const err = (await c
        .presign({ purpose: 'EVENT', contentType: 'image/jpeg', bytes: 1 })
        .catch((e: unknown) => e)) as EvidenceError;
      expect(err.kind).toBe(kind);
      expect(`${err.message}${JSON.stringify(err)}${err.stack ?? ''}`).not.toContain(TOKEN);
      expect(`${err.message}${JSON.stringify(err)}`).not.toContain('store.invalid');
      if (kind === 'RATE_LIMITED' || kind === 'UNAVAILABLE') expect(err.retryAfterMs).toBe(7000);
    }
  });
});

describe('identity re-check upload (FR-606, TC-057, C-08, ADR 0013 5.6)', () => {
  it('presign IDENTITY_RECHECK, PUT the frame, POST the name with capturedAt: ACCEPTED, no result', async () => {
    const puts: number[] = [];
    const { c, calls } = client(
      (path) => (path.endsWith('/evidence/presign') ? presignOk() : reply(202, { accepted: true })),
      puts,
    );
    const at = new Date('2026-03-01T10:00:00Z');
    const out = await c.rechecker(new Blob(['frame-bytes']), at);
    expect(out).toEqual({ kind: 'ACCEPTED' });
    expect(puts).toEqual([11]);
    expect(calls.map((x) => x.path)).toEqual([
      '/candidate/session/evidence/presign',
      '/candidate/session/identity/recheck',
    ]);
    expect(calls[0]?.body).toMatchObject({ purpose: 'IDENTITY_RECHECK', bytes: 11 });
    expect(calls[1]?.body).toEqual({ evidenceKey: NAME, capturedAt: at.toISOString() });
  });

  it('IDENTITY_CHECK_WAIVED and DETECTOR_DISABLED stop the scheduler quietly (no event, no retry)', async () => {
    for (const [code, state] of [
      ['IDENTITY_CHECK_WAIVED', 'WAIVED'],
      ['DETECTOR_DISABLED', 'DETECTOR_DISABLED'],
    ] as const) {
      const { c, calls } = client(() => reply(409, { code }));
      const s = new IdentityScheduler(120_000, () => Promise.resolve(new Blob(['f'])), c.rechecker);
      s.start();
      await s.tick();
      expect(s.getStatus().state).toBe(state);
      await s.tick(); // stopped: nothing more is sent
      expect(calls).toHaveLength(1);
    }
  });

  it('429 and 503 back off (Retry-After honoured); UPLOAD_NOT_FOUND and 400 skip the frame', async () => {
    let t = 1_000_000;
    let mode: 'busy' | 'missing' | 'ok' = 'busy';
    const { c, calls } = client((path) => {
      if (path.endsWith('/presign')) {
        return mode === 'busy'
          ? reply(503, { code: 'BUSY' }, { 'Retry-After': '300' })
          : presignOk();
      }
      return mode === 'missing'
        ? reply(409, { code: 'UPLOAD_NOT_FOUND' })
        : reply(202, { accepted: true });
    });
    const s = new IdentityScheduler(
      120_000,
      () => Promise.resolve(new Blob(['f'])),
      c.rechecker,
      undefined,
      () => t,
    );
    await s.tick();
    expect(s.getStatus().state).toBe('BACKOFF');
    t += 60_000;
    await s.tick();
    expect(calls).toHaveLength(1); // still backing off (Retry-After 300 s)
    t += 400_000;
    mode = 'missing';
    await s.tick();
    expect(s.getStatus()).toMatchObject({ state: 'RUNNING', skipped: 1 });
    mode = 'ok';
    await s.tick();
    expect(s.getStatus().accepted).toBe(1);
  });

  it('a failed PUT is a retry, never an accepted frame', async () => {
    const c = createEvidenceClient({
      baseUrl: 'https://api.test',
      getToken: () => TOKEN,
      fetchFn: () => Promise.resolve(presignOk()),
      put: () => Promise.resolve(403),
    });
    expect(await c.rechecker(new Blob(['f']), new Date())).toEqual({ kind: 'RETRY' });
  });
});

describe('privacy: frames stay in memory only (NFR-05, FR-606)', () => {
  it('a frame is never written to IndexedDB or localStorage and nothing is logged', async () => {
    const open = vi.spyOn(indexedDB, 'open');
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const logs = [
      vi.spyOn(console, 'log'),
      vi.spyOn(console, 'warn'),
      vi.spyOn(console, 'error'),
      vi.spyOn(console, 'info'),
      vi.spyOn(console, 'debug'),
    ];
    const seen: Blob[] = [];
    const s = new IdentityScheduler(
      60_000,
      () => Promise.resolve(new Blob(['SECRET-FRAME'])),
      (frame) => {
        seen.push(frame);
        return Promise.resolve({ kind: 'ACCEPTED' as const });
      },
    );
    await s.tick();
    expect(seen).toHaveLength(1);
    expect(open).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
    for (const l of logs) expect(l).not.toHaveBeenCalled();
    // The status carries counts and a state only.
    expect(JSON.stringify(s.getStatus())).not.toContain('SECRET-FRAME');
  });

  it('a frame that is in flight when stop() runs is ignored and no outcome is applied', async () => {
    let release!: (o: { kind: 'ACCEPTED' }) => void;
    const s = new IdentityScheduler(
      60_000,
      () => Promise.resolve(new Blob(['f'])),
      () => new Promise((r) => (release = r)),
    );
    s.start();
    const ticking = s.tick();
    await Promise.resolve();
    await Promise.resolve();
    s.stop();
    release({ kind: 'ACCEPTED' });
    await ticking;
    expect(s.getStatus()).toMatchObject({ state: 'STOPPED', accepted: 0 });
  });
});

describe('waivers (FR-305, C-25, C-34, ADR 0015)', () => {
  it('parses the two booleans (and the optional list); anything else is null', () => {
    expect(
      parseCandidateAccommodations({ identityCheckWaived: true, faceDetectorsOff: false }),
    ).toEqual({
      identityCheckWaived: true,
      faceDetectorsOff: false,
    });
    expect(
      parseCandidateAccommodations({
        identityCheckWaived: false,
        faceDetectorsOff: false,
        disabledDetectors: ['GAZE', 'NOPE', 'OBJECT'],
      })?.disabledDetectors,
    ).toEqual(['GAZE', 'OBJECT']);
    for (const bad of [
      null,
      [],
      'x',
      {},
      { identityCheckWaived: 'yes', faceDetectorsOff: false },
    ]) {
      expect(parseCandidateAccommodations(bad)).toBeNull();
    }
  });

  it('C-25: the waiver turns off the re-check only; faceDetectorsOff turns off FACE and the re-check (C-34); neither implies the other', () => {
    expect(detectorPolicy({ identityCheckWaived: true, faceDetectorsOff: false })).toEqual({
      disabledDetectors: [],
      identityRecheck: false,
    });
    expect(detectorPolicy({ identityCheckWaived: false, faceDetectorsOff: true })).toEqual({
      disabledDetectors: ['FACE'],
      identityRecheck: false,
    });
    expect(detectorPolicy({ identityCheckWaived: false, faceDetectorsOff: false })).toEqual({
      disabledDetectors: [],
      identityRecheck: true,
    });
    expect(
      detectorPolicy({
        identityCheckWaived: false,
        faceDetectorsOff: false,
        disabledDetectors: ['GAZE'],
      }),
    ).toEqual({ disabledDetectors: ['GAZE'], identityRecheck: true });
  });

  it('a missing or unreadable answer never weakens proctoring', () => {
    expect(detectorPolicy(null)).toEqual({ disabledDetectors: [], identityRecheck: true });
  });
});
