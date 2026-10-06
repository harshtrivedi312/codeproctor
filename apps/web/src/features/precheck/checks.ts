import type { MultiScreenResult } from '@codeproctor/proctor-sdk';
import { apiBaseUrl } from '@/lib/env';
import { mockingReady } from '@/lib/mock-ready';

/**
 * FR-402 system checks, behind one interface so the screen is testable and the SDK can take over a
 * check later. Today the SDK's public API offers the multi-screen and virtual-camera helpers
 * (`checkMultiScreen`, `checkVirtualCamera`); the other checks have no standalone SDK entry point
 * (the screen-share monitor needs a started session), so they are implemented here against the
 * browser APIs and listed in docs/followups/frontend.md.
 *
 * Nothing is recorded or uploaded by a check. Streams are opened only after the consent document
 * is signed (this step comes after it), and every stream is stopped when its check ends or the
 * step closes.
 */

export type CheckId =
  'browser' | 'camera' | 'microphone' | 'screen' | 'fullscreen' | 'network' | 'monitor';

export interface CheckOutcome {
  /** `warning` does not block (for example, a browser that cannot report the share type). */
  status: 'passed' | 'failed' | 'warning';
  message: string;
  /** Plain-language fix-it hint. Present on every failure. */
  help?: string;
}

export interface BrowserInfo {
  brand: 'Chrome' | 'Edge' | 'Firefox' | 'Safari' | 'Other';
  majorVersion: number;
  supported: boolean;
}

export type ScreenShareKind = 'MONITOR' | 'OTHER' | 'UNVERIFIABLE';

export interface MicHandle {
  stop: () => void;
}

export interface SystemChecker {
  browser(): BrowserInfo & CheckOutcome;
  camera(): Promise<CheckOutcome & { stream?: MediaStream; virtualCameraLabel?: string | null }>;
  microphone(onLevel: (level: number) => void): Promise<CheckOutcome & { handle?: MicHandle }>;
  screen(): Promise<CheckOutcome & { kind: ScreenShareKind }>;
  fullscreen(): Promise<CheckOutcome>;
  network(): Promise<CheckOutcome & { downlinkKbps: number; rttMs: number }>;
  monitor(): Promise<CheckOutcome & { result: MultiScreenResult }>;
}

/** Provisional advisory thresholds. The server's list of blocking reasons has no network item. */
export const MIN_DOWNLINK_KBPS = 1000;
export const MAX_RTT_MS = 1500;

interface UaBrand {
  brand: string;
  version: string;
}

export function detectBrowser(userAgent: string, brands: readonly UaBrand[] = []): BrowserInfo {
  const major = (re: RegExp): number => {
    const m = re.exec(userAgent);
    return m?.[1] ? Number.parseInt(m[1], 10) : 0;
  };
  const brandVersion = (name: string): number => {
    const found = brands.find((b) => b.brand === name);
    return found ? Number.parseInt(found.version, 10) || 0 : 0;
  };
  if (/\bEdg\/(\d+)/.test(userAgent) || brandVersion('Microsoft Edge') > 0) {
    return {
      brand: 'Edge',
      majorVersion: brandVersion('Microsoft Edge') || major(/\bEdg\/(\d+)/),
      supported: true,
    };
  }
  if (/\bFirefox\/(\d+)/.test(userAgent)) {
    return { brand: 'Firefox', majorVersion: major(/\bFirefox\/(\d+)/), supported: false };
  }
  if (/\bOPR\/|\bOpera\b|\bSamsungBrowser\b/.test(userAgent)) {
    return { brand: 'Other', majorVersion: 0, supported: false };
  }
  if (/\bChrome\/(\d+)/.test(userAgent) || brandVersion('Google Chrome') > 0) {
    return {
      brand: 'Chrome',
      majorVersion: brandVersion('Google Chrome') || major(/\bChrome\/(\d+)/),
      supported: true,
    };
  }
  if (/\bSafari\//.test(userAgent) && /\bVersion\/(\d+)/.test(userAgent)) {
    return { brand: 'Safari', majorVersion: major(/\bVersion\/(\d+)/), supported: false };
  }
  return { brand: 'Other', majorVersion: 0, supported: false };
}

interface NavigatorLike {
  userAgent: string;
  userAgentData?: { brands?: readonly UaBrand[] };
  mediaDevices?: Partial<
    Pick<MediaDevices, 'getUserMedia' | 'getDisplayMedia' | 'enumerateDevices'>
  >;
  connection?: { downlink?: number; rtt?: number };
}

export interface CheckerEnvironment {
  navigator: NavigatorLike;
  window: Window;
  document: Document;
  /** Network probe. Injected so tests need no real round trip. */
  ping?: () => Promise<number>;
}

