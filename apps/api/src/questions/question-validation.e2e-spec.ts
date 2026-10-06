// The validate job and AI reference solutions (FR-202, FR-203, TC-011, TC-012; BE-04 slice 4c) against
// real Postgres 16 and Redis (Testcontainers), the API running as app_user as in production. The
// code executor is replaced by a fake behind the question bank's port.
import { INestApplication, Logger } from '@nestjs/common';
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
import type { PortRequest, PortResult } from './reference-validation.port';
import type { ValidationService } from './validation.service';

const API = '/api/v1';
const GHOST = '00000000-0000-4000-8000-000000000042';
const AI_SECRET = 'QA-AI-SOLUTION-SECRET-CODE';
const AI_PROMPT = 'QA-AI-PROMPT-SECRET';
const REF_SECRET = 'REFERENCE-SECRET {{n}}';
const HIDDEN_IN = 'HIDDEN-IN-9';
const HIDDEN_OUT = 'HIDDEN-OUT-9';

type Json = Record<string, unknown>;

const codingBody = (over: Json = {}): Json => ({
  title: 'Print n',
  statementMd: 'Print {{n}}.',
  difficulty: 'EASY',
  tags: ['arrays'],
  allowedLanguages: ['python'],
  starterCode: { python: 'def solve(): ...' },
  referenceSolution: { python: REF_SECRET },
  testCases: [
    { input: '1 2', expectedOutput: '3', isHidden: false, weight: 1 },
    { input: HIDDEN_IN, expectedOutput: HIDDEN_OUT, isHidden: true, weight: 2 },
  ],
  ...over,
});

/** The controllable stand-in for the code executor. */
class FakePort {
  calls: PortRequest[] = [];
  /** Variant ids whose python reference fails the first slot. */
  failVariants = new Set<string | null>();
  reject: Error | undefined;
  hang = false;
  gate: Promise<void> | undefined;

  validate(req: PortRequest): Promise<PortResult> {
    this.calls.push(req);
    if (this.reject) return Promise.reject(this.reject);
    if (this.hang) return new Promise<PortResult>(() => undefined);
    const answer = (): PortResult => {
      const cells = req.variants.flatMap((v) =>
        req.languages.map((language) => {
          const bad = this.failVariants.has(v.variantId);
          return {
            variantId: v.variantId,
            language,
            passed: !bad,
            testsPassed: bad ? v.tests.length - 1 : v.tests.length,
            testsTotal: v.tests.length,
          };
        }),
      );
      const failures = req.variants
        .filter((v) => this.failVariants.has(v.variantId))
        .flatMap((v) =>
          req.languages.map((language) => ({
            variantId: v.variantId,
            language,
            testCaseId: v.tests[0]?.testCaseId ?? null,
            position: v.tests[0]?.position ?? null,
            verdict: 'FAILED',
            actualOutput: 'WRONG',
          })),
        );
      return { passed: failures.length === 0, cells, failures };
    };
    return this.gate ? this.gate.then(answer) : Promise.resolve(answer());
  }
}

