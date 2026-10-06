import type {
  FromWorker,
  InferenceTask,
  InitMessage,
  ReadyMessage,
  ResultMessage,
  ToWorker,
} from './protocol';

/** The slice of Worker we use, so tests can fake it. */
export interface WorkerLike {
  postMessage(msg: ToWorker, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((e: MessageEvent<FromWorker>) => void) | null;
  onerror: ((e: unknown) => void) | null;
}

/**
 * Main-thread handle to the inference worker. One frame in flight at a time (back-pressure): if
 * the worker is still busy the new frame is skipped and counted, never queued, so a slow device
 * degrades detection rate instead of memory or editor smoothness.
 */
export class InferenceClient {
  private worker: WorkerLike | null = null;
  private nextId = 1;
  private inFlight: { id: number; resolve: (r: ResultMessage | null) => void } | null = null;
  private ready: ((r: ReadyMessage | null) => void) | null = null;
  /** Called once if the worker dies after `ready` (error event or repeated frame timeouts). */
  onDead: (() => void) | null = null;
  private consecutiveStrikes = 0;
  /** Id of a frame that timed out but whose worker may still be computing it. */
  private lateId: number | null = null;
  private lateTimer: ReturnType<typeof setTimeout> | null = null;
  skippedFrames = 0;
  busyMs = 0;
  frames = 0;
  private readonly startedAt = performance.now();

  constructor(
    private readonly createWorker: () => WorkerLike,
    /** Give up when the worker never answers `init` (hung wasm or model fetch). */
    private readonly initTimeoutMs = 30_000,
    /** A frame the worker never answers is abandoned after this long (default 10 s). */
    private readonly frameTimeoutMs = 10_000,
  ) {}

  /** One strike per timeout or per error event; three in a row mean the worker is not usable. */
  private strike(): void {
    if (++this.consecutiveStrikes >= 3) this.die();
  }

  private die(): void {
    if (!this.worker) return;
    this.terminate();
    this.onDead?.();
  }

  /** Resolves with per-task load results, or null when the worker itself could not start. */
  init(msg: Omit<InitMessage, 'type'>): Promise<ReadyMessage | null> {
    return new Promise((resolve) => {
      try {
        this.worker = this.createWorker();
      } catch {
        resolve(null);
        return;
      }
      const finish = (r: ReadyMessage | null): void => {
        clearTimeout(timer);
        this.ready = null;
        if (r === null) this.terminate();
        resolve(r);
      };
      this.ready = finish;
      const timer = setTimeout(() => finish(null), this.initTimeoutMs);
      this.worker.onmessage = (e) => this.handle(e.data);
      this.worker.onerror = () => {
        if (this.ready) {
          this.ready(null);
          return;
        }
        // An `error` event also fires for an uncaught exception in a handler while the worker lives
        // on, so it is one strike (like a timeout), not an immediate death.
        this.strike();
      };
      this.worker.postMessage({ type: 'init', ...msg });
    });
  }

  private handle(m: FromWorker): void {
    if (m.type === 'ready') {
      this.ready?.(m);
      this.ready = null;
      return;
    }
    this.busyMs += m.busyMs;
    this.frames++;
    if (this.lateId === m.id) {
      // The worker finished the frame we gave up on: it is free again.
      this.lateId = null;
      if (this.lateTimer) clearTimeout(this.lateTimer);
      this.lateTimer = null;
    }
    if (this.inFlight?.id === m.id) {
      this.consecutiveStrikes = 0;
      this.inFlight.resolve(m);
      this.inFlight = null;
    }
  }

  /** Send a frame. Returns null when skipped (worker busy) or failed. Takes ownership of the bitmap. */
  analyze(bitmap: ImageBitmap, tasks: InferenceTask[]): Promise<ResultMessage | null> {
    // Busy: a frame in flight, or one that timed out but is still running in the worker.
    if (!this.worker || this.inFlight || this.lateId !== null) {
      this.skippedFrames++;
      bitmap.close();
      return Promise.resolve(null);
    }
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.inFlight?.id !== id) return;
        this.inFlight = null;
        resolve(null);
        // Keep back-pressure: the worker may still be busy with this frame. If it never answers
        // within another timeout it is considered dead.
        this.lateId = id;
        this.lateTimer = setTimeout(() => {
          if (this.lateId === id) this.die();
        }, this.frameTimeoutMs);
        this.strike();
      }, this.frameTimeoutMs);
      this.inFlight = {
        id,
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
      };
      this.worker?.postMessage({ type: 'frame', id, bitmap, tasks }, [bitmap]);
    });
  }

  /** Worker CPU as a percentage of one core since start. */
  workerBusyPercent(): number {
    return (this.busyMs / Math.max(1, performance.now() - this.startedAt)) * 100;
  }

  terminate(): void {
    if (this.lateTimer) clearTimeout(this.lateTimer);
    this.lateTimer = null;
    this.lateId = null;
    // An init still waiting for `ready` settles at once instead of hanging until its timeout.
    const pendingReady = this.ready;
    this.ready = null;
    pendingReady?.(null);
    this.worker?.terminate();
    this.worker = null;
    this.inFlight?.resolve(null);
    this.inFlight = null;
  }
}
