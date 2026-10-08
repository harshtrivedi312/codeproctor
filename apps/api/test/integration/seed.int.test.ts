// DB-04 development seed, checked against the docs it serves (docs/database.md, FR-201, FR-203,
// FR-804, ADR 0007). Runs the seed applier against a throwaway Postgres as app_user, the role
// `pnpm db:seed` prefers. The localhost and APP_ENV guards live in prisma/seed/guard.ts and are
// covered by infra/scripts/seed.test.mjs; this file never calls them with a real URL.
import { resolve } from 'node:path';
import request from 'supertest';
import { applyApprovedDemoConsent, applySeed, countRows } from '../../../../prisma/seed/apply';
import {
  DEMO_APPROVED_CONSENT_APPROVED_BY,
  DEMO_APPROVED_CONSENT_VERSION,
  buildApprovedDemoConsentText,
} from '../../../../prisma/seed/demo-consent';
import { DEMO_PASSWORD, SeedRefusal } from '../../../../prisma/seed/guard';
import { ID } from '../../../../prisma/seed/ids';
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

  it('TC-001: all four seeded staff accounts sign in with the development password; every role signs in with the password alone since 2FA is optional (TC-003, FR-102)', async () => {
    const outcomes: Record<string, string> = {};
    for (const user of plan.content.staff) {
      const res = await request(h.app.getHttpServer())
        .post(`${API}/auth/login`)
        .send({ email: user.email, password: DEMO_PASSWORD })
        .expect(200);
      outcomes[user.role] = (res.body as Body).status;
    }
    expect(outcomes).toEqual({
      SUPER_ADMIN: 'authenticated',
      RECRUITER: 'authenticated',
      AUTHOR: 'authenticated',
      REVIEWER: 'authenticated',
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

  // D-69 (owner decision 2026-10-08): the dev-only approved demo consent text. The API chooses the
  // current text by organizations.current_consent_text_id and treats a row as approved when
  // legal_approved_at is not null (apps/api/src/candidate/consent.service.ts), so these assert the DB
  // state the API reads. The gate is APP_ENV === 'development' exactly.
  describe('D-69 approved demo consent text (dev only, APP_ENV gated)', () => {
    const DEV = { APP_ENV: 'development' };
    const demoId = ID.approvedConsentText;

    // Copies of apps/web/src/features/consent/placeholder-guard.ts (that file must pass on this body
    // unchanged; a cross-package import is not available here). If the guard changes, update these.
    const BRACKET_FILL_IN = /\[(?=[^\]\n]*[^\s\]])[^\]\n]*\](?!\()/;
    const DRAFT_WORDS = /\b(placeholder|draft|lorem ipsum|todo|tbd)\b/i;
    const EXAMPLE_ADDRESS = /@example\.(com|org|net)\b/i;
    const NOT_APPROVED_PHRASES =
      /\b(not (yet )?(been )?(approved|reviewed)|pending (legal )?approval|for owner approval)\b/i;

    it('D-69: with APP_ENV=development the row is written, approved, and becomes the org current text', async () => {
      const result = await applyApprovedDemoConsent(appClient, DEV);
      expect(result.madeCurrent).toBe(true);
      const org = await appClient.organization.findUniqueOrThrow({
        where: { id: ID.org },
        select: { currentConsentTextId: true },
      });
      expect(org.currentConsentTextId).toBe(demoId);
      const row = await appClient.consentText.findUniqueOrThrow({
        where: { orgId_version: { orgId: ID.org, version: DEMO_APPROVED_CONSENT_VERSION } },
        select: { id: true, legalApprovedAt: true, legalApprovedBy: true },
      });
      expect(row.id).toBe(demoId);
      expect(row.legalApprovedAt).not.toBeNull();
      expect(row.legalApprovedBy).toBe(DEMO_APPROVED_CONSENT_APPROVED_BY);
    });

    it('D-69: a second development run adds no row and keeps the org pointed at the demo text (idempotent, no reset)', async () => {
      await applyApprovedDemoConsent(appClient, DEV);
      const before = await appClient.consentText.count({ where: { orgId: ID.org } });
      const result = await applyApprovedDemoConsent(appClient, DEV);
      expect(result.inserted).toBe(0);
      expect(await appClient.consentText.count({ where: { orgId: ID.org } })).toBe(before);
      const org = await appClient.organization.findUniqueOrThrow({
        where: { id: ID.org },
        select: { currentConsentTextId: true },
      });
      expect(org.currentConsentTextId).toBe(demoId);
    });

    it.each([
      ['staging', { APP_ENV: 'staging' }],
      ['pilot', { APP_ENV: 'pilot' }],
      ['production', { APP_ENV: 'production' }],
      ['empty', { APP_ENV: '' }],
      ['unset', {}],
      ['wrong case', { APP_ENV: 'Development' }],
    ])(
      'D-69: APP_ENV=%s refuses to write the row and changes nothing (Q-28)',
      async (_label, env) => {
        await applyApprovedDemoConsent(appClient, DEV); // ensure a known starting state
        const before = await appClient.consentText.count({ where: { orgId: ID.org } });
        const orgBefore = await appClient.organization.findUniqueOrThrow({
          where: { id: ID.org },
          select: { currentConsentTextId: true },
        });
        await expect(applyApprovedDemoConsent(appClient, env)).rejects.toBeInstanceOf(SeedRefusal);
        expect(await appClient.consentText.count({ where: { orgId: ID.org } })).toBe(before);
        const orgAfter = await appClient.organization.findUniqueOrThrow({
          where: { id: ID.org },
          select: { currentConsentTextId: true },
        });
        expect(orgAfter.currentConsentTextId).toBe(orgBefore.currentConsentTextId);
      },
    );

    it('D-69/C-09: the demo body passes the web placeholder guard (no fill-ins, draft words, example address or unapproved phrases) and is long enough', () => {
      const row = buildApprovedDemoConsentText();
      expect(row.legalApprovedAt).not.toBeNull();
      expect(row.bodyMd.trim().length).toBeGreaterThanOrEqual(200);
      expect(DEMO_APPROVED_CONSENT_VERSION.trim()).not.toBe('');
      for (const re of [BRACKET_FILL_IN, DRAFT_WORDS, EXAMPLE_ADDRESS, NOT_APPROVED_PHRASES]) {
        expect(row.bodyMd).not.toMatch(re);
      }
      expect(DEMO_APPROVED_CONSENT_VERSION).not.toMatch(BRACKET_FILL_IN);
      expect(DEMO_APPROVED_CONSENT_VERSION).not.toMatch(DRAFT_WORDS);
      // A markdown-link "[text](url)" would be allowed, but the body uses none; an empty "[ ]" is fine.
      expect(row.bodyMd).not.toContain('[');
    });
  });
});
