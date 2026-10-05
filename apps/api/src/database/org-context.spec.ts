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
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import request from 'supertest';
import type { App } from 'supertest/types';
import { Public, Roles } from '../common/auth/decorators';
import { JwtAuthGuard } from '../common/auth/jwt-auth.guard';
import { TokenModule, TokenService } from '../common/auth/token.service';
import type { UserRole } from '../generated/prisma/enums.js';
import { OrgContextMissingError, OrgScopeViolationError } from './errors';
import { OrgContextService, SYSTEM_SCOPE_REASONS } from './org-context';
import type { AuthenticatedUser, SystemScopeReason } from './org-context';
import { OrgContextInterceptor } from './org-context.interceptor';
import { PrismaService } from './prisma.module';
import { staffBearer } from './testing/staff-token';

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
      svc.runInOrg(ORG_A, () =>
        svc.runRawSql(
          'a reviewed raw query for the test',
          () => lazyQuery as unknown as Promise<string>,
        ),
      ),
    ).resolves.toBe(ORG_A);
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

  it('TC-008 an open runRawSql carries into a nested scope (so wrap only the single statement)', () => {
    const reason = 'one reviewed raw statement, nothing else';
    svc.runSystem('BACKGROUND_JOB', () => {
      svc.runRawSql(reason, () => {
        svc.runInOrg(ORG_A, () => {
          expect(svc.current()?.rawSqlReason).toBe(reason);
        });
        svc.runAsUser(USER_A, () => {
          expect(svc.current()?.rawSqlReason).toBe(reason);
        });
      });
      // Outside the block the hatch is closed again.
      svc.runInOrg(ORG_A, () => {
        expect(svc.current()?.rawSqlReason).toBeUndefined();
      });
    });
  });

  it('TC-008 runRawSql needs an active scope: with none it throws, and the hatch alone is not a scope', () => {
    const reason = 'a reviewed raw statement for the test';
    expect(() => svc.runRawSql(reason, () => undefined)).toThrow(OrgContextMissingError);
    svc.runSystem('BACKGROUND_JOB', () => {
      expect(() => svc.runRawSql(reason, () => undefined)).not.toThrow();
    });
    svc.runInOrg(ORG_A, () => {
      expect(() => svc.runRawSql(reason, () => undefined)).not.toThrow();
    });
  });

  it('TC-008 runRawSql needs a written reason, and keeps the org scope that is active', () => {
    svc.runInOrg(ORG_A, () => {
      expect(() => svc.runRawSql('', () => undefined)).toThrow(OrgScopeViolationError);
      expect(() => svc.runRawSql('short', () => undefined)).toThrow(OrgScopeViolationError);
    });
    svc.runInOrg(ORG_A, () => {
      svc.runRawSql('count sessions per day for the dashboard', () => {
        expect(svc.current()?.rawSqlReason).toBe('count sessions per day for the dashboard');
        expect(svc.requireOrgId()).toBe(ORG_A);
      });
      expect(svc.current()?.rawSqlReason).toBeUndefined();
    });
  });
});

// What a handler sees of the context, as JSON.
interface Seen {
  before?: string;
  after?: string;
  userId?: string;
  role?: string;
}

const ALL_ROLES: UserRole[] = ['SUPER_ADMIN', 'RECRUITER', 'AUTHOR', 'REVIEWER'];

function readContext(svc: OrgContextService): Seen {
  const scope = svc.current()?.scope;
  if (scope?.kind !== 'org') return {};
  return {
    before: scope.orgId,
    ...(scope.user ? { userId: scope.user.userId, role: scope.user.role } : {}),
  };
}

// A staff route and a public route, as BE-02 declares them (deny by default: @Roles or @Public).
@Controller('probe')
class ProbeController {
  constructor(private readonly orgContext: OrgContextService) {}

  @Get()
  @Roles(...ALL_ROLES)
  async staff(): Promise<Seen> {
    const seen = readContext(this.orgContext);
    await sleep(25);
    const scope = this.orgContext.current()?.scope;
    return { ...seen, ...(scope?.kind === 'org' ? { after: scope.orgId } : {}) };
  }

  @Get('public')
  @Public()
  open(): { scope: 'none' | 'org' | 'system' } {
    return { scope: this.orgContext.current()?.scope?.kind ?? 'none' };
  }
}

const SECRET = 'a-secret-for-the-interceptor-tests-only';

// The real guard re-reads the user on every request (FU-BE-19) through BE-02's PrismaService. This
// spec needs no database, so that service is a stand-in holding the two users; the guard itself is
// the real one, checking is_active, role, org and the pwv claim against these rows. The same guard
// runs against a real database in tc-008-org-isolation.spec.ts.
const USER_ROWS = new Map(
  [
    { user: USER_A, passwordHash: 'unit-test-hash-a' },
    { user: USER_B, passwordHash: 'unit-test-hash-b' },
  ].map(({ user, passwordHash }) => [
    user.userId,
    { isActive: true, role: user.role, orgId: user.orgId, passwordHash },
  ]),
);
const GuardUserLookup = {
  client: {
    user: {
      findUnique: ({ where }: { where: { id: string } }) =>
        Promise.resolve(USER_ROWS.get(where.id) ?? null),
    },
  },
} as unknown as PrismaService;

