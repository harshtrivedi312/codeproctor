// Single invitation (FR-303, TC-004, TC-006, TC-008) against real Postgres 16 and Redis
// (Testcontainers), the API running as app_user as in production (ADR 0006). The INVITED session
// port is a fake that writes through the transaction it is handed (the real adapter is Backend B's
// SessionStateService, PR #98); the mail port is a fake that records what it was asked to send.
import { INestApplication } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { Client } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';
import { passwordVersion } from '../auth/crypto.util';
import type { TokenService } from '../common/auth/token.service';
import { createPrismaClient } from '../database/create-prisma-client';
import { PrismaClient, UserRole } from '../generated/prisma/client';
import { applyEnv, applyMigrations, startInfra } from '../test/containers';
import type { TestInfra } from '../test/containers';
import type { InvitedSessionDb } from './invited-session.port';

const API = '/api/v1';
const GHOST = '00000000-0000-4000-8000-000000000042';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

type Json = Record<string, unknown>;

function stable(res: request.Response): Json {
  const { traceId: _t, instance: _i, ...rest } = res.body as Json;
  void _t;
  void _i;
  return rest;
}

const sha256 = (v: string): string => createHash('sha256').update(v).digest('hex');
const iso = (ms: number): string => new Date(ms).toISOString();