function isDenied(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === 'NotAllowedError' || error.name === 'SecurityError')
  );
}
function isMissing(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === 'NotFoundError' || error.name === 'OverconstrainedError')
  );
}

function stopStream(stream: MediaStream | null | undefined): void {
  stream?.getTracks().forEach((t) => t.stop());
}

/**
 * The SDK has no per-feature entry point yet, so its root module is loaded on demand (own chunk)
 * and only by the two checks that use it, instead of weighing down the first page of the stepper.
 */
const loadSdk = () => import('@codeproctor/proctor-sdk');

async function defaultPing(): Promise<number> {
  await mockingReady;
  const started = performance.now();
  await fetch(`${apiBaseUrl}/v1/health`, {
    cache: 'no-store',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  });
  return Math.round(performance.now() - started);
}

export class BrowserSystemChecker implements SystemChecker {
  constructor(
    private readonly env: CheckerEnvironment = {
      navigator,
      window,
      document,
    },
  ) {}

  browser(): BrowserInfo & CheckOutcome {
    const info = detectBrowser(
      this.env.navigator.userAgent,
      this.env.navigator.userAgentData?.brands,
    );
    if (info.supported) {
      return {
        ...info,
        status: 'passed',
        message: `${info.brand} ${info.majorVersion} is supported.`,
      };
    }
    return {
      ...info,
      status: 'failed',
      message: `${info.brand === 'Other' ? 'This browser' : info.brand} is not supported for this test.`,
      help: 'Open the link from your invitation email in the latest Google Chrome or Microsoft Edge on a computer. Firefox, Safari and phone browsers cannot be used.',
    };
  }

  async camera(): Promise<
    CheckOutcome & { stream?: MediaStream; virtualCameraLabel?: string | null }
  > {
    const media = this.env.navigator.mediaDevices;
    if (!media?.getUserMedia) {
      return {
        status: 'failed',
        message: 'This browser cannot use a camera.',
        help: 'Use the latest Chrome or Edge on a computer with a webcam.',
      };
    }
    try {
      const stream = await media.getUserMedia({ video: true, audio: false });
      let virtualCameraLabel: string | null = null;
      try {
        const { checkVirtualCamera } = await loadSdk();
        const vc = await checkVirtualCamera(media as Pick<MediaDevices, 'enumerateDevices'>);
        if (vc.kind === 'VIRTUAL') virtualCameraLabel = vc.label;
      } catch {
        // Device names are only evidence; failing to read them never fails the camera check.
      }
      return { status: 'passed', message: 'Your camera works.', stream, virtualCameraLabel };
    } catch (error) {
      if (isDenied(error)) {
        return {
          status: 'failed',
          message: 'Camera access was blocked.',
          help: 'Click the camera or lock icon in the address bar, set Camera to "Allow", then try again. If your computer blocks the camera, check its privacy settings.',
        };
      }
      return {
        status: 'failed',
        message: isMissing(error) ? 'No camera was found.' : 'The camera could not start.',
        help: 'Plug in or turn on your webcam and close other apps that use it (video calls, for example), then try again.',
      };
    }
  }

  async microphone(
    onLevel: (level: number) => void,
  ): Promise<CheckOutcome & { handle?: MicHandle }> {
    const media = this.env.navigator.mediaDevices;
    if (!media?.getUserMedia) {
      return {
        status: 'failed',
        message: 'This browser cannot use a microphone.',
        help: 'Use the latest Chrome or Edge on a computer with a microphone.',
      };
    }
    let stream: MediaStream;
    try {
      stream = await media.getUserMedia({ audio: true, video: false });
    } catch (error) {
      if (isDenied(error)) {
        return {
          status: 'failed',
          message: 'Microphone access was blocked.',
          help: 'Click the lock icon in the address bar, set Microphone to "Allow", then try again.',
        };
      }
      return {
        status: 'failed',
        message: isMissing(error) ? 'No microphone was found.' : 'The microphone could not start.',
        help: 'Plug in or unmute your microphone and close other apps that use it, then try again.',
      };
    }
    const win = this.env.window as Window & { AudioContext?: typeof AudioContext };
    let timer: ReturnType<typeof setInterval> | null = null;
    let context: AudioContext | null = null;
    if (typeof win.AudioContext === 'function') {
      try {
        context = new win.AudioContext();
        const analyser = context.createAnalyser();
        analyser.fftSize = 512;
        context.createMediaStreamSource(stream).connect(analyser);
        const data = new Uint8Array(analyser.fftSize);
        timer = setInterval(() => {
          analyser.getByteTimeDomainData(data);
          let peak = 0;
          for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
          onLevel(Math.min(100, Math.round((peak / 128) * 100 * 2)));
        }, 100);
      } catch {
        // No level meter: the microphone itself still works.
      }
    }
    return {
      status: 'passed',
      message: 'Your microphone works.',
      handle: {
        stop: () => {
          if (timer) clearInterval(timer);
          void context?.close().catch(() => undefined);
          stopStream(stream);
        },
      },
    };
  }

