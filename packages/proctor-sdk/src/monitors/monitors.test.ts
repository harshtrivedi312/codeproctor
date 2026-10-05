import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeContext } from '../test/helpers';
import { ClipboardMonitor } from './clipboard';
import { DevtoolsMonitor, devtoolsLikelyOpen } from './devtools';
import { FullscreenMonitor } from './fullscreen';
import { checkMultiScreen, MultiScreenMonitor } from './multi-screen';
import { ScreenShareMonitor } from './screen-share';
import { blockedShortcut, ShortcutMonitor } from './shortcuts';
import { checkVirtualCamera, findVirtualCamera, VirtualCameraMonitor } from './virtual-camera';
import { VisibilityMonitor } from './visibility';

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('ClipboardMonitor (FR-603)', () => {
  function setup() {
    const root = document.createElement('div');
    const inner = document.createElement('textarea');
    root.append(inner);
    document.body.append(root);
    const h = fakeContext(root);
    const m = new ClipboardMonitor();
    m.start(h.ctx);
    return { root, inner, h, m };
  }
  const fire = (el: Element, type: string, init: Record<string, unknown> = {}) => {
    const e = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(e, init);
    el.dispatchEvent(e);
    return e;
  };

  it('FR-603: blocks and logs paste with only the length, never the content', () => {
    const { inner, h } = setup();
    const e = fire(inner, 'paste', { clipboardData: { getData: () => 'secret code' } });
    expect(e.defaultPrevented).toBe(true);
    expect(h.events).toEqual([
      { type: 'PASTE_ATTEMPT', payload: { length: 11 }, options: undefined },
    ]);
    expect(JSON.stringify(h.events)).not.toContain('secret');
  });

  it('FR-603: blocks copy, cut, drop and right click', () => {
    const { inner, h } = setup();
    for (const t of ['copy', 'cut', 'drop', 'contextmenu']) {
      expect(fire(inner, t).defaultPrevented).toBe(true);
    }
    expect(h.events.map((e) => e.type)).toEqual([
      'COPY_ATTEMPT',
      'CUT_ATTEMPT',
      'DROP_ATTEMPT',
      'RIGHT_CLICK',
    ]);
  });

  it('FR-603: ignores events outside the root and stops after stop()', () => {
    const { h, m, inner } = setup();
    const outside = document.createElement('input');
    document.body.append(outside);
    expect(fire(outside, 'paste').defaultPrevented).toBe(false);
    m.stop();
    expect(fire(inner, 'paste').defaultPrevented).toBe(false);
    expect(h.events).toHaveLength(0);
  });
});

