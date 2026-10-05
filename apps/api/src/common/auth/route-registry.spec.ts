import { ROUTE_PERMISSIONS } from './route-permissions';
import { Controller, Get, Post } from '@nestjs/common';
import type { ModulesContainer } from '@nestjs/core';
import { Audited } from '../../audit/audited.decorator';
import { Public, Roles } from './decorators';
import { listRoutes, matrixProblems } from './route-registry';
import type { RegisteredRoute } from './route-registry';

const everyRoute = (): RegisteredRoute[] =>
  Object.entries(ROUTE_PERMISSIONS).map(([key, access]) => ({
    key,
    handler: 'X.y',
    isPublic: access === 'public',
    roles: access === 'public' ? [] : access.roles,
    audited: access !== 'public' && access.audited === true,
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
        audited: false,
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
      audited: false,
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

describe('route registry walk (FR-103, FR-105)', () => {
  class BaseController {
    @Get('inherited')
    @Roles('SUPER_ADMIN')
    inherited(): void {}
  }
  @Controller(['alpha', 'beta'])
  class ChildController extends BaseController {
    @Post(['one', 'two'])
    @Public()
    many(): void {}

    @Get('read')
    @Roles('REVIEWER')
    @Audited('X_READ', 'session')
    read(): void {}
  }
  const modules = {
    values: () => [{ controllers: new Map([['c', { metatype: ChildController }]]) }],
  } as unknown as ModulesContainer;

  it('FR-103: inherited controller methods are listed, and one key per controller path and route path', () => {
    const keys = listRoutes(modules)
      .map((r) => r.key)
      .sort();
    expect(keys).toEqual(
      [
        'GET /alpha/inherited',
        'GET /beta/inherited',
        'GET /alpha/read',
        'GET /beta/read',
        'POST /alpha/one',
        'POST /alpha/two',
        'POST /beta/one',
        'POST /beta/two',
      ].sort(),
    );
  });

  it('FR-105: the registry sees @Audited, and the matrix flag must agree both ways', () => {
    const read = listRoutes(modules).find((r) => r.key === 'GET /alpha/read');
    expect(read?.audited).toBe(true);
    const routes = Object.entries(ROUTE_PERMISSIONS).map(([key, access]) => ({
      key,
      handler: 'X.y',
      isPublic: access === 'public',
      roles: access === 'public' ? [] : access.roles,
      audited: access !== 'public' && access.audited === true,
    }));
    const flipped = routes.map((r) =>
      r.key === 'GET /admin/users' ? { ...r, audited: false } : r,
    );
    expect(matrixProblems(flipped).join('\n')).toContain(
      'GET /admin/users is audited in the matrix but has no @Audited()',
    );
    const extra = routes.map((r) => (r.key === 'POST /admin/users' ? { ...r, audited: true } : r));
    expect(matrixProblems(extra).join('\n')).toContain(
      'POST /admin/users has @Audited() but the matrix does not say audited',
    );
  });
});
