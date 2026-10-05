import createClient, { type Middleware } from 'openapi-fetch';
import { getAccessToken } from '@/lib/auth-token';
import { refreshSession } from '@/lib/auth-session';
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

// A staff request that gets 401 (access token expired) is retried once after a silent refresh. If
// the refresh fails, auth-session publishes "signed out" and the staff layout goes to login.
const retryCopies = new WeakMap<Request, Request>();
const refreshMiddleware: Middleware = {
  onRequest({ request }) {
    if (getAccessToken() && !new URL(request.url).pathname.startsWith('/v1/auth/')) {
      retryCopies.set(request, request.clone());
    }
    return undefined;
  },
  async onResponse({ request, response }) {
    const copy = retryCopies.get(request);
    if (response.status !== 401 || !copy) return undefined;
    const session = await refreshSession();
    if (!session) return undefined;
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
