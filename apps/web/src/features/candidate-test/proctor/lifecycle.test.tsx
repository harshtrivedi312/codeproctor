import { STORES } from '@codeproctor/proctor-sdk';
import { screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  recordRequests,
  renderWithQuery,
  server,
  setupCandidateServer,
} from '@/features/candidate-flow/test-helpers';
import { apiBaseUrl } from '@/lib/env';
import { MOCK_INGEST_GRACE_MS, testState } from '@/mocks/candidate/test-handlers';
import { createAdrSource } from '../adr-source';
import { ProctoredTest } from '../proctored-test';
import { ProctorController, seedCounters } from './controller';
import { MemoryStore, installFullscreen, setupDevices, startedSession } from './test-support';
import { withRetry } from './retry';

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_MOCKING = 'enabled';
});
vi.mock('@/lib/mock-ready', () => ({
  mockingReady: Promise.resolve(),
  markMockingReady: () => undefined,
}));
vi.mock('next/dynamic', async () => {
  const { editorStub } = await import('@/features/candidate-flow/test-helpers');
  return { default: () => editorStub() };
});

setupCandidateServer();
const cand = `${apiBaseUrl}/v1/candidate`;
const SID = '3f0e2a7c-6a52-4d5b-9a53-7e9b6a1c2d10';
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => installFullscreen());
const created: ProctorController[] = [];
afterEach(async () => {
  // A controller left running by a failed test would beat on the next test's session.
  await Promise.all(created.splice(0).map((c) => c.stop()));
  cleanup();
  await wait(150);
  vi.unstubAllGlobals();
  localStorage.clear();
});

function controllerFor(store: MemoryStore, extra: Record<string, unknown> = {}) {
  const c = new ProctorController({
    consentRecordedAt: '2026-10-05T10:00:00.000Z',
    sessionId: SID,
    root: document.body,
    store,
    heartbeatIntervalMs: 40,
    flushIntervalMs: 40,
    finishDrainMs: 200,
    retrySleep: () => Promise.resolve(),
    ...extra,
  });
  created.push(c);
  return c;
}

const paste = (): void => {
  document.body.dispatchEvent(new Event('paste', { bubbles: true, cancelable: true }));
};
const flush = (): void => {
  window.dispatchEvent(new Event('pagehide'));
};

describe('purge and keep on the way out (ADR 0013 section 2, Purge; TC-063)', () => {
  it('ADR 0013 5.3: 409 SESSION_NOT_ACTIVE purges signed batches and releases the devices', async () => {
    const devices = setupDevices();
    const session = await startedSession();
    // The server cannot take events (503), so batches wait in the store.
    server.use(http.post(`${cand}/session/events`, () => HttpResponse.json({}, { status: 503 })));
    const store = new MemoryStore();
    const c = controllerFor(store);
    await c.init();
    await c.shareScreen();
    await c.startRecorders();
    paste();
    await waitFor(() => expect(store.count(STORES.eventBatches)).toBeGreaterThan(0));
    testState(session).submitted = true;
    testState(session).submittedAt = Date.now() - MOCK_INGEST_GRACE_MS - 1000;
    await waitFor(() => expect(c.getState().endedBecause).toBe('not-active'), { timeout: 4000 });
    await waitFor(() => expect(store.count(STORES.eventBatches)).toBe(0));
    expect(store.count(STORES.chunks)).toBe(0);
    expect(devices.display.stops).toHaveBeenCalled();
    expect(devices.userStreams.every((s) => s.stops.mock.calls.length > 0)).toBe(true);
  });

  it('ADR 0013 5.2: 401 SESSION_TAKEN_OVER purges at once (this device is no longer the test)', async () => {
    setupDevices();
    await startedSession();
    const store = new MemoryStore();
    server.use(
      http.post(`${cand}/session/events`, () =>
        HttpResponse.json({ code: 'SESSION_TAKEN_OVER' }, { status: 401 }),
      ),
    );
    const c = controllerFor(store);
    await c.init();
    paste();
    flush();
    await waitFor(() => expect(c.getState().endedBecause).toBe('reauth'), { timeout: 4000 });
    await waitFor(() => expect(store.count(STORES.eventBatches)).toBe(0));
  });

  it('ADR 0013 5.2: three TOKEN_EXPIRED 401s ask for a new code but keep the outbox for the next run', async () => {
    setupDevices();
    await startedSession();
    const store = new MemoryStore();
    // An expired token is refused everywhere: the events and the heartbeat.
    server.use(
      http.post(`${cand}/session/events`, () =>
        HttpResponse.json({ code: 'TOKEN_EXPIRED' }, { status: 401 }),
      ),
      http.post(`${cand}/session/heartbeat`, () =>
        HttpResponse.json({ code: 'TOKEN_EXPIRED' }, { status: 401 }),
      ),
    );
    const c = controllerFor(store);
    await c.init();
    paste();
    await waitFor(
      () => {
        flush();
        // `online` makes the SDK retry now instead of waiting out its back-off.
        window.dispatchEvent(new Event('online'));
        expect(c.getState().endedBecause).toBe('reauth');
      },
      { timeout: 6000 },
    );
    await wait(100);
    expect(store.count(STORES.eventBatches)).toBeGreaterThan(0);
  });

  it('ADR 0013 section 2: leaving the page (stop) keeps unsent data for a reload and releases devices', async () => {
    const devices = setupDevices();
    await startedSession();
    server.use(http.post(`${cand}/session/events`, () => HttpResponse.json({}, { status: 503 })));
    const store = new MemoryStore();
    const c = controllerFor(store);
    await c.init();
    await c.shareScreen();
    paste();
    await waitFor(() => expect(store.count(STORES.eventBatches)).toBeGreaterThan(0));
    await c.stop();
    expect(store.count(STORES.eventBatches)).toBeGreaterThan(0);
    expect(devices.display.stops).toHaveBeenCalled();
  });
});

