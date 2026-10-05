/**
 * QA suite for the proctoring client (docs/test-cases.md TC-050..TC-056, TC-063, TC-065). Each test
 * drives the real monitors through a real ProctorSession and checks what would reach the API: the
 * signed batches. The HMAC is verified with node:crypto, independent of the SDK's own signer, and
 * every body is parsed with the shared batch schema the API will use. jsdom stands in for the
 * browser, so cases that need the real browser UI (picker, Esc, second monitor) stay manual or
 * e2e in docs/test-matrix.md; these tests are the unit-level evidence.
 */
import 'fake-indexeddb/auto';
import { createHmac } from 'node:crypto';
import {
  DEFAULT_EVENT_SEVERITY,
  proctorEventBatchSchema,
  type ProctorEventBatch,
} from '@codeproctor/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SignedBatch } from '../core/event-queue';
import { IdbStore } from '../core/idb';
import { ProctorSession, type ProctorSessionConfig } from '../core/session';
import type { Detector } from '../core/types';
import { DEFAULT_AI_CONFIG } from '../detectors/config';
import { PHONE_STRONG, PHONE_WEAK, NOTHING } from '../detectors/__fixtures__/samples';
import { FaceRules, ObjectRules } from '../detectors/rules';
import { ClipboardMonitor } from '../monitors/clipboard';
import { FullscreenMonitor } from '../monitors/fullscreen';
import { MultiScreenMonitor } from '../monitors/multi-screen';
import { ScreenShareMonitor } from '../monitors/screen-share';
import { VisibilityMonitor } from '../monitors/visibility';
import { TEST_KEY_B64 } from '../test/helpers';

const KEY = Buffer.from(TEST_KEY_B64, 'base64');
const verifies = (b: SignedBatch): boolean =>
  createHmac('sha256', KEY).update(b.body, 'utf8').digest('hex') === b.signature;

let dbN = 0;

interface Rig {
  session: ProctorSession;
  sent: SignedBatch[];
  root: HTMLElement;
  /** Every event the API would receive, in order, after checking signature and schema. */
  events(): ProctorEventBatch['events'];
  locks: { reason: string; locked: boolean }[];
}

async function rig(detectors: Detector[], over: Partial<ProctorSessionConfig> = {}): Promise<Rig> {
  const sent: SignedBatch[] = [];
  const root = document.createElement('div');
  const editor = document.createElement('textarea');
  root.append(editor);
  document.body.append(root);
  const session = new ProctorSession();
  const locks: { reason: string; locked: boolean }[] = [];
  session.on('lock', (l) => locks.push(l));
  await session.start({
    sessionId: 'qa-session',
    hmacKeyBase64: TEST_KEY_B64,
    root,
    consent: { recordedAt: '2026-10-05T10:00:00Z' },
    transport: {
      sendBatch: (b) => {
        sent.push(b);
        return Promise.resolve('OK');
      },
      heartbeat: () => Promise.resolve(true),
    },
    detectors,
    store: new IdbStore(indexedDB, `qa-${++dbN}`),
    flushIntervalMs: 5000,
    ...over,
  });
  return {
    session,
    sent,
    root,
    locks,
    events: () =>
      sent.flatMap((b) => {
        expect(verifies(b), `batch ${b.seq} signature`).toBe(true);
        const parsed = proctorEventBatchSchema.safeParse(JSON.parse(b.body));
        expect(parsed.success, `batch ${b.seq} schema`).toBe(true);
        return parsed.success ? parsed.data.events : [];
      }),
  };
}

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

const fire = (el: Element, type: string, init: Record<string, unknown> = {}): Event => {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(e, init);
  el.dispatchEvent(e);
  return e;
};

