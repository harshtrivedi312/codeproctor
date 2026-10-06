// A shared database harness for the retention integration specs: a real Postgres 16 with the real
// migrations, the code under test connecting as app_user through the real client factory and the
// org-scope extension, an in-memory object store, and fresh tenants for every test. Docker is
// required. Synthetic data only. Call `useRetentionDatabase()` inside a `describe`.
import type { PrismaClient } from '../../generated/prisma/client.js';
import type { SessionStatus } from '../../generated/prisma/enums.js';
import type { PrismaService } from '../../database';
import { createPrismaClient } from '../../database/create-prisma-client';
import { OrgContextService } from '../../database/org-context';
import { createOrgScopedClient } from '../../database/org-scope.extension';
import { startMigratedDatabase } from '../../database/testing/migrated-postgres';
import type { MigratedDatabase } from '../../database/testing/migrated-postgres';
import { createTenant } from '../../database/testing/tenant-fixtures';
import type { TenantFixture } from '../../database/testing/tenant-fixtures';
import { ConsentRetentionRepository } from '../consent-retention.repository';
import { LegalHoldPort, NoLegalHold } from '../legal-hold.port';
import { loadRetentionConfig } from '../retention.config';
import { RETENTION_MARKER_ACTIONS, consentPrefix, sessionPrefix } from '../retention.constants';
import { RetentionRepository } from '../retention.repository';
import { RetentionService } from '../retention.service';
import { InMemoryObjectStore } from './in-memory-object-store';

export const DAY = 86_400_000;
export const NOW = new Date('2026-10-05T12:00:00.000Z');
export const daysAgo = (n: number): Date => new Date(NOW.getTime() - n * DAY);

export interface SetupOptions {
  submittedDaysAgo?: number | null;
  anchorDaysAgo?: number | null;
  retentionDays?: number;
  status?: SessionStatus;
  /** The fixture's appeal is OPEN; by default it is closed so only the clocks decide. */
  openAppeal?: boolean;
}

export function useRetentionDatabase() {
  let db: MigratedDatabase;
  let owner: PrismaClient;
  let app: PrismaClient;
  let orgContext: OrgContextService;
  let counter = 0;
  const h = {} as {
    owner: PrismaClient;
    app: PrismaClient;
    store: InMemoryObjectStore;
    A: TenantFixture;
    B: TenantFixture;
  };

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
      consentPdf: `${consentPrefix(t.orgId, sessionIdOf(t))}C1.pdf`,
    };
  };

  function build(
    overrides: Record<string, string> = {},
    legalHold: LegalHoldPort = new NoLegalHold(),
  ) {
    const prisma = { client: createOrgScopedClient(app, orgContext) } as unknown as PrismaService;
    const repo = new RetentionRepository(prisma, orgContext);
    const consentRepo = new ConsentRetentionRepository(prisma, orgContext);
    const config = loadRetentionConfig(overrides);
    return {
      repo,
      consentRepo,
      service: new RetentionService(repo, consentRepo, h.store, legalHold, config),
    };
  }

  /** Puts a tenant's session into a state: dates, status, org setting, DB values and the matching objects. */
  async function setup(t: TenantFixture, opts: SetupOptions = {}): Promise<void> {
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
        createdAt: daysAgo(2000),
        submittedAt: opts.submittedDaysAgo == null ? null : daysAgo(opts.submittedDaysAgo),
        retentionAnchorAt: opts.anchorDaysAgo == null ? null : daysAgo(opts.anchorDaysAgo),
        reportKey: k.report,
        totalScore: 80,
        riskScore: 40,
        riskBand: 'MEDIUM',
        deviceInfo: { ua: 'secret-browser' },
      },
    });
    await owner.appeal.updateMany({
      where: { sessionReview: { sessionId } },
      data: { status: opts.openAppeal ? 'OPEN' : 'UPHELD' },
    });
    await owner.sessionReview.updateMany({
      where: { sessionId },
      data: { notes: 'reviewer note', verdict: 'CLEAN' },
    });
    await owner.sessionQuestion.updateMany({
      where: { sessionId },
      data: { finalCode: 'print(1)', answer: { a: 1 }, scoringNote: 'note', score: 5 },
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
        occurredAt: daysAgo(900),
        evidenceKey: k.sealed,
      },
    });
    await owner.proctorEvent.updateMany({
      where: { sessionId, type: 'TAB_SWITCH' },
      data: { evidenceKey: k.evidence },
    });
    await owner.keystrokeBatch.deleteMany({ where: { sessionId } });
    await owner.keystrokeBatch.create({
      data: { sessionId, seq: 1, signature: Buffer.from('s'), startedAt: NOW, events: [] },
    });
    h.store.put(k.idImage, k.selfie, k.sealed, k.evidence, k.media, k.report, k.live);
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
    h.owner = owner;
    h.app = app;
  }, 180_000);

  afterAll(async () => {
    await app?.$disconnect();
    await owner?.$disconnect();
    await db?.stop();
  });

  beforeEach(async () => {
    h.store = new InMemoryObjectStore();
    counter++;
    h.A = await createTenant(owner, `ret-a-${counter}`);
    h.B = await createTenant(owner, `ret-b-${counter}`);
  });

  afterEach(async () => {
    // Make every session of this test too young to be selected by a later test's run.
    await owner.session.updateMany({
      data: { createdAt: NOW, submittedAt: NOW, retentionAnchorAt: null },
    });
    await owner.consent.updateMany({ data: { signedAt: NOW, declinedAt: null } });
  });

  return { h, build, setup, keys, sessionIdOf, markers };
}
