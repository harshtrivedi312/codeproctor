// Question bank (FR-201, FR-202, FR-204, FR-205) against real Postgres 16 and Redis
// (Testcontainers), the API running as app_user as in production (ADR 0006).
import { INestApplication } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';
import { passwordVersion } from '../auth/crypto.util';
import type { TokenService } from '../common/auth/token.service';
import { computeRevision } from './revision';
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

  /**
   * Stands in for the validate job (slice 4c): records a passing validation of the CURRENT content
   * of the latest version, directly in the database.
   */
  async function markValidated(questionId: string, revision?: string): Promise<void> {
    // These tests are about content rules, not the AI reference gate (ADR 0005 AI-5): switch it off
    // for the question's org. The gate has its own tests (question-validation.e2e-spec.ts).
    const { orgId } = await owner.question.findUniqueOrThrow({ where: { id: questionId } });
    await owner.organization.update({
      where: { id: orgId },
      data: { settings: { aiReferences: { minAssistants: 0 } } },
    });
    const head = await owner.questionVersion.findFirstOrThrow({
      where: { questionId },
      orderBy: { version: 'desc' },
    });
    const cases = await owner.testCase.findMany({ where: { questionVersionId: head.id } });
    const variants = await owner.questionVariant.findMany({
      where: { questionVersionId: head.id },
      include: { testCaseOverrides: true },
    });
    await owner.questionVersion.update({
      where: { id: head.id },
      data: {
        validatedAt: new Date(),
        validationReport: {
          passed: true,
          revision: revision ?? computeRevision(head, cases, variants),
        },
      },
    });
  }

  async function publishable(who: Made, over: Json = {}): Promise<Json> {
    const q = await create(who, codingBody(over));
    await markValidated(idOf(q));
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
        codingBody({ title: 'a\u0000b' }),
        codingBody({ statementMd: 'a\u0000b' }),
        codingBody({ starterCode: { python: 'a\u0000b' } }),
        codingBody({ referenceSolution: { python: 'lone \ud800 surrogate' } }),
        codingBody({ testCases: [{ ...sampleCase, input: 'a\u0000b' }] }),
        codingBody({ testCases: [{ ...sampleCase, expectedOutput: 'a\u0000b' }] }),
        {
          type: 'SHORT_ANSWER',
          title: 'T',
          statementMd: 'S',
          difficulty: 'EASY',
          answerSpec: { canonical: 'a\u0000b', acceptedVariants: [] },
        },
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
      expect(cases.map((c) => [c.isHidden, !('input' in c)])).toEqual([
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
    it('TC-011 (partial: author preview route; the candidate route is BE-07): preview shows the statement and sample cases only, no hidden case, reference or key', async () => {
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

    it('TC-014 (partial: preview only; auto-scoring is BE-11), FR-205: an MCQ preview has the options but not the key', async () => {
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

    it('TC-013 (partial: row-level; no session fixture yet): editing a published question creates version 2 as a draft; version 1 and the current pointer stay', async () => {
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
      await markValidated(id);
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
      await markValidated(idOf(q));
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

    it('TC-014 (partial: create and publish; auto-scoring is BE-11), FR-205: MCQ and short answer publish with a valid answer_spec; invalid specs are 400', async () => {
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

  // ---- staff view: nothing withheld reaches a recruiter, and only published versions ------------

  describe('TC-011, FR-201..FR-205: staff view', () => {
    it('TC-011, FR-201..FR-205 staff view: a RECRUITER response never contains any withheld field or value, on any route', async () => {
      const author = await make(UserRole.AUTHOR);
      const recruiter = await make(UserRole.RECRUITER);
      const secrets = [
        'SECRET-REF-PY',
        'SECRET-REF-JAVA',
        'SECRET-HIDDEN-IN',
        'SECRET-HIDDEN-OUT',
        'SECRET-REPORT',
        'SECRET-PARAM',
        'SECRET-OVERRIDE-IN',
        'SECRET-OVERRIDE-OUT',
        'SECRET-AI-REF',
        'SECRET-CANONICAL',
        'SECRET-ACCEPTED',
      ];
      const q = await create(
        author,
        codingBody({
          allowedLanguages: ['python', 'java'],
          referenceSolution: { python: 'SECRET-REF-PY', java: 'SECRET-REF-JAVA' },
          testCases: [
            sampleCase,
            { input: 'SECRET-HIDDEN-IN', expectedOutput: 'SECRET-HIDDEN-OUT', isHidden: true },
          ],
        }),
      );
      const id = idOf(q);
      const cases = await owner.testCase.findMany({
        where: { questionVersion: { questionId: id } },
        orderBy: { position: 'asc' },
      });
      const hiddenRow = cases[1];
      const v1 = await owner.questionVersion.findFirstOrThrow({ where: { questionId: id } });
      // Variants, per-slot overrides and AI references exist in the database (slices 4b, 4c).
      const variant = await owner.questionVariant.create({
        data: {
          questionVersionId: v1.id,
          params: { n: 'SECRET-PARAM' },
          renderedStatement: 'rendered statement SECRET-REF-PY',
        },
      });
      await owner.variantTestCase.create({
        data: {
          variantId: variant.id,
          testCaseId: (hiddenRow as { id: string }).id,
          input: 'SECRET-OVERRIDE-IN',
          expectedOutput: 'SECRET-OVERRIDE-OUT',
        },
      });
      await owner.aiReferenceSolution.create({
        data: {
          questionVersionId: v1.id,
          assistant: 'a',
          modelLabel: 'm',
          language: 'python',
          solutionCode: 'SECRET-AI-REF',
          collectedAt: new Date(),
          collectedById: author.id,
        },
      });
      await markValidated(id);
      const head = await owner.questionVersion.findUniqueOrThrow({ where: { id: v1.id } });
      await owner.questionVersion.update({
        where: { id: v1.id },
        data: {
          validationReport: {
            ...(head.validationReport as Record<string, unknown>),
            note: 'SECRET-REPORT',
          },
        },
      });
      await http().post(`${API}/questions/${id}/publish`).set(author.auth).expect(200);
      await http()
        .patch(`${API}/questions/${id}`)
        .set(author.auth)
        .send({ title: 'v2' })
        .expect(200);
      const sa = await create(author, {
        type: 'SHORT_ANSWER',
        title: 'SA',
        statementMd: 'S',
        difficulty: 'EASY',
        answerSpec: { canonical: 'SECRET-CANONICAL', acceptedVariants: ['SECRET-ACCEPTED'] },
      });
      const mcq = await create(author, {
        type: 'MCQ',
        title: 'MC',
        statementMd: 'S',
        difficulty: 'EASY',
        answerSpec: {
          options: [
            { id: 'a', text: 'x' },
            { id: 'b', text: 'y' },
          ],
          correctOptionIds: ['b'],
          multiple: false,
        },
      });
      await http()
        .post(`${API}/questions/${idOf(sa)}/publish`)
        .set(author.auth)
        .expect(200);
      await http()
        .post(`${API}/questions/${idOf(mcq)}/publish`)
        .set(author.auth)
        .expect(200);

      const urls = [
        `${API}/questions?includeArchived=true&pageSize=100`,
        // Slice 4b: the candidate-shaped variant preview shows no params, override or key.
        `${API}/questions/${id}/versions/1/variants/${variant.id}/preview`,
        ...[id, idOf(sa), idOf(mcq)].flatMap((qid) => [
          `${API}/questions/${qid}`,
          `${API}/questions/${qid}?version=1`,
          `${API}/questions/${qid}/preview`,
          `${API}/questions/${qid}/preview?version=1`,
        ]),
      ];
      for (const url of urls) {
        const res = await http().get(url).set(recruiter.auth);
        expect([url, res.status]).toEqual([url, 200]);
        const text = JSON.stringify(res.body);
        for (const secret of secrets) expect([url, text.includes(secret)]).toEqual([url, false]);
        const keys = /referenceSolution|answerSpec|validationReport|correctOptionIds|revision/;
        expect([url, keys.test(text)]).toEqual([url, false]);
      }
      // A recruiter cannot list the variants (params, overrides): 403, not an empty list.
      for (const url of [
        `${API}/questions/${id}/versions/1/variants`,
        `${API}/questions/${id}/versions/2/variants`,
      ]) {
        const res = await http().get(url).set(recruiter.auth);
        expect([url, res.status, JSON.stringify(res.body).includes('SECRET')]).toEqual([
          url,
          403,
          false,
        ]);
      }
      // The draft version 2 is not reachable for a recruiter at all.
      for (const url of [
        `${API}/questions/${id}?version=2`,
        `${API}/questions/${id}/preview?version=2`,
      ]) {
        expect([url, (await http().get(url).set(recruiter.auth)).status]).toEqual([url, 404]);
      }
      // Hidden cases carry no input or expectedOutput key at all (absent, not null).
      const detail = await http().get(`${API}/questions/${id}?version=1`).set(recruiter.auth);
      const hiddenRead = (detail.body as { version: { testCases: Json[] } }).version
        .testCases[1] as Json;
      expect(Object.keys(hiddenRead).sort()).toEqual(['id', 'isHidden', 'position', 'weight']);
      // The writer view of the same version is full (the secrets are really stored and served).
      const full = JSON.stringify(
        (await http().get(`${API}/questions/${id}?version=1`).set(author.auth)).body,
      );
      for (const secret of [
        'SECRET-REF-PY',
        'SECRET-REF-JAVA',
        'SECRET-HIDDEN-IN',
        'SECRET-HIDDEN-OUT',
        'SECRET-REPORT',
        // Slice 4b: the writer view carries variant params and overrides.
        'SECRET-PARAM',
        'SECRET-OVERRIDE-IN',
        'SECRET-OVERRIDE-OUT',
      ]) {
        expect(full).toContain(secret);
      }
    });

    it('FR-201 staff view: every response to a writer carries the full view (create, patch, publish, test-case routes)', async () => {
      const a = await make(UserRole.AUTHOR);
      const q = await create(a);
      expect(JSON.stringify(q)).toContain('REFERENCE-SECRET');
      expect(JSON.stringify(q)).toContain('HIDDEN-IN-9');
      const id = idOf(q);
      const patched = await http()
        .patch(`${API}/questions/${id}`)
        .set(a.auth)
        .send({ title: 'p' })
        .expect(200);
      expect(JSON.stringify(patched.body)).toContain('REFERENCE-SECRET');
      const added = await http()
        .post(`${API}/questions/${id}/versions/1/test-cases`)
        .set(a.auth)
        .send(hiddenCase)
        .expect(201);
      expect(added.body).toMatchObject({ input: 'HIDDEN-IN-9', expectedOutput: 'HIDDEN-OUT-9' });
      const upd = await http()
        .patch(`${API}/questions/${id}/versions/1/test-cases/${(added.body as Json).id as string}`)
        .set(a.auth)
        .send({ weight: 3 })
        .expect(200);
      expect(upd.body).toMatchObject({ input: 'HIDDEN-IN-9' });
      await markValidated(id);
      const pub = await http().post(`${API}/questions/${id}/publish`).set(a.auth).expect(200);
      expect(JSON.stringify(pub.body)).toContain('REFERENCE-SECRET');
    });

    it('TC-011, FR-201 staff view: an archived question is hidden from a recruiter even with includeArchived, and stays listed for authors', async () => {
      const author = await make(UserRole.AUTHOR);
      const recruiter = await make(UserRole.RECRUITER);
      const tag = `arc${++seq}`;
      const pub = await publishable(author, { tags: [tag] });
      await http()
        .post(`${API}/questions/${idOf(pub)}/archive`)
        .set(author.auth)
        .expect(200);
      for (const qs of [`tag=${tag}`, `tag=${tag}&includeArchived=true`]) {
        const res = await http().get(`${API}/questions?${qs}`).set(recruiter.auth).expect(200);
        expect(res.body).toMatchObject({ total: 0, items: [] });
      }
      const mine = await http()
        .get(`${API}/questions?tag=${tag}&includeArchived=true`)
        .set(author.auth)
        .expect(200);
      expect((mine.body as { total: number }).total).toBe(1);
    });

    it('TC-011, FR-201..FR-205 staff view: a recruiter cannot see a draft, cannot enumerate it via list, and gets the identical 404', async () => {
      const author = await make(UserRole.AUTHOR);
      const recruiter = await make(UserRole.RECRUITER);
      const tag = `vis${++seq}`;
      const draftOnly = await create(
        author,
        codingBody({ tags: [tag], title: 'DRAFT-ONLY-TITLE' }),
      );
      const pub = await publishable(author, { tags: [tag], title: 'Published title' });
      await http()
        .patch(`${API}/questions/${idOf(pub)}`)
        .set(author.auth)
        .send({ title: 'DRAFT-V2-TITLE' })
        .expect(200);

      const list = await http()
        .get(`${API}/questions?tag=${tag}&pageSize=1`)
        .set(recruiter.auth)
        .expect(200);
      expect(list.body).toMatchObject({ total: 1, page: 1, pageSize: 1 });
      const item = (list.body as { items: Json[] }).items[0] as Json;
      expect(item).toMatchObject({
        id: idOf(pub),
        published: { version: 1 },
        latest: { version: 1, title: 'Published title' },
      });
      const all = JSON.stringify(
        (await http().get(`${API}/questions?includeArchived=true&pageSize=100`).set(recruiter.auth))
          .body,
      );
      expect(all).not.toContain('DRAFT-ONLY-TITLE');
      expect(all).not.toContain('DRAFT-V2-TITLE');
      expect(all).not.toContain(idOf(draftOnly));
      const authorList = await http()
        .get(`${API}/questions?tag=${tag}`)
        .set(author.auth)
        .expect(200);
      expect((authorList.body as { total: number }).total).toBe(2);

      const det = await http()
        .get(`${API}/questions/${idOf(pub)}`)
        .set(recruiter.auth)
        .expect(200);
      expect(versionOf(det.body as Json)).toMatchObject({ version: 1, title: 'Published title' });
      expect(((det.body as Json).versions as Json[]).map((v) => v.version)).toEqual([1]);
      expect(JSON.stringify(det.body)).not.toContain('DRAFT-V2-TITLE');
      const prev = await http()
        .get(`${API}/questions/${idOf(pub)}/preview`)
        .set(recruiter.auth)
        .expect(200);
      expect(prev.body).toMatchObject({ title: 'Published title' });
      await http()
        .get(`${API}/questions/${idOf(pub)}/preview?version=1`)
        .set(recruiter.auth)
        .expect(200);

      const ghost = await http().get(`${API}/questions/${GHOST}`).set(recruiter.auth);
      expect(ghost.status).toBe(404);
      const refused = [
        `${API}/questions/${GHOST}?version=1`,
        `${API}/questions/${GHOST}/preview`,
        `${API}/questions/${idOf(pub)}?version=2`,
        `${API}/questions/${idOf(pub)}?version=9`,
        `${API}/questions/${idOf(pub)}/preview?version=2`,
        `${API}/questions/${idOf(draftOnly)}`,
        `${API}/questions/${idOf(draftOnly)}?version=1`,
        `${API}/questions/${idOf(draftOnly)}/preview`,
        `${API}/questions/${idOf(draftOnly)}/preview?version=1`,
      ];
      for (const url of refused) {
        const res = await http().get(url).set(recruiter.auth);
        expect([url, res.status]).toEqual([url, 404]);
        expect(stable(res)).toEqual({ ...stable(ghost), ...{} });
      }
      await http()
        .get(`${API}/questions/${idOf(pub)}?version=2`)
        .set(author.auth)
        .expect(200);
      await http()
        .get(`${API}/questions/${idOf(draftOnly)}/preview`)
        .set(author.auth)
        .expect(200);
    });

    it('TC-011 staff view: the recruiter-visible version and test-case objects have exactly these keys', async () => {
      const author = await make(UserRole.AUTHOR);
      const recruiter = await make(UserRole.RECRUITER);
      const q = await publishable(author);
      const res = await http()
        .get(`${API}/questions/${idOf(q)}`)
        .set(recruiter.auth)
        .expect(200);
      const v = versionOf(res.body as Json);
      expect(Object.keys(v).sort()).toEqual(
        [
          'allowedLanguages',
          'createdAt',
          'difficulty',
          'id',
          'isPublished',
          'limits',
          'starterCode',
          'statementMd',
          'testCases',
          'title',
          'validatedAt',
          'version',
        ].sort(),
      );
      const [sample, hidden] = v.testCases as Json[];
      expect(Object.keys(sample as Json).sort()).toEqual([
        'expectedOutput',
        'id',
        'input',
        'isHidden',
        'position',
        'weight',
      ]);
      expect(Object.keys(hidden as Json).sort()).toEqual(['id', 'isHidden', 'position', 'weight']);
    });
  });

  // ---- publish gate: validation required, bound to the content ----------------------------------

  describe('FR-203, TC-012 (partial: gate only; the validate job is slice 4c): publish needs a passing validation of this content', () => {
    it('FR-203: a coding draft with no recorded validation cannot be published (422, fails closed)', async () => {
      const a = await make(UserRole.AUTHOR);
      const q = await create(a);
      const res = await http()
        .post(`${API}/questions/${idOf(q)}/publish`)
        .set(a.auth)
        .expect(422);
      expect(res.body).toMatchObject({
        errors: expect.arrayContaining<string>([
          'validation: a passing validation run of the current content is required',
        ]) as string[],
      });
      expect(res.body).not.toHaveProperty('code');
    });

    it('FR-203: a failed report, or a report recorded for other content, is refused', async () => {
      const a = await make(UserRole.AUTHOR);
      const q = await create(a);
      const id = idOf(q);
      const head = await owner.questionVersion.findFirstOrThrow({ where: { questionId: id } });
      for (const report of [
        { passed: false, revision: 'x' },
        { passed: true },
        { passed: true, revision: 'f'.repeat(64) },
      ]) {
        await owner.questionVersion.update({
          where: { id: head.id },
          data: { validatedAt: new Date(), validationReport: report },
        });
        await http().post(`${API}/questions/${id}/publish`).set(a.auth).expect(422);
      }
      await markValidated(id);
      await http().post(`${API}/questions/${id}/publish`).set(a.auth).expect(200);
    });

    it('FR-203: any content write after a validation clears it, so the question must be validated again', async () => {
      const a = await make(UserRole.AUTHOR);
      const q = await create(a);
      const id = idOf(q);
      await markValidated(id);
      await http()
        .patch(`${API}/questions/${id}`)
        .set(a.auth)
        .send({ statementMd: 'changed' })
        .expect(200);
      await http().post(`${API}/questions/${id}/publish`).set(a.auth).expect(422);
      await markValidated(id);
      await http()
        .post(`${API}/questions/${id}/versions/1/test-cases`)
        .set(a.auth)
        .send(hiddenCase)
        .expect(201);
      await http().post(`${API}/questions/${id}/publish`).set(a.auth).expect(422);
    });

    it('FR-205: every allowed language needs a reference solution before publish (422)', async () => {
      const a = await make(UserRole.AUTHOR);
      const q = await create(a, codingBody({ allowedLanguages: ['python', 'java'] }));
      await markValidated(idOf(q));
      const res = await http()
        .post(`${API}/questions/${idOf(q)}/publish`)
        .set(a.auth)
        .expect(422);
      expect(JSON.stringify(res.body)).toContain(
        'referenceSolution.java: required for an allowed language',
      );
    });
  });

  // ---- optimistic concurrency and races ----------------------------------------------------------

  describe('FR-204: two editors, races', () => {
    const revisionOf = async (who: Made, id: string): Promise<string> =>
      (
        (await http().get(`${API}/questions/${id}`).set(who.auth)).body as {
          version: { revision: string };
        }
      ).version.revision;

    it('FR-204: a stale expectedRevision is 409 (detail only, no code) and changes nothing; a matching one passes; omitted still works', async () => {
      const a = await make(UserRole.AUTHOR);
      const b = await make(UserRole.AUTHOR);
      const q = await create(a);
      const id = idOf(q);
      const loadedByA = await revisionOf(a, id);
      expect(loadedByA).toMatch(/^[0-9a-f]{64}$/);
      expect(await revisionOf(b, id)).toBe(loadedByA);
      await http()
        .patch(`${API}/questions/${id}`)
        .set(b.auth)
        .send({ title: 'B edit', expectedRevision: loadedByA })
        .expect(200);
      const stale = await http()
        .patch(`${API}/questions/${id}`)
        .set(a.auth)
        .send({ title: 'A edit', expectedRevision: loadedByA });
      expect(stale.status).toBe(409);
      expect(stale.body).not.toHaveProperty('code');
      expect(
        (await owner.questionVersion.findFirstOrThrow({ where: { questionId: id } })).title,
      ).toBe('B edit');
      const fresh = await revisionOf(a, id);
      expect(fresh).not.toBe(loadedByA);
      await http()
        .patch(`${API}/questions/${id}`)
        .set(a.auth)
        .send({ title: 'A edit', expectedRevision: fresh })
        .expect(200);
      await http()
        .patch(`${API}/questions/${id}`)
        .set(a.auth)
        .send({ title: 'no token' })
        .expect(200);
      await http()
        .patch(`${API}/questions/${id}`)
        .set(a.auth)
        .send({ title: 'x', expectedRevision: 'nope' })
        .expect(400);
      // A test case change also changes the revision, so a stale publish is refused too.
      const before = await revisionOf(a, id);
      await http()
        .post(`${API}/questions/${id}/versions/1/test-cases`)
        .set(b.auth)
        .send(hiddenCase)
        .expect(201);
      await markValidated(id);
      await http()
        .post(`${API}/questions/${id}/publish`)
        .set(a.auth)
        .send({ expectedRevision: before })
        .expect(409);
      expect(
        await owner.questionVersion.count({ where: { questionId: id, isPublished: true } }),
      ).toBe(0);
      await http()
        .post(`${API}/questions/${id}/publish`)
        .set(a.auth)
        .send({ expectedRevision: await revisionOf(a, id) })
        .expect(200);
    });

    it('FR-204, FR-202 (FU-BE-106): test-case routes take expectedRevision: stale is 409 (no code) and changes nothing, matching passes, omitted works, malformed is 400, nested create body rejects it', async () => {
      const a = await make(UserRole.AUTHOR);
      const b = await make(UserRole.AUTHOR);
      const id = idOf(await create(a, codingBody({ testCases: [] })));
      const base = `${API}/questions/${id}/versions/1/test-cases`;
      const t1 = await http()
        .post(base)
        .set(a.auth)
        .send({ input: 'a', expectedOutput: 'b' })
        .expect(201);
      const tid = (t1.body as Json).id as string;
      expect(t1.body).not.toHaveProperty('revision');
      const loaded = await revisionOf(a, id);
      await http().patch(`${base}/${tid}`).set(b.auth).send({ expectedOutput: 'B' }).expect(200);
      const count = (): Promise<number> =>
        owner.testCase.count({
          where: { questionVersionId: undefined, questionVersion: { questionId: id } },
        });
      const stalePatch = await http()
        .patch(`${base}/${tid}`)
        .set(a.auth)
        .send({ expectedOutput: 'A', expectedRevision: loaded });
      expect(stalePatch.status).toBe(409);
      expect(stalePatch.body).not.toHaveProperty('code');
      expect((await owner.testCase.findUniqueOrThrow({ where: { id: tid } })).expectedOutput).toBe(
        'B',
      );
      const stalePost = await http()
        .post(base)
        .set(a.auth)
        .send({ input: 'c', expectedOutput: 'd', expectedRevision: loaded });
      expect(stalePost.status).toBe(409);
      expect(await count()).toBe(1);
      const staleDelete = await http()
        .delete(`${base}/${tid}?expectedRevision=${loaded}`)
        .set(a.auth);
      expect(staleDelete.status).toBe(409);
      expect(staleDelete.body).not.toHaveProperty('code');
      expect(await count()).toBe(1);
      const fresh = await revisionOf(a, id);
      await http()
        .patch(`${base}/${tid}`)
        .set(a.auth)
        .send({ expectedOutput: 'A', expectedRevision: fresh })
        .expect(200);
      const t2 = await http()
        .post(base)
        .set(a.auth)
        .send({ input: 'c', expectedOutput: 'd', expectedRevision: await revisionOf(a, id) })
        .expect(201);
      expect(t2.body).not.toHaveProperty('expectedRevision');
      await http()
        .patch(`${base}/${tid}`)
        .set(a.auth)
        .send({ expectedRevision: await revisionOf(a, id) })
        .expect(400);
      await http()
        .patch(`${base}/${tid}`)
        .set(a.auth)
        .send({ expectedRevision: 'nope' })
        .expect(400);
      await http().delete(`${base}/${tid}?expectedRevision=nope`).set(a.auth).expect(400);
      await http()
        .delete(`${base}/${tid}?expectedRevision=${await revisionOf(a, id)}`)
        .set(a.auth)
        .expect(204);
      await http()
        .delete(`${base}/${(t2.body as Json).id as string}`)
        .set(a.auth)
        .expect(204);
      expect(await count()).toBe(0);
      // The create-question body keeps its strict shape: no expectedRevision inside testCases.
      await http()
        .post(`${API}/questions`)
        .set(a.auth)
        .send(codingBody({ testCases: [{ ...sampleCase, expectedRevision: fresh }] }))
        .expect(400);
    });

    it('FR-204: concurrent in-place edits of different fields are all kept (no lost update)', async () => {
      const a = await make(UserRole.AUTHOR);
      for (let round = 0; round < 3; round++) {
        const q = await create(a);
        const id = idOf(q);
        const results = await Promise.all([
          http()
            .patch(`${API}/questions/${id}`)
            .set(a.auth)
            .send({ title: `T${round}` }),
          http()
            .patch(`${API}/questions/${id}`)
            .set(a.auth)
            .send({ statementMd: `S${round}` }),
          http().patch(`${API}/questions/${id}`).set(a.auth).send({ difficulty: 'HARD' }),
        ]);
        expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
        const row = await owner.questionVersion.findFirstOrThrow({ where: { questionId: id } });
        expect([row.title, row.statementMd, row.difficulty]).toEqual([
          `T${round}`,
          `S${round}`,
          'HARD',
        ]);
      }
    });

    it('FR-201: publish racing a PATCH that empties the reference solution never publishes the emptied content', async () => {
      const a = await make(UserRole.AUTHOR);
      for (let round = 0; round < 4; round++) {
        const q = await create(a);
        const id = idOf(q);
        await markValidated(id);
        const [pub, patch] = await Promise.all([
          http().post(`${API}/questions/${id}/publish`).set(a.auth),
          http().patch(`${API}/questions/${id}`).set(a.auth).send({ referenceSolution: {} }),
        ]);
        expect([200, 409, 422]).toContain(pub.status);
        expect([200, 409]).toContain(patch.status);
        const published = await owner.questionVersion.findMany({
          where: { questionId: id, isPublished: true },
        });
        for (const v of published) {
          expect(Object.keys(v.referenceSolution as object)).not.toHaveLength(0);
        }
        const question = await owner.question.findUniqueOrThrow({ where: { id } });
        if (pub.status === 200) {
          expect(published).toHaveLength(1);
          expect(question.currentVersionId).toBe(published[0]?.id);
        } else {
          expect(published).toHaveLength(0);
          expect(question.currentVersionId).toBeNull();
        }
      }
    });

    it('FR-202: test case writes on an archived question are 409 and change nothing', async () => {
      const a = await make(UserRole.AUTHOR);
      const q = await create(a);
      const id = idOf(q);
      const tc = ((versionOf(q).testCases as Json[])[0] as Json).id as string;
      await http().post(`${API}/questions/${id}/archive`).set(a.auth).expect(200);
      const base = `${API}/questions/${id}/versions/1/test-cases`;
      await http().post(base).set(a.auth).send(sampleCase).expect(409);
      await http().patch(`${base}/${tc}`).set(a.auth).send({ weight: 9 }).expect(409);
      await http().delete(`${base}/${tc}`).set(a.auth).expect(409);
      expect(await owner.testCase.count({ where: { questionVersion: { questionId: id } } })).toBe(
        2,
      );
    });
  });

  // ---- input edge cases ---------------------------------------------------------------------------

  describe('FR-201: null fields, ids, bodies, drafts', () => {
    it('FR-201: an explicit null in a PATCH is 400 for every field and changes nothing (no version, no audit row)', async () => {
      const a = await make(UserRole.AUTHOR);
      const q = await publishable(a);
      const id = idOf(q);
      const nulls = [
        'tags',
        'title',
        'statementMd',
        'difficulty',
        'allowedLanguages',
        'limits',
        'starterCode',
        'referenceSolution',
        'answerSpec',
        'expectedRevision',
      ];
      for (const field of nulls) {
        const res = await http()
          .patch(`${API}/questions/${id}`)
          .set(a.auth)
          .send({ [field]: null });
        expect([field, res.status]).toEqual([field, 400]);
      }
      expect(await owner.questionVersion.count({ where: { questionId: id } })).toBe(1);
      expect(await audit('QUESTION_UPDATED', id)).toHaveLength(0);
      expect(await audit('QUESTION_VERSION_CREATED', id)).toHaveLength(0);
      const draft = await create(a);
      const tc = ((versionOf(draft).testCases as Json[])[0] as Json).id as string;
      for (const field of ['input', 'expectedOutput', 'isHidden', 'weight', 'position']) {
        const res = await http()
          .patch(`${API}/questions/${idOf(draft)}/versions/1/test-cases/${tc}`)
          .set(a.auth)
          .send({ [field]: null });
        expect([field, res.status]).toEqual([field, 400]);
      }
      await http()
        .post(`${API}/questions`)
        .set(a.auth)
        .send(codingBody({ tags: null, limits: null, starterCode: null }))
        .expect(400);
    });

    it('FR-201: a huge or malformed version number is 400, never 500', async () => {
      const a = await make(UserRole.AUTHOR);
      const q = await create(a);
      for (const v of ['99999999999999999999999', '0', '-1', '1.5', 'abc', '1000001']) {
        const res = await http()
          .post(`${API}/questions/${idOf(q)}/versions/${v}/test-cases`)
          .set(a.auth)
          .send(sampleCase);
        expect([v, res.status]).toEqual([v, 400]);
      }
    });

    it('FR-205: previewing a draft MCQ whose answer_spec is not set yet is 422, not 500', async () => {
      const a = await make(UserRole.AUTHOR);
      const q = await create(a, { type: 'MCQ', title: 'D', statementMd: 'S', difficulty: 'EASY' });
      const res = await http()
        .get(`${API}/questions/${idOf(q)}/preview`)
        .set(a.auth);
      expect(res.status).toBe(422);
      expect(res.body).not.toHaveProperty('code');
    });

    it('FR-201: bodies above the default 100 KB are accepted up to 1 MB (refused above), and /client-errors still works', async () => {
      const a = await make(UserRole.AUTHOR);
      const big = codingBody({
        starterCode: { python: 'x'.repeat(100_000) },
        referenceSolution: { python: 'y'.repeat(100_000) },
        testCases: [sampleCase, { ...hiddenCase, input: 'z'.repeat(100_000) }],
      });
      expect(JSON.stringify(big).length).toBeGreaterThan(300_000);
      await http().post(`${API}/questions`).set(a.auth).send(big).expect(201);
      // Above 1 MB the body is refused before any handler runs (the status is 500 today: the
      // problem filter does not map body-parser errors, FU-BE-103) and nothing is written.
      const before = await owner.question.count();
      const refused = await http()
        .post(`${API}/questions`)
        .set(a.auth)
        .send(codingBody({ statementMd: 'q'.repeat(1_200_000) }));
      expect(refused.status).toBeGreaterThanOrEqual(400);
      expect(await owner.question.count()).toBe(before);
      // /client-errors keeps its own small cap and still works.
      await http().post(`${API}/client-errors`).send({ message: 'boom' }).expect(204);
    });
  });

  // ---- FR-203: variants (slice 4b) ---------------------------------------------------------------

  describe('FR-203, TC-011, TC-012 (partial: render and publish rules; execution is slice 4c): variants', () => {
    const vbase = (q: Json, version = 1): string =>
      `${API}/questions/${idOf(q)}/versions/${version}/variants`;
    const templated = (over: Json = {}): Json =>
      codingBody({
        statementMd: 'Sum {{a}} and {{b}} for {{name}}.',
        starterCode: { python: 'A = {{a}}' },
        referenceSolution: { python: 'REFERENCE-SECRET {{a}}' },
        ...over,
      });
    const params = { a: 2, b: 3, name: 'Ada' };

    async function addVariant(
      who: Made,
      q: Json,
      p: Json = params,
      extra: Json = {},
    ): Promise<{ id: string; revision: string; body: Json }> {
      const res = await http()
        .post(vbase(q))
        .set(who.auth)
        .send({ params: p, ...extra });
      expect([res.status, res.body]).toEqual([201, expect.anything()]);
      const body = res.body as { variant: { id: string }; revision: string };
      return { id: body.variant.id, revision: body.revision, body: res.body as Json };
    }

    const slotsOf = (q: Json): Promise<{ id: string; isHidden: boolean }[]> =>
      owner.testCase.findMany({
        where: { questionVersion: { questionId: idOf(q) } },
        orderBy: { position: 'asc' },
        select: { id: true, isHidden: true },
      });

    const liveRevision = async (who: Made, q: Json): Promise<string> =>
      versionOf(
        (
          await http()
            .get(`${API}/questions/${idOf(q)}`)
            .set(who.auth)
            .expect(200)
        ).body as Json,
      ).revision as string;

    it('FR-203: adding a variant renders the statement, stores params, audits ids only, and the revision follows', async () => {
      const a = await make(UserRole.AUTHOR);
      const q = await create(a, templated());
      const before = await liveRevision(a, q);
      const v = await addVariant(a, q);
      const variant = (v.body as { variant: Json }).variant;
      expect(variant).toEqual({
        id: v.id,
        isActive: true,
        params,
        renderedStatement: 'Sum 2 and 3 for Ada.',
        testCaseOverrides: [],
      });
      expect(v.revision).not.toBe(before);
      expect(await liveRevision(a, q)).toBe(v.revision);
      const row = await owner.questionVariant.findUniqueOrThrow({ where: { id: v.id } });
      expect(row.params).toEqual(params);
      expect(row.renderedStatement).toBe('Sum 2 and 3 for Ada.');
      const rows = await audit('QUESTION_VARIANT_ADDED', idOf(q));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.metadata).toEqual({ version: 1, variantId: v.id, isActive: true });
      expect(JSON.stringify(rows)).not.toContain('Ada');
      // The writer view lists it with the version.
      const list = await http().get(vbase(q)).set(a.auth).expect(200);
      expect((list.body as { items: Json[] }).items).toHaveLength(1);
      expect((list.body as Json).revision).toBe(v.revision);
      const detail = versionOf(
        (
          await http()
            .get(`${API}/questions/${idOf(q)}`)
            .set(a.auth)
            .expect(200)
        ).body as Json,
      );
      expect((detail.variants as Json[]).map((x) => x.id)).toEqual([v.id]);
    });

    it('FR-203: a variant change clears the last validation result', async () => {
      const a = await make(UserRole.AUTHOR);
      const q = await create(a, templated());
      await markValidated(idOf(q));
      const v = await addVariant(a, q);
      const head = await owner.questionVersion.findFirstOrThrow({ where: { questionId: idOf(q) } });
      expect([head.validatedAt, head.validationReport]).toEqual([null, null]);
      await markValidated(idOf(q));
      await http()
        .patch(`${vbase(q)}/${v.id}`)
        .set(a.auth)
        .send({ isActive: false })
        .expect(200);
      const after = await owner.questionVersion.findFirstOrThrow({
        where: { questionId: idOf(q) },
      });
      expect(after.validatedAt).toBeNull();
    });

    it('FR-203: a placeholder with no param is 400 listing it, never rendered empty; nothing is written', async () => {
      const a = await make(UserRole.AUTHOR);
      const q = await create(a, templated());
      const res = await http()
        .post(vbase(q))
        .set(a.auth)
        .send({ params: { a: 1, b: 2 } });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain('unknown placeholder \\"name\\"');
      expect(JSON.stringify(res.body)).toContain('statementMd');
      expect(
        await owner.questionVariant.count({ where: { questionVersion: { questionId: idOf(q) } } }),
      ).toBe(0);
      expect(await audit('QUESTION_VARIANT_ADDED', idOf(q))).toHaveLength(0);
    });

    it('FR-203: unsupported Mustache features in the template are refused when a variant renders it', async () => {
      const a = await make(UserRole.AUTHOR);
      for (const statementMd of ['{{#a}}x{{/a}}', '{{{a}}}', '{{> p}}', '{{a.b}}', 'open {{a']) {
        const q = await create(a, codingBody({ statementMd }));
        const res = await http()
          .post(vbase(q))
          .set(a.auth)
          .send({ params: { a: 1 } });
        expect([statementMd, res.status]).toEqual([statementMd, 400]);
      }
      // A literal brace pair is written \{{ and renders as {{.
      const q = await create(a, codingBody({ statementMd: 'Use \\{{x}} and {{a}}' }));
      const v = await addVariant(a, q, { a: 1 });
      expect(
        (await owner.questionVariant.findUniqueOrThrow({ where: { id: v.id } })).renderedStatement,
      ).toBe('Use {{x}} and 1');
    });

    it('FR-203: params are validated (DTO): bad names, nesting, null, NUL, size, types; nothing is written', async () => {
      const a = await make(UserRole.AUTHOR);
      const q = await create(a, templated());
      const long = 'x'.repeat(1001);
      const bad: Json[] = [
        {},
        { params: null },
        { params: 'x' },
        { params: [] },
        { params: { ...params, __x: 1 } },
        { params: { ...params, 'a.b': 1 } },
        { params: { ...params, nested: { x: 1 } } },
        { params: { ...params, list: [1] } },
        { params: { ...params, n: null } },
        { params: { ...params, name: 'a\u0000b' } },
        { params: { ...params, name: 'a\ud800b' } },
        { params: { ...params, name: long } },
        { params, isActive: null },
        { params, isActive: 'yes' },
        { params, expectedRevision: 'abc' },
        { params, extra: 1 },
      ];
      for (const body of bad) {
        const res = await http().post(vbase(q)).set(a.auth).send(body);
        expect([JSON.stringify(body).slice(0, 80), res.status]).toEqual([
          JSON.stringify(body).slice(0, 80),
          400,
        ]);
      }
      const many = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`p${i}`, 1]));
      await http()
        .post(vbase(q))
        .set(a.auth)
        .send({ params: { ...params, ...many } })
        .expect(400);
      expect(
        await owner.questionVariant.count({ where: { questionVersion: { questionId: idOf(q) } } }),
      ).toBe(0);
    });

    it('FR-203: a __proto__ key in the JSON body never pollutes a prototype and is never stored', async () => {
      const a = await make(UserRole.AUTHOR);
      const q = await create(a, codingBody({ statementMd: 'Plain.' }));
      const res = await http()
        .post(vbase(q))
        .set(a.auth)
        .set('Content-Type', 'application/json')
        .send('{"params":{"x":1,"__proto__":{"polluted":"YES"}}}');
      expect([201, 400]).toContain(res.status);
      expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
      // `constructor` and `__proto__` keys are dropped by the body transformer before validation
      // (class-transformer skips them, `prototype` too), so they are never stored either way.
      const viaCtor = await http()
        .post(vbase(q))
        .set(a.auth)
        .set('Content-Type', 'application/json')
        .send('{"params":{"x":1,"prototype":1,"constructor":{"prototype":{"polluted":"YES"}}}}');
      expect([201, 400]).toContain(viaCtor.status);
      expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
      const rows = await owner.questionVariant.findMany({
        where: { questionVersion: { questionId: idOf(q) } },
      });
      expect(JSON.stringify(rows)).not.toContain('polluted');
      expect(JSON.stringify(rows)).not.toMatch(/constructor|prototype/);
      // The same on the way in through a rendered statement: a prototype name is an unknown placeholder.
      const q2 = await create(a, codingBody({ statementMd: '{{constructor}} {{__proto__}}' }));
      await http()
        .post(vbase(q2))
        .set(a.auth)
        .send({ params: { x: 1 } })
        .expect(400);
    });

    it('FR-203: PATCH changes params and re-renders; an empty PATCH is 400; an inactive variant is not rendered until reactivated', async () => {
      const a = await make(UserRole.AUTHOR);
      const q = await create(a, templated());
      const v = await addVariant(a, q);
      await http()
        .patch(`${vbase(q)}/${v.id}`)
        .set(a.auth)
        .send({})
        .expect(400);
      await http()
        .patch(`${vbase(q)}/${v.id}`)
        .set(a.auth)
        .send({ params: { ...params, a: 9 } })
        .expect(200);
      expect(
        (await owner.questionVariant.findUniqueOrThrow({ where: { id: v.id } })).renderedStatement,
      ).toBe('Sum 9 and 3 for Ada.');
      // Missing param while active: 400, unchanged.
      await http()
        .patch(`${vbase(q)}/${v.id}`)
        .set(a.auth)
        .send({ params: { a: 1 } })
        .expect(400);
      expect(
        (await owner.questionVariant.findUniqueOrThrow({ where: { id: v.id } })).params,
      ).toEqual({ ...params, a: 9 });
      // Inactive: the incomplete params are kept without rendering; reactivating is refused.
      await http()
        .patch(`${vbase(q)}/${v.id}`)
        .set(a.auth)
        .send({ params: { a: 1 }, isActive: false })
        .expect(200);
      await http()
        .patch(`${vbase(q)}/${v.id}`)
        .set(a.auth)
        .send({ isActive: true })
        .expect(400);
      await http()
        .patch(`${vbase(q)}/${v.id}`)
        .set(a.auth)
        .send({ params, isActive: true })
        .expect(200);
      const rows = await audit('QUESTION_VARIANT_UPDATED', idOf(q));
      expect(rows.map((r) => r.metadata)).toEqual([
        { version: 1, variantId: v.id, fields: ['params'] },
        { version: 1, variantId: v.id, fields: ['params', 'isActive'] },
        { version: 1, variantId: v.id, fields: ['params', 'isActive'] },
      ]);
    });

    it('FR-203: editing the base statement must still render for every active variant (400, unchanged), and refreshes the stored statement otherwise', async () => {
      const a = await make(UserRole.AUTHOR);
      const q = await create(a, templated());
      const v = await addVariant(a, q);
      await http()
        .patch(`${API}/questions/${idOf(q)}`)
        .set(a.auth)
        .send({ statementMd: 'Needs {{missing}}.' })
        .expect(400);
      expect(
        (await owner.questionVersion.findFirstOrThrow({ where: { questionId: idOf(q) } }))
          .statementMd,
      ).toBe('Sum {{a}} and {{b}} for {{name}}.');
      await http()
        .patch(`${API}/questions/${idOf(q)}`)
        .set(a.auth)
        .send({ referenceSolution: { python: 'uses {{nope}}' } })
        .expect(400);
      await http()
        .patch(`${API}/questions/${idOf(q)}`)
        .set(a.auth)
        .send({ statementMd: 'Only {{name}}.' })
        .expect(200);
      expect(
        (await owner.questionVariant.findUniqueOrThrow({ where: { id: v.id } })).renderedStatement,
      ).toBe('Only Ada.');
    });

    it('FR-203: removing a variant removes its overrides; a missing or foreign variant id is 404', async () => {
      const a = await make(UserRole.AUTHOR);
      const q = await create(a, templated());
      const other = await create(a, templated());
      const v = await addVariant(a, q);
      const [sample] = await slotsOf(q);
      await http()
        .put(`${vbase(q)}/${v.id}/test-cases/${sample?.id}`)
        .set(a.auth)
        .send({ input: '5 6', expectedOutput: '11' })
        .expect(200);
      // The variant belongs to another question: 404 through this one.
      await http()
        .delete(`${vbase(other)}/${v.id}`)
        .set(a.auth)
        .expect(404);
      await http()
        .delete(`${vbase(q)}/${GHOST}`)
        .set(a.auth)
        .expect(404);
      await http()
        .delete(`${vbase(q)}/${v.id}`)
        .set(a.auth)
        .expect(204);
      expect(await owner.questionVariant.count({ where: { id: v.id } })).toBe(0);
      expect(await owner.variantTestCase.count({ where: { variantId: v.id } })).toBe(0);
      expect(await audit('QUESTION_VARIANT_REMOVED', idOf(q))).toHaveLength(1);
    });

    it('FR-203, ADR 0007 V-1, V-6: an override replaces one slot, the hidden flag and weight follow the slot, and only slots of this version are allowed', async () => {
      const a = await make(UserRole.AUTHOR);
      const q = await create(a, templated());
      const other = await create(a, templated());
      const v = await addVariant(a, q);
      const [sample, hidden] = await slotsOf(q);
      const [foreign] = await slotsOf(other);
      const put = (slot: string | undefined, body: Json = { input: '5 6', expectedOutput: '11' }) =>
        http()
          .put(`${vbase(q)}/${v.id}/test-cases/${slot}`)
          .set(a.auth)
          .send(body);
      const first = await put(sample?.id);
      expect([first.status, first.body]).toEqual([
        200,
        {
          testCaseId: sample?.id,
          isHidden: false,
          position: 0,
          input: '5 6',
          expectedOutput: '11',
        },
      ]);
      // Replaced, not duplicated.
      await put(sample?.id, { input: '7 8', expectedOutput: '15' }).expect(200);
      expect(await owner.variantTestCase.count({ where: { variantId: v.id } })).toBe(1);
      const hid = await put(hidden?.id, { input: 'HID-IN', expectedOutput: 'HID-OUT' });
      expect((hid.body as Json).isHidden).toBe(true);
      // A slot of another question (V-6), a random id and an unknown variant are the same 404.
      for (const res of [await put(foreign?.id), await put(GHOST)]) {
        expect(res.status).toBe(404);
      }
      await http()
        .put(`${vbase(q)}/${GHOST}/test-cases/${sample?.id}`)
        .set(a.auth)
        .send({ input: 'x', expectedOutput: 'y' })
        .expect(404);
      expect(await owner.variantTestCase.count({ where: { testCaseId: foreign?.id } })).toBe(0);
      // Body validation.
      for (const body of [
        {},
        { input: 'x' },
        { input: 1, expectedOutput: 'y' },
        { input: 'a\u0000', expectedOutput: 'y' },
        { input: 'x', expectedOutput: null },
        { input: 'x'.repeat(100_001), expectedOutput: 'y' },
        { input: 'x', expectedOutput: 'y', isHidden: false },
      ]) {
        await put(sample?.id, body).expect(400);
      }
      // The slot's own flag is the one shown: flip the slot to hidden and the override follows it.
      await http()
        .patch(`${API}/questions/${idOf(q)}/versions/1/test-cases/${sample?.id}`)
        .set(a.auth)
        .send({ isHidden: true })
        .expect(200);
      const list = await http().get(vbase(q)).set(a.auth).expect(200);
      const overrides = (list.body as { items: { testCaseOverrides: Json[] }[] }).items[0]
        ?.testCaseOverrides as Json[];
      expect(overrides.map((o) => [o.testCaseId, o.isHidden]).sort()).toEqual(
        [
          [sample?.id, true],
          [hidden?.id, true],
        ].sort(),
      );
      // Remove one: the default applies again; removing it twice is 404.
      await http()
        .delete(`${vbase(q)}/${v.id}/test-cases/${hidden?.id}`)
        .set(a.auth)
        .expect(204);
      await http()
        .delete(`${vbase(q)}/${v.id}/test-cases/${hidden?.id}`)
        .set(a.auth)
        .expect(404);
      expect(await owner.variantTestCase.count({ where: { variantId: v.id } })).toBe(1);
      expect((await audit('QUESTION_VARIANT_TEST_CASE_SET', idOf(q))).length).toBe(3);
      const set = (await audit('QUESTION_VARIANT_TEST_CASE_SET', idOf(q)))[0];
      expect(Object.keys(set?.metadata as Json).sort()).toEqual([
        'isHidden',
        'testCaseId',
        'variantId',
        'version',
      ]);
      expect(JSON.stringify(await audit('QUESTION_VARIANT_TEST_CASE_SET', idOf(q)))).not.toContain(
        'HID-IN',
      );
      // Removing a slot removes the overrides on it (cascade).
      await http()
        .delete(`${API}/questions/${idOf(q)}/versions/1/test-cases/${sample?.id}`)
        .set(a.auth)
        .expect(204);
      expect(await owner.variantTestCase.count({ where: { variantId: v.id } })).toBe(0);
    });

    it('FR-203, TC-013: a published version is immutable for variants (409); editing forks version 2 with copies of variants and overrides on the new slots', async () => {
      const a = await make(UserRole.AUTHOR);
      const q = await create(a, templated());
      const v = await addVariant(a, q);
      const [sample] = await slotsOf(q);
      await http()
        .put(`${vbase(q)}/${v.id}/test-cases/${sample?.id}`)
        .set(a.auth)
        .send({ input: '5 6', expectedOutput: '11' })
        .expect(200);
      await markValidated(idOf(q));
      await http()
        .post(`${API}/questions/${idOf(q)}/publish`)
        .set(a.auth)
        .expect(200);
      const v1 = await owner.questionVersion.findFirstOrThrow({
        where: { questionId: idOf(q), version: 1 },
      });
      const frozen = JSON.stringify([
        await owner.questionVariant.findMany({ where: { questionVersionId: v1.id } }),
        await owner.variantTestCase.findMany({ where: { variantId: v.id } }),
      ]);
      const auditsBefore = await pg.query('SELECT count(*)::int AS n FROM audit_logs');
      const calls = [
        http().post(vbase(q)).set(a.auth).send({ params }),
        http()
          .patch(`${vbase(q)}/${v.id}`)
          .set(a.auth)
          .send({ isActive: false }),
        http()
          .delete(`${vbase(q)}/${v.id}`)
          .set(a.auth),
        http()
          .put(`${vbase(q)}/${v.id}/test-cases/${sample?.id}`)
          .set(a.auth)
          .send({ input: 'x', expectedOutput: 'y' }),
        http()
          .delete(`${vbase(q)}/${v.id}/test-cases/${sample?.id}`)
          .set(a.auth),
      ];
      for (const c of calls) expect((await c).status).toBe(409);
      expect(
        JSON.stringify([
          await owner.questionVariant.findMany({ where: { questionVersionId: v1.id } }),
          await owner.variantTestCase.findMany({ where: { variantId: v.id } }),
        ]),
      ).toBe(frozen);
      expect((await pg.query('SELECT count(*)::int AS n FROM audit_logs')).rows[0]).toEqual(
        auditsBefore.rows[0],
      );
      // Forking: the next version is a draft with its own copies, version 1 is untouched.
      const forked = await http()
        .patch(`${API}/questions/${idOf(q)}`)
        .set(a.auth)
        .send({ statementMd: 'Fork {{name}}.' })
        .expect(200);
      expect((forked.body as Json).createdNewVersion).toBe(true);
      const v2 = await owner.questionVersion.findFirstOrThrow({
        where: { questionId: idOf(q), version: 2 },
      });
      const copies = await owner.questionVariant.findMany({
        where: { questionVersionId: v2.id },
        include: { testCaseOverrides: true },
      });
      expect(copies).toHaveLength(1);
      expect(copies[0]?.id).not.toBe(v.id);
      expect(copies[0]?.params).toEqual(params);
      expect(copies[0]?.renderedStatement).toBe('Fork Ada.');
      const newSlots = await owner.testCase.findMany({ where: { questionVersionId: v2.id } });
      expect(copies[0]?.testCaseOverrides).toHaveLength(1);
      expect(newSlots.map((s) => s.id)).toContain(copies[0]?.testCaseOverrides[0]?.testCaseId);
      expect(copies[0]?.testCaseOverrides[0]?.testCaseId).not.toBe(sample?.id);
      expect(copies[0]?.testCaseOverrides[0]?.input).toBe('5 6');
      // Version 1 kept its own variant row and statement.
      expect(
        (await owner.questionVariant.findUniqueOrThrow({ where: { id: v.id } })).renderedStatement,
      ).toBe('Sum 2 and 3 for Ada.');
      // The draft version 2 accepts variant writes.
      await http().post(vbase(q, 2)).set(a.auth).send({ params }).expect(201);
    });

    it('FR-203, TC-012 (partial: render rules only; running the reference is slice 4c): publish needs every active variant to render and every override on a slot of the version', async () => {
      const a = await make(UserRole.AUTHOR);
      const q = await create(a, templated());
      const v = await addVariant(a, q);
      const head = await owner.questionVersion.findFirstOrThrow({ where: { questionId: idOf(q) } });
      const publish = (): request.Test =>
        http()
          .post(`${API}/questions/${idOf(q)}/publish`)
          .set(a.auth);
      // A variant whose params went bad behind the API's back (here: a direct database write).
      await owner.questionVariant.update({ where: { id: v.id }, data: { params: { a: 1 } } });
      await markValidated(idOf(q));
      const blocked = await publish();
      expect(blocked.status).toBe(422);
      expect(JSON.stringify(blocked.body)).toContain(`variants[${v.id}]`);
      expect(
        (await owner.questionVersion.findUniqueOrThrow({ where: { id: head.id } })).isPublished,
      ).toBe(false);
      // Inactive: not rendered, does not block.
      await owner.questionVariant.update({ where: { id: v.id }, data: { isActive: false } });
      await markValidated(idOf(q));
      // An override on a slot of another version is refused (V-6), even for an inactive variant.
      const other = await create(a, templated());
      const [foreign] = await slotsOf(other);
      await owner.variantTestCase.create({
        data: {
          variantId: v.id,
          testCaseId: foreign?.id as string,
          input: 'i',
          expectedOutput: 'o',
        },
      });
      await markValidated(idOf(q));
      const v6 = await publish();
      expect(v6.status).toBe(422);
      expect(JSON.stringify(v6.body)).toContain(
        'overrides a test slot that is not in this version',
      );
      await owner.variantTestCase.deleteMany({ where: { variantId: v.id } });
      await markValidated(idOf(q));
      await publish().expect(200);
    });

    it('FR-203: publish stores the freshly rendered statement of each active variant; a stale validation (variant added after) is refused', async () => {
      const a = await make(UserRole.AUTHOR);
      const q = await create(a, templated());
      const v = await addVariant(a, q);
      await owner.questionVariant.update({
        where: { id: v.id },
        data: { renderedStatement: 'STALE' },
      });
      // markValidated binds to the revision WITHOUT the variant added next: publish must refuse.
      const head = await owner.questionVersion.findFirstOrThrow({ where: { questionId: idOf(q) } });
      const cases = await owner.testCase.findMany({ where: { questionVersionId: head.id } });
      await markValidated(idOf(q), computeRevision(head, cases));
      const res = await http()
        .post(`${API}/questions/${idOf(q)}/publish`)
        .set(a.auth);
      expect(res.status).toBe(422);
      expect(JSON.stringify(res.body)).toContain('validation');
      await markValidated(idOf(q));
      await http()
        .post(`${API}/questions/${idOf(q)}/publish`)
        .set(a.auth)
        .expect(200);
      expect(
        (await owner.questionVariant.findUniqueOrThrow({ where: { id: v.id } })).renderedStatement,
      ).toBe('Sum 2 and 3 for Ada.');
    });

    it('FR-204: expectedRevision on variant routes: stale is 409 and changes nothing; the returned revision is current', async () => {
      const a = await make(UserRole.AUTHOR);
      const q = await create(a, templated());
      const first = await addVariant(a, q);
      const stale = first.revision;
      const second = await addVariant(a, q, params, { expectedRevision: stale });
      expect(second.revision).not.toBe(stale);
      const res = await http().post(vbase(q)).set(a.auth).send({ params, expectedRevision: stale });
      expect(res.status).toBe(409);
      expect(Object.keys(res.body as Json)).not.toContain('code');
      await http()
        .patch(`${vbase(q)}/${first.id}`)
        .set(a.auth)
        .send({ isActive: false, expectedRevision: stale })
        .expect(409);
      await http()
        .delete(`${vbase(q)}/${first.id}?expectedRevision=${stale}`)
        .set(a.auth)
        .expect(409);
      const [sample] = await slotsOf(q);
      await http()
        .put(`${vbase(q)}/${first.id}/test-cases/${sample?.id}`)
        .set(a.auth)
        .send({ input: 'x', expectedOutput: 'y', expectedRevision: stale })
        .expect(409);
      await http()
        .delete(`${vbase(q)}/${first.id}/test-cases/${sample?.id}?expectedRevision=${stale}`)
        .set(a.auth)
        .expect(409);
      expect(
        await owner.questionVariant.count({ where: { questionVersion: { questionId: idOf(q) } } }),
      ).toBe(2);
      await http()
        .delete(`${vbase(q)}/${first.id}?expectedRevision=${second.revision}`)
        .set(a.auth)
        .expect(204);
      // The base PATCH sees a variant change too.
      const current = await liveRevision(a, q);
      await addVariant(a, q);
      await http()
        .patch(`${API}/questions/${idOf(q)}`)
        .set(a.auth)
        .send({ title: 'T', expectedRevision: current })
        .expect(409);
    });

    it('FR-203: at most 50 variants per version (422); non-coding questions have none (422)', async () => {
      const a = await make(UserRole.AUTHOR);
      const q = await create(a, templated());
      const head = await owner.questionVersion.findFirstOrThrow({ where: { questionId: idOf(q) } });
      await owner.questionVariant.createMany({
        data: Array.from({ length: 50 }, () => ({
          questionVersionId: head.id,
          params,
          renderedStatement: 'x',
        })),
      });
      await http().post(vbase(q)).set(a.auth).send({ params }).expect(422);
      const mcq = await create(a, {
        type: 'MCQ',
        title: 'M',
        statementMd: 'S',
        difficulty: 'EASY',
        answerSpec: mcqSpec,
      });
      await http().post(vbase(mcq)).set(a.auth).send({ params }).expect(422);
    });

    it('FR-203: concurrent variant creates and a base statement edit never leave an active variant that cannot render', async () => {
      const a = await make(UserRole.AUTHOR);
      const q = await create(a, codingBody({ statementMd: 'Plain.' }));
      const results = await Promise.all([
        ...Array.from({ length: 6 }, (_, i) =>
          http()
            .post(vbase(q))
            .set(a.auth)
            .send({ params: { n: i } }),
        ),
        http()
          .patch(`${API}/questions/${idOf(q)}`)
          .set(a.auth)
          .send({ statementMd: 'Size {{n}}.' }),
      ]);
      for (const r of results) expect([201, 200, 400]).toContain(r.status);
      expect(results[6]?.status).toBe(200); // every variant has n, so the edit is always valid
      const head = await owner.questionVersion.findFirstOrThrow({ where: { questionId: idOf(q) } });
      expect(head.statementMd).toBe('Size {{n}}.');
      const rows = await owner.questionVariant.findMany({ where: { questionVersionId: head.id } });
      expect(rows.filter((r) => r.isActive).length).toBe(
        results.filter((r) => r.status === 201).length,
      );
      for (const r of rows) {
        const n = (r.params as { n: number }).n;
        // Created before the edit: its own text is stored as it was then; after: rendered with n.
        expect(['Plain.', `Size ${n}.`]).toContain(r.renderedStatement);
      }
      // The invariant: after the edit settled, publish-time rendering is clean for each variant.
      await http()
        .patch(`${API}/questions/${idOf(q)}`)
        .set(a.auth)
        .send({ title: 'again' })
        .expect(200);
    });

    it('FR-203, V-5, TC-011: the variant preview is candidate-shaped: rendered text, its own samples, no params, hidden data, reference solution or key', async () => {
      const a = await make(UserRole.AUTHOR);
      const r = await make(UserRole.RECRUITER);
      const q = await create(
        a,
        templated({
          testCases: [
            sampleCase,
            hiddenCase,
            { input: 'S2', expectedOutput: 'S2-OUT', isHidden: false, position: 5 },
          ],
        }),
      );
      const v = await addVariant(a, q, { a: 2, b: 3, name: 'SECRET-NAME-PARAM' });
      const slots = await slotsOf(q);
      await http()
        .put(`${vbase(q)}/${v.id}/test-cases/${slots[0]?.id}`)
        .set(a.auth)
        .send({ input: 'V-SAMPLE-IN', expectedOutput: 'V-SAMPLE-OUT' })
        .expect(200);
      await http()
        .put(`${vbase(q)}/${v.id}/test-cases/${slots[1]?.id}`)
        .set(a.auth)
        .send({ input: 'V-HIDDEN-IN', expectedOutput: 'V-HIDDEN-OUT' })
        .expect(200);
      const path = `${vbase(q)}/${v.id}/preview`;
      // The author sees the draft; a recruiter gets 404 until it is published.
      const draft = await http().get(path).set(a.auth).expect(200);
      expect(Object.keys(draft.body as Json).sort()).toEqual([
        'languages',
        'limits',
        'samples',
        'starterCode',
        'statementMd',
        'title',
        'type',
      ]);
      expect(draft.body).toMatchObject({
        statementMd: 'Sum 2 and 3 for SECRET-NAME-PARAM.',
        starterCode: { python: 'A = 2' },
        samples: [
          { input: 'V-SAMPLE-IN', expectedOutput: 'V-SAMPLE-OUT' },
          { input: 'S2', expectedOutput: 'S2-OUT' },
        ],
      });
      await http().get(path).set(r.auth).expect(404);
      await markValidated(idOf(q));
      await http()
        .post(`${API}/questions/${idOf(q)}/publish`)
        .set(a.auth)
        .expect(200);
      const res = await http().get(path).set(r.auth).expect(200);
      expect(res.body).toEqual(draft.body);
      const text = JSON.stringify(res.body);
      for (const secret of [
        'V-HIDDEN-IN',
        'V-HIDDEN-OUT',
        'HIDDEN-IN-9',
        'HIDDEN-OUT-9',
        'REFERENCE-SECRET',
        'params',
        'referenceSolution',
        'answerSpec',
        'revision',
      ]) {
        expect([secret, text.includes(secret)]).toEqual([secret, false]);
      }
      // An inactive variant is invisible to a recruiter (404) and still previewable by an author.
      await owner.questionVariant.update({ where: { id: v.id }, data: { isActive: false } });
      await http().get(path).set(r.auth).expect(404);
      await http().get(path).set(a.auth).expect(200);
      // Unknown variant, wrong version: 404.
      await http()
        .get(`${vbase(q)}/${GHOST}/preview`)
        .set(r.auth)
        .expect(404);
      await http()
        .get(`${vbase(q, 9)}/${v.id}/preview`)
        .set(a.auth)
        .expect(404);
    });

    it('FR-203: a variant that no longer renders is 422 with reasons for an author and a plain 422 for others', async () => {
      const a = await make(UserRole.AUTHOR);
      const r = await make(UserRole.RECRUITER);
      const q = await create(a, templated());
      const v = await addVariant(a, q);
      await markValidated(idOf(q));
      await http()
        .post(`${API}/questions/${idOf(q)}/publish`)
        .set(a.auth)
        .expect(200);
      // Corrupt the published row directly (the API cannot).
      await owner.questionVariant.update({ where: { id: v.id }, data: { params: { a: 1 } } });
      const path = `${vbase(q)}/${v.id}/preview`;
      const author = await http().get(path).set(a.auth);
      const recruiter = await http().get(path).set(r.auth);
      expect([author.status, recruiter.status]).toEqual([422, 422]);
      expect(JSON.stringify(author.body)).toContain('unknown placeholder');
      expect(JSON.stringify(recruiter.body)).not.toContain('placeholder');
    });

    it('FR-103, TC-004: roles on the variant routes: REVIEWER is 403 everywhere, RECRUITER only previews, org B gets 404 and nothing changes', async () => {
      const a = await make(UserRole.AUTHOR);
      const recruiter = await make(UserRole.RECRUITER);
      const reviewer = await make(UserRole.REVIEWER);
      const q = await create(a, templated());
      const v = await addVariant(a, q);
      const [sample] = await slotsOf(q);
      const base = vbase(q);
      const calls: [string, string, Json | undefined][] = [
        ['get', base, undefined],
        ['post', base, { params }],
        ['patch', `${base}/${v.id}`, { isActive: false }],
        ['delete', `${base}/${v.id}`, undefined],
        ['put', `${base}/${v.id}/test-cases/${sample?.id}`, { input: 'x', expectedOutput: 'y' }],
        ['delete', `${base}/${v.id}/test-cases/${sample?.id}`, undefined],
      ];
      const send = (who: Made, [m, url, body]: [string, string, Json | undefined]) => {
        const req = (http() as unknown as Record<string, (u: string) => request.Test>)[m]?.(url);
        if (!req) throw new Error('bad method');
        return body ? req.set(who.auth).send(body) : req.set(who.auth);
      };
      for (const call of calls) {
        expect([call[0], call[1], (await send(recruiter, call)).status]).toEqual([
          call[0],
          call[1],
          403,
        ]);
        expect([call[0], (await send(reviewer, call)).status]).toEqual([call[0], 403]);
      }
      await http().get(`${base}/${v.id}/preview`).set(reviewer.auth).expect(403);
      const outsider = await make(UserRole.AUTHOR, orgB);
      for (const call of calls) {
        expect([call[0], call[1], (await send(outsider, call)).status]).toEqual([
          call[0],
          call[1],
          404,
        ]);
      }
      await http().get(`${base}/${v.id}/preview`).set(outsider.auth).expect(404);
      const row = await owner.questionVariant.findUniqueOrThrow({ where: { id: v.id } });
      expect([row.isActive, row.params]).toEqual([true, params]);
      expect(await owner.variantTestCase.count({ where: { variantId: v.id } })).toBe(0);
      // The same 404 as for a random question id.
      const a404 = await http().get(base).set(outsider.auth);
      const ghost = await http()
        .get(`${API}/questions/${GHOST}/versions/1/variants`)
        .set(outsider.auth);
      expect(stable(a404)).toEqual({ ...stable(ghost), instance: undefined });
    });

    it('TC-011, FR-203: a recruiter never receives variant params or overrides in the detail view, and the version keys do not change', async () => {
      const a = await make(UserRole.AUTHOR);
      const r = await make(UserRole.RECRUITER);
      const q = await create(a, templated());
      const v = await addVariant(a, q, { a: 1, b: 2, name: 'SECRET-PARAM-ZED' });
      const [, hidden] = await slotsOf(q);
      await http()
        .put(`${vbase(q)}/${v.id}/test-cases/${hidden?.id}`)
        .set(a.auth)
        .send({ input: 'SECRET-OV-IN', expectedOutput: 'SECRET-OV-OUT' })
        .expect(200);
      await markValidated(idOf(q));
      await http()
        .post(`${API}/questions/${idOf(q)}/publish`)
        .set(a.auth)
        .expect(200);
      for (const url of [
        `${API}/questions/${idOf(q)}`,
        `${API}/questions/${idOf(q)}?version=1`,
        `${API}/questions?includeArchived=true`,
        `${API}/questions/${idOf(q)}/preview`,
      ]) {
        const res = await http().get(url).set(r.auth).expect(200);
        const text = JSON.stringify(res.body);
        for (const s of [
          'SECRET-PARAM-ZED',
          'SECRET-OV',
          'variants',
          'params',
          'renderedStatement',
        ]) {
          expect([url, s, text.includes(s)]).toEqual([url, s, false]);
        }
      }
      const full = JSON.stringify(
        (
          await http()
            .get(`${API}/questions/${idOf(q)}`)
            .set(a.auth)
        ).body,
      );
      expect(full).toContain('SECRET-PARAM-ZED');
      expect(full).toContain('SECRET-OV-OUT');
    });
  });

  // ---- route matrix ----------------------------------------------------------------------------

  it('TC-004: every question route is in the permission matrix with matching access (FR-103)', () => {
    const { ModulesContainer } = jest.requireActual<typeof import('@nestjs/core')>('@nestjs/core');
    const { listRoutes, matrixProblems } = jest.requireActual<
      typeof import('../common/auth/route-registry')
    >('../common/auth/route-registry');
    const routes = listRoutes(app.get(ModulesContainer));
    expect(routes.filter((r) => r.key.includes('/questions')).length).toBe(24);
    expect(matrixProblems(routes)).toEqual([]);
  });
});