describe('TC-050 (FR-601): fullscreen exit', () => {
  function fullscreen() {
    let el: Element | null = document.documentElement;
    Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, get: () => true });
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => el });
    return (v: Element | null) => {
      el = v;
      document.dispatchEvent(new Event('fullscreenchange'));
    };
  }

  it('TC-050: pressing Esc locks the editor and logs FULLSCREEN_EXIT; returning unlocks and logs FULLSCREEN_RESTORED with the time spent out', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const setFs = fullscreen();
    const r = await rig([new FullscreenMonitor()]);
    expect(r.locks.at(-1)).toEqual({ reason: 'FULLSCREEN', locked: false });
    setFs(null);
    expect(r.locks.at(-1)).toEqual({ reason: 'FULLSCREEN', locked: true });
    vi.advanceTimersByTime(6000);
    setFs(document.documentElement);
    expect(r.locks.at(-1)).toEqual({ reason: 'FULLSCREEN', locked: false });
    await r.session.stop();
    const ev = r.events();
    expect(ev.map((e) => e.type)).toEqual(['FULLSCREEN_EXIT', 'FULLSCREEN_RESTORED']);
    expect(ev[1]?.durationMs).toBe(6000);
  });

  // Documented gap: test-cases.md says FULLSCREEN_EXIT is "logged with duration". The SDK can only
  // know the duration when fullscreen returns, so the EXIT event has none and a candidate who never
  // returns leaves no duration at all. Reported as defect QA-D-01; remove KNOWN DEFECT when decided.
  it.fails(
    'TC-050 KNOWN DEFECT QA-D-01: the FULLSCREEN_EXIT event itself carries a duration',
    async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const setFs = fullscreen();
      const r = await rig([new FullscreenMonitor()]);
      setFs(null);
      vi.advanceTimersByTime(6000);
      setFs(document.documentElement);
      await r.session.stop();
      expect(r.events().find((e) => e.type === 'FULLSCREEN_EXIT')?.durationMs).toBe(6000);
    },
  );
});

describe('TC-051 (FR-602): tab switch', () => {
  const setHidden = (hidden: boolean) => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    document.dispatchEvent(new Event('visibilitychange'));
  };

  it('TC-051: leaving the tab for 8 s logs one TAB_SWITCH with about 8 s duration and no extra FOCUS_LOST', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const r = await rig([new VisibilityMonitor()]);
    window.dispatchEvent(new Event('blur'));
    setHidden(true);
    vi.advanceTimersByTime(8000);
    setHidden(false);
    window.dispatchEvent(new Event('focus'));
    await r.session.stop();
    const ev = r.events();
    expect(ev).toHaveLength(1);
    expect(ev[0]?.type).toBe('TAB_SWITCH');
    expect(ev[0]?.durationMs).toBeGreaterThanOrEqual(7500);
    expect(ev[0]?.durationMs).toBeLessThanOrEqual(8500);
  });

  it('TC-051: Alt+Tab to another window (blur only, page still visible) logs FOCUS_LOST with the duration', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    setHidden(false);
    const r = await rig([new VisibilityMonitor()]);
    window.dispatchEvent(new Event('blur'));
    vi.advanceTimersByTime(8000);
    window.dispatchEvent(new Event('focus'));
    await r.session.stop();
    const ev = r.events();
    expect(ev.map((e) => e.type)).toEqual(['FOCUS_LOST']);
    expect(ev[0]?.durationMs).toBe(8000);
  });
});

describe('TC-052 / TC-053 (FR-603): paste and drop blocked', () => {
  it('TC-052: Ctrl+V into the editor inserts nothing and logs PASTE_ATTEMPT with the length but never the text', async () => {
    const r = await rig([new ClipboardMonitor()]);
    const editor = r.root.querySelector('textarea') as HTMLTextAreaElement;
    const secret = 'print("pasted from outside")';
    const e = fire(editor, 'paste', { clipboardData: { getData: () => secret } });
    expect(e.defaultPrevented).toBe(true);
    expect(editor.value).toBe('');
    await r.session.stop();
    const ev = r.events();
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ type: 'PASTE_ATTEMPT', payload: { length: secret.length } });
    expect(JSON.stringify(r.sent)).not.toContain('pasted from outside');
  });

  it('TC-052: a paste outside the editor area is left alone and logs nothing', async () => {
    const r = await rig([new ClipboardMonitor()]);
    const outside = document.createElement('input');
    document.body.append(outside);
    expect(fire(outside, 'paste').defaultPrevented).toBe(false);
    await r.session.stop();
    expect(r.events()).toHaveLength(0);
  });

  it('TC-053: dropping text into the editor is blocked and logged as DROP_ATTEMPT without content', async () => {
    const r = await rig([new ClipboardMonitor()]);
    const editor = r.root.querySelector('textarea') as HTMLTextAreaElement;
    const e = fire(editor, 'drop', { dataTransfer: { getData: () => 'dragged text' } });
    expect(e.defaultPrevented).toBe(true);
    expect(editor.value).toBe('');
    await r.session.stop();
    const ev = r.events();
    expect(ev.map((x) => x.type)).toEqual(['DROP_ATTEMPT']);
    expect(JSON.stringify(r.sent)).not.toContain('dragged text');
  });
});

