/*
 * A tiny in-process Web Locks (navigator.locks) for jsdom, which has none: exclusive locks per
 * name, FIFO, `ifAvailable`. Enough for the refresh single-flight (src/lib/refresh-coordination.ts).
 * Tests that simulate several tabs share ONE instance between the simulated tabs.
 */
type Callback = (lock: { name: string } | null) => Promise<unknown>;

export function createFakeLocks(): Pick<LockManager, 'request'> {
  const byName = new Map<string, { held: boolean; queue: Array<() => void> }>();
  const stateOf = (name: string) => {
    let s = byName.get(name);
    if (!s) byName.set(name, (s = { held: false, queue: [] }));
    return s;
  };
  const request = ((name: string, a: unknown, b?: unknown): Promise<unknown> => {
    const options =
      typeof a === 'function' ? {} : (a as { ifAvailable?: boolean; signal?: AbortSignal });
    const cb = (typeof a === 'function' ? a : b) as Callback;
    const state = stateOf(name);
    const release = (): void => {
      state.held = false;
      const next = state.queue.shift();
      if (next) {
        state.held = true;
        next();
      }
    };
    return new Promise((resolve, reject) => {
      const run = (): void => {
        void cb({ name }).then(resolve, reject).finally(release);
      };
      if (!state.held) {
        state.held = true;
        run();
      } else if (options.ifAvailable) {
        void cb(null).then(resolve, reject);
      } else {
        state.queue.push(run);
        options.signal?.addEventListener(
          'abort',
          () => {
            const at = state.queue.indexOf(run);
            if (at >= 0) {
              state.queue.splice(at, 1);
              reject(new DOMException('The lock request was aborted', 'AbortError'));
            }
          },
          { once: true },
        );
      }
    });
  }) as LockManager['request'];
  return { request };
}
