// The org context: how it is set, that it follows async work, that it does not leak between
// requests, and that the interceptor fills it from request.user. No database.
import {
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  INestApplication,
  Injectable,
} from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import request from 'supertest';
import type { App } from 'supertest/types';
import { OrgContextMissingError, OrgScopeViolationError } from './errors';
import { OrgContextService, SYSTEM_SCOPE_REASONS } from './org-context';
import type { AuthenticatedUser, SystemScopeReason } from './org-context';
import { OrgContextInterceptor } from './org-context.interceptor';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const USER_A: AuthenticatedUser = {
  orgId: ORG_A,
  userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  role: 'RECRUITER',
};
const USER_B: AuthenticatedUser = {
  orgId: ORG_B,
  userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  role: 'REVIEWER',
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('OrgContextService (NFR-04, FR-103)', () => {
  const svc = new OrgContextService();

  it('TC-008 has no context outside a run', () => {
    expect(svc.current()).toBeUndefined();
    expect(() => svc.requireOrgId()).toThrow(OrgContextMissingError);
    expect(() => svc.requireUser()).toThrow(OrgContextMissingError);
  });

  it('TC-008 runAsUser sets the org and the user', () => {
    svc.runAsUser(USER_A, () => {
      expect(svc.requireOrgId()).toBe(ORG_A);
      expect(svc.requireUser()).toEqual(USER_A);
      expect(svc.current()?.scope).toEqual({ kind: 'org', orgId: ORG_A, user: USER_A });
    });
  });

  it('TC-008 runInOrg sets the org without a user (candidate routes and jobs)', () => {
    svc.runInOrg(ORG_B, () => {
      expect(svc.requireOrgId()).toBe(ORG_B);
      expect(() => svc.requireUser()).toThrow(OrgContextMissingError);
    });
  });

  it('TC-008 the context follows awaited work, timers and promise chains', async () => {
    const seen = await svc.runInOrg(ORG_A, async () => {
      const a = svc.requireOrgId();
      await sleep(5);
      const b = svc.requireOrgId();
      const c = await Promise.resolve().then(() => svc.requireOrgId());
      const d = await new Promise<string>((resolve) =>
        setImmediate(() => resolve(svc.requireOrgId())),
      );
      return [a, b, c, d];
    });
    expect(seen).toEqual([ORG_A, ORG_A, ORG_A, ORG_A]);
    expect(svc.current()).toBeUndefined();
  });

  it('TC-008 a lazy query returned from the callback is started inside the context', async () => {
    // Prisma queries send nothing until .then() is called. The caller awaits outside the callback,
    // so the service must start a returned thenable itself, while the context is still set.
    const lazyQuery = {
      then: (resolve: (orgId: string | undefined) => void): void => {
        const scope = svc.current()?.scope;
        resolve(scope?.kind === 'org' ? scope.orgId : undefined);
      },
    };
    await expect(svc.runInOrg(ORG_A, () => lazyQuery as unknown as Promise<string>)).resolves.toBe(
      ORG_A,
    );
    await expect(
      svc.runAsUser(USER_B, () => lazyQuery as unknown as Promise<string>),
    ).resolves.toBe(ORG_B);
    await expect(
      svc.runRawSql(
        'a reviewed raw query for the test',
        () => lazyQuery as unknown as Promise<string>,
      ),
    ).resolves.toBeUndefined();
  });

  it('TC-008 concurrent units of work keep separate contexts', async () => {
    const work = (orgId: string, delay: number): Promise<string[]> =>
      svc.runInOrg(orgId, async () => {
        const seen = [svc.requireOrgId()];
        await sleep(delay);
        seen.push(svc.requireOrgId());
        await sleep(delay);
        seen.push(svc.requireOrgId());
        return seen;
      });
    const runs = await Promise.all(
      Array.from({ length: 20 }, (_, i) => work(i % 2 === 0 ? ORG_A : ORG_B, 1 + (i % 5))),
    );
    runs.forEach((seen, i) => {
      const expected = i % 2 === 0 ? ORG_A : ORG_B;
      expect(seen).toEqual([expected, expected, expected]);
    });
  });

  it('TC-008 an org id that is not a uuid is refused', () => {
    expect(() => svc.runInOrg('', () => undefined)).toThrow(OrgScopeViolationError);
    expect(() => svc.runInOrg('org-1', () => undefined)).toThrow(OrgScopeViolationError);
    expect(() => svc.runAsUser({ ...USER_A, orgId: 'x' }, () => undefined)).toThrow(
      OrgScopeViolationError,
    );
  });

  it('TC-008 one unit of work cannot switch to another org', () => {
    svc.runInOrg(ORG_A, () => {
      expect(() => svc.runInOrg(ORG_B, () => undefined)).toThrow(OrgScopeViolationError);
      expect(() => svc.runAsUser(USER_B, () => undefined)).toThrow(OrgScopeViolationError);
      // The same org is fine, for example another user in the same request.
      expect(() => svc.runAsUser({ ...USER_A, role: 'AUTHOR' }, () => undefined)).not.toThrow();
    });
  });

  it('TC-008 system scope may narrow to one org, and has no org of its own', () => {
    svc.runSystem('BACKGROUND_JOB', () => {
      expect(svc.current()?.scope).toEqual({ kind: 'system', reason: 'BACKGROUND_JOB' });
      expect(() => svc.requireOrgId()).toThrow(OrgContextMissingError);
      svc.runInOrg(ORG_A, () => {
        expect(svc.requireOrgId()).toBe(ORG_A);
      });
    });
  });

  it('TC-008 an org scope cannot be widened to system scope', () => {
    svc.runInOrg(ORG_A, () => {
      expect(() => svc.runSystem('BACKGROUND_JOB', () => undefined)).toThrow(
        OrgScopeViolationError,
      );
    });
    svc.runAsUser(USER_B, () => {
      expect(() => svc.runSystem('AUTH_BOOTSTRAP', () => undefined)).toThrow(
        OrgScopeViolationError,
      );
    });
  });

  it('TC-008 runSystem accepts only the named reasons', () => {
    for (const reason of Object.keys(SYSTEM_SCOPE_REASONS) as SystemScopeReason[]) {
      expect(() => svc.runSystem(reason, () => undefined)).not.toThrow();
    }
    expect(() => svc.runSystem('because' as SystemScopeReason, () => undefined)).toThrow(
      OrgScopeViolationError,
    );
    expect(() => svc.runSystem('toString' as SystemScopeReason, () => undefined)).toThrow(
      OrgScopeViolationError,
    );
  });

  it('TC-008 runRawSql needs a written reason, and keeps the org scope that is active', () => {
    expect(() => svc.runRawSql('', () => undefined)).toThrow(OrgScopeViolationError);
    expect(() => svc.runRawSql('short', () => undefined)).toThrow(OrgScopeViolationError);
    svc.runInOrg(ORG_A, () => {
      svc.runRawSql('count sessions per day for the dashboard', () => {
        expect(svc.current()?.rawSqlReason).toBe('count sessions per day for the dashboard');
        expect(svc.requireOrgId()).toBe(ORG_A);
      });
      expect(svc.current()?.rawSqlReason).toBeUndefined();
    });
  });
});

// Stand-in for the BE-02 auth guard: it sets request.user from a header, the way the real guard
// sets it from a verified token.
@Injectable()
class FakeAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request & { user?: unknown }>();
    const header = req.headers['x-test-user'];
    if (typeof header === 'string') req.user = JSON.parse(header) as unknown;
    return true;
  }
}

