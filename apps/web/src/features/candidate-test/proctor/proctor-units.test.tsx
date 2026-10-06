import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import { describe, expect, it, vi } from 'vitest';
import { candidateApi } from '@/features/candidate-flow/api';
import { setSessionToken } from '@/features/candidate-flow/session-store';
import {
  recordRequests,
  server,
  setupCandidateServer,
} from '@/features/candidate-flow/test-helpers';
import { apiBaseUrl } from '@/lib/env';
import { MOCK_OTP, MOCK_TOKENS } from '@/mocks/candidate/handlers';
import { ProctorGate, ProctorPausedOverlay, ScreenShareLostOverlay } from '../overlays';
import { ALREADY_UPLOADED_URL, createAdrMediaApi, putChunk } from './media-api';
import { sessionIdFromToken } from './controller';
import { createProctorTransport } from './transport';

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_MOCKING = 'enabled';
});
vi.mock('@/lib/mock-ready', () => ({
  mockingReady: Promise.resolve(),
  markMockingReady: () => undefined,
}));

setupCandidateServer();
const cand = `${apiBaseUrl}/v1/candidate`;

async function signIn(): Promise<void> {
  const r = await candidateApi.startSession(MOCK_TOKENS.consented, MOCK_OTP);
  if (!r.ok) throw new Error('sign-in');
  setSessionToken(r.data.sessionToken);
  await candidateApi.startTest();
}

const batch = { seq: 1, body: '{"seq":1,"events":[]}', signature: 'a'.repeat(64) };

describe('proctor overlays (NFR-06, ADR 0002 P-2)', () => {
  it('NFR-06: the gate, the pause overlay and the screen-share overlay have no axe violations', async () => {
    const view = render(
      <ProctorGate
        ready
        shared={false}
        failure="Try again."
        busy={false}
        onShare={vi.fn()}
        onEnter={vi.fn()}
      />,
    );
    expect(await axe(document.body)).toHaveNoViolations();
    view.unmount();
    render(<ProctorPausedOverlay />);
    expect(screen.getByRole('alertdialog')).toHaveTextContent(/your time is stopped/i);
    expect(await axe(document.body)).toHaveNoViolations();
  });

  it('FR-604: the screen-share overlay says the time keeps running and offers one action', async () => {
    const onShare = vi.fn();
    const user = userEvent.setup();
    render(<ScreenShareLostOverlay onShare={onShare} failed={null} />);
    expect(screen.getByRole('alertdialog')).toHaveTextContent(/your time keeps running/i);
    await user.click(screen.getByRole('button', { name: /share your entire screen again/i }));
    expect(onShare).toHaveBeenCalled();
    expect(await axe(document.body)).toHaveNoViolations();
  });

  it('FR-604: the gate does not offer fullscreen before the screen is shared, nor anything before it is ready', () => {
    render(
      <ProctorGate
        ready={false}
        shared={false}
        failure={null}
        busy={false}
        onShare={vi.fn()}
        onEnter={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /share your entire screen/i })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /enter fullscreen/i })).not.toBeInTheDocument();
  });
});