describe('Validate job and AI references (FR-202, FR-203, TC-011, TC-012)', () => {
  let infra: TestInfra;
  let app: INestApplication<App>;
  let owner: PrismaClient;
  let pg: Client;
  let orgA: string;
  let orgB: string;
  let tokens: TokenService;
  let validation: ValidationService;
  let seq = 0;
  const port = new FakePort();

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
    const { REFERENCE_VALIDATION_PORT } = jest.requireActual<
      typeof import('./reference-validation.port')
    >('./reference-validation.port');
    const { ValidationService: Validation } =
      jest.requireActual<typeof import('./validation.service')>('./validation.service');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MailPort)
      .useValue({})
      .overrideProvider(REFERENCE_VALIDATION_PORT)
      .useValue(port)
      .compile();
    app = moduleRef.createNestApplication<INestApplication<App>>();
    configureApp(app);
    await app.init();
    await app.listen(0);
    const { TokenService: Tokens } = jest.requireActual<
      typeof import('../common/auth/token.service')
    >('../common/auth/token.service');
    tokens = app.get(Tokens);
    validation = app.get(Validation);
  });

  afterAll(async () => {
    await app?.close();
    await owner?.$disconnect();
    await pg?.end();
    await infra?.stop();
  });

  beforeEach(() => {
    port.calls = [];
    port.failVariants = new Set();
    port.reject = undefined;
    port.hang = false;
    port.gate = undefined;
    validation.timeoutMs = 60_000;
  });

  interface Made {
    id: string;
    auth: { Authorization: string };
  }

  async function make(role: UserRole, orgId = orgA): Promise<Made> {
    const n = ++seq;
    const passwordHash = `hash-${n}`;
    const user = await owner.user.create({
      data: { orgId, email: `v${n}@example.com`, fullName: `V ${n}`, role, passwordHash },
    });
    const token = tokens.sign(
      { sub: user.id, org: orgId, role, kind: 'access', pwv: passwordVersion(passwordHash) },
      900,
    );
    return { id: user.id, auth: { Authorization: `Bearer ${token}` } };
  }

  const http = (): ReturnType<typeof request> => request(app.getHttpServer());
  const setGate = (orgId: string, minAssistants: number): Promise<unknown> =>
    owner.organization.update({
      where: { id: orgId },
      data: { settings: { aiReferences: { minAssistants } } },
    });

  async function create(who: Made, body: Json = codingBody()): Promise<string> {
    const res = await http().post(`${API}/questions`).set(who.auth).send(body);
    expect([res.status, res.body]).toEqual([201, expect.anything()]);
    return (res.body as Json).id as string;
  }

  async function detail(who: Made, id: string): Promise<Json> {
    const res = await http().get(`${API}/questions/${id}`).set(who.auth).expect(200);
    return (res.body as Json).version as Json;
  }

  async function addVariant(who: Made, id: string, n: number): Promise<string> {
    const res = await http()
      .post(`${API}/questions/${id}/versions/1/variants`)
      .set(who.auth)
      .send({ params: { n } })
      .expect(201);
    return ((res.body as Json).variant as Json).id as string;
  }

  /** Starts a run and waits for the job to end. */
  async function validate(who: Made, id: string, body: Json = {}): Promise<request.Response> {
    const res = await http().post(`${API}/questions/${id}/validate`).set(who.auth).send(body);
    await validation.whenIdle();
    return res;
  }

  const status = async (who: Made, id: string): Promise<Json> =>
    (await http().get(`${API}/questions/${id}/validation`).set(who.auth).expect(200)).body as Json;
  const publish = (who: Made, id: string): request.Test =>
    http().post(`${API}/questions/${id}/publish`).set(who.auth).send({});
  const aiBody = (over: Json = {}): Json => ({
    assistant: 'ChatGPT',
    modelLabel: 'gpt-x',
    language: 'python',
    solutionCode: AI_SECRET,
    promptText: AI_PROMPT,
    ...over,
  });
  const addAi = (who: Made, id: string, over: Json = {}, version = 1): request.Test =>
    http()
      .post(`${API}/questions/${id}/versions/${version}/ai-references`)
      .set(who.auth)
      .send(aiBody(over));
  async function question(id: string): Promise<{ validatedAt: Date | null; report: Json | null }> {
    const v = await owner.questionVersion.findFirstOrThrow({
      where: { questionId: id },
      orderBy: { version: 'desc' },
    });
    return { validatedAt: v.validatedAt, report: v.validationReport as Json | null };
  }

  beforeAll(async () => {
    await setGate(orgA, 0);
  });

  // ---- validation -----------------------------------------------------------------------------

  describe('FR-203: the validate job', () => {
    it('FR-203, TC-012: validate then publish succeeds; the run covers the base content with the stored revision', async () => {
      const a = await make(UserRole.AUTHOR);
      const id = await create(a);
      const revision = (await detail(a, id)).revision as string;
      const res = await validate(a, id);
      expect(res.status).toBe(202);
      expect(res.body).toMatchObject({ status: 'RUNNING', revision, version: 1 });
      expect(port.calls).toHaveLength(1);
      expect(port.calls[0]?.variants).toHaveLength(1);
      expect(port.calls[0]?.variants[0]?.variantId).toBeNull();
      expect(port.calls[0]?.variants[0]?.tests).toHaveLength(2);
      const s = await status(a, id);
      expect(s).toMatchObject({ status: 'PASSED', revision, currentRevision: revision });
      expect(s.validatedAt).not.toBeNull();
      expect((s.report as Json).passed).toBe(true);
      expect((s.report as Json).revision).toBe(revision);
      await publish(a, id).expect(200);
    });

    it('FR-203: every active variant runs its rendered reference and its own slot data', async () => {
      const a = await make(UserRole.AUTHOR);
      const id = await create(a);
      const v1 = await addVariant(a, id, 1);
      const v2 = await addVariant(a, id, 2);
      const inactive = await addVariant(a, id, 3);
      await http()
        .patch(`${API}/questions/${id}/versions/1/variants/${inactive}`)
        .set(a.auth)
        .send({ isActive: false })
        .expect(200);
      const ver = await owner.questionVersion.findFirstOrThrow({ where: { questionId: id } });
      const hidden = await owner.testCase.findFirstOrThrow({
        where: { questionVersionId: ver.id, isHidden: true },
      });
      await http()
        .put(`${API}/questions/${id}/versions/1/variants/${v2}/test-cases/${hidden.id}`)
        .set(a.auth)
        .send({ input: 'V2-IN', expectedOutput: 'V2-OUT' })
        .expect(200);
      const revision = (await detail(a, id)).revision as string;
      const res = await validate(a, id);
      expect(res.body).toMatchObject({ revision });
      const sent = port.calls[0]?.variants ?? [];
      expect(sent.map((v) => v.variantId).sort()).toEqual([v1, v2].sort());
      for (const v of sent) {
        const n = v.variantId === v1 ? 1 : 2;
        expect(v.referenceSources).toEqual({ python: `REFERENCE-SECRET ${n}` });
        expect(v.tests.find((t) => t.isHidden)?.input).toBe(
          v.variantId === v2 ? 'V2-IN' : HIDDEN_IN,
        );
      }
      expect((await status(a, id)).status).toBe('PASSED');
      await publish(a, id).expect(200);
    });

    it('TC-012: a variant that fails its own data blocks publish and the report names variant, slot and verdict', async () => {
      const a = await make(UserRole.AUTHOR);
      const id = await create(a);
      await addVariant(a, id, 1);
      const bad = await addVariant(a, id, 2);
      port.failVariants.add(bad);
      await validate(a, id).then((r) => expect(r.status).toBe(202));
      const s = await status(a, id);
      expect(s.status).toBe('FAILED');
      expect(s.validatedAt).toBeNull();
      const per = ((s.report as Json).perVariant as Json[]).find((p) => p.variantId === bad);
      expect(per).toMatchObject({ passed: false });
      expect((per?.failures as Json[])[0]).toMatchObject({ verdict: 'FAILED', position: 0 });
      expect((await question(id)).validatedAt).toBeNull();
      const res = await publish(a, id).expect(422);
      expect(JSON.stringify(res.body)).toContain('validation');
    });

    it('TC-012: validate, edit and save while it runs, then publish is still 422 (stale validation)', async () => {
      const a = await make(UserRole.AUTHOR);
      const id = await create(a);
      let release: () => void = () => undefined;
      port.gate = new Promise<void>((r) => {
        release = r;
      });
      const started = await http().post(`${API}/questions/${id}/validate`).set(a.auth).send({});
      expect(started.status).toBe(202);
      expect((await status(a, id)).status).toBe('RUNNING');
      await http()
        .patch(`${API}/questions/${id}`)
        .set(a.auth)
        .send({ title: 'Edited while running' })
        .expect(200);
      release();
      await validation.whenIdle();
      const s = await status(a, id);
      expect(s.status).toBe('STALE');
      expect(s.validatedAt).toBeNull();
      expect(s.revision).toBe((started.body as Json).revision);
      expect(s.currentRevision).not.toBe(s.revision);
      expect((await question(id)).validatedAt).toBeNull();
      // The STALE outcome is recorded (a job-written row) and nothing was stored in the report.
      const finished = await owner.auditLog.findMany({
        where: { entityId: id, action: 'QUESTION_VALIDATION_FINISHED' },
      });
      expect(finished).toHaveLength(1);
      expect((finished[0]?.metadata as { outcome: string }).outcome).toBe('STALE');
      expect(finished[0]?.actorId).toBeNull();
      const stored = await owner.questionVersion.findFirstOrThrow({
        where: { questionId: id },
        orderBy: { version: 'desc' },
      });
      expect(stored.validationReport).toBeNull();
      await publish(a, id).expect(422);
      // A fresh run on the new content opens the gate.
      port.gate = undefined;
      await validate(a, id);
      expect((await status(a, id)).status).toBe('PASSED');
      await publish(a, id).expect(200);
    });

    it('TC-012: a test case or variant change while the job runs is stale as well', async () => {
      const a = await make(UserRole.AUTHOR);
      const id = await create(a);
      let release: () => void = () => undefined;
      port.gate = new Promise<void>((r) => {
        release = r;
      });
      await http().post(`${API}/questions/${id}/validate`).set(a.auth).send({}).expect(202);
      await http()
        .post(`${API}/questions/${id}/versions/1/test-cases`)
        .set(a.auth)
        .send({ input: 'x', expectedOutput: 'y', isHidden: true, weight: 1 })
        .expect(201);
      release();
      await validation.whenIdle();
      expect((await status(a, id)).status).toBe('STALE');
      await publish(a, id).expect(422);
    });

    it('FR-203: a new run closes the gate until it passes (a stale pass never survives a restart)', async () => {
      const a = await make(UserRole.AUTHOR);
      const id = await create(a);
      await validate(a, id);
      expect((await question(id)).validatedAt).not.toBeNull();
      let release: () => void = () => undefined;
      port.gate = new Promise<void>((r) => {
        release = r;
      });
      await http().post(`${API}/questions/${id}/validate`).set(a.auth).send({}).expect(202);
      expect((await question(id)).validatedAt).toBeNull();
      await publish(a, id).expect(422);
      release();
      await validation.whenIdle();
      expect((await question(id)).validatedAt).not.toBeNull();
    });

    it('FR-203: a second start while a run is in progress is 409', async () => {
      const a = await make(UserRole.AUTHOR);
      const id = await create(a);
      let release: () => void = () => undefined;
      port.gate = new Promise<void>((r) => {
        release = r;
      });
      await http().post(`${API}/questions/${id}/validate`).set(a.auth).send({}).expect(202);
      await http().post(`${API}/questions/${id}/validate`).set(a.auth).send({}).expect(409);
      release();
      await validation.whenIdle();
      expect(port.calls).toHaveLength(1);
    });

    it('FR-203: concurrent starts run exactly one job', async () => {
      const a = await make(UserRole.AUTHOR);
      const id = await create(a);
      let release: () => void = () => undefined;
      port.gate = new Promise<void>((r) => {
        release = r;
      });
      const codes = await Promise.all(
        [1, 2, 3].map(
          async () =>
            (await http().post(`${API}/questions/${id}/validate`).set(a.auth).send({})).status,
        ),
      );
      release();
      await validation.whenIdle();
      expect(codes.filter((c) => c === 202)).toHaveLength(1);
      expect(codes.filter((c) => c === 409)).toHaveLength(2);
      expect(port.calls).toHaveLength(1);
    });

    it('FR-203: execution errors and timeouts fail closed and log neither source nor messages', async () => {
      const a = await make(UserRole.AUTHOR);
      const id = await create(a);
      const logged: string[] = [];
      const spies = (['warn', 'error', 'log'] as const).map((m) =>
        jest.spyOn(Logger.prototype, m).mockImplementation((...args: unknown[]) => {
          logged.push(args.map(String).join(' '));
        }),
      );
      try {
        port.reject = new Error(`boom ${REF_SECRET} ${HIDDEN_OUT}`);
        await validate(a, id);
        let s = await status(a, id);
        expect(s.status).toBe('ERROR');
        expect(s.validatedAt).toBeNull();
        expect((s.report as Json).error).toBe('EXECUTION_ERROR');
        await publish(a, id).expect(422);

        port.reject = undefined;
        port.hang = true;
        validation.timeoutMs = 50;
        await validate(a, id);
        s = await status(a, id);
        expect(s.status).toBe('ERROR');
        expect((s.report as Json).error).toBe('TIMEOUT');
        expect((await question(id)).validatedAt).toBeNull();
      } finally {
        spies.forEach((x) => x.mockRestore());
      }
      expect(logged.join('\n')).not.toMatch(/REFERENCE-SECRET|HIDDEN-OUT|boom/);
    });

    it('FR-203: a question with no active variant and an active variant that does not render', async () => {
      const a = await make(UserRole.AUTHOR);
      const id = await create(
        a,
        codingBody({ referenceSolution: { python: 'print(1)' }, statementMd: 'S' }),
      );
      await validate(a, id);
      expect((await status(a, id)).status).toBe('PASSED');
      // A later edit adds a placeholder no variant defines: the next run is a 422, not a pass.
      const id2 = await create(a);
      await addVariant(a, id2, 1);
      // The API refuses such an edit (4b); a row written around it must still not validate.
      await owner.questionVersion.updateMany({
        where: { questionId: id2 },
        data: { statementMd: 'Print {{m}}.' },
      });
      const res = await http().post(`${API}/questions/${id2}/validate`).set(a.auth).send({});
      expect(res.status).toBe(422);
      expect(port.calls).toHaveLength(1);
    });

    it('FR-203: not a coding question 422, published latest 409, archived 409, stale expectedRevision 409, bad body 400', async () => {
      const a = await make(UserRole.AUTHOR);
      const mcq = await create(a, {
        type: 'MCQ',
        title: 'M',
        statementMd: 'M',
        difficulty: 'EASY',
        answerSpec: {
          options: [
            { id: 'a', text: 'A' },
            { id: 'b', text: 'B' },
          ],
          correctOptionIds: ['a'],
          multiple: false,
        },
      });
      await http().post(`${API}/questions/${mcq}/validate`).set(a.auth).send({}).expect(422);
      const id = await create(a);
      await http()
        .post(`${API}/questions/${id}/validate`)
        .set(a.auth)
        .send({ expectedRevision: 'f'.repeat(64) })
        .expect(409);
      await http()
        .post(`${API}/questions/${id}/validate`)
        .set(a.auth)
        .send({ expectedRevision: 'nope' })
        .expect(400);
      await http()
        .post(`${API}/questions/${id}/validate`)
        .set(a.auth)
        .send({ surprise: 1 })
        .expect(400);
      await validate(a, id);
      await publish(a, id).expect(200);
      await http().post(`${API}/questions/${id}/validate`).set(a.auth).send({}).expect(409);
      const other = await create(a);
      await http().post(`${API}/questions/${other}/archive`).set(a.auth).expect(200);
      await http().post(`${API}/questions/${other}/validate`).set(a.auth).send({}).expect(409);
      expect(port.calls).toHaveLength(1);
    });

    it('FR-203, FU-BE-130: the job records a start and a finish audit row with ids and outcome only', async () => {
      const a = await make(UserRole.AUTHOR);
      const id = await create(a);
      await validate(a, id);
      await validation.whenIdle();
      const rows = await owner.auditLog.findMany({
        where: { entityId: id, action: { startsWith: 'QUESTION_VALIDATION' } },
        orderBy: { createdAt: 'asc' },
      });
      expect(rows.map((r) => r.action)).toEqual([
        'QUESTION_VALIDATION_STARTED',
        'QUESTION_VALIDATION_FINISHED',
      ]);
      expect(rows[0]?.metadata).toEqual({ version: 1, variants: 1 });
      const finished = rows[1]?.metadata as Record<string, unknown>;
      expect(Object.keys(finished).sort()).toEqual([
        'initiatedBy',
        'outcome',
        'revision',
        'startedAuditId',
        'system',
        'version',
      ]);
      expect([finished.system, finished.initiatedBy, finished.version, finished.outcome]).toEqual([
        true,
        a.id,
        1,
        'PASSED',
      ]);
      expect(finished.startedAuditId).toBe(String(rows[0]?.id));
      expect(finished.revision).toMatch(/^[0-9a-f]{12}$/);
      // The STARTED row is request-driven (actor, ip); the FINISHED row is job-written (ADR 0001 C-3).
      expect(rows[0]?.actorId).toBe(a.id);
      expect([rows[1]?.actorId, rows[1]?.ip]).toEqual([null, null]);
      expect(rows.every((r) => r.orgId === orgA)).toBe(true);
      expect(
        JSON.stringify(rows, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
      ).not.toMatch(/REFERENCE-SECRET|HIDDEN/);
    });

    it('FR-103, TC-004: roles and tenancy (recruiter and reviewer 403, anonymous 401, other org 404)', async () => {
      const a = await make(UserRole.AUTHOR);
      const admin = await make(UserRole.SUPER_ADMIN);
      const recruiter = await make(UserRole.RECRUITER);
      const reviewer = await make(UserRole.REVIEWER);
      const foreign = await make(UserRole.AUTHOR, orgB);
      const id = await create(a);
      for (const who of [recruiter, reviewer]) {
        await http().post(`${API}/questions/${id}/validate`).set(who.auth).send({}).expect(403);
        await http().get(`${API}/questions/${id}/validation`).set(who.auth).expect(403);
      }
      await http().post(`${API}/questions/${id}/validate`).send({}).expect(401);
      await http().get(`${API}/questions/${id}/validation`).expect(401);
      for (const target of [id, GHOST]) {
        await http()
          .post(`${API}/questions/${target}/validate`)
          .set(foreign.auth)
          .send({})
          .expect(404);
        await http().get(`${API}/questions/${target}/validation`).set(foreign.auth).expect(404);
      }
      await http().post(`${API}/questions/not-a-uuid/validate`).set(a.auth).send({}).expect(400);
      expect(port.calls).toHaveLength(0);
      expect((await status(a, id)).status).toBe('NONE');
      await http().post(`${API}/questions/${id}/validate`).set(admin.auth).send({}).expect(202);
      await validation.whenIdle();
      // The admin's run is visible to the author of the same org.
      expect((await status(a, id)).status).toBe('PASSED');
    });
  });

  // ---- AI reference solutions -----------------------------------------------------------------

  describe('FR-203, ADR 0005 AI-1: a variant with AI reference rows is never deleted', () => {
    const delVariant = (who: Made, id: string, variantId: string): request.Test =>
      http().delete(`${API}/questions/${id}/versions/1/variants/${variantId}`).set(who.auth);
    const removedAudits = (id: string): Promise<number> =>
      owner.auditLog.count({ where: { entityId: id, action: 'QUESTION_VARIANT_REMOVED' } });
    const aiCount = (variantId: string): Promise<number> =>
      owner.aiReferenceSolution.count({ where: { variantId } });
    const settled = (p: Promise<unknown>): Promise<boolean> =>
      Promise.race([
        p.then(() => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), 600)),
      ]);

    async function held(id: string): Promise<Client> {
      const c = new Client({ connectionString: infra.postgres.getConnectionUri() });
      await c.connect();
      await c.query('BEGIN');
      await c.query('UPDATE questions SET is_archived = is_archived WHERE id = $1', [id]);
      return c;
    }

    it('FR-203, ADR 0005 AI-1: a variant with a current AI row is 409 (detail only), nothing is deleted, no audit row', async () => {
      const a = await make(UserRole.AUTHOR);
      const id = await create(a);
      const variantId = await addVariant(a, id, 1);
      await addAi(a, id, { variantId }).expect(201);
      const res = await delVariant(a, id, variantId);
      expect(res.status).toBe(409);
      expect(JSON.stringify(res.body)).toMatch(/AI reference/);
      expect((res.body as { code?: string }).code).toBe('VARIANT_HAS_AI_REFERENCES');
      expect(await owner.questionVariant.count({ where: { id: variantId } })).toBe(1);
      expect(await aiCount(variantId)).toBe(1);
      expect(await removedAudits(id)).toBe(0);
    });

    it('FR-203, ADR 0005 AI-1: a variant whose only AI row is superseded is also 409', async () => {
      const a = await make(UserRole.AUTHOR);
      const id = await create(a);
      const variantId = await addVariant(a, id, 2);
      const row = (await addAi(a, id, { variantId }).expect(201)).body as Json;
      await http()
        .post(`${API}/questions/${id}/versions/1/ai-references/${row.id as string}/supersede`)
        .set(a.auth)
        .send({})
        .expect(200);
      const res = await delVariant(a, id, variantId).expect(409);
      expect((res.body as { code?: string }).code).toBe('VARIANT_HAS_AI_REFERENCES');
      expect(await owner.questionVariant.count({ where: { id: variantId } })).toBe(1);
      expect(await aiCount(variantId)).toBe(1);
      expect(await removedAudits(id)).toBe(0);
    });

    it('FR-203: a variant without AI rows (a base-level row does not count) is still 200 with the new revision and audited', async () => {
      const a = await make(UserRole.AUTHOR);
      const id = await create(a);
      const variantId = await addVariant(a, id, 3);
      await addAi(a, id).expect(201);
      await delVariant(a, id, variantId).expect(200);
      expect(await owner.questionVariant.count({ where: { id: variantId } })).toBe(0);
      expect(
        await owner.aiReferenceSolution.count({ where: { questionVersion: { questionId: id } } }),
      ).toBe(1);
      expect(await removedAudits(id)).toBe(1);
    });

    it('FR-203, ADR 0005 AI-1: a delete racing an uncommitted AI insert waits on the variant lock, then ends 409 with variant and row intact', async () => {
      const a = await make(UserRole.AUTHOR);
      const id = await create(a);
      const variantId = await addVariant(a, id, 4);
      const ver = await owner.questionVersion.findFirstOrThrow({ where: { questionId: id } });
      const c = new Client({ connectionString: infra.postgres.getConnectionUri() });
      await c.connect();
      try {
        await c.query('BEGIN');
        // No question lock here on purpose: only the FK lock on the variant row protects it.
        await c.query(
          `INSERT INTO ai_reference_solutions (question_version_id, variant_id, assistant, model_label, language, solution_code, collected_at, collected_by)
           VALUES ($1, $2, 'ChatGPT', 'm', 'python', 'x', now(), $3)`,
          [ver.id, variantId, a.id],
        );
        const del = delVariant(a, id, variantId).then((r) => r);
        expect(await settled(del)).toBe(false);
        await c.query('COMMIT');
        const done = await del;
        expect(done.status).toBe(409);
        expect((done.body as { code?: string }).code).toBe('VARIANT_HAS_AI_REFERENCES');
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        await c.end();
      }
      expect(await owner.questionVariant.count({ where: { id: variantId } })).toBe(1);
      expect(await aiCount(variantId)).toBe(1);
      expect(await removedAudits(id)).toBe(0);
    });

    it('FR-203, ADR 0005 AI-1: an AI create racing a variant delete that holds the lock gets 404, never a 500, and no row survives without its variant', async () => {
      const a = await make(UserRole.AUTHOR);
      const id = await create(a);
      const variantId = await addVariant(a, id, 5);
      const c = await held(id);
      try {
        await c.query('DELETE FROM question_variants WHERE id = $1', [variantId]);
        const create$ = addAi(a, id, { variantId }).then((r) => r);
        expect(await settled(create$)).toBe(false);
        await c.query('COMMIT');
        expect((await create$).status).toBe(404);
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        await c.end();
      }
      expect(await aiCount(variantId)).toBe(0);
    });

    it('FR-203, ADR 0005 AI-1: concurrent create and delete end consistent over many rounds (never a created row with its variant gone)', async () => {
      const a = await make(UserRole.AUTHOR);
      for (let round = 0; round < 6; round++) {
        const id = await create(a);
        const variantId = await addVariant(a, id, 6);
        const [del, add] = await Promise.all([
          delVariant(a, id, variantId).then((r) => r),
          addAi(a, id, { variantId }).then((r) => r),
        ]);
        expect(`${del.status}/${add.status}`).toMatch(/^(200\/404|409\/201)$/);
        const variants = await owner.questionVariant.count({ where: { id: variantId } });
        expect(variants).toBe(add.status === 201 ? 1 : 0);
        expect(await aiCount(variantId)).toBe(add.status === 201 ? 1 : 0);
      }
    });
  });

  describe('FR-203, ADR 0005 AI-5: GET /questions/ai-policy', () => {
    const policy = (who: Made): request.Test =>
      http().get(`${API}/questions/ai-policy`).set(who.auth);

    it('FR-203: authors and admins read it; it is not taken for a question id (no 400 from ParseUUIDPipe)', async () => {
      const org = (await owner.organization.create({ data: { name: 'Policy org' } })).id;
      for (const role of [UserRole.AUTHOR, UserRole.SUPER_ADMIN]) {
        const who = await make(role, org);
        const res = await policy(who);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ minAssistants: 2, isDefault: true, refreshIntervalDays: null });
      }
    });

    it('FR-203, FR-103: recruiters and reviewers get 403, no token 401', async () => {
      for (const role of [UserRole.RECRUITER, UserRole.REVIEWER]) {
        expect((await policy(await make(role))).status).toBe(403);
      }
      await http().get(`${API}/questions/ai-policy`).expect(401);
    });

    it('FR-203, TC-008: a configured value is returned, isolated per org; an invalid value falls back to the default', async () => {
      const o1 = (await owner.organization.create({ data: { name: 'P1' } })).id;
      const o2 = (await owner.organization.create({ data: { name: 'P2' } })).id;
      await setGate(o1, 3);
      await setGate(o2, 0);
      const a1 = await make(UserRole.AUTHOR, o1);
      const a2 = await make(UserRole.AUTHOR, o2);
      expect((await policy(a1)).body).toMatchObject({ minAssistants: 3, isDefault: false });
      expect((await policy(a2)).body).toMatchObject({ minAssistants: 0, isDefault: false });
      const o3 = (await owner.organization.create({ data: { name: 'P3' } })).id;
      await setGate(o3, 99);
      expect((await policy(await make(UserRole.AUTHOR, o3))).body).toMatchObject({
        minAssistants: 2,
        isDefault: true,
      });
    });
  });

  describe('ADR 0005: AI reference solutions', () => {
    it('FR-202: create, list and supersede are append-only; rows keep their history', async () => {
      const a = await make(UserRole.AUTHOR);
      const id = await create(a);
      const first = await addAi(a, id).expect(201);
      expect(first.body).toMatchObject({
        assistant: 'ChatGPT',
        language: 'python',
        variantId: null,
        collectedById: a.id,
        supersededAt: null,
      });
      const rowId = (first.body as Json).id as string;
      const refreshed = await http()
        .post(`${API}/questions/${id}/versions/1/ai-references/${rowId}/supersede`)
        .set(a.auth)
        .send({ replacement: aiBody({ solutionCode: 'NEW-CODE' }) })
        .expect(200);
      const body = refreshed.body as Json;
      expect((body.superseded as Json).supersededAt).not.toBeNull();
      expect((body.replacement as Json).solutionCode).toBe('NEW-CODE');
      const list = await http()
        .get(`${API}/questions/${id}/versions/1/ai-references`)
        .set(a.auth)
        .expect(200);
      expect(((list.body as Json).items as Json[]).length).toBe(2);
      // The old row is still there, unchanged but for superseded_at (AI-1).
      const old = await owner.aiReferenceSolution.findUniqueOrThrow({ where: { id: rowId } });
      expect(old.solutionCode).toBe(AI_SECRET);
      expect(old.supersededAt).not.toBeNull();
      await http()
        .post(`${API}/questions/${id}/versions/1/ai-references/${rowId}/supersede`)
        .set(a.auth)
        .send({})
        .expect(409);
      // No update or delete route exists.
      await http()
        .patch(`${API}/questions/${id}/versions/1/ai-references/${rowId}`)
        .set(a.auth)
        .send({})
        .expect(404);
      await http()
        .delete(`${API}/questions/${id}/versions/1/ai-references/${rowId}`)
        .set(a.auth)
        .expect(404);
      expect(
        await owner.aiReferenceSolution.count({ where: { questionVersion: { questionId: id } } }),
      ).toBe(2);
    });

    it('FR-202: a retire without a replacement is allowed; validation of input (400, 422, 404)', async () => {
      const a = await make(UserRole.AUTHOR);
      const id = await create(a);
      const row = (await addAi(a, id).expect(201)).body as Json;
      await http()
        .post(`${API}/questions/${id}/versions/1/ai-references/${row.id as string}/supersede`)
        .set(a.auth)
        .send({})
        .expect(200);
      await addAi(a, id, { language: 'ruby' }).expect(400);
      await addAi(a, id, { solutionCode: '   ' }).expect(400);
      await addAi(a, id, { assistant: '' }).expect(400);
      await addAi(a, id, { extra: 1 }).expect(400);
      await addAi(a, id, { language: 'java' }).expect(422); // not an allowed language of the version
      await addAi(a, id, { variantId: GHOST }).expect(404);
      await addAi(a, id, {}, 9).expect(404);
      const mcq = await create(a, {
        type: 'SHORT_ANSWER',
        title: 'S',
        statementMd: 'S',
        difficulty: 'EASY',
        answerSpec: { canonical: 'x', acceptedVariants: [] },
      });
      await addAi(a, mcq).expect(422);
      const other = await create(a);
      const foreignRow = (await addAi(a, other).expect(201)).body as Json;
      await http()
        .post(
          `${API}/questions/${id}/versions/1/ai-references/${foreignRow.id as string}/supersede`,
        )
        .set(a.auth)
        .send({})
        .expect(404);
    });

    it('AI-1: the permissions matrix (author and super admin yes; recruiter, reviewer, anonymous no; other org 404)', async () => {
      const a = await make(UserRole.AUTHOR);
      const admin = await make(UserRole.SUPER_ADMIN);
      const recruiter = await make(UserRole.RECRUITER);
      const reviewer = await make(UserRole.REVIEWER);
      const foreign = await make(UserRole.AUTHOR, orgB);
      const id = await create(a);
      const row = (await addAi(admin, id).expect(201)).body as Json;
      const base = `${API}/questions/${id}/versions/1/ai-references`;
      for (const who of [recruiter, reviewer]) {
        await http().get(base).set(who.auth).expect(403);
        await http().post(base).set(who.auth).send(aiBody()).expect(403);
        await http()
          .post(`${base}/${row.id as string}/supersede`)
          .set(who.auth)
          .send({})
          .expect(403);
      }
      await http().get(base).expect(401);
      await http().post(base).send(aiBody()).expect(401);
      await http().get(base).set(foreign.auth).expect(404);
      await http().post(base).set(foreign.auth).send(aiBody()).expect(404);
      await http()
        .post(`${base}/${row.id as string}/supersede`)
        .set(foreign.auth)
        .send({})
        .expect(404);
      await http()
        .get(`${API}/questions/${GHOST}/versions/1/ai-references`)
        .set(a.auth)
        .expect(404);
      await http().get(base).set(a.auth).expect(200);
      expect(
        await owner.aiReferenceSolution.count({ where: { questionVersion: { questionId: id } } }),
      ).toBe(1);
    });

    it('AI-6: create and supersede are audited in the same transaction, ids only', async () => {
      const a = await make(UserRole.AUTHOR);
      const id = await create(a);
      const row = (await addAi(a, id).expect(201)).body as Json;
      await http()
        .post(`${API}/questions/${id}/versions/1/ai-references/${row.id as string}/supersede`)
        .set(a.auth)
        .send({ replacement: aiBody({ assistant: 'Claude' }) })
        .expect(200);
      const rows = await owner.auditLog.findMany({
        where: { entityId: id, action: { startsWith: 'AI_REFERENCE_' } },
        orderBy: { createdAt: 'asc' },
      });
      expect(rows.map((r) => r.action)).toEqual([
        'AI_REFERENCE_CREATED',
        'AI_REFERENCE_CREATED',
        'AI_REFERENCE_SUPERSEDED',
      ]);
      expect(Object.keys(rows[2]?.metadata as Json).sort()).toEqual([
        'aiReferenceId',
        'replacementId',
        'version',
      ]);
      expect(
        JSON.stringify(rows, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
      ).not.toMatch(/QA-AI|ChatGPT|Claude|gpt-x/);
    });

    it('AI-5: publish needs current rows from minAssistants distinct assistants per allowed language', async () => {
      await setGate(orgB, 2);
      const a = await make(UserRole.AUTHOR, orgB);
      const id = await create(
        a,
        codingBody({
          allowedLanguages: ['python', 'javascript'],
          starterCode: {},
          referenceSolution: { python: 'p', javascript: 'j' },
        }),
      );
      await validate(a, id);
      expect((await status(a, id)).status).toBe('PASSED');
      let res = await publish(a, id).expect(422);
      expect(JSON.stringify(res.body)).toContain('aiReferences.python');
      expect(JSON.stringify(res.body)).toContain('aiReferences.javascript');
      const p1 = (await addAi(a, id, { assistant: 'ChatGPT' }).expect(201)).body as Json;
      await addAi(a, id, { assistant: 'chatgpt ' }).expect(201); // same assistant, no second
      await addAi(a, id, { assistant: 'Claude' }).expect(201);
      await addAi(a, id, { assistant: 'ChatGPT', language: 'javascript' }).expect(201);
      res = await publish(a, id).expect(422);
      expect(JSON.stringify(res.body)).not.toContain('aiReferences.python');
      expect(JSON.stringify(res.body)).toContain('aiReferences.javascript');
      await addAi(a, id, { assistant: 'Claude', language: 'javascript' }).expect(201);
      // A superseded row no longer counts.
      await http()
        .post(`${API}/questions/${id}/versions/1/ai-references/${p1.id as string}/supersede`)
        .set(a.auth)
        .send({})
        .expect(200);
      await publish(a, id).expect(200);
    });

    it('AI-5: superseding drops a language below the minimum; minAssistants 0 turns the gate off; malformed settings use 2', async () => {
      await setGate(orgB, 1);
      const a = await make(UserRole.AUTHOR, orgB);
      const id = await create(a);
      await validate(a, id);
      await publish(a, id).expect(422);
      const row = (await addAi(a, id).expect(201)).body as Json;
      await http()
        .post(`${API}/questions/${id}/versions/1/ai-references/${row.id as string}/supersede`)
        .set(a.auth)
        .send({})
        .expect(200);
      await publish(a, id).expect(422);
      await owner.organization.update({
        where: { id: orgB },
        data: { settings: { aiReferences: { minAssistants: 'many' } } },
      });
      await addAi(a, id).expect(201);
      await publish(a, id).expect(422); // default 2, one assistant
      await setGate(orgB, 0);
      await publish(a, id).expect(200);
    });

    it('AI-5: a coding question is gated, an MCQ is not', async () => {
      await setGate(orgB, 2);
      const a = await make(UserRole.AUTHOR, orgB);
      const sa = await create(a, {
        type: 'SHORT_ANSWER',
        title: 'S',
        statementMd: 'S',
        difficulty: 'EASY',
        answerSpec: { canonical: 'x', acceptedVariants: [] },
      });
      await publish(a, sa).expect(200);
    });
  });

  // ---- staff views ----------------------------------------------------------------------------

  describe('TC-011, FR-103: recruiters and candidates never see reference solutions, AI references or the report', () => {
    it('TC-011: planted secrets stay out of every recruiter response and the report out of the author list', async () => {
      const a = await make(UserRole.AUTHOR);
      const recruiter = await make(UserRole.RECRUITER);
      const id = await create(a);
      await addAi(a, id).expect(201);
      await addAi(a, id, { assistant: 'Claude' }).expect(201);
      await validate(a, id);
      await publish(a, id).expect(200);
      const bodies: string[] = [];
      for (const path of [
        `/questions/${id}`,
        `/questions/${id}?version=1`,
        `/questions/${id}/preview`,
        '/questions?pageSize=50',
        '/questions?includeArchived=true',
      ]) {
        const res = await http().get(`${API}${path}`).set(recruiter.auth).expect(200);
        bodies.push(JSON.stringify(res.body));
      }
      for (const path of [
        `/questions/${id}/validation`,
        `/questions/${id}/versions/1/ai-references`,
        `/questions/${id}/versions/1/variants`,
      ]) {
        await http().get(`${API}${path}`).set(recruiter.auth).expect(403);
      }
      const all = bodies.join('\n');
      for (const secret of [AI_SECRET, AI_PROMPT, 'REFERENCE-SECRET', HIDDEN_IN, HIDDEN_OUT]) {
        expect(all).not.toContain(secret);
      }
      expect(all).not.toMatch(
        /validationReport|perVariant|aiReference|referenceSolution|revision/i,
      );
      // The author does see them.
      const full = await http().get(`${API}/questions/${id}`).set(a.auth).expect(200);
      expect(JSON.stringify(full.body)).toContain('REFERENCE-SECRET');
      expect(JSON.stringify(full.body)).not.toContain(AI_SECRET);
    });
  });
});
