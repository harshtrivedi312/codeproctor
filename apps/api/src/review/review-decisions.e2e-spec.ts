// Reviewer write routes (BE-13; FR-205, FR-902, D-23, TC-099, TC-008, TC-004 style role matrix;
// docs/api-contract.md section 7) against real Postgres 16 and Redis (Testcontainers), the API
// running as app_user (ADR 0006). TC-099 anchors the manual-scoring flow; the verdict gate is
// TC-099 ("the verdict is blocked until a reviewer marks it") and FR-902.
import { INestApplication } from '@nestjs/common';
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

const API = '/api/v1';
const GHOST = '00000000-0000-4000-8000-000000000042';

type Json = Record<string, unknown>;
type Dec = { toFixed(n: number): string } | null;

interface Seeded {
  sessionId: string;
  sectionId: string;
  orgId: string;
}

describe('Reviewer decisions (FR-205, FR-902, D-23, TC-099, TC-008)', () => {
  let infra: TestInfra;
  let app: INestApplication<App>;
  let owner: PrismaClient;
  let pg: Client;
  let orgA: string;
  let orgB: string;
  let tokens: TokenService;
  let candidateTokens: CandidateTokenService;
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
    const { InMemoryRecordingStorage } = jest.requireActual<
      typeof import('./recording-storage.testing')
    >('./recording-storage.testing');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MailPort)
      .useValue({})
      .overrideProvider(RecordingStoragePort)
      .useValue(new InMemoryRecordingStorage())
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
  const scoreUrl = (sid: string, sqid: string): string =>
    `${API}/review/sessions/${sid}/answers/${sqid}`;
  const verdictUrl = (sid: string): string => `${API}/review/sessions/${sid}/verdict`;

  async function seedSession(o: { orgId?: string; status?: SessionStatus } = {}): Promise<Seeded> {
    const n = ++seq;
    const orgId = o.orgId ?? orgA;
    const cand = await owner.candidate.create({
      data: { orgId, email: `cand${n}@example.com`, fullName: `Cand ${n}` },
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
        submittedAt: new Date(),
        startedAt: new Date(Date.now() - 600_000),
      },
    });
    return { sessionId: s.id, sectionId: section.id, orgId };
  }

  async function seedAnswer(
    s: Seeded,
    o: {
      type: QuestionType;
      position: number;
      points?: number;
      scoring: QuestionScoring;
      score?: string | null;
      answerText?: string;
      scoringNote?: string;
    },
  ): Promise<string> {
    const n = ++seq;
    const points = o.points ?? 50;
    const q = await owner.question.create({
      data: { orgId: s.orgId, slug: `q-${n}`, type: o.type },
    });
    const v = await owner.questionVersion.create({
      data: {
        questionId: q.id,
        version: 1,
        title: `Question ${n}`,
        statementMd: `Statement ${n}`,
        difficulty: 'EASY',
        allowedLanguages: ['python'],
        isPublished: true,
      },
    });
    const tq = await owner.testQuestion.create({
      data: { sectionId: s.sectionId, questionVersionId: v.id, points, position: o.position },
    });
    const score =
      o.score === undefined ? (o.scoring === 'MANUAL_PENDING' ? null : '10.00') : o.score;
    const sq = await owner.sessionQuestion.create({
      data: {
        sessionId: s.sessionId,
        testQuestionId: tq.id,
        questionVersionId: v.id,
        position: o.position,
        points,
        scoring: o.scoring,
        score,
        ...(o.scoringNote !== undefined ? { scoringNote: o.scoringNote } : {}),
        answer: o.answerText === undefined ? undefined : ({ text: o.answerText } as never),
      },
    });
    return sq.id;
  }

  /** Two pending short answers (50 and 30 points), an auto-scored MCQ (10) and coding (5). */
  async function seedPendingSession(): Promise<{
    sessionId: string;
    orgId: string;
    seeded: Seeded;
    a: string;
    b: string;
    mcq: string;
    coding: string;
  }> {
    const s = await seedSession();
    const a = await seedAnswer(s, {
      type: 'SHORT_ANSWER',
      position: 1,
      points: 50,
      scoring: 'MANUAL_PENDING',
      answerText: 'SECRET_CANDIDATE_ANSWER_A',
    });
    const b = await seedAnswer(s, {
      type: 'SHORT_ANSWER',
      position: 2,
      points: 30,
      scoring: 'MANUAL_PENDING',
      answerText: 'SECRET_CANDIDATE_ANSWER_B',
    });
    const mcq = await seedAnswer(s, { type: 'MCQ', position: 3, scoring: 'AUTO', score: '10.00' });
    const coding = await seedAnswer(s, {
      type: 'CODING',
      position: 4,
      scoring: 'AUTO',
      score: '5.00',
    });
    return { sessionId: s.sessionId, orgId: s.orgId, seeded: s, a, b, mcq, coding };
  }

  const sessionRow = (id: string): Promise<{ status: SessionStatus; totalScore: Dec }> =>
    owner.session.findUniqueOrThrow({
      where: { id },
      select: { status: true, totalScore: true },
    });
  const total = async (id: string): Promise<string | null> =>
    (await sessionRow(id)).totalScore?.toFixed(2) ?? null;

  // ---- role matrix and validation ---------------------------------------------------------------

  describe('FR-103: role matrix and validation', () => {
    it('FR-103, TC-004: RECRUITER and AUTHOR get 403 on both write routes and change nothing', async () => {
      const s = await seedPendingSession();
      for (const role of [UserRole.RECRUITER, UserRole.AUTHOR]) {
        const who = await make(role);
        await http()
          .patch(scoreUrl(s.sessionId, s.a))
          .set(who.auth)
          .send({ correct: true })
          .expect(403);
        await http()
          .post(verdictUrl(s.sessionId))
          .set(who.auth)
          .send({ verdict: 'CLEAN' })
          .expect(403);
      }
      const row = await owner.sessionQuestion.findUniqueOrThrow({ where: { id: s.a } });
      expect(row.scoring).toBe('MANUAL_PENDING');
    });

    it('FR-103: a candidate token and no token are 401', async () => {
      const s = await seedPendingSession();
      await http().patch(scoreUrl(s.sessionId, s.a)).send({ correct: true }).expect(401);
      await http().post(verdictUrl(s.sessionId)).send({ verdict: 'CLEAN' }).expect(401);
      const real = candidateTokens.sign({ sid: s.sessionId, oid: orgA, epoch: 1 }).token;
      const cand = { Authorization: `Bearer ${real}` };
      await http().patch(scoreUrl(s.sessionId, s.a)).set(cand).send({ correct: true }).expect(401);
      await http().post(verdictUrl(s.sessionId)).set(cand).send({ verdict: 'CLEAN' }).expect(401);
    });

    it('FR-205, D-23, TC-099: REVIEWER and SUPER_ADMIN can both score; the response is no-store and has no answer text', async () => {
      const s = await seedPendingSession();
      const reviewer = await make(UserRole.REVIEWER);
      const admin = await make(UserRole.SUPER_ADMIN);
      const r1 = await http()
        .patch(scoreUrl(s.sessionId, s.a))
        .set(reviewer.auth)
        .send({ correct: true })
        .expect(200);
      expect(r1.headers['cache-control']).toBe('no-store');
      expect(r1.body).toEqual({ sessionQuestionId: s.a, correct: true, score: 50 });
      const r2 = await http()
        .patch(scoreUrl(s.sessionId, s.b))
        .set(admin.auth)
        .send({ correct: false })
        .expect(200);
      expect(r2.body).toEqual({ sessionQuestionId: s.b, correct: false, score: 0 });
      expect(JSON.stringify([r1.body, r2.body])).not.toContain('SECRET_CANDIDATE');
    });

    it('FR-205: bad ids, missing or non-boolean correct, bad notes and unknown keys are 400', async () => {
      const s = await seedPendingSession();
      const who = await make(UserRole.REVIEWER);
      const patch = (body: Json, url = scoreUrl(s.sessionId, s.a)): request.Test =>
        http().patch(url).set(who.auth).send(body);
      await patch({ correct: true }, scoreUrl('not-a-uuid', s.a)).expect(400);
      await patch({ correct: true }, scoreUrl(s.sessionId, 'not-a-uuid')).expect(400);
      await patch({}).expect(400);
      await patch({ correct: 'true' }).expect(400);
      await patch({ correct: 1 }).expect(400);
      await patch({ correct: true, note: '' }).expect(400);
      await patch({ correct: true, note: '   ' }).expect(400);
      await patch({ correct: true, note: 'x'.repeat(1001) }).expect(400);
      await patch({ correct: true, note: 'bad\u0007bell' }).expect(400);
      await patch({ correct: true, note: `bidi${String.fromCharCode(0x202e)}override` }).expect(
        400,
      );
      await patch({ correct: true, note: 42 }).expect(400);
      await patch({ correct: true, note: null }).expect(400);
      await http()
        .post(verdictUrl(s.sessionId))
        .set(who.auth)
        .send({ verdict: 'CLEAN', note: null })
        .expect(400);
      await patch({ correct: true, score: 50 }).expect(400);
      await patch({ correct: true, scoredBy: GHOST }).expect(400);
      await http().post(verdictUrl('nope')).set(who.auth).send({ verdict: 'CLEAN' }).expect(400);
      const bad: Json[] = [
        {},
        { verdict: 'MAYBE' },
        { verdict: 'clean' },
        { verdict: 'CLEAN', note: '' },
        { verdict: 'CLEAN', note: 'x'.repeat(2001) },
        { verdict: 'CLEAN', reviewerId: GHOST },
      ];
      for (const body of bad) {
        await http().post(verdictUrl(s.sessionId)).set(who.auth).send(body).expect(400);
      }
      const row = await owner.sessionQuestion.findUniqueOrThrow({ where: { id: s.a } });
      expect(row.scoring).toBe('MANUAL_PENDING');
      expect(await owner.sessionReview.count({ where: { sessionId: s.sessionId } })).toBe(0);
    });

    it('TC-008, FR-205: another organisation, an unknown id and a question of another session are the same 404', async () => {
      const s = await seedPendingSession();
      const other = await seedPendingSession();
      const foreign = await make(UserRole.REVIEWER, orgB);
      const own = await make(UserRole.REVIEWER);
      const calls = [
        http().patch(scoreUrl(s.sessionId, s.a)).set(foreign.auth).send({ correct: true }),
        http().patch(scoreUrl(GHOST, s.a)).set(own.auth).send({ correct: true }),
        http().patch(scoreUrl(s.sessionId, GHOST)).set(own.auth).send({ correct: true }),
        http().patch(scoreUrl(s.sessionId, other.a)).set(own.auth).send({ correct: true }),
        http().post(verdictUrl(s.sessionId)).set(foreign.auth).send({ verdict: 'CLEAN' }),
        http().post(verdictUrl(GHOST)).set(own.auth).send({ verdict: 'CLEAN' }),
      ];
      const bodies = new Set<string>();
      for (const c of calls) {
        const res = await c;
        expect(res.status).toBe(404);
        const { instance, traceId, ...rest } = res.body as Json;
        expect([typeof instance, typeof traceId]).toHaveLength(2);
        bodies.add(JSON.stringify(rest));
      }
      expect([...bodies]).toHaveLength(1);
      expect((await sessionRow(s.sessionId)).status).toBe('UNDER_REVIEW');
    });
  });

  describe('FU-DB-278, TC-008: the actor must be a live reviewer of the session organisation', () => {
    it('TC-008: a reviewer of org B cannot score or give a verdict on a session of org A; same 404 as a missing session, nothing written, no audit row names the foreign user', async () => {
      const s = await seedPendingSession();
      const foreign = await make(UserRole.REVIEWER, orgB);
      const missing = await http()
        .patch(scoreUrl(GHOST, s.a))
        .set(foreign.auth)
        .send({ correct: true });
      const r1 = await http()
        .patch(scoreUrl(s.sessionId, s.a))
        .set(foreign.auth)
        .send({ correct: true });
      const r2 = await http()
        .post(verdictUrl(s.sessionId))
        .set(foreign.auth)
        .send({ verdict: 'CLEAN' });
      expect([missing.status, r1.status, r2.status]).toEqual([404, 404, 404]);
      expect((r1.body as Json).detail).toBe((missing.body as Json).detail);
      expect((r2.body as Json).detail).toBe((missing.body as Json).detail);
      expect((r1.body as Json).code).toBeUndefined();
      const row = await owner.sessionQuestion.findUniqueOrThrow({ where: { id: s.a } });
      expect(row).toMatchObject({ scoring: 'MANUAL_PENDING', scoredById: null });
      expect(await owner.sessionReview.count({ where: { sessionId: s.sessionId } })).toBe(0);
      expect(await owner.auditLog.count({ where: { actorId: foreign.id } })).toBe(0);
    });

    it('FR-103: a deactivated reviewer and a user whose role changed to RECRUITER are refused by the guard and nothing is written', async () => {
      const s = await seedPendingSession();
      const off = await make(UserRole.REVIEWER);
      await owner.user.update({ where: { id: off.id }, data: { isActive: false } });
      const demoted = await make(UserRole.REVIEWER);
      await owner.user.update({ where: { id: demoted.id }, data: { role: UserRole.RECRUITER } });
      for (const who of [off, demoted]) {
        const a = await http()
          .patch(scoreUrl(s.sessionId, s.a))
          .set(who.auth)
          .send({ correct: true });
        const v = await http()
          .post(verdictUrl(s.sessionId))
          .set(who.auth)
          .send({ verdict: 'CLEAN' });
        expect([401, 403]).toContain(a.status);
        expect([401, 403]).toContain(v.status);
      }
      const row = await owner.sessionQuestion.findUniqueOrThrow({ where: { id: s.a } });
      expect(row.scoring).toBe('MANUAL_PENDING');
      expect(await owner.sessionReview.count({ where: { sessionId: s.sessionId } })).toBe(0);
      expect(await owner.auditLog.count({ where: { actorId: { in: [off.id, demoted.id] } } })).toBe(
        0,
      );
    });

    it('FR-205, FR-902: the stored scorer and reviewer ids equal the token user', async () => {
      const s = await seedPendingSession();
      const who = await make(UserRole.SUPER_ADMIN);
      for (const id of [s.a, s.b]) {
        await http()
          .patch(scoreUrl(s.sessionId, id))
          .set(who.auth)
          .send({ correct: true })
          .expect(200);
      }
      await http()
        .post(verdictUrl(s.sessionId))
        .set(who.auth)
        .send({ verdict: 'CLEAN' })
        .expect(200);
      const rows = await owner.sessionQuestion.findMany({ where: { id: { in: [s.a, s.b] } } });
      expect(rows.map((r) => r.scoredById)).toEqual([who.id, who.id]);
      const review = await owner.sessionReview.findFirstOrThrow({
        where: { sessionId: s.sessionId },
      });
      expect(review.reviewerId).toBe(who.id);
    });

    it('FU-DB-278, TC-008: called inside org A with a forged actor (reviewer of org B, inactive user, RECRUITER) the service answers the same 404 and writes nothing', async () => {
      const s = await seedPendingSession();
      const mod = jest.requireActual<typeof import('./review-decisions.service')>(
        './review-decisions.service',
      );
      const ctx =
        jest.requireActual<typeof import('../database/org-context')>('../database/org-context');
      const service = app.get(mod.ReviewDecisionsService);
      const orgContext = app.get(ctx.OrgContextService);
      const real = await make(UserRole.REVIEWER);
      const foreignReviewer = await make(UserRole.REVIEWER, orgB);
      const inactive = await make(UserRole.REVIEWER);
      await owner.user.update({ where: { id: inactive.id }, data: { isActive: false } });
      const recruiter = await make(UserRole.RECRUITER);
      for (const actor of [foreignReviewer, inactive, recruiter]) {
        const asOrgA = <T>(fn: () => Promise<T>): Promise<T> =>
          orgContext.runAsUser({ orgId: orgA, userId: real.id, role: UserRole.REVIEWER }, fn);
        await expect(
          asOrgA(() =>
            service.scoreAnswer({ id: actor.id, orgId: orgA }, undefined, s.sessionId, s.a, {
              correct: true,
            }),
          ),
        ).rejects.toMatchObject({ status: 404, message: 'Session not found.' });
        await expect(
          asOrgA(() =>
            service.setVerdict({ id: actor.id, orgId: orgA }, undefined, s.sessionId, {
              verdict: 'CLEAN',
            }),
          ),
        ).rejects.toMatchObject({ status: 404, message: 'Session not found.' });
        expect(await owner.auditLog.count({ where: { actorId: actor.id } })).toBe(0);
      }
      const row = await owner.sessionQuestion.findUniqueOrThrow({ where: { id: s.a } });
      expect(row).toMatchObject({ scoring: 'MANUAL_PENDING', scoredById: null });
      expect(await owner.sessionReview.count({ where: { sessionId: s.sessionId } })).toBe(0);
      expect((await sessionRow(s.sessionId)).status).toBe('UNDER_REVIEW');
    });
  });

  describe('D-23: previousCorrect on a 0-point question', () => {
    it('D-23: correct:true on a 0-point question is recorded as true, not derived from the 0 score', async () => {
      const sess = await seedSession();
      const a = await seedAnswer(sess, {
        type: 'SHORT_ANSWER',
        position: 1,
        points: 0,
        scoring: 'MANUAL_PENDING',
      });
      const who = await make(UserRole.REVIEWER);
      const put = (correct: boolean): request.Test =>
        http().patch(scoreUrl(sess.sessionId, a)).set(who.auth).send({ correct });
      await put(true).expect(200);
      await put(false).expect(200);
      await put(false).expect(200);
      const audits = await owner.auditLog.findMany({
        where: { entityId: sess.sessionId, action: 'ANSWER_SCORED_MANUALLY' },
        orderBy: { id: 'asc' },
      });
      expect(audits.map((x) => (x.metadata as Json).previousCorrect)).toEqual([null, true, false]);
    });
  });

  describe('DL-37: lock contention', () => {
    it('DL-37, FR-205: a held sessions row lock answers 503 BUSY with Retry-After within the lock timeout and writes nothing', async () => {
      const s = await seedPendingSession();
      const who = await make(UserRole.REVIEWER);
      const holder = new Client({ connectionString: infra.postgres.getConnectionUri() });
      await holder.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT id FROM sessions WHERE id = $1 FOR UPDATE', [s.sessionId]);
        const t0 = Date.now();
        const res = await http()
          .patch(scoreUrl(s.sessionId, s.a))
          .set(who.auth)
          .send({ correct: true });
        expect(Date.now() - t0).toBeLessThan(6000);
        expect(res.status).toBe(503);
        expect(res.body).toMatchObject({ code: 'BUSY' });
        expect(res.headers['retry-after']).toBeDefined();
        const row = await owner.sessionQuestion.findUniqueOrThrow({ where: { id: s.a } });
        expect(row.scoring).toBe('MANUAL_PENDING');
        expect(await owner.auditLog.count({ where: { entityId: s.sessionId } })).toBe(0);
      } finally {
        await holder.query('ROLLBACK');
        await holder.end();
      }
    });
  });

  // ---- manual scoring ---------------------------------------------------------------------------

  describe('FR-205, D-23, TC-099: manual scoring', () => {
    it('TC-099: an auto-scored short answer, an MCQ and a coding question are 409 ANSWER_NOT_MANUAL', async () => {
      const s = await seedPendingSession();
      const autoShort = await seedAnswer(s.seeded, {
        type: 'SHORT_ANSWER',
        position: 9,
        scoring: 'AUTO',
        score: '10.00',
      });
      const who = await make(UserRole.REVIEWER);
      for (const id of [autoShort, s.mcq, s.coding]) {
        const res = await http()
          .patch(scoreUrl(s.sessionId, id))
          .set(who.auth)
          .send({ correct: true })
          .expect(409);
        expect(res.body).toMatchObject({ code: 'ANSWER_NOT_MANUAL' });
      }
      const row = await owner.sessionQuestion.findUniqueOrThrow({ where: { id: s.mcq } });
      expect(row.score?.toFixed(2)).toBe('10.00');
    });

    it('FR-205, TC-099: scoring stores score, scorer from the token, time and note; total stays NULL while another answer waits and is the sum after the last', async () => {
      const s = await seedPendingSession();
      const who = await make(UserRole.REVIEWER);
      await http()
        .patch(scoreUrl(s.sessionId, s.a))
        .set(who.auth)
        .send({ correct: true, note: '  Same meaning  ' })
        .expect(200);
      const a = await owner.sessionQuestion.findUniqueOrThrow({ where: { id: s.a } });
      expect(a).toMatchObject({
        scoring: 'MANUAL',
        scoredById: who.id,
        scoringNote: 'Same meaning',
      });
      expect(a.score?.toFixed(2)).toBe('50.00');
      expect(a.scoredAt).not.toBeNull();
      expect(await total(s.sessionId)).toBeNull();

      await http()
        .patch(scoreUrl(s.sessionId, s.b))
        .set(who.auth)
        .send({ correct: false })
        .expect(200);
      // 50 (correct) + 0 (incorrect) + 10 (MCQ) + 5 (coding).
      expect(await total(s.sessionId)).toBe('65.00');
    });

    it('D-23: a decision may change until the verdict; the last wins, the total follows, a change without a note keeps the note, previousCorrect is audited', async () => {
      const s = await seedPendingSession();
      const who = await make(UserRole.REVIEWER);
      const put = (id: string, body: Json): request.Test =>
        http().patch(scoreUrl(s.sessionId, id)).set(who.auth).send(body);
      await put(s.a, { correct: true, note: 'first' }).expect(200);
      await put(s.b, { correct: true }).expect(200);
      expect(await total(s.sessionId)).toBe('95.00');
      await put(s.a, { correct: false }).expect(200);
      expect(await total(s.sessionId)).toBe('45.00');
      await put(s.a, { correct: true }).expect(200);
      expect(await total(s.sessionId)).toBe('95.00');
      const row = await owner.sessionQuestion.findUniqueOrThrow({ where: { id: s.a } });
      expect(row.scoringNote).toBe('first');
      const audits = await owner.auditLog.findMany({
        where: { entityId: s.sessionId, action: 'ANSWER_SCORED_MANUALLY' },
        orderBy: { id: 'asc' },
      });
      const forA = audits.filter((a) => (a.metadata as Json).sessionQuestionId === s.a);
      expect(forA.map((a) => (a.metadata as Json).previousCorrect)).toEqual([null, true, false]);
    });

    it('FR-105, FR-205: the audit row has the actor from the token, the session as entity, ids and booleans, and no answer text or note', async () => {
      const s = await seedPendingSession();
      const who = await make(UserRole.REVIEWER);
      await http()
        .patch(scoreUrl(s.sessionId, s.a))
        .set(who.auth)
        .send({ correct: true, note: 'PRIVATE_NOTE_TEXT' })
        .expect(200);
      const audit = await owner.auditLog.findFirstOrThrow({
        where: { entityId: s.sessionId, action: 'ANSWER_SCORED_MANUALLY' },
      });
      expect(audit).toMatchObject({ actorId: who.id, orgId: orgA, entityType: 'session' });
      expect(audit.metadata).toEqual({
        sessionQuestionId: s.a,
        correct: true,
        previousCorrect: null,
      });
      const text = JSON.stringify(audit.metadata);
      expect(text).not.toContain('PRIVATE_NOTE_TEXT');
      expect(text).not.toContain('SECRET_CANDIDATE');
    });

    it('FR-205: a session that is not UNDER_REVIEW is 409 SESSION_NOT_UNDER_REVIEW; COMPLETED and APPEALED are VERDICT_ALREADY_SET; the answer is unchanged', async () => {
      const who = await make(UserRole.REVIEWER);
      const cases: Array<[SessionStatus, string]> = [
        ['GRADED', 'SESSION_NOT_UNDER_REVIEW'],
        ['SUBMITTED', 'SESSION_NOT_UNDER_REVIEW'],
        ['COMPLETED', 'VERDICT_ALREADY_SET'],
        ['APPEALED', 'VERDICT_ALREADY_SET'],
      ];
      for (const [status, code] of cases) {
        const sess = await seedSession({ status });
        const a = await seedAnswer(sess, {
          type: 'SHORT_ANSWER',
          position: 1,
          scoring: 'MANUAL_PENDING',
        });
        const res = await http()
          .patch(scoreUrl(sess.sessionId, a))
          .set(who.auth)
          .send({ correct: true })
          .expect(409);
        expect(res.body).toMatchObject({ code });
        const row = await owner.sessionQuestion.findUniqueOrThrow({ where: { id: a } });
        expect(row.scoring).toBe('MANUAL_PENDING');
      }
    });
  });

  // ---- verdict ----------------------------------------------------------------------------------

  // DL-72 development-only stopgap (BE-12 and FU-BEB-145 own the real behaviour). The booted app is
  // APP_ENV 'test', so these HTTP cases prove every non-development environment is unchanged; the
  // development case runs the same service class with APP_ENV 'development' injected.
  describe('DL-72: coding manual scoring is development-only', () => {
    const STUB = 'not graded (local stub)';

    async function stubCoding(): Promise<{ s: Seeded; coding: string }> {
      const s = await seedSession();
      const coding = await seedAnswer(s, {
        type: 'CODING',
        position: 1,
        points: 20,
        scoring: 'MANUAL_PENDING',
        score: null,
        scoringNote: STUB,
      });
      return { s, coding };
    }

    it('FR-205, TC-099: with APP_ENV test (and so staging, pilot, production, unset) a stub-pending coding answer is 409 ANSWER_NOT_MANUAL and unchanged', async () => {
      const { s, coding } = await stubCoding();
      const who = await make(UserRole.REVIEWER);
      const res = await http()
        .patch(scoreUrl(s.sessionId, coding))
        .set(who.auth)
        .send({ correct: true })
        .expect(409);
      expect(res.body).toMatchObject({ code: 'ANSWER_NOT_MANUAL' });
      const row = await owner.sessionQuestion.findUniqueOrThrow({ where: { id: coding } });
      expect(row).toMatchObject({ scoring: 'MANUAL_PENDING', score: null, scoredById: null });
    });

    it('FR-205, TC-099: with APP_ENV development a stub-pending coding answer is scored by hand with the short-answer math and audit; other coding answers stay 409', async () => {
      const mod = jest.requireActual<typeof import('./review-decisions.service')>(
        './review-decisions.service',
      );
      const ctx =
        jest.requireActual<typeof import('../database/org-context')>('../database/org-context');
      const prismaMod = jest.requireActual<typeof import('../database/prisma.service')>(
        '../database/prisma.service',
      );
      const stateMod = jest.requireActual<typeof import('../session/session-state.service')>(
        '../session/session-state.service',
      );
      const orgContext = app.get(ctx.OrgContextService);
      const dev = new mod.ReviewDecisionsService(
        app.get(prismaMod.PrismaService),
        orgContext,
        app.get(stateMod.SessionStateService),
        { get: (k: string) => ({ APP_ENV: 'development', NODE_ENV: 'development' })[k] } as never,
      );
      const real = await make(UserRole.REVIEWER);
      const asOrgA = <T>(fn: () => Promise<T>): Promise<T> =>
        orgContext.runAsUser({ orgId: orgA, userId: real.id, role: UserRole.REVIEWER }, fn);
      const score = (
        sid: string,
        sqid: string,
        correct: boolean,
      ): ReturnType<typeof dev.scoreAnswer> =>
        asOrgA(() =>
          dev.scoreAnswer({ id: real.id, orgId: orgA }, undefined, sid, sqid, { correct }),
        );

      const { s, coding } = await stubCoding();
      await expect(score(s.sessionId, coding, true)).resolves.toMatchObject({ score: 20 });
      expect(await total(s.sessionId)).toBe('20.00');
      await expect(score(s.sessionId, coding, false)).resolves.toMatchObject({ score: 0 });
      expect(await total(s.sessionId)).toBe('0.00');
      const audits = await owner.auditLog.findMany({
        where: { entityId: s.sessionId, action: 'ANSWER_SCORED_MANUALLY' },
        orderBy: { id: 'asc' },
      });
      expect(audits.map((a) => a.metadata)).toEqual([
        { sessionQuestionId: coding, correct: true, previousCorrect: null },
        { sessionQuestionId: coding, correct: false, previousCorrect: true },
      ]);

      // AUTO coding, and a pending coding answer without the grader's marker, stay refused.
      const auto = await seedAnswer(s, {
        type: 'CODING',
        position: 2,
        scoring: 'AUTO',
        score: '5.00',
      });
      const other = await seedAnswer(s, {
        type: 'CODING',
        position: 3,
        scoring: 'MANUAL_PENDING',
        score: null,
        scoringNote: 'please score this',
      });
      const bare = await seedAnswer(s, {
        type: 'CODING',
        position: 4,
        scoring: 'MANUAL_PENDING',
        score: null,
      });
      for (const id of [auto, other, bare]) {
        await expect(score(s.sessionId, id, true)).rejects.toMatchObject({
          code: 'ANSWER_NOT_MANUAL',
        });
      }
    });
  });

  describe('DL-72: non-development configs refuse coding manual scoring even when built by hand', () => {
    const configs: Record<string, string>[] = [
      { APP_ENV: 'development', NODE_ENV: 'production' },
      { APP_ENV: 'staging', NODE_ENV: 'production' },
      { APP_ENV: 'staging' },
    ];
    for (const cfg of configs) {
      it(`FR-205, TC-099: ${JSON.stringify(cfg)} answers ANSWER_NOT_MANUAL for a stub-pending and for a MANUAL coding answer`, async () => {
        const mod = jest.requireActual<typeof import('./review-decisions.service')>(
          './review-decisions.service',
        );
        const ctx =
          jest.requireActual<typeof import('../database/org-context')>('../database/org-context');
        const prismaMod = jest.requireActual<typeof import('../database/prisma.service')>(
          '../database/prisma.service',
        );
        const stateMod = jest.requireActual<typeof import('../session/session-state.service')>(
          '../session/session-state.service',
        );
        const orgContext = app.get(ctx.OrgContextService);
        const svc = new mod.ReviewDecisionsService(
          app.get(prismaMod.PrismaService),
          orgContext,
          app.get(stateMod.SessionStateService),
          { get: (k: string) => cfg[k] } as never,
        );
        const real = await make(UserRole.REVIEWER);
        const s = await seedSession();
        const pending = await seedAnswer(s, {
          type: 'CODING',
          position: 1,
          scoring: 'MANUAL_PENDING',
          score: null,
          scoringNote: 'not graded (local stub)',
        });
        const manual = await seedAnswer(s, {
          type: 'CODING',
          position: 2,
          scoring: 'MANUAL_PENDING',
          score: null,
          scoringNote: 'not graded (local stub)',
        });
        // The check constraint ties MANUAL to scored_by and scored_at: set all three together.
        await owner.sessionQuestion.update({
          where: { id: manual },
          data: { scoring: 'MANUAL', score: '10.00', scoredById: real.id, scoredAt: new Date() },
        });
        for (const id of [pending, manual]) {
          await expect(
            orgContext.runAsUser({ orgId: orgA, userId: real.id, role: UserRole.REVIEWER }, () =>
              svc.scoreAnswer({ id: real.id, orgId: orgA }, undefined, s.sessionId, id, {
                correct: true,
              }),
            ),
          ).rejects.toMatchObject({ code: 'ANSWER_NOT_MANUAL' });
        }
        const row = await owner.sessionQuestion.findUniqueOrThrow({ where: { id: pending } });
        expect(row).toMatchObject({ scoring: 'MANUAL_PENDING', score: null });
      });
    }
  });

  describe('FR-902, TC-099: verdict', () => {
    it('TC-099: 409 MANUAL_PENDING while an answer waits (status stays UNDER_REVIEW, no review row); 200 after every answer is decided', async () => {
      const s = await seedPendingSession();
      const who = await make(UserRole.REVIEWER);
      const blocked = await http()
        .post(verdictUrl(s.sessionId))
        .set(who.auth)
        .send({ verdict: 'CLEAN' })
        .expect(409);
      expect(blocked.body).toMatchObject({ code: 'MANUAL_PENDING' });
      await http()
        .patch(scoreUrl(s.sessionId, s.a))
        .set(who.auth)
        .send({ correct: true })
        .expect(200);
      await http()
        .post(verdictUrl(s.sessionId))
        .set(who.auth)
        .send({ verdict: 'CLEAN' })
        .expect(409);
      expect((await sessionRow(s.sessionId)).status).toBe('UNDER_REVIEW');
      expect(await owner.sessionReview.count({ where: { sessionId: s.sessionId } })).toBe(0);
      await http()
        .patch(scoreUrl(s.sessionId, s.b))
        .set(who.auth)
        .send({ correct: false })
        .expect(200);
      const ok = await http()
        .post(verdictUrl(s.sessionId))
        .set(who.auth)
        .send({ verdict: 'SUSPICIOUS', note: '  Looked at the tab switches  ' })
        .expect(200);
      expect(ok.headers['cache-control']).toBe('no-store');
      expect(ok.body).toMatchObject({ verdict: 'SUSPICIOUS', notes: 'Looked at the tab switches' });
      expect(typeof (ok.body as Json).completedAt).toBe('string');
      expect((await sessionRow(s.sessionId)).status).toBe('COMPLETED');
      const review = await owner.sessionReview.findFirstOrThrow({
        where: { sessionId: s.sessionId },
      });
      expect(review).toMatchObject({ reviewerId: who.id, verdict: 'SUSPICIOUS' });
      expect(review.completedAt).not.toBeNull();
      const audit = await owner.auditLog.findFirstOrThrow({
        where: { entityId: s.sessionId, action: 'REVIEW_VERDICT_SET' },
      });
      expect(audit).toMatchObject({ actorId: who.id, orgId: orgA });
      expect(audit.metadata).toEqual({ verdict: 'SUSPICIOUS' });
      expect(JSON.stringify(audit.metadata)).not.toContain('tab switches');
    });

    it('FR-902: each Verdict value works, for REVIEWER and SUPER_ADMIN; a second verdict is 409 VERDICT_ALREADY_SET and the first stands', async () => {
      const reviewer = await make(UserRole.REVIEWER);
      const admin = await make(UserRole.SUPER_ADMIN);
      const runs = [
        [reviewer, 'CLEAN'],
        [admin, 'VIOLATION'],
      ] as const;
      for (const [who, verdict] of runs) {
        const sess = await seedSession();
        const res = await http()
          .post(verdictUrl(sess.sessionId))
          .set(who.auth)
          .send({ verdict })
          .expect(200);
        expect(res.body).toMatchObject({ verdict, notes: null });
        const again = await http()
          .post(verdictUrl(sess.sessionId))
          .set(who.auth)
          .send({ verdict: 'CLEAN' })
          .expect(409);
        expect(again.body).toMatchObject({ code: 'VERDICT_ALREADY_SET' });
        const review = await owner.sessionReview.findFirstOrThrow({
          where: { sessionId: sess.sessionId },
        });
        expect(review.verdict).toBe(verdict);
      }
    });

    it('FR-902: a session that is not UNDER_REVIEW is 409 SESSION_NOT_UNDER_REVIEW; a review row already present is VERDICT_ALREADY_SET and the status stays', async () => {
      const who = await make(UserRole.REVIEWER);
      for (const status of ['GRADED', 'SUBMITTED', 'IN_PROGRESS'] as const) {
        const sess = await seedSession({ status });
        const res = await http()
          .post(verdictUrl(sess.sessionId))
          .set(who.auth)
          .send({ verdict: 'CLEAN' })
          .expect(409);
        expect(res.body).toMatchObject({ code: 'SESSION_NOT_UNDER_REVIEW' });
        expect((await sessionRow(sess.sessionId)).status).toBe(status);
      }
      const done = await seedSession({ status: 'COMPLETED' });
      const res = await http()
        .post(verdictUrl(done.sessionId))
        .set(who.auth)
        .send({ verdict: 'CLEAN' })
        .expect(409);
      expect(res.body).toMatchObject({ code: 'VERDICT_ALREADY_SET' });
      const odd = await seedSession();
      await owner.sessionReview.create({
        data: { sessionId: odd.sessionId, reviewerId: who.id, verdict: 'CLEAN' },
      });
      const res2 = await http()
        .post(verdictUrl(odd.sessionId))
        .set(who.auth)
        .send({ verdict: 'VIOLATION' })
        .expect(409);
      expect(res2.body).toMatchObject({ code: 'VERDICT_ALREADY_SET' });
      expect((await sessionRow(odd.sessionId)).status).toBe('UNDER_REVIEW');
    });

    it('FR-205: after the verdict a decision cannot change (VERDICT_ALREADY_SET) and the total is unchanged', async () => {
      const s = await seedPendingSession();
      const who = await make(UserRole.REVIEWER);
      for (const id of [s.a, s.b]) {
        await http()
          .patch(scoreUrl(s.sessionId, id))
          .set(who.auth)
          .send({ correct: true })
          .expect(200);
      }
      await http()
        .post(verdictUrl(s.sessionId))
        .set(who.auth)
        .send({ verdict: 'CLEAN' })
        .expect(200);
      const before = await total(s.sessionId);
      const res = await http()
        .patch(scoreUrl(s.sessionId, s.a))
        .set(who.auth)
        .send({ correct: false })
        .expect(409);
      expect(res.body).toMatchObject({ code: 'VERDICT_ALREADY_SET' });
      expect(await total(s.sessionId)).toBe(before);
      const row = await owner.sessionQuestion.findUniqueOrThrow({ where: { id: s.a } });
      expect(row.score?.toFixed(2)).toBe('50.00');
    });
  });

  // ---- concurrency ------------------------------------------------------------------------------

  describe('FR-205, FR-902: concurrency under the session lock (contract section 7)', () => {
    it('FR-205: two scorers on different answers of one session leave total_score equal to the sum of the scores', async () => {
      const who = await make(UserRole.REVIEWER);
      const other = await make(UserRole.SUPER_ADMIN);
      for (let i = 0; i < 5; i++) {
        const s = await seedPendingSession();
        const [r1, r2] = await Promise.all([
          http().patch(scoreUrl(s.sessionId, s.a)).set(who.auth).send({ correct: true }),
          http().patch(scoreUrl(s.sessionId, s.b)).set(other.auth).send({ correct: true }),
        ]);
        expect([r1.status, r2.status]).toEqual([200, 200]);
        expect(await total(s.sessionId)).toBe('95.00');
      }
    });

    it('FR-205: two scorers on the same answer both succeed, the last wins, and previousCorrect chains', async () => {
      const who = await make(UserRole.REVIEWER);
      const other = await make(UserRole.SUPER_ADMIN);
      const s = await seedPendingSession();
      await http()
        .patch(scoreUrl(s.sessionId, s.b))
        .set(who.auth)
        .send({ correct: true })
        .expect(200);
      const [r1, r2] = await Promise.all([
        http().patch(scoreUrl(s.sessionId, s.a)).set(who.auth).send({ correct: true }),
        http().patch(scoreUrl(s.sessionId, s.a)).set(other.auth).send({ correct: false }),
      ]);
      expect([r1.status, r2.status]).toEqual([200, 200]);
      const row = await owner.sessionQuestion.findUniqueOrThrow({ where: { id: s.a } });
      const sum = (row.score?.toNumber() ?? NaN) + 30 + 10 + 5;
      expect(await total(s.sessionId)).toBe(sum.toFixed(2));
      const audits = await owner.auditLog.findMany({
        where: { entityId: s.sessionId, action: 'ANSWER_SCORED_MANUALLY' },
        orderBy: { id: 'asc' },
      });
      const forA = audits.filter((a) => (a.metadata as Json).sessionQuestionId === s.a);
      expect(forA).toHaveLength(2);
      const prevs = forA.map((a) => (a.metadata as Json).previousCorrect);
      expect(prevs[0]).toBeNull();
      expect(prevs[1]).toBe((forA[0]?.metadata as Json).correct);
    });

    it('FR-902, TC-099: a verdict racing the last decision either waits for it or is refused; never a verdict with a pending answer or a stale total', async () => {
      const who = await make(UserRole.REVIEWER);
      const other = await make(UserRole.SUPER_ADMIN);
      for (let i = 0; i < 6; i++) {
        const s = await seedPendingSession();
        await http()
          .patch(scoreUrl(s.sessionId, s.a))
          .set(who.auth)
          .send({ correct: true })
          .expect(200);
        const [score, verdict] = await Promise.all([
          http().patch(scoreUrl(s.sessionId, s.b)).set(who.auth).send({ correct: true }),
          http().post(verdictUrl(s.sessionId)).set(other.auth).send({ verdict: 'CLEAN' }),
        ]);
        expect(score.status).toBe(200);
        const rows = await owner.sessionQuestion.findMany({ where: { sessionId: s.sessionId } });
        expect(rows.every((r) => r.scoring !== 'MANUAL_PENDING')).toBe(true);
        if (verdict.status === 200) {
          expect((await sessionRow(s.sessionId)).status).toBe('COMPLETED');
          expect(await total(s.sessionId)).toBe('95.00');
          expect(await owner.sessionReview.count({ where: { sessionId: s.sessionId } })).toBe(1);
        } else {
          expect(verdict.status).toBe(409);
          expect(verdict.body).toMatchObject({ code: 'MANUAL_PENDING' });
          expect((await sessionRow(s.sessionId)).status).toBe('UNDER_REVIEW');
          expect(await owner.sessionReview.count({ where: { sessionId: s.sessionId } })).toBe(0);
        }
      }
    });

    it('FR-205, FR-902: a changed decision racing the verdict: one order wins and the stored total always equals the stored scores', async () => {
      const who = await make(UserRole.REVIEWER);
      const other = await make(UserRole.SUPER_ADMIN);
      for (let i = 0; i < 6; i++) {
        const s = await seedPendingSession();
        for (const id of [s.a, s.b]) {
          await http()
            .patch(scoreUrl(s.sessionId, id))
            .set(who.auth)
            .send({ correct: true })
            .expect(200);
        }
        const [score, verdict] = await Promise.all([
          http().patch(scoreUrl(s.sessionId, s.a)).set(who.auth).send({ correct: false }),
          http().post(verdictUrl(s.sessionId)).set(other.auth).send({ verdict: 'VIOLATION' }),
        ]);
        expect(verdict.status).toBe(200);
        expect([200, 409]).toContain(score.status);
        if (score.status === 409) {
          expect(score.body).toMatchObject({ code: 'VERDICT_ALREADY_SET' });
        }
        const rows = await owner.sessionQuestion.findMany({ where: { sessionId: s.sessionId } });
        const sum = rows.reduce((acc, r) => acc + (r.score?.toNumber() ?? 0), 0);
        expect(await total(s.sessionId)).toBe(sum.toFixed(2));
        expect(sum).toBe(score.status === 200 ? 45 : 95);
      }
    });
  });
});
