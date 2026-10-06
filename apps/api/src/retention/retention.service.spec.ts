// RetentionService, face tier and media tier (FR-704, NFR-05, TC-072; ADR 0004 9.2; C-04, C-27, C-35).
// A real Postgres 16 with the real migrations, the code under test connecting as app_user through
// the real client factory and the org-scope extension, and an in-memory object store. Docker is
// required. Synthetic data only. Every test gets fresh tenants, so no test depends on another.
import { Logger } from '@nestjs/common';
import type { PrismaClient } from '../generated/prisma/client.js';
import type { SessionStatus } from '../generated/prisma/enums.js';
import { createPrismaClient } from '../database/create-prisma-client';
import { OrgContextService } from '../database/org-context';
import { createOrgScopedClient } from '../database/org-scope.extension';
import type { PrismaService } from '../database';
import { startMigratedDatabase } from '../database/testing/migrated-postgres';
import type { MigratedDatabase } from '../database/testing/migrated-postgres';
import { createTenant } from '../database/testing/tenant-fixtures';
import type { TenantFixture } from '../database/testing/tenant-fixtures';
import { LegalHoldPort, NoLegalHold } from './legal-hold.port';
import { loadRetentionConfig } from './retention.config';
import { RETENTION_MARKER_ACTIONS, sessionPrefix } from './retention.constants';
import { RetentionRepository, TERMINAL_TRANSITION_ACTIONS } from './retention.repository';
import { RetentionService } from './retention.service';
import { InMemoryObjectStore } from './testing/in-memory-object-store';

const DAY = 86_400_000;
const NOW = new Date('2026-10-05T12:00:00.000Z');
const daysAgo = (n: number): Date => new Date(NOW.getTime() - n * DAY);

