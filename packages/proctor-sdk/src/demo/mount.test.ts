import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { mountProctorDemo } from './mount';

/**
 * Leaving the page (or HMR) while the permission prompt is open must not leave the camera or
 * microphone on (FR-701, D-17).
 */
class FakeMediaRecorder {
  static isTypeSupported(): boolean {
    return true;
  }
  state = 'inactive';
  ondataavailable: unknown = null;
  onstop: (() => void) | null = null;
  onerror: unknown = null;
  start(): void {
    this.state = 'recording';
  }
  stop(): void {
    this.state = 'inactive';
    this.onstop?.();
  }
}

function fakeStream() {
  const stop = vi.fn();
  const track = { stop, addEventListener: vi.fn(), getSettings: () => ({}) };
  const stream = {
    getTracks: () => [track],
    getVideoTracks: () => [track],
  } as unknown as MediaStream;
  return { stream, stop };
}

describe('mountProctorDemo stop() during an async start (FR-701, D-17)', () => {
  let getUserMedia: Mock<() => Promise<MediaStream>>;
  const fetchMock = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })));

  beforeEach(() => {
    getUserMedia = vi.fn<() => Promise<MediaStream>>();
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    vi.stubGlobal('fetch', fetchMock);
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia,
        enumerateDevices: () => Promise.resolve([]),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    fetchMock.mockClear();
  });

  const mount = () => {
    const el = document.createElement('div');
    document.body.append(el);
    const handle = mountProctorDemo(el, {
      apiBase: '/dev/proctor/api',
      modelBaseUrl: '/dev-proctor-models',
      hmacKeyBase64: btoa('demo-key-demo-key-demo-key-12345'),
      sessionId: 'stop-test',
    });
    return { el, handle };
  };

  it('FR-701: stop() while getUserMedia is pending releases the camera when it arrives and starts nothing else', async () => {
    const cam = fakeStream();
    let grantCamera!: (s: MediaStream) => void;
    const pending = new Promise<MediaStream>((r) => {
      grantCamera = r;
    });
    getUserMedia.mockImplementationOnce(() => pending);
    const { el, handle } = mount();
    el.querySelector<HTMLButtonElement>('[data-a=consent]')?.click();
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));
    await handle.stop(); // user leaves the page during the prompt
    grantCamera(cam.stream); // the browser answers afterwards
    await vi.waitFor(() => expect(cam.stop).toHaveBeenCalled());
    expect(getUserMedia).toHaveBeenCalledTimes(1); // no microphone request afterwards
    expect(fetchMock).not.toHaveBeenCalled(); // no session, so no heartbeat or batches
  });

  it('D-17: after stop() a second click on the consent button does nothing', async () => {
    const { el, handle } = mount();
    const button = el.querySelector<HTMLButtonElement>('[data-a=consent]');
    await handle.stop();
    button?.click(); // the page was torn down, but a stale handler must not start devices
    expect(getUserMedia).not.toHaveBeenCalled();
  });
});
