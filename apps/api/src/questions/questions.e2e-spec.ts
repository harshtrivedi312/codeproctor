// Question bank (FR-201, FR-202, FR-204, FR-205) against real Postgres 16 and Redis
// (Testcontainers), the API running as app_user as in production (ADR 0006).
import { INestApplication } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';
import { passwordVersion } from '../auth/crypto.util';
import type { TokenService } from '../common/auth/token.service';
import { createPrismaClient } from '../database/create-prisma-client';
import { PrismaClient, UserRole } from '../generated/prisma/client';
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

const sampleCase = { input: '1 2', expectedOutput: '3', isHidden: false, weight: 1 };
const hiddenCase = {
  input: 'HIDDEN-IN-9',
  expectedOutput: 'HIDDEN-OUT-9',
  isHidden: true,
  weight: 2,
};

const codingBody = (over: Json = {}): Json => ({
  title: 'Two sum',
  statementMd: 'Add two numbers.',
  difficulty: 'EASY',
  tags: ['arrays', 'Math'],
  allowedLanguages: ['python'],
  starterCode: { python: 'def solve(): ...' },
  referenceSolution: { python: 'REFERENCE-SECRET' },
  testCases: [sampleCase, hiddenCase],
  ...over,
});

const mcqSpec = {
  options: [
    { id: 'a', text: 'Red' },
    { id: 'b', text: 'Blue' },
  ],
  correctOptionIds: ['b'],
  multiple: false,
};

