/** Answer of one bounded request, body already read. Never logged. */
export interface TimedAnswer {
  status: number;
  ok: boolean;
  text: string;
  retryAfter: string | null;
}

export class RequestTimeoutError extends Error {
  constructor() {
    super('request timed out');
    this.name = 'RequestTimeoutError';
  }
}

/**
 * One request with an AbortController and a race against a timer (a fetch that ignores the signal
 * is bounded too). The timer is cleared only after the body is read. Throws on timeout or network
 * error. Nothing about the request or the response is logged.
 */
export async function timedFetch(
  f: typeof fetch,
  url: string,
  init: Omit<RequestInit, 'signal'>,
  timeoutMs: number,
): Promise<TimedAnswer> {
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctl.abort();
      reject(new RequestTimeoutError());
    }, timeoutMs);
  });
  const run = (async (): Promise<TimedAnswer> => {
    const res = await f(url, { ...init, signal: ctl.signal });
    const text = await res.text();
    return {
      status: res.status,
      ok: res.ok,
      text,
      retryAfter: res.headers?.get?.('Retry-After') ?? null,
    };
  })();
  run.catch(() => undefined); // a late rejection after the timeout must not be unhandled
  try {
    return await Promise.race([run, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
