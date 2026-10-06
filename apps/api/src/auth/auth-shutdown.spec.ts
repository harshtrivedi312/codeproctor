import { AuthService } from './auth.service';

interface Shape {
  deferred: Set<Promise<void>>;
  logger: { warn: (m: string) => void };
}

describe('FU-BE-162 bounded shutdown settle of deferred auth mail', () => {
  function bare(): { svc: AuthService; lines: string[]; shape: Shape } {
    const lines: string[] = [];
    const svc = Object.create(AuthService.prototype) as AuthService;
    const shape = svc as unknown as Shape;
    shape.deferred = new Set();
    shape.logger = { warn: (m) => void lines.push(m) };
    return { svc, lines, shape };
  }

  it('FU-BE-162: a stuck deferred task cannot stall shutdown past the bound, and a fixed line is logged', async () => {
    const { svc, lines, shape } = bare();
    shape.deferred.add(new Promise<void>(() => undefined));
    const started = Date.now();
    await svc.settleDeferredBounded(50);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(lines).toEqual(['Shutdown gave up waiting for 1 deferred tasks after 50 ms']);
    // The abandoned task is still counted, nothing pretends it finished.
    expect(shape.deferred.size).toBe(1);
  });

  it('FU-BE-162: onApplicationShutdown is a short bounded catch-all with the same fixed line', async () => {
    const { svc, lines, shape } = bare();
    shape.deferred.add(new Promise<void>(() => undefined));
    const started = Date.now();
    await svc.onApplicationShutdown();
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(lines).toEqual(['Shutdown gave up waiting for 1 deferred tasks after 1000 ms']);
  });

  it('FU-BE-162: deferred work that finishes in time is awaited with no warning', async () => {
    const { svc, lines, shape } = bare();
    let done = false;
    const task: Promise<void> = new Promise<void>((r) => setTimeout(r, 10)).then(() => {
      done = true;
      shape.deferred.delete(task);
    });
    shape.deferred.add(task);
    await svc.settleDeferredBounded(1_000);
    expect(done).toBe(true);
    expect(lines).toEqual([]);
  });
});
