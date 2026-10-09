// BE-11 end to end: run, draft, submit, finish, section close, auto-submit and grade-session over HTTP
// against real Postgres 16 (app_user, real grants and migrations) and real Redis (Testcontainers).
// Judge0 is a fake that "runs" source markers; everything else is the real app.
// Covers FR-502, FR-504, FR-505, FR-506, FR-205 and TC-040, TC-041, TC-045, TC-046, TC-048, TC-099,
// ADR 0002 S-5, ADR 0013 sections 5.10 and 5.11, DL-17.
import { INestApplication } from '@nestjs/common';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types';
import { createInvitation, createTenant } from '../candidate/testing/fixtures';
import type { InvitationFixture, Tenant } from '../candidate/testing/fixtures';
import { createPrismaClient } from '../database/create-prisma-client';
import { startMigratedDatabase } from '../database/testing/migrated-postgres';
import type { MigratedDatabase } from '../database/testing/migrated-postgres';
import type { PrismaClient } from '../generated/prisma/client.js';
import type { Judge0Client, Judge0RawResult, Judge0Submission } from '../judge0/judge0.types';
import type { CandidateTokenService } from '../candidate/candidate-token.service';
import type { CloseSectionService } from '../grading/close-section.service';
import type { GradeSessionService } from '../grading/grade-session.service';
import type { GradingWorker } from '../grading/grading-worker';
import type { ManualScoringService } from '../grading/manual-scoring.service';
import type { ExecutionService } from '../execution/execution.service';
import type { GradingQueue } from '../grading/grading-queue';
import type { SubmitFlowService } from '../grading/submit-flow.service';

const API = '/api/v1/candidate';
const FINISH_PATH = '/session/section/finish';
const FINISH = FINISH_PATH;
const SECRET_MARKER = 'SECRET-SOURCE-MARKER';

/** "PASS:h1,h3" passes the tests whose stdin is listed (stdout = stdin); others print WRONG. */
class FakeJudge0 implements Judge0Client {
  readonly calls: Judge0Submission[][] = [];
  down = false;
  /** Runs inside the next runBatch (a save landing while grading runs). */
  onRun: (() => Promise<void>) | undefined;
  async runBatch(submissions: readonly Judge0Submission[]): Promise<Judge0RawResult[]> {
    if (this.down) throw new Error('judge0 down');
    this.calls.push([...submissions]);
    const hook = this.onRun;
    this.onRun = undefined;
    if (hook) await hook();
    return submissions.map((s) => {
      const head = s.sourceCode.split(/\s/)[0] ?? '';
      const passes = head.startsWith('PASS:') ? head.slice(5).split(',') : [];
      const ok = head === 'ECHO' || passes.includes(s.stdin);
      return {
        statusId: 3,
        stdout: ok ? s.stdin : 'WRONG',
        stderr: null,
        compileOutput: null,
        message: null,
        timeMs: 12,
        wallTimeMs: 20,
        memoryKb: 2048,
        exitCode: 0,
      };
    });
  }
}

// The app's own copy of Nest (jest.resetModules ran before it was built), not this file's import.
const appLogger = (): typeof import('@nestjs/common').Logger =>
  jest.requireActual<typeof import('@nestjs/common')>('@nestjs/common').Logger;

async function eventually<T>(
  read: () => Promise<T>,
  done: (v: T) => boolean,
  ms = 30_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await new Promise((r) => setTimeout(r, 200));
  }
}

interface World {
  readonly tenant: Tenant;
  readonly testId: string;
  readonly sectionIds: readonly [string, string];
  readonly testQuestionIds: readonly [string, string, string, string];
  readonly versionIds: readonly [string, string, string, string];
  readonly variantId: string;
}

interface Live {
  readonly inv: InvitationFixture;
  readonly token: string;
  readonly q: { code: string; mcq: string; short: string; code2: string };
}