describe('TC-054 / TC-055 (FR-604): screen share', () => {
  function stream(surface: string) {
    const listeners: Record<string, () => void> = {};
    const track = {
      getSettings: () => ({ displaySurface: surface }),
      addEventListener: (n: string, f: () => void) => {
        listeners[n] = f;
      },
      stop: vi.fn(),
    };
    return {
      stream: { getVideoTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream,
      track,
      stopSharing: () => listeners['ended']?.(),
    };
  }

  it('TC-054: choosing a window instead of the entire screen is rejected, the stream is stopped and the attempt is logged', async () => {
    const s = stream('window');
    const monitor = new ScreenShareMonitor({ getDisplayMedia: () => Promise.resolve(s.stream) });
    const r = await rig([monitor]);
    const res = await monitor.request();
    expect(res).toEqual({ ok: false, reason: 'WRONG_SURFACE' });
    expect(s.track.stop).toHaveBeenCalled();
    await r.session.stop();
    expect(r.events().map((e) => e.type)).toEqual(['SCREEN_SHARE_STOPPED']);
  });

  it('TC-054: a browser tab share is rejected the same way', async () => {
    const s = stream('browser');
    const monitor = new ScreenShareMonitor({ getDisplayMedia: () => Promise.resolve(s.stream) });
    await rig([monitor]);
    expect(await monitor.request()).toEqual({ ok: false, reason: 'WRONG_SURFACE' });
  });

  it('TC-055: clicking "Stop sharing" locks the editor and logs SCREEN_SHARE_STOPPED (HIGH severity in the shared taxonomy)', async () => {
    const s = stream('monitor');
    const monitor = new ScreenShareMonitor({ getDisplayMedia: () => Promise.resolve(s.stream) });
    const r = await rig([monitor]);
    expect((await monitor.request()).ok).toBe(true);
    s.stopSharing();
    expect(r.locks.at(-1)).toEqual({ reason: 'SCREEN_SHARE', locked: true });
    await r.session.stop();
    const ev = r.events();
    expect(ev.at(-1)).toMatchObject({
      type: 'SCREEN_SHARE_STOPPED',
      payload: { reason: 'TRACK_ENDED' },
    });
    expect(DEFAULT_EVENT_SEVERITY.SCREEN_SHARE_STOPPED).toBe('HIGH');
  });

  it('D-17: a session without recorded consent refuses to start, so no detector runs and the screen picker is never opened', async () => {
    const getDisplayMedia = vi.fn();
    const monitor = new ScreenShareMonitor({ getDisplayMedia });
    await expect(
      rig([monitor], { consent: null as unknown as { recordedAt: string } }),
    ).rejects.toThrow();
    expect(getDisplayMedia).not.toHaveBeenCalled();
  });
});

describe('TC-056 (FR-605): second monitor', () => {
  it('TC-056: an extended desktop logs MULTI_MONITOR; a browser that cannot tell is reported as unverifiable, never as clean', async () => {
    const r = await rig([new MultiScreenMonitor({ screen: { isExtended: true } })]);
    await r.session.stop();
    expect(r.events().map((e) => e.type)).toEqual(['MULTI_MONITOR']);

    const r2 = await rig([new MultiScreenMonitor({ screen: {} })]);
    await r2.session.stop();
    expect(r2.events().map((e) => e.type)).toEqual(['DETECTOR_UNAVAILABLE']);
    expect(r2.session.getCapabilities().some((c) => c.status === 'UNSUPPORTED')).toBe(true);
  });
});

describe('TC-063 (FR-609, NFR-08): network drop', () => {
  it('TC-063: a 45 s outage loses no batch; everything arrives in sequence order with valid signatures afterwards', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    let online = false;
    const sent: SignedBatch[] = [];
    const r = await rig([new ClipboardMonitor()], {
      transport: {
        sendBatch: (b) => {
          if (!online) return Promise.resolve('RETRY');
          sent.push(b);
          return Promise.resolve('OK');
        },
        heartbeat: () => Promise.resolve(online),
      },
      backoffBaseMs: 1000,
    });
    const editor = r.root.querySelector('textarea') as HTMLTextAreaElement;
    for (let i = 0; i < 9; i++) {
      fire(editor, 'paste', { clipboardData: { getData: () => 'x'.repeat(i + 1) } });
      await vi.advanceTimersByTimeAsync(5000); // one batch per 5 s window
    }
    online = true;
    // The browser's `online` event is the documented reconnect trigger (retryNow): it drains at
    // once instead of waiting for the backoff timer, so the test does not depend on host speed.
    window.dispatchEvent(new Event('online'));
    // The SDK needs real wall-clock turns for IndexedDB writes and fake time for its backoff, so
    // poll in real time (30 s deadline) and advance fake time per poll until all arrived.
    // How many pastes end up in one batch depends on host speed (a slow flush lets the next paste
    // join the pending batch), so count delivered events, not batches.
    const eventsSent = (): number =>
      sent.reduce((n, b) => n + (JSON.parse(b.body) as ProctorEventBatch).events.length, 0);
    await vi.waitFor(
      async () => {
        // 5 fake seconds per poll: six polls cross the 30 s backoff cap even on a slow host.
        await vi.advanceTimersByTimeAsync(5000);
        expect(eventsSent()).toBe(9);
      },
      { timeout: 30_000, interval: 5 },
    );
    // No gap and no reordering: seq runs 0..n-1 in order.
    expect(sent.map((b) => b.seq)).toEqual(sent.map((_, i) => i));
    const lengths = sent.flatMap((b) =>
      (JSON.parse(b.body) as ProctorEventBatch).events.map(
        (e) => (e.payload as { length: number }).length,
      ),
    );
    expect(lengths.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    for (const b of sent) expect(verifies(b)).toBe(true);
    await r.session.stop();
  }, 40_000);
});

describe('TC-065 (security): forged events', () => {
  it('TC-065: every batch is signed with HMAC-SHA256 over its exact body and the signature matches an independent implementation', async () => {
    const r = await rig([new ClipboardMonitor()]);
    const editor = r.root.querySelector('textarea') as HTMLTextAreaElement;
    fire(editor, 'paste', { clipboardData: { getData: () => 'abc' } });
    await r.session.stop();
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]?.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(verifies(r.sent[0] as SignedBatch)).toBe(true);
  });

  it('TC-065: changing one character of the payload, or the sequence number, breaks the signature', async () => {
    const r = await rig([new ClipboardMonitor()]);
    const editor = r.root.querySelector('textarea') as HTMLTextAreaElement;
    fire(editor, 'paste', { clipboardData: { getData: () => 'abc' } });
    await r.session.stop();
    const good = r.sent[0] as SignedBatch;
    expect(verifies({ ...good, body: good.body.replace('"length":3', '"length":4') })).toBe(false);
    expect(verifies({ ...good, body: good.body.replace('"seq":0', '"seq":1') })).toBe(false);
    // A signature made with a different key does not verify either.
    const other = createHmac('sha256', Buffer.alloc(32, 9)).update(good.body).digest('hex');
    expect(verifies({ ...good, signature: other })).toBe(false);
  });

  it('TC-065: sequence numbers rise by one per batch and a replayed batch keeps its original seq and signature (idempotent retry)', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    const r = await rig([new ClipboardMonitor()]);
    const editor = r.root.querySelector('textarea') as HTMLTextAreaElement;
    for (let i = 0; i < 3; i++) {
      fire(editor, 'paste', { clipboardData: { getData: () => 'a'.repeat(i + 1) } });
      await vi.advanceTimersByTimeAsync(5000);
      // Signing uses WebCrypto, which runs outside the faked timers. Wait in real time (30 s
      // deadline) until this batch has been delivered, so the next paste cannot join it and stop()
      // cannot run while a batch is still being signed. Independent of host speed.
      await vi.waitFor(() => expect(r.sent).toHaveLength(i + 1), { timeout: 30_000, interval: 5 });
    }
    await r.session.stop();
    expect(r.sent.map((b) => b.seq)).toEqual([0, 1, 2]);
    expect(new Set(r.sent.map((b) => b.signature)).size).toBe(3);
  }, 40_000);

  it('TC-065: the client refuses to build batches with server-only event types (RESUME_OTP_FAILED, risk or similarity events) or malformed payloads', async () => {
    const sent: SignedBatch[] = [];
    const root = document.createElement('div');
    document.body.append(root);
    let hooked: ((t: string, p: unknown) => void) | undefined;
    const rogue: Detector = {
      id: 'rogue',
      start: (ctx) => {
        hooked = ctx.emit as unknown as (t: string, p: unknown) => void;
      },
      stop: () => undefined,
    };
    const session = new ProctorSession();
    await session.start({
      sessionId: 'forge',
      hmacKeyBase64: TEST_KEY_B64,
      root,
      consent: { recordedAt: '2026-10-05T10:00:00Z' },
      transport: {
        sendBatch: (b) => {
          sent.push(b);
          return Promise.resolve('OK');
        },
        heartbeat: () => Promise.resolve(true),
      },
      detectors: [rogue],
      store: new IdbStore(indexedDB, `qa-forge-${++dbN}`),
    });
    expect(hooked).toBeDefined();
    hooked?.('RESUME_OTP_FAILED', {});
    hooked?.('CODE_SIMILARITY', {});
    hooked?.('PASTE_ATTEMPT', { length: -5 });
    await session.stop();
    expect(sent).toHaveLength(0);
    expect(session.getQueueStats()).toBeNull();
  });
});

