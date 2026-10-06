// Small helpers for the BE-03 tests. Sign-in comes from harness.ts (signIn, signInWithTotp).
import request from 'supertest';
import { UserRole } from '../../src/generated/prisma/client';
import { API, createUser, Harness, signIn, signInWithTotp, TOTP_SECRET } from './harness';

export interface Actor {
  id: string;
  email: string;
  role: UserRole;
  orgId: string;
  token: string;
}

/** Creates a user of `role` in `orgId` and signs in (REVIEWER and SUPER_ADMIN need TOTP, ADR 0003). */
export async function actor(h: Harness, role: UserRole, orgId = h.orgId): Promise<Actor> {
  const needs2fa = role === UserRole.REVIEWER || role === UserRole.SUPER_ADMIN;
  const u = await createUser(h, { role, orgId, totp: needs2fa ? TOTP_SECRET : undefined });
  const auth = needs2fa ? await signInWithTotp(h, u.email) : await signIn(h, u.email);
  return {
    id: u.id,
    email: u.email,
    role,
    orgId,
    token: auth.Authorization.replace('Bearer ', ''),
  };
}

export function call(
  h: Harness,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  token?: string,
  body?: unknown,
): request.Test {
  const req = request(h.app.getHttpServer())[method.toLowerCase() as 'get'](`${API}${path}`);
  if (token !== undefined) req.set('Authorization', `Bearer ${token}`);
  return body === undefined ? req : req.send(body as object);
}

/**
 * The token in a set-password or reset link: the `token` of the URL fragment (the staff invite,
 * `/admin/set-password#token=...`), else of the query string. Returns ''
 * when the value is not a parseable URL, so a changed link format fails the test that expects a
 * token, not an unrelated one.
 */
export function tokenFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const fromHash = new URLSearchParams(u.hash.replace(/^#/, '')).get('token');
    return fromHash ?? u.searchParams.get('token') ?? '';
  } catch {
    return '';
  }
}

/**
 * Waits for mail the API defers until after the response (lock alerts, invites, forgot-password):
 * the API's own pending work first, then a few event-loop turns so a send queued by a callback
 * that has just run is also seen. Use before asserting that a mail was, or was not, sent.
 */
export async function flushDeferred(h: Harness): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await h.settle();
    await new Promise((resolve) => setImmediate(resolve));
  }
}