  async screen(): Promise<CheckOutcome & { kind: ScreenShareKind }> {
    const media = this.env.navigator.mediaDevices;
    if (!media?.getDisplayMedia) {
      return {
        kind: 'OTHER',
        status: 'failed',
        message: 'This browser cannot share your screen.',
        help: 'Use the latest Chrome or Edge on a computer. Phones and tablets cannot take this test.',
      };
    }
    let stream: MediaStream | null = null;
    try {
      stream = await media.getDisplayMedia({
        video: { displaySurface: 'monitor' } as MediaTrackConstraints,
        audio: false,
      });
      const surface = stream.getVideoTracks()[0]?.getSettings().displaySurface;
      if (surface === 'monitor') {
        return { kind: 'MONITOR', status: 'passed', message: 'Sharing your entire screen works.' };
      }
      if (surface === undefined) {
        return {
          kind: 'UNVERIFIABLE',
          status: 'warning',
          message: 'Screen sharing works, but this browser cannot tell us which part you shared.',
          help: 'During the test, choose "Entire screen" when asked.',
        };
      }
      return {
        kind: 'OTHER',
        status: 'failed',
        message: 'You shared a window or a tab, not your entire screen.',
        help: 'Try again and, in the sharing window, choose the "Entire Screen" tab and pick your screen. A window or a browser tab is not enough.',
      };
    } catch (error) {
      return {
        kind: 'OTHER',
        status: 'failed',
        message: isDenied(error)
          ? 'Screen sharing was cancelled or blocked.'
          : 'Screen sharing could not start.',
        help: 'Try again, choose "Entire Screen" and press "Share". On a Mac, also allow your browser under System Settings, Privacy and Security, Screen Recording, then restart the browser.',
      };
    } finally {
      stopStream(stream);
    }
  }

  async fullscreen(): Promise<CheckOutcome> {
    const doc = this.env.document;
    const root = doc.documentElement;
    if (!doc.fullscreenEnabled || typeof root.requestFullscreen !== 'function') {
      return {
        status: 'failed',
        message: 'Full-screen mode is not available.',
        help: 'Use the latest Chrome or Edge and make sure full screen is not blocked by your organisation or an extension.',
      };
    }
    try {
      await root.requestFullscreen();
      await doc.exitFullscreen();
      return { status: 'passed', message: 'Full-screen mode works.' };
    } catch {
      return {
        status: 'failed',
        message: 'Full-screen mode was blocked.',
        help: 'Try again and allow full screen if your browser asks. Close other windows that may take over the screen.',
      };
    }
  }

  async network(): Promise<CheckOutcome & { downlinkKbps: number; rttMs: number }> {
    const conn = this.env.navigator.connection;
    let rttMs: number;
    try {
      rttMs = await (this.env.ping ?? defaultPing)();
    } catch {
      return {
        downlinkKbps: 0,
        rttMs: 0,
        status: 'failed',
        message: 'We could not reach the test service.',
        help: 'Check your internet connection (try another website), turn off a VPN if you use one, then try again.',
      };
    }
    const downlinkKbps = Math.round((conn?.downlink ?? 0) * 1000);
    const slow = (downlinkKbps > 0 && downlinkKbps < MIN_DOWNLINK_KBPS) || rttMs > MAX_RTT_MS;
    return slow
      ? {
          downlinkKbps,
          rttMs,
          status: 'warning',
          message: 'Your connection looks slow.',
          help: 'You can continue, but a slow connection may interrupt the recording. Move closer to your router, use a cable if you can, and close apps that use the internet.',
        }
      : { downlinkKbps, rttMs, status: 'passed', message: 'Your connection is fast enough.' };
  }

  async monitor(): Promise<CheckOutcome & { result: MultiScreenResult }> {
    const { checkMultiScreen } = await loadSdk();
    const result = await checkMultiScreen(
      this.env.window as unknown as Parameters<typeof checkMultiScreen>[0],
    );
    switch (result.kind) {
      case 'SINGLE':
        return { result, status: 'passed', message: 'One screen found.' };
      case 'MULTI':
        return {
          result,
          status: 'failed',
          message: 'More than one screen is connected.',
          help: 'Unplug or turn off extra monitors (or set the display to "Show only on 1"), then try again. Only one screen may be used during the test.',
        };
      default:
        return {
          result,
          status: 'warning',
          message: 'We could not check how many screens you use.',
          help: 'Please make sure only one screen is connected during the test. A reviewer may check.',
        };
    }
  }
}
