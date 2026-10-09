import type { ClientProctorEvent, ProctorDetector } from '@codeproctor/shared';
import {
  IdbStore,
  ProctorSession,
  type KeystrokeRecorder,
  RecordingPipeline,
  STORES,
  createDefaultMonitors,
  type Detector,
} from '@codeproctor/proctor-sdk';
import { requestAt } from '@/features/candidate-flow/api';
import { getSessionToken } from '@/features/candidate-flow/session-store';
import { mockingEnabled } from '@/lib/env';
import { createAdrMediaApi, putChunk, type MediaProgress } from './media-api';
import { withRetry } from './retry';
import { createProctorTransport, type HeartbeatHealth } from './transport';
import { PROCTOR_PAUSE, proctorKeySchema, type HeartbeatState, type ProctorKey } from './wire';

/**
 * Wires the proctor SDK into the real test (ADR 0013; FR-601..FR-603, FR-609, FR-701, FR-702).
 * The SDK is consumed through its public exports only.
 *
 * What it does: fetches the HMAC key once (memory only, handed to the SDK, never stored or logged),
 * seeds the event and media counters from the key response (max of local and server, ADR 0013
 * section 2), starts the SDK session with the fullscreen, visibility, clipboard, shortcut,
 * devtools, multi-screen, virtual-camera and screen-share monitors, runs the signed event queue
 * and the 10 s heartbeat (with recorder and queue health), records screen, webcam and audio in
 * 10 s chunks through the presign and confirm routes, and turns the SDK's locks and the server's
 * pause reasons into one UI state.
 *
 * When the session is over (409 SESSION_NOT_ACTIVE) or taken over (401 SESSION_TAKEN_OVER) it
 * purges the signed batches and the recording chunks from the browser and releases every device
 * (ADR 0013 section 2, Purge). Other endings keep the outbox for the next page load.
 *
 * Keystroke batches (FR-608) go through the same session: `keystrokes()` is the recorder the answer
 * editor feeds. Not done yet (docs/followups/frontend.md): the ML detectors (FR-606, FR-607: WebAssembly is not allowed by the CSP in this
 * document; they are reported as unavailable, not silently absent), key persistence and re-signing
 * after an epoch change (the SDK has no setKey hooks), and the side camera stream.
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
  /**
   * The server said "not active" while the candidate's own last-section submit was under way: the
   * session is submitted. Nothing was purged or ended; the test screen moves to its submitted page,
   * which then calls finish().
   */
  serverClosed: boolean;
  /** A blocked action to tell the candidate about (paste, drop, shortcut), cleared by the UI. */
  notice: null | { kind: NoticeKind; at: number };
  /** Recording that did not start (camera or microphone denied, recording not supported). */
  unavailable: string[];
}

export type NoticeKind = 'paste' | 'drop' | 'copy' | 'shortcut' | 'right-click';

export const initialProctorState: ProctorUiState = {
  phase: 'idle',
  locks: { fullscreen: true, screenShare: true },
  pauseReasons: [],
  online: true,
  shared: false,
  endedBecause: null,
  serverClosed: false,
  notice: null,
  unavailable: [],
};

/** The SDK's own counter backup in localStorage (a batch number, no candidate data). */
const SEQ_BACKUP_PREFIXES = ['codeproctor:eventseq:', 'codeproctor:keystrokeseq:'] as const;

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

/** Wire seq = segment * 100000 + seq (media-api.ts), so a segment must also clear nextSeq. */
const WIRE_SEQ_PER_SEGMENT = 100_000;
const MEDIA_STREAMS = ['SCREEN', 'WEBCAM', 'AUDIO'] as const;

/**
 * Continues the counters where the server says they are (ADR 0013 section 2): the larger of the
 * local value and the server's, written through the SDK's own store before the SDK reads it. A
 * failure to write leaves the SDK on its own (safe) defaults.
 */