describe('OrgContextInterceptor with the real JwtAuthGuard (BE-02, NFR-04, FR-103)', () => {
  let app: INestApplication<App>;
  let tokens: TokenService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ JWT_ACCESS_SECRET: SECRET })],
        }),
        TokenModule,
      ],
      controllers: [ProbeController],
      providers: [
        OrgContextService,
        { provide: PrismaService, useValue: GuardUserLookup },
        // The same order as AppModule: the guard authenticates, then the interceptor reads the user.
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_INTERCEPTOR, useClass: OrgContextInterceptor },
      ],
    }).compile();
    app = moduleRef.createNestApplication<INestApplication<App>>({ logger: false });
    await app.listen(0);
    tokens = app.get(TokenService);
  });

  afterAll(async () => {
    await app.close();
  });

  /** A real staff token, with the claims BE-02's AuthService signs. */
  const bearer = (user: AuthenticatedUser, kind: 'access' | 'challenge' = 'access'): string =>
    staffBearer(
      tokens,
      {
        userId: user.userId,
        orgId: user.orgId,
        userRole: user.role,
        passwordHash: USER_ROWS.get(user.userId)?.passwordHash ?? '',
      },
      kind,
      60,
    );

  it('TC-008 guards run before interceptors: the handler runs in the org the guard put on request.user', async () => {
    const res = await request(app.getHttpServer())
      .get('/probe')
      .set('Authorization', bearer(USER_A))
      .expect(200);
    expect(res.body).toEqual({
      before: ORG_A,
      after: ORG_A,
      userId: USER_A.userId,
      role: 'RECRUITER',
    });
  });

  it('TC-008 AuthUser.id becomes the context user id, and the role is carried over', async () => {
    const res = await request(app.getHttpServer())
      .get('/probe')
      .set('Authorization', bearer(USER_B))
      .expect(200);
    expect(res.body).toMatchObject({ before: ORG_B, userId: USER_B.userId, role: 'REVIEWER' });
  });

  it('TC-008 a @Public() route has no request.user, so it runs with no org context', async () => {
    const res = await request(app.getHttpServer()).get('/probe/public').expect(200);
    expect(res.body).toEqual({ scope: 'none' });
    // Even with a valid token: the guard returns early on a public route and sets no user.
    const withToken = await request(app.getHttpServer())
      .get('/probe/public')
      .set('Authorization', bearer(USER_A))
      .expect(200);
    expect(withToken.body).toEqual({ scope: 'none' });
  });

  it('TC-008 a staff route without a token, with a bad token, or with a 2FA challenge token is 401 and never runs', async () => {
    const server = app.getHttpServer();
    await request(server).get('/probe').expect(401);
    await request(server).get('/probe').set('Authorization', 'Bearer not-a-token').expect(401);
    await request(server)
      .get('/probe')
      .set('Authorization', bearer(USER_A, 'challenge'))
      .expect(401);
  });

  it("TC-008 concurrent requests from two orgs never see each other's context", async () => {
    const server = app.getHttpServer();
    const calls = Array.from({ length: 24 }, (_, i) => {
      const user = i % 2 === 0 ? USER_A : USER_B;
      return request(server)
        .get('/probe')
        .set('Authorization', bearer(user))
        .then((res) => ({ expected: user.orgId, body: res.body as Seen }));
    });
    for (const { expected, body } of await Promise.all(calls)) {
      expect(body).toMatchObject({ before: expected, after: expected });
    }
  });
});

// Stand-in guard that sets request.user from a header, to feed the interceptor shapes the real
// guard never produces. The interceptor checks request.user itself and fails closed.
@Injectable()
class FakeAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request & { user?: unknown }>();
    const header = req.headers['x-test-user'];
    if (typeof header === 'string') req.user = JSON.parse(header) as unknown;
    return true;
  }
}

@Controller('fake')
class FakeProbeController {
  constructor(private readonly orgContext: OrgContextService) {}

  @Get()
  probe(): Seen {
    return readContext(this.orgContext);
  }
}

describe('OrgContextInterceptor checks request.user itself (NFR-04, FR-103)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [FakeProbeController],
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

  // BE-02's AuthUser.
  const authUser = { id: USER_A.userId, orgId: ORG_A, role: 'RECRUITER', kind: 'access' };
  const send = (user: unknown): request.Test =>
    request(app.getHttpServer()).get('/fake').set('x-test-user', JSON.stringify(user));

  it('TC-008 a valid AuthUser sets the context, and extra claims are ignored', async () => {
    const res = await send({ ...authUser, email: 'a@example.test', exp: 1 }).expect(200);
    expect(res.body).toEqual({ before: ORG_A, userId: USER_A.userId, role: 'RECRUITER' });
  });

  it('TC-008 no request.user at all runs with no context', async () => {
    const res = await request(app.getHttpServer()).get('/fake').expect(200);
    expect(res.body).toEqual({});
  });

  it.each([
    ['no orgId', { id: USER_A.userId, role: 'RECRUITER', kind: 'access' }],
    ['an empty orgId', { ...authUser, orgId: '' }],
    ['an orgId that is not a uuid', { ...authUser, orgId: 'org-1' }],
    ['no id', { orgId: ORG_A, role: 'RECRUITER', kind: 'access' }],
    ['an unknown role', { ...authUser, role: 'ROOT' }],
    ['a 2FA challenge kind', { ...authUser, kind: 'challenge' }],
    ['no kind', { id: USER_A.userId, orgId: ORG_A, role: 'RECRUITER' }],
    ['the context shape (userId, no id or kind)', { ...USER_A }],
    ['a string instead of an object', 'admin'],
  ])(
    'TC-008 a request.user with %s is answered 401 and never reaches the handler',
    async (_name, user) => {
      await send(user).expect(401);
    },
  );
});