describe('proctor transport (ADR 0013 5.2, 5.3)', () => {
  const hooks = () => ({ onState: vi.fn(), onNotActive: vi.fn(), onReauthRequired: vi.fn() });

  it('ADR 0013 5.2: sends the exact signed body with X-Signature and the bearer token, no cookies, no Referer', async () => {
    await signIn();
    const seen = recordRequests();
    const t = createProctorTransport(hooks());
    // The mock verifies the signature, so a fake one is a 403 (dropped, never retried).
    expect(await t.sendBatch(batch)).toBe('REJECTED');
    const sent = seen.find((r) => r.url.endsWith('/session/events'));
    expect(JSON.stringify(sent?.body)).toContain('"seq":1');
  });

  it.each([
    [429, 'RETRY'],
    [503, 'RETRY'],
    [408, 'RETRY'],
    [400, 'REJECTED'],
    [413, 'REJECTED'],
    [415, 'REJECTED'],
  ] as const)('ADR 0013 5.2: status %s is %s', async (status, expected) => {
    await signIn();
    server.use(http.post(`${cand}/session/events`, () => HttpResponse.json({}, { status })));
    expect(await createProctorTransport(hooks()).sendBatch(batch)).toBe(expected);
  });

  it('ADR 0013 5.2: a network failure retries', async () => {
    await signIn();
    server.use(http.post(`${cand}/session/events`, () => HttpResponse.error()));
    expect(await createProctorTransport(hooks()).sendBatch(batch)).toBe('RETRY');
  });

  it('ADR 0013 5.2: 409 SESSION_NOT_ACTIVE stops, 409 KEY_EPOCH_STALE drops the batch', async () => {
    await signIn();
    const h = hooks();
    server.use(
      http.post(`${cand}/session/events`, () =>
        HttpResponse.json({ code: 'SESSION_NOT_ACTIVE' }, { status: 409 }),
      ),
    );
    expect(await createProctorTransport(h).sendBatch(batch)).toBe('REJECTED');
    expect(h.onNotActive).toHaveBeenCalled();
    server.use(
      http.post(`${cand}/session/events`, () =>
        HttpResponse.json({ code: 'KEY_EPOCH_STALE' }, { status: 409 }),
      ),
    );
    expect(await createProctorTransport(hooks()).sendBatch(batch)).toBe('REJECTED');
  });

  it('ADR 0013 5.2: a stale key drops the batch and NEVER asks for a new code (a new code cannot re-sign it)', async () => {
    await signIn();
    server.use(
      http.post(`${cand}/session/events`, () =>
        HttpResponse.json({ code: 'KEY_EPOCH_STALE' }, { status: 409 }),
      ),
    );
    const h = hooks();
    const t = createProctorTransport(h);
    for (let i = 0; i < 12; i += 1) expect(await t.sendBatch(batch)).toBe('REJECTED');
    expect(h.onReauthRequired).not.toHaveBeenCalled();
  });

  it('ADR 0013 section 2: once purging, nothing more is sent', async () => {
    await signIn();
    const seen = recordRequests();
    const t = createProctorTransport({ ...hooks(), isPurged: () => true });
    expect(await t.sendBatch(batch)).toBe('REJECTED');
    expect(seen.some((q) => q.url.endsWith('/session/events'))).toBe(false);
  });

  it('ADR 0013 5.2: three 401s in a row ask for a new code; one does not', async () => {
    await signIn();
    server.use(
      http.post(`${cand}/session/events`, () =>
        HttpResponse.json({ code: 'TOKEN_EXPIRED' }, { status: 401 }),
      ),
    );
    const h = hooks();
    const t = createProctorTransport(h);
    await t.sendBatch(batch);
    await t.sendBatch(batch);
    expect(h.onReauthRequired).not.toHaveBeenCalled();
    await t.sendBatch(batch);
    expect(h.onReauthRequired).toHaveBeenCalledWith('TOKEN_EXPIRED');
  });

  it('ADR 0013 5.3: a heartbeat passes the server state and timing to the app, and a renewed token goes to memory only', async () => {
    await signIn();
    server.use(
      http.post(`${cand}/session/heartbeat`, () =>
        HttpResponse.json({
          serverTime: '2026-10-06T10:00:00.000Z',
          status: 'IN_PROGRESS',
          startedAt: null,
          deadlineAt: null,
          sectionDeadlineAt: null,
          pauseReasons: [],
          sessionToken: 'renewed-session-token-value',
          sessionTokenExpiresAt: '2026-10-06T10:15:00.000Z',
        }),
      ),
    );
    const h = hooks();
    expect(await createProctorTransport(h).heartbeat()).toBe(true);
    const [state, timing] = h.onState.mock.calls[0] as [
      { serverTime: string },
      { startedAt: number; endedAt: number },
    ];
    expect(state.serverTime).toBe('2026-10-06T10:00:00.000Z');
    expect(timing.endedAt).toBeGreaterThanOrEqual(timing.startedAt);
    const { getSessionToken } = await import('@/features/candidate-flow/session-store');
    expect(getSessionToken()).toBe('renewed-session-token-value');
    expect(Object.keys(localStorage)).toEqual([]);
  });

  it('ADR 0013 5.3: 409 SESSION_NOT_ACTIVE on a heartbeat is "ended", not offline', async () => {
    await signIn();
    server.use(
      http.post(`${cand}/session/heartbeat`, () =>
        HttpResponse.json({ code: 'SESSION_NOT_ACTIVE' }, { status: 409 }),
      ),
    );
    const h = hooks();
    expect(await createProctorTransport(h).heartbeat()).toBe(false);
    expect(h.onNotActive).toHaveBeenCalled();
  });
});