export async function seedCounters(
  store: IdbStore,
  sessionId: string,
  counters: ProctorKey['counters'],
): Promise<void> {
  if (!counters) return;
  try {
    if (counters.eventSeqStart !== undefined) {
      const key = `${sessionId}:nextEventSeq`;
      const local = (await store.get<number>(STORES.meta, key)) ?? 0;
      await store.put(STORES.meta, key, Math.max(local, counters.eventSeqStart));
    }
    if (counters.keystrokeSeqStart !== undefined) {
      // The keystroke stream has its own sequence (FR-608): without this a resume on another device
      // restarts at 0 and the server answers SEQ_CONFLICT for the first batches, RESET included.
      const key = `${sessionId}:nextKeystrokeSeq`;
      const local = (await store.get<number>(STORES.meta, key)) ?? 0;
      await store.put(STORES.meta, key, Math.max(local, counters.keystrokeSeqStart));
    }
    for (const stream of MEDIA_STREAMS) {
      const c = counters.media?.[stream];
      if (!c) continue;
      const nextSegment = Math.max(c.nextSegment, Math.ceil(c.nextSeq / WIRE_SEQ_PER_SEGMENT));
      const key = `${sessionId}:segment:${stream}`;
      const local = (await store.get<number>(STORES.meta, key)) ?? -1;
      // The SDK stores the last segment used and starts the next one after it.
      await store.put(STORES.meta, key, Math.max(local, nextSegment - 1));
    }
  } catch {
    // no storage: the SDK reports it and uses its own floor
  }
}

/**
 * Deletes this session's signed batches and recording chunks from the browser. It needs no key and
 * no running session, so it also works when the very first call said the session is over (ADR 0013
 * section 2, Purge). The batch counter stays (a small integer, no candidate data); the SDK's own
 * localStorage copy of it is removed separately.
 */
export async function purgeStore(store: IdbStore, sessionId: string): Promise<void> {
  await Promise.allSettled([
    store.deletePrefix(STORES.eventBatches, `${sessionId}:`),
    store.deletePrefix(STORES.chunks, `${sessionId}:`),
    store.deletePrefix(STORES.meta, `${sessionId}:segment:`),
  ]);
}

/**
 * A detector that is not started in this build still says so (ADR 0005): DETECTOR_UNAVAILABLE and
 * a capability flag, so a reviewer can tell "off" from "no findings".
 */
class NotStartedDetector implements Detector {
  constructor(
    readonly id: string,
    readonly accommodationId: ProctorDetector,
  ) {}
  start(ctx: Parameters<Detector['start']>[0]): void {
    ctx.emit('DETECTOR_UNAVAILABLE', { detector: this.accommodationId, reason: 'UNSUPPORTED' });
    ctx.setCapability({
      id: this.id,
      status: 'UNSUPPORTED',
      detail: 'The in-browser detector is not started in this build.',
    });
  }
  stop(): void {
    // nothing to stop
  }
}

function notStartedDetectors(): Detector[] {
  return [
    new NotStartedDetector('face', 'FACE'),
    new NotStartedDetector('gaze', 'GAZE'),
    new NotStartedDetector('object', 'OBJECT'),
    new NotStartedDetector('voice', 'VOICE'),
  ];
}

function noticeKind(type: string): NoticeKind | null {
  switch (type) {
    case 'PASTE_ATTEMPT':
      return 'paste';
    case 'DROP_ATTEMPT':
      return 'drop';
    case 'COPY_ATTEMPT':
    case 'CUT_ATTEMPT':
      return 'copy';
    case 'SHORTCUT_BLOCKED':
      return 'shortcut';
    case 'RIGHT_CLICK':
      return 'right-click';
    default:
      return null;
  }
}

export interface ProctorControllerOptions {
  /** The server time of the consent signature: nothing starts without it (D-17). */
  consentRecordedAt: string;
  /** Names the session in the SDK's own storage. From the token's `sid` claim when there is one. */
  sessionId: string;
  root: HTMLElement;
  /** Heartbeat state with timing, so the app can re-sync its countdown from the server time. */
  onHeartbeat?: (state: HeartbeatState, timing: { startedAt: number; endedAt: number }) => void;
  /** Test seams: real code never passes these. */
  store?: IdbStore;
  detectors?: Detector[];
  heartbeatIntervalMs?: number;
  flushIntervalMs?: number;
  /** How long to wait for queued events and chunks when the test ends (SDK default 15 s). */
  finishDrainMs?: number;
  retrySleep?: (ms: number) => Promise<void>;
  /** Per attempt on the one-shot key call (default 15 s). */
  keyTimeoutMs?: number;
}

type Listener = (state: ProctorUiState) => void;

