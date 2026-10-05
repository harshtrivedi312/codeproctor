import { ROUTE_PERMISSIONS } from './route-permissions';
import { matrixProblems } from './route-registry';
import type { RegisteredRoute } from './route-registry';

const everyRoute = (): RegisteredRoute[] =>
  Object.entries(ROUTE_PERMISSIONS).map(([key, access]) => ({
    key,
    handler: 'X.y',
    isPublic: access === 'public',
    roles: access === 'public' ? [] : access.roles,
  }));

describe('route permission matrix (FR-103, TC-004)', () => {
  it('TC-004: a matrix that mirrors the controllers has no problems', () => {
    expect(matrixProblems(everyRoute())).toEqual([]);
  });

  it('TC-004: a controller route missing from the matrix is reported', () => {
    const routes = [
      ...everyRoute(),
      {
        key: 'PATCH /questions/:id',
        handler: 'Q.patch',
        isPublic: false,
        roles: ['AUTHOR' as const],
      },
    ];
    expect(matrixProblems(routes)).toEqual([
      'PATCH /questions/:id (Q.patch) is not in ROUTE_PERMISSIONS',
    ]);
  });

  it('FR-103: a stale matrix entry, a role mismatch and a public/roles mix-up are reported', () => {
    const routes = everyRoute()
      .filter((r) => r.key !== 'POST /admin/users' && r.key !== 'POST /auth/login')
      .map((r): RegisteredRoute =>
        r.key === 'GET /admin/users' ? { ...r, roles: ['RECRUITER'] } : r,
      );
    routes.push({
      key: 'POST /auth/login',
      handler: 'A.login',
      isPublic: true,
      roles: ['SUPER_ADMIN'],
    });
    const problems = matrixProblems(routes).join('\n');
    expect(problems).toContain(
      'POST /admin/users is in ROUTE_PERMISSIONS but no controller serves it',
    );
    expect(problems).toContain('GET /admin/users @Roles() differs from the matrix');
    expect(problems).toContain('POST /auth/login (A.login) carries both @Public() and @Roles()');
  });

  it('FR-103: /health is public and every admin user route is SUPER_ADMIN only', () => {
    expect(ROUTE_PERMISSIONS['GET /health']).toBe('public');
    for (const [key, access] of Object.entries(ROUTE_PERMISSIONS)) {
      if (key.includes('/admin/users')) {
        expect(access).toMatchObject({ roles: ['SUPER_ADMIN'], permission: 'user:manage' });
      }
    }
  });
});