describe('ShortcutMonitor (FR-603, FR-610)', () => {
  const k = (key: string, o: Partial<KeyboardEvent> = {}) => ({
    key,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...o,
  });
  it('FR-603: recognises the devtools and view-source shortcuts', () => {
    expect(blockedShortcut(k('F12'))).toBe('F12');
    expect(blockedShortcut(k('i', { ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift+I');
    expect(blockedShortcut(k('J', { ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift+J');
    expect(blockedShortcut(k('c', { metaKey: true, altKey: true }))).toBe('Meta+Alt+C');
    expect(blockedShortcut(k('u', { ctrlKey: true }))).toBe('Ctrl+U');
  });
  it('FR-603: ordinary typing is never matched', () => {
    expect(blockedShortcut(k('a'))).toBeNull();
    expect(blockedShortcut(k('c', { ctrlKey: true }))).toBeNull();
    expect(blockedShortcut(k('i', { shiftKey: true }))).toBeNull();
  });
  it('FR-603: blocks the key event and emits a schema-valid shortcut name', () => {
    const h = fakeContext();
    const m = new ShortcutMonitor();
    m.start(h.ctx);
    const e = new KeyboardEvent('keydown', { key: 'F12', cancelable: true, bubbles: true });
    document.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(h.events[0]).toMatchObject({ type: 'SHORTCUT_BLOCKED', payload: { shortcut: 'F12' } });
    m.stop();
  });
});

describe('VisibilityMonitor (FR-602)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  const setHidden = (hidden: boolean) => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    document.dispatchEvent(new Event('visibilitychange'));
  };

  it('FR-602: logs TAB_SWITCH with its duration, and FOCUS_LOST is not double-counted', () => {
    const h = fakeContext();
    const m = new VisibilityMonitor();
    m.start(h.ctx);
    window.dispatchEvent(new Event('blur'));
    setHidden(true);
    vi.advanceTimersByTime(4000);
    setHidden(false);
    window.dispatchEvent(new Event('focus'));
    expect(h.events.map((e) => e.type)).toEqual(['TAB_SWITCH']);
    expect(h.events[0]?.options).toMatchObject({ durationMs: 4000 });
    m.stop();
  });

  it('FR-602: logs FOCUS_LOST with duration when the page stays visible', () => {
    const h = fakeContext();
    const m = new VisibilityMonitor();
    m.start(h.ctx);
    window.dispatchEvent(new Event('blur'));
    vi.advanceTimersByTime(2500);
    window.dispatchEvent(new Event('focus'));
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({ type: 'FOCUS_LOST', options: { durationMs: 2500 } });
    m.stop();
  });

  it('FR-602: a later focus loss is reported again after a tab switch', () => {
    const h = fakeContext();
    const m = new VisibilityMonitor();
    m.start(h.ctx);
    window.dispatchEvent(new Event('blur'));
    setHidden(true);
    setHidden(false);
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('blur'));
    vi.advanceTimersByTime(100);
    window.dispatchEvent(new Event('focus'));
    expect(h.events.map((e) => e.type)).toEqual(['TAB_SWITCH', 'FOCUS_LOST']);
    m.stop();
  });
});

describe('FullscreenMonitor (FR-601)', () => {
  function fsDoc(enabled: boolean) {
    let el: Element | null = null;
    const doc = document;
    Object.defineProperty(doc, 'fullscreenEnabled', { configurable: true, get: () => enabled });
    Object.defineProperty(doc, 'fullscreenElement', { configurable: true, get: () => el });
    return {
      set(v: Element | null) {
        el = v;
        doc.dispatchEvent(new Event('fullscreenchange'));
      },
    };
  }

  it('FR-601: locks the editor on exit and restores with a duration', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const fs = fsDoc(true);
    const h = fakeContext();
    const m = new FullscreenMonitor();
    fs.set(document.documentElement);
    m.start(h.ctx);
    expect(h.locks.at(-1)).toEqual({ reason: 'FULLSCREEN', locked: false });
    fs.set(null);
    vi.advanceTimersByTime(3000);
    fs.set(document.documentElement);
    expect(h.events.map((e) => e.type)).toEqual(['FULLSCREEN_EXIT', 'FULLSCREEN_RESTORED']);
    expect(h.events[1]?.options).toMatchObject({ durationMs: 3000 });
    expect(h.locks.map((l) => l.locked)).toEqual([false, true, false]);
    m.stop();
  });

  it('FR-601: reports UNSUPPORTED instead of pretending when fullscreen is unavailable', () => {
    fsDoc(false);
    const h = fakeContext();
    new FullscreenMonitor().start(h.ctx);
    expect(h.capabilities[0]).toMatchObject({ id: 'fullscreen', status: 'UNSUPPORTED' });
  });
});

describe('DevtoolsMonitor (FR-610)', () => {
  it('FR-610: heuristic compares outer and inner window size', () => {
    expect(
      devtoolsLikelyOpen({
        outerWidth: 1400,
        innerWidth: 1000,
        outerHeight: 900,
        innerHeight: 800,
      }),
    ).toBe(true);
    expect(
      devtoolsLikelyOpen({
        outerWidth: 1000,
        innerWidth: 1000,
        outerHeight: 900,
        innerHeight: 800,
      }),
    ).toBe(false);
  });
  it('FR-610: emits once per open episode', () => {
    vi.useFakeTimers();
    const win = { outerWidth: 1000, innerWidth: 1000, outerHeight: 800, innerHeight: 800 };
    const h = fakeContext();
    const m = new DevtoolsMonitor(win as Window, 1000);
    m.start(h.ctx);
    win.outerWidth = 1500;
    vi.advanceTimersByTime(3000);
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({
      type: 'DEVTOOLS_OPEN',
      payload: { heuristic: 'WINDOW_SIZE' },
    });
    win.outerWidth = 1000;
    vi.advanceTimersByTime(1000);
    win.outerWidth = 1500;
    vi.advanceTimersByTime(1000);
    expect(h.events).toHaveLength(2);
    m.stop();
  });
});

describe('multi-screen check (FR-605)', () => {
  it('FR-605: uses getScreenDetails when available', async () => {
    const r = await checkMultiScreen({
      screen: {},
      getScreenDetails: () => Promise.resolve({ screens: [{}, {}] }),
    });
    expect(r).toEqual({ kind: 'MULTI', api: 'WINDOW_MANAGEMENT', screenCount: 2 });
  });
  it('FR-605: falls back to screen.isExtended when the permission is denied', async () => {
    const r = await checkMultiScreen({
      screen: { isExtended: true },
      getScreenDetails: () => Promise.reject(new Error('denied')),
    });
    expect(r).toEqual({ kind: 'MULTI', api: 'SCREEN_IS_EXTENDED' });
  });
  it('FR-605: never reports SINGLE when it cannot tell', async () => {
    expect(await checkMultiScreen({ screen: {} })).toEqual({ kind: 'UNSUPPORTED' });
    expect(
      await checkMultiScreen({
        screen: {},
        getScreenDetails: () => Promise.reject(new Error('x')),
      }),
    ).toEqual({ kind: 'DENIED' });
  });
  it('FR-605: monitor emits MULTI_MONITOR, or DETECTOR_UNAVAILABLE with a capability flag', async () => {
    const h = fakeContext();
    const m = new MultiScreenMonitor({ screen: { isExtended: true } });
    await m.start(h.ctx);
    expect(h.events[0]).toMatchObject({
      type: 'MULTI_MONITOR',
      payload: { api: 'SCREEN_IS_EXTENDED' },
    });
    m.stop();

    const h2 = fakeContext();
    const m2 = new MultiScreenMonitor({ screen: {} });
    await m2.start(h2.ctx);
    expect(h2.events[0]).toMatchObject({
      type: 'DETECTOR_UNAVAILABLE',
      payload: { detector: 'MULTI_MONITOR', reason: 'UNSUPPORTED' },
    });
    expect(h2.capabilities[0]?.status).toBe('UNSUPPORTED');
    m2.stop();
  });
});

describe('virtual camera (FR-610, TC-064)', () => {
  const cam = (label: string) => ({ kind: 'videoinput', label });
  it('TC-064: matches OBS, ManyCam and other virtual camera names', () => {
    expect(findVirtualCamera([cam('OBS Virtual Camera')])).toBe('OBS Virtual Camera');
    expect(findVirtualCamera([cam('ManyCam Virtual Webcam')])).not.toBeNull();
    expect(findVirtualCamera([cam('FaceTime HD Camera')])).toBeNull();
    expect(findVirtualCamera([{ kind: 'audioinput', label: 'OBS Audio' }])).toBeNull();
  });
  it('TC-064: hidden labels are reported as unverifiable, not clean', async () => {
    const r = await checkVirtualCamera({
      enumerateDevices: () => Promise.resolve([cam('') as MediaDeviceInfo]),
    });
    expect(r.kind).toBe('LABELS_HIDDEN');
  });
  it('TC-064: monitor emits VIRTUAL_CAMERA once per device', async () => {
    const h = fakeContext();
    const media = {
      enumerateDevices: () => Promise.resolve([cam('OBS Virtual Camera') as MediaDeviceInfo]),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const m = new VirtualCameraMonitor(media);
    await m.start(h.ctx);
    await m.run();
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({
      type: 'VIRTUAL_CAMERA',
      payload: { deviceLabel: 'OBS Virtual Camera' },
    });
    m.stop();
  });
  it('TC-064: hidden labels emit DETECTOR_UNAVAILABLE plus a capability flag', async () => {
    const h = fakeContext();
    const media = {
      enumerateDevices: () => Promise.resolve([cam('') as MediaDeviceInfo]),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const m = new VirtualCameraMonitor(media);
    await m.start(h.ctx);
    expect(h.events[0]).toMatchObject({
      type: 'DETECTOR_UNAVAILABLE',
      payload: { detector: 'VIRTUAL_CAMERA', reason: 'PERMISSION_DENIED' },
    });
    expect(h.capabilities.at(-1)?.status).toBe('UNVERIFIABLE');
  });
});

describe('ScreenShareMonitor (FR-604)', () => {
  function fakeStream(surface: string | undefined) {
    const listeners: Record<string, () => void> = {};
    const track = {
      getSettings: () => (surface === undefined ? {} : { displaySurface: surface }),
      addEventListener: (n: string, f: () => void) => {
        listeners[n] = f;
      },
      stop: vi.fn(),
    };
    const stream = {
      getVideoTracks: () => [track],
      getTracks: () => [track],
    } as unknown as MediaStream;
    return { stream, track, end: () => listeners['ended']?.() };
  }

  it('FR-604: rejects a window or tab share', async () => {
    const s = fakeStream('window');
    const h = fakeContext();
    const m = new ScreenShareMonitor({ getDisplayMedia: () => Promise.resolve(s.stream) });
    m.start(h.ctx);
    const r = await m.request();
    expect(r).toEqual({ ok: false, reason: 'WRONG_SURFACE' });
    expect(s.track.stop).toHaveBeenCalled();
    expect(h.events[0]).toMatchObject({
      type: 'SCREEN_SHARE_STOPPED',
      payload: { reason: 'WRONG_SURFACE' },
    });
  });

  it('FR-604: accepts the whole screen, logs the end of the track and the re-share', async () => {
    const first = fakeStream('monitor');
    const second = fakeStream('monitor');
    const queue = [first, second];
    const h = fakeContext();
    const m = new ScreenShareMonitor({
      getDisplayMedia: () =>
        Promise.resolve((queue.shift() as ReturnType<typeof fakeStream>).stream),
    });
    m.start(h.ctx);
    expect((await m.request()).ok).toBe(true);
    first.end();
    expect(h.events[0]).toMatchObject({
      type: 'SCREEN_SHARE_STOPPED',
      payload: { reason: 'TRACK_ENDED' },
    });
    expect(h.locks.at(-1)).toEqual({ reason: 'SCREEN_SHARE', locked: true });
    expect((await m.request()).ok).toBe(true);
    expect(h.events[1]?.type).toBe('SCREEN_SHARE_RESUMED');
    expect(h.locks.at(-1)).toEqual({ reason: 'SCREEN_SHARE', locked: false });
  });

  it('FR-604: a browser that hides displaySurface gets an UNVERIFIABLE flag, not a pass', async () => {
    const s = fakeStream(undefined);
    const h = fakeContext();
    const m = new ScreenShareMonitor({ getDisplayMedia: () => Promise.resolve(s.stream) });
    m.start(h.ctx);
    await m.request();
    expect(
      h.capabilities.some((c) => c.id === 'screen-share-surface' && c.status === 'UNVERIFIABLE'),
    ).toBe(true);
  });

  it('FR-604: stopping the monitor does not log a stopped share', async () => {
    const s = fakeStream('monitor');
    const h = fakeContext();
    const m = new ScreenShareMonitor({ getDisplayMedia: () => Promise.resolve(s.stream) });
    m.start(h.ctx);
    await m.request();
    m.stop();
    s.end();
    expect(h.events).toHaveLength(0);
  });

  it('D-17: refuses to open the screen picker before consent', async () => {
    const getDisplayMedia = vi.fn();
    const h = fakeContext();
    h.setConsent(false);
    const m = new ScreenShareMonitor({ getDisplayMedia });
    m.start(h.ctx);
    await expect(m.request()).rejects.toThrow();
    expect(getDisplayMedia).not.toHaveBeenCalled();
  });
});
