// RetentionService, face tier and media tier (FR-704, NFR-05, TC-072; ADR 0004 9.2; C-04, C-27, C-35).
// A real Postgres 16 with the real migrations, the code under test connecting as app_user through
// the real client factory and the org-scope extension, and an in-memory object store. Docker is
// required. Synthetic data only.
import { Logger } from '@nestjs/common';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createPrismaClient } from '../database/create-prisma-client';
import { OrgContextService } from '../database/org-context';
import { createOrgScopedClient } from '../database/org-scope.extension';
import type { PrismaService } from '../database';
import { startMigratedDatabase } from '../database/testing/migrated-postgres';
import type { MigratedDatabase } from '../database/testing/migrated-postgres';
import { createTenant } from '../database/testing/tenant-fixtures';
import type { TenantFixture } from '../database/testing/tenant-fixtures';
import { NoLegalHold } from './legal-hold.port';
import { loadRetentionConfig } from './retention.config';
import type { RetentionConfig } from './retention.config';
import { RETENTION_MARKER_ACTIONS, sessionPrefix } from './retention.constants';
import { RetentionRepository } from './retention.repository';
import { RetentionService } from './retention.service';
import { InMemoryObjectStore } from './testing/in-memory-object-store';

const DAY = 86_400_000;
const NOW = new Date('2026-10-05T12:00:00.000Z');
const daysAgo = (n: number): Date => new Date(NOW.getTime() - n * DAY);

