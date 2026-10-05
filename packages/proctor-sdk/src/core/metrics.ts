export interface Metrics {
  uptimeMs: number;
  /** Time spent inside SDK callbacks per label, in ms. */
  busyMsByLabel: Record<string, number>;
  /** Sum of busyMsByLabel divided by uptime, as a percentage of one main-thread core. */
  mainThreadBusyPercent: number;
  longTasks: { count: number; totalMs: number };
}

/**
 * CPU accounting for the SDK. measure() times every SDK callback with performance.now(); the
 * PerformanceObserver counts long tasks (over 50 ms) where the browser supports it, so we can
 * show that the editor thread stays free. Worker CPU (Step 8) is reported separately by the
 * detector worker.
 */
export class MetricsCollector {
  private readonly busy = new Map<string, number>();
  private readonly startedAt = performance.now();
  private longTaskCount = 0;
  private longTaskMs = 0;
  private observer: PerformanceObserver | null = null;

  constructor() {
    try {
      if (typeof PerformanceObserver !== 'undefined') {
        this.observer = new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            this.longTaskCount++;
            this.longTaskMs += e.duration;
          }
        });
        this.observer.observe({ entryTypes: ['longtask'] });
      }
    } catch {
      this.observer = null; // longtask not supported (Safari, Firefox): counts stay at 0
    }
  }

  measure = <R>(label: string, fn: () => R): R => {
    const t0 = performance.now();
    try {
      return fn();
    } finally {
      this.busy.set(label, (this.busy.get(label) ?? 0) + (performance.now() - t0));
    }
  };

  snapshot(): Metrics {
    const uptimeMs = Math.max(1, performance.now() - this.startedAt);
    const busyMsByLabel = Object.fromEntries(this.busy);
    const total = [...this.busy.values()].reduce((a, b) => a + b, 0);
    return {
      uptimeMs,
      busyMsByLabel,
      mainThreadBusyPercent: (total / uptimeMs) * 100,
      longTasks: { count: this.longTaskCount, totalMs: this.longTaskMs },
    };
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
  }
}
