import { IdbStore, type StoreName } from '@codeproctor/proctor-sdk';
import { vi } from 'vitest';
import { candidateApi } from '@/features/candidate-flow/api';
import { setSessionToken } from '@/features/candidate-flow/session-store';
import { MOCK_OTP, MOCK_TOKENS, getMockSession } from '@/mocks/candidate/handlers';

/** Shared fakes for the proctoring tests: jsdom has no fullscreen, display capture or recorder. */

/** A fake MediaStream whose tracks can be ended, with a count of stops. */
export function fakeStream(settings: Record<string, unknown> = {}) {
  const stops = vi.fn();
  const listeners: (() => void)[] = [];
  const track = {
    stop: stops,
    getSettings: () => settings,
    applyConstraints: () => Promise.resolve(),
    addEventListener: (type: string, fn: () => void) => {
      if (type === 'ended') listeners.push(fn);
    },
  };
  const stream = {
    getTracks: () => [track],
    getVideoTracks: () => [track],
    getAudioTracks: () => [],
  } as unknown as MediaStream;
  return { stream, stops, end: () => listeners.forEach((fn) => fn()) };
}

export class FakeRecorder {
  static instances: FakeRecorder[] = [];
  static isTypeSupported = (): boolean => true;
  state = 'inactive';
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    FakeRecorder.instances.push(this);
  }
  start(): void {
    this.state = 'recording';
  }
  emit(): void {
    this.ondataavailable?.({ data: new Blob(['chunk-bytes']) });
  }
  stop(): void {
    this.state = 'inactive';
    this.emit();
    this.onstop?.();
  }
}

export interface Devices {
  display: ReturnType<typeof fakeStream>;
  getDisplayMedia: ReturnType<typeof vi.fn>;
  getUserMedia: ReturnType<typeof vi.fn>;
  recorders: FakeRecorder[];
  /** Streams handed out by getUserMedia, in order. */
  userStreams: ReturnType<typeof fakeStream>[];
}

export function setupDevices(
  options: {
    deny?: 'camera' | 'all';
    /** Resolve the display and user media only when the test says so (late grants). */
    deferred?: boolean;
  } = {},
): Devices & { grantDisplay: () => void; grantUser: () => void } {
  const display = fakeStream({ displaySurface: 'monitor' });
  const userStreams: ReturnType<typeof fakeStream>[] = [];
  let grantDisplay: () => void = () => undefined;
  let grantUser: () => void = () => undefined;
  const getDisplayMedia = vi.fn(() =>
    options.deferred
      ? new Promise<MediaStream>((resolve) => {
          grantDisplay = () => resolve(display.stream);
        })
      : Promise.resolve(display.stream),
  );
  const getUserMedia = vi.fn(() => {
    if (options.deny) return Promise.reject(new DOMException('no', 'NotAllowedError'));
    const s = fakeStream();
    userStreams.push(s);
    return options.deferred
      ? new Promise<MediaStream>((resolve) => {
          grantUser = () => resolve(s.stream);
        })
      : Promise.resolve(s.stream);
  });
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getDisplayMedia, getUserMedia, enumerateDevices: () => Promise.resolve([]) },
  });
  FakeRecorder.instances = [];
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  return {
    display,
    getDisplayMedia,
    getUserMedia,
    recorders: FakeRecorder.instances,
    userStreams,
    grantDisplay: () => grantDisplay(),
    grantUser: () => grantUser(),
  };
}

let fullscreenElement: Element | null = null;
export function setFullscreen(on: boolean): void {
  fullscreenElement = on ? document.documentElement : null;
  document.dispatchEvent(new Event('fullscreenchange'));
}

/** A fullscreen API that works like a browser's: entering and leaving fire fullscreenchange. */
export function installFullscreen(): void {
  fullscreenElement = null;
  Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: true });
  Object.defineProperty(document, 'fullscreenElement', {
    configurable: true,
    get: () => fullscreenElement,
  });
  Object.defineProperty(document, 'exitFullscreen', {
    configurable: true,
    value: vi.fn(() => {
      setFullscreen(false);
      return Promise.resolve();
    }),
  });
  Object.defineProperty(document.documentElement, 'requestFullscreen', {
    configurable: true,
    value: vi.fn(() => {
      setFullscreen(true);
      return Promise.resolve();
    }),
  });
}

export async function startedSession(token: string = MOCK_TOKENS.consented): Promise<object> {
  const r = await candidateApi.startSession(token, MOCK_OTP);
  if (!r.ok) throw new Error('mock sign-in failed');
  setSessionToken(r.data.sessionToken);
  if (token !== MOCK_TOKENS.resume) {
    const started = await candidateApi.startTest();
    if (!started.ok) throw new Error('mock start failed');
  }
  const session = getMockSession(r.data.sessionToken);
  if (!session) throw new Error('no mock session');
  return session;
}

/**
 * The SDK's IndexedDB store, in memory, so tests can look at what the SDK keeps and what a purge
 * removes (jsdom has no IndexedDB, and the SDK's fake-indexeddb is not a dependency of the app).
 */
export class MemoryStore extends IdbStore {
  readonly data = new Map<string, unknown>();
  constructor() {
    super({
      open: () => {
        throw new Error('not used');
      },
    } as unknown as IDBFactory);
  }
  private k(name: StoreName, key: string): string {
    return `${name}\u0000${key}`;
  }
  override put<T>(name: StoreName, key: string, value: T): Promise<void> {
    this.data.set(this.k(name, key), structuredClone(value));
    return Promise.resolve();
  }
  override get<T>(name: StoreName, key: string): Promise<T | undefined> {
    return Promise.resolve(this.data.get(this.k(name, key)) as T | undefined);
  }
  override delete(name: StoreName, key: string): Promise<void> {
    this.data.delete(this.k(name, key));
    return Promise.resolve();
  }
  override entries<T>(name: StoreName, prefix: string): Promise<{ key: string; value: T }[]> {
    const start = this.k(name, prefix);
    return Promise.resolve(
      [...this.data.entries()]
        .filter(([k]) => k.startsWith(start))
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, value]) => ({ key: k.slice(name.length + 1), value: value as T })),
    );
  }
  override deletePrefix(name: StoreName, prefix: string): Promise<number> {
    const start = this.k(name, prefix);
    let n = 0;
    for (const k of [...this.data.keys()]) {
      if (k.startsWith(start)) {
        this.data.delete(k);
        n += 1;
      }
    }
    return Promise.resolve(n);
  }
  override keys(name: StoreName, prefix: string): Promise<string[]> {
    return this.entries(name, prefix).then((es) => es.map((e) => e.key));
  }
  override close(): Promise<void> {
    return Promise.resolve();
  }
  /** Entries in one SDK store (eventBatches, chunks, meta). */
  count(name: StoreName): number {
    return [...this.data.keys()].filter((k) => k.startsWith(`${name}\u0000`)).length;
  }
}
