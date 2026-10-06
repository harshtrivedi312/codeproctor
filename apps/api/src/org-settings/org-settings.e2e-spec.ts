// Org settings admin route against a real Postgres 16 and Redis (Testcontainers), API as app_user.
import { INestApplication } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';
import { hash } from '@node-rs/argon2';
import { passwordVersion } from '../auth/crypto.util';
import { ARGON2_OPTIONS } from '../auth/password.service';
import type { TokenService } from '../common/auth/token.service';
import { createPrismaClient } from '../database/create-prisma-client';
import { PrismaClient, UserRole } from '../generated/prisma/client';
import type { Prisma } from '../generated/prisma/client';
import { aiReferenceProblems, minAssistantsFromSettings } from '../questions/ai-reference-rules';
import { applyEnv, applyMigrations, startInfra, TestInfra } from '../test/containers';

const API = '/api/v1';
const URL = `${API}/admin/org-settings`;
const PASSWORD = 'Correct-Horse-9';

describe('Org settings admin route (FR-103, TC-004, TC-008, ADR 0005 AI-5, ADR 0010)', () => {
  let infra: TestInfra;
  let app: INestApplication<App>;
  let owner: PrismaClient;
  let pg: Client;
  let orgA: string;
  let orgB: string;
  let tokens: TokenService;
  let seq = 0;
  let cachedHash: string | undefined;
  const passwordHashOf = async (): Promise<string> =>
    (cachedHash ??= await hash(PASSWORD, ARGON2_OPTIONS));

  beforeAll(async () => {
    infra = await startInfra();
    await applyMigrations(infra);
    const appPassword = randomBytes(18).toString('hex');
    pg = new Client({ connectionString: infra.postgres.getConnectionUri() });
    await pg.connect();
    await pg.query(`ALTER ROLE app_user PASSWORD '${appPassword}'`);
    const appUserUrl = `postgresql://app_user:${appPassword}@${infra.postgres.getHost()}:${infra.postgres.getMappedPort(5432)}/${infra.postgres.getDatabase()}`;
    applyEnv(infra, { DATABASE_URL: appUserUrl, THROTTLE_AUTH_LIMIT: '100000' });
    owner = createPrismaClient(infra.postgres.getConnectionUri());
    orgA = (await owner.organization.create({ data: { name: 'Org A' } })).id;
    orgB = (await owner.organization.create({ data: { name: 'Org B' } })).id;

    jest.resetModules();
    const { AppModule } = jest.requireActual<typeof import('../app.module')>('../app.module');
    const { Test } = jest.requireActual<typeof import('@nestjs/testing')>('@nestjs/testing');
    const { configureApp } = jest.requireActual<typeof import('../bootstrap')>('../bootstrap');
    const { MailPort: MailToken } =
      jest.requireActual<typeof import('../mail/mail.port')>('../mail/mail.port');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MailToken)
      .useValue({})
      .compile();
    app = moduleRef.createNestApplication<INestApplication<App>>();
    configureApp(app);
    await app.init();
    await app.listen(0);
    const { TokenService: Tokens } = jest.requireActual<
      typeof import('../common/auth/token.service')
    >('../common/auth/token.service');
    tokens = app.get(Tokens);
  });

  afterAll(async () => {
    await app?.close();
    await owner?.$disconnect();
    await pg?.end();
    await infra?.stop();
  });

  beforeEach(async () => {
    await owner.organization.updateMany({ data: { settings: {} } });
    await pg.query('DELETE FROM audit_logs WHERE action = $1', ['ORG_SETTINGS_UPDATED']);
  });

  async function make(
    role: UserRole,
    orgId = orgA,
  ): Promise<{ id: string; auth: { Authorization: string } }> {
    const n = ++seq;
    const user = await owner.user.create({
      data: {
        orgId,
        email: `os${n}@example.com`,
        fullName: `User ${n}`,
        role,
        passwordHash: await passwordHashOf(),
      },
    });
    const token = tokens.sign(
      {
        sub: user.id,
        org: orgId,
        role,
        kind: 'access',
        pwv: passwordVersion(await passwordHashOf()),
      },
      900,
    );
    return { id: user.id, auth: { Authorization: `Bearer ${token}` } };
  }

  const http = (): ReturnType<typeof request> => request(app.getHttpServer());
  const setStored = (orgId: string, settings: Prisma.InputJsonValue): Promise<unknown> =>
    owner.organization.update({ where: { id: orgId }, data: { settings } });
  const stored = async (orgId: string): Promise<unknown> =>
    (await owner.organization.findUniqueOrThrow({ where: { id: orgId } })).settings;
  async function audits(
    orgId: string,
  ): Promise<{ entity_type: string; entity_id: string; actor_id: string; metadata: unknown }[]> {
    const r = await pg.query(
      `SELECT entity_type, entity_id, actor_id, metadata FROM audit_logs WHERE action = 'ORG_SETTINGS_UPDATED' AND org_id = $1 ORDER BY id`,
      [orgId],
    );
    return r.rows as never;
  }

  describe('FR-103, TC-004: only a SUPER_ADMIN reaches the route', () => {
    it('TC-004 unauthenticated is 401 on GET and PATCH', async () => {
      await http().get(URL).expect(401);
      await http()
        .patch(URL)
        .send({ currentPassword: PASSWORD, aiReferences: { minAssistants: 1 } })
        .expect(401);
    });

    it('TC-004 a candidate-kind token, even with a SUPER_ADMIN role claim, is exactly 401 on GET and PATCH', async () => {
      const admin = await make(UserRole.SUPER_ADMIN);
      const n = ++seq;
      const forged: Record<string, string>[] = [
        { sub: `cand-${n}`, org: orgA, kind: 'candidate' },
        {
          sub: admin.id,
          org: orgA,
          role: 'SUPER_ADMIN',
          kind: 'candidate',
          pwv: passwordVersion(await passwordHashOf()),
        },
      ];
      for (const claims of forged) {
        const auth = { Authorization: `Bearer ${tokens.sign(claims, 900)}` };
        await http().get(URL).set(auth).expect(401);
        await http()
          .patch(URL)
          .set(auth)
          .send({ currentPassword: PASSWORD, aiReferences: { minAssistants: 1 } })
          .expect(401);
      }
      expect(await stored(orgA)).toEqual({});
      expect(await audits(orgA)).toHaveLength(0);
    });

    it.each([UserRole.RECRUITER, UserRole.AUTHOR, UserRole.REVIEWER])(
      'TC-004 %s gets 403 and nothing changes',
      async (role) => {
        const caller = await make(role);
        await http().get(URL).set(caller.auth).expect(403);
        await http()
          .patch(URL)
          .set(caller.auth)
          .send({ currentPassword: PASSWORD, aiReferences: { minAssistants: 1 } })
          .expect(403);
        expect(await stored(orgA)).toEqual({});
        expect(await audits(orgA)).toHaveLength(0);
      },
    );
  });

  describe('ADR 0005 AI-5: the setting', () => {
    it('AI-5 GET reports the default when nothing is stored', async () => {
      const admin = await make(UserRole.SUPER_ADMIN);
      const res = await http().get(URL).set(admin.auth).expect(200);
      expect(res.body).toEqual({ aiReferences: { minAssistants: 2, isDefault: true } });
    });

    it('AI-5 PATCH sets the value, GET returns it, one audit row has the old and new number', async () => {
      const admin = await make(UserRole.SUPER_ADMIN);
      const res = await http()
        .patch(URL)
        .set(admin.auth)
        .send({ currentPassword: PASSWORD, aiReferences: { minAssistants: 4 } })
        .expect(200);
      expect(res.body).toEqual({ aiReferences: { minAssistants: 4, isDefault: false } });
      const got = await http().get(URL).set(admin.auth).expect(200);
      expect(got.body).toEqual(res.body);
      const rows = await audits(orgA);
      expect(rows).toEqual([
        {
          entity_type: 'organization',
          entity_id: orgA,
          actor_id: admin.id,
          metadata: { changes: [{ key: 'aiReferences.minAssistants', from: 2, to: 4 }] },
        },
      ]);
    });

    it('AI-5 0 is accepted (gate off) and 5 is accepted', async () => {
      const admin = await make(UserRole.SUPER_ADMIN);
      await http()
        .patch(URL)
        .set(admin.auth)
        .send({ currentPassword: PASSWORD, aiReferences: { minAssistants: 0 } })
        .expect(200);
      await http()
        .patch(URL)
        .set(admin.auth)
        .send({ currentPassword: PASSWORD, aiReferences: { minAssistants: 5 } })
        .expect(200);
      expect((await audits(orgA)).map((r) => r.metadata)).toEqual([
        { changes: [{ key: 'aiReferences.minAssistants', from: 2, to: 0 }] },
        { changes: [{ key: 'aiReferences.minAssistants', from: 0, to: 5 }] },
      ]);
    });

    it('AI-5 a no-op PATCH (same stored value) is 200 with no write and no audit row', async () => {
      const admin = await make(UserRole.SUPER_ADMIN);
      await setStored(orgA, { aiReferences: { minAssistants: 3 } });
      const res = await http()
        .patch(URL)
        .set(admin.auth)
        .send({ currentPassword: PASSWORD, aiReferences: { minAssistants: 3 } })
        .expect(200);
      expect(res.body).toEqual({ aiReferences: { minAssistants: 3, isDefault: false } });
      expect(await audits(orgA)).toHaveLength(0);
    });

    it.each([
      ['-1', -1],
      ['6', 6],
      ['2.5', 2.5],
      ["'3'", '3'],
      ['null', null],
      ['huge', 1e21],
      ['true', true],
      ['array', [1]],
    ])('AI-5 minAssistants %s is 400 and nothing changes', async (_n, value) => {
      const admin = await make(UserRole.SUPER_ADMIN);
      await http()
        .patch(URL)
        .set(admin.auth)
        .send({ currentPassword: PASSWORD, aiReferences: { minAssistants: value } })
        .expect(400);
      expect(await stored(orgA)).toEqual({});
      expect(await audits(orgA)).toHaveLength(0);
    });

    it.each([
      ['empty body', {}],
      ['top-level array', []],
      ['empty aiReferences', { aiReferences: {} }],
      ['aiReferences null', { aiReferences: null }],
      ['aiReferences string', { aiReferences: 'x' }],
      ['aiReferences array', { aiReferences: [] }],
      ['unknown top-level key', { aiReferences: { minAssistants: 1 }, retention: { days: 1 } }],
      ['unknown nested key', { aiReferences: { minAssistants: 1, extra: 1 } }],
      ['only an unknown key', { other: 1 }],
    ])('AI-5 %s is 400', async (_n, body) => {
      const admin = await make(UserRole.SUPER_ADMIN);
      await http()
        .patch(URL)
        .set(admin.auth)
        .send(Array.isArray(body) ? body : { currentPassword: PASSWORD, ...body })
        .expect(400);
      expect(await stored(orgA)).toEqual({});
      expect(await audits(orgA)).toHaveLength(0);
    });

    it('AI-5 PATCH merges: other settings keys and other aiReferences keys survive', async () => {
      const admin = await make(UserRole.SUPER_ADMIN);
      await setStored(orgA, {
        retention: { days: 30 },
        consent: { text: 'v2' },
        aiReferences: { minAssistants: 1, note: 'keep' },
      });
      await http()
        .patch(URL)
        .set(admin.auth)
        .send({ currentPassword: PASSWORD, aiReferences: { minAssistants: 3 } })
        .expect(200);
      expect(await stored(orgA)).toEqual({
        retention: { days: 30 },
        consent: { text: 'v2' },
        aiReferences: { minAssistants: 3, note: 'keep' },
      });
    });

    it.each([
      ['settings is a string', '"oops"', 2],
      ['settings is an array', '[1,2]', 2],
      ['settings is null', 'null', 2],
      ['aiReferences is a string', '{"retention":{"days":9},"aiReferences":"x"}', 2],
      ['minAssistants is 2.5', '{"aiReferences":{"minAssistants":2.5}}', 2],
      ['minAssistants is a string', '{"aiReferences":{"minAssistants":"4"}}', 2],
      ['minAssistants is 99', '{"aiReferences":{"minAssistants":99}}', 2],
      ['minAssistants is 6', '{"aiReferences":{"minAssistants":6}}', 2],
      ['minAssistants is 10', '{"aiReferences":{"minAssistants":10}}', 2],
    ])(
      'AI-5 malformed stored settings (%s): GET is the default, PATCH repairs',
      async (_n, json, eff) => {
        const admin = await make(UserRole.SUPER_ADMIN);
        await pg.query('UPDATE organizations SET settings = $1::jsonb WHERE id = $2', [json, orgA]);
        const got = await http().get(URL).set(admin.auth).expect(200);
        expect(got.body).toEqual({ aiReferences: { minAssistants: eff, isDefault: true } });
        // Even writing the default value repairs the structure and is audited.
        await http()
          .patch(URL)
          .set(admin.auth)
          .send({ currentPassword: PASSWORD, aiReferences: { minAssistants: 2 } })
          .expect(200);
        const after = (await stored(orgA)) as { aiReferences: { minAssistants: number } };
        expect(after.aiReferences.minAssistants).toBe(2);
        if (json.includes('"retention"')) expect(after).toHaveProperty('retention', { days: 9 });
        expect(await audits(orgA)).toHaveLength(1);
        expect((await http().get(URL).set(admin.auth).expect(200)).body).toEqual({
          aiReferences: { minAssistants: 2, isDefault: false },
        });
      },
    );

    it('AI-5 parallel PATCHes (compare-and-set): each is 200 or 409 SETTINGS_CONFLICT, the final state is valid and audit rows equal the successful writes', async () => {
      const admin = await make(UserRole.SUPER_ADMIN);
      await setStored(orgA, { retention: { days: 5 } });
      const values = [0, 1, 3, 4, 5, 1, 3];
      const results = await Promise.all(
        values.map((v) =>
          http()
            .patch(URL)
            .set(admin.auth)
            .send({ currentPassword: PASSWORD, aiReferences: { minAssistants: v } }),
        ),
      );
      const ok = results.filter((r) => r.status === 200);
      const lost = results.filter((r) => r.status === 409);
      // The shared step-up reservation can refuse a concurrent attempt of the same admin: 403
      // REAUTH_FAILED, exactly as on the sibling admin routes. It changes nothing.
      const refused = results.filter((r) => r.status === 403);
      for (const r of refused) expect((r.body as { code?: string }).code).toBe('REAUTH_FAILED');
      expect(ok.length + lost.length + refused.length).toBe(values.length);
      expect(ok.length).toBeGreaterThanOrEqual(1);
      for (const r of lost) expect((r.body as { code?: string }).code).toBe('SETTINGS_CONFLICT');
      const final = (await stored(orgA)) as {
        retention: unknown;
        aiReferences: { minAssistants: number };
      };
      expect(values).toContain(final.aiReferences.minAssistants);
      expect(final.retention).toEqual({ days: 5 });
      // A repeat of the stored value is a 200 without a write, so rows <= 200s; every row is a
      // real change and the chain of from/to values is unbroken.
      const rows = await audits(orgA);
      expect(rows.length).toBeLessThanOrEqual(ok.length);
      expect(rows.length).toBeGreaterThanOrEqual(1);
      const changes = rows.map(
        (r) => (r.metadata as { changes: { from: number; to: number }[] }).changes[0],
      );
      expect(changes[0]?.from).toBe(2);
      for (let i = 1; i < changes.length; i++) expect(changes[i]?.from).toBe(changes[i - 1]?.to);
      expect(changes[changes.length - 1]?.to).toBe(final.aiReferences.minAssistants);
    });

    it('AI-5 a lost compare-and-set (3 attempts) is 409 SETTINGS_CONFLICT, writes nothing and no audit row', async () => {
      const admin = await make(UserRole.SUPER_ADMIN);
      const { OrgSettingsService } =
        jest.requireActual<typeof import('./org-settings.service')>('./org-settings.service');
      const svc = app.get(OrgSettingsService);
      const spy = jest.spyOn(svc as unknown as { tryUpdate: () => Promise<null> }, 'tryUpdate');
      spy.mockResolvedValue(null);
      try {
        const res = await http()
          .patch(URL)
          .set(admin.auth)
          .send({ currentPassword: PASSWORD, aiReferences: { minAssistants: 1 } })
          .expect(409);
        expect((res.body as { code?: string }).code).toBe('SETTINGS_CONFLICT');
        expect(spy).toHaveBeenCalledTimes(3);
      } finally {
        spy.mockRestore();
      }
      expect(await stored(orgA)).toEqual({});
      expect(await audits(orgA)).toHaveLength(0);
    });

    it('AI-5 compare-and-set: a change to another key between the read and the write is kept by the retry, one audit row, correct from', async () => {
      const admin = await make(UserRole.SUPER_ADMIN);
      await setStored(orgA, { retention: { days: 1 }, aiReferences: { minAssistants: 3 } });
      const { PrismaService } = jest.requireActual<typeof import('../database/prisma.service')>(
        '../database/prisma.service',
      );
      const prisma = app.get(PrismaService);
      const realTx = prisma.client.$transaction.bind(prisma.client) as (
        fn: (tx: Record<string, unknown>) => Promise<unknown>,
      ) => Promise<unknown>;
      let raced = false;
      const spy = jest.spyOn(prisma.client, '$transaction') as unknown as jest.SpyInstance;
      spy.mockImplementation(((fn: (tx: Record<string, unknown>) => Promise<unknown>) =>
        realTx((tx) => {
          const org = tx['organization'] as {
            findUnique: (a: unknown) => Promise<unknown>;
          };
          const wrapped = new Proxy(tx, {
            get: (t, k) =>
              k === 'organization'
                ? new Proxy(org, {
                    get: (o, m) =>
                      m === 'findUnique'
                        ? async (a: unknown): Promise<unknown> => {
                            const read = await o.findUnique(a);
                            if (!raced) {
                              raced = true;
                              await setStored(orgA, {
                                retention: { days: 99 },
                                aiReferences: { minAssistants: 3 },
                              });
                            }
                            return read;
                          }
                        : (o as Record<string | symbol, unknown>)[m],
                  })
                : (t as Record<string | symbol, unknown>)[k],
          });
          return fn(wrapped);
        })) as never);
      try {
        await http()
          .patch(URL)
          .set(admin.auth)
          .send({ currentPassword: PASSWORD, aiReferences: { minAssistants: 5 } })
          .expect(200);
      } finally {
        spy.mockRestore();
      }
      expect(raced).toBe(true);
      expect(await stored(orgA)).toEqual({
        retention: { days: 99 },
        aiReferences: { minAssistants: 5 },
      });
      const rows = await audits(orgA);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.metadata).toEqual({
        changes: [{ key: 'aiReferences.minAssistants', from: 3, to: 5 }],
      });
    });

    it('AI-5 extra stored keys never reset the stored minAssistants (GET and the publish-gate reader)', async () => {
      const admin = await make(UserRole.SUPER_ADMIN);
      await setStored(orgA, {
        retention: { days: 30 },
        aiReferences: { minAssistants: 4, futureKey: { x: 1 } },
        somethingNew: true,
      });
      const res = await http().get(URL).set(admin.auth).expect(200);
      expect(res.body).toEqual({ aiReferences: { minAssistants: 4, isDefault: false } });
      expect(minAssistantsFromSettings(await stored(orgA))).toBe(4);
    });

    it('AI-5 lowering minAssistants lowers the publish gate (the reader the gate uses)', async () => {
      const admin = await make(UserRole.SUPER_ADMIN);
      const rows = [{ language: 'python', assistant: 'one' }];
      const problems = async (): Promise<string[]> =>
        aiReferenceProblems(['python'], rows, minAssistantsFromSettings(await stored(orgA)));
      expect(await problems()).toHaveLength(1);
      await http()
        .patch(URL)
        .set(admin.auth)
        .send({ currentPassword: PASSWORD, aiReferences: { minAssistants: 1 } })
        .expect(200);
      expect(await problems()).toHaveLength(0);
      await http()
        .patch(URL)
        .set(admin.auth)
        .send({ currentPassword: PASSWORD, aiReferences: { minAssistants: 3 } })
        .expect(200);
      expect(await problems()).toHaveLength(1);
    });
  });

  describe('FR-102, TC-003: step-up with the admin current password on PATCH', () => {
    const body = (extra: object = {}): object => ({ aiReferences: { minAssistants: 4 }, ...extra });

    it('FR-102 a wrong password is 403 REAUTH_FAILED, nothing changes and no audit row', async () => {
      const admin = await make(UserRole.SUPER_ADMIN);
      const res = await http()
        .patch(URL)
        .set(admin.auth)
        .send(body({ currentPassword: 'Wrong-Horse-99' }))
        .expect(403);
      expect((res.body as { code?: string }).code).toBe('REAUTH_FAILED');
      expect(JSON.stringify(res.body)).not.toContain('Wrong-Horse-99');
      expect(await stored(orgA)).toEqual({});
      expect(await audits(orgA)).toHaveLength(0);
    });

    it('FR-102 a correct password works', async () => {
      const admin = await make(UserRole.SUPER_ADMIN);
      await http()
        .patch(URL)
        .set(admin.auth)
        .send(body({ currentPassword: PASSWORD }))
        .expect(200);
      expect(await audits(orgA)).toHaveLength(1);
    });

    it('FR-102 a no-op PATCH (same value) still needs the correct password', async () => {
      const admin = await make(UserRole.SUPER_ADMIN);
      await setStored(orgA, { aiReferences: { minAssistants: 4 } });
      await http()
        .patch(URL)
        .set(admin.auth)
        .send(body({ currentPassword: 'Wrong-Horse-99' }))
        .expect(403);
      await http()
        .patch(URL)
        .set(admin.auth)
        .send(body({ currentPassword: PASSWORD }))
        .expect(200);
    });

    it.each([
      ['missing', undefined],
      ['empty', ''],
      ['null', null],
      ['a number', 12345],
    ])('FR-102 a %s password is 400 and nothing changes', async (_n, value) => {
      const admin = await make(UserRole.SUPER_ADMIN);
      const payload: Record<string, unknown> = { aiReferences: { minAssistants: 4 } };
      if (value !== undefined) payload['currentPassword'] = value;
      await http().patch(URL).set(admin.auth).send(payload).expect(400);
      expect(await stored(orgA)).toEqual({});
      expect(await audits(orgA)).toHaveLength(0);
    });

    it('FR-102 GET needs no password', async () => {
      const admin = await make(UserRole.SUPER_ADMIN);
      await http().get(URL).set(admin.auth).expect(200);
    });

    it('FR-102 the password never appears in the audit row or the logs', async () => {
      const admin = await make(UserRole.SUPER_ADMIN);
      const planted = 'Zq7-Planted-Pw-Unusual!';
      const hashed = await hash(planted, ARGON2_OPTIONS);
      await owner.user.update({ where: { id: admin.id }, data: { passwordHash: hashed } });
      const token = tokens.sign(
        {
          sub: admin.id,
          org: orgA,
          role: 'SUPER_ADMIN',
          kind: 'access',
          pwv: passwordVersion(hashed),
        },
        900,
      );
      const writes: string[] = [];
      const spy = jest.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
        writes.push(String(c));
        return true;
      });
      try {
        await http()
          .patch(URL)
          .set({ Authorization: `Bearer ${token}` })
          .send(body({ currentPassword: planted }))
          .expect(200);
        await http()
          .patch(URL)
          .set({ Authorization: `Bearer ${token}` })
          .send({ aiReferences: { minAssistants: 1 }, currentPassword: `${planted}-wrong` })
          .expect(403);
      } finally {
        spy.mockRestore();
      }
      const row = await pg.query(
        `SELECT to_jsonb(a)::text AS t FROM audit_logs a WHERE action = 'ORG_SETTINGS_UPDATED'`,
      );
      expect(JSON.stringify(row.rows)).not.toContain('Planted-Pw');
      expect(writes.join('')).not.toContain('Planted-Pw');
    });

    it('FR-101, TC-003 repeated wrong passwords lock the admin like the sibling admin routes: even the right password is then the same 403', async () => {
      const admin = await make(UserRole.SUPER_ADMIN);
      const patch = (password: string): request.Test =>
        http()
          .patch(URL)
          .set(admin.auth)
          .send(body({ currentPassword: password }));
      const wrong = await patch('nope-nope-nope-1');
      for (let i = 0; i < 6; i++) await patch('nope-nope-nope-1');
      const lockedRight = await patch(PASSWORD);
      expect(lockedRight.status).toBe(403);
      const strip = (r: request.Response): unknown => {
        const { traceId: _t, instance: _i, ...rest } = r.body as Record<string, unknown>;
        void _t;
        void _i;
        return rest;
      };
      expect(strip(lockedRight)).toEqual(strip(wrong));
      // The shared counter: the sibling unlock route is locked too.
      const victim = await make(UserRole.RECRUITER);
      const sibling = await http()
        .post(`${API}/admin/users/${victim.id}/unlock`)
        .set(admin.auth)
        .send({ currentPassword: PASSWORD });
      expect(sibling.status).toBe(403);
      expect((sibling.body as { code?: string }).code).toBe('REAUTH_FAILED');
      expect(await stored(orgA)).toEqual({});
      expect(await audits(orgA)).toHaveLength(0);
    });
  });

  describe('TC-008: org isolation', () => {
    it('TC-008 an admin of org B changes org B only; org A is untouched and each GET shows its own org', async () => {
      const adminA = await make(UserRole.SUPER_ADMIN, orgA);
      const adminB = await make(UserRole.SUPER_ADMIN, orgB);
      await setStored(orgA, { aiReferences: { minAssistants: 3 }, retention: { days: 7 } });
      await http()
        .patch(URL)
        .set(adminB.auth)
        .send({ currentPassword: PASSWORD, aiReferences: { minAssistants: 0 } })
        .expect(200);
      expect(await stored(orgA)).toEqual({
        aiReferences: { minAssistants: 3 },
        retention: { days: 7 },
      });
      expect(
        ((await stored(orgB)) as { aiReferences: { minAssistants: number } }).aiReferences
          .minAssistants,
      ).toBe(0);
      expect((await http().get(URL).set(adminA.auth).expect(200)).body).toEqual({
        aiReferences: { minAssistants: 3, isDefault: false },
      });
      expect((await http().get(URL).set(adminB.auth).expect(200)).body).toEqual({
        aiReferences: { minAssistants: 0, isDefault: false },
      });
      expect(await audits(orgA)).toHaveLength(0);
      expect(await audits(orgB)).toHaveLength(1);
    });

    it('TC-008 an org id in the body or query is ignored (rejected as an unknown key)', async () => {
      const adminB = await make(UserRole.SUPER_ADMIN, orgB);
      await http()
        .patch(`${URL}?orgId=${orgA}`)
        .set(adminB.auth)
        .send({ currentPassword: PASSWORD, orgId: orgA, aiReferences: { minAssistants: 0 } })
        .expect(400);
      expect(await stored(orgA)).toEqual({});
    });
  });
});
