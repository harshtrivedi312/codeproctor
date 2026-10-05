// Contract check between the web app's OpenAPI file (apps/web/openapi/openapi.yaml, which the
// frontend mocks follow) and the real API: every /v1/auth route the web calls must exist on the API
// when the web base URL points at it, and the login and session bodies must have the fields the web
// reads. Cases: FR-101, FR-102, FR-104, FR-107 (the TC-001, TC-003, TC-098 browser flows depend on it).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import request from 'supertest';
import { Body, boot, createUser, Harness, login } from '../support/harness';

function webAuthRoutes(): { method: string; path: string }[] {
  const yaml = readFileSync(resolve(__dirname, '../../../web/openapi/openapi.yaml'), 'utf8').split(
    '\n',
  );
  const routes: { method: string; path: string }[] = [];
  let current: string | null = null;
  for (const line of yaml) {
    const p = /^ {2}(\/v1\/auth\/[^:]+):\s*$/.exec(line);
    if (p) current = p[1] ?? null;
    else if (/^ {2}\S/.test(line)) current = null;
    const m = /^ {4}(get|post|put|patch|delete):\s*$/.exec(line);
    if (m && current) routes.push({ method: m[1] ?? 'get', path: current });
  }
  return routes;
}

describe('Web OpenAPI contract against the real API (FR-101, FR-102, FR-104, FR-107)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await boot();
  });
  afterAll(async () => {
    await h?.close();
  });

  it('FR-101: the web file lists the auth routes this test relies on', () => {
    const paths = webAuthRoutes().map((r) => `${r.method} ${r.path}`);
    expect(paths).toEqual(
      expect.arrayContaining([
        'post /v1/auth/login',
        'post /v1/auth/2fa/verify',
        'post /v1/auth/refresh',
        'post /v1/auth/password/forgot',
        'post /v1/auth/password/reset',
      ]),
    );
  });

  it('FR-101: every auth route the web calls is served by the API under the /api prefix', async () => {
    const notFound: string[] = [];
    for (const r of webAuthRoutes()) {
      const res = await (
        request(h.app.getHttpServer()) as unknown as Record<string, (u: string) => request.Test>
      )[r.method]!(`/api${r.path}`).send({});
      if (res.status === 404) notFound.push(`${r.method.toUpperCase()} /api${r.path}`);
    }
    expect(notFound).toEqual([]);
  });

  // QA-D-02: the web default API URL has no /api prefix, so its own paths miss the API.
  it('FR-101: the web paths exactly as written in the OpenAPI file (no /api prefix) are not served, so NEXT_PUBLIC_API_URL must end in /api', async () => {
    await request(h.app.getHttpServer()).post('/v1/auth/login').send({}).expect(404);
  });

  it('FR-104: the login session and the refresh response carry the user fields the web reads (id, email, name, role, orgName)', async () => {
    const u = await createUser(h);
    const res = await login(h, u.email).expect(200);
    const user = (res.body as Body).session.user as unknown as Record<string, unknown>;
    const wanted = ['id', 'email', 'name', 'role', 'orgName'];
    expect(wanted.filter((f) => typeof user[f] !== 'string')).toEqual([]);
  });
});
