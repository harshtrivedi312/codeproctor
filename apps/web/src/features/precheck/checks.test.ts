import { describe, expect, it, vi } from 'vitest';
import { BrowserSystemChecker, detectBrowser, type CheckerEnvironment } from './checks';
import { buildSystemCheckBody } from './system-check-body';

const UA = {
  chrome:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
  firefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0',
  safari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  opera:
    'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 OPR/110.0.0.0',
};

function env(overrides: Partial<CheckerEnvironment['navigator']> = {}): CheckerEnvironment {
  return {
    navigator: { userAgent: UA.chrome, ...overrides },
    window: { screen: { isExtended: false } } as unknown as Window,
    document: {
      fullscreenEnabled: true,
      documentElement: { requestFullscreen: vi.fn(() => Promise.resolve()) },
      exitFullscreen: vi.fn(() => Promise.resolve()),
    } as unknown as Document,
    ping: () => Promise.resolve(40),
  };
}

function track(settings: Record<string, unknown> = {}) {
  return { stop: vi.fn(), getSettings: () => settings } as unknown as MediaStreamTrack;
}
function stream(tracks: MediaStreamTrack[]): MediaStream {
  return {
    getTracks: () => tracks,
    getVideoTracks: () => tracks,
  } as unknown as MediaStream;
}

describe('browser detection (FR-402, TC-031)', () => {
  it.each([
    ['chrome', 'Chrome', true],
    ['edge', 'Edge', true],
    ['firefox', 'Firefox', false],
    ['safari', 'Safari', false],
    ['opera', 'Other', false],
  ] as const)('TC-031: %s is classified as %s (supported: %s)', (key, brand, supported) => {
    const info = detectBrowser(UA[key]);
    expect(info.brand).toBe(brand);
    expect(info.supported).toBe(supported);
  });

  it('TC-031: Firefox gets a clear block with the supported browsers named', () => {
    const result = new BrowserSystemChecker(env({ userAgent: UA.firefox })).browser();
    expect(result.status).toBe('failed');
    expect(result.message).toMatch(/firefox is not supported/i);
    expect(result.help).toMatch(/chrome or microsoft edge/i);
  });

  it('FR-402: uses the UA-CH brand list when present', () => {
    const info = detectBrowser('', [{ brand: 'Microsoft Edge', version: '141' }]);
    expect(info).toMatchObject({ brand: 'Edge', majorVersion: 141, supported: true });
  });
});

