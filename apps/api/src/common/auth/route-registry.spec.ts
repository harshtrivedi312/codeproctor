import { ROUTE_PERMISSIONS, isCandidate, isPublic, isStaff } from './route-permissions';
import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import type { ModulesContainer } from '@nestjs/core';
import { Audited } from '../../audit/audited.decorator';
import { CandidateRoute } from './candidate-route.decorator';
import { Public, Roles } from './decorators';
import { listRoutes, matrixProblems } from './route-registry';
import type { RegisteredRoute } from './route-registry';

const everyRoute = (): RegisteredRoute[] =>
  Object.entries(ROUTE_PERMISSIONS).map(([key, access]) => ({
    key,
    handler: 'X.y',
    isPublic: isPublic(access) || isCandidate(access),
    roles: isStaff(access) ? access.roles : [],
    audited: !isPublic(access) && !isCandidate(access) && access.audited === true,
    guards: isCandidate(access) ? [class G {}] : [],
    candidatePermission: isCandidate(access) ? access.permission : null,
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
        guards: [],
        candidatePermission: null,
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
      guards: [],
      candidatePermission: null,
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
        expect(isStaff(access)).toBe(true);
        expect(access).toMatchObject({ roles: ['SUPER_ADMIN'], permission: 'user:manage' });
      }
    }
  });
});