@Controller('probe')
class ProbeController {
  constructor(private readonly orgContext: OrgContextService) {}

  @Get()
  async probe(): Promise<{ before?: string; after?: string; scope: string }> {
    const read = (): string | undefined => {
      const scope = this.orgContext.current()?.scope;
      return scope?.kind === 'org' ? scope.orgId : undefined;
    };
    const before = read();
    await sleep(25);
    const after = read();
    return { ...(before ? { before } : {}), ...(after ? { after } : {}), scope: String(before) };
  }
}

describe('OrgContextInterceptor (NFR-04, FR-103)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeController],
      providers: [
        OrgContextService,
        { provide: APP_GUARD, useClass: FakeAuthGuard },
        { provide: APP_INTERCEPTOR, useClass: OrgContextInterceptor },
      ],
    }).compile();
    app = moduleRef.createNestApplication<INestApplication<App>>({ logger: false });
    await app.listen(0);
  });

  afterAll(async () => {
    await app.close();
  });

  const asUser = (user: unknown): string => JSON.stringify(user);

  it('TC-008 runs the handler in the org of request.user, before and after an await', async () => {
    const res = await request(app.getHttpServer())
      .get('/probe')
      .set('x-test-user', asUser(USER_A))
      .expect(200);
    expect(res.body).toEqual({ before: ORG_A, after: ORG_A, scope: ORG_A });
  });

  it('TC-008 a route with no authenticated user runs with no org context', async () => {
    const res = await request(app.getHttpServer()).get('/probe').expect(200);
    expect(res.body).toEqual({ scope: 'undefined' });
  });

  it('TC-008 extra claims on request.user are ignored', async () => {
    const res = await request(app.getHttpServer())
      .get('/probe')
      .set('x-test-user', asUser({ ...USER_B, email: 'b@example.test', exp: 1 }))
      .expect(200);
    expect(res.body).toEqual({ before: ORG_B, after: ORG_B, scope: ORG_B });
  });

  it.each([
    ['no orgId', { userId: USER_A.userId, role: 'RECRUITER' }],
    ['an empty orgId', { ...USER_A, orgId: '' }],
    ['an orgId that is not a uuid', { ...USER_A, orgId: 'org-1' }],
    ['no userId', { orgId: ORG_A, role: 'RECRUITER' }],
    ['an unknown role', { ...USER_A, role: 'ROOT' }],
    ['a string instead of an object', 'admin'],
  ])(
    'TC-008 a request.user with %s is answered 401 and never reaches the handler',
    async (_name, user) => {
      await request(app.getHttpServer()).get('/probe').set('x-test-user', asUser(user)).expect(401);
    },
  );

  it("TC-008 concurrent requests from two orgs never see each other's context", async () => {
    const server = app.getHttpServer();
    const calls = Array.from({ length: 24 }, (_, i) => {
      const user = i % 2 === 0 ? USER_A : USER_B;
      return request(server)
        .get('/probe')
        .set('x-test-user', asUser(user))
        .then((res) => ({
          expected: user.orgId,
          body: res.body as { before?: string; after?: string },
        }));
    });
    for (const { expected, body } of await Promise.all(calls)) {
      expect(body).toMatchObject({ before: expected, after: expected });
    }
  });
});