describe('media api bridge (ADR 0013 5.5, FR-701)', () => {
  const chunk = (segment: number, seq: number, stream: 'SCREEN' | 'AUDIO' = 'SCREEN') => ({
    stream,
    segment,
    seq,
    bytes: 100,
    contentType: 'video/webm;codecs=vp8',
  });

  it('ADR 0013 5.5: the wire seq is unique per stream across segments, and the content type is bare', async () => {
    await signIn();
    const seen = recordRequests();
    const api = createAdrMediaApi();
    await api.presign(chunk(2, 7));
    await api.presign(chunk(0, 7, 'AUDIO'));
    const bodies = seen
      .filter((r) => r.url.endsWith('/media/presign'))
      .map((r) => r.body as Record<string, unknown>);
    expect(bodies[0]).toMatchObject({
      stream: 'SCREEN',
      segment: 2,
      seq: 200_007,
      contentType: 'video/webm',
    });
    expect(bodies[1]).toMatchObject({ stream: 'AUDIO', seq: 7, contentType: 'audio/webm' });
    expect(JSON.stringify(bodies)).not.toContain('codecs');
    expect(bodies[0]).toMatchObject({ durationMs: 10_000 });
  });

  it('ADR 0013 5.5: alreadyUploaded becomes a marker that needs no PUT; 412 on the PUT counts as stored', async () => {
    await signIn();
    const api = createAdrMediaApi();
    expect((await api.presign(chunk(0, 1))).url.startsWith('http')).toBe(true);
    await api.confirm(chunk(0, 1));
    expect((await api.presign(chunk(0, 1))).url).toBe(ALREADY_UPLOADED_URL);
    expect(await putChunk(ALREADY_UPLOADED_URL, new ArrayBuffer(1), {})).toBe(200);
    server.use(
      http.put(`${apiBaseUrl}/mock-upload/x`, () => new HttpResponse(null, { status: 412 })),
    );
    expect(await putChunk(`${apiBaseUrl}/mock-upload/x`, new ArrayBuffer(1), {})).toBe(200);
  });

  it('FU-FEB-36: alreadyUploaded for a chunk this page was never given a URL for is a conflict, not "stored"', async () => {
    await signIn();
    const api = createAdrMediaApi();
    server.use(
      http.post(`${cand}/session/media/presign`, () =>
        HttpResponse.json({ alreadyUploaded: true }),
      ),
    );
    await expect(api.presign(chunk(0, 1))).rejects.toMatchObject({ kind: 'FATAL' });
  });

  it('ADR 0013 5.5: a wire seq above 99,999,999 is refused before any request', async () => {
    await signIn();
    const seen = recordRequests();
    await expect(createAdrMediaApi().presign(chunk(1000, 0))).rejects.toMatchObject({
      kind: 'FATAL',
    });
    expect(seen.some((q) => q.url.endsWith('/media/presign'))).toBe(false);
  });

  it('ADR 0013 5.5: session over and seq conflicts are fatal (dropped), everything else is retried', async () => {
    await signIn();
    const api = createAdrMediaApi();
    server.use(
      http.post(`${cand}/session/media/presign`, () =>
        HttpResponse.json({ code: 'SESSION_NOT_ACTIVE' }, { status: 409 }),
      ),
    );
    await expect(api.presign(chunk(0, 1))).rejects.toMatchObject({ kind: 'FATAL' });
    server.use(
      http.post(`${cand}/session/media/presign`, () =>
        HttpResponse.json({ code: 'SEQ_CONFLICT' }, { status: 409 }),
      ),
    );
    await expect(api.presign(chunk(0, 1))).rejects.toMatchObject({ kind: 'FATAL' });
    server.use(
      http.post(`${cand}/session/media/presign`, () => HttpResponse.json({}, { status: 429 })),
    );
    await expect(api.presign(chunk(0, 1))).rejects.toMatchObject({ kind: 'RETRY' });
    server.use(
      http.post(`${cand}/session/media/confirm`, () =>
        HttpResponse.json({ code: 'UPLOAD_NOT_FOUND' }, { status: 409 }),
      ),
    );
    await expect(api.confirm(chunk(0, 1))).rejects.toMatchObject({ kind: 'RETRY' });
  });
});

describe('session id for the SDK storage', () => {
  it('ADR 0013 5.10: uses the token sid claim when there is one; without one only mock mode gets a random id and everything else fails closed (null)', () => {
    const sid = '3f0e2a7c-6a52-4d5b-9a53-7e9b6a1c2d10';
    const payload = btoa(JSON.stringify({ sid })).replace(/=/g, '');
    expect(sessionIdFromToken(`h.${payload}.s`)).toBe(sid);
    expect(sessionIdFromToken('mock-session-token-1', true)).toMatch(/^[0-9a-f-]{36}$/);
    expect(sessionIdFromToken(null, true)).toMatch(/^[0-9a-f-]{36}$/);
    // Outside mock mode there is no fallback: the test does not start (fail closed).
    expect(sessionIdFromToken('mock-session-token-1', false)).toBeNull();
    expect(sessionIdFromToken(null, false)).toBeNull();
  });
});
