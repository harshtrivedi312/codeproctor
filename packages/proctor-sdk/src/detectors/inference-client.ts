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
  skippedFrames = 0;
  busyMs = 0;
  frames = 0;
  private readonly startedAt = performance.now();

  constructor(
    private readonly createWorker: () => WorkerLike,
    /** Give up when the worker never answers `init` (hung wasm or model fetch). */
    private readonly initTimeoutMs = 30_000,
  ) {}

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
        this.ready?.(null);
        this.inFlight?.resolve(null);
        this.inFlight = null;
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
      this.inFlight = { id, resolve };
      this.worker?.postMessage({ type: 'frame', id, bitmap, tasks }, [bitmap]);
    });
  }

  /** Worker CPU as a percentage of one core since start. */
  workerBusyPercent(): number {
    return (this.busyMs / Math.max(1, performance.now() - this.startedAt)) * 100;
  }

  terminate(): void {
    this.worker?.terminate();
    this.worker = null;
    this.inFlight?.resolve(null);
    this.inFlight = null;
  }
}