describe('Run, draft, submit, finish and grading (FR-502, FR-504..FR-506, FR-205, ADR 0013 5.11)', () => {
  let db: MigratedDatabase;
  let redisBox: StartedRedisContainer;
  let owner: PrismaClient;
  let redis: Redis;
  let app: INestApplication<App>;
  let tokens: CandidateTokenService;
  let closeSection: CloseSectionService;
  let grading: GradeSessionService;
  let worker: GradingWorker;
  let manual: ManualScoringService;
  let flow: SubmitFlowService;
  let queue: GradingQueue;
  let execution: ExecutionService;
  let main: World;
  let foreign: World;
  const judge = new FakeJudge0();
  const logged: string[] = [];
  let stdout: jest.SpyInstance;

  async function buildApp(): Promise<INestApplication<App>> {
    Object.assign(process.env, {
      NODE_ENV: 'test',
      APP_ENV: 'test',
      LOG_LEVEL: 'info',
      WEB_ORIGIN: 'http://localhost:3000',
      DATABASE_URL: db.appUserUrl,
      REDIS_URL: redisBox.getConnectionUrl(),
      HEALTH_TIMEOUT_MS: '1500',
      JWT_ACCESS_SECRET: randomBytes(32).toString('base64'),
      COOKIE_SECRET: randomBytes(32).toString('base64'),
      ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      JWT_CANDIDATE_SECRET: randomBytes(32).toString('base64'),
      OTP_PEPPER: randomBytes(32).toString('base64'),
      SESSION_KEY_ENC_ACTIVE_KID: 'k1',
      SESSION_KEY_ENC_KEY_k1: randomBytes(32).toString('base64'),
      CANDIDATE_TOKEN_TTL_SECONDS: '900',
      THROTTLE_DEFAULT_LIMIT: '100000',
      THROTTLE_AUTH_LIMIT: '100000',
      THROTTLE_CANDIDATE_LIMIT: '100000',
      REQUIRE_LEGAL_APPROVED_CONSENT: 'false',
    });
    jest.resetModules();
    const { AppModule } = jest.requireActual<typeof import('../app.module')>('../app.module');
    const { Test } = jest.requireActual<typeof import('@nestjs/testing')>('@nestjs/testing');
    const { configureApp } = jest.requireActual<typeof import('../bootstrap')>('../bootstrap');
    const types =
      jest.requireActual<typeof import('../judge0/judge0.types')>('../judge0/judge0.types');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(types.JUDGE0_CLIENT)
      .useValue(judge)
      .compile();
    const created = moduleRef.createNestApplication<INestApplication<App>>();
    configureApp(created);
    await created.init();
    return created;
  }

  async function buildWorld(tenant: Tenant): Promise<World> {
    const org = tenant.orgId;
    async function question(
      slug: string,
      type: 'CODING' | 'MCQ' | 'SHORT_ANSWER',
      answerSpec: object | null,
    ): Promise<string> {
      const q = await owner.question.create({
        data: { orgId: org, slug: `${slug}-${tenant.label}`, type },
      });
      const v = await owner.questionVersion.create({
        data: {
          questionId: q.id,
          version: 1,
          title: slug,
          statementMd: 'statement',
          difficulty: 'EASY',
          allowedLanguages: type === 'CODING' ? ['python'] : [],
          isPublished: true,
          ...(answerSpec === null ? {} : { answerSpec }),
        },
      });
      await owner.question.update({ where: { id: q.id }, data: { currentVersionId: v.id } });
      return v.id;
    }
    async function cases(versionId: string, hidden: Array<[string, number]>): Promise<string[]> {
      const ids: string[] = [];
      const sample = await owner.testCase.create({
        data: {
          questionVersionId: versionId,
          input: 's1',
          expectedOutput: 's1',
          isHidden: false,
          position: 0,
        },
      });
      ids.push(sample.id);
      let position = 1;
      for (const [input, weight] of hidden) {
        const c = await owner.testCase.create({
          data: {
            questionVersionId: versionId,
            input,
            expectedOutput: input,
            isHidden: true,
            weight,
            position: position++,
          },
        });
        ids.push(c.id);
      }
      return ids;
    }
    const code = await question('code', 'CODING', null);
    const caseIds = await cases(code, [
      ['h1', 1],
      ['h2', 1],
      ['h3', 2],
      ['h4', 2],
      ['h5', 4],
    ]);
    const mcq = await question('mcq', 'MCQ', {
      options: [
        { id: 'a', text: 'A' },
        { id: 'b', text: 'B' },
      ],
      correctOptionIds: ['b'],
      multiple: false,
    });
    const short = await question('short', 'SHORT_ANSWER', {
      canonical: 'Photosynthesis',
      acceptedVariants: ['the process of photosynthesis'],
    });
    const code2 = await question('code2', 'CODING', null);
    await cases(code2, [['k1', 1]]);

    // A variant of the first coding question with its own sample data (ADR 0007).
    const variant = await owner.questionVariant.create({
      data: { questionVersionId: code, params: { n: 1 }, renderedStatement: 'variant' },
    });
    await owner.variantTestCase.create({
      data: {
        variantId: variant.id,
        testCaseId: caseIds[0] as string,
        input: 'vs1',
        expectedOutput: 'vs1',
      },
    });

    const test = await owner.test.create({
      data: { orgId: org, name: `BE-11 ${tenant.label}`, durationMinutes: 60 },
    });
    const s1 = await owner.testSection.create({
      data: { testId: test.id, title: 'One', position: 1, timeLimitMin: 20 },
    });
    const s2 = await owner.testSection.create({
      data: { testId: test.id, title: 'Two', position: 2, timeLimitMin: null },
    });
    const tq = async (sectionId: string, versionId: string, points: number, position: number) =>
      (
        await owner.testQuestion.create({
          data: { sectionId, questionVersionId: versionId, points, position },
        })
      ).id;
    return {
      tenant,
      testId: test.id,
      sectionIds: [s1.id, s2.id],
      testQuestionIds: [
        await tq(s1.id, code, 100, 1),
        await tq(s1.id, mcq, 10, 2),
        await tq(s1.id, short, 10, 3),
        await tq(s2.id, code2, 50, 1),
      ],
      versionIds: [code, mcq, short, code2],
      variantId: variant.id,
    };
  }

  interface LiveOptions {
    status?: 'IN_PROGRESS' | 'PAUSED';
    pause?: Array<'FULLSCREEN_EXIT' | 'SCREEN_SHARE_STOPPED' | 'SIDE_CAMERA_LOST' | 'PROCTOR'>;
    sessionDeadlineInMs?: number;
    sectionDeadlineInMs?: number;
    world?: World;
  }

  async function live(options: LiveOptions = {}): Promise<Live> {
    const w = options.world ?? main;
    const now = Date.now();
    const inv = await createInvitation(owner, w.tenant, {
      testId: w.testId,
      status: options.status ?? 'IN_PROGRESS',
      session: {
        startedAt: new Date(now - 10 * 60_000),
        deadlineAt: new Date(now + (options.sessionDeadlineInMs ?? 50 * 60_000)),
        lastHeartbeat: new Date(),
        authEpoch: 1,
        ...(options.pause !== undefined ? { pauseReasons: options.pause } : {}),
      },
    });
    await owner.sessionSection.createMany({
      data: [
        {
          sessionId: inv.sessionId,
          sectionId: w.sectionIds[0],
          position: 1,
          timeLimitMs: 20n * 60_000n,
          startedAt: new Date(now - 10 * 60_000),
          deadlineAt: new Date(now + (options.sectionDeadlineInMs ?? 10 * 60_000)),
        },
        { sessionId: inv.sessionId, sectionId: w.sectionIds[1], position: 2 },
      ],
    });
    const ids: string[] = [];
    for (const [i, tqId] of w.testQuestionIds.entries()) {
      const row = await owner.sessionQuestion.create({
        data: {
          sessionId: inv.sessionId,
          testQuestionId: tqId,
          questionVersionId: w.versionIds[i] as string,
          variantId: i === 0 ? w.variantId : null,
          position: i + 1,
          points: [100, 10, 10, 50][i] as number,
        },
      });
      ids.push(row.id);
    }
    return {
      inv,
      token: tokens.sign({ sid: inv.sessionId, oid: w.tenant.orgId, epoch: 1 }).token,
      q: {
        code: ids[0] as string,
        mcq: ids[1] as string,
        short: ids[2] as string,
        code2: ids[3] as string,
      },
    };
  }

  const call = (
    method: 'post' | 'put',
    path: string,
    token: string | null,
    body: object = {},
  ): request.Test => {
    const req = request(app.getHttpServer())[method](`${API}${path}`);
    if (token !== null) req.set('Authorization', `Bearer ${token}`);
    return req.send(body);
  };
  const sessionRow = (id: string) => owner.session.findUniqueOrThrow({ where: { id } });
  const questionRow = (id: string) => owner.sessionQuestion.findUniqueOrThrow({ where: { id } });
  const clearLimits = async (sid: string): Promise<void> => {
    const keys = await redis.keys(`*${sid}*`);
    if (keys.length > 0) await redis.del(...keys);
  };

  beforeAll(async () => {
    stdout = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      logged.push(String(chunk));
      return true;
    });
    [db, redisBox] = await Promise.all([
      startMigratedDatabase(),
      new RedisContainer('redis:8.8').start(),
    ]);
    owner = createPrismaClient(db.ownerUrl);
    redis = new Redis(redisBox.getConnectionUrl());
    const tenant = await createTenant(owner, 'main');
    const other = await createTenant(owner, 'foreign');
    main = await buildWorld(tenant);
    foreign = await buildWorld(other);
    app = await buildApp();
    const actual = <T extends object>(path: string): T => jest.requireActual<T>(path);
    tokens = app.get(
      actual<typeof import('../candidate/candidate-token.service')>(
        '../candidate/candidate-token.service',
      ).CandidateTokenService,
    );
    closeSection = app.get(
      actual<typeof import('../grading/close-section.service')>('../grading/close-section.service')
        .CloseSectionService,
    );
    grading = app.get(
      actual<typeof import('../grading/grade-session.service')>('../grading/grade-session.service')
        .GradeSessionService,
    );
    worker = app.get(
      actual<typeof import('../grading/grading-worker')>('../grading/grading-worker').GradingWorker,
    );
    execution = app.get(
      actual<typeof import('../execution/execution.service')>('../execution/execution.service')
        .ExecutionService,
    );
    queue = app.get(
      actual<typeof import('../grading/grading-queue')>('../grading/grading-queue').GradingQueue,
    );
    flow = app.get(
      actual<typeof import('../grading/submit-flow.service')>('../grading/submit-flow.service')
        .SubmitFlowService,
    );
    manual = app.get(
      actual<typeof import('../grading/manual-scoring.service')>(
        '../grading/manual-scoring.service',
      ).ManualScoringService,
    );
  }, 240_000);

  afterAll(async () => {
    stdout.mockRestore();
    await app?.close();
    redis?.disconnect();
    await owner?.$disconnect();
    await redisBox?.stop();
    await db?.stop();
  });

  beforeEach(() => {
    judge.calls.length = 0;
    judge.down = false;
  });

  // ---------- Run (FR-502) ----------

  describe('POST /candidate/answers/:questionId/run (FR-502, TC-040, TC-041)', () => {
    it('TC-040: Run executes only the variant sample, returns its result, stores a RUN row and autosaves the code', async () => {
      const s = await live();
      const res = await call('post', `/answers/${s.q.code}/run`, s.token, {
        code: `ECHO # ${SECRET_MARKER}`,
        language: 'python',
      }).expect(200);
      const body = res.body as {
        passed: number;
        total: number;
        results: Array<Record<string, unknown>>;
      };
      expect(body).toMatchObject({ passed: 1, total: 1 });
      expect(body.results[0]).toMatchObject({
        index: 1,
        verdict: 'PASSED',
        passed: true,
        stdout: 'vs1',
      });
      // The variant's own sample data ran, and nothing hidden did.
      expect(judge.calls).toHaveLength(1);
      expect(judge.calls[0]?.map((c) => c.stdin)).toEqual(['vs1']);
      expect(JSON.stringify(res.body)).not.toMatch(/h[1-5]|WRONG/);
      const rows = await owner.submission.findMany({ where: { sessionQuestionId: s.q.code } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: 'RUN', language: 'python', passed: 1, total: 1 });
      const stored = rows[0]?.results as Array<Record<string, unknown>>;
      expect(Object.keys(stored[0] as object).sort()).toEqual(
        ['memoryKb', 'passed', 'status', 'testCaseId', 'timeMs'].sort(),
      );
      // FR-504: Run autosaves.
      expect((await questionRow(s.q.code)).finalCode).toContain(SECRET_MARKER);
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('TC-041: three Runs within two seconds execute once; the others are 429 RATE_LIMITED with Retry-After', async () => {
      const s = await live();
      const send = (): request.Test =>
        call('post', `/answers/${s.q.code}/run`, s.token, { code: 'ECHO', language: 'python' });
      const first = await send();
      const second = await send();
      const third = await send();
      expect([first.status, second.status, third.status]).toEqual([200, 429, 429]);
      expect(second.body).toMatchObject({ code: 'RATE_LIMITED' });
      expect(Number(second.headers['retry-after'])).toBeGreaterThan(0);
      expect(judge.calls).toHaveLength(1);
      expect(await owner.submission.count({ where: { sessionQuestionId: s.q.code } })).toBe(1);
    });

    it('FR-502: a runner failure is reported as INTERNAL_ERROR, not as a wrong answer', async () => {
      const s = await live();
      judge.down = true;
      const res = await call('post', `/answers/${s.q.code}/run`, s.token, {
        code: 'ECHO',
        language: 'python',
      }).expect(200);
      expect((res.body as { results: Array<{ verdict: string }> }).results[0]?.verdict).toBe(
        'INTERNAL_ERROR',
      );
    });

    it('FR-502: a language the question does not allow, empty code, and extra body fields are 400', async () => {
      const s = await live();
      await call('post', `/answers/${s.q.code}/run`, s.token, {
        code: 'x',
        language: 'java',
      }).expect(400);
      await clearLimits(s.inv.sessionId);
      await call('post', `/answers/${s.q.code}/run`, s.token, {
        code: '',
        language: 'python',
      }).expect(400);
      await call('post', `/answers/${s.q.code}/run`, s.token, {
        code: 'x',
        language: 'python',
        sessionId: s.inv.sessionId,
      }).expect(400);
      // A question that takes no code.
      await clearLimits(s.inv.sessionId);
      await call('post', `/answers/${s.q.mcq}/run`, s.token, {
        code: 'x',
        language: 'python',
      }).expect(400);
    });
  });

  // ---------- Draft (FR-504) ----------

  describe('PUT /candidate/answers/:questionId/draft (FR-504, TC-045)', () => {
    it('TC-045: a draft saves code and language, and a reload reads back the last save', async () => {
      const s = await live();
      const res = await call('put', `/answers/${s.q.code}/draft`, s.token, {
        code: 'print(1)',
        language: 'python',
      }).expect(200);
      expect(typeof (res.body as { savedAt: string }).savedAt).toBe('string');
      await call('put', `/answers/${s.q.code}/draft`, s.token, {
        code: 'print(2)',
        language: 'python',
      }).expect(200);
      const row = await questionRow(s.q.code);
      expect(row).toMatchObject({ finalCode: 'print(2)', finalLanguage: 'python' });
      // A draft is not a Run: no submission row, no runner call.
      expect(await owner.submission.count({ where: { sessionQuestionId: s.q.code } })).toBe(0);
      expect(judge.calls).toHaveLength(0);
    });

    it('FR-504, FR-205: MCQ ids and short answer text are saved per type and checked against it', async () => {
      const s = await live();
      await call('put', `/answers/${s.q.mcq}/draft`, s.token, {
        answer: { optionIds: ['b'] },
      }).expect(200);
      expect((await questionRow(s.q.mcq)).answer).toEqual({ optionIds: ['b'] });
      await call('put', `/answers/${s.q.mcq}/draft`, s.token, {
        answer: { optionIds: ['zzz'] },
      }).expect(400);
      await call('put', `/answers/${s.q.mcq}/draft`, s.token, {
        answer: { optionIds: ['a', 'b'] },
      }).expect(400);
      await call('put', `/answers/${s.q.mcq}/draft`, s.token, {
        code: 'x',
        language: 'python',
      }).expect(400);
      await call('put', `/answers/${s.q.short}/draft`, s.token, {
        answer: { text: 'Photosynthesis' },
      }).expect(200);
      expect((await questionRow(s.q.short)).answer).toEqual({ text: 'Photosynthesis' });
      await call('put', `/answers/${s.q.short}/draft`, s.token, {
        answer: { optionIds: ['a'] },
      }).expect(400);
      await call('put', `/answers/${s.q.code}/draft`, s.token, { answer: { text: 'x' } }).expect(
        400,
      );
    });

    it('FR-504: a NUL byte in code is a 400, never a database error', async () => {
      const s = await live();
      await call('put', `/answers/${s.q.code}/draft`, s.token, {
        code: 'a\u0000b',
        language: 'python',
      }).expect(400);
    });
  });

  // ---------- Submit (FR-506) ----------

  describe('POST /candidate/answers/:questionId/submit (FR-506)', () => {
    it('FR-506: Submit returns only { accepted, submissionId }, stores a SUBMIT row and the saved code', async () => {
      const s = await live();
      const res = await call('post', `/answers/${s.q.code}/submit`, s.token, {
        code: 'PASS:h1',
        language: 'python',
      }).expect(200);
      expect(Object.keys(res.body as object).sort()).toEqual(['accepted', 'submissionId']);
      expect(res.body).toMatchObject({ accepted: true });
      const row = await owner.submission.findUniqueOrThrow({
        where: { id: (res.body as { submissionId: string }).submissionId },
      });
      expect(row).toMatchObject({ kind: 'SUBMIT', language: 'python', sourceCode: 'PASS:h1' });
      expect(await questionRow(s.q.code)).toMatchObject({ finalCode: 'PASS:h1' });
      // Nothing ran: grading is later.
      expect(judge.calls).toHaveLength(0);
    });

    it('FR-506: a second submit inside 10 s is 429; past 20 per question it is 409 SUBMIT_LIMIT_REACHED and the count is given back', async () => {
      const s = await live();
      const send = (): request.Test =>
        call('post', `/answers/${s.q.code}/submit`, s.token, { code: 'x', language: 'python' });
      await send().expect(200);
      const again = await send();
      expect(again.status).toBe(429);
      expect(again.body).toMatchObject({ code: 'RATE_LIMITED' });
      expect(Number(again.headers['retry-after'])).toBeGreaterThan(0);
      await redis.del(`rl:submit:${s.inv.sessionId}`);
      const counter = `submits:${s.inv.sessionId}:${s.q.code}`;
      await redis.set(counter, '20');
      const over = await send();
      expect(over.status).toBe(409);
      expect(over.body).toMatchObject({ code: 'SUBMIT_LIMIT_REACHED' });
      expect(await redis.get(counter)).toBe('20');
    });

    it('FR-506: a question that takes no code is refused', async () => {
      const s = await live();
      await call('post', `/answers/${s.q.short}/submit`, s.token, {
        code: 'x',
        language: 'python',
      }).expect(400);
    });
  });

  // ---------- Gate: open section, pause, scope ----------

  describe('open section, pause and session scope (ADR 0002 S-5, DL-17, ADR 0013 CS-2)', () => {
    it('S-5: a question of a section that has not opened is 409 SECTION_NOT_OPEN on run, draft and submit', async () => {
      const s = await live();
      const body = { code: 'ECHO', language: 'python' };
      for (const [method, path] of [
        ['post', `/answers/${s.q.code2}/run`],
        ['put', `/answers/${s.q.code2}/draft`],
        ['post', `/answers/${s.q.code2}/submit`],
      ] as const) {
        const res = await call(method, path, s.token, body);
        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({ code: 'SECTION_NOT_OPEN' });
      }
      expect(judge.calls).toHaveLength(0);
    });

    it('S-5, FR-505: on server time a question is refused after its section deadline even before the close job ran', async () => {
      const s = await live({ sectionDeadlineInMs: -1_000 });
      const res = await call('put', `/answers/${s.q.code}/draft`, s.token, {
        code: 'x',
        language: 'python',
      });
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'SECTION_NOT_OPEN' });
      const past = await live({ sessionDeadlineInMs: -1_000 });
      const late = await call('put', `/answers/${past.q.code}/draft`, past.token, {
        code: 'x',
        language: 'python',
      });
      expect(late.status).toBe(409);
      expect(late.body).toMatchObject({ code: 'SECTION_NOT_OPEN' });
    });

    it('DL-17: SCREEN_SHARE_STOPPED (and PROCTOR) pauses refuse every write with 409 SESSION_PAUSED; FULLSCREEN_EXIT does not', async () => {
      for (const reason of ['SCREEN_SHARE_STOPPED', 'SIDE_CAMERA_LOST', 'PROCTOR'] as const) {
        const s = await live({ status: 'PAUSED', pause: [reason] });
        for (const [method, path] of [
          ['post', `/answers/${s.q.code}/run`],
          ['put', `/answers/${s.q.code}/draft`],
          ['post', `/answers/${s.q.code}/submit`],
        ] as const) {
          const res = await call(method, path, s.token, { code: 'x', language: 'python' });
          expect(res.status).toBe(409);
          expect(res.body).toMatchObject({ code: 'SESSION_PAUSED' });
        }
        expect((await questionRow(s.q.code)).finalCode).toBeNull();
      }
      const fs = await live({ status: 'PAUSED', pause: ['FULLSCREEN_EXIT'] });
      await call('put', `/answers/${fs.q.code}/draft`, fs.token, {
        code: 'x',
        language: 'python',
      }).expect(200);
    });

    it('CS-2, TC-008: another session, another org and a malformed id are 404 or 400, never a read or write', async () => {
      const a = await live();
      const b = await live();
      const other = await live({ world: foreign });
      for (const id of [b.q.code, other.q.code]) {
        await clearLimits(a.inv.sessionId);
        await call('post', `/answers/${id}/run`, a.token, {
          code: 'ECHO',
          language: 'python',
        }).expect(404);
        await call('put', `/answers/${id}/draft`, a.token, {
          code: 'x',
          language: 'python',
        }).expect(404);
        await call('post', `/answers/${id}/submit`, a.token, {
          code: 'x',
          language: 'python',
        }).expect(404);
      }
      expect((await questionRow(b.q.code)).finalCode).toBeNull();
      expect((await questionRow(other.q.code)).finalCode).toBeNull();
      await call('put', '/answers/not-a-uuid/draft', a.token, {
        code: 'x',
        language: 'python',
      }).expect(400);
      expect(judge.calls).toHaveLength(0);
    });

    it('FR-103: no token and a bad token are 401 on every route of this step', async () => {
      const s = await live();
      for (const [method, path] of [
        ['post', `/answers/${s.q.code}/run`],
        ['put', `/answers/${s.q.code}/draft`],
        ['post', `/answers/${s.q.code}/submit`],
        ['post', '/session/finish'],
      ] as const) {
        await call(method, path, null, {}).expect(401);
        await call(method, path, 'garbage', {}).expect(401);
      }
    });
  });

  // ---------- Finish, grade (FR-505, FR-506, TC-048) ----------

  describe('finish and grade-session (FR-505, FR-506, FR-205, TC-048, TC-099)', () => {
    it('TC-048: hidden weights 1, 1, 2, 2, 4 with 1, 2 and 4 passing score 70.00; MCQ and short answer score; total is the sum', async () => {
      const s = await live();
      await call('put', `/answers/${s.q.code}/draft`, s.token, {
        code: `PASS:h1,h3,h5 # ${SECRET_MARKER}`,
        language: 'python',
      }).expect(200);
      await call('put', `/answers/${s.q.mcq}/draft`, s.token, {
        answer: { optionIds: ['b'] },
      }).expect(200);
      await call('put', `/answers/${s.q.short}/draft`, s.token, {
        answer: { text: '  PHOTOSYNTHESIS ' },
      }).expect(200);
      const fin = await call('post', '/session/finish', s.token).expect(200);
      expect(Object.keys(fin.body as object).sort()).toEqual(['serverTime', 'status']);
      expect(fin.body).toMatchObject({ status: 'SUBMITTED' });
      expect((await sessionRow(s.inv.sessionId)).submittedAt).not.toBeNull();
      // Writes are refused once submitted.
      await call('put', `/answers/${s.q.code}/draft`, s.token, {
        code: 'y',
        language: 'python',
      }).expect(409);

      expect(await grading.grade(main.tenant.orgId, s.inv.sessionId)).toBe('graded');
      const code = await questionRow(s.q.code);
      expect(code.score?.toFixed(2)).toBe('70.00');
      expect(code.scoring).toBe('AUTO');
      expect((await questionRow(s.q.mcq)).score?.toFixed(2)).toBe('10.00');
      expect((await questionRow(s.q.short)).score?.toFixed(2)).toBe('10.00');
      // Section 2 never opened: 0, not skipped.
      expect((await questionRow(s.q.code2)).score?.toFixed(2)).toBe('0.00');
      const session = await sessionRow(s.inv.sessionId);
      expect(session.status).toBe('GRADED');
      expect(session.totalScore?.toFixed(2)).toBe('90.00');

      // The graded row is the close snapshot (created_at = ended_at); no case data is stored.
      const section = await owner.sessionSection.findUniqueOrThrow({
        where: {
          sessionId_sectionId: { sessionId: s.inv.sessionId, sectionId: main.sectionIds[0] },
        },
      });
      const snap = await owner.submission.findMany({
        where: { sessionQuestionId: s.q.code, kind: 'SUBMIT', createdAt: section.endedAt as Date },
      });
      expect(snap).toHaveLength(1);
      // Section 2 never opened: no snapshot at all for it, and the non-coding questions have none.
      expect(await owner.submission.count({ where: { sessionQuestionId: s.q.code2 } })).toBe(0);
      expect(
        await owner.submission.count({
          where: { sessionQuestionId: { in: [s.q.mcq, s.q.short] } },
        }),
      ).toBe(0);
      expect(snap[0]).toMatchObject({ passed: 3, total: 5 });
      expect(snap[0]?.score?.toFixed(2)).toBe('70.00');
      const results = snap[0]?.results as Array<Record<string, unknown>>;
      expect(results).toHaveLength(5);
      for (const r of results) {
        expect(Object.keys(r).sort()).toEqual([
          'memoryKb',
          'passed',
          'status',
          'testCaseId',
          'timeMs',
        ]);
      }
      expect(JSON.stringify(results)).not.toMatch(/WRONG|h[1-5]/);
      // analyze-session was queued, once.
      expect(await redis.exists(`bull:analyze-session:analyze-session_${s.inv.sessionId}`)).toBe(1);
      // Hidden runs never reveal output.
      expect(judge.calls.flat().every((c) => c.stdin.startsWith('h') || c.stdin === 'k1')).toBe(
        true,
      );

      // Idempotent: a second run changes nothing.
      expect(await grading.grade(main.tenant.orgId, s.inv.sessionId)).toBe('already-graded');
      expect((await questionRow(s.q.code)).score?.toFixed(2)).toBe('70.00');
    });

    it('FR-505: finish is idempotent, and allowed during a PROCTOR pause; a session that is not running is 409', async () => {
      const s = await live();
      await call('post', '/session/finish', s.token).expect(200);
      const again = await call('post', '/session/finish', s.token);
      expect(again.status).toBe(200);
      expect(again.body).toMatchObject({ status: 'SUBMITTED' });
      const paused = await live({ status: 'PAUSED', pause: ['PROCTOR'] });
      await call('post', '/session/finish', paused.token).expect(200);
      expect((await sessionRow(paused.inv.sessionId)).status).toBe('SUBMITTED');
      const idle = await createInvitation(owner, main.tenant, {
        status: 'OPENED',
        testId: main.testId,
        session: { authEpoch: 1 },
      });
      const t = tokens.sign({ sid: idle.sessionId, oid: main.tenant.orgId, epoch: 1 }).token;
      const res = await call('post', '/session/finish', t);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'SESSION_NOT_ACTIVE' });
    });

    it('TC-099: an answer in an accepted variant scores; an unlisted wording is MANUAL_PENDING with no score; the reviewer decides, with audit and total', async () => {
      const exact = await live();
      const unlisted = await live();
      for (const [s, text] of [
        [exact, 'The Process of   PHOTOSYNTHESIS'],
        [unlisted, 'plants turn light into sugar'],
      ] as const) {
        await call('put', `/answers/${s.q.short}/draft`, s.token, { answer: { text } }).expect(200);
        await call('put', `/answers/${s.q.mcq}/draft`, s.token, {
          answer: { optionIds: ['a'] },
        }).expect(200);
        await call('post', '/session/finish', s.token).expect(200);
        await grading.grade(main.tenant.orgId, s.inv.sessionId);
      }
      const a = await questionRow(exact.q.short);
      expect(a).toMatchObject({ scoring: 'AUTO' });
      expect(a.score?.toFixed(2)).toBe('10.00');
      const p = await questionRow(unlisted.q.short);
      expect(p.scoring).toBe('MANUAL_PENDING');
      expect(p.score).toBeNull();
      // The session is graded but has no total while an answer waits for a person.
      const pending = await sessionRow(unlisted.inv.sessionId);
      expect(pending.status).toBe('GRADED');
      expect(pending.totalScore).toBeNull();
      expect((await sessionRow(exact.inv.sessionId)).totalScore?.toFixed(2)).toBe('10.00');

      const result = await manual.score({
        orgId: main.tenant.orgId,
        reviewerId: main.tenant.staffUserId,
        sessionQuestionId: unlisted.q.short,
        correct: true,
        note: 'Same meaning',
      });
      expect(result).toMatchObject({ score: '10.00', totalScore: '10.00', pendingLeft: 0 });
      const decided = await questionRow(unlisted.q.short);
      expect(decided).toMatchObject({
        scoring: 'MANUAL',
        scoredById: main.tenant.staffUserId,
        scoringNote: 'Same meaning',
      });
      expect(decided.scoredAt).not.toBeNull();
      expect((await sessionRow(unlisted.inv.sessionId)).totalScore?.toFixed(2)).toBe('10.00');
      const audit = await owner.auditLog.findFirst({
        where: { entityId: unlisted.q.short, action: 'answer.manual_score' },
      });
      expect(audit).toMatchObject({ actorId: main.tenant.staffUserId, orgId: main.tenant.orgId });
      expect(JSON.stringify(audit?.metadata)).not.toContain('Same meaning');
      // Decided once: a second reviewer is 409; another org's reviewer finds nothing.
      await expect(
        manual.score({
          orgId: main.tenant.orgId,
          reviewerId: main.tenant.staffUserId,
          sessionQuestionId: unlisted.q.short,
          correct: false,
        }),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        manual.score({
          orgId: foreign.tenant.orgId,
          reviewerId: foreign.tenant.staffUserId,
          sessionQuestionId: unlisted.q.short,
          correct: true,
        }),
      ).rejects.toMatchObject({ status: 404 });
    });

    it('FR-506: a runner failure while grading fails the job and leaves the session SUBMITTED, never a silent 0', async () => {
      const s = await live();
      await call('put', `/answers/${s.q.code}/draft`, s.token, {
        code: 'ECHO',
        language: 'python',
      }).expect(200);
      await call('post', '/session/finish', s.token).expect(200);
      judge.down = true;
      await expect(grading.grade(main.tenant.orgId, s.inv.sessionId)).rejects.toThrow();
      expect((await sessionRow(s.inv.sessionId)).status).toBe('SUBMITTED');
      judge.down = false;
      expect(await grading.grade(main.tenant.orgId, s.inv.sessionId)).toBe('graded');
      expect((await questionRow(s.q.code)).score?.toFixed(2)).toBe('100.00');
    });
  });

  // ---------- Section close and auto-submit (FR-505, S-5, TC-046) ----------

  describe('section close and auto-submit (FR-505, ADR 0002 S-5, TC-046)', () => {
    it('S-5: close-section at the deadline snapshots the latest saved code, closes the section and opens the next; a repeat or a race closes once', async () => {
      const s = await live({ sectionDeadlineInMs: -10_000 });
      // (No request here: a refused write queues the close, which would race the direct calls below.)
      await owner.sessionQuestion.update({
        where: { id: s.q.code },
        data: { finalCode: 'latest saved', finalLanguage: 'python' },
      });
      const [a, b] = await Promise.all([
        closeSection.close(main.tenant.orgId, s.inv.sessionId, main.sectionIds[0], 'deadline'),
        closeSection.close(main.tenant.orgId, s.inv.sessionId, main.sectionIds[0], 'deadline'),
      ]);
      expect([a.closed, b.closed].filter(Boolean)).toHaveLength(1);
      const sections = await owner.sessionSection.findMany({
        where: { sessionId: s.inv.sessionId },
        orderBy: { position: 'asc' },
      });
      expect(sections[0]?.endedAt).not.toBeNull();
      // The next section opens at the job's own time, never before the close (5.11 timing).
      expect(sections[1]?.startedAt?.getTime()).toBeGreaterThanOrEqual(
        sections[0]?.endedAt?.getTime() ?? Infinity,
      );
      // The next section has no limit: it ends with the session.
      expect(sections[1]?.deadlineAt?.getTime()).toBe(
        (await sessionRow(s.inv.sessionId)).deadlineAt?.getTime(),
      );
      const snaps = await owner.submission.findMany({
        where: { sessionQuestionId: s.q.code, kind: 'SUBMIT' },
      });
      expect(snaps).toHaveLength(1);
      expect(snaps[0]).toMatchObject({ sourceCode: 'latest saved' });
      expect(snaps[0]?.createdAt.getTime()).toBe(sections[0]?.endedAt?.getTime());
      const repeat = await closeSection.close(
        main.tenant.orgId,
        s.inv.sessionId,
        main.sectionIds[0],
        'deadline',
      );
      expect(repeat).toEqual({ closed: false, reason: 'not-open' });
      // The closed section refuses writes; the opened one accepts them.
      await call('put', `/answers/${s.q.code}/draft`, s.token, {
        code: 'y',
        language: 'python',
      }).expect(409);
      await call('put', `/answers/${s.q.code2}/draft`, s.token, {
        code: 'y',
        language: 'python',
      }).expect(200);
    });

    it('S-5: a section that is not yet due, or whose PROCTOR pause pushes the deadline out, is not closed by the deadline job', async () => {
      const s = await live();
      expect(
        await closeSection.close(
          main.tenant.orgId,
          s.inv.sessionId,
          main.sectionIds[0],
          'deadline',
        ),
      ).toMatchObject({ closed: false, reason: 'not-due' });
      const paused = await live({
        status: 'PAUSED',
        pause: ['PROCTOR'],
        sectionDeadlineInMs: -10_000,
      });
      await owner.session.update({
        where: { id: paused.inv.sessionId },
        data: { proctorPausedAt: new Date(Date.now() - 20_000) },
      });
      expect(
        await closeSection.close(
          main.tenant.orgId,
          paused.inv.sessionId,
          main.sectionIds[0],
          'deadline',
        ),
      ).toMatchObject({ closed: false, reason: 'not-due' });
    });

    it('S-5: closing the last section submits the session (compare-and-set) and queues grade-session once', async () => {
      const s = await live({ sectionDeadlineInMs: -10_000 });
      await closeSection.close(main.tenant.orgId, s.inv.sessionId, main.sectionIds[0], 'finish');
      const last = await closeSection.close(
        main.tenant.orgId,
        s.inv.sessionId,
        main.sectionIds[1],
        'finish',
      );
      expect(last).toMatchObject({ closed: true, submittedSession: true });
      expect((await sessionRow(s.inv.sessionId)).status).toBe('SUBMITTED');
      expect(await redis.exists(`bull:grading-jobs:grade-session_${s.inv.sessionId}`)).toBe(1);
    });

    it('TC-046: a session past its deadline is auto-submitted with the latest saved code, then graded, through the real queue', async () => {
      const s = await live({ sessionDeadlineInMs: -60_000, sectionDeadlineInMs: -60_000 });
      await owner.sessionQuestion.update({
        where: { id: s.q.code },
        data: { finalCode: 'PASS:h1,h2,h3,h4,h5', finalLanguage: 'python' },
      });
      const found = await worker.sweep();
      expect(found.sessions).toBeGreaterThanOrEqual(1);
      const submitted = await eventually(
        () => sessionRow(s.inv.sessionId),
        (r) => r.status !== 'IN_PROGRESS',
      );
      expect(['SUBMITTED', 'GRADED']).toContain(submitted.status);
      expect(submitted.submittedAt).not.toBeNull();
      const graded = await eventually(
        () => sessionRow(s.inv.sessionId),
        (r) => r.status === 'GRADED',
      );
      expect(graded.status).toBe('GRADED');
      expect((await questionRow(s.q.code)).score?.toFixed(2)).toBe('100.00');
      expect(graded.totalScore).not.toBeNull();
    }, 60_000);
  });

  // ---------- BE-11 review round: section finish, provisos, races, loud failures ----------

  describe('section finish and the 5.11 provisos (FR-301, FR-505, ADR 0002 S-5)', () => {
    const sections = (sid: string) =>
      owner.sessionSection.findMany({ where: { sessionId: sid }, orderBy: { position: 'asc' } });

    it('FR-301: section finish enqueues the close; a retry after the next section opened is a no-op 202 that never touches it', async () => {
      const s = await live();
      await call('put', `/answers/${s.q.code}/draft`, s.token, {
        code: 'saved',
        language: 'python',
      }).expect(200);
      const res = await call('post', FINISH, s.token, { position: 1 }).expect(202);
      expect(res.body).toEqual({ accepted: true });
      const rows = await eventually(
        () => sections(s.inv.sessionId),
        (r) => r[0]?.endedAt != null && r[1]?.startedAt != null,
      );
      const [one, two] = rows;
      // The next section starts at the close instant and runs to the session deadline (no own limit).
      expect(two?.startedAt?.getTime()).toBe(one?.endedAt?.getTime());
      expect(two?.deadlineAt?.getTime()).toBe(
        (await sessionRow(s.inv.sessionId)).deadlineAt?.getTime(),
      );
      // A retry (double click, slow network) for section 1: a no-op, section 2 stays open and unchanged.
      await clearLimits(s.inv.sessionId);
      const retry = await call('post', FINISH, s.token, { position: 1 }).expect(202);
      expect(retry.body).toEqual({ accepted: true });
      await new Promise((r) => setTimeout(r, 500));
      const after = await sections(s.inv.sessionId);
      expect(after[0]?.endedAt?.getTime()).toBe(one?.endedAt?.getTime());
      expect(after[1]?.endedAt).toBeNull();
      expect(after[1]?.startedAt?.getTime()).toBe(two?.startedAt?.getTime());
      expect(after[1]?.deadlineAt?.getTime()).toBe(two?.deadlineAt?.getTime());
      // FR-301: the finished section cannot be reopened, by a write or by a second close.
      const late = await call('put', `/answers/${s.q.code}/draft`, s.token, {
        code: 'y',
        language: 'python',
      });
      expect(late.status).toBe(409);
      expect(late.body).toMatchObject({ code: 'SECTION_NOT_OPEN' });
      expect(
        await closeSection.close(main.tenant.orgId, s.inv.sessionId, main.sectionIds[0], 'finish'),
      ).toMatchObject({ closed: false });
      await call('put', `/answers/${s.q.code2}/draft`, s.token, {
        code: 'z',
        language: 'python',
      }).expect(200);
      expect(
        await owner.submission.count({ where: { sessionQuestionId: s.q.code, kind: 'SUBMIT' } }),
      ).toBe(1);
    });

    it('FR-301: section finish names a position of the token session only: unopened 409, beyond the last 404, bad bodies 400, no token 401, PROCTOR pause 409', async () => {
      const a = await live();
      const b = await live();
      // Finish 2 before it opened: 409; beyond the last section: 404.
      const early = await call('post', FINISH, a.token, { position: 2 });
      expect(early.status).toBe(409);
      expect(early.body).toMatchObject({ code: 'SECTION_NOT_OPEN' });
      await call('post', FINISH, a.token, { position: 3 }).expect(404);
      for (const body of [
        {},
        { position: '1' },
        { position: 1.5 },
        { position: 0 },
        { position: -1 },
        { position: 1, sectionId: main.sectionIds[0] },
        { sectionId: main.sectionIds[0] },
      ]) {
        await call('post', FINISH, a.token, body).expect(400);
      }
      await call('post', FINISH, null, { position: 1 }).expect(401);
      const p = await live({ status: 'PAUSED', pause: ['PROCTOR'] });
      const paused = await call('post', FINISH, p.token, { position: 1 });
      expect(paused.status).toBe(409);
      expect(paused.body).toMatchObject({ code: 'SESSION_PAUSED' });
      // Another session's sections are untouched by a's calls.
      expect((await sections(b.inv.sessionId))[0]?.endedAt).toBeNull();
      expect((await sections(p.inv.sessionId))[0]?.endedAt).toBeNull();
    });

    it('S-5: two concurrent section-finish calls and the deadline job close the section once, with one snapshot', async () => {
      const s = await live();
      await owner.sessionQuestion.update({
        where: { id: s.q.code },
        data: { finalCode: 'raced twice', finalLanguage: 'python' },
      });
      const [x, y] = await Promise.all([
        call('post', FINISH, s.token, { position: 1 }),
        call('post', FINISH, s.token, { position: 1 }),
      ]);
      // Both are 202 (or the second is rate limited by the per-session limiter): never an error.
      expect([202, 429]).toContain(x.status);
      expect([202, 429]).toContain(y.status);
      await eventually(
        () => sections(s.inv.sessionId),
        (r) => r[0]?.endedAt != null,
      );
      await closeSection.close(main.tenant.orgId, s.inv.sessionId, main.sectionIds[0], 'deadline');
      expect(
        await owner.submission.count({ where: { sessionQuestionId: s.q.code, kind: 'SUBMIT' } }),
      ).toBe(1);
    });

    it('S-5: finish vs finish vs deadline racing close the section once, with one snapshot', async () => {
      const s = await live({ sectionDeadlineInMs: -10_000 });
      await owner.sessionQuestion.update({
        where: { id: s.q.code },
        data: { finalCode: 'raced', finalLanguage: 'python' },
      });
      const outcomes = await Promise.all([
        closeSection.close(main.tenant.orgId, s.inv.sessionId, main.sectionIds[0], 'finish'),
        closeSection.close(main.tenant.orgId, s.inv.sessionId, main.sectionIds[0], 'finish'),
        closeSection.close(main.tenant.orgId, s.inv.sessionId, main.sectionIds[0], 'deadline'),
      ]);
      expect(outcomes.filter((o) => o.closed)).toHaveLength(1);
      expect(
        await owner.submission.count({ where: { sessionQuestionId: s.q.code, kind: 'SUBMIT' } }),
      ).toBe(1);
    });

    it('FR-505, 5.11 proviso 1: at request time every write after the section deadline is refused, with no runner call', async () => {
      const s = await live({ sectionDeadlineInMs: -1_000 });
      for (const [method, path] of [
        ['post', `/answers/${s.q.code}/run`],
        ['put', `/answers/${s.q.code}/draft`],
        ['post', `/answers/${s.q.code}/submit`],
      ] as const) {
        await clearLimits(s.inv.sessionId);
        const res = await call(method, path, s.token, { code: 'ECHO', language: 'python' });
        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({ code: 'SECTION_NOT_OPEN' });
      }
      expect(judge.calls).toHaveLength(0);
    });

    it('FR-505, 5.11 proviso 2 and 3: the snapshot is the state at the deadline; the next section opens at the job time and runs to the session cap', async () => {
      const ranAt = Date.now();
      const s = await live({ sectionDeadlineInMs: -60_000 });
      const before = await sections(s.inv.sessionId);
      const deadline = before[0]?.deadlineAt as Date;
      await owner.sessionQuestion.update({
        where: { id: s.q.code },
        data: { finalCode: 'at the deadline', finalLanguage: 'python' },
      });
      const out = await closeSection.close(
        main.tenant.orgId,
        s.inv.sessionId,
        main.sectionIds[0],
        'deadline',
      );
      expect(out).toMatchObject({ closed: true });
      const after = await sections(s.inv.sessionId);
      expect(after[0]?.endedAt?.getTime()).toBe(deadline.getTime());
      // ended_at and the snapshot are D; the next section opens at the job's own time (hub ruling).
      expect(after[1]?.startedAt?.getTime()).toBeGreaterThanOrEqual(ranAt);
      expect(after[1]?.deadlineAt?.getTime()).toBe(
        (await sessionRow(s.inv.sessionId)).deadlineAt?.getTime(),
      );
      const snap = await owner.submission.findFirstOrThrow({
        where: { sessionQuestionId: s.q.code, kind: 'SUBMIT' },
      });
      expect(snap.sourceCode).toBe('at the deadline');
      expect(snap.createdAt.getTime()).toBe(deadline.getTime());
    });

    it('FR-505, 5.11 proviso 3: the first refused request after the deadline queues the close, so the next section opens without the sweep', async () => {
      const ranAt = Date.now();
      const s = await live({ sectionDeadlineInMs: -60_000 });
      const deadline = (await sections(s.inv.sessionId))[0]?.deadlineAt as Date;
      await call('put', `/answers/${s.q.code}/draft`, s.token, {
        code: 'x',
        language: 'python',
      }).expect(409);
      const rows = await eventually(
        () => sections(s.inv.sessionId),
        (r) => r[1]?.startedAt != null,
      );
      expect(rows[0]?.endedAt?.getTime()).toBe(deadline.getTime());
      expect(rows[1]?.startedAt?.getTime()).toBeGreaterThanOrEqual(ranAt);
    });

    it('FR-301, 5.11 timing: a late close opens the next section at the job time with its full limit L; the session deadline still caps it', async () => {
      const s = await live({ sectionDeadlineInMs: -120_000 });
      await owner.sessionSection.update({
        where: {
          sessionId_sectionId: { sessionId: s.inv.sessionId, sectionId: main.sectionIds[1] },
        },
        data: { timeLimitMs: 15n * 60_000n },
      });
      const ranAt = Date.now();
      await closeSection.close(main.tenant.orgId, s.inv.sessionId, main.sectionIds[0], 'deadline');
      const two = (await sections(s.inv.sessionId))[1];
      expect(two?.startedAt?.getTime()).toBeGreaterThanOrEqual(ranAt);
      // The close ran two minutes late; the candidate still has the whole 15 minutes.
      expect((two?.deadlineAt?.getTime() ?? 0) - (two?.startedAt?.getTime() ?? 0)).toBe(900_000);

      const capped = await live({ sectionDeadlineInMs: -120_000, sessionDeadlineInMs: 5 * 60_000 });
      await owner.sessionSection.update({
        where: {
          sessionId_sectionId: { sessionId: capped.inv.sessionId, sectionId: main.sectionIds[1] },
        },
        data: { timeLimitMs: 15n * 60_000n },
      });
      await closeSection.close(
        main.tenant.orgId,
        capped.inv.sessionId,
        main.sectionIds[0],
        'deadline',
      );
      const second = (await sections(capped.inv.sessionId))[1];
      expect(second?.deadlineAt?.getTime()).toBe(
        (await sessionRow(capped.inv.sessionId)).deadlineAt?.getTime(),
      );
    });

    it('FR-506, ADR 0013 5.11 precision: Prisma fills created_at with a client millisecond value (pinned finding, FU-BEB-89)', async () => {
      const s = await live();
      for (let i = 0; i < 6; i++) {
        await redis.del(`rl:run:${s.inv.sessionId}`);
        await call('post', `/answers/${s.q.code}/run`, s.token, {
          code: 'ECHO',
          language: 'python',
        }).expect(200);
      }
      const rows = await owner.$queryRaw<Array<{ sub: number }>>`
        select (extract(microseconds from created_at)::bigint % 1000)::int as sub
        from submissions where session_question_id = ${s.q.code}::uuid and kind = 'RUN'`;
      expect(rows).toHaveLength(6);
      // Not the database now(): the tie-break below is what keeps grading safe.
      expect(rows.every((r) => r.sub === 0)).toBe(true);
    });

    it('FR-506, 5.11: two rows at the close timestamp fail grading loudly and alert, whatever their code; no tie-break, never a wrong grade (FU-BEB-89)', async () => {
      const errors = jest.spyOn(appLogger().prototype, 'error').mockImplementation(() => undefined);
      try {
        for (const code of ['PASS:h1,h3,h5', 'PASS:h1,h2']) {
          const x = await live();
          await call('put', `/answers/${x.q.code}/draft`, x.token, {
            code: 'PASS:h1,h3,h5',
            language: 'python',
          }).expect(200);
          await call('post', '/session/finish', x.token).expect(200);
          await closeSection.close(main.tenant.orgId, x.inv.sessionId, main.sectionIds[0], 'final');
          const ended = (
            await owner.sessionSection.findUniqueOrThrow({
              where: {
                sessionId_sectionId: { sessionId: x.inv.sessionId, sectionId: main.sectionIds[0] },
              },
            })
          ).endedAt as Date;
          await owner.submission.create({
            data: {
              sessionQuestionId: x.q.code,
              kind: 'SUBMIT',
              language: 'python',
              sourceCode: code,
              createdAt: ended,
            },
          });
          await expect(grading.grade(main.tenant.orgId, x.inv.sessionId)).rejects.toThrow(
            /close snapshot/,
          );
          expect((await sessionRow(x.inv.sessionId)).status).toBe('SUBMITTED');
          expect(
            errors.mock.calls.some(
              (c) =>
                String(c[0]).includes('grading_snapshot_ambiguous') &&
                String(c[0]).includes(x.q.code),
            ),
          ).toBe(true);
        }
      } finally {
        errors.mockRestore();
      }
    });

    it('FR-506, 5.11: a save after the close claim does not fail grading; the close snapshot is graded and a LATE_WRITE_AFTER_SECTION_CLOSE audit row is written (FR-506, TC-046)', async () => {
      // (a) no code at the claim, a write lands after it: scored 0, flagged, no throw.
      const none = await live();
      await call('post', '/session/finish', none.token).expect(200);
      await closeSection.close(main.tenant.orgId, none.inv.sessionId, main.sectionIds[0], 'final');
      await owner.sessionQuestion.update({
        where: { id: none.q.code },
        data: { finalCode: 'PASS:h1,h2,h3,h4,h5', finalLanguage: 'python' },
      });
      expect(await grading.grade(main.tenant.orgId, none.inv.sessionId)).toBe('graded');
      const flagged = await questionRow(none.q.code);
      expect(flagged.score?.toFixed(2)).toBe('0.00');
      expect(flagged.scoringNote).toBeNull();
      const lateRows = (id: string) =>
        owner.auditLog.findMany({
          where: { entityId: id, action: 'LATE_WRITE_AFTER_SECTION_CLOSE' },
        });
      const audit = await lateRows(none.inv.sessionId);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        actorId: null,
        ip: null,
        entityType: 'session',
        orgId: main.tenant.orgId,
      });
      expect(audit[0]?.metadata).toEqual({
        system: true,
        sessionId: none.inv.sessionId,
        sessionQuestionId: none.q.code,
      });
      expect(JSON.stringify(audit[0]?.metadata)).not.toContain('PASS');
      // (b) code at the claim, a newer save after it: the snapshot is graded, flagged.
      const some = await live();
      await call('put', `/answers/${some.q.code}/draft`, some.token, {
        code: 'PASS:h1,h3,h5',
        language: 'python',
      }).expect(200);
      await call('post', '/session/finish', some.token).expect(200);
      await closeSection.close(main.tenant.orgId, some.inv.sessionId, main.sectionIds[0], 'final');
      await owner.sessionQuestion.update({
        where: { id: some.q.code },
        data: { finalCode: 'PASS:h1' },
      });
      expect(await grading.grade(main.tenant.orgId, some.inv.sessionId)).toBe('graded');
      const graded = await questionRow(some.q.code);
      expect(graded.score?.toFixed(2)).toBe('70.00');
      expect(graded.scoringNote).toBeNull();
      expect(await lateRows(some.inv.sessionId)).toHaveLength(1);
      // A normal question carries no flag.
      const clean = await live();
      await call('put', `/answers/${clean.q.code}/draft`, clean.token, {
        code: 'ECHO',
        language: 'python',
      }).expect(200);
      await call('post', '/session/finish', clean.token).expect(200);
      await grading.grade(main.tenant.orgId, clean.inv.sessionId);
      expect((await questionRow(clean.q.code)).scoringNote).toBeNull();
      expect(await lateRows(clean.inv.sessionId)).toHaveLength(0);
    });

    it('FR-505, FU-BEB-91: a late close after the session deadline leaves the next section unopened and queues auto-submit', async () => {
      const s = await live({ sessionDeadlineInMs: -30_000, sectionDeadlineInMs: -60_000 });
      const out = await closeSection.close(
        main.tenant.orgId,
        s.inv.sessionId,
        main.sectionIds[0],
        'deadline',
      );
      expect(out).toMatchObject({ closed: true, openedNext: false, sessionPastDeadline: true });
      const rows = await sections(s.inv.sessionId);
      expect(rows[0]?.endedAt).not.toBeNull();
      expect(rows[1]?.startedAt).toBeNull();
      await eventually(
        () => sessionRow(s.inv.sessionId),
        (r) => r.status !== 'IN_PROGRESS',
      );
      expect((await sessionRow(s.inv.sessionId)).status).not.toBe('IN_PROGRESS');
    }, 60_000);

    it('Q17: a post-SUBMITTED status reads as SUBMITTED in the finish response and in problem bodies', async () => {
      const s = await live();
      await call('post', '/session/finish', s.token).expect(200);
      await grading.grade(main.tenant.orgId, s.inv.sessionId);
      expect((await sessionRow(s.inv.sessionId)).status).toBe('GRADED');
      const again = await call('post', '/session/finish', s.token).expect(200);
      expect(again.body).toMatchObject({ status: 'SUBMITTED' });
      const write = await call('put', `/answers/${s.q.code}/draft`, s.token, {
        code: 'x',
        language: 'python',
      });
      expect(write.status).toBe(409);
      expect(write.body).toMatchObject({ code: 'SESSION_NOT_ACTIVE', sessionStatus: 'SUBMITTED' });
      const fin = await call('post', FINISH_PATH, s.token, { position: 1 });
      expect(fin.body).toMatchObject({ code: 'SESSION_NOT_ACTIVE', sessionStatus: 'SUBMITTED' });
      expect(JSON.stringify([again.body, write.body, fin.body])).not.toMatch(/GRADED|UNDER_REVIEW/);
    });

    it('FR-505: a refused write just after the deadline queues a delayed close that waits out the grace', async () => {
      const s = await live({ sectionDeadlineInMs: -1_000 });
      await call('put', `/answers/${s.q.code}/draft`, s.token, {
        code: 'x',
        language: 'python',
      }).expect(409);
      const job = await queue
        .queue()
        .getJob(`close-section_${s.inv.sessionId}_${main.sectionIds[0]}_deadline`);
      // Delayed to deadline + 5 s (about 4 s left), not run at once as a not-due no-op.
      expect(job?.opts.delay ?? 0).toBeGreaterThan(0);
      expect(job?.opts.delay ?? 0).toBeLessThanOrEqual(5_000);
    });

    it('FR-505: closing the last section on the deadline job stamps submitted_at with the close time, not the deadline', async () => {
      const s = await live({ sectionDeadlineInMs: -60_000 });
      await closeSection.close(main.tenant.orgId, s.inv.sessionId, main.sectionIds[0], 'finish');
      await owner.sessionSection.update({
        where: {
          sessionId_sectionId: { sessionId: s.inv.sessionId, sectionId: main.sectionIds[1] },
        },
        data: {
          startedAt: new Date(Date.now() - 120_000),
          deadlineAt: new Date(Date.now() - 60_000),
        },
      });
      const before = Date.now();
      const out = await closeSection.close(
        main.tenant.orgId,
        s.inv.sessionId,
        main.sectionIds[1],
        'deadline',
      );
      expect(out).toMatchObject({ closed: true, submittedSession: true });
      expect((await sessionRow(s.inv.sessionId)).submittedAt?.getTime()).toBeGreaterThanOrEqual(
        before,
      );
    });

    it('5.11: the reconciler leaves a session alone while its grade job is queued, and re-queues it once the job is gone', async () => {
      const s = await live();
      await call('post', '/session/finish', s.token).expect(200);
      await owner.session.update({
        where: { id: s.inv.sessionId },
        data: { submittedAt: new Date(Date.now() - 120_000) },
      });
      expect(await queue.hasLiveGradeJob(s.inv.sessionId)).toBe(true);
      const spy = jest.spyOn(queue, 'enqueueGrade');
      try {
        await worker.sweep();
        expect(spy.mock.calls.some((c) => c[1] === s.inv.sessionId)).toBe(false);
        await queue.queue().remove(`grade-session_${s.inv.sessionId}`);
        expect(await queue.hasLiveGradeJob(s.inv.sessionId)).toBe(false);
        await worker.sweep();
        expect(spy.mock.calls.some((c) => c[1] === s.inv.sessionId)).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });

    it('FR-506, FU-BEB-102: an in-flight save during grading does not fail it or change the grade; the difference is flagged with an audit row', async () => {
      const s = await live();
      await call('put', `/answers/${s.q.code}/draft`, s.token, {
        code: 'PASS:h1,h3,h5',
        language: 'python',
      }).expect(200);
      await call('post', '/session/finish', s.token).expect(200);
      judge.onRun = async () => {
        await owner.sessionQuestion.update({
          where: { id: s.q.code },
          data: { finalCode: 'PASS:h1,h2,h3,h4,h5' },
        });
      };
      expect(await grading.grade(main.tenant.orgId, s.inv.sessionId)).toBe('graded');
      // Graded on the close snapshot (3 of 5 tests, 70.00), not on the newer final_code (100.00).
      expect((await questionRow(s.q.code)).score?.toFixed(2)).toBe('70.00');
      const rows = await owner.auditLog.findMany({
        where: { entityId: s.inv.sessionId, action: 'LATE_WRITE_AFTER_SECTION_CLOSE' },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.metadata).toEqual({
        system: true,
        sessionId: s.inv.sessionId,
        sessionQuestionId: s.q.code,
      });
      // A save that equals the snapshot is not late.
      const calm = await live();
      await call('put', `/answers/${calm.q.code}/draft`, calm.token, {
        code: 'ECHO',
        language: 'python',
      }).expect(200);
      await call('post', '/session/finish', calm.token).expect(200);
      await grading.grade(main.tenant.orgId, calm.inv.sessionId);
      expect(
        await owner.auditLog.count({
          where: { entityId: calm.inv.sessionId, action: 'LATE_WRITE_AFTER_SECTION_CLOSE' },
        }),
      ).toBe(0);
    });

    it('FR-506, 5.11: every coding question gets a close snapshot, an empty one scores 0 with no runner call', async () => {
      const s = await live();
      await call('post', '/session/finish', s.token).expect(200);
      judge.calls.length = 0;
      expect(await grading.grade(main.tenant.orgId, s.inv.sessionId)).toBe('graded');
      const snap = await owner.submission.findMany({
        where: { sessionQuestionId: s.q.code, kind: 'SUBMIT' },
      });
      expect(snap).toHaveLength(1);
      // No saved language: the question's first allowed language; no code: empty.
      expect(snap[0]).toMatchObject({ language: 'python', sourceCode: '' });
      expect((await questionRow(s.q.code)).score?.toFixed(2)).toBe('0.00');
      expect(judge.calls).toHaveLength(0);
      expect(
        await owner.auditLog.count({
          where: { entityId: s.inv.sessionId, action: 'LATE_WRITE_AFTER_SECTION_CLOSE' },
        }),
      ).toBe(0);
    });

    it("FR-506, 5.11: the snapshot language is the saved one, else the first allowed language of the PINNED version, not the question's current version", async () => {
      const q = await owner.question.findFirstOrThrow({
        where: { currentVersionId: main.versionIds[0] },
      });
      const v2 = await owner.questionVersion.create({
        data: {
          questionId: q.id,
          version: 2,
          title: 'v2',
          statementMd: 's',
          difficulty: 'EASY',
          allowedLanguages: ['javascript'],
          isPublished: true,
        },
      });
      await owner.question.update({ where: { id: q.id }, data: { currentVersionId: v2.id } });
      try {
        const s = await live();
        await call('post', '/session/finish', s.token).expect(200);
        await grading.grade(main.tenant.orgId, s.inv.sessionId);
        const snap = await owner.submission.findFirstOrThrow({
          where: { sessionQuestionId: s.q.code, kind: 'SUBMIT' },
        });
        // The session question is pinned to the first version (python), not the current one.
        expect(snap.language).toBe('python');
        // A saved language wins over the allowed list.
        const saved = await live();
        await call('put', `/answers/${saved.q.code}/draft`, saved.token, {
          code: 'ECHO',
          language: 'python',
        }).expect(200);
        await owner.sessionQuestion.update({
          where: { id: saved.q.code },
          data: { finalLanguage: 'java' },
        });
        await closeSection.close(
          main.tenant.orgId,
          saved.inv.sessionId,
          main.sectionIds[0],
          'final',
        );
        expect(
          (
            await owner.submission.findFirstOrThrow({
              where: { sessionQuestionId: saved.q.code, kind: 'SUBMIT' },
            })
          ).language,
        ).toBe('java');
      } finally {
        await owner.question.update({
          where: { id: q.id },
          data: { currentVersionId: main.versionIds[0] },
        });
      }
    });

    it('FR-301, 5.11: a deadline close that runs after D + L still gives the next section its full limit from the job time', async () => {
      const s = await live({ sectionDeadlineInMs: -120_000 });
      await owner.sessionSection.update({
        where: {
          sessionId_sectionId: { sessionId: s.inv.sessionId, sectionId: main.sectionIds[1] },
        },
        data: { timeLimitMs: 60_000n },
      });
      const ranAt = Date.now();
      await closeSection.close(main.tenant.orgId, s.inv.sessionId, main.sectionIds[0], 'deadline');
      const two = (await sections(s.inv.sessionId))[1];
      expect(two?.startedAt?.getTime()).toBeGreaterThanOrEqual(ranAt);
      expect(two?.deadlineAt?.getTime()).toBe((two?.startedAt?.getTime() ?? 0) + 60_000);
      expect(two?.deadlineAt?.getTime() ?? 0).toBeGreaterThan(Date.now());
    });

    it('FR-505, P-3, 5.11: a deadline close during a PROCTOR pause closes at D plus the credit; with the cap used up at D itself', async () => {
      const p = await live({ status: 'PAUSED', pause: ['PROCTOR'], sectionDeadlineInMs: -600_000 });
      await owner.session.update({
        where: { id: p.inv.sessionId },
        data: { proctorPausedAt: new Date(Date.now() - 180_000) },
      });
      const d = (await sections(p.inv.sessionId))[0]?.deadlineAt?.getTime() ?? 0;
      await closeSection.close(main.tenant.orgId, p.inv.sessionId, main.sectionIds[0], 'deadline');
      const ended = (await sections(p.inv.sessionId))[0]?.endedAt?.getTime() ?? 0;
      // About three minutes of credit (the pause ran 180 s when the job read it).
      expect(ended - d).toBeGreaterThanOrEqual(179_000);
      expect(ended - d).toBeLessThanOrEqual(200_000);

      const capped = await live({
        status: 'PAUSED',
        pause: ['PROCTOR'],
        sectionDeadlineInMs: -600_000,
      });
      await owner.session.update({
        where: { id: capped.inv.sessionId },
        data: { proctorPausedAt: new Date(Date.now() - 180_000), pausedMs: 30n * 60_000n },
      });
      const d2 = (await sections(capped.inv.sessionId))[0]?.deadlineAt?.getTime() ?? 0;
      await closeSection.close(
        main.tenant.orgId,
        capped.inv.sessionId,
        main.sectionIds[0],
        'deadline',
      );
      expect((await sections(capped.inv.sessionId))[0]?.endedAt?.getTime()).toBe(d2);
    });

    it('FR-505, 5.11: a finish click after D but before the deadline job closes at D, like the deadline variant', async () => {
      const ranAt = Date.now();
      const s = await live({ sectionDeadlineInMs: -30_000 });
      const d = (await sections(s.inv.sessionId))[0]?.deadlineAt?.getTime() ?? 0;
      await owner.sessionQuestion.update({
        where: { id: s.q.code },
        data: { finalCode: 'x', finalLanguage: 'python' },
      });
      await closeSection.close(main.tenant.orgId, s.inv.sessionId, main.sectionIds[0], 'finish');
      const rows = await sections(s.inv.sessionId);
      expect(rows[0]?.endedAt?.getTime()).toBe(d);
      expect(rows[1]?.startedAt?.getTime()).toBeGreaterThanOrEqual(ranAt);
      const snap = await owner.submission.findFirstOrThrow({
        where: { sessionQuestionId: s.q.code, kind: 'SUBMIT' },
      });
      expect(snap.createdAt.getTime()).toBe(d);
    });

    it('FR-505, 5.11: the deadline claim misses when the deadline moved after it was read (extension or resume credit), and a not-yet-due job queues a distinct delayed follow-up', async () => {
      const s = await live({ sectionDeadlineInMs: -10_000 });
      // A section whose deadline was pushed out is not due: the job re-delays with a distinct id.
      await owner.sessionSection.update({
        where: {
          sessionId_sectionId: { sessionId: s.inv.sessionId, sectionId: main.sectionIds[0] },
        },
        data: { deadlineAt: new Date(Date.now() + 120_000) },
      });
      const out = await closeSection.close(
        main.tenant.orgId,
        s.inv.sessionId,
        main.sectionIds[0],
        'deadline',
      );
      expect(out).toMatchObject({ closed: false, reason: 'not-due' });
      const dueAt = (out as { dueAt: Date }).dueAt.getTime();
      const job = await queue
        .queue()
        .getJob(`close-section_${s.inv.sessionId}_${main.sectionIds[0]}_deadline_${String(dueAt)}`);
      expect(job?.opts.delay ?? 0).toBeGreaterThan(100_000);
      expect((await sections(s.inv.sessionId))[0]?.endedAt).toBeNull();
    });

    it('FR-506, TC-048, 5.11: a pinned version that allows no language fails the close loudly with an ids-only alert, and the close rolls back', async () => {
      const q = await owner.question.findFirstOrThrow({
        where: { currentVersionId: main.versionIds[0] },
      });
      const bare = await owner.questionVersion.create({
        data: {
          questionId: q.id,
          version: 3,
          title: 'bare',
          statementMd: 's',
          difficulty: 'EASY',
          allowedLanguages: [],
          isPublished: true,
        },
      });
      const s = await live();
      await owner.sessionQuestion.update({
        where: { id: s.q.code },
        data: { questionVersionId: bare.id },
      });
      const errors = jest.spyOn(appLogger().prototype, 'error').mockImplementation(() => undefined);
      try {
        const { GradingInvariantError } =
          jest.requireActual<typeof import('../grading/errors')>('../grading/errors');
        await expect(
          closeSection.close(main.tenant.orgId, s.inv.sessionId, main.sectionIds[0], 'finish'),
        ).rejects.toBeInstanceOf(GradingInvariantError);
        const logs = errors.mock.calls.map((c) => String(c[0]));
        const alert = logs.find((l) => l.includes('close_snapshot_no_language'));
        expect(alert).toContain(s.q.code);
        expect(alert).toContain(main.tenant.orgId);
        expect(alert).not.toMatch(/sourceCode|code":/);
      } finally {
        errors.mockRestore();
      }
      // Rolled back: the section is still open and nothing was written.
      expect((await sections(s.inv.sessionId))[0]?.endedAt).toBeNull();
      expect(await owner.submission.count({ where: { sessionQuestionId: s.q.code } })).toBe(0);
    });

    it('FR-506, TC-046, 5.11: a missing close snapshot is always a bug: alert and fail, nothing is graded', async () => {
      const s = await live();
      await call('put', `/answers/${s.q.code}/draft`, s.token, {
        code: 'ECHO',
        language: 'python',
      }).expect(200);
      await call('post', '/session/finish', s.token).expect(200);
      await closeSection.close(main.tenant.orgId, s.inv.sessionId, main.sectionIds[0], 'final');
      await owner.submission.deleteMany({ where: { sessionQuestionId: s.q.code, kind: 'SUBMIT' } });
      const errors = jest.spyOn(appLogger().prototype, 'error').mockImplementation(() => undefined);
      try {
        await expect(grading.grade(main.tenant.orgId, s.inv.sessionId)).rejects.toThrow(
          /close snapshot/,
        );
        expect(
          errors.mock.calls.some(
            (c) =>
              String(c[0]).includes('grading_snapshot_missing') &&
              String(c[0]).includes(main.tenant.orgId),
          ),
        ).toBe(true);
      } finally {
        errors.mockRestore();
      }
      expect((await sessionRow(s.inv.sessionId)).status).toBe('SUBMITTED');
      expect((await questionRow(s.q.code)).score).toBeNull();
    });

    it('FU-BEB-92: runner-outage failures are uncounted only up to a time ceiling, then the session is given up', async () => {
      const s = await live();
      await call('put', `/answers/${s.q.code}/draft`, s.token, {
        code: 'ECHO',
        language: 'python',
      }).expect(200);
      await call('post', '/session/finish', s.token).expect(200);
      judge.down = true;
      const data = { orgId: main.tenant.orgId, sessionId: s.inv.sessionId };
      await expect(worker.process({ name: 'grade-session', data })).rejects.toMatchObject({
        name: 'RunnerUnavailableError',
      });
      await redis.set(`grade-outage-since:${s.inv.sessionId}`, String(Date.now() - 7 * 3_600_000));
      await expect(worker.process({ name: 'grade-session', data })).rejects.toMatchObject({
        name: 'UnrecoverableError',
      });
      expect(await redis.get(`grade-failures:${s.inv.sessionId}`)).toBe('15');
    });

    it('FU-BEB-93: sweep paging skips given-up rows ahead of newer ones, and the stuck alert fires once per hour per session', async () => {
      const collect = (
        worker as unknown as {
          collect: <T>(
            f: (skip: number, take: number) => Promise<T[]>,
            k: (r: T) => Promise<boolean>,
            want: number,
          ) => Promise<T[]>;
        }
      ).collect.bind(worker);
      const rows = Array.from({ length: 1003 }, (_, i) => ({ i }));
      const picked = await collect(
        (skip, take) => Promise.resolve(rows.slice(skip, skip + take)),
        (r) => Promise.resolve(r.i >= 1000),
        10,
      );
      expect(picked.map((r) => r.i)).toEqual([1000, 1001, 1002]);

      const s = await live();
      await call('post', '/session/finish', s.token).expect(200);
      await owner.session.update({
        where: { id: s.inv.sessionId },
        data: { submittedAt: new Date(Date.now() - 2 * 3_600_000) },
      });
      await redis.del(`alert:stuck:${s.inv.sessionId}`);
      const errors = jest.spyOn(appLogger().prototype, 'error').mockImplementation(() => undefined);
      try {
        await worker.sweep();
        await worker.sweep();
        const alerts = errors.mock.calls.filter(
          (c) =>
            String(c[0]).includes('session_stuck_submitted') &&
            String(c[0]).includes(s.inv.sessionId),
        );
        expect(alerts).toHaveLength(1);
      } finally {
        errors.mockRestore();
      }
    });

    it('FR-301, 5.11 proviso 4: the variant assignment is fixed, so the sample a question runs is the same every time', async () => {
      const s = await live();
      const send = (): request.Test =>
        call('post', `/answers/${s.q.code}/run`, s.token, { code: 'ECHO', language: 'python' });
      await send().expect(200);
      await redis.del(`rl:run:${s.inv.sessionId}`);
      await send().expect(200);
      expect(judge.calls.map((c) => c.map((x) => x.stdin))).toEqual([['vs1'], ['vs1']]);
      // NOTE: render-question is BE-09; this pins the projection BE-11 itself reads (FU-BEB-82).
    });
  });

  describe('races and loud failures (reviewer S2, S3, S4, S5)', () => {
    it('S5: finish racing auto-submit makes exactly one SUBMITTED transition and one grade job', async () => {
      const s = await live({ sessionDeadlineInMs: -10_000, sectionDeadlineInMs: -10_000 });
      const [fin, auto] = await Promise.all([
        flow.finish(main.tenant.orgId, s.inv.sessionId),
        flow.autoSubmit(main.tenant.orgId, s.inv.sessionId),
      ]);
      expect([fin.alreadySubmitted === false, auto].filter(Boolean)).toHaveLength(1);
      expect((await sessionRow(s.inv.sessionId)).status).toBe('SUBMITTED');
      expect(await redis.exists(`bull:grading-jobs:grade-session_${s.inv.sessionId}`)).toBe(1);
    });

    it('S5: finish racing the last-section close makes exactly one SUBMITTED transition', async () => {
      const s = await live({ sectionDeadlineInMs: -10_000 });
      await closeSection.close(main.tenant.orgId, s.inv.sessionId, main.sectionIds[0], 'finish');
      const [close, fin] = await Promise.all([
        closeSection.close(main.tenant.orgId, s.inv.sessionId, main.sectionIds[1], 'finish'),
        flow.finish(main.tenant.orgId, s.inv.sessionId),
      ]);
      const closeWon = close.closed && close.submittedSession;
      expect([closeWon, fin.alreadySubmitted === false].filter(Boolean)).toHaveLength(1);
      expect((await sessionRow(s.inv.sessionId)).status).toBe('SUBMITTED');
    });

    it('S5: two concurrent grade() calls write the scores once', async () => {
      const s = await live();
      await call('put', `/answers/${s.q.code}/draft`, s.token, {
        code: 'PASS:h1,h3,h5',
        language: 'python',
      }).expect(200);
      await call('post', '/session/finish', s.token).expect(200);
      const outcomes = await Promise.all([
        grading.grade(main.tenant.orgId, s.inv.sessionId),
        grading.grade(main.tenant.orgId, s.inv.sessionId),
      ]);
      expect(outcomes.filter((o) => o === 'graded')).toHaveLength(1);
      expect(outcomes.filter((o) => o !== 'graded')[0]).toMatch(/lost-race|already-graded/);
      expect((await questionRow(s.q.code)).score?.toFixed(2)).toBe('70.00');
      expect((await sessionRow(s.inv.sessionId)).totalScore?.toFixed(2)).toBe('70.00');
    });

    it('FR-506: a variant hidden override is the data the code is graded on', async () => {
      const s = await live();
      const h5 = await owner.testCase.findFirstOrThrow({
        where: { questionVersionId: main.versionIds[0], input: 'h5' },
      });
      const variant = await owner.questionVariant.create({
        data: { questionVersionId: main.versionIds[0], params: { n: 2 }, renderedStatement: 'v2' },
      });
      await owner.variantTestCase.create({
        data: { variantId: variant.id, testCaseId: h5.id, input: 'v5', expectedOutput: 'v5' },
      });
      await owner.sessionQuestion.update({
        where: { id: s.q.code },
        data: { variantId: variant.id },
      });
      // The base h5 is not what runs: h5 (weight 4) fails, so 1 + 1 + 2 + 2 of 10.
      await call('put', `/answers/${s.q.code}/draft`, s.token, {
        code: 'PASS:h1,h2,h3,h4,h5',
        language: 'python',
      }).expect(200);
      await call('post', '/session/finish', s.token).expect(200);
      await grading.grade(main.tenant.orgId, s.inv.sessionId);
      expect((await questionRow(s.q.code)).score?.toFixed(2)).toBe('60.00');
      expect(judge.calls.flat().some((c) => c.stdin === 'v5')).toBe(true);
    });

    it('S3, S2: a snapshot language the runner does not support fails loudly, gives up at once and stays SUBMITTED', async () => {
      const s = await live();
      await owner.sessionQuestion.update({
        where: { id: s.q.code },
        data: { finalCode: 'x', finalLanguage: 'cobol' },
      });
      await call('post', '/session/finish', s.token).expect(200);
      const { GradingInvariantError } =
        jest.requireActual<typeof import('../grading/errors')>('../grading/errors');
      await expect(grading.grade(main.tenant.orgId, s.inv.sessionId)).rejects.toBeInstanceOf(
        GradingInvariantError,
      );
      await expect(
        worker.process({
          name: 'grade-session',
          data: { orgId: main.tenant.orgId, sessionId: s.inv.sessionId },
        }),
      ).rejects.toMatchObject({ name: 'UnrecoverableError' });
      expect(await redis.get(`grade-failures:${s.inv.sessionId}`)).toBe('15');
      expect((await sessionRow(s.inv.sessionId)).status).toBe('SUBMITTED');
      expect((await questionRow(s.q.code)).score).toBeNull();
    });

    it('S3: a coding question with no hidden test weight fails loudly instead of scoring 0', async () => {
      const s = await live();
      await call('put', `/answers/${s.q.code}/draft`, s.token, {
        code: 'ECHO',
        language: 'python',
      }).expect(200);
      await call('post', '/session/finish', s.token).expect(200);
      const where = { questionVersionId: main.versionIds[0], isHidden: true };
      await owner.testCase.updateMany({ where, data: { weight: 0 } });
      try {
        await expect(grading.grade(main.tenant.orgId, s.inv.sessionId)).rejects.toThrow(
          /hidden test/,
        );
      } finally {
        await owner.testCase.updateMany({
          where: { ...where, input: { in: ['h1', 'h2'] } },
          data: { weight: 1 },
        });
        await owner.testCase.updateMany({
          where: { ...where, input: { in: ['h3', 'h4'] } },
          data: { weight: 2 },
        });
        await owner.testCase.updateMany({ where: { ...where, input: 'h5' }, data: { weight: 4 } });
      }
      expect((await sessionRow(s.inv.sessionId)).status).toBe('SUBMITTED');
    });

    it('S2: a runner outage is not counted toward the give-up budget; other repeated failures stop at the budget and the sweep stops re-queuing', async () => {
      const s = await live();
      await call('put', `/answers/${s.q.code}/draft`, s.token, {
        code: 'ECHO',
        language: 'python',
      }).expect(200);
      await call('post', '/session/finish', s.token).expect(200);
      const data = { orgId: main.tenant.orgId, sessionId: s.inv.sessionId };
      judge.down = true;
      for (let i = 0; i < 16; i++) {
        const err = await worker.process({ name: 'grade-session', data }).catch((e: unknown) => e);
        expect(err).toMatchObject({ name: 'RunnerUnavailableError' });
      }
      expect(await redis.get(`grade-failures:${s.inv.sessionId}`)).toBeNull();
      judge.down = false;
      const spy = jest.spyOn(grading, 'grade').mockRejectedValue(new Error('boom'));
      let last: unknown;
      try {
        for (let i = 0; i < 15; i++) {
          last = await worker.process({ name: 'grade-session', data }).catch((e: unknown) => e);
        }
      } finally {
        spy.mockRestore();
      }
      expect(last).toMatchObject({ name: 'UnrecoverableError' });
      expect(Number(await redis.get(`grade-failures:${s.inv.sessionId}`))).toBeGreaterThanOrEqual(
        15,
      );
      await owner.session.update({
        where: { id: s.inv.sessionId },
        data: { submittedAt: new Date(Date.now() - 120_000) },
      });
      await redis.del(`bull:grading-jobs:grade-session_${s.inv.sessionId}`);
      await worker.sweep();
      expect(await redis.exists(`bull:grading-jobs:grade-session_${s.inv.sessionId}`)).toBe(0);
    }, 60_000);

    it('S2: close-section and auto-submit failures are bounded too, and a live session without a deadline gives up at once', async () => {
      const s = await live();
      await owner.session.update({ where: { id: s.inv.sessionId }, data: { deadlineAt: null } });
      const data = {
        orgId: main.tenant.orgId,
        sessionId: s.inv.sessionId,
        sectionId: main.sectionIds[0],
        variant: 'finish',
      };
      await expect(worker.process({ name: 'close-section', data })).rejects.toMatchObject({
        name: 'UnrecoverableError',
      });
      expect(
        await redis.get(`close-section-failures:${s.inv.sessionId}:${main.sectionIds[0]}`),
      ).toBe('15');
      // The claim was rolled back with the transaction.
      expect(
        (await owner.sessionSection.findMany({ where: { sessionId: s.inv.sessionId } }))[0]
          ?.endedAt,
      ).toBeNull();
      const auto = await live({ sessionDeadlineInMs: -10_000 });
      const boom = jest.spyOn(flow, 'autoSubmit').mockRejectedValue(new Error('boom'));
      let last: unknown;
      try {
        for (let i = 0; i < 15; i++) {
          last = await worker
            .process({
              name: 'auto-submit',
              data: { orgId: main.tenant.orgId, sessionId: auto.inv.sessionId },
            })
            .catch((e: unknown) => e);
        }
      } finally {
        boom.mockRestore();
      }
      expect(last).toMatchObject({ name: 'UnrecoverableError' });
    }, 60_000);

    it('S4, TC-099: two reviewers scoring the last two pending answers at once leave one total computed from both', async () => {
      const s = await live();
      const extra = await owner.sessionQuestion.create({
        data: {
          sessionId: s.inv.sessionId,
          testQuestionId: main.testQuestionIds[2],
          questionVersionId: main.versionIds[2],
          position: 5,
          points: 10,
        },
      });
      await call('put', `/answers/${s.q.short}/draft`, s.token, {
        answer: { text: 'something else' },
      }).expect(200);
      await owner.sessionQuestion.update({
        where: { id: extra.id },
        data: { answer: { text: 'another wording' } },
      });
      await call('post', '/session/finish', s.token).expect(200);
      await grading.grade(main.tenant.orgId, s.inv.sessionId);
      expect((await sessionRow(s.inv.sessionId)).totalScore).toBeNull();
      const attempts = jest.spyOn(
        manual as unknown as { scoreOnce: (...a: unknown[]) => unknown },
        'scoreOnce',
      );
      const results = await Promise.all([
        manual.score({
          orgId: main.tenant.orgId,
          reviewerId: main.tenant.staffUserId,
          sessionQuestionId: s.q.short,
          correct: true,
        }),
        manual.score({
          orgId: main.tenant.orgId,
          reviewerId: main.tenant.staffUserId,
          sessionQuestionId: extra.id,
          correct: true,
        }),
      ]);
      // Two reviewers, each at least once; a serialization conflict is retried (bounded).
      expect(attempts.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(attempts.mock.calls.length).toBeLessThanOrEqual(10);
      attempts.mockRestore();
      expect(results.filter((r) => r.pendingLeft === 0).length).toBeGreaterThanOrEqual(1);
      const row = await sessionRow(s.inv.sessionId);
      // MCQ unanswered 0, coding 0, two short answers 10 each.
      expect(row.totalScore?.toFixed(2)).toBe('20.00');
    }, 60_000);

    it('FR-506: no stored result or candidate response carries hidden stdout, stdin or expected output', async () => {
      const s = await live();
      const run = await call('post', `/answers/${s.q.code}/run`, s.token, {
        code: 'ECHO',
        language: 'python',
      }).expect(200);
      const submit = await call('post', `/answers/${s.q.code}/submit`, s.token, {
        code: 'PASS:h1',
        language: 'python',
      }).expect(200);
      await call('post', '/session/finish', s.token).expect(200);
      await grading.grade(main.tenant.orgId, s.inv.sessionId);
      const stored = await owner.submission.findMany({ where: { sessionQuestionId: s.q.code } });
      const all = JSON.stringify([run.body, submit.body, stored.map((r) => r.results)]);
      expect(all).not.toMatch(/WRONG|"h[1-5]"|expectedOutput|stdin/);
    });
  });

  describe('local stub runner (DL-54, DL-58, Backend A PR #298), FR-502, FR-506', () => {
    type Run = ExecutionService['run'];
    const stubRun = (verdicts: string[], seen: unknown[] = []): Run =>
      ((request: { tests: ReadonlyArray<{ id: string }>; mode?: string }) => {
        seen.push(request.mode);
        return Promise.resolve({
          clampedLimits: false,
          results: request.tests.map((t, i) => {
            const verdict = verdicts[i % verdicts.length] as string;
            const stub = verdict === 'LOCAL_STUB';
            return {
              testId: t.id,
              verdict,
              passed: verdict === 'PASSED',
              timeMs: null,
              memoryKb: null,
              ...(stub ? { stub: true as const, message: 'not graded (local stub)' } : {}),
            };
          }),
        });
      }) as unknown as Run;

    it('FR-506, TC-048: hidden tests answered by the local stub leave the question not graded (no score, MANUAL_PENDING), total_score null, and the job succeeds without a retry count', async () => {
      const s = await live();
      await call('put', `/answers/${s.q.code}/draft`, s.token, {
        code: 'ECHO',
        language: 'python',
      }).expect(200);
      await call('put', `/answers/${s.q.mcq}/draft`, s.token, {
        answer: { optionIds: ['b'] },
      }).expect(200);
      await call('post', '/session/finish', s.token).expect(200);
      const seen: unknown[] = [];
      const spy = jest.spyOn(execution, 'run').mockImplementation(stubRun(['LOCAL_STUB'], seen));
      try {
        await worker.process({
          name: 'grade-session',
          data: { orgId: main.tenant.orgId, sessionId: s.inv.sessionId },
        });
      } finally {
        spy.mockRestore();
      }
      const code = await questionRow(s.q.code);
      expect(code.score).toBeNull();
      expect(code).toMatchObject({
        scoring: 'MANUAL_PENDING',
        scoringNote: 'not graded (local stub)',
      });
      // Mixed with a real question: the MCQ is scored, the total waits for the pending one.
      expect((await questionRow(s.q.mcq)).score?.toFixed(2)).toBe('10.00');
      const session = await sessionRow(s.inv.sessionId);
      expect(session.status).toBe('GRADED');
      expect(session.totalScore).toBeNull();
      expect(await redis.get(`grade-failures:${s.inv.sessionId}`)).toBeNull();
      // Grading asks for submit mode; results are stored without stdout.
      expect(seen).toContain('submit');
      const snap = await owner.submission.findFirstOrThrow({
        where: { sessionQuestionId: s.q.code, kind: 'SUBMIT' },
      });
      expect(snap.score).toBeNull();
      expect(JSON.stringify(snap.results)).toContain('LOCAL_STUB');
      expect(JSON.stringify(snap.results)).not.toMatch(/stdout|"h[1-5]"/);
    });

    it('FR-506: one stub result among real ones makes the whole question not graded (all or nothing)', async () => {
      const s = await live();
      await call('put', `/answers/${s.q.code}/draft`, s.token, {
        code: 'ECHO',
        language: 'python',
      }).expect(200);
      await call('post', '/session/finish', s.token).expect(200);
      const spy = jest
        .spyOn(execution, 'run')
        .mockImplementation(stubRun(['PASSED', 'LOCAL_STUB']));
      try {
        expect(await grading.grade(main.tenant.orgId, s.inv.sessionId)).toBe('graded');
      } finally {
        spy.mockRestore();
      }
      const code = await questionRow(s.q.code);
      expect(code.score).toBeNull();
      expect(code.scoring).toBe('MANUAL_PENDING');
    });

    it('FR-502, TC-040: Run returns the LOCAL_STUB verdict through unchanged and stores the RUN row', async () => {
      const s = await live();
      const spy = jest.spyOn(execution, 'run').mockImplementation(stubRun(['LOCAL_STUB']));
      let res;
      try {
        res = await call('post', `/answers/${s.q.code}/run`, s.token, {
          code: 'ECHO',
          language: 'python',
        }).expect(200);
      } finally {
        spy.mockRestore();
      }
      expect(res.body).toMatchObject({ passed: 0, total: 1 });
      expect((res.body as { results: Array<Record<string, unknown>> }).results[0]).toMatchObject({
        verdict: 'LOCAL_STUB',
        passed: false,
        message: 'not graded (local stub)',
      });
      const rows = await owner.submission.findMany({
        where: { sessionQuestionId: s.q.code, kind: 'RUN' },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ passed: 0, total: 1 });
    });
  });

  it('NFR: no log line carries source code, an answer or a token', () => {
    const text = logged.join('');
    expect(text).not.toContain(SECRET_MARKER);
    expect(text).not.toContain('Photosynthesis');
    expect(text).not.toMatch(/Bearer\s/i);
  });

  // ---------- render projection (ADR 0013 CS-4.6; FR-301, FR-501, TC-011) ----------

  describe('GET /candidate/session/test and GET /candidate/questions/:id (CS-4.6, TC-011, FR-301)', () => {
    const get = (path: string, token: string | null): request.Test => {
      const req = request(app.getHttpServer()).get(`${API}${path}`);
      return token === null ? req : req.set('Authorization', `Bearer ${token}`);
    };

    it('TC-011, FR-501: a coding question shows the variant statement, languages, the variant sample and nothing hidden', async () => {
      const l = await live();
      const res = await get(`/questions/${l.q.code}`, l.token).expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toMatchObject({
        sessionQuestionId: l.q.code,
        type: 'CODING',
        title: 'code',
        statementMd: 'variant',
        languages: ['python'],
        samples: [{ input: 'vs1', expectedOutput: 'vs1' }],
      });
      // An allowlist: exactly these keys, no reference solution, no hidden case, no answer spec.
      expect(Object.keys(res.body as object).sort()).toEqual(
        [
          'languages',
          'limits',
          'samples',
          'sessionQuestionId',
          'starterCode',
          'statementMd',
          'title',
          'type',
        ].sort(),
      );
      expect(JSON.stringify(res.body)).not.toMatch(
        /h1|h2|h3|h4|h5|referenceSolution|REFERENCE|answerSpec/,
      );
    });

    it('TC-011: an MCQ shows the options in the author order and never the correct ids; a short answer shows no accepted answer', async () => {
      const l = await live();
      const mcq = await get(`/questions/${l.q.mcq}`, l.token).expect(200);
      expect(mcq.body).toMatchObject({
        type: 'MCQ',
        mcq: {
          multiple: false,
          options: [
            { id: 'a', text: 'A' },
            { id: 'b', text: 'B' },
          ],
        },
      });
      expect(JSON.stringify(mcq.body)).not.toMatch(/correct/i);
      const short = await get(`/questions/${l.q.short}`, l.token).expect(200);
      expect(short.body).toMatchObject({ type: 'SHORT_ANSWER' });
      expect(JSON.stringify(short.body)).not.toMatch(/photosynthesis|canonical|accepted/i);
    });

    it('S-5, CS-2: a question of a section that has not opened is 409 SECTION_NOT_OPEN; another session, another org and a malformed id are 404 or 400; no token is 401', async () => {
      const l = await live();
      const res = await get(`/questions/${l.q.code2}`, l.token).expect(409);
      expect(res.body).toMatchObject({ code: 'SECTION_NOT_OPEN' });
      const other = await live();
      await get(`/questions/${other.q.code}`, l.token).expect(404);
      const foreignLive = await live({ world: foreign });
      await get(`/questions/${foreignLive.q.code}`, l.token).expect(404);
      await get('/questions/not-a-uuid', l.token).expect(400);
      await get(`/questions/${l.q.code}`, null).expect(401);
    });

    it('CS-4.6: reads stay allowed in every pause; past the section deadline on server time the read is 409', async () => {
      const paused = await live({ status: 'PAUSED', pause: ['PROCTOR'] });
      await get(`/questions/${paused.q.code}`, paused.token).expect(200);
      const late = await live({ sectionDeadlineInMs: -60_000 });
      const res = await get(`/questions/${late.q.code}`, late.token).expect(409);
      expect(res.body).toMatchObject({ code: 'SECTION_NOT_OPEN' });
    });

    it('FR-301: the layout lists sections, question ids, points and deadlines, no content; only a running session has one', async () => {
      const l = await live();
      const res = await get('/session/test', l.token);
      expect(res.status).toBe(200);
      const body = res.body as {
        status: string;
        sections: Array<{
          position: number;
          questions: Array<{ sessionQuestionId: string; points: string }>;
        }>;
      };
      expect(body.status).toBe('IN_PROGRESS');
      expect(body.sections.map((s) => s.position)).toEqual([1, 2]);
      expect(body.sections[0]?.questions.map((q) => q.sessionQuestionId)).toEqual([
        l.q.code,
        l.q.mcq,
        l.q.short,
      ]);
      expect(JSON.stringify(res.body)).not.toMatch(/statement|starterCode|samples/);
      const over = await createInvitation(owner, main.tenant, {
        testId: main.testId,
        status: 'SUBMITTED',
        session: { authEpoch: 1 },
      });
      const token = tokens.sign({ sid: over.sessionId, oid: main.tenant.orgId, epoch: 1 }).token;
      const done = await get('/session/test', token).expect(409);
      expect(done.body).toMatchObject({ code: 'SESSION_NOT_ACTIVE' });
      await get('/session/test', null).expect(401);
    });
  });
});
