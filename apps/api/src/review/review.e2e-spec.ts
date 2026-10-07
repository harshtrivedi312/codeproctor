// Reviewer read API (FR-901, FR-703, FR-105, FR-103, TC-004 style role matrix, TC-008 org isolation)
// against real Postgres 16 and Redis (Testcontainers), the API running as app_user (ADR 0006).
// There is no TC ID for the read API in docs/test-cases.md yet; each test cites its FR.
import { INestApplication, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';
import { passwordVersion } from '../auth/crypto.util';
import type { CandidateTokenService } from '../candidate/candidate-token.service';
import type { TokenService } from '../common/auth/token.service';
import { createPrismaClient } from '../database/create-prisma-client';
import { PrismaClient, UserRole } from '../generated/prisma/client';
import type { QuestionScoring, QuestionType, SessionStatus } from '../generated/prisma/client';
import { applyEnv, applyMigrations, startInfra } from '../test/containers';
import type { TestInfra } from '../test/containers';
import { InMemoryRecordingStorage } from './recording-storage.testing';

const API = '/api/v1';
const GHOST = '00000000-0000-4000-8000-000000000042';

type Json = Record<string, unknown>;

describe('Reviewer read API (FR-901, FR-703, FR-105, TC-008)', () => {
  let infra: TestInfra;
  let app: INestApplication<App>;
  let owner: PrismaClient;
  let pg: Client;
  let orgA: string;
  let orgB: string;
  let tokens: TokenService;
  let candidateTokens: CandidateTokenService;
  let storage: InMemoryRecordingStorage;
  let seq = 0;

  beforeAll(async () => {
    infra = await startInfra();
    await applyMigrations(infra);
    const appPassword = randomBytes(18).toString('hex');
    pg = new Client({ connectionString: infra.postgres.getConnectionUri() });
    await pg.connect();
    await pg.query(`ALTER ROLE app_user PASSWORD '${appPassword}'`);
    const url = `postgresql://app_user:${appPassword}@${infra.postgres.getHost()}:${infra.postgres.getMappedPort(5432)}/${infra.postgres.getDatabase()}`;
    applyEnv(infra, {
      DATABASE_URL: url,
      LOG_LEVEL: 'silent',
      THROTTLE_DEFAULT_LIMIT: '100000',
      JWT_CANDIDATE_SECRET: randomBytes(32).toString('base64'),
    });
    owner = createPrismaClient(infra.postgres.getConnectionUri());
    orgA = (await owner.organization.create({ data: { name: 'Org A' } })).id;
    orgB = (await owner.organization.create({ data: { name: 'Org B' } })).id;

    jest.resetModules();
    const { AppModule } = jest.requireActual<typeof import('../app.module')>('../app.module');
    const { Test } = jest.requireActual<typeof import('@nestjs/testing')>('@nestjs/testing');
    const { configureApp } = jest.requireActual<typeof import('../bootstrap')>('../bootstrap');
    const { MailPort } =
      jest.requireActual<typeof import('../mail/mail.port')>('../mail/mail.port');
    const { RecordingStoragePort } = jest.requireActual<typeof import('./recording-storage.port')>(
      './recording-storage.port',
    );
    storage = new InMemoryRecordingStorage();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MailPort)
      .useValue({})
      .overrideProvider(RecordingStoragePort)
      .useValue(storage)
      .compile();
    app = moduleRef.createNestApplication<INestApplication<App>>();
    configureApp(app);
    await app.init();
    await app.listen(0);
    const { TokenService: Tokens } = jest.requireActual<
      typeof import('../common/auth/token.service')
    >('../common/auth/token.service');
    tokens = app.get(Tokens);
    const { CandidateTokenService: CTokens } = jest.requireActual<
      typeof import('../candidate/candidate-token.service')
    >('../candidate/candidate-token.service');
    candidateTokens = app.get(CTokens);
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
      data: { orgId, email: `u${n}@example.com`, fullName: `U ${n}`, role, passwordHash },
    });
    const token = tokens.sign(
      { sub: user.id, org: orgId, role, kind: 'access', pwv: passwordVersion(passwordHash) },
      900,
    );
    return { id: user.id, auth: { Authorization: `Bearer ${token}` } };
  }

  const http = (): ReturnType<typeof request> => request(app.getHttpServer());

  interface SeedSession {
    orgId?: string;
    status?: SessionStatus;
    submittedAt?: Date | null;
    riskScore?: number | null;
    name?: string;
  }

  /** Candidate, test (one section), invitation and session straight in the database. */
  async function seedSession(
    o: SeedSession = {},
  ): Promise<{ sessionId: string; sectionId: string; orgId: string }> {
    const n = ++seq;
    const orgId = o.orgId ?? orgA;
    const cand = await owner.candidate.create({
      data: { orgId, email: `cand${n}@example.com`, fullName: o.name ?? `Cand ${n}` },
    });
    const test = await owner.test.create({
      data: { orgId, name: `Test ${n}`, durationMinutes: 60 },
    });
    const section = await owner.testSection.create({
      data: { testId: test.id, title: 'S', position: 1 },
    });
    const inv = await owner.invitation.create({
      data: {
        orgId,
        testId: test.id,
        candidateId: cand.id,
        tokenHash: randomBytes(32).toString('hex'),
        windowStart: new Date(Date.now() - 1000),
        windowEnd: new Date(Date.now() + 3_600_000),
      },
    });
    const s = await owner.session.create({
      data: {
        orgId,
        invitationId: inv.id,
        status: o.status ?? 'UNDER_REVIEW',
        submittedAt: o.submittedAt === undefined ? new Date() : o.submittedAt,
        startedAt: new Date(Date.now() - 600_000),
        riskScore: o.riskScore === undefined ? null : o.riskScore,
      },
    });
    return { sessionId: s.id, sectionId: section.id, orgId };
  }

  async function seedAnswer(
    sessionId: string,
    sectionId: string,
    orgId: string,
    o: {
      type: QuestionType;
      position: number;
      scoring?: QuestionScoring;
      answer?: Json | null;
      finalCode?: string;
      finalLanguage?: string;
    },
  ): Promise<string> {
    const n = ++seq;
    const q = await owner.question.create({ data: { orgId, slug: `q-${n}`, type: o.type } });
    const v = await owner.questionVersion.create({
      data: {
        questionId: q.id,
        version: 1,
        title: `Question ${n}`,
        statementMd: `Statement ${n}`,
        difficulty: 'EASY',
        allowedLanguages: ['python'],
        isPublished: true,
        referenceSolution: { python: 'REFERENCE_SECRET' },
      },
    });
    const tq = await owner.testQuestion.create({
      data: { sectionId, questionVersionId: v.id, points: 50, position: o.position },
    });
    const sq = await owner.sessionQuestion.create({
      data: {
        sessionId,
        testQuestionId: tq.id,
        questionVersionId: v.id,
        position: o.position,
        points: 50,
        scoring: o.scoring ?? 'AUTO',
        score: o.scoring === 'MANUAL_PENDING' ? null : 25,
        answer: o.answer === undefined || o.answer === null ? undefined : (o.answer as never),
        finalCode: o.finalCode,
        finalLanguage: o.finalLanguage,
      },
    });
    return sq.id;
  }

  async function seedChunks(
    sessionId: string,
    stream: 'SCREEN' | 'WEBCAM' | 'AUDIO',
    segment: number,
    count: number,
  ): Promise<void> {
    for (let seqNo = 0; seqNo < count; seqNo++) {
      await owner.mediaChunk.create({
        data: {
          sessionId,
          stream,
          segment,
          seq: seqNo + segment * 100,
          objectKey: `private/${sessionId}/${stream}/${segment}/${seqNo}.webm`,
          startedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, seqNo * 10)),
          durationMs: 10_000,
          uploadedAt: new Date(),
        },
      });
    }
  }

  const bundleUrl = (id: string): string => `${API}/review/sessions/${id}`;
  const playUrl = (id: string, rec: string): string =>
    `${bundleUrl(id)}/recordings/${rec}/playback`;

  // ---- role matrix -------------------------------------------------------------------------------

  describe('FR-103: role matrix', () => {
    it('FR-103: RECRUITER and AUTHOR get 403 on all three routes', async () => {
      const { sessionId } = await seedSession();
      await seedChunks(sessionId, 'SCREEN', 0, 1);
      for (const role of [UserRole.RECRUITER, UserRole.AUTHOR]) {
        const who = await make(role);
        await http().get(`${API}/review/queue`).set(who.auth).expect(403);
        await http().get(bundleUrl(sessionId)).set(who.auth).expect(403);
        await http().get(playUrl(sessionId, 'SCREEN-0')).set(who.auth).expect(403);
      }
      expect(storage.calls.filter((c) => c.key.includes(sessionId))).toHaveLength(0);
    });

    it('FR-103: a candidate token and no token are refused', async () => {
      const { sessionId } = await seedSession();
      await http().get(`${API}/review/queue`).expect(401);
      await http().get(bundleUrl(sessionId)).expect(401);
      await http().get(playUrl(sessionId, 'SCREEN-0')).expect(401);
      const real = candidateTokens.sign({ sid: sessionId, oid: orgA, epoch: 1 }).token;
      const cand = { Authorization: `Bearer ${real}` };
      await http().get(`${API}/review/queue`).set(cand).expect(401);
      await http().get(bundleUrl(sessionId)).set(cand).expect(401);
      await http().get(playUrl(sessionId, 'SCREEN-0')).set(cand).expect(401);
    });

    it('FR-901: REVIEWER and SUPER_ADMIN can read all three, with no-store', async () => {
      const { sessionId } = await seedSession();
      await seedChunks(sessionId, 'WEBCAM', 0, 2);
      for (const role of [UserRole.REVIEWER, UserRole.SUPER_ADMIN]) {
        const who = await make(role);
        const q = await http().get(`${API}/review/queue`).set(who.auth).expect(200);
        expect(q.headers['cache-control']).toBe('no-store');
        const b = await http().get(bundleUrl(sessionId)).set(who.auth).expect(200);
        expect(b.headers['cache-control']).toBe('no-store');
        const p = await http().get(playUrl(sessionId, 'WEBCAM-0')).set(who.auth).expect(200);
        expect(p.headers['cache-control']).toBe('no-store');
      }
    });

    it('FR-105: each successful read writes an audit row without a query string or a URL', async () => {
      const { sessionId } = await seedSession();
      await seedChunks(sessionId, 'SCREEN', 0, 1);
      const who = await make(UserRole.REVIEWER);
      await http().get(`${API}/review/queue?pageSize=1`).set(who.auth).expect(200);
      await http().get(bundleUrl(sessionId)).set(who.auth).expect(200);
      await http().get(playUrl(sessionId, 'SCREEN-0')).set(who.auth).expect(200);
      const r = await pg.query(
        `SELECT action, entity_type, entity_id, metadata::text AS m FROM audit_logs WHERE actor_id = $1 ORDER BY id`,
        [who.id],
      );
      expect(r.rows.map((x: { action: string }) => x.action)).toEqual([
        'REVIEW_QUEUE_VIEWED',
        'REVIEW_SESSION_VIEWED',
        'REVIEW_PLAYBACK_ISSUED',
      ]);
      expect(r.rows[1]).toMatchObject({ entity_type: 'session', entity_id: sessionId });
      for (const row of r.rows as Array<{ m: string }>) {
        expect(row.m).not.toContain('store.invalid');
        expect(row.m).not.toContain('pageSize');
        expect(row.m).not.toContain('private/');
      }
    });
  });

  // ---- cross-org ---------------------------------------------------------------------------------

  describe('TC-008: another organization is 404, never 403', () => {
    it('TC-008: bundle, playback of a foreign session are the same 404 as a missing one', async () => {
      const foreign = await seedSession({ orgId: orgB });
      await seedChunks(foreign.sessionId, 'SCREEN', 0, 1);
      const callsBefore = storage.calls.length;
      for (const role of [UserRole.REVIEWER, UserRole.SUPER_ADMIN]) {
        const who = await make(role);
        const stable = (r: request.Response): Json => {
          const { traceId: _t, instance: _i, ...rest } = r.body as Json;
          void _t;
          void _i;
          return rest;
        };
        const a = await http().get(bundleUrl(foreign.sessionId)).set(who.auth).expect(404);
        const b = await http().get(bundleUrl(GHOST)).set(who.auth).expect(404);
        expect(stable(a)).toEqual(stable(b));
        await http().get(playUrl(foreign.sessionId, 'SCREEN-0')).set(who.auth).expect(404);
        await http().get(playUrl(GHOST, 'SCREEN-0')).set(who.auth).expect(404);
      }
      expect(storage.calls.length).toBe(callsBefore);
    });

    it('TC-008: the queue never lists another organization and a foreign cursor id leaks nothing', async () => {
      const mine = await seedSession({ name: 'Mine' });
      const theirs = await seedSession({ orgId: orgB, name: 'Theirs' });
      const who = await make(UserRole.REVIEWER);
      const res = await http().get(`${API}/review/queue?pageSize=100`).set(who.auth).expect(200);
      const ids = (res.body as { items: Array<{ sessionId: string }> }).items.map(
        (i) => i.sessionId,
      );
      expect(ids).toContain(mine.sessionId);
      expect(ids).not.toContain(theirs.sessionId);
      expect(JSON.stringify(res.body)).not.toContain('Theirs');
      const cursor = Buffer.from(JSON.stringify({ t: null, id: theirs.sessionId })).toString(
        'base64url',
      );
      const r2 = await http()
        .get(`${API}/review/queue?cursor=${cursor}&pageSize=100`)
        .set(who.auth)
        .expect(200);
      expect(JSON.stringify(r2.body)).not.toContain('Theirs');
    });

    it('TC-008: a recording id of the same session but another segment is 404', async () => {
      const mine = await seedSession();
      await seedChunks(mine.sessionId, 'SCREEN', 0, 1);
      const who = await make(UserRole.REVIEWER);
      await http().get(playUrl(mine.sessionId, 'SCREEN-1')).set(who.auth).expect(404);
      await http().get(playUrl(mine.sessionId, 'WEBCAM-0')).set(who.auth).expect(404);
      await http().get(playUrl(mine.sessionId, 'bogus')).set(who.auth).expect(400);
      await http().get(playUrl(mine.sessionId, 'ROOM_SCAN-0')).set(who.auth).expect(400);
    });
  });

  // ---- queue -------------------------------------------------------------------------------------

  describe('FR-805, FR-901: GET /review/queue', () => {
    it('FR-901: items carry the agreed shape, flag and pending counts, and a default status filter', async () => {
      const s = await seedSession({
        status: 'UNDER_REVIEW',
        riskScore: 72,
        name: 'Queue Shape',
        submittedAt: new Date('2020-01-01T00:00:00Z'),
      });
      await seedAnswer(s.sessionId, s.sectionId, s.orgId, {
        type: 'SHORT_ANSWER',
        position: 1,
        scoring: 'MANUAL_PENDING',
        answer: { text: 'x' },
      });
      await owner.proctorEvent.createMany({
        data: [
          { sessionId: s.sessionId, type: 'TAB_SWITCH', severity: 'HIGH', occurredAt: new Date() },
          {
            sessionId: s.sessionId,
            type: 'FOCUS_LOST',
            severity: 'MEDIUM',
            occurredAt: new Date(),
          },
          { sessionId: s.sessionId, type: 'RECONNECTED', severity: 'LOW', occurredAt: new Date() },
        ],
      });
      const other = await seedSession({ status: 'IN_PROGRESS', name: 'Not Queued' });
      const who = await make(UserRole.REVIEWER);
      const res = await http().get(`${API}/review/queue?pageSize=100`).set(who.auth).expect(200);
      const body = res.body as { items: Json[]; nextCursor: string | null };
      const item = body.items.find((i) => i.sessionId === s.sessionId);
      expect(item).toEqual({
        sessionId: s.sessionId,
        candidateName: 'Queue Shape',
        candidateEmail: expect.stringMatching(/@example\.com$/) as unknown,
        testTitle: expect.stringMatching(/^Test \d+$/) as unknown,
        status: 'UNDER_REVIEW',
        submittedAt: '2020-01-01T00:00:00.000Z',
        riskScore: 72,
        flagCount: 2,
        pendingManualCount: 1,
      });
      expect(body.items.map((i) => i.sessionId)).not.toContain(other.sessionId);
    });

    it('FR-901: an explicit status filter selects that status; an unknown status is 400', async () => {
      const s = await seedSession({ status: 'COMPLETED', name: 'Done One' });
      const who = await make(UserRole.REVIEWER);
      const res = await http()
        .get(`${API}/review/queue?status=COMPLETED&pageSize=100`)
        .set(who.auth)
        .expect(200);
      const items = (res.body as { items: Array<{ sessionId: string; status: string }> }).items;
      expect(items.map((i) => i.sessionId)).toContain(s.sessionId);
      expect(new Set(items.map((i) => i.status))).toEqual(new Set(['COMPLETED']));
      await http().get(`${API}/review/queue?status=NOPE`).set(who.auth).expect(400);
      await http().get(`${API}/review/queue?status=under_review`).set(who.auth).expect(400);
    });

    it('FR-901: cursor pagination over (submittedAt, id) visits every row once, oldest first', async () => {
      // A fresh org keeps the page arithmetic exact.
      const org = (await owner.organization.create({ data: { name: 'Pager' } })).id;
      const who = await make(UserRole.REVIEWER, org);
      const t = new Date('2021-05-05T10:00:00.000Z');
      const made: string[] = [];
      for (let i = 0; i < 5; i++) {
        // Three share the same submittedAt, so the id tiebreak is exercised.
        const at = i < 3 ? t : new Date(t.getTime() + i * 1000);
        made.push((await seedSession({ orgId: org, submittedAt: at, status: 'GRADED' })).sessionId);
      }
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const res: request.Response = await http()
          .get(`${API}/review/queue?pageSize=2${cursor ? `&cursor=${cursor}` : ''}`)
          .set(who.auth)
          .expect(200);
        const body = res.body as { items: Array<{ sessionId: string }>; nextCursor: string | null };
        expect(body.items.length).toBeLessThanOrEqual(2);
        seen.push(...body.items.map((i) => i.sessionId));
        cursor = body.nextCursor;
        pages++;
      } while (cursor && pages < 10);
      expect(pages).toBe(3);
      expect([...seen].sort()).toEqual([...made].sort());
      expect(new Set(seen).size).toBe(5);
      const firstThree = seen.slice(0, 3);
      expect(firstThree).toEqual([...firstThree].sort());
    });

    it('FR-901: pageSize above 100, below 1 or not a number, and a bad cursor are 400', async () => {
      const who = await make(UserRole.REVIEWER);
      for (const qs of ['pageSize=101', 'pageSize=0', 'pageSize=abc', 'cursor=@@@', 'cursor=']) {
        await http().get(`${API}/review/queue?${qs}`).set(who.auth).expect(400);
      }
    });
  });

  // ---- bundle ------------------------------------------------------------------------------------

  describe('FR-901: GET /review/sessions/:id', () => {
    it('FR-901: CODING, MCQ and SHORT_ANSWER answers have the agreed shapes and leak no reference data', async () => {
      const s = await seedSession({ riskScore: 40 });
      const coding = await seedAnswer(s.sessionId, s.sectionId, s.orgId, {
        type: 'CODING',
        position: 1,
        finalCode: 'print(1)',
        finalLanguage: 'python',
      });
      const mcq = await seedAnswer(s.sessionId, s.sectionId, s.orgId, {
        type: 'MCQ',
        position: 2,
        answer: { selected: ['b'] },
      });
      const short = await seedAnswer(s.sessionId, s.sectionId, s.orgId, {
        type: 'SHORT_ANSWER',
        position: 3,
        scoring: 'MANUAL_PENDING',
        answer: { text: 'forty two' },
      });
      await owner.submission.create({
        data: {
          sessionQuestionId: coding,
          kind: 'RUN',
          language: 'python',
          sourceCode: 'SOURCE_NOT_RETURNED',
          passed: 1,
          total: 2,
          results: [
            { testCaseId: 'a', passed: true, status: 'PASSED', timeMs: 3, stdout: 'LEAK_STDOUT' },
            { testCaseId: 'b', passed: false, status: 'WRONG_ANSWER', message: 'LEAK_MSG' },
          ],
        },
      });
      const who = await make(UserRole.REVIEWER);
      const res = await http().get(bundleUrl(s.sessionId)).set(who.auth).expect(200);
      const b = res.body as {
        session: Json;
        candidate: Json;
        test: Json;
        answers: Json[];
        events: Json[];
        recordings: Json[];
        verdict: Json | null;
      };
      expect(b.session).toMatchObject({
        id: s.sessionId,
        status: 'UNDER_REVIEW',
        totalScore: null,
        riskScore: 40,
        submittedAt: expect.any(String) as unknown,
        startedAt: expect.any(String) as unknown,
      });
      expect(b.test.title).toMatch(/^Test \d+$/);
      expect(Object.keys(b.candidate).sort()).toEqual(['email', 'name']);
      expect(b.verdict).toBeNull();
      expect(b.answers.map((a) => a.sessionQuestionId)).toEqual([coding, mcq, short]);
      expect(b.answers[0]).toMatchObject({
        type: 'CODING',
        points: 50,
        score: 25,
        scoring: 'AUTO',
        scoringNote: null,
        answer: { language: 'python', code: 'print(1)' },
        runResults: [
          {
            at: expect.any(String) as unknown,
            passed: 1,
            total: 2,
            tests: [
              { name: 'a', status: 'PASSED' },
              { name: 'b', status: 'WRONG_ANSWER' },
            ],
          },
        ],
      });
      expect(b.answers[0]?.title).toMatch(/^Question \d+$/);
      expect(b.answers[0]?.statement).toMatch(/^Statement \d+$/);
      expect(b.answers[1]).toMatchObject({ type: 'MCQ', answer: { selected: ['b'] } });
      expect(b.answers[1]).not.toHaveProperty('runResults');
      expect(b.answers[2]).toMatchObject({
        type: 'SHORT_ANSWER',
        scoring: 'MANUAL_PENDING',
        score: null,
        answer: { text: 'forty two' },
      });
      const text = JSON.stringify(res.body);
      for (const secret of ['REFERENCE_SECRET', 'SOURCE_NOT_RETURNED', 'LEAK_STDOUT', 'LEAK_MSG']) {
        expect(text).not.toContain(secret);
      }
    });

    it('FR-801, FR-901: events are ordered by time then id, details are safe, payload and evidence never leave', async () => {
      const s = await seedSession();
      const base = Date.UTC(2026, 2, 1, 12, 0, 0);
      const at = (sec: number): Date => new Date(base + sec * 1000);
      await owner.proctorEvent.create({
        data: {
          sessionId: s.sessionId,
          type: 'PASTE_ATTEMPT',
          severity: 'HIGH',
          occurredAt: at(20),
          payload: { clipboard: 'PAYLOAD_SECRET', token: 'tok_SECRET' },
          evidenceKey: 'evidence/KEY_SECRET.png',
        },
      });
      const early = await owner.proctorEvent.create({
        data: {
          sessionId: s.sessionId,
          type: 'NO_FACE',
          severity: 'MEDIUM',
          occurredAt: at(5),
          durationMs: 1500,
          confidence: '0.9312',
        },
      });
      const tie = await owner.proctorEvent.create({
        data: { sessionId: s.sessionId, type: 'GAZE_AWAY', severity: 'LOW', occurredAt: at(5) },
      });
      const reviewer = await make(UserRole.REVIEWER);
      const decision = await owner.flagDecision.create({
        data: { eventId: early.id, reviewerId: reviewer.id, decision: 'CONFIRMED' },
      });
      const res = await http().get(bundleUrl(s.sessionId)).set(reviewer.auth).expect(200);
      const events = (res.body as { events: Json[] }).events;
      expect(events.map((e) => e.type)).toEqual(['NO_FACE', 'GAZE_AWAY', 'PASTE_ATTEMPT']);
      expect(events[0]).toEqual({
        id: early.id.toString(),
        at: at(5).toISOString(),
        type: 'NO_FACE',
        severity: 'MEDIUM',
        detail: 'duration 1500 ms, confidence 0.93',
        flagId: decision.id,
      });
      expect(events[1]).toMatchObject({ id: tie.id.toString(), detail: null, flagId: null });
      const text = JSON.stringify(res.body);
      for (const secret of ['PAYLOAD_SECRET', 'tok_SECRET', 'KEY_SECRET', 'evidence/']) {
        expect(text).not.toContain(secret);
      }
    });

    it('FR-701: recordings group chunks of one stream and segment, summing duration, without keys', async () => {
      const s = await seedSession();
      await seedChunks(s.sessionId, 'SCREEN', 0, 3);
      await seedChunks(s.sessionId, 'SCREEN', 1, 2);
      await seedChunks(s.sessionId, 'AUDIO', 0, 1);
      // Not yet uploaded and deleted chunks are not part of a recording.
      await owner.mediaChunk.create({
        data: {
          sessionId: s.sessionId,
          stream: 'WEBCAM',
          segment: 0,
          seq: 0,
          objectKey: 'x/pending.webm',
          startedAt: new Date(),
          durationMs: 10_000,
        },
      });
      await owner.mediaChunk.create({
        data: {
          sessionId: s.sessionId,
          stream: 'WEBCAM',
          segment: 0,
          seq: 1,
          objectKey: 'x/deleted.webm',
          startedAt: new Date(),
          durationMs: 10_000,
          uploadedAt: new Date(),
          deletedAt: new Date(),
        },
      });
      const who = await make(UserRole.REVIEWER);
      const res = await http().get(bundleUrl(s.sessionId)).set(who.auth).expect(200);
      const startedAt = '2026-01-01T00:00:00.000Z';
      // Stream order follows the media_stream enum (SCREEN, WEBCAM, AUDIO), then the segment.
      expect((res.body as { recordings: Json[] }).recordings).toEqual([
        { id: 'SCREEN-0', kind: 'SCREEN', startedAt, durationMs: 30_000 },
        { id: 'SCREEN-1', kind: 'SCREEN', startedAt, durationMs: 20_000 },
        { id: 'AUDIO-0', kind: 'AUDIO', startedAt, durationMs: 10_000 },
      ]);
      expect(JSON.stringify(res.body)).not.toContain('private/');
    });

    it('FR-902: the verdict is null until a review row exists, then carries verdict and notes', async () => {
      const s = await seedSession({ status: 'COMPLETED' });
      const who = await make(UserRole.REVIEWER);
      await owner.sessionReview.create({
        data: {
          sessionId: s.sessionId,
          reviewerId: who.id,
          verdict: 'SUSPICIOUS',
          notes: 'looked odd',
          completedAt: new Date('2026-02-02T00:00:00Z'),
        },
      });
      const res = await http().get(bundleUrl(s.sessionId)).set(who.auth).expect(200);
      expect((res.body as { verdict: Json }).verdict).toEqual({
        verdict: 'SUSPICIOUS',
        notes: 'looked odd',
        completedAt: '2026-02-02T00:00:00.000Z',
      });
    });

    it('FR-901: a non-UUID id is 400', async () => {
      const who = await make(UserRole.REVIEWER);
      await http().get(`${API}/review/sessions/not-a-uuid`).set(who.auth).expect(400);
    });
  });

  // ---- playback ----------------------------------------------------------------------------------

  describe('FR-703: GET /review/sessions/:id/recordings/:recordingId/playback', () => {
    it('FR-703: the URLs are presigned for exactly 900 s and expiresAt is 15 minutes ahead', async () => {
      const s = await seedSession();
      await seedChunks(s.sessionId, 'SCREEN', 0, 3);
      const who = await make(UserRole.REVIEWER);
      const before = Date.now();
      storage.calls.length = 0;
      const res = await http().get(playUrl(s.sessionId, 'SCREEN-0')).set(who.auth).expect(200);
      const after = Date.now();
      const body = res.body as {
        url: string;
        expiresAt: string;
        contentType: string;
        parts: Array<{ url: string; seq: number; durationMs: number }>;
      };
      expect(storage.calls.map((c) => c.ttlSeconds)).toEqual([900, 900, 900]);
      expect(storage.calls.map((c) => c.key.split('/').pop())).toEqual([
        '0.webm',
        '1.webm',
        '2.webm',
      ]);
      const exp = Date.parse(body.expiresAt);
      expect(exp).toBeGreaterThanOrEqual(before + 900_000);
      expect(exp).toBeLessThanOrEqual(after + 900_000);
      expect(body.contentType).toBe('video/webm');
      expect(body.url).toBe(body.parts[0]?.url);
      expect(body.parts.map((p) => p.seq)).toEqual([0, 1, 2]);
      expect(body.parts.every((p) => p.durationMs === 10_000)).toBe(true);
      await seedChunks(s.sessionId, 'AUDIO', 0, 1);
      const a = await http().get(playUrl(s.sessionId, 'AUDIO-0')).set(who.auth).expect(200);
      expect((a.body as { contentType: string }).contentType).toBe('audio/webm');
    });

    it('FR-703: the URL and the object key are never logged', async () => {
      const s = await seedSession();
      await seedChunks(s.sessionId, 'WEBCAM', 0, 1);
      const who = await make(UserRole.REVIEWER);
      const sinks = [
        jest.spyOn(Logger.prototype, 'log'),
        jest.spyOn(Logger.prototype, 'warn'),
        jest.spyOn(Logger.prototype, 'error'),
        jest.spyOn(Logger.prototype, 'debug'),
        jest.spyOn(Logger.prototype, 'verbose'),
        jest.spyOn(console, 'log'),
        jest.spyOn(console, 'error'),
        jest.spyOn(process.stdout, 'write'),
        jest.spyOn(process.stderr, 'write'),
      ];
      try {
        const res = await http().get(playUrl(s.sessionId, 'WEBCAM-0')).set(who.auth).expect(200);
        const url = (res.body as { url: string }).url;
        expect(url).toContain('store.invalid');
        const logged = sinks.flatMap((spy) => spy.mock.calls.map((c) => JSON.stringify(c)));
        for (const line of logged) {
          expect(line).not.toContain('store.invalid');
          expect(line).not.toContain('private/');
          expect(line).not.toContain('sig=fake');
        }
      } finally {
        sinks.forEach((spy) => spy.mockRestore());
      }
    });

    it('FR-703: a recording with no uploaded chunk is 404', async () => {
      const s = await seedSession();
      const who = await make(UserRole.REVIEWER);
      await http().get(playUrl(s.sessionId, 'SCREEN-0')).set(who.auth).expect(404);
    });
  });
});
