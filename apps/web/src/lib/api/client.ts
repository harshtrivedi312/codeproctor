import createClient, { type Middleware } from 'openapi-fetch';
import { getAccessToken } from '@/lib/auth-token';
import {
  MAX_BUSY_RETRIES,
  MAX_TOTAL_WAIT_MS,
  NO_BUSY_RETRY_HEADER,
  busyDelayMs,
  busyStore,
  isBusyResponse,
  isNoRetryRoute,
  pause,
} from './busy';
import {
  captureSessionStamp,
  getGeneration,
  refreshForReplay,
  type SessionStamp,
} from '@/lib/auth-session';
import { apiBaseUrl } from '@/lib/env';
import { mockingReady } from '@/lib/mock-ready';
import type { components, paths } from './schema';

const authMiddleware: Middleware = {
  onRequest({ request }) {
    const token = getAccessToken();
    if (token) request.headers.set('Authorization', `Bearer ${token}`);
    return request;
  },
};

const basePath = new URL(apiBaseUrl).pathname.replace(/\/+$/, '');

/**
 * True for the auth endpoints (login, 2FA, refresh, logout), which must not trigger a refresh and
 * retry. The check is relative to the API base URL, so a path prefix in NEXT_PUBLIC_API_URL or a
 * move to /api/v1 does not break it.
 */
export function isAuthRequest(url: string): boolean {
  const { pathname } = new URL(url);
  const relative = pathname.startsWith(basePath) ? pathname.slice(basePath.length) : pathname;
  return /^(?:\/api)?\/v\d+\/auth\//.test(relative);
}

// A staff request that gets 401 (access token expired) is retried once after a silent refresh. If
// the refresh fails, auth-session publishes "signed out" and the staff layout goes to login.
// The copy is tagged with the session generation it was sent under. A 401 that arrives after the
// user signed out (and maybe someone else signed in) must not be replayed with the new token.
const retryCopies = new WeakMap<Request, { copy: Request; stamp: SessionStamp }>();
const refreshMiddleware: Middleware = {
  onRequest({ request }) {
    if (getAccessToken() && !isAuthRequest(request.url)) {
      retryCopies.set(request, { copy: request.clone(), stamp: captureSessionStamp() });
    }
    return undefined;
  },
  async onResponse({ request, response }) {
    const sent = retryCopies.get(request);
    if (response.status !== 401 || !sent) return undefined;
    const { copy, stamp } = sent;
    // The refresh cookie is shared by all tabs: only replay for the same person (FR-103).
    const session = await refreshForReplay(stamp);
    if (!session) return undefined;
    copy.headers.set('Authorization', `Bearer ${session.accessToken}`);
    return fetch(copy);
  },
};

/**
 * A 503 whose problem code is BUSY (lock contention, the action did not happen) is sent again, at
 * most 3 more times, after the Retry-After wait (1 to 5 s plus jitter, about 10 s in all). Nothing
 * else is retried: not another 503, not a 500 (a staff write may have committed), nothing on the
 * credential and re-auth routes (see isNoRetryRoute). The retry stops when the call was aborted
 * (the screen left) or the session generation or user changed, and never sends for another person.
 * A call can opt out with the NO_BUSY_RETRY_HEADER header. The body is cloned before the first
 * send; a body that cannot be cloned is not retried.
 */
const busyCopies = new WeakMap<Request, { copy: Request; stamp: SessionStamp }>();
const busyMiddleware: Middleware = {
  onRequest({ request }) {
    const optOut = request.headers.has(NO_BUSY_RETRY_HEADER);
    request.headers.delete(NO_BUSY_RETRY_HEADER);
    if (optOut) return request;
    const { pathname } = new URL(request.url);
    const relative = pathname.startsWith(basePath) ? pathname.slice(basePath.length) : pathname;
    if (isNoRetryRoute(relative, request.method)) return request;
    try {
      busyCopies.set(request, { copy: request.clone(), stamp: captureSessionStamp() });
    } catch {
      // A body that cannot be cloned (a stream) cannot be sent again.
    }
    return request;
  },
  async onResponse({ request, response }) {
    const failedWrite = response.status === 500 && !['GET', 'HEAD'].includes(request.method);
    if (failedWrite && !isAuthRequest(request.url) && getAccessToken()) {
      // A 500 on a staff write is never retried: the action may have happened (audit-after-commit).
      busyStore.writeFailed();
    }
    const sent = busyCopies.get(request);
    if (!sent || !(await isBusyResponse(response))) {
      if (!(response.status === 503)) busyStore.answered();
      return undefined;
    }
    const { copy, stamp } = sent;
    const current = () => getGeneration() === stamp.generation;
    let last = response;
    let waited = 0;
    for (let attempt = 0; attempt < MAX_BUSY_RETRIES; attempt += 1) {
      const wait = busyDelayMs(last.headers.get('retry-after'));
      if (waited + wait > MAX_TOTAL_WAIT_MS) break;
      busyStore.waitStart();
      let go: boolean;
      try {
        go = await pause(wait, current, request.signal);
      } finally {
        busyStore.waitEnd();
      }
      if (!go) return last;
      waited += wait;
      const again = copy.clone();
      const token = getAccessToken();
      if (token) again.headers.set('Authorization', `Bearer ${token}`);
      last = await fetch(again);
      if (!current()) return last;
      if (!(await isBusyResponse(last))) {
        busyStore.answered();
        return last;
      }
    }
    if (current()) busyStore.gaveUp();
    return last;
  },
};

export const api = createClient<paths>({
  baseUrl: apiBaseUrl,
  credentials: 'include',
  fetch: async (request) => {
    await mockingReady;
    return fetch(request);
  },
});
api.use(authMiddleware);
// Registered before the refresh middleware: responses go through them in reverse, so a BUSY
// answer to a request replayed after a refresh is retried too.
api.use(busyMiddleware);
api.use(refreshMiddleware);

export type Schemas = components['schemas'];
