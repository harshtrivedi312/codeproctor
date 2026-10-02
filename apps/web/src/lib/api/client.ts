import createClient, { type Middleware } from 'openapi-fetch';
import { getAccessToken } from '@/lib/auth-token';
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

export const api = createClient<paths>({
  baseUrl: apiBaseUrl,
  credentials: 'include',
  fetch: async (request) => {
    await mockingReady;
    return fetch(request);
  },
});
api.use(authMiddleware);

export type Schemas = components['schemas'];
