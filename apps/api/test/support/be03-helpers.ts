// Small local helpers for the BE-03 tests. The fuller settle/signIn/expectReauthFailed helpers live
// on branch qa/step-2b (pending merge into backend PR #26). These are minimal equivalents; after
// #26 lands, the rebase should dedupe them into harness.ts.
import { authenticator } from 'otplib';
import request from 'supertest';
import { UserRole } from '../../src/generated/prisma/client';
import { API, Body, createUser, Harness, login, TOTP_SECRET } from './harness';

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
  const res = (await login(h, u.email).expect(200)).body as Body;
  let token = res.session?.accessToken;
  if (!token) {
    const verified = (
      await request(h.app.getHttpServer())
        .post(`${API}/auth/2fa/verify`)
        .send({ challengeToken: res.challengeToken, code: authenticator.generate(TOTP_SECRET) })
        .expect(200)
    ).body as Body;
    // /auth/2fa/verify answers with a flat accessToken, login with { session: { accessToken } }.
    token = verified.accessToken ?? verified.session?.accessToken;
  }
  if (!token) throw new Error('sign-in gave no access token');
  return { id: u.id, email: u.email, role, orgId, token };
}

export function call(
  h: Harness,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  token?: string,
  body?: unknown,
): request.Test {
  const req = request(h.app.getHttpServer())[method.toLowerCase() as 'get'](`${API}${path}`);
  if (token !== undefined) req.set('Authorization', `Bearer ${token}`);
  return body === undefined ? req : req.send(body as object);
}

/** The token in a set-password link such as https://app/set-password?token=abc (last path or query value). */
export function tokenFromUrl(url: string): string {
  const u = new URL(url);
  return u.searchParams.get('token') ?? u.pathname.split('/').filter(Boolean).pop() ?? '';
}