describe('Single invitation (FR-303, TC-004, TC-006, TC-008)', () => {
  let infra: TestInfra;
  let app: INestApplication<App>;
  let owner: PrismaClient;
  let pg: Client;
  let orgA: string;
  let orgB: string;
  let tokens: TokenService;
  let seq = 0;

  // Fakes, reset per test.
  interface SentMail {
    to: string;
    inviteUrl: string;
    windowStartsAt: Date;
    windowEndsAt: Date;
  }
  let sent: SentMail[];
  let mailMode: 'queued' | 'failed' | 'disabled' | 'throw';
  let portMode: 'ok' | 'fail';
  let portCalls: number;
  /** Runs after the fake mail answered 'queued'; a test uses it to break the sent_at stamp. */
  let afterMail: ((to: string) => Promise<void>) | null;
  let HttpErrors: typeof import('@nestjs/common');

  beforeAll(async () => {
    infra = await startInfra();
    await applyMigrations(infra);
    const appPassword = randomBytes(18).toString('hex');
    pg = new Client({ connectionString: infra.postgres.getConnectionUri() });
    await pg.connect();
    await pg.query(`ALTER ROLE app_user PASSWORD '${appPassword}'`);
    const url = `postgresql://app_user:${appPassword}@${infra.postgres.getHost()}:${infra.postgres.getMappedPort(5432)}/${infra.postgres.getDatabase()}`;
    applyEnv(infra, { DATABASE_URL: url, LOG_LEVEL: 'silent', THROTTLE_DEFAULT_LIMIT: '10000' });
    owner = createPrismaClient(infra.postgres.getConnectionUri());
    orgA = (await owner.organization.create({ data: { name: 'Org A' } })).id;
    orgB = (await owner.organization.create({ data: { name: 'Org B' } })).id;

    jest.resetModules();
    HttpErrors = jest.requireActual<typeof import('@nestjs/common')>('@nestjs/common');
    app = await build();
    const { TokenService: Tokens } = jest.requireActual<
      typeof import('../common/auth/token.service')
    >('../common/auth/token.service');
    tokens = app.get(Tokens);
  });

  /** Boots the app with the fakes; the log level comes from process.env.LOG_LEVEL at call time. */
  async function build(): Promise<INestApplication<App>> {
    const { AppModule } = jest.requireActual<typeof import('../app.module')>('../app.module');
    const { Test } = jest.requireActual<typeof import('@nestjs/testing')>('@nestjs/testing');
    const { configureApp } = jest.requireActual<typeof import('../bootstrap')>('../bootstrap');
    const { MailPort } =
      jest.requireActual<typeof import('../mail/mail.port')>('../mail/mail.port');
    const { INVITED_SESSION_PORT } =
      jest.requireActual<typeof import('./invited-session.port')>('./invited-session.port');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MailPort)
      .useValue({
        sendInvitation: (
          to: string,
          m: { inviteUrl: string; windowStartsAt: Date; windowEndsAt: Date },
        ): Promise<string> => {
          sent.push({ to, ...m });
          if (mailMode === 'throw') {
            return Promise.reject(new Error(`SES refused ${to} for ${m.inviteUrl}`));
          }
          return (afterMail ? afterMail(to) : Promise.resolve()).then(() => mailMode);
        },
      })
      .overrideProvider(INVITED_SESSION_PORT)
      .useValue({
        createInvited: async (
          ids: { orgId: string; invitationId: string },
          tx: InvitedSessionDb,
        ): Promise<{ id: string }> => {
          portCalls += 1;
          if (portMode === 'fail') {
            throw new HttpErrors.ServiceUnavailableException('Invitations are not available yet.');
          }
          // Stands in for SessionStateService.createInvited: INVITED is the column default.
          const s = await tx.session.create({
            data: { orgId: ids.orgId, invitationId: ids.invitationId },
          });
          return { id: s.id };
        },
      })
      .compile();
    const built = moduleRef.createNestApplication<INestApplication<App>>();
    configureApp(built);
    await built.init();
    await built.listen(0);
    return built;
  }

  beforeEach(() => {
    sent = [];
    mailMode = 'queued';
    portMode = 'ok';
    portCalls = 0;
    afterMail = null;
  });

  afterAll(async () => {
    await app?.close();
    await owner?.$disconnect();
    await pg?.end();
    await infra?.stop();
  });

  interface Made {
    id: string;
    auth: { Authorization: string };
  }

  async function make(role: UserRole, orgId = orgA): Promise<Made> {
    const n = ++seq;
    const passwordHash = `hash-${n}`;
    const user = await owner.user.create({
      data: {
        orgId,
        email: `inv-staff${n}@example.com`,
        fullName: `Staff ${n}`,
        role,
        passwordHash,
      },
    });
    const token = tokens.sign(
      { sub: user.id, org: orgId, role, kind: 'access', pwv: passwordVersion(passwordHash) },
      900,
    );
    return { id: user.id, auth: { Authorization: `Bearer ${token}` } };
  }

  const http = (): ReturnType<typeof request> => request(app.getHttpServer());

  async function seedQuestion(
    o: { tags?: string[]; orgId?: string } = {},
  ): Promise<{ questionId: string; versionId: string }> {
    const n = ++seq;
    const q = await owner.question.create({
      data: { orgId: o.orgId ?? orgA, slug: `iq-${n}`, type: 'CODING', tags: o.tags ?? [] },
    });
    const v = await owner.questionVersion.create({
      data: {
        questionId: q.id,
        version: 1,
        title: `Question ${n}`,
        statementMd: 'Do it.',
        difficulty: 'EASY',
        allowedLanguages: ['python'],
        isPublished: true,
      },
    });
    await owner.question.update({ where: { id: q.id }, data: { currentVersionId: v.id } });
    return { questionId: q.id, versionId: v.id };
  }

  /** A saved test of org A (through the API as the given staff member). */
  async function makeTest(who: Made, randomTag?: string): Promise<string> {
    const slot = randomTag
      ? { randomRule: { tags: [randomTag] } }
      : { questionVersionId: (await seedQuestion()).versionId };
    const res = await http()
      .post(`${API}/tests`)
      .set(who.auth)
      .send({
        name: 'Invite me',
        durationMinutes: 60,
        sections: [{ title: 'S', questions: [slot] }],
      });
    expect(res.status).toBe(201);
    return (res.body as Json).id as string;
  }

  const email = (): string => `cand.${++seq}@Example.org`;
  // The body the web dialog sends. `email` and `fullName` in `over` are shorthand for the nested
  // candidate fields; `candidate` replaces the whole object.
  const goodBody = (over: Json = {}): Json => {
    const { email: e, fullName, ...rest } = over;
    const candidate = { email: email(), name: 'Ada Lovelace' } as Json;
    if ('email' in over) candidate.email = e;
    if ('fullName' in over) candidate.name = fullName;
    return {
      candidate,
      windowStart: iso(Date.now()),
      windowEnd: iso(Date.now() + 2 * DAY),
      ...rest,
    };
  };
  const invite = (who: Made, testId: string, b: Json): request.Test =>
    http().post(`${API}/tests/${testId}/invitations`).set(who.auth).send(b);

  async function auditRows(entityId: string): Promise<Json[]> {
    const r = await pg.query(
      `SELECT org_id, actor_id, entity_type, action, metadata FROM audit_logs WHERE entity_id = $1 ORDER BY id`,
      [entityId],
    );
    return r.rows as Json[];
  }

  // ---- happy path ---------------------------------------------------------------------------------

  describe('FR-303: create', () => {
    it('FR-303, TC-006: creates candidate, hashed-token invitation, INVITED session, audit row, then mails once', async () => {
      const who = await make(UserRole.RECRUITER);
      const testId = await makeTest(who);
      const b = goodBody({ email: '  Ada.Mixed@Example.ORG ' });
      const start = Date.now() + HOUR;
      const res = await invite(who, testId, { ...b, windowStart: iso(start) });
      expect([res.status, res.body]).toEqual([201, expect.anything()]);
      const body = res.body as Json;
      expect(Object.keys(body).sort()).toEqual(
        [
          'candidateId',
          'createdAt',
          'id',
          'mail',
          'status',
          'testId',
          'windowEnd',
          'windowStart',
        ].sort(),
      );
      expect(body.mail).toBe('queued');
      expect(body.status).toBe('INVITED');
      expect(body.testId).toBe(testId);
      expect(body.windowStart).toBe(iso(start));

      const cand = await owner.candidate.findUniqueOrThrow({
        where: { id: body.candidateId as string },
      });
      expect(cand).toMatchObject({
        orgId: orgA,
        email: 'ada.mixed@example.org',
        fullName: 'Ada Lovelace',
        externalRef: null,
      });
      const inv = await owner.invitation.findUniqueOrThrow({ where: { id: body.id as string } });
      expect(inv).toMatchObject({
        orgId: orgA,
        testId,
        candidateId: cand.id,
        createdById: who.id,
        usedAt: null,
      });
      expect(inv.sentAt).not.toBeNull();
      const session = await owner.session.findFirstOrThrow({ where: { invitationId: inv.id } });
      expect(session).toMatchObject({ orgId: orgA, status: 'INVITED' });

      expect(sent).toHaveLength(1);
      expect(sent[0]?.to).toBe('ada.mixed@example.org');
      const m = /^http:\/\/localhost:3000\/t#([A-Za-z0-9_-]{43})$/.exec(sent[0]?.inviteUrl ?? '');
      expect(m).not.toBeNull();
      const token = m?.[1] ?? '';
      expect(inv.tokenHash).toBe(sha256(token));
      expect(inv.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(sent[0]?.windowStartsAt.toISOString()).toBe(iso(start));

      const rows = await auditRows(inv.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        org_id: orgA,
        actor_id: who.id,
        entity_type: 'invitation',
        action: 'INVITATION_CREATED',
      });
      expect(Object.keys(rows[0]?.metadata as Json).sort()).toEqual(
        ['candidateId', 'testId', 'windowEnd', 'windowStart'].sort(),
      );
    });

    it('FR-303: an existing candidate of the same org is reused (case-insensitive) and keeps its name', async () => {
      const who = await make(UserRole.RECRUITER);
      const t1 = await makeTest(who);
      const t2 = await makeTest(who);
      const addr = email();
      const first = await invite(who, t1, goodBody({ email: addr, fullName: 'First Name' }));
      const second = await invite(
        who,
        t2,
        goodBody({ email: addr.toUpperCase(), fullName: 'Other Name' }),
      );
      expect([first.status, second.status]).toEqual([201, 201]);
      expect((second.body as Json).candidateId).toBe((first.body as Json).candidateId);
      const cand = await owner.candidate.findUniqueOrThrow({
        where: { id: (first.body as Json).candidateId as string },
      });
      expect(cand.fullName).toBe('First Name');
    });

    it('FR-303: a second active invitation for the same candidate and test is 409 and writes nothing; an expired or used one does not block', async () => {
      const who = await make(UserRole.RECRUITER);
      const testId = await makeTest(who);
      const addr = email();
      expect((await invite(who, testId, goodBody({ email: addr }))).status).toBe(201);
      const before = await owner.invitation.count({ where: { testId } });
      const audits = await owner.auditLog.count();
      const dup = await invite(who, testId, goodBody({ email: addr }));
      expect(dup.status).toBe(409);
      expect((dup.body as Json).detail).toBe(
        'This candidate already has an active invitation for this test.',
      );
      expect(await owner.invitation.count({ where: { testId } })).toBe(before);
      expect(await owner.auditLog.count()).toBe(audits);
      expect(sent).toHaveLength(1);
      // Once the first is used it no longer blocks.
      await owner.invitation.updateMany({ where: { testId }, data: { usedAt: new Date() } });
      expect((await invite(who, testId, goodBody({ email: addr }))).status).toBe(201);
    });

    it.each([
      ['erasureRequestedAt', { erasureRequestedAt: new Date() }],
      ['erasedAt', { erasedAt: new Date() }],
    ])(
      'FR-303: a candidate with %s set cannot be invited (fixed 409, no address echo)',
      async (_n, flag) => {
        const who = await make(UserRole.RECRUITER);
        const testId = await makeTest(who);
        const addr = email();
        await owner.candidate.create({
          data: { orgId: orgA, email: addr.toLowerCase(), fullName: 'Gone', ...flag },
        });
        const res = await invite(who, testId, goodBody({ email: addr }));
        expect(res.status).toBe(409);
        expect((res.body as Json).detail).toBe('This candidate cannot be invited.');
        expect(JSON.stringify(res.body).toLowerCase()).not.toContain(addr.toLowerCase());
        expect(sent).toHaveLength(0);
        expect(await owner.invitation.count({ where: { testId } })).toBe(0);
      },
    );

    it('FR-303: a sent_at stamp that fails still answers 201 with mail queued', async () => {
      const who = await make(UserRole.RECRUITER);
      const testId = await makeTest(who);
      const addr = email();
      // After the mail, the invitation disappears, so the stamp finds no row.
      afterMail = async (to) => {
        const c = await owner.candidate.findFirstOrThrow({ where: { email: to, orgId: orgA } });
        const invs = await owner.invitation.findMany({ where: { candidateId: c.id } });
        await owner.session.deleteMany({ where: { invitationId: { in: invs.map((i) => i.id) } } });
        await owner.invitation.deleteMany({ where: { candidateId: c.id } });
      };
      const res = await invite(who, testId, goodBody({ email: addr }));
      expect([res.status, (res.body as Json).mail]).toEqual([201, 'queued']);
    });
  });

  // ---- validation ---------------------------------------------------------------------------------

  describe('FR-303: validation', () => {
    const bad: [string, (n: number) => Json][] = [
      ['no email', () => ({ email: undefined })],
      ['bad email', () => ({ email: 'not-an-email' })],
      ['quoted local part with CRLF', () => ({ email: '"a\r\nb"@example.org' })],
      ['quoted local part', () => ({ email: '"ab"@example.org' })],
      ['local part with a bidi override', () => ({ email: 'ab\u202Ecd@example.org' })],
      ['UTF-8 local part', () => ({ email: 'j\u00F6rg@example.org' })],
      ['null email', () => ({ email: null })],
      ['email over 254', () => ({ email: `${'a'.repeat(250)}@x.org` })],
      ['no name', () => ({ fullName: undefined })],
      ['empty name', () => ({ fullName: '   ' })],
      ['name over 200', () => ({ fullName: 'n'.repeat(201) })],
      ['name with NUL', () => ({ fullName: 'a\u0000b' })],
      ['name with lone surrogate', () => ({ fullName: 'a\ud800b' })],
      ['name is a number', () => ({ fullName: 5 })],
      ['no windowStart', () => ({ windowStart: undefined })],
      ['no candidate', () => ({ candidate: undefined })],
      ['candidate null', () => ({ candidate: null })],
      ['candidate a string', () => ({ candidate: 'ada@example.org' })],
      ['candidate an array', () => ({ candidate: [] })],
      [
        'candidate with fullName instead of name',
        () => ({ candidate: { email: 'a@example.org', fullName: 'Ada' } }),
      ],
      [
        'candidate with externalRef',
        () => ({ candidate: { email: 'a@example.org', name: 'Ada', externalRef: 'x' } }),
      ],
      ['top-level externalRef', () => ({ externalRef: 'ATS-1' })],
      ['no windowEnd', () => ({ windowEnd: undefined })],
      ['windowEnd not a date', () => ({ windowEnd: 'tomorrow' })],
      ['windowEnd without offset', () => ({ windowEnd: '2099-01-01T00:00:00' })],
      ['windowEnd a number', () => ({ windowEnd: Date.now() + DAY })],
      ['windowStart null', () => ({ windowStart: null })],
      ['windowEnd in the past', () => ({ windowEnd: iso(Date.now() - HOUR) })],
      [
        'windowEnd before windowStart',
        () => ({ windowStart: iso(Date.now() + 2 * HOUR), windowEnd: iso(Date.now() + HOUR) }),
      ],
      [
        'windowEnd equals windowStart',
        () => ({ windowStart: iso(Date.now() + HOUR), windowEnd: iso(Date.now() + HOUR) }),
      ],
      [
        'window over 7 days',
        () => ({
          windowStart: iso(Date.now() + HOUR),
          windowEnd: iso(Date.now() + HOUR + 7 * DAY + 1000),
        }),
      ],
      [
        'windowStart over a year ahead',
        () => ({
          windowStart: iso(Date.now() + 400 * DAY),
          windowEnd: iso(Date.now() + 401 * DAY),
        }),
      ],
      [
        'windowStart more than 5 minutes in the past',
        () => ({ windowStart: iso(Date.now() - 10 * 60_000), windowEnd: iso(Date.now() + DAY) }),
      ],
      ['name with a newline', () => ({ fullName: 'Ada\nLovelace' })],
      ['name with a C1 control', () => ({ fullName: 'Ada\u0085Lovelace' })],
      ['name with a bidi override', () => ({ fullName: 'Ada\u202Eevol' })],
      ['name with a bidi isolate', () => ({ fullName: 'Ada\u2066x' })],
      ['unknown field', () => ({ allowDuplicate: true })],
      [
        'mass assignment of orgId, tokenHash and createdById',
        () => ({ orgId: GHOST, tokenHash: 'a'.repeat(64), createdById: GHOST }),
      ],
      ['accommodations are not part of this route', () => ({ accommodations: {} })],
    ];

    it.each(bad)('FR-303: 400 for %s, nothing written, no mail', async (_name, over) => {
      const who = await make(UserRole.RECRUITER);
      const testId = await makeTest(who);
      const cands = await owner.candidate.count();
      const res = await invite(who, testId, goodBody(over(0)));
      expect(res.status).toBe(400);
      expect(await owner.candidate.count()).toBe(cands);
      expect(await owner.invitation.count({ where: { testId } })).toBe(0);
      expect(sent).toHaveLength(0);
    });

    it('FR-303: the old flat body { email, fullName, windowEnd } is 400 (the contract is the nested candidate)', async () => {
      const who = await make(UserRole.RECRUITER);
      const testId = await makeTest(who);
      const res = await invite(who, testId, {
        email: email(),
        fullName: 'Ada Lovelace',
        windowEnd: iso(Date.now() + DAY),
      });
      expect(res.status).toBe(400);
      expect(await owner.invitation.count({ where: { testId } })).toBe(0);
    });

    it.each([
      ['no email', { name: 'Ada' }, 'candidate.email'],
      ['bad email', { email: 'nope', name: 'Ada' }, 'candidate.email'],
      ['no name', { email: 'a@example.org' }, 'candidate.name'],
      ['empty name', { email: 'a@example.org', name: ' ' }, 'candidate.name'],
      ['name with a newline', { email: 'a@example.org', name: 'A\nB' }, 'candidate.name'],
    ])('FR-303: nested candidate error for %s names %s', async (_n, candidate, field) => {
      const who = await make(UserRole.RECRUITER);
      const testId = await makeTest(who);
      const res = await invite(who, testId, goodBody({ candidate }));
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain(field);
    });

    it('FR-303: the exact body the web dialog sends (candidate, start truncated to the minute, end = start + 7 days, ISO Z) is 201 with the web response shape', async () => {
      const who = await make(UserRole.RECRUITER);
      const testId = await makeTest(who);
      const start = new Date(Math.floor(Date.now() / 60_000) * 60_000);
      const end = new Date(start.getTime() + 7 * DAY);
      const res = await invite(who, testId, {
        candidate: { email: email(), name: 'Dialog Person' },
        windowStart: start.toISOString(),
        windowEnd: end.toISOString(),
      });
      expect(res.status).toBe(201);
      const body = res.body as Json;
      expect(body).toMatchObject({
        testId,
        status: 'INVITED',
        windowStart: start.toISOString(),
        windowEnd: end.toISOString(),
        mail: 'queued',
      });
      expect(Object.keys(body).sort()).toEqual(
        [
          'candidateId',
          'createdAt',
          'id',
          'mail',
          'status',
          'testId',
          'windowEnd',
          'windowStart',
        ].sort(),
      );
    });

    it('FR-303: a windowStart a few seconds in the past is accepted', async () => {
      const who = await make(UserRole.RECRUITER);
      const testId = await makeTest(who);
      const res = await invite(
        who,
        testId,
        goodBody({ windowStart: iso(Date.now() - 5_000), windowEnd: iso(Date.now() + DAY) }),
      );
      expect(res.status).toBe(201);
    });

    it('FR-303: a windowStart a minute in the past (clock skew) is accepted', async () => {
      const who = await make(UserRole.RECRUITER);
      const testId = await makeTest(who);
      const res = await invite(
        who,
        testId,
        goodBody({ windowStart: iso(Date.now() - 60_000), windowEnd: iso(Date.now() + DAY) }),
      );
      expect(res.status).toBe(201);
    });

    it('FR-303: a window of exactly 7 days is accepted', async () => {
      const who = await make(UserRole.RECRUITER);
      const testId = await makeTest(who);
      const start = Date.now() + HOUR;
      const res = await invite(
        who,
        testId,
        goodBody({ windowStart: iso(start), windowEnd: iso(start + 7 * DAY) }),
      );
      expect(res.status).toBe(201);
    });

    it('FR-303: a malformed test id is 400', async () => {
      const who = await make(UserRole.RECRUITER);
      await invite(who, 'not-a-uuid', goodBody()).expect(400);
    });
  });

  // ---- test lookup and satisfiability --------------------------------------------------------------

  describe('FR-303, TC-008: the test', () => {
    it('TC-008: a missing test and another org test are the same 404', async () => {
      const a = await make(UserRole.RECRUITER);
      const b = await make(UserRole.RECRUITER, orgB);
      const bTest = await owner.test.create({
        data: { orgId: orgB, name: 'B test', durationMinutes: 30, createdById: b.id },
      });
      const cands = await owner.candidate.count();
      const other = await invite(a, bTest.id, goodBody());
      const ghost = await invite(a, GHOST, goodBody());
      expect([other.status, ghost.status]).toEqual([404, 404]);
      expect(stable(other)).toEqual(stable(ghost));
      expect(await owner.candidate.count()).toBe(cands);
      expect(await owner.invitation.count({ where: { testId: bTest.id } })).toBe(0);
      expect(sent).toHaveLength(0);
    });

    it('FR-303: an unsatisfiable test is 422 naming slot positions only, nothing is written', async () => {
      const who = await make(UserRole.RECRUITER);
      const tag = `inv-${++seq}`;
      const q = await seedQuestion({ tags: [tag] });
      const testId = await makeTest(who, tag);
      await owner.question.update({ where: { id: q.questionId }, data: { isArchived: true } });
      const cands = await owner.candidate.count();
      const audits = await owner.auditLog.count();
      const res = await invite(who, testId, goodBody());
      expect(res.status).toBe(422);
      expect(JSON.stringify(res.body)).toMatch(
        /sections\[0\]\.questions\[0\]\.randomRule matches 0/,
      );
      expect(await owner.candidate.count()).toBe(cands);
      expect(await owner.invitation.count({ where: { testId } })).toBe(0);
      expect(await owner.auditLog.count()).toBe(audits);
      expect(portCalls).toBe(0);
      expect(sent).toHaveLength(0);
    });
  });

  // ---- roles and org isolation ---------------------------------------------------------------------

  describe('TC-004, TC-008: roles and organizations', () => {
    it('TC-004: RECRUITER and SUPER_ADMIN may invite; AUTHOR and REVIEWER get 403; no token is 401', async () => {
      const r = await make(UserRole.RECRUITER);
      const testId = await makeTest(r);
      for (const role of [UserRole.RECRUITER, UserRole.SUPER_ADMIN]) {
        const who = await make(role);
        expect((await invite(who, testId, goodBody())).status).toBe(201);
      }
      const before = await owner.invitation.count({ where: { testId } });
      for (const role of [UserRole.AUTHOR, UserRole.REVIEWER]) {
        const who = await make(role);
        expect((await invite(who, testId, goodBody())).status).toBe(403);
      }
      await http().post(`${API}/tests/${testId}/invitations`).send(goodBody()).expect(401);
      expect(await owner.invitation.count({ where: { testId } })).toBe(before);
    });

    it('TC-008: another org candidate of the same address is invisible; org A gets its own candidate and the response looks the same', async () => {
      const a = await make(UserRole.RECRUITER);
      const testA1 = await makeTest(a);
      const testA2 = await makeTest(a);
      const addrFree = email();
      const addrTaken = email();
      const theirs = await owner.candidate.create({
        data: { orgId: orgB, email: addrTaken.toLowerCase(), fullName: 'Org B Person' },
      });
      const free = await invite(a, testA1, goodBody({ email: addrFree }));
      const taken = await invite(a, testA2, goodBody({ email: addrTaken }));
      expect([free.status, taken.status]).toEqual([201, 201]);
      expect(Object.keys(taken.body as Json).sort()).toEqual(Object.keys(free.body as Json).sort());
      expect((taken.body as Json).candidateId).not.toBe(theirs.id);
      const mine = await owner.candidate.findUniqueOrThrow({
        where: { id: (taken.body as Json).candidateId as string },
      });
      expect(mine.orgId).toBe(orgA);
      expect(mine.fullName).toBe('Ada Lovelace');
      const untouched = await owner.candidate.findUniqueOrThrow({ where: { id: theirs.id } });
      expect(untouched).toMatchObject({ orgId: orgB, fullName: 'Org B Person' });
      expect(await owner.invitation.count({ where: { candidateId: theirs.id } })).toBe(0);
    });
  });

  // ---- failures ------------------------------------------------------------------------------------

  describe('FR-303: failures', () => {
    it('FR-303: a failing session port rolls everything back: 503, no invitation, no new candidate, no audit row, no mail', async () => {
      const who = await make(UserRole.RECRUITER);
      const testId = await makeTest(who);
      portMode = 'fail';
      const addr = email();
      const audits = await owner.auditLog.count();
      const res = await invite(who, testId, goodBody({ email: addr }));
      expect(res.status).toBe(503);
      expect(portCalls).toBe(1);
      expect(await owner.invitation.count({ where: { testId } })).toBe(0);
      expect(await owner.candidate.count({ where: { email: addr.toLowerCase() } })).toBe(0);
      expect(await owner.auditLog.count()).toBe(audits);
      expect(sent).toHaveLength(0);
    });

    it.each(['failed', 'disabled'] as const)(
      'FR-303: mail outcome %s still answers 201 with that outcome and leaves sent_at empty',
      async (mode) => {
        const who = await make(UserRole.RECRUITER);
        const testId = await makeTest(who);
        mailMode = mode;
        const res = await invite(who, testId, goodBody());
        expect(res.status).toBe(201);
        expect((res.body as Json).mail).toBe(mode);
        const inv = await owner.invitation.findUniqueOrThrow({
          where: { id: (res.body as Json).id as string },
        });
        expect(inv.sentAt).toBeNull();
        expect(sent).toHaveLength(1);
      },
    );
  });

  // ---- concurrency --------------------------------------------------------------------------------

  describe('FR-303, FR-301: races', () => {
    it('FR-303: two parallel invites for the same candidate and test: one 201, one 409, no duplicate rows', async () => {
      const who = await make(UserRole.RECRUITER);
      for (let round = 0; round < 3; round++) {
        const testId = await makeTest(who);
        const addr = email();
        const res = await Promise.all([
          invite(who, testId, goodBody({ email: addr })),
          invite(who, testId, goodBody({ email: addr })),
        ]);
        expect(res.map((r) => r.status).sort()).toEqual([201, 409]);
        expect(await owner.invitation.count({ where: { testId } })).toBe(1);
        expect(
          await owner.candidate.count({ where: { email: addr.toLowerCase(), orgId: orgA } }),
        ).toBe(1);
        expect(await owner.session.count({ where: { invitation: { is: { testId } } } })).toBe(1);
        expect(sent.filter((s) => s.to === addr.toLowerCase())).toHaveLength(1);
      }
    });

    it('FR-303: parallel invites of different candidates get different tokens and hashes', async () => {
      const who = await make(UserRole.RECRUITER);
      const testId = await makeTest(who);
      const res = await Promise.all([
        invite(who, testId, goodBody()),
        invite(who, testId, goodBody()),
      ]);
      expect(res.map((r) => r.status)).toEqual([201, 201]);
      const toks = sent.slice(-2).map((m) => /#(.+)$/.exec(m.inviteUrl)?.[1] ?? '');
      expect(new Set(toks).size).toBe(2);
      const rows = await owner.invitation.findMany({ where: { testId } });
      expect(new Set(rows.map((r) => r.tokenHash)).size).toBe(2);
    });

    it('FR-301, FR-303: an invite racing PATCH /tests/:id: the edit waits or is refused, a used test is never edited', async () => {
      const who = await make(UserRole.RECRUITER);
      for (let round = 0; round < 4; round++) {
        const testId = await makeTest(who);
        const [inv, patch] = await Promise.all([
          invite(who, testId, goodBody()),
          http()
            .patch(`${API}/tests/${testId}`)
            .set(who.auth)
            .send({ name: `Raced ${round}` }),
        ]);
        expect(inv.status).toBe(201);
        expect([200, 409]).toContain(patch.status);
        const row = await owner.test.findUniqueOrThrow({ where: { id: testId } });
        expect(row.name).toBe(patch.status === 200 ? `Raced ${round}` : 'Invite me');
        if (patch.status === 200) {
          // The edit came first: no invitation existed when it ran, and the invite saw the edit.
          expect(await owner.testSection.count({ where: { testId } })).toBe(1);
        }
        // Whatever the order, the edit now answers 409.
        await http()
          .patch(`${API}/tests/${testId}`)
          .set(who.auth)
          .send({ name: 'Late' })
          .expect(409);
      }
    });

    it('FR-301, FR-303: an edit in flight holds the tests row: the invite waits and then judges the edited test (422 when the edit made it unsatisfiable)', async () => {
      const who = await make(UserRole.RECRUITER);
      const tag = `race-${++seq}`;
      const q = await seedQuestion({ tags: [tag] });
      const testId = await makeTest(who, tag);
      const holder = new Client({ connectionString: infra.postgres.getConnectionUri() });
      await holder.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT id FROM tests WHERE id = $1 FOR UPDATE', [testId]);
        let settled = false;
        const pending = invite(who, testId, goodBody()).then((r) => {
          settled = true;
          return r;
        });
        await new Promise((r) => setTimeout(r, 800));
        expect(settled).toBe(false); // waiting on the tests row, as an edit would make it
        await holder.query('UPDATE questions SET is_archived = true WHERE id = $1', [q.questionId]);
        await holder.query('COMMIT');
        const res = await pending;
        expect(res.status).toBe(422);
      } finally {
        await holder.end();
      }
      expect(await owner.invitation.count({ where: { testId } })).toBe(0);
    });
  });

  // ---- rate limit and timeout -----------------------------------------------------------------------

  describe('FR-303: per-organization limit and transaction timeout', () => {
    const svc = (): object => {
      const { InvitationsService } =
        jest.requireActual<typeof import('./invitations.service')>('./invitations.service');
      return app.get(InvitationsService);
    };

    /** The counter is a fixed hourly window: do not straddle a window boundary mid-test. */
    const awayFromHourBoundary = async (): Promise<void> => {
      const left = DAY / 24 - (Date.now() % (DAY / 24));
      if (left < 15_000) await new Promise((r) => setTimeout(r, left + 500));
    };

    /** A fresh org with one test and a limit of 2 per hour; returns a restore function. */
    async function limited(): Promise<{ who: Made; testId: string; restore: () => void }> {
      await awayFromHourBoundary();
      const org = (await owner.organization.create({ data: { name: 'Refund Org' } })).id;
      const who = await make(UserRole.RECRUITER, org);
      const test = await owner.test.create({
        data: { orgId: org, name: 'T', durationMinutes: 30, createdById: who.id },
      });
      const service = svc();
      const before = Reflect.get(service, 'rateLimit') as number;
      Reflect.set(service, 'rateLimit', 2);
      return {
        who,
        testId: test.id,
        restore: () => Reflect.set(service, 'rateLimit', before),
      };
    }

    it('FR-303: a port 503 after the slot gives the slot back; the next two invites still fit', async () => {
      const { who, testId, restore } = await limited();
      try {
        portMode = 'fail';
        await invite(who, testId, goodBody()).expect(503);
        portMode = 'ok';
        await invite(who, testId, goodBody()).expect(201);
        await invite(who, testId, goodBody()).expect(201);
        await invite(who, testId, goodBody()).expect(429);
      } finally {
        restore();
      }
    });

    it('FR-303: a transaction timeout (P2028) gives the slot back', async () => {
      const { who, testId, restore } = await limited();
      const service = svc();
      const before = Reflect.get(service, 'txTimeoutMs') as number;
      Reflect.set(service, 'txTimeoutMs', 1500);
      const holder = new Client({ connectionString: infra.postgres.getConnectionUri() });
      await holder.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT id FROM tests WHERE id = $1 FOR UPDATE', [testId]);
        const release = setTimeout(() => void holder.query('COMMIT'), 3000);
        const busy = await invite(who, testId, goodBody()).expect(503);
        expect((busy.body as Json).code).toBe('BUSY');
        expect(busy.headers['retry-after']).toBe('2');
        clearTimeout(release);
        Reflect.set(service, 'txTimeoutMs', before);
        await invite(who, testId, goodBody()).expect(201);
        await invite(who, testId, goodBody()).expect(201);
        await invite(who, testId, goodBody()).expect(429);
      } finally {
        Reflect.set(service, 'txTimeoutMs', before);
        await holder.end();
        restore();
      }
    });

    it('FR-303: a lock wait cut by lock_timeout (55P03) gives the slot back', async () => {
      const { who, testId, restore } = await limited();
      const service = svc();
      const before = Reflect.get(service, 'lockTimeoutMs') as number;
      Reflect.set(service, 'lockTimeoutMs', 500);
      const holder = new Client({ connectionString: infra.postgres.getConnectionUri() });
      await holder.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT id FROM tests WHERE id = $1 FOR UPDATE', [testId]);
        const busy = await invite(who, testId, goodBody()).expect(503);
        expect((busy.body as Json).code).toBe('BUSY');
        expect(busy.headers['retry-after']).toBe('2');
        await holder.query('COMMIT');
        Reflect.set(service, 'lockTimeoutMs', before);
        await invite(who, testId, goodBody()).expect(201);
        await invite(who, testId, goodBody()).expect(201);
        await invite(who, testId, goodBody()).expect(429);
      } finally {
        Reflect.set(service, 'lockTimeoutMs', before);
        await holder.end();
        restore();
      }
    });

    it('FR-303: a 404 and a 422 keep their slot', async () => {
      const { who, restore } = await limited();
      try {
        await invite(who, GHOST, goodBody()).expect(404);
        const tag = `slot-${++seq}`;
        // The limited org has no questions: a random slot nobody can fill is a 422.
        const test = await owner.test.findFirstOrThrow({ where: { createdById: who.id } });
        const section = await owner.testSection.create({
          data: { testId: test.id, title: 'S', position: 1 },
        });
        await owner.testQuestion.create({
          data: { sectionId: section.id, position: 1, points: 10, randomRule: { tags: [tag] } },
        });
        await invite(who, test.id, goodBody()).expect(422);
        await invite(who, test.id, goodBody()).expect(429);
      } finally {
        restore();
      }
    });

    it('FR-303: a failing refund does not mask the original 503', async () => {
      const { who, testId, restore } = await limited();
      const { REDIS_CLIENT } = jest.requireActual<
        typeof import('../infrastructure/infrastructure.module')
      >('../infrastructure/infrastructure.module');
      const redis = app.get<import('ioredis').Redis>(REDIS_CLIENT);
      const realEval = redis.eval.bind(redis) as (...a: unknown[]) => Promise<unknown>;
      let calls = 0;
      const spy = jest.spyOn(redis, 'eval').mockImplementation((...a: unknown[]) => {
        calls += 1;
        return calls === 1 ? realEval(...a) : Promise.reject(new Error('redis down'));
      });
      try {
        portMode = 'fail';
        const res = await invite(who, testId, goodBody());
        expect(res.status).toBe(503);
        expect((res.body as Json).detail).toBe('Invitations are not available yet.');
        expect(calls).toBe(2);
      } finally {
        spy.mockRestore();
        restore();
      }
    });

    it('FR-303: a 409 keeps its slot (a legitimate attempt)', async () => {
      const { who, testId, restore } = await limited();
      try {
        const addr = email();
        await invite(who, testId, goodBody({ email: addr })).expect(201);
        await invite(who, testId, goodBody({ email: addr })).expect(409);
        await invite(who, testId, goodBody()).expect(429);
      } finally {
        restore();
      }
    });

    it('FR-303: a request that fails validation takes no rate-limit slot', async () => {
      await awayFromHourBoundary();
      const org = (await owner.organization.create({ data: { name: 'Slot Org' } })).id;
      const who = await make(UserRole.RECRUITER, org);
      const test = await owner.test.create({
        data: { orgId: org, name: 'T', durationMinutes: 30, createdById: who.id },
      });
      const service = svc();
      const before = Reflect.get(service, 'rateLimit') as number;
      Reflect.set(service, 'rateLimit', 2);
      try {
        await invite(who, test.id, goodBody()).expect(201);
        // DTO-invalid and window()-invalid requests.
        await invite(who, test.id, goodBody({ email: 'nope' })).expect(400);
        await invite(who, test.id, goodBody({ windowStart: iso(Date.now() - 10 * 60_000) })).expect(
          400,
        );
        await invite(who, test.id, goodBody()).expect(201);
        await invite(who, test.id, goodBody()).expect(429);
      } finally {
        Reflect.set(service, 'rateLimit', before);
      }
    });

    it('FR-303: the invitation over the hourly limit is 429, nothing is written, and another org has its own counter', async () => {
      const org = (await owner.organization.create({ data: { name: 'Limit Org' } })).id;
      const who = await make(UserRole.RECRUITER, org);
      const test = await owner.test.create({
        data: { orgId: org, name: 'T', durationMinutes: 30, createdById: who.id },
      });
      const other = await make(UserRole.RECRUITER, orgB);
      const otherTest = await owner.test.create({
        data: { orgId: orgB, name: 'T', durationMinutes: 30, createdById: other.id },
      });
      await awayFromHourBoundary();
      const service = svc();
      const before = Reflect.get(service, 'rateLimit') as number;
      Reflect.set(service, 'rateLimit', 2);
      try {
        await invite(who, test.id, goodBody()).expect(201);
        await invite(who, test.id, goodBody()).expect(201);
        const refused = goodBody();
        const res = await invite(who, test.id, refused);
        expect(res.status).toBe(429);
        expect(await owner.invitation.count({ where: { testId: test.id } })).toBe(2);
        expect(
          await owner.candidate.count({
            where: { email: (refused.candidate as Json).email as string },
          }),
        ).toBe(0);
        expect(sent).toHaveLength(2);
        // The counter is per organization.
        await invite(other, otherTest.id, goodBody()).expect(201);
        await invite(other, otherTest.id, goodBody()).expect(201);
        await invite(other, otherTest.id, goodBody()).expect(429);
      } finally {
        Reflect.set(service, 'rateLimit', before);
      }
    });

    it('FR-303: Redis down is a fixed 503 (fail closed) and nothing is written', async () => {
      const who = await make(UserRole.RECRUITER);
      const testId = await makeTest(who);
      const { REDIS_CLIENT } = jest.requireActual<
        typeof import('../infrastructure/infrastructure.module')
      >('../infrastructure/infrastructure.module');
      const redis = app.get<import('ioredis').Redis>(REDIS_CLIENT);
      const addr = email();
      const evalSpy = jest.spyOn(redis, 'eval').mockRejectedValue(new Error('redis down'));
      try {
        const res = await invite(who, testId, goodBody({ email: addr }));
        expect(res.status).toBe(503);
        expect((res.body as Json).detail).toBe('Invitations are temporarily unavailable.');
      } finally {
        evalSpy.mockRestore();
      }
      expect(await owner.invitation.count({ where: { testId } })).toBe(0);
      expect(await owner.candidate.count({ where: { email: addr.toLowerCase() } })).toBe(0);
      expect(sent).toHaveLength(0);
    });

    it('FR-303: a lock wait is cut by lock_timeout; nothing is written', async () => {
      const who = await make(UserRole.RECRUITER);
      const testId = await makeTest(who);
      const service = svc();
      const before = Reflect.get(service, 'lockTimeoutMs') as number;
      Reflect.set(service, 'lockTimeoutMs', 800);
      const holder = new Client({ connectionString: infra.postgres.getConnectionUri() });
      await holder.connect();
      const addr = email();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT id FROM tests WHERE id = $1 FOR UPDATE', [testId]);
        const started = Date.now();
        const res = await invite(who, testId, goodBody({ email: addr }));
        expect(Date.now() - started).toBeLessThan(5000); // cut at ~0.8 s, not held to the commit
        expect(res.status).toBe(503);
        expect((res.body as Json).detail).toBe('The service is busy; retry shortly.');
        await holder.query('COMMIT');
      } finally {
        Reflect.set(service, 'lockTimeoutMs', before);
        await holder.end();
      }
      expect(await owner.invitation.count({ where: { testId } })).toBe(0);
      expect(await owner.candidate.count({ where: { email: addr.toLowerCase() } })).toBe(0);
    });

    it('FR-303: a transaction that waits past its timeout on the tests row is a fixed 503 and writes nothing', async () => {
      const who = await make(UserRole.RECRUITER);
      const testId = await makeTest(who);
      const service = svc();
      const before = Reflect.get(service, 'txTimeoutMs') as number;
      Reflect.set(service, 'txTimeoutMs', 1500);
      const holder = new Client({ connectionString: infra.postgres.getConnectionUri() });
      await holder.connect();
      const addr = email();
      const audits = await owner.auditLog.count();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT id FROM tests WHERE id = $1 FOR UPDATE', [testId]);
        // Prisma cannot cancel a statement that is blocked on a lock, so the answer comes once the
        // lock is released; the holder commits after the transaction timeout has passed.
        const release = setTimeout(() => void holder.query('COMMIT'), 3000);
        const res = await invite(who, testId, goodBody({ email: addr }));
        clearTimeout(release);
        expect(res.status).toBe(503);
        expect((res.body as Json).detail).toBe('The service is busy; retry shortly.');
      } finally {
        Reflect.set(service, 'txTimeoutMs', before);
        await holder.end();
      }
      await new Promise((r) => setTimeout(r, 500));
      expect(await owner.invitation.count({ where: { testId } })).toBe(0);
      expect(await owner.candidate.count({ where: { email: addr.toLowerCase() } })).toBe(0);
      expect(await owner.auditLog.count()).toBe(audits);
      expect(sent).toHaveLength(0);
    });
  });

  // ---- secrets ------------------------------------------------------------------------------------

  describe('FR-303, C-31: the token, address and name stay out of everything but the mail', () => {
    it('C-31: planted token, address and name appear in no response, row, audit metadata, error or log line', async () => {
      const who = await make(UserRole.RECRUITER);
      const testId = await makeTest(who);
      const lines: string[] = [];
      const grab = (a: unknown[]): void => void lines.push(a.map((x) => String(x)).join(' '));
      // A second app at log level trace: with the shared app (silent) this check would prove
      // nothing. pino writes to fd 1 with fs.writeSync, so that is captured as well.
      const fs = jest.requireActual<typeof import('node:fs')>('node:fs');
      const realWriteSync = fs.writeSync.bind(fs);
      // LOG_LEVEL is read when app.module is first loaded, so load a fresh module graph. This test
      // is the last in the file because it resets the module registry.
      process.env.LOG_LEVEL = 'trace';
      // Independent of the shared org A hourly counter.
      process.env.INVITATION_RATE_LIMIT_PER_ORG_HOUR = '10000';
      jest.resetModules();
      const Nest = jest.requireActual<typeof import('@nestjs/common')>('@nestjs/common');
      const traced = await build();
      process.env.LOG_LEVEL = 'silent';
      delete process.env.INVITATION_RATE_LIMIT_PER_ORG_HOUR;
      const inviteT = (t: string, b: Json): request.Test =>
        request(traced.getHttpServer()).post(`${API}/tests/${t}/invitations`).set(who.auth).send(b);
      const realWrite = fs.write.bind(fs);
      const spies = [
        jest
          .spyOn(fs, 'write')
          .mockImplementation((fd: number, data: unknown, ...rest: unknown[]) => {
            if (fd !== 1 && fd !== 2)
              return (realWrite as (...a: unknown[]) => void)(fd, data, ...rest);
            grab([data]);
            const cb = rest.find((r) => typeof r === 'function') as
              ((e: null, n: number) => void) | undefined;
            cb?.(null, Buffer.byteLength(String(data)));
          }),
        jest.spyOn(fs, 'writeSync').mockImplementation((fd: number, data: unknown) => {
          if (fd === 1 || fd === 2) {
            grab([data]);
            return Buffer.byteLength(String(data));
          }
          return (realWriteSync as (...a: unknown[]) => number)(fd, data);
        }),
        jest.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => (grab([c]), true)),
        jest.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => (grab([c]), true)),
        ...(['log', 'warn', 'error', 'debug', 'verbose', 'fatal'] as const).map((m) =>
          jest.spyOn(Nest.Logger.prototype, m).mockImplementation((...a: unknown[]) => grab(a)),
        ),
      ];
      const addr = 'planted.person@example.org';
      const name = 'Plantedname Zxqv';
      const responses: string[] = [];
      try {
        const ok = await inviteT(testId, {
          candidate: { email: addr, name },
          windowStart: iso(Date.now()),
          windowEnd: iso(Date.now() + DAY),
        });
        responses.push(JSON.stringify(ok.body), JSON.stringify(ok.headers));
        expect(ok.status).toBe(201);
        // A failing mail whose error carries the address and the link.
        mailMode = 'throw';
        const t2 = await makeTest(who);
        const failed = await inviteT(t2, {
          candidate: { email: addr, name },
          windowStart: iso(Date.now()),
          windowEnd: iso(Date.now() + DAY),
        });
        responses.push(JSON.stringify(failed.body));
        expect([failed.status, (failed.body as Json).mail]).toEqual([201, 'failed']);
        // A conflict and a validation failure, which echo input in some APIs.
        const dup = await inviteT(t2, {
          candidate: { email: addr, name },
          windowStart: iso(Date.now()),
          windowEnd: iso(Date.now() + DAY),
        });
        expect(dup.status).toBe(409);
        responses.push(JSON.stringify(dup.body));
        const bad = await inviteT(testId, {
          candidate: { email: addr, name },
          windowStart: iso(Date.now()),
          windowEnd: 'planted',
        });
        expect(bad.status).toBe(400);
        responses.push(JSON.stringify(bad.body));
      } finally {
        spies.forEach((s) => s.mockRestore());
        await traced.close();
      }
      // Not vacuous: the request log lines were captured (the path carries the test id).
      expect(lines.some((l) => l.includes(`/api/v1/tests/${testId}/invitations`))).toBe(true);
      const tokensSeen = sent.map((s) => /#([A-Za-z0-9_-]+)$/.exec(s.inviteUrl)?.[1] ?? '');
      expect(tokensSeen).toHaveLength(2);
      for (const t of tokensSeen) expect(t).toHaveLength(43);
      const planted = [...tokensSeen, addr, 'planted.person', name, 'Zxqv'];

      const everywhere = [...lines, ...responses].join('\n');
      for (const p of planted) expect(everywhere).not.toContain(p);

      // Database: only the hash is stored; audit rows hold ids and dates only.
      const hashes = (await owner.invitation.findMany({ where: { testId: { in: [testId] } } })).map(
        (i) => i.tokenHash,
      );
      expect(hashes).toContain(sha256(tokensSeen[0] ?? ''));
      const audits = await pg.query(
        `SELECT metadata::text AS m, ip, entity_type FROM audit_logs WHERE action = 'INVITATION_CREATED'`,
      );
      const auditText = audits.rows.map((r: Json) => JSON.stringify(r)).join('\n');
      const invText = JSON.stringify(await owner.invitation.findMany());
      for (const p of planted) expect(auditText).not.toContain(p);
      for (const p of tokensSeen) expect(invText).not.toContain(p);
    });
  });
});
