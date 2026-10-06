import type { ClientProctorEvent } from '@codeproctor/shared';
import {
  IdbStore,
  ProctorSession,
  RecordingPipeline,
  createDefaultMonitors,
  type Detector,
} from '@codeproctor/proctor-sdk';
import { requestAt } from '@/features/candidate-flow/api';
import { getSessionToken } from '@/features/candidate-flow/session-store';
import { createAdrMediaApi, putChunk } from './media-api';
import { createProctorTransport } from './transport';
import { PROCTOR_PAUSE, proctorKeySchema, type HeartbeatState } from './wire';

/**
 * Wires the proctor SDK into the real test (ADR 0013; FR-601..FR-603, FR-609, FR-701, FR-702).
 * The SDK is consumed through its public exports only.
 *
 * What it does: fetches the HMAC key once (memory only, handed to the SDK, never stored or logged),
 * starts the SDK session with the fullscreen, visibility, clipboard, shortcut, devtools,
 * multi-screen, virtual-camera and screen-share monitors, runs the signed event queue and the 10 s
 * heartbeat, records screen, webcam and audio in 10 s chunks through the presign and confirm
 * routes, and turns the SDK's locks and the server's pause reasons into one UI state.
 *
 * What it does not do yet (docs/followups/frontend.md): keystroke batches (FR-608: the SDK has no
 * keystroke queue), the ML detectors (FR-606, FR-607: WebAssembly is not allowed by the CSP in this
 * document, and the model files are not served), key persistence and re-signing after an epoch
 * change (the SDK has no setKey hooks), and the side camera stream.
 */
export interface ProctorUiState {
  /** Nothing proctored has started yet. */
  phase: 'idle' | 'starting' | 'running' | 'ended';
  locks: { fullscreen: boolean; screenShare: boolean };
  /** Pause reasons the server reported on the last heartbeat. */
  pauseReasons: string[];
  /** False after a heartbeat failed (offline or the server is unreachable). */
  online: boolean;
  /** The candidate has shared their entire screen at least once. */
  shared: boolean;
  /** Why the test cannot go on: the session is over, or a new code is needed. */
  endedBecause: null | 'not-active' | 'reauth' | 'key';
  /** A blocked action to tell the candidate about (paste, drop, shortcut), cleared by the UI. */
  notice: null | { kind: 'paste' | 'drop' | 'copy' | 'shortcut' | 'right-click'; at: number };
  /** Devices that did not start (camera or microphone denied, recording not supported). */
  unavailable: string[];
}

/**
 * The SDK's own storage. When IndexedDB does not exist at all (some privacy modes), the SDK's
 * default store would throw a ReferenceError while starting; a factory that fails to open makes it
 * report the capability and buffer in memory instead (a reload then loses unsent batches).
 */
function safeIdbFactory(): IDBFactory {
  if (typeof indexedDB !== 'undefined') return indexedDB;
  return {
    open: () => {
      throw new Error('IndexedDB unavailable');
    },
  } as unknown as IDBFactory;
}

export const initialProctorState: ProctorUiState = {
  phase: 'idle',
  locks: { fullscreen: true, screenShare: true },
  pauseReasons: [],
  online: true,
  shared: false,
  endedBecause: null,
  notice: null,
  unavailable: [],
};

export interface ProctorControllerOptions {
  /** The server time of the consent signature: nothing starts without it (D-17). */
  consentRecordedAt: string;
  /** Names the session in the SDK's own storage. From the token's `sid` claim when there is one. */
  sessionId: string;
  root: HTMLElement;
  /** Heartbeat state with timing, so the app can re-sync its countdown from the server time. */
  onHeartbeat?: (state: HeartbeatState, timing: { startedAt: number; endedAt: number }) => void;
  /** Test seams: real code never passes these. */
  detectors?: Detector[];
}

type Listener = (state: ProctorUiState) => void;

export class ProctorController {
  private state: ProctorUiState = initialProctorState;
  private readonly listeners = new Set<Listener>();
  private readonly session = new ProctorSession();
  private readonly monitors = createDefaultMonitors();
  private pipeline: RecordingPipeline | null = null;
  private stopped = false;

  constructor(private readonly o: ProctorControllerOptions) {}

  getState = (): ProctorUiState => this.state;

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private set(patch: Partial<ProctorUiState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(this.state);
  }

  private end(because: NonNullable<ProctorUiState['endedBecause']>): void {
    if (this.state.endedBecause) return;
    this.set({ phase: 'ended', endedBecause: because });
    void this.stop();
  }

  /** Clears the "blocked action" notice once the UI has shown it. */
  clearNotice(): void {
    this.set({ notice: null });
  }