describe('Question bank (FR-201..FR-205, TC-010, TC-011, TC-013, TC-014)', () => {
  let infra: TestInfra;
  let app: INestApplication<App>;
  let owner: PrismaClient;
  let pg: Client;
  let PgClient: typeof Client;
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
    applyEnv(infra, { DATABASE_URL: url, LOG_LEVEL: 'silent' });
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
    PgClient = jest.requireActual<typeof import('pg')>('pg').Client;
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
      data: { orgId, email: `q${n}@example.com`, fullName: `Q ${n}`, role, passwordHash },
    });
    const token = tokens.sign(
      { sub: user.id, org: orgId, role, kind: 'access', pwv: passwordVersion(passwordHash) },
      900,
    );
    return { id: user.id, auth: { Authorization: `Bearer ${token}` } };
  }

  const http = (): ReturnType<typeof request> => request(app.getHttpServer());

  async function create(who: Made, body: Json = codingBody()): Promise<Json> {
    const res = await http().post(`${API}/questions`).set(who.auth).send(body);
    expect([res.status, res.body]).toEqual([201, expect.anything()]);
    return res.body as Json;
  }

  const idOf = (q: Json): string => q.id as string;
  const versionOf = (q: Json): Json => q.version as Json;

  async function publishable(who: Made, over: Json = {}): Promise<Json> {
    const q = await create(who, codingBody(over));
    await http()
      .post(`${API}/questions/${idOf(q)}/publish`)
      .set(who.auth)
      .expect(200);
    return q;
  }

  async function statementsDuring(run: () => Promise<unknown>): Promise<number> {
    const spy = jest.spyOn(PgClient.prototype, 'query');
    try {
      await run();
      return spy.mock.calls.length;
    } finally {
      spy.mockRestore();
    }
  }

  async function audit(action: string, entityId: string): Promise<Json[]> {
    const r = await pg.query(
      `SELECT org_id, actor_id, metadata FROM audit_logs WHERE action = $1 AND entity_id = $2 ORDER BY id`,
      [action, entityId],
    );
    return r.rows as Json[];
  }

  // ---- TC-010: create ---------------------------------------------------------------------------

  describe('FR-201, FR-202, TC-010: create a coding question', () => {
    it('TC-010: all fields saved as draft version 1, normalized tags, default limits, audit row', async () => {
      const author = await make(UserRole.AUTHOR);
      const q = await create(author);
      expect(q).toMatchObject({
        type: 'CODING',
        tags: ['arrays', 'math'],
        isArchived: false,
        published: null,
        createdNewVersion: false,
      });
      expect(q.slug).toMatch(/^two-sum-[0-9a-f]{6}$/);
      expect(versionOf(q)).toMatchObject({
        version: 1,
        isPublished: false,
        title: 'Two sum',
        difficulty: 'EASY',
        allowedLanguages: ['python'],
        limits: { cpuMs: 2000, wallMs: 5000, memoryKb: 262_144 },
        starterCode: { python: 'def solve(): ...' },
        referenceSolution: { python: 'REFERENCE-SECRET' },
      });
      const cases = versionOf(q).testCases as Json[];
      expect(cases.map((c) => [c.position, c.isHidden, c.weight])).toEqual([
        [0, false, 1],
        [1, true, 2],
      ]);
      const row = await owner.question.findUniqueOrThrow({ where: { id: idOf(q) } });
      expect(row).toMatchObject({ orgId: orgA, createdById: author.id, currentVersionId: null });
      const rows = await audit('QUESTION_CREATED', idOf(q));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ org_id: orgA, actor_id: author.id });
      expect(JSON.stringify(rows[0]?.metadata)).not.toContain('REFERENCE-SECRET');
    });

    it('FR-201: an explicit slug is kept; a duplicate in the same org is 409 and writes nothing', async () => {
      const a = await make(UserRole.AUTHOR);
      await create(a, codingBody({ slug: 'fizz-buzz' }));
      const before = await owner.question.count();
      await http()
        .post(`${API}/questions`)
        .set(a.auth)
        .send(codingBody({ slug: 'fizz-buzz' }))
        .expect(409);
      expect(await owner.question.count()).toBe(before);
      const b = await make(UserRole.AUTHOR, orgB);
      await create(b, codingBody({ slug: 'fizz-buzz' }));
    });

    it('FR-201: DTO bounds on every field (400, nothing written)', async () => {
      const a = await make(UserRole.AUTHOR);
      const before = await owner.question.count();
      const bad: Json[] = [
        codingBody({ title: '' }),
        codingBody({ title: 'x'.repeat(201) }),
        codingBody({ statementMd: '' }),
        codingBody({ statementMd: 'x'.repeat(50_001) }),
        codingBody({ difficulty: 'IMPOSSIBLE' }),
        codingBody({ type: 'ESSAY' }),
        codingBody({ slug: 'Bad Slug' }),
        codingBody({ tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }),
        codingBody({ tags: ['dup', 'dup'] }),
        codingBody({ tags: ['bad tag!'] }),
        codingBody({ allowedLanguages: ['cobol'] }),
        codingBody({ allowedLanguages: ['python', 'python'] }),
        codingBody({ limits: { cpuMs: 50, wallMs: 5000, memoryKb: 262_144 } }),
        codingBody({ limits: { cpuMs: 1000, wallMs: 99_999, memoryKb: 262_144 } }),
        codingBody({ limits: { cpuMs: 1000, wallMs: 5000, memoryKb: 1 } }),
        codingBody({ limits: { cpuMs: 3000, wallMs: 2000, memoryKb: 65_536 } }),
        codingBody({ starterCode: { cobol: 'x' } }),
        codingBody({ referenceSolution: { python: 'x'.repeat(100_001) } }),
        codingBody({ testCases: [{ ...sampleCase, weight: 0 }] }),
        codingBody({ testCases: [{ ...sampleCase, weight: 1.234 }] }),
        codingBody({ testCases: [{ ...sampleCase, input: 'x'.repeat(100_001) }] }),
        codingBody({ testCases: Array.from({ length: 101 }, () => sampleCase) }),
        codingBody({ answerSpec: mcqSpec }),
        codingBody({ unknownField: 1 }),
        { ...codingBody(), title: undefined },
      ];
      for (const body of bad) {
        const res = await http().post(`${API}/questions`).set(a.auth).send(body);
        expect([JSON.stringify(body).slice(0, 80), res.status]).toEqual([
          JSON.stringify(body).slice(0, 80),
          400,
        ]);
      }
      expect(await owner.question.count()).toBe(before);
    });
  });

  // ---- role matrix (TC-004 style) --------------------------------------------------------------

  describe('FR-103, TC-004: roles on the question routes', () => {
    it('TC-004: REVIEWER is 403 on every route, RECRUITER only reads, nothing changes', async () => {
      const author = await make(UserRole.AUTHOR);
      const q = await publishable(author);
      const id = idOf(q);
      const tc = ((versionOf(q).testCases as Json[])[0] as Json).id as string;
      const before = JSON.stringify(
        await owner.questionVersion.findMany({ where: { questionId: id } }),
      );
      const calls = (who: Made): Record<string, request.Test> => ({
        list: http().get(`${API}/questions`).set(who.auth),
        get: http().get(`${API}/questions/${id}`).set(who.auth),
        preview: http().get(`${API}/questions/${id}/preview`).set(who.auth),
        create: http().post(`${API}/questions`).set(who.auth).send(codingBody()),
        patch: http().patch(`${API}/questions/${id}`).set(who.auth).send({ title: 'Hacked' }),
        publish: http().post(`${API}/questions/${id}/publish`).set(who.auth),
        archive: http().post(`${API}/questions/${id}/archive`).set(who.auth),
        unarchive: http().post(`${API}/questions/${id}/unarchive`).set(who.auth),
        addTc: http()
          .post(`${API}/questions/${id}/versions/1/test-cases`)
          .set(who.auth)
          .send(sampleCase),
        patchTc: http()
          .patch(`${API}/questions/${id}/versions/1/test-cases/${tc}`)
          .set(who.auth)
          .send({ weight: 5 }),
        delTc: http().delete(`${API}/questions/${id}/versions/1/test-cases/${tc}`).set(who.auth),
      });
      const reviewer = await make(UserRole.REVIEWER);
      for (const [name, call] of Object.entries(calls(reviewer))) {
        expect([name, (await call).status]).toEqual([name, 403]);
      }
      const recruiter = await make(UserRole.RECRUITER);
      for (const [name, call] of Object.entries(calls(recruiter))) {
        const expected = ['list', 'get', 'preview'].includes(name) ? 200 : 403;
        expect([name, (await call).status]).toEqual([name, expected]);
      }
      for (const name of ['list', 'get', 'preview', 'create']) {
        const admin = await make(UserRole.SUPER_ADMIN);
        const res = await calls(admin)[name];
        expect([name, res?.status]).toEqual([name, name === 'create' ? 201 : 200]);
      }
      await http().get(`${API}/questions`).expect(401);
      expect(
        JSON.stringify(await owner.questionVersion.findMany({ where: { questionId: id } })),
      ).toBe(before);
    });

    it('FR-201: a recruiter never receives the reference solution, answer_spec or hidden test data', async () => {
      const author = await make(UserRole.AUTHOR);
      const q = await publishable(author);
      const recruiter = await make(UserRole.RECRUITER);
      const res = await http()
        .get(`${API}/questions/${idOf(q)}`)
        .set(recruiter.auth)
        .expect(200);
      const text = JSON.stringify(res.body);
      expect(text).not.toContain('REFERENCE-SECRET');
      expect(text).not.toContain('HIDDEN-IN-9');
      expect(text).not.toContain('HIDDEN-OUT-9');
      expect(text).not.toContain('referenceSolution');
      const cases = (res.body as { version: { testCases: Json[] } }).version.testCases;
      expect(cases.map((c) => [c.isHidden, c.input === null])).toEqual([
        [false, false],
        [true, true],
      ]);
      const full = await http()
        .get(`${API}/questions/${idOf(q)}`)
        .set(author.auth)
        .expect(200);
      expect(JSON.stringify(full.body)).toContain('REFERENCE-SECRET');
    });
  });

  // ---- TC-011: candidate-facing view -----------------------------------------------------------

  describe('FR-202, TC-011: the candidate-facing view', () => {
    it('TC-011: preview shows the statement and sample cases only, no hidden case, reference or key', async () => {
      const author = await make(UserRole.AUTHOR);
      const q = await publishable(author);
      const res = await http()
        .get(`${API}/questions/${idOf(q)}/preview`)
        .set(author.auth)
        .expect(200);
      expect(res.body).toEqual({
        type: 'CODING',
        title: 'Two sum',
        statementMd: 'Add two numbers.',
        languages: ['python'],
        limits: { cpuMs: 2000, wallMs: 5000, memoryKb: 262_144 },
        starterCode: { python: 'def solve(): ...' },
        samples: [{ input: '1 2', expectedOutput: '3' }],
      });
      const text = JSON.stringify(res.body);
      for (const s of ['HIDDEN-IN-9', 'HIDDEN-OUT-9', 'REFERENCE-SECRET']) {
        expect(text).not.toContain(s);
      }
    });

    it('TC-014, FR-205: an MCQ preview has the options but not the key', async () => {
      const author = await make(UserRole.AUTHOR);
      const q = await create(author, {
        type: 'MCQ',
        title: 'Colour',
        statementMd: 'Pick one.',
        difficulty: 'EASY',
        answerSpec: mcqSpec,
      });
      const res = await http()
        .get(`${API}/questions/${idOf(q)}/preview`)
        .set(author.auth)
        .expect(200);
      expect(res.body).toMatchObject({
        type: 'MCQ',
        mcq: { multiple: false, options: mcqSpec.options },
        samples: [],
      });
      expect(JSON.stringify(res.body)).not.toContain('correctOptionIds');
    });
  });

  // ---- FR-204, TC-013: versioning and immutability --------------------------------------------

  describe('FR-204, TC-013: versions and immutable published versions', () => {
    it('TC-013: editing a draft updates it in place and clears the validation result', async () => {
      const a = await make(UserRole.AUTHOR);
      const q = await create(a);
      const id = idOf(q);
      await owner.questionVersion.updateMany({
        where: { questionId: id },
        data: { validatedAt: new Date(), validationReport: { ok: true } },
      });
      const res = await http()
        .patch(`${API}/questions/${id}`)
        .set(a.auth)
        .send({ title: 'Two sum v2', difficulty: 'HARD', tags: ['x'] })
        .expect(200);
      expect(res.body).toMatchObject({ createdNewVersion: false, tags: ['x'] });
      expect(versionOf(res.body as Json)).toMatchObject({
        version: 1,
        title: 'Two sum v2',
        difficulty: 'HARD',
        validatedAt: null,
      });
      expect(await owner.questionVersion.count({ where: { questionId: id } })).toBe(1);
      expect(await audit('QUESTION_UPDATED', id)).toHaveLength(1);
    });

    it('TC-013: editing a published question creates version 2 as a draft; version 1 and the current pointer stay', async () => {
      const a = await make(UserRole.AUTHOR);
      const q = await publishable(a);
      const id = idOf(q);
      const v1Before = await owner.questionVersion.findFirstOrThrow({
        where: { questionId: id, version: 1 },
      });
      const res = await http()
        .patch(`${API}/questions/${id}`)
        .set(a.auth)
        .send({ title: 'Edited', statementMd: 'New statement' })
        .expect(200);
      expect(res.body).toMatchObject({ createdNewVersion: true });
      expect(versionOf(res.body as Json)).toMatchObject({
        version: 2,
        isPublished: false,
        title: 'Edited',
        statementMd: 'New statement',
        referenceSolution: { python: 'REFERENCE-SECRET' },
      });
      expect((versionOf(res.body as Json).testCases as Json[]).length).toBe(2);
      const v1After = await owner.questionVersion.findFirstOrThrow({
        where: { questionId: id, version: 1 },
      });
      expect(v1After).toEqual(v1Before);
      const question = await owner.question.findUniqueOrThrow({ where: { id } });
      expect(question.currentVersionId).toBe(v1Before.id);
      expect(await owner.testCase.count({ where: { questionVersionId: v1Before.id } })).toBe(2);
      expect((await audit('QUESTION_VERSION_CREATED', id))[0]?.metadata).toMatchObject({
        version: 2,
        fromVersion: 1,
      });
      // A second edit changes the draft in place.
      const again = await http()
        .patch(`${API}/questions/${id}`)
        .set(a.auth)
        .send({ title: 'E2' })
        .expect(200);
      expect(again.body).toMatchObject({ createdNewVersion: false });
      expect(await owner.questionVersion.count({ where: { questionId: id } })).toBe(2);
      // Publishing v2 moves the pointer; v1 is still published and untouched.
      await http().post(`${API}/questions/${id}/publish`).set(a.auth).expect(200);
      const q2 = await owner.question.findUniqueOrThrow({ where: { id } });
      expect(q2.currentVersionId).not.toBe(v1Before.id);
      expect(
        await owner.questionVersion.findFirstOrThrow({ where: { questionId: id, version: 1 } }),
      ).toEqual(v1Before);
      const old = await http().get(`${API}/questions/${id}?version=1`).set(a.auth).expect(200);
      expect(versionOf(old.body as Json)).toMatchObject({ version: 1, title: 'Two sum' });
    });

    it('TC-013: test cases of a published version cannot be added, changed or removed (409)', async () => {
      const a = await make(UserRole.AUTHOR);
      const q = await publishable(a);
      const id = idOf(q);
      const tc = ((versionOf(q).testCases as Json[])[0] as Json).id as string;
      const before = JSON.stringify(
        await owner.testCase.findMany({
          orderBy: { id: 'asc' },
          where: { questionVersion: { questionId: id } },
        }),
      );
      await http()
        .post(`${API}/questions/${id}/versions/1/test-cases`)
        .set(a.auth)
        .send(sampleCase)
        .expect(409);
      await http()
        .patch(`${API}/questions/${id}/versions/1/test-cases/${tc}`)
        .set(a.auth)
        .send({ expectedOutput: 'changed' })
        .expect(409);
      await http()
        .delete(`${API}/questions/${id}/versions/1/test-cases/${tc}`)
        .set(a.auth)
        .expect(409);
      expect(
        JSON.stringify(
          await owner.testCase.findMany({
            orderBy: { id: 'asc' },
            where: { questionVersion: { questionId: id } },
          }),
        ),
      ).toBe(before);
    });

    it('FR-204: tags change on a published question without a new version', async () => {
      const a = await make(UserRole.AUTHOR);
      const q = await publishable(a);
      const res = await http()
        .patch(`${API}/questions/${idOf(q)}`)
        .set(a.auth)
        .send({ tags: ['graphs'] })
        .expect(200);
      expect(res.body).toMatchObject({ tags: ['graphs'], createdNewVersion: false });
      expect(await owner.questionVersion.count({ where: { questionId: idOf(q) } })).toBe(1);
    });

    it('FR-201: an empty PATCH is 400; MCQ and coding shape rules hold on update', async () => {
      const a = await make(UserRole.AUTHOR);
      const q = await create(a);
      await http()
        .patch(`${API}/questions/${idOf(q)}`)
        .set(a.auth)
        .send({})
        .expect(400);
      await http()
        .patch(`${API}/questions/${idOf(q)}`)
        .set(a.auth)
        .send({ answerSpec: mcqSpec })
        .expect(400);
      await http()
        .patch(`${API}/questions/${idOf(q)}`)
        .set(a.auth)
        .send({ type: 'MCQ' })
        .expect(400);
    });
  });

  // ---- publish --------------------------------------------------------------------------------

  describe('FR-201, FR-202: publish', () => {
    it('FR-202: an incomplete draft is 422 with the problems listed and stays a draft', async () => {
      const a = await make(UserRole.AUTHOR);
      const q = await create(a, codingBody({ testCases: [sampleCase], referenceSolution: {} }));
      const res = await http()
        .post(`${API}/questions/${idOf(q)}/publish`)
        .set(a.auth)
        .expect(422);
      expect(res.body).toMatchObject({
        errors: expect.arrayContaining<string>([
          'referenceSolution: at least one language',
          'testCases: at least one hidden test',
        ]) as string[],
      });
      const row = await owner.question.findUniqueOrThrow({ where: { id: idOf(q) } });
      expect(row.currentVersionId).toBeNull();
      expect(
        await owner.questionVersion.count({ where: { questionId: idOf(q), isPublished: true } }),
      ).toBe(0);
      expect(await audit('QUESTION_PUBLISHED', idOf(q))).toHaveLength(0);
    });

    it('FR-201: publishing sets the current version and audits; publishing again is 409', async () => {
      const a = await make(UserRole.AUTHOR);
      const q = await create(a);
      const res = await http()
        .post(`${API}/questions/${idOf(q)}/publish`)
        .set(a.auth)
        .expect(200);
      expect(res.body).toMatchObject({ published: { version: 1, isPublished: true } });
      const row = await owner.question.findUniqueOrThrow({ where: { id: idOf(q) } });
      expect(row.currentVersionId).toBe(versionOf(res.body as Json).id);
      expect(await audit('QUESTION_PUBLISHED', idOf(q))).toHaveLength(1);
      await http()
        .post(`${API}/questions/${idOf(q)}/publish`)
        .set(a.auth)
        .expect(409);
      expect(await audit('QUESTION_PUBLISHED', idOf(q))).toHaveLength(1);
    });

    it('TC-014, FR-205: MCQ and short answer publish with a valid answer_spec; invalid specs are 400', async () => {
      const a = await make(UserRole.AUTHOR);
      const base = { title: 'Q', statementMd: 'S', difficulty: 'EASY' };
      const mcq = await create(a, { ...base, type: 'MCQ', answerSpec: mcqSpec });
      await http()
        .post(`${API}/questions/${idOf(mcq)}/publish`)
        .set(a.auth)
        .expect(200);
      const sa = await create(a, {
        ...base,
        type: 'SHORT_ANSWER',
        answerSpec: { canonical: 'Paris', acceptedVariants: ['paris, france'] },
      });
      await http()
        .post(`${API}/questions/${idOf(sa)}/publish`)
        .set(a.auth)
        .expect(200);
      const draft = await create(a, { ...base, type: 'MCQ' });
      await http()
        .post(`${API}/questions/${idOf(draft)}/publish`)
        .set(a.auth)
        .expect(422);
      for (const bad of [
        { ...mcqSpec, correctOptionIds: ['zzz'] },
        { ...mcqSpec, multiple: true, correctOptionIds: [] },
        { ...mcqSpec, extra: true },
        { canonical: 'x', acceptedVariants: [] },
      ]) {
        await http()
          .post(`${API}/questions`)
          .set(a.auth)
          .send({ ...base, type: 'MCQ', answerSpec: bad })
          .expect(400);
      }
      await http()
        .post(`${API}/questions`)
        .set(a.auth)
        .send({
          ...base,
          type: 'SHORT_ANSWER',
          answerSpec: { canonical: '  ', acceptedVariants: [] },
        })
        .expect(400);
      await http()
        .post(`${API}/questions`)
        .set(a.auth)
        .send({ ...base, type: 'MCQ', answerSpec: mcqSpec, testCases: [sampleCase] })
        .expect(400);
      await http()
        .post(`${API}/questions/${idOf(mcq)}/versions/1/test-cases`)
        .set(a.auth)
        .send(sampleCase)
        .expect(422);
      const d2 = await http()
        .post(`${API}/questions/${idOf(draft)}/versions/1/test-cases`)
        .set(a.auth)
        .send(sampleCase);
      expect(d2.status).toBe(422);
    });
  });

  // ---- test cases ------------------------------------------------------------------------------

  describe('FR-202: test cases on a draft', () => {
    it('FR-202: add, update and remove; positions append; weight and flags stored; each audited', async () => {
      const a = await make(UserRole.AUTHOR);
      const q = await create(a, codingBody({ testCases: [] }));
      const id = idOf(q);
      const base = `${API}/questions/${id}/versions/1/test-cases`;
      const t1 = await http()
        .post(base)
        .set(a.auth)
        .send({ input: 'a', expectedOutput: 'b' })
        .expect(201);
      expect(t1.body).toMatchObject({ position: 0, isHidden: true, weight: 1 });
      const t2 = await http()
        .post(base)
        .set(a.auth)
        .send({ ...sampleCase, weight: 2.5 })
        .expect(201);
      expect(t2.body).toMatchObject({ position: 1, isHidden: false, weight: 2.5 });
      const upd = await http()
        .patch(`${base}/${(t1.body as Json).id as string}`)
        .set(a.auth)
        .send({ isHidden: false, weight: 4, expectedOutput: 'c' })
        .expect(200);
      expect(upd.body).toMatchObject({
        isHidden: false,
        weight: 4,
        expectedOutput: 'c',
        input: 'a',
      });
      await http()
        .patch(`${base}/${(t1.body as Json).id as string}`)
        .set(a.auth)
        .send({})
        .expect(400);
      await http()
        .patch(`${base}/${(t1.body as Json).id as string}`)
        .set(a.auth)
        .send({ weight: 0 })
        .expect(400);
      await http()
        .delete(`${base}/${(t1.body as Json).id as string}`)
        .set(a.auth)
        .expect(204);
      await http()
        .delete(`${base}/${(t1.body as Json).id as string}`)
        .set(a.auth)
        .expect(404);
      await http().patch(`${base}/${GHOST}`).set(a.auth).send({ weight: 1 }).expect(404);
      await http()
        .post(`${API}/questions/${id}/versions/9/test-cases`)
        .set(a.auth)
        .send(sampleCase)
        .expect(404);
      const detail = await http().get(`${API}/questions/${id}`).set(a.auth).expect(200);
      expect((versionOf(detail.body as Json).testCases as Json[]).length).toBe(1);
      for (const action of [
        'QUESTION_TEST_CASE_ADDED',
        'QUESTION_TEST_CASE_UPDATED',
        'QUESTION_TEST_CASE_REMOVED',
      ]) {
        expect((await audit(action, id)).length).toBeGreaterThan(0);
      }
      const all = await pg.query(`SELECT metadata FROM audit_logs WHERE entity_id = $1`, [id]);
      expect(JSON.stringify(all.rows)).not.toMatch(/HIDDEN-IN|HIDDEN-OUT|"input"/);
    });

    it('FR-202: a test case of another question is not reachable through this one (404)', async () => {
      const a = await make(UserRole.AUTHOR);
      const q1 = await create(a);
      const q2 = await create(a);
      const foreign = ((versionOf(q2).testCases as Json[])[0] as Json).id as string;
      await http()
        .delete(`${API}/questions/${idOf(q1)}/versions/1/test-cases/${foreign}`)
        .set(a.auth)
        .expect(404);
      expect(await owner.testCase.count({ where: { id: foreign } })).toBe(1);
    });

    it('FR-202: at most 100 test cases per version (422)', async () => {
      const a = await make(UserRole.AUTHOR);
      const q = await create(
        a,
        codingBody({ testCases: Array.from({ length: 100 }, () => hiddenCase) }),
      );
      await http()
        .post(`${API}/questions/${idOf(q)}/versions/1/test-cases`)
        .set(a.auth)
        .send(sampleCase)
        .expect(422);
    });
  });

  // ---- TC-008: org scope -----------------------------------------------------------------------

  describe('TC-008, FR-103: org scope', () => {
    it('TC-008: another org question is the same 404 as a missing id, with the same statement count, and nothing changes', async () => {
      const a = await make(UserRole.AUTHOR);
      const b = await make(UserRole.AUTHOR, orgB);
      const qb = await publishable(b);
      const idB = idOf(qb);
      const tcB = ((versionOf(qb).testCases as Json[])[0] as Json).id as string;
      const before = JSON.stringify([
        await owner.question.findMany({ orderBy: { id: 'asc' } }),
        await owner.questionVersion.findMany({ orderBy: { id: 'asc' } }),
        await owner.testCase.findMany({ orderBy: { id: 'asc' } }),
      ]);
      const attempts: [string, (id: string) => request.Test][] = [
        ['get', (id) => http().get(`${API}/questions/${id}`).set(a.auth)],
        ['preview', (id) => http().get(`${API}/questions/${id}/preview`).set(a.auth)],
        ['patch', (id) => http().patch(`${API}/questions/${id}`).set(a.auth).send({ title: 'x' })],
        ['publish', (id) => http().post(`${API}/questions/${id}/publish`).set(a.auth)],
        ['archive', (id) => http().post(`${API}/questions/${id}/archive`).set(a.auth)],
        ['unarchive', (id) => http().post(`${API}/questions/${id}/unarchive`).set(a.auth)],
        [
          'addTc',
          (id) =>
            http()
              .post(`${API}/questions/${id}/versions/1/test-cases`)
              .set(a.auth)
              .send(sampleCase),
        ],
        [
          'patchTc',
          (id) =>
            http()
              .patch(`${API}/questions/${id}/versions/1/test-cases/${tcB}`)
              .set(a.auth)
              .send({ weight: 3 }),
        ],
        [
          'delTc',
          (id) => http().delete(`${API}/questions/${id}/versions/1/test-cases/${tcB}`).set(a.auth),
        ],
      ];
      for (const [name, call] of attempts) {
        let cross: request.Response | undefined;
        let missing: request.Response | undefined;
        const crossCount = await statementsDuring(async () => {
          cross = await call(idB);
        });
        const missingCount = await statementsDuring(async () => {
          missing = await call(GHOST);
        });
        expect([name, cross?.status]).toEqual([name, 404]);
        expect([name, missing?.status]).toEqual([name, 404]);
        expect(stable(cross as request.Response)).toEqual(stable(missing as request.Response));
        expect(crossCount).toBeGreaterThan(1);
        expect([name, crossCount]).toEqual([name, missingCount]);
      }
      expect(
        JSON.stringify([
          await owner.question.findMany({ orderBy: { id: 'asc' } }),
          await owner.questionVersion.findMany({ orderBy: { id: 'asc' } }),
          await owner.testCase.findMany({ orderBy: { id: 'asc' } }),
        ]),
      ).toBe(before);
    });

    it('TC-008: lists show only the caller org, and a new question is stamped with the token org', async () => {
      const a = await make(UserRole.AUTHOR);
      const b = await make(UserRole.AUTHOR, orgB);
      const qa = await create(a, codingBody({ tags: ['scope-a'] }));
      await create(b, codingBody({ tags: ['scope-a'] }));
      const res = await http().get(`${API}/questions?tag=scope-a`).set(a.auth).expect(200);
      expect((res.body as { items: Json[] }).items.map((i) => i.id)).toEqual([idOf(qa)]);
      const row = await owner.question.findUniqueOrThrow({ where: { id: idOf(qa) } });
      expect(row.orgId).toBe(orgA);
      await http()
        .post(`${API}/questions`)
        .set(a.auth)
        .send({ ...codingBody(), orgId: orgB })
        .expect(400);
    });
  });

  // ---- list, filters, archive -------------------------------------------------------------------

  describe('FR-201: list, filters, pagination, archive', () => {
    it('FR-201: tag, difficulty and type filters; newest first; archived hidden by default', async () => {
      const a = await make(UserRole.AUTHOR);
      const tag = `f${++seq}`;
      const easy = await create(a, codingBody({ tags: [tag], difficulty: 'EASY' }));
      const hard = await create(a, codingBody({ tags: [tag, 'extra'], difficulty: 'HARD' }));
      const mcq = await create(a, {
        type: 'MCQ',
        title: 'M',
        statementMd: 'S',
        difficulty: 'HARD',
        tags: [tag],
        answerSpec: mcqSpec,
      });
      const ids = async (qs: string): Promise<unknown[]> =>
        (
          (await http().get(`${API}/questions?${qs}`).set(a.auth).expect(200)).body as {
            items: Json[];
          }
        ).items.map((i) => i.id);
      expect(await ids(`tag=${tag}`)).toEqual([idOf(mcq), idOf(hard), idOf(easy)]);
      expect(await ids(`tag=${tag}&difficulty=HARD`)).toEqual([idOf(mcq), idOf(hard)]);
      expect(await ids(`tag=${tag}&difficulty=HARD&type=CODING`)).toEqual([idOf(hard)]);
      expect(await ids(`tag=extra`)).toEqual([idOf(hard)]);
      await http()
        .post(`${API}/questions/${idOf(hard)}/archive`)
        .set(a.auth)
        .expect(200);
      expect(await ids(`tag=${tag}`)).toEqual([idOf(mcq), idOf(easy)]);
      expect(await ids(`tag=${tag}&includeArchived=true`)).toEqual([
        idOf(mcq),
        idOf(hard),
        idOf(easy),
      ]);
    });

    it('FR-201: the difficulty filter follows the published version, not an older or newer one', async () => {
      const a = await make(UserRole.AUTHOR);
      const tag = `d${++seq}`;
      const q = await publishable(a, { tags: [tag], difficulty: 'EASY' });
      await http()
        .patch(`${API}/questions/${idOf(q)}`)
        .set(a.auth)
        .send({ difficulty: 'HARD' })
        .expect(200);
      const list = async (d: string): Promise<number> =>
        (
          (await http().get(`${API}/questions?tag=${tag}&difficulty=${d}`).set(a.auth)).body as {
            total: number;
          }
        ).total;
      expect(await list('EASY')).toBe(1);
      expect(await list('HARD')).toBe(0);
      const item = (
        (await http().get(`${API}/questions?tag=${tag}`).set(a.auth)).body as { items: Json[] }
      ).items[0] as Json;
      expect(item).toMatchObject({
        published: { version: 1 },
        latest: { version: 2, isPublished: false },
      });
    });

    it('FR-201: pagination is bounded and exact', async () => {
      const a = await make(UserRole.AUTHOR);
      const tag = `p${++seq}`;
      for (let i = 0; i < 5; i++) await create(a, codingBody({ tags: [tag] }));
      const page = async (p: number, size: number): Promise<Json> =>
        (
          await http()
            .get(`${API}/questions?tag=${tag}&page=${p}&pageSize=${size}`)
            .set(a.auth)
            .expect(200)
        ).body as Json;
      const p1 = await page(1, 2);
      const p3 = await page(3, 2);
      expect([(p1.items as Json[]).length, p1.total, (p3.items as Json[]).length]).toEqual([
        2, 5, 1,
      ]);
      const seen = new Set<unknown>();
      for (const p of [1, 2, 3]) for (const i of (await page(p, 2)).items as Json[]) seen.add(i.id);
      expect(seen.size).toBe(5);
      for (const bad of [
        'pageSize=101',
        'pageSize=0',
        'page=0',
        'page=abc',
        'difficulty=X',
        'type=X',
        'tag=Bad%20Tag!',
        'includeArchived=maybe',
        'page=99999&pageSize=100',
      ]) {
        expect([bad, (await http().get(`${API}/questions?${bad}`).set(a.auth)).status]).toEqual([
          bad,
          400,
        ]);
      }
      await http().get(`${API}/questions/not-a-uuid`).set(a.auth).expect(400);
      await http().get(`${API}/questions/${GHOST}?version=0`).set(a.auth).expect(400);
    });

    it('FR-201: archive hides and freezes a question; unarchive restores it; both audited and idempotent', async () => {
      const a = await make(UserRole.AUTHOR);
      const q = await publishable(a);
      const id = idOf(q);
      const res = await http().post(`${API}/questions/${id}/archive`).set(a.auth).expect(200);
      expect(res.body).toMatchObject({ isArchived: true });
      await http().post(`${API}/questions/${id}/archive`).set(a.auth).expect(200);
      expect(await audit('QUESTION_ARCHIVED', id)).toHaveLength(1);
      await http().patch(`${API}/questions/${id}`).set(a.auth).send({ title: 'x' }).expect(409);
      await http().post(`${API}/questions/${id}/publish`).set(a.auth).expect(409);
      await http().get(`${API}/questions/${id}`).set(a.auth).expect(200);
      await http().post(`${API}/questions/${id}/unarchive`).set(a.auth).expect(200);
      expect(await audit('QUESTION_UNARCHIVED', id)).toHaveLength(1);
      await http().patch(`${API}/questions/${id}`).set(a.auth).send({ title: 'x' }).expect(200);
    });
  });

  // ---- route matrix ----------------------------------------------------------------------------

  it('TC-004: every question route is in the permission matrix with matching access (FR-103)', () => {
    const { ModulesContainer } = jest.requireActual<typeof import('@nestjs/core')>('@nestjs/core');
    const { listRoutes, matrixProblems } = jest.requireActual<
      typeof import('../common/auth/route-registry')
    >('../common/auth/route-registry');
    const routes = listRoutes(app.get(ModulesContainer));
    expect(routes.filter((r) => r.key.includes('/questions')).length).toBe(11);
    expect(matrixProblems(routes)).toEqual([]);
  });
});