export class ProctorController {
  private state: ProctorUiState = initialProctorState;
  private readonly listeners = new Set<Listener>();
  private readonly session = new ProctorSession();
  private readonly monitors = createDefaultMonitors();
  private pipeline: RecordingPipeline | null = null;
  private initPromise: Promise<boolean> | null = null;
  private store: IdbStore | null = null;
  private readonly mediaProgress: MediaProgress = {};
  /** Set when the data is being purged: nothing more may be sent or written. */
  private purging = false;
  /** Set once finish() has drained and purged: a device that answers after this is dropped at once. */
  private drained = false;
  /** The running finish(), so a late device answer can wait for the real final chunks to go. */
  private finishPromise: Promise<{ lostBatches: number }> | null = null;
  /** Set while a device granted after the end is dropped: its last chunk must not be uploaded. */
  private dropping = false;
  private stopped = false;
  private finishing = false;
  /** The candidate's own last-section finish is in flight or accepted: "not active" is the normal end. */
  private submitting = false;
  /** A "not active" met while submitting; acted on as soon as the submit settles without a submit. */
  private notActiveWhileSubmitting = false;
  private torn = false;

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

  /**
   * The SDK's keystroke recorder for the answer editor (FR-608, TC-062): null until the proctor
   * session has started, and null when the transport cannot send keystroke batches. It is closed by
   * the session on stop() and finish(), so nothing is recorded after the test ends (FR-702).
   */
  keystrokes(): KeystrokeRecorder | null {
    return this.session.keystrokes;
  }

  /** Clears the "blocked action" notice once the UI has shown it. */
  clearNotice(): void {
    this.set({ notice: null });
  }

  /**
   * Called by the test screen around the candidate's own last-section finish (on before the request,
   * off again if the finish did not go through, or when another section opens). While it is on, the
   * server's "not active" (the session is SUBMITTED once the close lands) is the normal end of the
   * candidate's own submit, not a reason to purge and show "no longer running": it is remembered
   * (state.serverClosed) and the test screen moves to its submitted page, which calls finish().
   * Turning it off acts on a remembered "not active" at once, so a real time-out or proctor end
   * is never swallowed for good.
   */
  setSubmitting(on: boolean): void {
    this.submitting = on;
    if (!on && this.notActiveWhileSubmitting) {
      this.notActiveWhileSubmitting = false;
      // end() only acts if the test is still running. If finish() already started (the submitted
      // page is up) the page must not be withdrawn, so serverClosed stays as it is.
      if (this.finishing || this.stopped || this.state.endedBecause) return;
      this.set({ serverClosed: false });
      this.end('not-active', true);
    }
  }

  private end(because: NonNullable<ProctorUiState['endedBecause']>, purge: boolean): void {
    // While finishing (or already stopped) the server's "not active" is the normal end.
    if (this.state.endedBecause || this.stopped || this.finishing) return;
    // The same holds from the moment the candidate submits their last section: remember it.
    if (this.submitting && because === 'not-active') {
      this.notActiveWhileSubmitting = true;
      this.set({ serverClosed: true });
      return;
    }
    this.set({ phase: 'ended', endedBecause: because });
    void this.teardown({ purge });
  }

  /** Fetch the key, seed the counters, start the SDK session and the recording queue. */
  init(): Promise<boolean> {
    this.initPromise ??= this.runInit();
    return this.initPromise;
  }