  /** Fetch the key, start the SDK session and the recording queue. No device is touched yet. */
  async init(): Promise<boolean> {
    this.set({ phase: 'starting' });
    const keyResult = await requestAt(proctorKeySchema, '/session/proctor-key', {
      method: 'POST',
      authed: true,
    });
    if (this.stopped) return false;
    if (!keyResult.ok) {
      // KEY_ALREADY_ISSUED: this epoch's key went out already (a reload). Only a new code, which
      // raises the epoch, gets a new key (ADR 0013 section 2).
      if (keyResult.kind === 'problem' && keyResult.status === 409) {
        this.end(keyResult.code === 'SESSION_NOT_ACTIVE' ? 'not-active' : 'key');
      } else if (keyResult.kind === 'problem' && keyResult.status === 401) {
        this.end('reauth');
      } else {
        this.end('key');
      }
      return false;
    }
    const transport = createProctorTransport({
      onState: (s, timing) => {
        this.set({ pauseReasons: s.pauseReasons, online: true });
        this.o.onHeartbeat?.(s, timing);
      },
      onNotActive: () => this.end('not-active'),
      onReauthRequired: () => this.end('reauth'),
    });
    const consent = { recordedAt: this.o.consentRecordedAt };
    const store = new IdbStore(safeIdbFactory());
    this.session.on('lock', (l) => {
      this.set({
        locks: {
          ...this.state.locks,
          [l.reason === 'FULLSCREEN' ? 'fullscreen' : 'screenShare']: l.locked,
        },
      });
    });
    this.session.on('connection', (c) => {
      // A failed heartbeat only means "offline" if the session is still alive.
      if (!this.state.endedBecause) this.set({ online: c.online });
    });
    this.session.on('capability', (f) => {
      if (f.status === 'DENIED' || f.status === 'UNSUPPORTED') {
        if (!this.state.unavailable.includes(f.id)) {
          this.set({ unavailable: [...this.state.unavailable, f.id] });
        }
      }
    });
    this.session.on('event', (e) => this.onEvent(e));
    try {
      await this.session.start({
        // The key goes straight into the SDK, which imports it as a non-extractable CryptoKey.
        sessionId: this.o.sessionId,
        hmacKeyBase64: keyResult.data.key,
        root: this.o.root,
        consent,
        transport,
        store,
        detectors: this.o.detectors ?? Object.values(this.monitors),
      });
    } catch {
      this.end('key');
      return false;
    }
    if (this.stopped) return false;
    this.pipeline = new RecordingPipeline({
      sessionId: this.o.sessionId,
      api: createAdrMediaApi(),
      store,
      assertConsent: () => {
        if (!consent.recordedAt) throw new Error('consent required');
      },
      put: putChunk,
      onCapability: (f) => {
        if (
          (f.status === 'DENIED' || f.status === 'UNSUPPORTED') &&
          !this.state.unavailable.includes(f.id)
        )
          this.set({ unavailable: [...this.state.unavailable, f.id] });
      },
    });
    await this.pipeline.start();
    this.set({ phase: 'running' });
    return true;
  }

  private onEvent(e: ClientProctorEvent): void {
    const kind = (
      {
        PASTE_ATTEMPT: 'paste',
        DROP_ATTEMPT: 'drop',
        COPY_ATTEMPT: 'copy',
        CUT_ATTEMPT: 'copy',
        SHORTCUT_BLOCKED: 'shortcut',
        RIGHT_CLICK: 'right-click',
      } as const
    )[e.type as 'PASTE_ATTEMPT'];
    if (kind) this.set({ notice: { kind, at: Date.now() } });
  }

  /** Needs a click. The whole screen must be shared (FR-604); anything else is refused. */
  async shareScreen(): Promise<{ ok: true } | { ok: false; reason: string }> {
    const outcome = await this.monitors.screenShare.request();
    if (!outcome.ok) return { ok: false, reason: outcome.reason };
    this.set({ shared: true });
    await this.pipeline?.recordScreen(outcome.stream);
    return { ok: true };
  }

  /** Needs a click. */
  enterFullscreen(): Promise<boolean> {
    return this.monitors.fullscreen.enter();
  }

  /** Webcam and microphone recording. Each may be denied: that is reported, never hidden. */
  async startRecorders(): Promise<void> {
    await this.pipeline?.recordWebcam();
    await this.pipeline?.recordAudio();
  }

  /** The test is over: flush what is queued, stop every device, purge the SDK's own storage. */
  async finish(): Promise<{ lostBatches: number }> {
    this.stopped = true;
    let lost = 0;
    try {
      lost = (await this.session.finish()).lostBatches;
      await this.pipeline?.finish();
    } catch {
      // stop below
    }
    await this.stopAll();
    this.set({ phase: 'ended' });
    return { lostBatches: lost };
  }

  /** Leaving the page without finishing: keep unsent data for a reload, stop the devices. */
  async stop(): Promise<void> {
    this.stopped = true;
    await this.session.stop().catch(() => undefined);
    await this.pipeline?.stop().catch(() => undefined);
    await this.stopAll();
  }

  private async stopAll(): Promise<void> {
    this.monitors.screenShare.stop();
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
  }

  hasPause(reason: string = PROCTOR_PAUSE): boolean {
    return this.state.pauseReasons.includes(reason);
  }
}

/** The session id the SDK names its storage with: the token's `sid` claim, else a random id. */
export function sessionIdFromToken(token: string | null = getSessionToken()): string {
  try {
    const payload = token?.split('.')[1];
    if (payload) {
      const json: unknown = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
      if (typeof json === 'object' && json !== null && 'sid' in json) {
        const sid = json.sid;
        if (typeof sid === 'string' && /^[0-9a-f-]{36}$/i.test(sid)) return sid.toLowerCase();
      }
    }
  } catch {
    // not a JWT (mock tokens): fall through
  }
  return crypto.randomUUID();
}