describe('device and screen checks (FR-402, TC-032)', () => {
  it('TC-032: a denied camera fails with a fix-it hint and opens no stream', async () => {
    const getUserMedia = vi.fn(() => Promise.reject(new DOMException('x', 'NotAllowedError')));
    const result = await new BrowserSystemChecker(env({ mediaDevices: { getUserMedia } })).camera();
    expect(result.status).toBe('failed');
    expect(result.message).toMatch(/camera access was blocked/i);
    expect(result.help).toMatch(/allow/i);
    expect(result.stream).toBeUndefined();
  });

  it('FR-402: a missing camera and a missing microphone each get their own help', async () => {
    const getUserMedia = vi.fn(() => Promise.reject(new DOMException('x', 'NotFoundError')));
    const checker = new BrowserSystemChecker(env({ mediaDevices: { getUserMedia } }));
    expect((await checker.camera()).message).toMatch(/no camera was found/i);
    expect((await checker.microphone(() => undefined)).message).toMatch(/no microphone was found/i);
  });

  it('FR-402: a working camera returns the stream for the preview', async () => {
    const s = stream([track()]);
    const getUserMedia = vi.fn(() => Promise.resolve(s));
    const enumerateDevices = vi.fn(() =>
      Promise.resolve([{ kind: 'videoinput', label: 'FaceTime HD' }]),
    );
    const result = await new BrowserSystemChecker(
      env({ mediaDevices: { getUserMedia, enumerateDevices } as never }),
    ).camera();
    expect(result.status).toBe('passed');
    expect(result.stream).toBe(s);
    expect(result.virtualCameraLabel).toBeNull();
  });

  it('FR-610: a virtual camera name is noted, not blocked', async () => {
    const s = stream([track()]);
    const result = await new BrowserSystemChecker(
      env({
        mediaDevices: {
          getUserMedia: () => Promise.resolve(s),
          enumerateDevices: () =>
            Promise.resolve([{ kind: 'videoinput', label: 'OBS Virtual Camera' }]),
        } as never,
      }),
    ).camera();
    expect(result.status).toBe('passed');
    expect(result.virtualCameraLabel).toBe('OBS Virtual Camera');
  });

  it('FR-604: sharing a window instead of the entire screen fails with a hint, and the share is stopped', async () => {
    const t = track({ displaySurface: 'window' });
    const result = await new BrowserSystemChecker(
      env({ mediaDevices: { getDisplayMedia: () => Promise.resolve(stream([t])) } }),
    ).screen();
    expect(result).toMatchObject({ kind: 'OTHER', status: 'failed' });
    expect(result.help).toMatch(/entire screen/i);
    expect(t.stop).toHaveBeenCalled();
  });

  it('FR-604: sharing the entire screen passes and the share is stopped straight away', async () => {
    const t = track({ displaySurface: 'monitor' });
    const result = await new BrowserSystemChecker(
      env({ mediaDevices: { getDisplayMedia: () => Promise.resolve(stream([t])) } }),
    ).screen();
    expect(result).toMatchObject({ kind: 'MONITOR', status: 'passed' });
    expect(t.stop).toHaveBeenCalled();
  });

  it('FR-604: a browser that cannot say what was shared passes with a note, never silently', async () => {
    const result = await new BrowserSystemChecker(
      env({ mediaDevices: { getDisplayMedia: () => Promise.resolve(stream([track({})])) } }),
    ).screen();
    expect(result).toMatchObject({ kind: 'UNVERIFIABLE', status: 'warning' });
  });

  it('FR-402: cancelling the share prompt fails with a hint', async () => {
    const result = await new BrowserSystemChecker(
      env({
        mediaDevices: {
          getDisplayMedia: () => Promise.reject(new DOMException('x', 'NotAllowedError')),
        },
      }),
    ).screen();
    expect(result.status).toBe('failed');
    expect(result.help).toMatch(/entire screen/i);
  });

  it('FR-605: a second screen fails the check; an unknown count is only a warning', async () => {
    const multi = env();
    (multi.window as unknown as { screen: { isExtended: boolean } }).screen.isExtended = true;
    expect((await new BrowserSystemChecker(multi).monitor()).status).toBe('failed');
    const unknown = env();
    (unknown.window as unknown as { screen: object }).screen = {};
    expect((await new BrowserSystemChecker(unknown).monitor()).status).toBe('warning');
    expect((await new BrowserSystemChecker(env()).monitor()).status).toBe('passed');
  });

  it('FR-402: network is advisory: slow gives a warning, an unreachable service a failure', async () => {
    const slow = env({ connection: { downlink: 0.4, rtt: 100 } });
    expect((await new BrowserSystemChecker(slow).network()).status).toBe('warning');
    const fast = env({ connection: { downlink: 20, rtt: 30 } });
    expect(await new BrowserSystemChecker(fast).network()).toMatchObject({
      status: 'passed',
      downlinkKbps: 20000,
    });
    const down = env();
    down.ping = () => Promise.reject(new Error('offline'));
    expect((await new BrowserSystemChecker(down).network()).status).toBe('failed');
  });

  it('FR-402: full screen blocked fails with a hint', async () => {
    const e = env();
    (
      e.document.documentElement as unknown as { requestFullscreen: () => Promise<void> }
    ).requestFullscreen = () => Promise.reject(new Error('blocked'));
    const result = await new BrowserSystemChecker(e).fullscreen();
    expect(result.status).toBe('failed');
    expect(result.help).toBeTruthy();
  });
});

describe('system check body (ADR 0013 section 5.4)', () => {
  it('FR-402: carries findings for extra screens and virtual cameras, and the device results', () => {
    const body = buildSystemCheckBody(
      {
        browser: { brand: 'Chrome', majorVersion: 141, supported: true },
        cameraOk: true,
        microphoneOk: true,
        screen: 'MONITOR',
        network: { downlinkKbps: 20000, rttMs: 30 },
        monitor: { kind: 'MULTI', api: 'WINDOW_MANAGEMENT', screenCount: 2 },
        virtualCameraLabel: 'OBS Virtual Camera',
      },
      new Date('2026-10-05T10:00:00Z'),
    );
    expect(body.devices).toEqual({ camera: true, microphone: true, screenShare: 'MONITOR' });
    expect(body.findings).toEqual([
      {
        type: 'MULTI_MONITOR',
        occurredAt: '2026-10-05T10:00:00.000Z',
        payload: { api: 'WINDOW_MANAGEMENT', screenCount: 2 },
      },
      {
        type: 'VIRTUAL_CAMERA',
        occurredAt: '2026-10-05T10:00:00.000Z',
        payload: { deviceLabel: 'OBS Virtual Camera' },
      },
    ]);
    expect(body.capabilities.length).toBeLessThanOrEqual(32);
    expect(JSON.stringify(body)).not.toMatch(/sessionId|token/i);
  });
});