describe('RetentionService: face and media tiers (FR-704, NFR-05, TC-072)', () => {
  let db: MigratedDatabase;
  let owner: PrismaClient;
  let app: PrismaClient;
  let A: TenantFixture;
  let B: TenantFixture;
  let store: InMemoryObjectStore;
  let service: RetentionService;
  let config: RetentionConfig;

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

  /** Puts the session into a state: dates, org setting, DB keys and the matching objects. */
  async function setup(
    t: TenantFixture,
    opts: {
      submittedDaysAgo?: number | null;
      anchorDaysAgo?: number | null;
      retentionDays?: number;
    },
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
        submittedAt: opts.submittedDaysAgo == null ? null : daysAgo(opts.submittedDaysAgo),
        retentionAnchorAt: opts.anchorDaysAgo == null ? null : daysAgo(opts.anchorDaysAgo),
        reportKey: k.report,
      },
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
    await owner.proctorEvent.create({
      data: {
        sessionId,
        type: 'FACE_MISMATCH',
        severity: 'HIGH',
        occurredAt: daysAgo(200),
        evidenceKey: k.sealed,
      },
    });
    await owner.proctorEvent.updateMany({
      where: { sessionId, type: 'TAB_SWITCH' },
      data: { evidenceKey: k.evidence },
    });
    store.put(k.idImage, k.selfie, k.sealed, k.evidence, k.media, k.report, k.live);
  }

  const markers = (sessionId: string) =>
    owner.auditLog.findMany({
      where: {
        entityType: 'session',
        entityId: sessionId,
        action: { in: Object.values(RETENTION_MARKER_ACTIONS) },
      },
    });

  beforeAll(async () => {
    db = await startMigratedDatabase();
    owner = createPrismaClient(db.ownerUrl);
    app = createPrismaClient(db.appUserUrl);
    A = await createTenant(owner, 'ret-a');
    B = await createTenant(owner, 'ret-b');
  }, 180_000);

  afterAll(async () => {
    await app?.$disconnect();
    await owner?.$disconnect();
    await db?.stop();
  });

  beforeEach(async () => {
    // Fresh object store and per-test rows for both tenants.
    store = new InMemoryObjectStore();
    config = loadRetentionConfig({});
    await owner.auditLog
      .deleteMany({ where: { action: { startsWith: 'RETENTION_' } } })
      .catch(() => undefined);
    const orgContext = new OrgContextService();
    const prisma = { client: createOrgScopedClient(app, orgContext) } as unknown as PrismaService;
    service = new RetentionService(
      new RetentionRepository(prisma, orgContext),
      store,
      new NoLegalHold(),
      config,
    );
  });

  describe('face tier (C-27, C-35)', () => {
    it('TC-072: at submission + 90 days it deletes identity and sealed frames, nulls their keys, and writes the marker', async () => {
      await setup(A, { submittedDaysAgo: 91, anchorDaysAgo: null, retentionDays: 365 });
      const summary = await service.runDaily(NOW);
      expect(summary.face).toEqual({ due: 1, completed: 1, retryLater: 0 });
      const k = keys(A);
      expect(store.keys.has(k.idImage)).toBe(false);
      expect(store.keys.has(k.selfie)).toBe(false);
      expect(store.keys.has(k.sealed)).toBe(false);
      expect(store.keys.has(k.evidence)).toBe(false); // OQ-19 on by default: event frames are face images too
      expect(store.keys.has(k.media)).toBe(true); // recordings are the media tier's
      expect(store.keys.has(k.report)).toBe(true);
      const sessionId = sessionIdOf(A);
      const checks = await owner.identityCheck.findMany({ where: { sessionId } });
      expect(checks.every((c) => c.idImageKey === null && c.selfieKey === null)).toBe(true);
      const mismatch = await owner.proctorEvent.findMany({
        where: { sessionId, type: 'FACE_MISMATCH' },
      });
      expect(mismatch.every((e) => e.evidenceKey === null)).toBe(true);
      const found = await markers(sessionId);
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

    it('C-35: a hold (no anchor) does not delay it: the cap runs from submission whatever a review says', async () => {
      await setup(A, { submittedDaysAgo: 91, anchorDaysAgo: null, retentionDays: 730 });
      expect((await service.runDaily(NOW)).face.completed).toBe(1);
    });

    it('C-27: a long org retention never extends it past 90 days, and a short one shortens it', async () => {
      await setup(A, { submittedDaysAgo: 89, anchorDaysAgo: null, retentionDays: 730 });
      expect((await service.runDaily(NOW)).face.due).toBe(0);
      await setup(A, { submittedDaysAgo: 40, anchorDaysAgo: null, retentionDays: 30 });
      expect((await service.runDaily(NOW)).face.completed).toBe(1);
    });

    it('NFR-05: with the evidence switch off (OQ-19), only identity and sealed frames go', async () => {
      await setup(A, { submittedDaysAgo: 100, anchorDaysAgo: null });
      const orgContext = new OrgContextService();
      const prisma = { client: createOrgScopedClient(app, orgContext) } as unknown as PrismaService;
      const off = new RetentionService(
        new RetentionRepository(prisma, orgContext),
        store,
        new NoLegalHold(),
        loadRetentionConfig({ RETENTION_EVIDENCE_IN_FACE_TIER: 'false' }),
      );
      await off.runDaily(NOW);
      const k = keys(A);
      expect(store.keys.has(k.sealed)).toBe(false);
      expect(store.keys.has(k.evidence)).toBe(true);
    });

    it('NFR-05: an orphan object with no database row is deleted too (selection is by session, not by key)', async () => {
      await setup(A, { submittedDaysAgo: 100, anchorDaysAgo: null });
      const orphan = `${keys(A).root}identity/2/id-ORPHAN.jpg`;
      store.put(orphan);
      await service.runDaily(NOW);
      expect(store.keys.has(orphan)).toBe(false);
    });

    it('a session with no objects at all is still marked once the listing is verified empty', async () => {
      await setup(A, { submittedDaysAgo: 100, anchorDaysAgo: null });
      store.keys.clear();
      expect((await service.runDaily(NOW)).face.completed).toBe(1);
    });

    it('a session never submitted uses its latest capture, then its creation (the face clock fallbacks)', async () => {
      await setup(A, { submittedDaysAgo: null, anchorDaysAgo: null });
      await owner.session.update({
        where: { id: sessionIdOf(A) },
        data: { createdAt: daysAgo(500) },
      });
      await owner.identityCheck.updateMany({
        where: { sessionId: sessionIdOf(A) },
        data: { createdAt: daysAgo(10) },
      });
      await owner.proctorEvent.updateMany({
        where: { sessionId: sessionIdOf(A), type: 'FACE_MISMATCH' },
        data: { occurredAt: daysAgo(10) },
      });
      expect((await service.runDaily(NOW)).face.due).toBe(0); // latest capture 10 days ago
      await owner.identityCheck.updateMany({
        where: { sessionId: sessionIdOf(A) },
        data: { createdAt: daysAgo(95) },
      });
      await owner.proctorEvent.updateMany({
        where: { sessionId: sessionIdOf(A), type: 'FACE_MISMATCH' },
        data: { occurredAt: daysAgo(95) },
      });
      expect((await service.runDaily(NOW)).face.completed).toBe(1);
    });
  });

  describe('media tier (R-4; C-04)', () => {
    it('TC-072: at anchor + retention_days it deletes everything except reports/, nulls the keys and writes the marker', async () => {
      await setup(A, { submittedDaysAgo: 120, anchorDaysAgo: 91, retentionDays: 90 });
      // Not yet in the face tier's reach: skip it by completing it first.
      await service.runDaily(NOW);
      const summary = await service.runDaily(NOW);
      expect(summary.media.due).toBe(0); // the first run already did both tiers
      const k = keys(A);
      expect(store.keys.has(k.media)).toBe(false);
      expect(store.keys.has(k.live)).toBe(false);
      expect(store.keys.has(k.report)).toBe(true); // reports are R-10's (C-26)
      const sessionId = sessionIdOf(A);
      const chunks = await owner.mediaChunk.findMany({ where: { sessionId } });
      expect(chunks.every((c) => c.objectKey === null && c.deletedAt !== null)).toBe(true);
      expect(await owner.keystrokeBatch.count({ where: { sessionId } })).toBe(0);
      expect((await owner.session.findUniqueOrThrow({ where: { id: sessionId } })).reportKey).toBe(
        k.report,
      );
      const actions = (await markers(sessionId)).map((m) => m.action).sort();
      expect(actions).toEqual(['RETENTION_FACE_DONE', 'RETENTION_MEDIA_DONE']);
    });

    it('NFR-05: a hold (no anchor) means the media tier is not due', async () => {
      await setup(A, { submittedDaysAgo: 120, anchorDaysAgo: null, retentionDays: 7 });
      expect((await service.runDaily(NOW)).media.due).toBe(0);
    });

    it('not due before the anchor + retention_days', async () => {
      await setup(A, { submittedDaysAgo: 120, anchorDaysAgo: 30, retentionDays: 90 });
      expect((await service.runDaily(NOW)).media.due).toBe(0);
      expect(store.keys.has(keys(A).media)).toBe(true);
    });

    it('OQ-18: with a 90-day cap, a 730-day org setting still deletes at 90', async () => {
      await setup(A, { submittedDaysAgo: 200, anchorDaysAgo: 100, retentionDays: 730 });
      const orgContext = new OrgContextService();
      const prisma = { client: createOrgScopedClient(app, orgContext) } as unknown as PrismaService;
      const capped = new RetentionService(
        new RetentionRepository(prisma, orgContext),
        store,
        new NoLegalHold(),
        loadRetentionConfig({ RETENTION_MEDIA_CAP_DAYS: '90' }),
      );
      expect((await service.runDaily(NOW)).media.due).toBe(0); // uncapped: 730 days
      expect((await capped.runDaily(NOW)).media.completed).toBe(1);
    });
  });

  describe('verification, idempotence and safety (ADR 0004 9.2)', () => {
    it('NFR-05: a DeleteObjects error changes nothing and writes no marker; the next run completes it', async () => {
      await setup(A, { submittedDaysAgo: 100, anchorDaysAgo: null });
      const k = keys(A);
      store.failDeleteFor.add(k.idImage);
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const first = await service.runDaily(NOW);
      expect(first.face).toEqual({ due: 1, completed: 0, retryLater: 1 });
      expect(await markers(sessionIdOf(A))).toHaveLength(0);
      const checks = await owner.identityCheck.findMany({ where: { sessionId: sessionIdOf(A) } });
      expect(checks.some((c) => c.idImageKey !== null)).toBe(true); // columns untouched
      // The warning names the session and never an object key.
      const logged = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain(sessionIdOf(A));
      expect(logged).not.toContain('orgs/');
      warn.mockRestore();
      store.failDeleteFor.clear();
      expect((await service.runDaily(NOW)).face.completed).toBe(1);
      expect(await markers(sessionIdOf(A))).toHaveLength(1);
    });

    it('NFR-05: an object that survives the delete (listing still shows it) is not verified', async () => {
      await setup(A, { submittedDaysAgo: 100, anchorDaysAgo: null });
      store.resurrect.add(keys(A).selfie);
      expect((await service.runDaily(NOW)).face.retryLater).toBe(1);
      expect(await markers(sessionIdOf(A))).toHaveLength(0);
    });

    it('a second run does nothing (one marker per tier and session)', async () => {
      await setup(A, { submittedDaysAgo: 100, anchorDaysAgo: 100, retentionDays: 90 });
      await service.runDaily(NOW);
      const second = await service.runDaily(NOW);
      expect(second.face.due).toBe(0);
      expect(second.media.due).toBe(0);
      expect(await markers(sessionIdOf(A))).toHaveLength(2);
    });

    it('FR-103: it never touches another org, and each marker carries its own org', async () => {
      await setup(A, { submittedDaysAgo: 100, anchorDaysAgo: null });
      await setup(B, { submittedDaysAgo: 10, anchorDaysAgo: null });
      await service.runDaily(NOW);
      const kb = keys(B);
      expect(store.keys.has(kb.idImage) && store.keys.has(kb.media)).toBe(true);
      expect(await markers(sessionIdOf(B))).toHaveLength(0);
      expect((await markers(sessionIdOf(A)))[0]?.orgId).toBe(A.orgId);
    });

    it('a run fails closed, changing nothing, when the bucket may keep noncurrent versions', async () => {
      await setup(A, { submittedDaysAgo: 100, anchorDaysAgo: null });
      store.versioningState = { kind: 'versioned', noncurrentExpireDays: 30 };
      await expect(service.runDaily(NOW)).rejects.toThrow('noncurrent');
      expect(store.keys.has(keys(A).idImage)).toBe(true);
      expect(await markers(sessionIdOf(A))).toHaveLength(0);
    });

    it('writes one run summary row per org with ids and counts only, never a key', async () => {
      await setup(A, { submittedDaysAgo: 100, anchorDaysAgo: null });
      const { runId } = await service.runDaily(NOW);
      const rows = await owner.auditLog.findMany({
        where: { action: 'RETENTION_RUN', entityId: runId },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.orgId).toBe(A.orgId);
      expect(JSON.stringify(rows[0]?.metadata)).not.toContain('orgs/');
      expect(rows[0]?.metadata).toEqual({ runId, faceCompleted: 1 });
    });

    it('the retention marker rows are written as app_user, and app_user still cannot edit or delete them', async () => {
      await setup(A, { submittedDaysAgo: 100, anchorDaysAgo: null });
      await service.runDaily(NOW);
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
});
