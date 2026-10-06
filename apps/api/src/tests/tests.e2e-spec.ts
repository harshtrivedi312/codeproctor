// Test templates (FR-301, FR-302, TC-020 part 1, TC-008 style) against real Postgres 16 and Redis
// (Testcontainers), the API running as app_user as in production (ADR 0006).
//
// TC-020 is covered only in part here: the rule is validated and checked for satisfiability when
// the test is saved. Picking 2 matching questions per session at start (the distribution part)
// belongs to the candidate start flow (BE-07) and its tests.
import { INestApplication } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';
import { passwordVersion } from '../auth/crypto.util';
import type { TokenService } from '../common/auth/token.service';
import { createPrismaClient } from '../database/create-prisma-client';
import { PrismaClient, UserRole } from '../generated/prisma/client';
import type { Difficulty, QuestionType } from '../generated/prisma/client';
import { applyEnv, applyMigrations, startInfra } from '../test/containers';
import type { TestInfra } from '../test/containers';

const API = '/api/v1';
const GHOST = '00000000-0000-4000-8000-000000000042';

type Json = Record<string, unknown>;

function stable(res: request.Response): Json {
  const { traceId: _t, instance: _i, ...rest } = res.body as Json;
  void _t;
  void _i;
  return rest;
}

describe('Test templates (FR-301, FR-302, TC-020 part 1, TC-008)', () => {
  let infra: TestInfra;
  let app: INestApplication<App>;
  let owner: PrismaClient;
  let pg: Client;
  let orgA: string;
  let orgB: string;
  let tokens: TokenService;
  let seq = 0;

  beforeAll(async () => {
    infra = await startInfra();
    await applyMigrations(infra);
    const appPassword = randomBytes(18).toString('hex');
    pg = new Client({ connectionString: infra.postgres.getConnectionUri() });
    await pg.connect();
    await pg.query(`ALTER ROLE app_user PASSWORD '${appPassword}'`);
    const url = `postgresql://app_user:${appPassword}@${infra.postgres.getHost()}:${infra.postgres.getMappedPort(5432)}/${infra.postgres.getDatabase()}`;
    applyEnv(infra, { DATABASE_URL: url, LOG_LEVEL: 'silent', THROTTLE_DEFAULT_LIMIT: '100000' });
    owner = createPrismaClient(infra.postgres.getConnectionUri());
    orgA = (await owner.organization.create({ data: { name: 'Org A' } })).id;
    orgB = (await owner.organization.create({ data: { name: 'Org B' } })).id;

    jest.resetModules();
    const { AppModule } = jest.requireActual<typeof import('../app.module')>('../app.module');
    const { Test } = jest.requireActual<typeof import('@nestjs/testing')>('@nestjs/testing');
    const { configureApp } = jest.requireActual<typeof import('../bootstrap')>('../bootstrap');
    const { MailPort } =
      jest.requireActual<typeof import('../mail/mail.port')>('../mail/mail.port');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MailPort)
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

  interface Made {
    id: string;
    auth: { Authorization: string };
  }

  async function make(role: UserRole, orgId = orgA): Promise<Made> {
    const n = ++seq;
    const passwordHash = `hash-${n}`;
    const user = await owner.user.create({
      data: { orgId, email: `t${n}@example.com`, fullName: `T ${n}`, role, passwordHash },
    });
    const token = tokens.sign(
      { sub: user.id, org: orgId, role, kind: 'access', pwv: passwordVersion(passwordHash) },
      900,
    );
    return { id: user.id, auth: { Authorization: `Bearer ${token}` } };
  }

  const http = (): ReturnType<typeof request> => request(app.getHttpServer());

  interface SeedQuestion {
    tags?: string[];
    difficulty?: Difficulty;
    type?: QuestionType;
    published?: boolean;
    archived?: boolean;
    orgId?: string;
  }

  /** A question with one version, straight in the database (the question bank is slice 4a). */
  async function seedQuestion(
    o: SeedQuestion = {},
  ): Promise<{ questionId: string; versionId: string }> {
    const n = ++seq;
    const q = await owner.question.create({
      data: {
        orgId: o.orgId ?? orgA,
        slug: `q-${n}`,
        type: o.type ?? 'CODING',
        tags: o.tags ?? [],
        isArchived: o.archived ?? false,
      },
    });
    const v = await owner.questionVersion.create({
      data: {
        questionId: q.id,
        version: 1,
        title: `Question ${n}`,
        statementMd: 'Do it.',
        difficulty: o.difficulty ?? 'EASY',
        allowedLanguages: ['python'],
        isPublished: o.published ?? true,
      },
    });
    if (o.published ?? true) {
      await owner.question.update({ where: { id: q.id }, data: { currentVersionId: v.id } });
    }
    return { questionId: q.id, versionId: v.id };
  }

  const fixed = (versionId: string, points = 50): Json => ({
    questionVersionId: versionId,
    points,
  });

  async function body(over: Json = {}): Promise<Json> {
    const { versionId } = await seedQuestion();
    return {
      name: 'Backend screen',
      durationMinutes: 60,
      sections: [
        { title: 'Warm-up', timeLimitMin: 20, questions: [fixed(versionId)] },
        { title: 'Main', timeLimitMin: 40, questions: [fixed(versionId, 100)] },
      ],
      ...over,
    };
  }

  async function create(who: Made, b?: Json): Promise<Json> {
    const res = await http()
      .post(`${API}/tests`)
      .set(who.auth)
      .send(b ?? (await body()));
    expect([res.status, res.body]).toEqual([201, expect.anything()]);
    return res.body as Json;
  }

  async function audit(action: string, entityId: string): Promise<Json[]> {
    const r = await pg.query(
      `SELECT org_id, actor_id, entity_type, metadata FROM audit_logs WHERE action = $1 AND entity_id = $2 ORDER BY id`,
      [action, entityId],
    );
    return r.rows as Json[];
  }

  async function seedInvitation(testId: string, orgId = orgA): Promise<string> {
    const n = ++seq;
    const c = await owner.candidate.create({
      data: { orgId, email: `cand${n}@example.com`, fullName: `Cand ${n}` },
    });
    const inv = await owner.invitation.create({
      data: {
        orgId,
        testId,
        candidateId: c.id,
        tokenHash: randomBytes(32).toString('hex'),
        windowStart: new Date(Date.now() - 1000),
        windowEnd: new Date(Date.now() + 3_600_000),
      },
    });
    return inv.id;
  }

  const sectionTitles = (t: Json): string[] => (t.sections as Json[]).map((s) => s.title as string);

  // ---- roles -------------------------------------------------------------------------------------

  describe('FR-103, FR-301: role matrix', () => {
    it('FR-301: RECRUITER and SUPER_ADMIN can create, read, list and edit', async () => {
      for (const role of [UserRole.RECRUITER, UserRole.SUPER_ADMIN]) {
        const who = await make(role);
        const t = await create(who);
        await http()
          .get(`${API}/tests/${t.id as string}`)
          .set(who.auth)
          .expect(200);
        await http().get(`${API}/tests`).set(who.auth).expect(200);
        await http()
          .patch(`${API}/tests/${t.id as string}`)
          .set(who.auth)
          .send({ name: 'Renamed' })
          .expect(200);
      }
    });

    it('FR-301: AUTHOR and REVIEWER get 403 on every route and change nothing', async () => {
      const recruiter = await make(UserRole.RECRUITER);
      const t = await create(recruiter);
      const before = await owner.test.count();
      for (const role of [UserRole.AUTHOR, UserRole.REVIEWER]) {
        const who = await make(role);
        await http().get(`${API}/tests`).set(who.auth).expect(403);
        await http()
          .get(`${API}/tests/${t.id as string}`)
          .set(who.auth)
          .expect(403);
        await http()
          .post(`${API}/tests`)
          .set(who.auth)
          .send(await body())
          .expect(403);
        await http()
          .patch(`${API}/tests/${t.id as string}`)
          .set(who.auth)
          .send({ name: 'Hacked' })
          .expect(403);
      }
      expect(await owner.test.count()).toBe(before);
      expect((await owner.test.findUniqueOrThrow({ where: { id: t.id as string } })).name).toBe(
        'Backend screen',
      );
    });

    it('FR-301: no token is 401 on every route', async () => {
      await http().get(`${API}/tests`).expect(401);
      await http().get(`${API}/tests/${GHOST}`).expect(401);
      await http().post(`${API}/tests`).send({}).expect(401);
      await http().patch(`${API}/tests/${GHOST}`).send({}).expect(401);
    });

    it('FR-301: there is no copy or archive route', async () => {
      const who = await make(UserRole.RECRUITER);
      await http().post(`${API}/tests/${GHOST}/copy`).set(who.auth).send({}).expect(404);
      await http().post(`${API}/tests/${GHOST}/archive`).set(who.auth).send({}).expect(404);
      await http().delete(`${API}/tests/${GHOST}`).set(who.auth).expect(404);
    });
  });

  // ---- create ------------------------------------------------------------------------------------

  describe('FR-301: create', () => {
    it('FR-301: saves ordered sections and questions, default STANDARD profile, and one audit row', async () => {
      const who = await make(UserRole.RECRUITER);
      const t = await create(who, { ...(await body()), passScore: 120.5, description: 'Hello' });
      expect(t).toMatchObject({
        name: 'Backend screen',
        description: 'Hello',
        durationMinutes: 60,
        profile: 'STANDARD',
        passScore: 120.5,
        createdById: who.id,
        sectionCount: 2,
        questionCount: 2,
        used: false,
      });
      const sections = t.sections as Json[];
      expect(sections.map((s) => [s.title, s.position, s.timeLimitMin])).toEqual([
        ['Warm-up', 1, 20],
        ['Main', 2, 40],
      ]);
      expect((sections[1]?.questions as Json[])[0]).toMatchObject({
        position: 1,
        points: 100,
        randomRule: null,
        difficulty: 'EASY',
      });
      const rows = await audit('TEST_CREATED', t.id as string);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        org_id: orgA,
        actor_id: who.id,
        entity_type: 'test',
        metadata: { sections: 2, questions: 2 },
      });
      expect(JSON.stringify(rows[0]?.metadata)).not.toContain('Backend screen');
    });

    it('FR-301: sections sent out of order are stored by position', async () => {
      const who = await make(UserRole.RECRUITER);
      const { versionId } = await seedQuestion();
      const t = await create(who, {
        name: 'Ordered',
        durationMinutes: 30,
        sections: [
          { title: 'Second', position: 2, questions: [fixed(versionId)] },
          { title: 'First', position: 1, questions: [fixed(versionId)] },
        ],
      });
      expect(sectionTitles(t)).toEqual(['First', 'Second']);
    });

    it('FR-301 sections sum: limits above the duration are 400, equal to the duration is accepted', async () => {
      const who = await make(UserRole.RECRUITER);
      const { versionId } = await seedQuestion();
      const mk = (a: number, b: number): Json => ({
        name: 'Sum',
        durationMinutes: 60,
        sections: [
          { title: 'A', timeLimitMin: a, questions: [fixed(versionId)] },
          { title: 'B', timeLimitMin: b, questions: [fixed(versionId)] },
        ],
      });
      const before = await owner.test.count();
      const bad = await http().post(`${API}/tests`).set(who.auth).send(mk(30, 31));
      expect(bad.status).toBe(400);
      expect(JSON.stringify(bad.body)).toMatch(/add up to 61 minutes/);
      expect(await owner.test.count()).toBe(before);
      await http().post(`${API}/tests`).set(who.auth).send(mk(30, 30)).expect(201);
    });

    it('FR-302: LOCKDOWN is refused with 400 and nothing is saved; STRICT is accepted', async () => {
      const who = await make(UserRole.RECRUITER);
      const before = await owner.test.count();
      for (const profile of ['LOCKDOWN', 'lockdown', 'OTHER', 7]) {
        await http()
          .post(`${API}/tests`)
          .set(who.auth)
          .send(await body({ profile }))
          .expect(400);
      }
      expect(await owner.test.count()).toBe(before);
      const t = await create(who, await body({ profile: 'STRICT' }));
      expect(t.profile).toBe('STRICT');
    });

    it.each([
      ['no sections', { sections: [] }],
      ['sections not an array', { sections: 'x' }],
      ['duration 4', { durationMinutes: 4 }],
      ['duration 481', { durationMinutes: 481 }],
      ['duration 60.5', { durationMinutes: 60.5 }],
      ['no name', { name: undefined }],
      ['blank name', { name: '   ' }],
      ['name 201 chars', { name: 'x'.repeat(201) }],
      ['NUL in name', { name: 'a\u0000b' }],
      ['lone surrogate in description', { description: 'a\ud800' }],
      ['null description', { description: null }],
      ['null passScore', { passScore: null }],
      ['null profile', { profile: null }],
      ['unknown field', { settings: { x: 1 } }],
      ['pass score above the points (150)', { passScore: 150.01 }],
      ['negative pass score', { passScore: -1 }],
      ['pass score 3 decimals', { passScore: 1.234 }],
    ])('FR-301: %s is 400 and nothing is saved', async (_name, over) => {
      const who = await make(UserRole.RECRUITER);
      const before = await owner.test.count();
      const res = await http()
        .post(`${API}/tests`)
        .set(who.auth)
        .send(await body(over as Json));
      expect(res.status).toBe(400);
      expect(await owner.test.count()).toBe(before);
    });

    it.each([
      ['empty questions', (): Json => ({ title: 'S', questions: [] })],
      ['no title', (v: string): Json => ({ questions: [fixed(v)] })],
      ['null title', (v: string): Json => ({ title: null, questions: [fixed(v)] })],
      ['NUL title', (v: string): Json => ({ title: 'a\u0000', questions: [fixed(v)] })],
      ['limit 0', (v: string): Json => ({ title: 'S', timeLimitMin: 0, questions: [fixed(v)] })],
      [
        'null limit',
        (v: string): Json => ({ title: 'S', timeLimitMin: null, questions: [fixed(v)] }),
      ],
      [
        'both fixed and random',
        (v: string): Json => ({
          title: 'S',
          questions: [{ questionVersionId: v, randomRule: {} }],
        }),
      ],
      ['neither fixed nor random', (): Json => ({ title: 'S', questions: [{ points: 5 }] })],
      ['points 0', (v: string): Json => ({ title: 'S', questions: [fixed(v, 0)] })],
      ['points 10000', (v: string): Json => ({ title: 'S', questions: [fixed(v, 10000)] })],
      ['points 3 decimals', (v: string): Json => ({ title: 'S', questions: [fixed(v, 1.005)] })],
      ['not a uuid', (): Json => ({ title: 'S', questions: [{ questionVersionId: 'abc' }] })],
      ['null version id', (): Json => ({ title: 'S', questions: [{ questionVersionId: null }] })],
      ['null random rule', (): Json => ({ title: 'S', questions: [{ randomRule: null }] })],
      [
        'unknown question field',
        (v: string): Json => ({ title: 'S', questions: [{ ...fixed(v), count: 2 }] }),
      ],
      [
        '51 questions',
        (v: string): Json => ({
          title: 'S',
          questions: Array.from({ length: 51 }, () => fixed(v, 1)),
        }),
      ],
      [
        'question positions with a gap',
        (v: string): Json => ({ title: 'S', questions: [{ ...fixed(v), position: 2 }] }),
      ],
      [
        'question positions mixed',
        (v: string): Json => ({ title: 'S', questions: [{ ...fixed(v), position: 1 }, fixed(v)] }),
      ],
    ])('FR-301: a section with %s is 400', async (_name, make1) => {
      const who = await make(UserRole.RECRUITER);
      const { versionId } = await seedQuestion();
      const before = await owner.test.count();
      const res = await http()
        .post(`${API}/tests`)
        .set(who.auth)
        .send({ name: 'Bad', durationMinutes: 60, sections: [make1(versionId)] });
      expect(res.status).toBe(400);
      expect(await owner.test.count()).toBe(before);
    });

    it('FR-301: section positions with a gap, a repeat or only on some sections are 400', async () => {
      const who = await make(UserRole.RECRUITER);
      const { versionId } = await seedQuestion();
      const sec = (title: string, position?: number): Json => ({
        title,
        ...(position === undefined ? {} : { position }),
        questions: [fixed(versionId)],
      });
      for (const sections of [
        [sec('A', 2), sec('B', 3)],
        [sec('A', 1), sec('B', 1)],
        [sec('A', 1), sec('B')],
      ]) {
        await http()
          .post(`${API}/tests`)
          .set(who.auth)
          .send({ name: 'Pos', durationMinutes: 60, sections })
          .expect(400);
      }
    });

    it('FR-301: a body of 21 sections is 400', async () => {
      const who = await make(UserRole.RECRUITER);
      const { versionId } = await seedQuestion();
      const sections = Array.from({ length: 21 }, (_v, i) => ({
        title: `S${i}`,
        questions: [fixed(versionId, 1)],
      }));
      await http()
        .post(`${API}/tests`)
        .set(who.auth)
        .send({ name: 'Many', durationMinutes: 60, sections })
        .expect(400);
    });
  });

  // ---- fixed question references -------------------------------------------------------------------

  describe('FR-301: fixed questions', () => {
    it('FR-301, DL-34: a draft version is the same 404 as a missing id; an archived question is 422; nothing is saved', async () => {
      const who = await make(UserRole.RECRUITER);
      const draft = await seedQuestion({ published: false });
      const archived = await seedQuestion({ archived: true });
      const before = await owner.test.count();
      const send = (versionId: string): Promise<request.Response> =>
        http()
          .post(`${API}/tests`)
          .set(who.auth)
          .send({
            name: 'Refs',
            durationMinutes: 60,
            sections: [{ title: 'S', questions: [fixed(versionId)] }],
          });
      const missing = await send('00000000-0000-4000-8000-000000000000');
      const draftRes = await send(draft.versionId);
      expect(missing.status).toBe(404);
      expect(draftRes.status).toBe(404);
      const strip = (b: Record<string, unknown>): Record<string, unknown> => {
        return { ...b, traceId: undefined };
      };
      expect(strip(draftRes.body as Record<string, unknown>)).toEqual(
        strip(missing.body as Record<string, unknown>),
      );
      expect((await send(archived.versionId)).status).toBe(422);
      expect(await owner.test.count()).toBe(before);
    });

    it('TC-008 style: a version of another organization, and a missing one, are the same 404', async () => {
      const who = await make(UserRole.RECRUITER);
      const foreign = await seedQuestion({ orgId: orgB });
      const send = (versionId: string): Promise<request.Response> =>
        http()
          .post(`${API}/tests`)
          .set(who.auth)
          .send({
            name: 'Cross',
            durationMinutes: 60,
            sections: [{ title: 'S', questions: [fixed(versionId)] }],
          });
      const a = await send(foreign.versionId);
      const b = await send(GHOST);
      expect([a.status, b.status]).toEqual([404, 404]);
      expect(stable(a)).toEqual(stable(b));
    });
  });

  // ---- random rules --------------------------------------------------------------------------------

  describe('TC-020 part 1, FR-301: random-pick rules', () => {
    const withRule = (randomRule: unknown, extra: Json = {}): Json => ({
      name: 'Random',
      durationMinutes: 60,
      sections: [{ title: 'S', questions: [{ randomRule, points: 10, ...extra }] }],
    });

    it('TC-020: a satisfiable rule is stored exactly, tags lower-cased', async () => {
      const who = await make(UserRole.RECRUITER);
      await seedQuestion({ tags: ['arrays', 'dp'], difficulty: 'MEDIUM' });
      const t = await create(
        who,
        withRule({ tags: ['Arrays'], difficulty: 'MEDIUM', type: 'CODING' }),
      );
      const q = ((t.sections as Json[])[0]?.questions as Json[])[0];
      expect(q).toMatchObject({
        questionVersionId: null,
        randomRule: { tags: ['arrays'], difficulty: 'MEDIUM', type: 'CODING' },
      });
      const stored = await owner.testQuestion.findFirstOrThrow({
        where: { id: q?.id as string },
      });
      expect(stored.randomRule).toEqual({ tags: ['arrays'], difficulty: 'MEDIUM', type: 'CODING' });
      expect(stored.questionVersionId).toBeNull();
    });

    it.each([
      ['unknown key', { tags: ['arrays'], bogus: 1 }],
      ['count', { tags: ['arrays'], count: 2 }],
      ['empty tags', { tags: [] }],
      ['bad difficulty', { difficulty: 'IMPOSSIBLE' }],
      ['bad type', { type: 'ESSAY' }],
      ['array', []],
      ['string', 'arrays'],
      ['NUL tag', { tags: ['a\u0000'] }],
    ])('TC-020: a rule with %s is 400', async (_n, rule) => {
      const who = await make(UserRole.RECRUITER);
      await seedQuestion({ tags: ['arrays'] });
      const before = await owner.test.count();
      await http().post(`${API}/tests`).set(who.auth).send(withRule(rule)).expect(400);
      expect(await owner.test.count()).toBe(before);
    });

    it('TC-020: a rule that matches nothing is 422 and nothing is saved', async () => {
      const who = await make(UserRole.RECRUITER);
      await seedQuestion({ tags: ['graphs'], difficulty: 'HARD' });
      const before = await owner.test.count();
      for (const rule of [{ tags: ['no-such-tag'] }, { tags: ['graphs'], difficulty: 'EASY' }]) {
        const res = await http().post(`${API}/tests`).set(who.auth).send(withRule(rule));
        expect(res.status).toBe(422);
        expect(JSON.stringify(res.body)).toMatch(
          /sections\[0\]\.questions\[0\]\.randomRule matches/,
        );
      }
      expect(await owner.test.count()).toBe(before);
    });

    it('TC-020: unpublished, archived and other-organization questions do not satisfy a rule', async () => {
      const who = await make(UserRole.RECRUITER);
      const tag = `only-${++seq}`;
      await seedQuestion({ tags: [tag], published: false });
      await seedQuestion({ tags: [tag], archived: true });
      await seedQuestion({ tags: [tag], orgId: orgB });
      await http()
        .post(`${API}/tests`)
        .set(who.auth)
        .send(withRule({ tags: [tag] }))
        .expect(422);
      await seedQuestion({ tags: [tag] });
      await http()
        .post(`${API}/tests`)
        .set(who.auth)
        .send(withRule({ tags: [tag] }))
        .expect(201);
    });

    it('TC-020: tags must all match (hasEvery), and the type filter applies', async () => {
      const who = await make(UserRole.RECRUITER);
      const t1 = `a-${++seq}`;
      const t2 = `b-${seq}`;
      await seedQuestion({ tags: [t1], type: 'CODING' });
      await http()
        .post(`${API}/tests`)
        .set(who.auth)
        .send(withRule({ tags: [t1, t2] }))
        .expect(422);
      await http()
        .post(`${API}/tests`)
        .set(who.auth)
        .send(withRule({ tags: [t1], type: 'MCQ' }))
        .expect(422);
      await http()
        .post(`${API}/tests`)
        .set(who.auth)
        .send(withRule({ tags: [t1], type: 'CODING' }))
        .expect(201);
    });

    it('TC-020: two slots with the same rule need two different matching questions', async () => {
      const who = await make(UserRole.RECRUITER);
      const tag = `pair-${++seq}`;
      await seedQuestion({ tags: [tag] });
      const two = (): Json => ({
        name: 'Pair',
        durationMinutes: 60,
        sections: [
          {
            title: 'S',
            questions: [{ randomRule: { tags: [tag] } }, { randomRule: { tags: [tag] } }],
          },
        ],
      });
      const res = await http().post(`${API}/tests`).set(who.auth).send(two());
      expect(res.status).toBe(422);
      expect(JSON.stringify(res.body)).toMatch(/sections\[0\]\.questions\[1\]\.randomRule matches/);
      await seedQuestion({ tags: [tag] });
      await http().post(`${API}/tests`).set(who.auth).send(two()).expect(201);
    });

    it('TC-020, FU-BE-116: overlapping rules that pass one by one but need 3 different questions are 422', async () => {
      const who = await make(UserRole.RECRUITER);
      const a = `ov-a-${++seq}`;
      const b = `ov-b-${seq}`;
      await seedQuestion({ tags: [a, b] });
      await seedQuestion({ tags: [a] });
      const three = (): Json => ({
        name: 'Overlap',
        durationMinutes: 60,
        sections: [
          {
            title: 'S',
            questions: [
              { randomRule: { tags: [a] } },
              { randomRule: { tags: [a] } },
              { randomRule: { tags: [a, b] } },
            ],
          },
        ],
      });
      const before = await owner.test.count();
      const res = await http().post(`${API}/tests`).set(who.auth).send(three());
      expect(res.status).toBe(422);
      expect(JSON.stringify(res.body)).toMatch(/randomRule matches/);
      expect(await owner.test.count()).toBe(before);
      await seedQuestion({ tags: [a] });
      await http().post(`${API}/tests`).set(who.auth).send(three()).expect(201);
    });

    it('TC-020, FU-BE-116: a fixed question is not available to a random slot of the same test', async () => {
      const who = await make(UserRole.RECRUITER);
      const tag = `fx-${++seq}`;
      const one = await seedQuestion({ tags: [tag] });
      const mixed = (): Json => ({
        name: 'Mixed',
        durationMinutes: 60,
        sections: [
          { title: 'S', questions: [fixed(one.versionId), { randomRule: { tags: [tag] } }] },
        ],
      });
      const res = await http().post(`${API}/tests`).set(who.auth).send(mixed());
      expect(res.status).toBe(422);
      expect(JSON.stringify(res.body)).toMatch(/sections\[0\]\.questions\[1\]\.randomRule/);
      await seedQuestion({ tags: [tag] });
      await http().post(`${API}/tests`).set(who.auth).send(mixed()).expect(201);
    });
  });

  // ---- later changes: checkTestSatisfiable (FU-BE-114) -----------------------------------------

  describe('TC-020, FU-BE-114: checkTestSatisfiable re-checks a saved test, read-only and org-scoped', () => {
    it('TC-020: a test that was satisfiable at save turns unsatisfiable after an archive, with no writes', async () => {
      const who = await make(UserRole.RECRUITER);
      const tag = `late-${++seq}`;
      const q1 = await seedQuestion({ tags: [tag] });
      await seedQuestion({ tags: [tag] });
      const t = await create(who, {
        name: 'Later',
        durationMinutes: 60,
        sections: [
          {
            title: 'S',
            questions: [{ randomRule: { tags: [tag] } }, { randomRule: { tags: [tag] } }],
          },
        ],
      });
      const id = t.id as string;
      const { TestsService: Svc } =
        jest.requireActual<typeof import('./tests.service')>('./tests.service');
      const service = app.get(Svc);
      const { OrgContextService: Ctx } =
        jest.requireActual<typeof import('../database/org-context')>('../database/org-context');
      const inOrg = <T>(orgId: string, fn: () => Promise<T>): Promise<T> =>
        app.get(Ctx).runInOrg(orgId, fn);
      const audits = await owner.auditLog.count();
      expect(await inOrg(orgA, () => service.checkTestSatisfiable(id))).toEqual({
        satisfiable: true,
        problems: [],
      });
      await owner.question.update({ where: { id: q1.questionId }, data: { isArchived: true } });
      const after = await inOrg(orgA, () => service.checkTestSatisfiable(id));
      expect(after.satisfiable).toBe(false);
      expect(after.problems).toHaveLength(1);
      expect(after.problems[0]).toMatch(
        /^sections\[0\]\.questions\[\d\]\.randomRule matches \d+ published/,
      );
      expect(await owner.auditLog.count()).toBe(audits);
      await expect(inOrg(orgB, () => service.checkTestSatisfiable(id))).rejects.toThrow(
        /Test not found/,
      );
    });
  });

  // ---- org isolation -------------------------------------------------------------------------------

  describe('TC-008 style: tests are isolated per organization', () => {
    it('TC-008: another organization sees a test as missing, in list, get and edit, and cannot change it', async () => {
      const a = await make(UserRole.RECRUITER, orgA);
      const b = await make(UserRole.RECRUITER, orgB);
      const t = await create(a, await body({ name: 'Secret test of A' }));
      const id = t.id as string;

      const foreign = await http().get(`${API}/tests/${id}`).set(b.auth);
      const missing = await http().get(`${API}/tests/${GHOST}`).set(b.auth);
      expect([foreign.status, missing.status]).toEqual([404, 404]);
      expect(stable(foreign)).toEqual(stable(missing));

      const patchForeign = await http()
        .patch(`${API}/tests/${id}`)
        .set(b.auth)
        .send({ name: 'Mine now' });
      const patchMissing = await http()
        .patch(`${API}/tests/${GHOST}`)
        .set(b.auth)
        .send({ name: 'Mine now' });
      expect([patchForeign.status, patchMissing.status]).toEqual([404, 404]);
      expect(stable(patchForeign)).toEqual(stable(patchMissing));

      const list = await http().get(`${API}/tests?search=Secret`).set(b.auth).expect(200);
      expect(list.body).toMatchObject({ items: [], total: 0 });
      const own = await http().get(`${API}/tests?search=Secret`).set(a.auth).expect(200);
      expect((own.body as { total: number }).total).toBe(1);

      const row = await owner.test.findUniqueOrThrow({ where: { id } });
      expect(row.name).toBe('Secret test of A');
      expect(await audit('TEST_UPDATED', id)).toHaveLength(0);
    });
  });

  // ---- update --------------------------------------------------------------------------------------

  describe('FR-301: edit', () => {
    it('FR-301: an unused test can be renamed, re-timed and given new sections; one audit row names the fields', async () => {
      const who = await make(UserRole.RECRUITER);
      const t = await create(who);
      const id = t.id as string;
      const { versionId } = await seedQuestion();
      const res = await http()
        .patch(`${API}/tests/${id}`)
        .set(who.auth)
        .send({
          name: 'New name',
          durationMinutes: 90,
          profile: 'STRICT',
          passScore: 10,
          sections: [{ title: 'Only', timeLimitMin: 90, questions: [fixed(versionId, 10)] }],
        })
        .expect(200);
      expect(res.body).toMatchObject({
        name: 'New name',
        durationMinutes: 90,
        profile: 'STRICT',
        passScore: 10,
        sectionCount: 1,
        questionCount: 1,
      });
      expect(sectionTitles(res.body as Json)).toEqual(['Only']);
      expect(await owner.testSection.count({ where: { testId: id } })).toBe(1);
      const rows = await audit('TEST_UPDATED', id);
      expect(rows).toHaveLength(1);
      expect((rows[0]?.metadata as { fields: string[] }).fields.sort()).toEqual(
        ['durationMinutes', 'name', 'passScore', 'profile', 'sections'].sort(),
      );
    });

    it('FR-301: a scalar-only edit is checked against the stored sections (limits, points)', async () => {
      const who = await make(UserRole.RECRUITER);
      const t = await create(who); // limits 20 + 40, points 50 + 100
      const id = t.id as string;
      const tooShort = await http()
        .patch(`${API}/tests/${id}`)
        .set(who.auth)
        .send({ durationMinutes: 59 });
      expect(tooShort.status).toBe(400);
      expect(JSON.stringify(tooShort.body)).toMatch(/add up to 60 minutes/);
      await http()
        .patch(`${API}/tests/${id}`)
        .set(who.auth)
        .send({ passScore: 150.01 })
        .expect(400);
      await http().patch(`${API}/tests/${id}`).set(who.auth).send({ passScore: 150 }).expect(200);
      const row = await owner.test.findUniqueOrThrow({ where: { id } });
      expect([row.durationMinutes, Number(row.passScore)]).toEqual([60, 150]);
    });

    it.each([
      ['empty body', {}],
      ['LOCKDOWN', { profile: 'LOCKDOWN' }],
      ['null name', { name: null }],
      ['null sections', { sections: null }],
      ['empty sections', { sections: [] }],
      ['unknown field', { createdById: GHOST }],
    ])('FR-301: edit with %s is 400 and changes nothing', async (_n, over) => {
      const who = await make(UserRole.RECRUITER);
      const t = await create(who);
      const id = t.id as string;
      await http().patch(`${API}/tests/${id}`).set(who.auth).send(over).expect(400);
      expect(await audit('TEST_UPDATED', id)).toHaveLength(0);
      expect((await owner.test.findUniqueOrThrow({ where: { id } })).profile).toBe('STANDARD');
    });

    it('FR-301: a failed replacement (unsatisfiable rule, draft version) leaves the old sections', async () => {
      const who = await make(UserRole.RECRUITER);
      const t = await create(who);
      const id = t.id as string;
      const draft = await seedQuestion({ published: false });
      const before = await owner.testSection.findMany({
        where: { testId: id },
        orderBy: { position: 'asc' },
      });
      const rule = await http()
        .patch(`${API}/tests/${id}`)
        .set(who.auth)
        .send({
          name: 'Half done',
          sections: [{ title: 'X', questions: [{ randomRule: { tags: ['nope-nope'] } }] }],
        });
      expect(rule.status).toBe(422);
      const unpublished = await http()
        .patch(`${API}/tests/${id}`)
        .set(who.auth)
        .send({ sections: [{ title: 'X', questions: [fixed(draft.versionId)] }] });
      expect(unpublished.status).toBe(404);
      const after = await owner.testSection.findMany({
        where: { testId: id },
        orderBy: { position: 'asc' },
      });
      expect(after.map((s) => s.id)).toEqual(before.map((s) => s.id));
      expect((await owner.test.findUniqueOrThrow({ where: { id } })).name).toBe('Backend screen');
    });

    it('FR-301 PATCH on used test 409: a test with an invitation is never edited in place', async () => {
      const who = await make(UserRole.RECRUITER);
      const t = await create(who);
      const id = t.id as string;
      await seedInvitation(id);
      const res = await http().patch(`${API}/tests/${id}`).set(who.auth).send({ name: 'Edited' });
      expect(res.status).toBe(409);
      const sections = await http()
        .patch(`${API}/tests/${id}`)
        .set(who.auth)
        .send({ sections: [{ title: 'X', questions: [fixed((await seedQuestion()).versionId)] }] });
      expect(sections.status).toBe(409);
      const row = await owner.test.findUniqueOrThrow({ where: { id } });
      expect(row.name).toBe('Backend screen');
      expect(await owner.testSection.count({ where: { testId: id } })).toBe(2);
      expect(await audit('TEST_UPDATED', id)).toHaveLength(0);
      const read = await http().get(`${API}/tests/${id}`).set(who.auth).expect(200);
      expect((read.body as Json).used).toBe(true);
    });

    it('FR-301 PATCH on used test 409: a test with a session is 409 too', async () => {
      const who = await make(UserRole.RECRUITER);
      const t = await create(who);
      const id = t.id as string;
      const invitationId = await seedInvitation(id);
      await owner.session.create({ data: { orgId: orgA, invitationId } });
      await http().patch(`${API}/tests/${id}`).set(who.auth).send({ name: 'Edited' }).expect(409);
    });

    it('FR-301 edit vs invite race: an invitation insert in flight makes the edit wait, then 409, nothing changed', async () => {
      const who = await make(UserRole.RECRUITER);
      const t = await create(who);
      const id = t.id as string;
      const n = ++seq;
      const cand = await owner.candidate.create({
        data: { orgId: orgA, email: `race${n}@example.com`, fullName: 'Race' },
      });
      // An invitation insert that has not committed yet (as BE-06 slice 6b's will be).
      const other = new Client({ connectionString: infra.postgres.getConnectionUri() });
      await other.connect();
      try {
        await other.query('BEGIN');
        await other.query(
          `INSERT INTO invitations (org_id, test_id, candidate_id, token_hash, window_start, window_end)
           VALUES ($1, $2, $3, $4, now(), now() + interval '1 hour')`,
          [orgA, id, cand.id, randomBytes(32).toString('hex')],
        );
        let settled = false;
        const patch = http()
          .patch(`${API}/tests/${id}`)
          .set(who.auth)
          .send({ name: 'Raced' })
          .then((r) => {
            settled = true;
            return r;
          });
        await new Promise((r) => setTimeout(r, 1000));
        expect(settled).toBe(false); // waiting on the invitation's key-share lock
        await other.query('COMMIT');
        const res = await patch;
        expect(res.status).toBe(409);
      } finally {
        await other.end();
      }
      expect((await owner.test.findUniqueOrThrow({ where: { id } })).name).toBe('Backend screen');
    });

    it('FR-301 edit vs invite race: an invitation insert waits for an edit in flight and is not lost', async () => {
      const who = await make(UserRole.RECRUITER);
      const t = await create(who);
      const id = t.id as string;
      const n = ++seq;
      const cand = await owner.candidate.create({
        data: { orgId: orgA, email: `race${n}@example.com`, fullName: 'Race' },
      });
      // Hold the tests row exactly as the edit does, then insert an invitation concurrently.
      const holder = new Client({ connectionString: infra.postgres.getConnectionUri() });
      await holder.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT id FROM tests WHERE id = $1 FOR UPDATE', [id]);
        let inserted = false;
        const insert = owner.invitation
          .create({
            data: {
              orgId: orgA,
              testId: id,
              candidateId: cand.id,
              tokenHash: randomBytes(32).toString('hex'),
              windowStart: new Date(),
              windowEnd: new Date(Date.now() + 3_600_000),
            },
          })
          .then((r) => {
            inserted = true;
            return r;
          });
        await new Promise((r) => setTimeout(r, 800));
        expect(inserted).toBe(false);
        await holder.query('COMMIT');
        await insert;
      } finally {
        await holder.end();
      }
      await http().patch(`${API}/tests/${id}`).set(who.auth).send({ name: 'Late' }).expect(409);
    });

    it('FR-301: two edits at once serialize; the test ends with exactly one complete section set', async () => {
      const who = await make(UserRole.RECRUITER);
      const t = await create(who);
      const id = t.id as string;
      const { versionId } = await seedQuestion();
      const sections = (title: string, count: number): Json[] =>
        Array.from({ length: count }, (_v, i) => ({
          title: `${title}${i}`,
          questions: [fixed(versionId, 10)],
        }));
      const results = await Promise.all([
        http()
          .patch(`${API}/tests/${id}`)
          .set(who.auth)
          .send({ sections: sections('A', 3) }),
        http()
          .patch(`${API}/tests/${id}`)
          .set(who.auth)
          .send({ sections: sections('B', 2) }),
      ]);
      expect(results.map((r) => r.status)).toEqual([200, 200]);
      const rows = await owner.testSection.findMany({
        where: { testId: id },
        orderBy: { position: 'asc' },
      });
      const prefixes = new Set(rows.map((r) => r.title[0]));
      expect(prefixes.size).toBe(1);
      expect(rows.map((r) => r.position)).toEqual(rows.map((_r, i) => i + 1));
      expect(rows.length).toBe(prefixes.has('A') ? 3 : 2);
      const qs = await owner.testQuestion.count({
        where: { sectionId: { in: rows.map((r) => r.id) } },
      });
      expect(qs).toBe(rows.length);
    });
  });

  // ---- list / get ----------------------------------------------------------------------------------

  describe('FR-301: list and get', () => {
    it('FR-301: search treats % _ and backslash literally, not as wildcards', async () => {
      const who = await make(UserRole.RECRUITER);
      const tag = `lit${++seq}`;
      await create(who, await body({ name: `${tag} plain` }));
      await create(who, await body({ name: `${tag} 100%_done\\x` }));
      const total = async (term: string): Promise<number> =>
        (
          (
            await http()
              .get(`${API}/tests`)
              .query({ search: term, pageSize: 100 })
              .set(who.auth)
              .expect(200)
          ).body as { total: number }
        ).total;
      expect(await total('%')).toBe(1);
      expect(await total('_')).toBe(1);
      expect(await total('\\')).toBe(1);
      expect(await total(`${tag} 100%_done\\x`)).toBe(1);
      expect(await total(`${tag}%`)).toBe(0);
    });

    it('FR-301: pagination, filters and the used flag', async () => {
      const who = await make(UserRole.RECRUITER);
      const tag = `list${++seq}`;
      const a = await create(who, await body({ name: `${tag} alpha` }));
      await create(who, await body({ name: `${tag} Beta`, profile: 'STRICT' }));
      await create(who, await body({ name: `${tag} gamma` }));
      await seedInvitation(a.id as string);

      const q = (qs: string): Promise<request.Response> =>
        http().get(`${API}/tests?${qs}`).set(who.auth);
      const all = (await q(`search=${tag}`)).body as { items: Json[]; total: number };
      expect(all.total).toBe(3);
      expect(all.items[0]).toMatchObject({
        name: `${tag} gamma`,
        sectionCount: 2,
        questionCount: 2,
      });
      const page2 = (await q(`search=${tag}&pageSize=2&page=2`)).body as {
        items: Json[];
        total: number;
      };
      expect([page2.items.length, page2.total]).toEqual([1, 3]);
      expect(
        ((await q(`search=${tag.toUpperCase()}&profile=STRICT`)).body as { total: number }).total,
      ).toBe(1);
      const used = (await q(`search=${tag}&used=true`)).body as { items: Json[] };
      expect(used.items.map((i) => i.id)).toEqual([a.id]);
      expect(((await q(`search=${tag}&used=false`)).body as { total: number }).total).toBe(2);
    });

    it.each([
      ['page 0', 'page=0'],
      ['page size 101', 'pageSize=101'],
      ['a page too deep', 'page=100000&pageSize=100'],
      ['profile LOCKDOWN', 'profile=LOCKDOWN'],
      ['used maybe', 'used=maybe'],
      ['unknown filter', 'foo=1'],
      ['search of 101 chars', `search=${'x'.repeat(101)}`],
    ])('FR-301: list with %s is 400', async (_n, qs) => {
      const who = await make(UserRole.RECRUITER);
      await http().get(`${API}/tests?${qs}`).set(who.auth).expect(400);
    });

    it('FR-301: a malformed id is 400 and an unknown id is 404, never 500', async () => {
      const who = await make(UserRole.RECRUITER);
      await http().get(`${API}/tests/not-a-uuid`).set(who.auth).expect(400);
      await http().patch(`${API}/tests/not-a-uuid`).set(who.auth).send({ name: 'x' }).expect(400);
      await http().get(`${API}/tests/${GHOST}`).set(who.auth).expect(404);
      await http().patch(`${API}/tests/${GHOST}`).set(who.auth).send({ name: 'x' }).expect(404);
    });

    it('FR-301: staff reads never carry reference solutions or hidden data (only titles and difficulty of fixed questions)', async () => {
      const who = await make(UserRole.RECRUITER);
      const t = await create(who);
      const text = JSON.stringify(t);
      expect(text).not.toMatch(/referenceSolution|answerSpec|statementMd|testCases/);
    });
  });
});