describe('matrix edge cases (FR-103, FR-105)', () => {
  it('FR-105: a candidate-data route that is not audited is reported', () => {
    const real = Object.entries(ROUTE_PERMISSIONS).filter(([, a]) => isStaff(a))[0];
    const key = 'GET /review/sessions/:id';
    const saved = ROUTE_PERMISSIONS[key];
    (ROUTE_PERMISSIONS as Record<string, unknown>)[key] = {
      roles: ['REVIEWER'],
      permission: 'review_session:read',
      candidateData: true,
    };
    try {
      const routes: RegisteredRoute[] = [
        {
          key,
          handler: 'R.read',
          isPublic: false,
          roles: ['REVIEWER'],
          audited: false,
          guards: [],
          candidatePermission: null,
        },
      ];
      expect(real).toBeDefined();
      expect(matrixProblems(routes).join('\n')).toContain(
        'GET /review/sessions/:id touches candidate data but is not audited (FR-105)',
      );
    } finally {
      if (saved === undefined) delete (ROUTE_PERMISSIONS as Record<string, unknown>)[key];
    }
  });

  it('FR-103: the same key served by two handlers is reported', () => {
    const [first] = everyRoute();
    const problems = matrixProblems([
      ...everyRoute(),
      { ...(first as RegisteredRoute), handler: 'Other.dup' },
    ]);
    expect(problems.join('\n')).toContain('is served by more than one handler');
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
      isPublic: isPublic(access) || isCandidate(access),
      roles: isStaff(access) ? access.roles : [],
      audited: !isPublic(access) && !isCandidate(access) && access.audited === true,
      guards: isCandidate(access) ? [class G {}] : [],
      candidatePermission: isCandidate(access) ? access.permission : null,
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

describe('candidate route variant (FR-103, ADR 0010 section 6, ADR 0013)', () => {
  const KEY = 'POST /candidate/answers/:questionId/run';
  const candidate = {
    principal: 'CANDIDATE',
    permission: 'candidate_answer:run',
  } as const;
  const base: RegisteredRoute = {
    key: KEY,
    handler: 'C.run',
    isPublic: true,
    roles: [],
    audited: false,
    guards: [class FakeCandidateGuard {}],
    candidatePermission: 'candidate_answer:run',
  };
  const withEntry = (entry: unknown, routes: RegisteredRoute[]): string[] => {
    const matrix = ROUTE_PERMISSIONS as Record<string, unknown>;
    matrix[KEY] = entry;
    try {
      // Only this route: the other matrix entries are not served by these synthetic routes.
      return matrixProblems(routes).filter((p) => p.includes(KEY));
    } finally {
      delete matrix[KEY];
    }
  };

  it('FR-103: the type guards tell public, staff and candidate access apart', () => {
    expect([isPublic('public'), isStaff('public'), isCandidate('public')]).toEqual([
      true,
      false,
      false,
    ]);
    expect([isPublic(candidate), isStaff(candidate), isCandidate(candidate)]).toEqual([
      false,
      false,
      true,
    ]);
    const staff = { roles: ['AUTHOR'], permission: 'question:read' } as const;
    expect([isPublic(staff), isStaff(staff), isCandidate(staff)]).toEqual([false, true, false]);
  });

  it('FR-103: ADR 0013: a CANDIDATE route that is @Public() and carries @CandidateRoute() has no problems', () => {
    expect(withEntry(candidate, [base])).toEqual([]);
  });

  it('FR-103: a CANDIDATE route that is not @Public() is reported', () => {
    const problems = withEntry(candidate, [{ ...base, isPublic: false }]);
    expect(problems.join('\n')).toContain('is a CANDIDATE route in the matrix but not @Public()');
  });

  it('FR-103: a CANDIDATE route without the marker, or with another permission, is reported', () => {
    expect(withEntry(candidate, [{ ...base, candidatePermission: null }]).join('\n')).toContain(
      'has no @CandidateRoute()',
    );
    expect(
      withEntry(candidate, [{ ...base, candidatePermission: 'candidate_answer:submit' }]).join(
        '\n',
      ),
    ).toContain('@CandidateRoute() permission differs from the matrix');
  });

  it('FR-103: the marker on a route the matrix lists as public or staff is reported', () => {
    expect(withEntry('public', [base]).join('\n')).toContain(
      'carries @CandidateRoute() but the matrix does not list it as CANDIDATE',
    );
    const staff = { roles: ['AUTHOR'], permission: 'question:read' };
    const problems = withEntry(staff, [{ ...base, isPublic: false, roles: ['AUTHOR'] }]).join('\n');
    expect(problems).toContain('is a staff route (@Roles()) but carries @CandidateRoute()');
  });

  it('FR-103: a staff route (@Roles) never carries the candidate marker, even when the matrix says CANDIDATE', () => {
    const problems = withEntry(candidate, [{ ...base, isPublic: false, roles: ['AUTHOR'] }]).join(
      '\n',
    );
    expect(problems).toContain('is a CANDIDATE route but carries @Roles()');
  });

  it('FR-103: ADR 0013: @Audited() on a CANDIDATE route is always a problem', () => {
    expect(withEntry(candidate, [{ ...base, audited: true }]).join('\n')).toContain(
      'candidate routes write no audit rows (ADR 0013)',
    );
    // Even a matrix entry that tries the old escape hatch is still a problem.
    expect(
      withEntry({ ...candidate, audited: true }, [{ ...base, audited: true }]).join('\n'),
    ).toContain('write no audit rows');
  });

  it('FR-103: listRoutes reads @CandidateRoute from synthetic controllers, and a staff route has none', () => {
    @Controller('candidate')
    class CandidateController {
      @Post('run')
      @Public()
      @CandidateRoute('candidate_answer:run')
      run(): void {}

      @Get('staff')
      @Roles('AUTHOR')
      staff(): void {}
    }
    const modules = {
      values: () => [{ controllers: new Map([['c', { metatype: CandidateController }]]) }],
    } as unknown as ModulesContainer;
    const routes = listRoutes(modules);
    expect(routes.find((r) => r.key === 'POST /candidate/run')).toMatchObject({
      isPublic: true,
      roles: [],
      candidatePermission: 'candidate_answer:run',
    });
    expect(routes.find((r) => r.key === 'GET /candidate/staff')?.candidatePermission).toBeNull();
  });

  it('FR-103: ADR 0013: a CANDIDATE route with no route guard fails closed, one with a guard passes', () => {
    expect(withEntry(candidate, [{ ...base, guards: [] }]).join('\n')).toContain(
      `${KEY} is a CANDIDATE route with no route guard (@UseGuards(CandidateSessionGuard))`,
    );
    expect(withEntry(candidate, [base])).toEqual([]);
  });

  it('FR-103: listRoutes reads @UseGuards from the handler and the class', () => {
    class SomeGuard {}
    @Controller('candidate')
    @UseGuards(SomeGuard)
    @CandidateRoute('candidate_answer:run')
    class ClassLevel {
      @Get('mixed')
      @Roles('AUTHOR')
      mixed(): void {}
    }
    const modules = {
      values: () => [{ controllers: new Map([['c', { metatype: ClassLevel }]]) }],
    } as unknown as ModulesContainer;
    const route = listRoutes(modules).find((r) => r.key === 'GET /candidate/mixed');
    expect(route?.guards).toEqual([SomeGuard]);
    expect(route?.candidatePermission).toBe('candidate_answer:run');
    expect(
      withEntry(
        'public',
        [route as RegisteredRoute].map((r) => ({ ...r, key: KEY })),
      ).join('\n'),
    ).toContain('is a staff route (@Roles()) but carries @CandidateRoute()');
  });

  it('FR-103: a CANDIDATE entry whose permission CANDIDATE does not hold is reported', () => {
    const problems = withEntry({ principal: 'CANDIDATE', permission: 'question:read' }, [base]);
    expect(problems.join('\n')).toContain('which CANDIDATE does not hold');
  });

  it('FR-103: ADR 0013: a /candidate/ route listed plain public is reported unless it is a bootstrap route', () => {
    const key = 'GET /candidate/session/consent';
    const matrix = ROUTE_PERMISSIONS as Record<string, unknown>;
    matrix[key] = 'public';
    try {
      const route = { ...base, key, candidatePermission: null, guards: [] };
      expect(
        matrixProblems([route])
          .filter((p) => p.includes(key))
          .join('\n'),
      ).toContain('is a /candidate/ route listed public but is not a bootstrap route');
    } finally {
      delete matrix[key];
    }
  });
});