  private async runInit(): Promise<boolean> {
    this.set({ phase: 'starting' });
    // The store exists before the first call, so even a session that is over on arrival can purge.
    const store = this.o.store ?? new IdbStore(safeIdbFactory());
    this.store = store;
    const keyResult = await withRetry(
      () =>
        requestAt(proctorKeySchema, '/session/proctor-key', {
          method: 'POST',
          authed: true,
          signal: AbortSignal.timeout(this.o.keyTimeoutMs ?? 15_000),
        }),
      this.o.retrySleep ? { sleep: this.o.retrySleep } : {},
    );
    if (this.stopped) return false;
    if (!keyResult.ok) {
      // KEY_ALREADY_ISSUED: this epoch's key went out already (a reload). Only a new code, which
      // raises the epoch, gets a new key (ADR 0013 section 2).
      if (keyResult.kind === 'problem' && keyResult.status === 409) {
        // Over: purge what an earlier page load left (no key is needed to delete).
        const over = keyResult.code === 'SESSION_NOT_ACTIVE';
        this.end(over ? 'not-active' : 'key', over);
      } else if (keyResult.kind === 'problem' && keyResult.status === 401) {
        this.end('reauth', keyResult.code === 'SESSION_TAKEN_OVER');
      } else {
        this.end('key', false);
      }
      return false;
    }
    await seedCounters(store, this.o.sessionId, keyResult.data.counters);
    // The heartbeat reports where each stream continues from, before anything is uploaded.
    for (const stream of MEDIA_STREAMS) {
      const c = keyResult.data.counters?.media?.[stream];
      if (c && c.nextSeq > 0) {
        this.mediaProgress[stream] = {
          segment: Math.max(0, c.nextSegment - 1),
          lastSeq: c.nextSeq - 1,
        };
      }
    }
    if (this.stopped) return false;

    const transport = createProctorTransport({
      onState: (s, timing) => {
        this.set({ pauseReasons: s.pauseReasons, online: true });
        this.o.onHeartbeat?.(s, timing);
      },
      onNotActive: () => this.end('not-active', true),
      onReauthRequired: (reason) => this.end('reauth', reason === 'SESSION_TAKEN_OVER'),
      getHealth: () => this.health(),
      isPurged: () => this.purging,
    });
    const consent = { recordedAt: this.o.consentRecordedAt };
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
      // (Also not while a submit is under way: a "not active" heartbeat is not "offline".)
      if (!this.state.endedBecause && !this.notActiveWhileSubmitting)
        this.set({ online: c.online });
    });
    this.session.on('capability', (f) => this.noteCapability(f.id, f.status));
    this.session.on('event', (e) => this.onEvent(e));
    try {
      await this.session.start({
        // The key goes straight into the SDK, which imports it as a CryptoKey.
        sessionId: this.o.sessionId,
        hmacKeyBase64: keyResult.data.key,
        root: this.o.root,
        consent,
        transport,
        store,
        ...(this.o.heartbeatIntervalMs ? { heartbeatIntervalMs: this.o.heartbeatIntervalMs } : {}),
        ...(this.o.flushIntervalMs ? { flushIntervalMs: this.o.flushIntervalMs } : {}),
        detectors: this.o.detectors ?? [...Object.values(this.monitors), ...notStartedDetectors()],
      });
    } catch {
      this.end('key', false);
      return false;
    }
    // Stopped while starting: teardown() waits for this function, then stops what just started.
    if (this.stopped) return false;
    this.pipeline = new RecordingPipeline({
      sessionId: this.o.sessionId,
      api: createAdrMediaApi(this.mediaProgress, () => this.purging || this.dropping),
      store,
      assertConsent: () => {
        if (!consent.recordedAt) throw new Error('consent required');
      },
      put: putChunk,
      onCapability: (f) => this.noteCapability(f.id, f.status),
    });
    try {
      await this.pipeline.start();
    } catch {
      // The recording queue could not start: the test goes on and says recording is unavailable.
      this.noteCapability('recording-storage', 'UNSUPPORTED');
      this.pipeline = null;
    }
    if (this.stopped) return false;
    this.set({ phase: 'running' });
    return true;
  }

  /** Only recording problems reach the candidate; detector flags are for the reviewer. */
  private noteCapability(id: string, status: string): void {
    if (status !== 'DENIED' && status !== 'UNSUPPORTED') return;
    if (!id.startsWith('record')) return;
    if (!this.state.unavailable.includes(id))
      this.set({ unavailable: [...this.state.unavailable, id] });
  }

  private health(): HeartbeatHealth {
    const rec = this.pipeline?.health();
    const queue = this.session.getQueueStats();
    const ks = this.session.getKeystrokeStats();
    return {
      ...(rec
        ? {
            recorder: {
              streams: MEDIA_STREAMS.map((stream) => ({
                stream,
                segment: this.mediaProgress[stream]?.segment ?? 0,
                lastSeq: this.mediaProgress[stream]?.lastSeq ?? -1,
                bufferedBytes: rec.bytesPendingByStream[stream],
              })),
              bufferedChunks: rec.chunksPending,
              droppedChunks: rec.droppedChunks,
              droppedBytes: rec.droppedBytes,
            },
          }
        : {}),
      ...(queue
        ? {
            queue: {
              pendingEventBatches: queue.unsentBatches,
              pendingKeystrokeBatches: ks?.unsentBatches ?? 0,
              // Batches the server refused or the SDK could not send, events and keystrokes: a
              // sequence gap shows the hole, this says how many were dropped (FR-608, ADR 0013 5.8).
              rejectedBatches: queue.rejectedBatches + (ks?.rejectedBatches ?? 0),
            },
          }
        : {}),
    };
  }

  private onEvent(e: ClientProctorEvent): void {
    const kind = noticeKind(e.type);
    if (kind) this.set({ notice: { kind, at: Date.now() } });
  }

  /** Needs a click. The whole screen must be shared (FR-604); anything else is refused. */
  async shareScreen(): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (this.stopped) return { ok: false, reason: 'STOPPED' };
    const outcome = await this.monitors.screenShare.request();
    if (this.stopped) {
      // Granted after the test ended: switch it straight off.
      if (outcome.ok) outcome.stream.getTracks().forEach((t) => t.stop());
      this.monitors.screenShare.stop();
      return { ok: false, reason: 'STOPPED' };
    }
    if (!outcome.ok) return { ok: false, reason: outcome.reason };
    this.set({ shared: true });
    const recording = await this.pipeline?.recordScreen(outcome.stream);
    if (this.stopped && recording) await this.dropLate('SCREEN');
    return { ok: true };
  }

  /** Needs a click. */
  async enterFullscreen(): Promise<boolean> {
    if (this.stopped) return false;
    const ok = await this.monitors.fullscreen.enter();
    if (this.stopped && ok && document.fullscreenElement) {
      await document.exitFullscreen().catch(() => undefined);
      return false;
    }
    return ok;
  }

  /** Webcam and microphone recording. Each may be denied: that is reported, never hidden. */
  async startRecorders(): Promise<void> {
    if (this.stopped || !this.pipeline) return;
    const webcam = await this.pipeline.recordWebcam();
    if (this.stopped) {
      // Only a stream that was really granted started a recorder; a denied device left nothing.
      if (webcam) {
        webcam.getTracks().forEach((t) => t.stop());
        await this.dropLate('WEBCAM');
      }
      return;
    }
    const audio = await this.pipeline.recordAudio();
    if (this.stopped && audio) {
      audio.getTracks().forEach((t) => t.stop());
      await this.dropLate('AUDIO');
    }
  }

  /**
   * A device was granted after the test ended, and the SDK has already started a recorder (and
   * its upload queue and segment counter) for it. Stopping the recorder flushes a last chunk into
   * the SDK's storage. When the data is being purged or the test finished, that would leave a clip
   * on disk after the purge, so finish the pipeline with no drain and purge the store again. When
   * the page is only being left, an older SDK keeps that chunk for the next load; a newer one
   * (SDK #366) refuses devices once it is closing and never starts the recorder. Either is fine:
   * nothing here depends on a late recorder after stop().
   */
  private async dropLate(stream: (typeof MEDIA_STREAMS)[number]): Promise<void> {
    if (!this.pipeline) return;
    if (this.purging || this.drained) {
      // The data is deleted (or being deleted): nothing this late recorder wrote may stay or be sent.
      await this.discardLate();
      return;
    }
    // Finishing normally, or only leaving the page: stop the recorder (if the SDK started one) so
    // its last chunk is flushed.
    await this.pipeline.stopStream(stream).catch(() => undefined);
    if (this.finishing) {
      // That chunk joins the real drain of the final evidence (the screen, webcam and audio chunks
      // of a normal submit are still being uploaded within the ingest grace). Wait for the finish
      // to end, and only then remove anything the late recorder wrote after the queue was purged.
      await this.finishPromise?.catch(() => undefined);
      await this.discardLate();
    }
  }

  /** Finish the pipeline with no drain and purge the store: nothing is left on disk or sent. */
  private async discardLate(): Promise<void> {
    if (!this.pipeline) return;
    this.dropping = true;
    await this.pipeline.finish({ drainTimeoutMs: 0 }).catch(() => undefined);
    if (this.store) await purgeStore(this.store, this.o.sessionId);
    this.removeSeqBackup();
  }

  /**
   * The test is over: stop the recorders (final chunks are flushed), then drain events and media in
   * parallel, purge the SDK's own storage and release every device.
   */
  finish(): Promise<{ lostBatches: number }> {
    if (this.finishPromise) return this.finishPromise;
    if (this.torn) return Promise.resolve({ lostBatches: 0 });
    this.finishPromise = this.runFinish();
    return this.finishPromise;
  }

  private async runFinish(): Promise<{ lostBatches: number }> {
    this.finishing = true;
    this.stopped = true;
    await this.initPromise?.catch(() => undefined);
    const drain = this.o.finishDrainMs;
    let lost = 0;
    for (const s of MEDIA_STREAMS) await this.pipeline?.stopStream(s).catch(() => undefined);
    // Both drains run to the end before anything is purged: a drain that is still running could
    // otherwise write buffered events or chunks back after the purge. One failing does not hide
    // the other's result (the event loss count is kept even if the pipeline side failed).
    const [sessionResult, pipelineResult] = await Promise.allSettled([
      this.session.finish(drain),
      this.pipeline?.finish(drain === undefined ? {} : { drainTimeoutMs: drain }),
    ]);
    if (sessionResult.status === 'fulfilled') lost = sessionResult.value.lostBatches;
    // Reported by name only: an error message could carry a URL or a key.
    for (const r of [sessionResult, pipelineResult]) {
      if (r.status === 'rejected') {
        console.warn(
          'Proctor finish step failed:',
          r.reason instanceof Error ? r.reason.name : 'unknown',
        );
      }
    }
    // Whatever an earlier page load left (and anything the SDK could not delete, for example when
    // the key call was still in flight and no session or pipeline ever started) goes now.
    if (this.store) await purgeStore(this.store, this.o.sessionId);
    this.drained = true;
    await this.releaseDevices();
    this.removeSeqBackup();
    this.torn = true;
    this.set({ phase: 'ended' });
    return { lostBatches: lost };
  }

  /** Leaving the page without finishing: keep unsent data for a reload, release the devices. */
  stop(): Promise<void> {
    // finish() tears everything down itself.
    if (this.finishing) return Promise.resolve();
    this.stopped = true;
    return this.teardown({ purge: false });
  }

  /**
   * Always waits for init() first (end() does not wait for this, so there is no deadlock): a purge
   * or a stop that ran while the SDK session was still starting would leave detectors running and
   * write batches after the purge.
   */
  private async teardown(o: { purge: boolean }): Promise<void> {
    this.stopped = true;
    if (this.torn) return;
    this.torn = true;
    if (o.purge) this.purging = true;
    await this.initPromise?.catch(() => undefined);
    if (o.purge) {
      // Purge: delete the signed batches and the chunks as well as stopping (ADR 0013 section 2).
      await Promise.allSettled([
        this.session.finish(0),
        this.pipeline?.finish({ drainTimeoutMs: 0 }),
      ]);
      if (this.store) await purgeStore(this.store, this.o.sessionId);
      this.removeSeqBackup();
    } else {
      await this.session.stop().catch(() => undefined);
      await this.pipeline?.stop().catch(() => undefined);
    }
    await this.releaseDevices();
  }

  private async releaseDevices(): Promise<void> {
    this.monitors.screenShare.stop();
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
  }

  /** The SDK keeps a batch counter per stream and session in localStorage; they go when the test ends. */
  private removeSeqBackup(): void {
    try {
      for (const prefix of SEQ_BACKUP_PREFIXES) {
        globalThis.localStorage?.removeItem(`${prefix}${this.o.sessionId}`);
      }
    } catch {
      // storage disabled
    }
  }

  hasPause(reason: string = PROCTOR_PAUSE): boolean {
    return this.state.pauseReasons.includes(reason);
  }
}

/**
 * The session id the SDK names its storage with: the token's `sid` claim. With no claim only mock
 * mode (whose tokens are not JWTs) may use a random id; anywhere else this returns null and the
 * test does not start (it fails closed: a random id would file the candidate's data under a name
 * nobody can find or purge).
 */
export function sessionIdFromToken(
  token: string | null = getSessionToken(),
  allowRandom: boolean = mockingEnabled,
): string | null {
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
    // not a JWT
  }
  return allowRandom ? crypto.randomUUID() : null;
}
