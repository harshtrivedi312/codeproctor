/*
 * A tiny in-process Web Locks (navigator.locks) for jsdom, which has none: exclusive locks, FIFO,
 * `ifAvailable`. Enough for the refresh single-flight (src/lib/refresh-coordination.ts). Tests that
 * simulate several tabs share ONE instance between the simulated tabs.
 */
type Callback = (lock: { name: string } | null) => Promise<unknown>;

export function createFakeLocks(): Pick<LockManager, 'request'> {
  let held = false;
  const queue: Array<() => void> = [];
  const release = (): void => {
    held = false;
    const next = queue.shift();
    if (next) {
      held = true;
      next();
    }
  };
  const request = ((name: string, a: unknown, b?: unknown): Promise<unknown> => {
    const options = typeof a === 'function' ? {} : (a as { ifAvailable?: boolean });
    const cb = (typeof a === 'function' ? a : b) as Callback;
    return new Promise((resolve, reject) => {
      const run = (): void => {
        void cb({ name }).then(resolve, reject).finally(release);
      };
      if (!held) {
        held = true;
        run();
      } else if (options.ifAvailable) {
        void cb(null).then(resolve, reject);
      } else {
        queue.push(run);
      }
    });
  }) as LockManager['request'];
  return { request };
}
