// DB-04 development seed, checked against the docs it serves (docs/database.md, FR-201, FR-203,
// FR-804, ADR 0007). Runs the seed applier against a throwaway Postgres as app_user, the role
// `pnpm db:seed` prefers. The localhost and APP_ENV guards live in prisma/seed/guard.ts and are
// covered by infra/scripts/seed.test.mjs; this file never calls them with a real URL.
import { resolve } from 'node:path';
import request from 'supertest';
import { applySeed, countRows } from '../../../../prisma/seed/apply';
import { DEMO_PASSWORD } from '../../../../prisma/seed/guard';
import { loadPasswordHasher } from '../../../../prisma/seed/passwords';
import { buildSeedPlan } from '../../../../prisma/seed/plan';
import { createPrismaClient } from '../../src/database/create-prisma-client';
import { API, Body, boot, Harness } from '../support/harness';

describe('DB-04 seed (supports TC-001, TC-003; seeded data for FR-201, FR-804)', () => {
  let h: Harness;
  let appClient: ReturnType<typeof createPrismaClient>;
  const plan = buildSeedPlan(new Date());
  const hash = loadPasswordHasher(resolve(__dirname, '../../../..'));

  beforeAll(async () => {
    h = await boot();
    appClient = createPrismaClient(h.appUserUrl);
    await applySeed(appClient, plan, hash);
  });
  afterAll(async () => {
    await appClient?.$disconnect();
    await h?.close();
  });

  it('DB-04: a second run inserts nothing and changes no row count', async () => {
    const before = await countRows(appClient);
    const inserted = await applySeed(appClient, plan, hash);
    expect(Object.values(inserted).reduce((a, b) => a + b, 0)).toBe(0);
    expect(await countRows(appClient)).toEqual(before);
  });

  it('TC-001: all four seeded staff accounts sign in with the development password; roles needing 2FA are forced to enroll (TC-003)', async () => {
    const outcomes: Record<string, string> = {};
    for (const user of plan.content.staff) {
      const res = await request(h.app.getHttpServer())
        .post(`${API}/auth/login`)
        .send({ email: user.email, password: DEMO_PASSWORD })
        .expect(200);
      outcomes[user.role] = (res.body as Body).status;
    }
    expect(outcomes).toEqual({
      SUPER_ADMIN: 'two_factor_enrollment_required',
      RECRUITER: 'authenticated',
      AUTHOR: 'authenticated',
      REVIEWER: 'two_factor_enrollment_required',
    });
  });

  it('FR-101: seeded passwords are Argon2id and the development password is not stored in clear', async () => {
    const users = await appClient.user.findMany();
    expect(users).toHaveLength(4);
    for (const u of users) {
      expect(u.passwordHash).toMatch(/^\$argon2id\$/);
      expect(JSON.stringify(u)).not.toContain(DEMO_PASSWORD);
    }
  });

  it('FR-201: every seeded coding question has a current version with 3 sample and 8 hidden test cases and 3 variants (FR-201, FR-203)', async () => {
    const questions = await appClient.question.findMany({ where: { type: 'CODING' } });
    expect(questions).toHaveLength(6);
    for (const q of questions) {
      const versionId = q.currentVersionId ?? '';
      expect(versionId).not.toBe('');
      const cases = await appClient.testCase.findMany({ where: { questionVersionId: versionId } });
      expect(cases.filter((c) => !c.isHidden)).toHaveLength(3);
      expect(cases.filter((c) => c.isHidden)).toHaveLength(8);
      expect(
        await appClient.questionVariant.count({ where: { questionVersionId: versionId } }),
      ).toBe(3);
    }
  });

  it('FR-804: every stored session risk band matches its score under FR-804 (0-29 LOW, 30-59 MEDIUM, 60-100 HIGH)', async () => {
    const sessions = await appClient.session.findMany({ where: { riskScore: { not: null } } });
    expect(sessions.length).toBeGreaterThanOrEqual(3);
    const bands = new Set<string>();
    for (const s of sessions) {
      const score = s.riskScore ?? 0;
      const expected = score >= 60 ? 'HIGH' : score >= 30 ? 'MEDIUM' : 'LOW';
      expect(s.riskBand).toBe(expected);
      bands.add(expected);
    }
    expect([...bands].sort()).toEqual(['HIGH', 'LOW', 'MEDIUM']);
  });
});
