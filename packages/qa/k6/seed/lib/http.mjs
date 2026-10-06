// A small HTTP client: built-in fetch, a request-rate limit, polite retries, no redirects, no
// request or response bodies in errors. Error messages carry the step name, status and the
// problem `code` (an upper-case token) only.
import { SeedError } from './redact.mjs';

const CODE_RE = /^[A-Z][A-Z0-9_]{2,60}$/;

// One limiter can be shared by several clients (API and mail sink) so the run stays under one rate.
export function createLimiter({
  rps = 5,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
} = {}) {
  const gap = rps > 0 ? Math.ceil(1000 / rps) : 0;
  let nextSlot = 0;
  return async function slot() {
    const t = now();
    const at = Math.max(t, nextSlot);
    nextSlot = at + gap;
    if (at > t) await sleep(at - t);
  };
}

export function createClient({
  baseUrl,
  rps = 5,
  limiter,
  maxRetries = 4,
  timeoutMs = 30000,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
}) {
  // Serialises request starts so the whole run stays under `rps` requests per second.
  const slot = limiter ?? createLimiter({ rps, sleep, now });

  function backoff(attempt, retryAfter) {
    if (retryAfter !== null && Number.isFinite(retryAfter)) {
      return Math.min(Math.max(retryAfter, 0), 30) * 1000;
    }
    return Math.min(500 * 2 ** attempt, 8000) + Math.floor(Math.random() * 250);
  }

  // opts: { token, body, step, idempotent, retry503, expect: [statuses], raw: Buffer, headers, absolute }
  // retry503: the route answers 503 + Retry-After without processing (ADR 0013), so a repeat is safe.
  // `absolute` is a full URL (storage PUT); otherwise `path` is joined to baseUrl.
  async function request(method, path, opts = {}) {
    const step = opts.step ?? `${method} ${path.split('?')[0].replace(/[0-9a-f-]{36}/g, ':id')}`;
    const safeToRepeat = opts.idempotent ?? (method === 'GET' || method === 'PUT');
    const expect = opts.expect ?? [200, 201, 202, 204];
    for (let attempt = 0; ; attempt++) {
      await slot();
      let res;
      try {
        const headers = { Accept: 'application/json', ...(opts.headers ?? {}) };
        if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
        let body;
        if (opts.raw) body = opts.raw;
        else if (opts.body !== undefined) {
          headers['Content-Type'] = 'application/json';
          body = JSON.stringify(opts.body);
        }
        res = await fetchImpl(opts.absolute ?? baseUrl + path, {
          method,
          headers,
          body,
          redirect: 'manual', // a 3xx must never carry a bearer token or a POST elsewhere
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        if (safeToRepeat && attempt < maxRetries) {
          await sleep(backoff(attempt, null));
          continue;
        }
        throw new SeedError(`${step}: network error or timeout (no response).`, { step });
      }
      const text = await res.text();
      if (expect.includes(res.status)) {
        let json;
        if (text) {
          try {
            json = JSON.parse(text);
          } catch {
            json = undefined;
          }
        }
        return { status: res.status, json, headers: res.headers };
      }
      let code;
      try {
        const c = JSON.parse(text)?.code;
        if (typeof c === 'string' && CODE_RE.test(c)) code = c;
      } catch {
        /* not JSON */
      }
      const ra = res.headers.get('retry-after');
      const retryAfter = ra === null ? null : Number(ra);
      // 429 means "not processed". 503 is repeated only for repeatable calls or routes flagged retry503;
      // 502/504 only for repeatable calls.
      const retryable =
        res.status === 429 ||
        (res.status === 503 && (safeToRepeat || opts.retry503 === true)) ||
        ((res.status === 502 || res.status === 504) && safeToRepeat);
      if (retryable && attempt < maxRetries) {
        await sleep(backoff(attempt, retryAfter));
        continue;
      }
      throw new SeedError(
        `${step}: HTTP ${res.status}${code ? ` ${code}` : ''}${res.status >= 300 && res.status < 400 ? ' (redirect refused)' : ''}.`,
        { status: res.status, code, step },
      );
    }
  }

  return { request };
}
