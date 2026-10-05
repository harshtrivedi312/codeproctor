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
  private consecutiveTimeouts = 0;
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
        // Dead worker after ready: do not keep it, a frame would wait forever.
        this.die();
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
    if (this.inFlight?.id === m.id) {
      this.consecutiveTimeouts = 0;
      this.inFlight.resolve(m);
      this.inFlight = null;
    }
  }

  /** Send a frame. Returns null when skipped (worker busy) or failed. Takes ownership of the bitmap. */
  analyze(bitmap: ImageBitmap, tasks: InferenceTask[]): Promise<ResultMessage | null> {
    if (!this.worker || this.inFlight) {
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
        if (++this.consecutiveTimeouts >= 3) this.die();
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