describe('no device after the end (late grants)', () => {
  it('FR-604: a screen share granted after the test ended is switched off at once', async () => {
    const devices = setupDevices({ deferred: true });
    await startedSession();
    const c = controllerFor(new MemoryStore());
    await c.init();
    const sharing = c.shareScreen();
    await c.stop();
    devices.grantDisplay();
    expect(await sharing).toEqual({ ok: false, reason: 'STOPPED' });
    expect(devices.display.stops).toHaveBeenCalled();
    expect(FakeRecorderCount()).toBe(0);
  });

  it('FR-701: a webcam granted after the test ended is stopped and no recorder is left running', async () => {
    const devices = setupDevices({ deferred: true });
    await startedSession();
    const c = controllerFor(new MemoryStore());
    await c.init();
    const starting = c.startRecorders();
    await waitFor(() => expect(devices.getUserMedia).toHaveBeenCalledTimes(1));
    await c.stop();
    devices.grantUser();
    await starting;
    expect(devices.userStreams[0]?.stops).toHaveBeenCalled();
    // The microphone is never even asked for once the test is over.
    expect(devices.getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('FR-601: asking for fullscreen or the screen on a stopped controller does nothing', async () => {
    const devices = setupDevices();
    await startedSession();
    const c = controllerFor(new MemoryStore());
    await c.init();
    await c.stop();
    expect(await c.shareScreen()).toEqual({ ok: false, reason: 'STOPPED' });
    expect(await c.enterFullscreen()).toBe(false);
    await c.startRecorders();
    expect(devices.getDisplayMedia).not.toHaveBeenCalled();
    expect(devices.getUserMedia).not.toHaveBeenCalled();
  });

  it('ADR 0013 section 2: stopping while the key and session are still starting stops the half-started session', async () => {
    setupDevices();
    const session = await startedSession();
    const c = controllerFor(new MemoryStore());
    const starting = c.init();
    await c.stop();
    await starting;
    const beats = testState(session).heartbeats;
    await wait(250);
    expect(testState(session).heartbeats).toBe(beats);
  });
});

function FakeRecorderCount(): number {
  return (
    (
      globalThis as { MediaRecorder?: { instances?: { state: string }[] } }
    ).MediaRecorder?.instances?.filter((r) => r.state === 'recording').length ?? 0
  );
}

describe('counters from the key response (ADR 0013 section 2)', () => {
  it('ADR 0013 section 2: seedCounters keeps the larger of the local and the server value', async () => {
    const store = new MemoryStore();
    await store.put(STORES.meta, `${SID}:nextEventSeq`, 900);
    await store.put(STORES.meta, `${SID}:segment:SCREEN`, 7);
    await seedCounters(store, SID, {
      eventSeqStart: 500,
      media: {
        SCREEN: { nextSeq: 0, nextSegment: 3 },
        WEBCAM: { nextSeq: 250_001, nextSegment: 1 },
      },
    });
    expect(await store.get(STORES.meta, `${SID}:nextEventSeq`)).toBe(900);
    expect(await store.get(STORES.meta, `${SID}:segment:SCREEN`)).toBe(7);
    // The wire seq is segment * 100000 + seq, so segment 3 is the first that clears 250001.
    expect(await store.get(STORES.meta, `${SID}:segment:WEBCAM`)).toBe(2);
    await seedCounters(store, SID, undefined);
  });

  it('ADR 0013 section 2: with counters above zero the first batch and the first chunk start there', async () => {
    const devices = setupDevices();
    const session = await startedSession();
    server.use(
      http.post(`${cand}/session/proctor-key`, () =>
        HttpResponse.json({
          alg: 'HMAC-SHA256',
          key: btoa('k'.repeat(32)),
          keyEpoch: 2,
          counters: {
            eventSeqStart: 500,
            keystrokeSeqStart: 0,
            media: { WEBCAM: { nextSeq: 3, nextSegment: 4 } },
          },
        }),
      ),
    );
    const seen = recordRequests();
    const c = controllerFor(new MemoryStore());
    await c.init();
    await c.startRecorders();
    devices.recorders.forEach((r) => r.emit());
    paste();
    await waitFor(() => {
      flush();
      expect(testState(session).batches.length).toBeGreaterThan(0);
    });
    expect(Math.min(...testState(session).batches.map((b) => b.seq))).toBeGreaterThanOrEqual(500);
    await waitFor(() => expect(seen.some((q) => q.url.endsWith('/media/presign'))).toBe(true));
    const webcam = seen
      .filter((q) => q.url.endsWith('/media/presign'))
      .map((q) => q.body as { stream: string; segment: number; seq: number })
      .find((b) => b.stream === 'WEBCAM');
    expect(webcam).toMatchObject({ segment: 4, seq: 400_000 });
    await c.stop();
  });
});

describe('what the server sees (ADR 0013 5.3, ADR 0005)', () => {
  it('ADR 0005: detectors that are not started are reported as unavailable, so "off" is not "no findings"', async () => {
    setupDevices();
    const session = await startedSession();
    const c = controllerFor(new MemoryStore());
    await c.init();
    await waitFor(() => {
      flush();
      expect(testState(session).batches.length).toBeGreaterThan(0);
    });
    const unavailable = testState(session).batches.flatMap((b) =>
      b.events.filter((e) => e.type === 'DETECTOR_UNAVAILABLE'),
    );
    expect(unavailable.length).toBeGreaterThanOrEqual(4);
    await c.stop();
  });

  it('ADR 0013 5.3: the heartbeat body carries the queue and recorder health', async () => {
    setupDevices();
    await startedSession();
    const seen = recordRequests();
    const c = controllerFor(new MemoryStore());
    await c.init();
    await waitFor(() => expect(seen.some((q) => q.url.endsWith('/heartbeat'))).toBe(true));
    await waitFor(() => {
      const beat = seen.filter((q) => q.url.endsWith('/heartbeat')).at(-1)?.body as {
        queue?: object;
        recorder?: { streams: unknown[] };
      } | null;
      expect(beat?.queue).toBeDefined();
      expect(beat?.recorder?.streams).toHaveLength(3);
    });
    await c.stop();
  });

  it('NFR-05 S-10: the SDK counter backup holds only {seq, seenAt} and is removed when the test ends', async () => {
    setupDevices();
    await startedSession();
    const c = controllerFor(new MemoryStore());
    await c.init();
    paste();
    flush();
    await waitFor(() => expect(localStorage.getItem(`codeproctor:eventseq:${SID}`)).not.toBeNull());
    const value = JSON.parse(localStorage.getItem(`codeproctor:eventseq:${SID}`) ?? '{}') as object;
    expect(Object.keys(value).sort()).toEqual(['seenAt', 'seq']);
    await c.finish();
    expect(localStorage.getItem(`codeproctor:eventseq:${SID}`)).toBeNull();
  });

  it('FR-505: finishing sends the queued events before the end, within the ingest grace', async () => {
    setupDevices();
    const session = await startedSession();
    const c = controllerFor(new MemoryStore());
    await c.init();
    paste();
    await c.finish();
    expect(testState(session).batches.flatMap((b) => b.events.map((e) => e.type))).toContain(
      'PASTE_ATTEMPT',
    );
  });
});

describe('retries (S-6)', () => {
  it('ADR 0013 5.1: a 503 and a 429 on the key route are retried before the test ends', async () => {
    setupDevices();
    await startedSession();
    let calls = 0;
    server.use(
      http.post(`${cand}/session/proctor-key`, () => {
        calls += 1;
        if (calls === 1) return HttpResponse.json({}, { status: 503 });
        if (calls === 2)
          return HttpResponse.json({}, { status: 429, headers: { 'Retry-After': '1' } });
        return HttpResponse.json({
          alg: 'HMAC-SHA256',
          key: btoa('k'.repeat(32)),
          keyEpoch: 1,
        });
      }),
    );
    const c = controllerFor(new MemoryStore());
    expect(await c.init()).toBe(true);
    expect(calls).toBe(3);
    await c.stop();
  });

  it('ADR 0013 5.1: withRetry honours Retry-After (capped), tries a bounded number of times, and never retries a 401', async () => {
    const sleeps: number[] = [];
    const sleep = (ms: number) => {
      sleeps.push(ms);
      return Promise.resolve();
    };
    let n = 0;
    const result = await withRetry(
      () => {
        n += 1;
        return Promise.resolve({
          ok: false,
          kind: 'problem',
          status: 429,
          code: null,
          retryAfterSeconds: 99,
        } as const);
      },
      { sleep },
    );
    expect(result.ok).toBe(false);
    expect(n).toBe(3);
    expect(sleeps).toEqual([5000, 5000]);
    let m = 0;
    await withRetry(() => {
      m += 1;
      return Promise.resolve({
        ok: false,
        kind: 'problem',
        status: 401,
        code: null,
        retryAfterSeconds: null,
      } as const);
    });
    expect(m).toBe(1);
  });
});

describe('React mounting (S-1, S-13)', () => {
  it('ADR 0013 section 4: under StrictMode the key is requested once, so the test is not ended by KEY_ALREADY_ISSUED', async () => {
    setupDevices();
    const session = await startedSession();
    const seen = recordRequests();
    const onSessionEnded = vi.fn();
    renderWithQuery(
      <React.StrictMode>
        <main id="main">
          <ProctoredTest
            source={createAdrSource({ onSessionEnded })}
            onSessionEnded={onSessionEnded}
            onSubmitted={vi.fn()}
            timing={{ heartbeatIntervalMs: 60, flushIntervalMs: 60, finishDrainMs: 200 }}
          />
        </main>
      </React.StrictMode>,
    );
    const share = await screen.findByRole('button', { name: /share your entire screen/i });
    await waitFor(() => expect(share).toBeEnabled());
    expect(seen.filter((q) => q.url.endsWith('/proctor-key'))).toHaveLength(1);
    await waitFor(() => expect(testState(session).heartbeats).toBeGreaterThan(0));
    expect(onSessionEnded).not.toHaveBeenCalled();
  });

  it('FR-701: unmounting the real test releases the screen, the recorders and fullscreen', async () => {
    const devices = setupDevices();
    await startedSession();
    const user = userEvent.setup();
    const onSessionEnded = vi.fn();
    const view = renderWithQuery(
      <main id="main">
        <ProctoredTest
          source={createAdrSource({ onSessionEnded })}
          onSessionEnded={onSessionEnded}
          onSubmitted={vi.fn()}
          timing={{ heartbeatIntervalMs: 60, flushIntervalMs: 60, finishDrainMs: 200 }}
        />
      </main>,
    );
    const share = await screen.findByRole('button', { name: /share your entire screen/i });
    await waitFor(() => expect(share).toBeEnabled());
    await user.click(share);
    await user.click(await screen.findByRole('button', { name: /enter fullscreen and continue/i }));
    await screen.findByRole('button', { name: /run sample tests/i });
    expect(document.fullscreenElement).not.toBeNull();
    view.unmount();
    await waitFor(() => expect(devices.display.stops).toHaveBeenCalled());
    await waitFor(() => expect(document.fullscreenElement).toBeNull());
    // Every recorder was stopped (its last chunk is flushed).
    await waitFor(() => expect(devices.recorders.every((r) => r.state === 'inactive')).toBe(true));
    expect(devices.recorders.length).toBeGreaterThan(0);
  });

  it('NFR-06 S-13: the real test renders no second main landmark inside the flow main', async () => {
    setupDevices();
    await startedSession();
    const onSessionEnded = vi.fn();
    renderWithQuery(
      <main id="main">
        <ProctoredTest
          source={createAdrSource({ onSessionEnded })}
          onSessionEnded={onSessionEnded}
          onSubmitted={vi.fn()}
          timing={{ heartbeatIntervalMs: 60, flushIntervalMs: 60, finishDrainMs: 200 }}
        />
      </main>,
    );
    await screen.findByRole('dialog', { name: /share your entire screen/i });
    expect(document.querySelectorAll('main')).toHaveLength(1);
  });
});
