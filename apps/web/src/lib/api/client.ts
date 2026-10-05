import createClient, { type Middleware } from 'openapi-fetch';
import { getAccessToken } from '@/lib/auth-token';
import { getGeneration, getSessionUserId, refreshSession } from '@/lib/auth-session';
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
const retryCopies = new WeakMap<
  Request,
  { copy: Request; generation: number; userId: string | null }
>();
const refreshMiddleware: Middleware = {
  onRequest({ request }) {
    if (getAccessToken() && !isAuthRequest(request.url)) {
      retryCopies.set(request, {
        copy: request.clone(),
        generation: getGeneration(),
        userId: getSessionUserId(),
      });
    }
    return undefined;
  },
  async onResponse({ request, response }) {
    const sent = retryCopies.get(request);
    if (response.status !== 401 || !sent) return undefined;
    const { copy, generation, userId } = sent;
    if (generation !== getGeneration()) return undefined;
    const session = await refreshSession();
    // The refresh cookie is shared by all tabs: only replay for the same person (FR-103).
    if (!session || generation !== getGeneration() || session.user.id !== userId) return undefined;
    copy.headers.set('Authorization', `Bearer ${session.accessToken}`);
    return fetch(copy);
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
api.use(refreshMiddleware);

export type Schemas = components['schemas'];