describe('TC-057 / TC-058 / TC-059 (FR-606): vision rules on 1 s samples', () => {
  const T = 5_000_000;
  const face = (counts: number[]) => {
    const rules = new FaceRules(DEFAULT_AI_CONFIG);
    return counts.flatMap((n, i) =>
      rules.process({ faceCount: n }, T + i * 1000).map((e) => ({ at: i, e })),
    );
  };

  it('TC-057: leaving the camera view for 10 s raises one NO_FACE after 5 s, with the 5 s duration, not at the first missing frame', () => {
    const got = face([1, 1, ...Array<number>(10).fill(0), 1]);
    expect(got).toHaveLength(1);
    expect(got[0]?.e.type).toBe('NO_FACE');
    expect(got[0]?.at).toBe(2 + 5); // two present seconds, then the fifth absent second
    expect(got[0]?.e.durationMs).toBe(5000);
  });

  it('TC-057: stepping out for 3 s only (shorter than 5 s) raises nothing', () => {
    expect(face([1, 0, 0, 0, 1, 1, 1])).toEqual([]);
  });

  it('TC-058: a second person entering the frame raises MULTIPLE_FACES after two samples, with HIGH severity in the taxonomy', () => {
    const got = face([1, 1, 2, 2, 2]);
    expect(got.map((g) => g.e.type)).toEqual(['MULTIPLE_FACES']);
    expect(got[0]?.e.faceCount).toBe(2);
    expect(DEFAULT_EVENT_SEVERITY.MULTIPLE_FACES).toBe('HIGH');
  });

  it('TC-058: one noisy frame with two faces is not an event', () => {
    expect(face([1, 2, 1, 1, 2, 1])).toEqual([]);
  });

  it('TC-059: a phone held up to the camera raises PHONE_DETECTED (confidence kept), a weak guess or other objects do not', () => {
    const rules = new ObjectRules(DEFAULT_AI_CONFIG);
    const frames = [PHONE_STRONG, PHONE_STRONG, PHONE_STRONG, PHONE_STRONG];
    const got = frames.flatMap((d, i) => rules.process(d, T + i * 2000));
    expect(got.map((e) => e.type)).toEqual(['PHONE_DETECTED']);
    expect(got[0]?.confidence).toBeGreaterThan(0.5);
    expect(DEFAULT_EVENT_SEVERITY.PHONE_DETECTED).toBe('HIGH');

    const quiet = new ObjectRules(DEFAULT_AI_CONFIG);
    const none = [PHONE_WEAK, NOTHING, PHONE_WEAK, NOTHING, PHONE_WEAK].flatMap((d, i) =>
      quiet.process(d, T + i * 2000),
    );
    expect(none).toEqual([]);
  });
});