describe('RetentionService: face and media tiers (FR-704, NFR-05, TC-072)', () => {
  let db: MigratedDatabase;
  let owner: PrismaClient;
  let app: PrismaClient;
  let orgContext: OrgContextService;
  let A: TenantFixture;
  let B: TenantFixture;
  let store: InMemoryObjectStore;
  let counter = 0;

  const sessionIdOf = (t: TenantFixture): string => (t.rows.Session.unique as { id: string }).id;
  const keys = (t: TenantFixture) => {
    const s = sessionPrefix(t.orgId, sessionIdOf(t));
    return {
      root: s,
      idImage: `${s}identity/1/sealed/id-A.jpg`,
      selfie: `${s}identity/1/sealed/selfie-A.jpg`,
      sealed: `${s}evidence/sealed/F1.jpg`,
      evidence: `${s}evidence/E1.jpg`,
      media: `${s}media/SCREEN/000000/00000000.webm`,
      report: `${s}reports/R1.pdf`,
      live: `${s}live/L1.jpg`,
    };
  };

  function build(
    overrides: Record<string, string> = {},
    legalHold: LegalHoldPort = new NoLegalHold(),
  ) {
    const prisma = { client: createOrgScopedClient(app, orgContext) } as unknown as PrismaService;
    const repo = new RetentionRepository(prisma, orgContext);
    return {
      repo,
      service: new RetentionService(repo, store, legalHold, loadRetentionConfig(overrides)),
    };
  }

  /** Puts a tenant's session into a state: dates, status, org setting, DB keys and the matching objects. */
  async function setup(
    t: TenantFixture,
    opts: {
      submittedDaysAgo?: number | null;
      anchorDaysAgo?: number | null;
      retentionDays?: number;
      status?: SessionStatus;
      mismatchEvent?: boolean;
      /** The fixture's appeal is OPEN; by default it is closed so only the clocks decide. */
      openAppeal?: boolean;
    } = {},
  ): Promise<void> {
    const sessionId = sessionIdOf(t);
    const k = keys(t);
    await owner.organization.update({
      where: { id: t.orgId },
      data: { retentionDays: opts.retentionDays ?? 90 },
    });
    await owner.session.update({
      where: { id: sessionId },
      data: {
        status: opts.status ?? 'COMPLETED',
        createdAt: daysAgo(1000),
        submittedAt: opts.submittedDaysAgo == null ? null : daysAgo(opts.submittedDaysAgo),
        retentionAnchorAt: opts.anchorDaysAgo == null ? null : daysAgo(opts.anchorDaysAgo),
        reportKey: k.report,
      },
    });
    await owner.appeal.updateMany({
      where: { sessionReview: { sessionId } },
      data: { status: opts.openAppeal ? 'OPEN' : 'UPHELD' },
    });
    await owner.identityCheck.updateMany({
      where: { sessionId },
      data: { idImageKey: k.idImage, selfieKey: k.selfie },
    });
    await owner.mediaChunk.updateMany({
      where: { sessionId },
      data: { objectKey: k.media, deletedAt: null },
    });
    await owner.proctorEvent.deleteMany({ where: { sessionId, type: 'FACE_MISMATCH' } });
    if (opts.mismatchEvent !== false) {
      await owner.proctorEvent.create({
        data: {
          sessionId,
          type: 'FACE_MISMATCH',
          severity: 'HIGH',
          occurredAt: daysAgo(900),
          evidenceKey: k.sealed,
        },
      });
    }
    await owner.proctorEvent.updateMany({
      where: { sessionId, type: 'TAB_SWITCH' },
      data: { evidenceKey: k.evidence },
    });
    await owner.keystrokeBatch.deleteMany({ where: { sessionId } });
    await owner.keystrokeBatch.create({
      data: { sessionId, seq: 1, signature: Buffer.from('s'), startedAt: NOW, events: [] },
    });
    store.put(k.idImage, k.selfie, k.sealed, k.evidence, k.media, k.report, k.live);
  }

  const markers = (t: TenantFixture) =>
    owner.auditLog.findMany({
      where: {
        entityType: 'session',
        entityId: sessionIdOf(t),
        action: { in: Object.values(RETENTION_MARKER_ACTIONS) },
      },
    });

  beforeAll(async () => {
    db = await startMigratedDatabase();
    owner = createPrismaClient(db.ownerUrl);
    app = createPrismaClient(db.appUserUrl);
    orgContext = new OrgContextService();
  }, 180_000);

  afterAll(async () => {
    await app?.$disconnect();
    await owner?.$disconnect();
    await db?.stop();
  });

  beforeEach(async () => {
    store = new InMemoryObjectStore();
    counter++;
    A = await createTenant(owner, `ret-a-${counter}`);
    B = await createTenant(owner, `ret-b-${counter}`);
  });

  afterEach(async () => {
    // Make every session of this test too young to be selected by a later test's run.
    await owner.session.updateMany({
      data: { createdAt: NOW, submittedAt: NOW, retentionAnchorAt: null },
    });
  });

  describe('face tier (C-27, C-35)', () => {
    it('TC-072: at submission + 90 days it deletes identity and sealed frames, nulls their keys, and writes the marker', async () => {
      await setup(A, { submittedDaysAgo: 91, retentionDays: 365 });
      const { service } = build();
      const summary = await service.runDaily(NOW);
      expect(summary.face).toMatchObject({ due: 1, completed: 1, retryLater: 0 });
      const k = keys(A);
      expect(store.keys.has(k.idImage)).toBe(false);
      expect(store.keys.has(k.selfie)).toBe(false);
      expect(store.keys.has(k.sealed)).toBe(false);
      expect(store.keys.has(k.evidence)).toBe(true); // OQ-19 off by default: event frames stay with the media tier
      expect(store.keys.has(k.media)).toBe(true); // recordings are the media tier's
      expect(store.keys.has(k.report)).toBe(true);
      const sessionId = sessionIdOf(A);
      const checks = await owner.identityCheck.findMany({ where: { sessionId } });
      expect(checks.every((c) => c.idImageKey === null && c.selfieKey === null)).toBe(true);
      const mismatch = await owner.proctorEvent.findMany({
        where: { sessionId, type: 'FACE_MISMATCH' },
      });
      expect(mismatch.every((e) => e.evidenceKey === null)).toBe(true);
      const event = await owner.proctorEvent.findFirstOrThrow({
        where: { sessionId, type: 'TAB_SWITCH' },
      });
      expect(event.evidenceKey).toBe(k.evidence);
      const found = await markers(A);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({
        action: 'RETENTION_FACE_DONE',
        entityType: 'session',
        entityId: sessionId,
        orgId: A.orgId,
        actorId: null,
      });
      expect(Object.keys((found[0]?.metadata ?? {}) as object).sort()).toEqual(['runId', 'tier']);
    });

    it('OQ-19: with the switch on, event frames go with the face tier', async () => {
      await setup(A, { submittedDaysAgo: 100 });
      await build({ RETENTION_EVIDENCE_IN_FACE_TIER: 'true' }).service.runDaily(NOW);
      expect(store.keys.has(keys(A).evidence)).toBe(false);
      const event = await owner.proctorEvent.findFirstOrThrow({
        where: { sessionId: sessionIdOf(A), type: 'TAB_SWITCH' },
      });
      expect(event.evidenceKey).toBeNull();
    });

    it('C-35: a hold (no anchor) does not delay it: the cap runs from submission whatever a review says', async () => {
      await setup(A, {
        submittedDaysAgo: 91,
        anchorDaysAgo: null,
        retentionDays: 730,
        status: 'UNDER_REVIEW',
      });
      expect((await build().service.runDaily(NOW)).face.completed).toBe(1);
    });

    it('C-27: the boundary is exact, a long org retention never extends it, a short one shortens it', async () => {
      await setup(A, { submittedDaysAgo: 89.99, retentionDays: 730 });
      expect((await build().service.runDaily(NOW)).face.due).toBe(0);
      await setup(A, { submittedDaysAgo: 90, retentionDays: 730 });
      expect((await build().service.runDaily(NOW)).face.completed).toBe(1);
      await setup(B, { submittedDaysAgo: 40, retentionDays: 30 });
      expect((await build().service.runDaily(NOW)).face.completed).toBe(1);
    });

    it('NFR-05: an orphan object with no database row is deleted too (selection is by session, not by key)', async () => {
      await setup(A, { submittedDaysAgo: 100 });
      const orphan = `${keys(A).root}identity/2/id-ORPHAN.jpg`;
      store.put(orphan);
      await build().service.runDaily(NOW);
      expect(store.keys.has(orphan)).toBe(false);
    });

    it('a session with no objects at all is still marked once the listing is verified empty', async () => {
      await setup(A, { submittedDaysAgo: 100 });
      store.keys.clear();
      expect((await build().service.runDaily(NOW)).face.completed).toBe(1);
    });

    describe('the face clock fallbacks (ADR 0004 9.2)', () => {
      it('never submitted: the latest capture decides (identity check and FACE_MISMATCH, whichever is newer)', async () => {
        await setup(A, { submittedDaysAgo: null });
        const sessionId = sessionIdOf(A);
        await owner.identityCheck.updateMany({
          where: { sessionId },
          data: { createdAt: daysAgo(10) },
        });
        await owner.proctorEvent.updateMany({
          where: { sessionId, type: 'FACE_MISMATCH' },
          data: { occurredAt: daysAgo(10) },
        });
        expect((await build().service.runDaily(NOW)).face.due).toBe(0);
        await owner.identityCheck.updateMany({
          where: { sessionId },
          data: { createdAt: daysAgo(95) },
        });
        await owner.proctorEvent.updateMany({
          where: { sessionId, type: 'FACE_MISMATCH' },
          data: { occurredAt: daysAgo(95) },
        });
        expect((await build().service.runDaily(NOW)).face.completed).toBe(1);
      });

      it('GREATEST ignores a missing side: an identity check alone, or a FACE_MISMATCH alone, is enough', async () => {
        await setup(A, { submittedDaysAgo: null, mismatchEvent: false });
        await owner.identityCheck.updateMany({
          where: { sessionId: sessionIdOf(A) },
          data: { createdAt: daysAgo(95) },
        });
        await setup(B, { submittedDaysAgo: null });
        await owner.identityCheck.deleteMany({ where: { sessionId: sessionIdOf(B) } });
        await owner.proctorEvent.updateMany({
          where: { sessionId: sessionIdOf(B), type: 'FACE_MISMATCH' },
          data: { occurredAt: daysAgo(95) },
        });
        expect((await build().service.runDaily(NOW)).face.completed).toBe(2);
      });

      it('no capture at all: the first terminal transition decides, not the creation time', async () => {
        await setup(A, { submittedDaysAgo: null, mismatchEvent: false, status: 'EXPIRED' });
        const sessionId = sessionIdOf(A);
        await owner.identityCheck.deleteMany({ where: { sessionId } });
        const [action] = TERMINAL_TRANSITION_ACTIONS;
        const row = await owner.auditLog.create({
          data: {
            orgId: A.orgId,
            action: action ?? 'x',
            entityType: 'session',
            entityId: sessionId,
            createdAt: daysAgo(10),
          },
        });
        expect((await build().service.runDaily(NOW)).face.due).toBe(0); // expired 10 days ago, created 1000
        await owner.auditLog.update({ where: { id: row.id }, data: { createdAt: daysAgo(95) } });
        expect((await build().service.runDaily(NOW)).face.completed).toBe(1);
      });

      it('nothing else: the creation time is the last fallback', async () => {
        await setup(A, { submittedDaysAgo: null, mismatchEvent: false, status: 'EXPIRED' });
        const sessionId = sessionIdOf(A);
        await owner.identityCheck.deleteMany({ where: { sessionId } });
        await owner.session.update({ where: { id: sessionId }, data: { createdAt: daysAgo(95) } });
        expect((await build().service.runDaily(NOW)).face.completed).toBe(1);
      });
    });

    it('a session that can still capture (INVITED, IN_PROGRESS...) is never marked, however old (B1)', async () => {
      for (const status of [
        'INVITED',
        'OPENED',
        'CONSENTED',
        'VERIFIED',
        'IN_PROGRESS',
        'PAUSED',
      ] as const) {
        await setup(A, { submittedDaysAgo: null, status });
        await owner.session.update({
          where: { id: sessionIdOf(A) },
          data: { createdAt: daysAgo(500) },
        });
        await owner.identityCheck.deleteMany({ where: { sessionId: sessionIdOf(A) } });
        await owner.proctorEvent.deleteMany({
          where: { sessionId: sessionIdOf(A), type: 'FACE_MISMATCH' },
        });
        expect((await build().service.runDaily(NOW)).face.due).toBe(0);
        expect(await markers(A)).toHaveLength(0);
      }
      // Once it can no longer capture, the images that arrived late are covered.
      await owner.session.update({ where: { id: sessionIdOf(A) }, data: { status: 'EXPIRED' } });
      expect((await build().service.runDaily(NOW)).face.completed).toBe(1);
    });

    it('NFR-05: a stored key outside the session prefix is not nulled away: the tier waits for a person', async () => {
      await setup(A, { submittedDaysAgo: 100 });
      await owner.identityCheck.updateMany({
        where: { sessionId: sessionIdOf(A) },
        data: { selfieKey: 'legacy/other-place/selfie.jpg' },
      });
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      expect((await build().service.runDaily(NOW)).face).toMatchObject({
        completed: 0,
        retryLater: 1,
      });
      expect(await markers(A)).toHaveLength(0);
      expect(warn.mock.calls.map((c) => String(c[0])).join()).not.toContain('legacy');
      warn.mockRestore();
    });
  });

  describe('media tier (R-4; C-04)', () => {
    it('TC-072: at anchor + retention_days it deletes everything except reports/, nulls the keys and writes the marker', async () => {
      await setup(A, { submittedDaysAgo: 120, anchorDaysAgo: 91, retentionDays: 90 });
      const summary = await build().service.runDaily(NOW);
      expect(summary.face.completed).toBe(1);
      expect(summary.media.completed).toBe(1);
      const k = keys(A);
      expect(store.keys.has(k.media)).toBe(false);
      expect(store.keys.has(k.evidence)).toBe(false);
      expect(store.keys.has(k.live)).toBe(false);
      expect(store.keys.has(k.report)).toBe(true); // reports are R-10's (C-26)
      const sessionId = sessionIdOf(A);
      const chunks = await owner.mediaChunk.findMany({ where: { sessionId } });
      expect(chunks.every((c) => c.objectKey === null && c.deletedAt !== null)).toBe(true);
      expect(await owner.keystrokeBatch.count({ where: { sessionId } })).toBe(0);
      expect((await owner.session.findUniqueOrThrow({ where: { id: sessionId } })).reportKey).toBe(
        k.report,
      );
      expect((await markers(A)).map((m) => m.action).sort()).toEqual([
        'RETENTION_FACE_DONE',
        'RETENTION_MEDIA_DONE',
      ]);
    });

    it('NFR-05: a hold (no anchor) means the media tier is not due', async () => {
      await setup(A, { submittedDaysAgo: 120, anchorDaysAgo: null, retentionDays: 7 });
      expect((await build().service.runDaily(NOW)).media.due).toBe(0);
    });

    it('not due before the anchor + retention_days', async () => {
      await setup(A, { submittedDaysAgo: 120, anchorDaysAgo: 30, retentionDays: 90 });
      expect((await build().service.runDaily(NOW)).media.due).toBe(0);
      expect(store.keys.has(keys(A).media)).toBe(true);
    });

    it('OQ-18: with a 90-day cap, a 730-day org setting still deletes at 90', async () => {
      await setup(A, { submittedDaysAgo: 200, anchorDaysAgo: 100, retentionDays: 730 });
      expect((await build().service.runDaily(NOW)).media.due).toBe(0); // uncapped: 730 days
      expect(
        (await build({ RETENTION_MEDIA_CAP_DAYS: '90' }).service.runDaily(NOW)).media.completed,
      ).toBe(1);
    });

    it('R-2: a session UNDER_REVIEW or APPEALED, or with an open appeal, is never selected even with an anchor', async () => {
      for (const status of ['UNDER_REVIEW', 'APPEALED'] as const) {
        await setup(A, { submittedDaysAgo: 400, anchorDaysAgo: 300, retentionDays: 90, status });
        expect((await build().service.runDaily(NOW)).media.due).toBe(0);
        expect(store.keys.has(keys(A).media)).toBe(true);
      }
      await setup(A, {
        submittedDaysAgo: 400,
        anchorDaysAgo: 300,
        retentionDays: 90,
        openAppeal: true,
      });
      expect(
        await owner.appeal.count({
          where: { status: 'OPEN', sessionReview: { sessionId: sessionIdOf(A) } },
        }),
      ).toBe(1);
      expect((await build().service.runDaily(NOW)).media.due).toBe(0);
      await owner.appeal.updateMany({
        where: { sessionReview: { sessionId: sessionIdOf(A) } },
        data: { status: 'UPHELD' },
      });
      expect((await build().service.runDaily(NOW)).media.completed).toBe(1);
    });

    it('R-2: the hold states are read again right before deleting (selection can be stale)', async () => {
      await setup(A, { submittedDaysAgo: 400, anchorDaysAgo: 300, retentionDays: 90 });
      const { repo } = build();
      const check = () => repo.inOrg(A.orgId, () => repo.mediaStillEligible(sessionIdOf(A)));
      await owner.appeal.updateMany({
        where: { sessionReview: { sessionId: sessionIdOf(A) } },
        data: { status: 'UPHELD' },
      });
      expect(await check()).toBe(true);
      await owner.session.update({ where: { id: sessionIdOf(A) }, data: { status: 'APPEALED' } });
      expect(await check()).toBe(false);
      await owner.session.update({
        where: { id: sessionIdOf(A) },
        data: { status: 'COMPLETED', retentionAnchorAt: null },
      });
      expect(await check()).toBe(false);
    });
  });

  describe('verification, order, idempotence and safety (ADR 0004 9.2)', () => {
    it('NFR-05: a DeleteObjects error changes nothing and writes no marker; the next run completes it', async () => {
      await setup(A, { submittedDaysAgo: 100 });
      store.failDeleteFor.add(keys(A).idImage);
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const first = await build().service.runDaily(NOW);
      expect(first.face).toMatchObject({ due: 1, completed: 0, retryLater: 1 });
      expect(await markers(A)).toHaveLength(0);
      const checks = await owner.identityCheck.findMany({ where: { sessionId: sessionIdOf(A) } });
      expect(checks.some((c) => c.idImageKey !== null)).toBe(true); // columns untouched
      const logged = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain(sessionIdOf(A));
      expect(logged).not.toContain('orgs/'); // the warning names the session, never an object key
      warn.mockRestore();
      store.failDeleteFor.clear();
      expect((await build().service.runDaily(NOW)).face.completed).toBe(1);
      expect(await markers(A)).toHaveLength(1);
    });

    it('NFR-05: an object that survives the delete (the listing still shows it) is not verified', async () => {
      await setup(A, { submittedDaysAgo: 100 });
      store.resurrect.add(keys(A).selfie);
      expect((await build().service.runDaily(NOW)).face.retryLater).toBe(1);
      expect(await markers(A)).toHaveLength(0);
    });

    it('a second run does nothing (one marker per tier and session)', async () => {
      await setup(A, { submittedDaysAgo: 100, anchorDaysAgo: 100, retentionDays: 90 });
      await build().service.runDaily(NOW);
      const second = await build().service.runDaily(NOW);
      expect(second.face.due).toBe(0);
      expect(second.media.due).toBe(0);
      expect(await markers(A)).toHaveLength(2);
    });

    it('NFR-05: two runs at the same time write one marker per tier and session (advisory lock and re-check)', async () => {
      await setup(A, { submittedDaysAgo: 100, anchorDaysAgo: 100, retentionDays: 90 });
      const [one, two] = await Promise.all([
        build().service.runDaily(NOW),
        build().service.runDaily(NOW),
      ]);
      expect(await markers(A)).toHaveLength(2);
      expect(one.face.completed + two.face.completed).toBe(1);
      expect(one.media.completed + two.media.completed).toBe(1);
    });

    it('FR-103: both orgs are due, and each deletion and marker stays inside its own org', async () => {
      await setup(A, { submittedDaysAgo: 100 });
      await setup(B, { submittedDaysAgo: 100 });
      const extra = `orgs/${A.orgId}/sessions/${sessionIdOf(B)}/identity/9/leak.jpg`; // wrong org in the path
      store.put(extra);
      await build().service.runDaily(NOW);
      expect(store.keys.has(keys(A).idImage) || store.keys.has(keys(B).idImage)).toBe(false);
      expect(store.keys.has(extra)).toBe(true); // B's prefix is orgs/<B>/..., never orgs/<A>/sessions/<B>
      expect((await markers(A))[0]?.orgId).toBe(A.orgId);
      expect((await markers(B))[0]?.orgId).toBe(B.orgId);
    });

    it('a session that never verifies cannot starve the rest: the cursor steps past it (batch size 1)', async () => {
      await setup(A, { submittedDaysAgo: 300 }); // oldest first, fails every time
      await setup(B, { submittedDaysAgo: 100 });
      await owner.session.update({
        where: { id: sessionIdOf(A) },
        data: { createdAt: daysAgo(1000) },
      });
      await owner.session.update({
        where: { id: sessionIdOf(B) },
        data: { createdAt: daysAgo(900) },
      });
      store.failDeleteFor.add(keys(A).idImage);
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const summary = await build({ RETENTION_BATCH_SIZE: '1' }).service.runDaily(NOW);
      warn.mockRestore();
      expect(summary.face).toMatchObject({ due: 2, completed: 1, retryLater: 1 });
      expect(await markers(B)).toHaveLength(1);
      expect(await markers(A)).toHaveLength(0);
    });

    it('more due sessions than one page are all processed in the same run', async () => {
      const extras = await Promise.all([
        createTenant(owner, `ret-c-${counter}`),
        createTenant(owner, `ret-d-${counter}`),
      ]);
      const all = [A, B, ...extras];
      for (const [i, t] of all.entries()) {
        await setup(t, { submittedDaysAgo: 100 });
        await owner.session.update({
          where: { id: sessionIdOf(t) },
          data: { createdAt: daysAgo(900 - i) },
        });
      }
      const summary = await build({ RETENTION_BATCH_SIZE: '2' }).service.runDaily(NOW);
      expect(summary.face).toMatchObject({ due: 4, completed: 4 });
    });

    it('a run fails closed, changing nothing, when the bucket may keep noncurrent versions', async () => {
      await setup(A, { submittedDaysAgo: 100 });
      store.versioningState = { kind: 'versioned', noncurrentExpireDays: 30 };
      await expect(build().service.runDaily(NOW)).rejects.toThrow('noncurrent');
      expect(store.keys.has(keys(A).idImage)).toBe(true);
      expect(await markers(A)).toHaveLength(0);
    });

    it('writes one run summary row per org with ids and counts only, never a key', async () => {
      await setup(A, { submittedDaysAgo: 100 });
      const { runId } = await build().service.runDaily(NOW);
      const rows = await owner.auditLog.findMany({
        where: { action: 'RETENTION_RUN', entityId: runId },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.orgId).toBe(A.orgId);
      expect(JSON.stringify(rows[0]?.metadata)).not.toContain('orgs/');
      expect(rows[0]?.metadata).toEqual({ runId, faceCompleted: 1 });
    });

    it('the retention marker rows are written as app_user, and app_user still cannot edit or delete them', async () => {
      await setup(A, { submittedDaysAgo: 100 });
      await build().service.runDaily(NOW);
      await expect(
        app.auditLog.updateMany({
          where: { action: 'RETENTION_FACE_DONE' },
          data: { action: 'X' },
        }),
      ).rejects.toThrow();
      await expect(
        app.auditLog.deleteMany({ where: { action: 'RETENTION_FACE_DONE' } }),
      ).rejects.toThrow();
    });
  });

  describe('legal hold hook (OQ-10)', () => {
    class Held extends LegalHoldPort {
      isHeld = jest.fn().mockResolvedValue(true);
    }

    it('with the switch on, a held session keeps its recordings (the media tier waits) and nothing is deleted', async () => {
      await setup(A, { submittedDaysAgo: 400, anchorDaysAgo: 300, retentionDays: 90 });
      await owner.appeal.updateMany({
        where: { sessionReview: { sessionId: sessionIdOf(A) } },
        data: { status: 'UPHELD' },
      });
      const hold = new Held();
      const summary = await build({ RETENTION_LEGAL_HOLD: 'true' }, hold).service.runDaily(NOW);
      expect(summary.media).toMatchObject({ due: 1, completed: 0, retryLater: 1 });
      expect(store.keys.has(keys(A).media)).toBe(true);
      expect(hold.isHeld).toHaveBeenCalledWith(A.orgId, sessionIdOf(A));
    });

    it('a failing hold port counts as held: nothing is deleted when the hold cannot be read', async () => {
      await setup(A, { submittedDaysAgo: 400, anchorDaysAgo: 300, retentionDays: 90 });
      await owner.appeal.updateMany({
        where: { sessionReview: { sessionId: sessionIdOf(A) } },
        data: { status: 'UPHELD' },
      });
      const broken = new Held();
      broken.isHeld.mockRejectedValue(new Error('down'));
      expect(
        (await build({ RETENTION_LEGAL_HOLD: 'true' }, broken).service.runDaily(NOW)).media
          .completed,
      ).toBe(0);
      expect(store.keys.has(keys(A).media)).toBe(true);
    });

    it('C-35: the face cap does not wait for a legal hold (it runs whatever any hold says)', async () => {
      await setup(A, { submittedDaysAgo: 100 });
      expect(
        (await build({ RETENTION_LEGAL_HOLD: 'true' }, new Held()).service.runDaily(NOW)).face
          .completed,
      ).toBe(1);
    });

    it('with the switch off the port is never asked', async () => {
      await setup(A, { submittedDaysAgo: 400, anchorDaysAgo: 300, retentionDays: 90 });
      await owner.appeal.updateMany({
        where: { sessionReview: { sessionId: sessionIdOf(A) } },
        data: { status: 'UPHELD' },
      });
      const hold = new Held();
      await build({}, hold).service.runDaily(NOW);
      expect(hold.isHeld).not.toHaveBeenCalled();
    });
  });
});
