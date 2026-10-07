// SessionStateService against a real Postgres 16 (Testcontainers, real migrations, connecting as
// app_user): every allowed transition, every forbidden one, the timestamps each one stamps, and the
// compare-and-set under concurrency (FR-106, ADR 0002, C-28).
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { OrgContextService } from '../database/org-context';
import { PrismaService } from '../database/prisma.service';
import { createPrismaClient } from '../database/create-prisma-client';
import { startMigratedDatabase } from '../database/testing/migrated-postgres';
import type { MigratedDatabase } from '../database/testing/migrated-postgres';
import type { PrismaClient } from '../generated/prisma/client.js';
import type { SessionStatus } from '../generated/prisma/enums.js';
import { createInvitation, createTenant } from '../candidate/testing/fixtures';
import type { Tenant } from '../candidate/testing/fixtures';
import { IllegalTransitionError, SessionStateConflictError } from './session-state.errors';
import { SessionStateService } from './session-state.service';
import { SESSION_STATUSES, TRANSITIONS } from './session-transitions';

describe('SessionStateService (FR-106, ADR 0002, C-28)', () => {
  let db: MigratedDatabase;
  let owner: PrismaClient;
  let prisma: PrismaService;
  let orgContext: OrgContextService;
  let service: SessionStateService;
  let tenant: Tenant;

  beforeAll(async () => {
    db = await startMigratedDatabase();
    owner = createPrismaClient(db.ownerUrl);
    orgContext = new OrgContextService();
    prisma = new PrismaService(
      { get: () => db.appUserUrl } as unknown as ConfigService<never, true>,
      orgContext,
    );
    service = new SessionStateService(prisma);
    tenant = await createTenant(owner, 'state');
  });

  afterAll(async () => {
    await owner?.$disconnect();
    await prisma?.onApplicationShutdown();
    await db?.stop();
  });

  const inOrg = <T>(fn: () => Promise<T>): Promise<T> => orgContext.runInOrg(tenant.orgId, fn);

  async function sessionIn(status: SessionStatus): Promise<string> {
    return (await createInvitation(owner, tenant, { status })).sessionId;
  }
  const read = (id: string) => owner.session.findUniqueOrThrow({ where: { id } });

  const EDGES = SESSION_STATUSES.flatMap((from) =>
    TRANSITIONS[from].map((to) => [from, to] as const),
  );

  it.each(EDGES)('FR-106: %s to %s is applied', async (from, to) => {
    const id = await sessionIn(from);
    const now = new Date('2026-10-05T12:00:00.000Z');
    await inOrg(() => service.transition({ sessionId: id, from, to, now }));
    const row = await read(id);
    expect(row.status).toBe(to);
    // Timestamps (ADR 0002, ADR 0004 R-1): the table decides them, never the caller.
    const anchored = ['COMPLETED', 'EXPIRED', 'DECLINED'].includes(to) && from !== 'APPEALED';
    expect(row.retentionAnchorAt?.toISOString() ?? null).toBe(anchored ? now.toISOString() : null);
    expect(row.submittedAt?.toISOString() ?? null).toBe(
      to === 'SUBMITTED' ? now.toISOString() : null,
    );
  });

  it('FR-106: every forbidden pair is rejected before any write and leaves the session untouched', async () => {
    const allowed = new Set(EDGES.map(([a, b]) => `${a}>${b}`));
    const probe = await sessionIn('OPENED');
    for (const from of SESSION_STATUSES) {
      for (const to of SESSION_STATUSES) {
        if (allowed.has(`${from}>${to}`)) continue;
        await expect(
          inOrg(() => service.transition({ sessionId: probe, from, to })),
        ).rejects.toBeInstanceOf(IllegalTransitionError);
      }
    }
    expect((await read(probe)).status).toBe('OPENED');
  });

  it('FR-106: a transition from a state the session is not in loses the compare-and-set (409)', async () => {
    const id = await sessionIn('OPENED');
    const error: unknown = await inOrg(() =>
      service.transition({ sessionId: id, from: 'INVITED', to: 'OPENED' }),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SessionStateConflictError);
    expect((error as SessionStateConflictError).extensions.sessionStatus).toBe('OPENED');
    expect((error as SessionStateConflictError).getStatus()).toBe(409);
    expect((await read(id)).status).toBe('OPENED');
  });

  describe('ifPauseReasons compare-and-set (BE-10, ADR 0013 CS-4.4a)', () => {
    async function pausedWith(reasons: Array<'FULLSCREEN_EXIT' | 'PROCTOR'>): Promise<string> {
      const inv = await createInvitation(owner, tenant, {
        status: 'PAUSED',
        session: { pauseReasons: reasons },
      });
      return inv.sessionId;
    }

    it('FR-106: a matching list lets the transition through and writes the patch', async () => {
      const id = await pausedWith(['FULLSCREEN_EXIT']);
      await inOrg(() =>
        service.transition({
          sessionId: id,
          from: 'PAUSED',
          to: 'IN_PROGRESS',
          ifPauseReasons: ['FULLSCREEN_EXIT'],
          patch: { pauseReasons: [] },
        }),
      );
      const row = await read(id);
      expect(row.status).toBe('IN_PROGRESS');
      expect(row.pauseReasons).toEqual([]);
    });

    it('FR-106: a list that no longer matches (a reason was added) is a conflict and changes nothing', async () => {
      const id = await pausedWith(['FULLSCREEN_EXIT', 'PROCTOR']);
      await expect(
        inOrg(() =>
          service.transition({
            sessionId: id,
            from: 'PAUSED',
            to: 'IN_PROGRESS',
            ifPauseReasons: ['FULLSCREEN_EXIT'],
            patch: { pauseReasons: [] },
          }),
        ),
      ).rejects.toBeInstanceOf(SessionStateConflictError);
      const row = await read(id);
      expect(row.status).toBe('PAUSED');
      expect(row.pauseReasons).toEqual(['FULLSCREEN_EXIT', 'PROCTOR']);
    });

    it('FR-106: an empty list matches an empty column, and not a non-empty one', async () => {
      const empty = (await createInvitation(owner, tenant, { status: 'IN_PROGRESS' })).sessionId;
      await inOrg(() =>
        service.transition({
          sessionId: empty,
          from: 'IN_PROGRESS',
          to: 'PAUSED',
          ifPauseReasons: [],
          patch: { pauseReasons: ['FULLSCREEN_EXIT'] },
        }),
      );
      expect((await read(empty)).status).toBe('PAUSED');
      const busy = await pausedWith(['PROCTOR']);
      await expect(
        inOrg(() =>
          service.transition({
            sessionId: busy,
            from: 'PAUSED',
            to: 'IN_PROGRESS',
            ifPauseReasons: [],
          }),
        ),
      ).rejects.toBeInstanceOf(SessionStateConflictError);
    });

    it('FR-106: without the option the old behaviour holds (only the status is compared)', async () => {
      const id = await pausedWith(['FULLSCREEN_EXIT', 'PROCTOR']);
      await inOrg(() => service.transition({ sessionId: id, from: 'PAUSED', to: 'IN_PROGRESS' }));
      expect((await read(id)).status).toBe('IN_PROGRESS');
    });
  });

  it('FR-106: concurrent attempts at one transition have exactly one winner', async () => {
    const id = await sessionIn('OPENED');
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () =>
        inOrg(() => service.transition({ sessionId: id, from: 'OPENED', to: 'CONSENTED' })),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const losers = results.filter((r) => r.status === 'rejected');
    expect(losers).toHaveLength(11);
    for (const l of losers) expect(l.reason).toBeInstanceOf(SessionStateConflictError);
    expect((await read(id)).status).toBe('CONSENTED');
  });

  it('FR-106: racing moves out of one state (decline versus sign) end in exactly one state', async () => {
    const id = await sessionIn('OPENED');
    const results = await Promise.allSettled([
      inOrg(() => service.transition({ sessionId: id, from: 'OPENED', to: 'CONSENTED' })),
      inOrg(() => service.transition({ sessionId: id, from: 'OPENED', to: 'DECLINED' })),
      inOrg(() => service.transition({ sessionId: id, from: 'OPENED', to: 'EXPIRED' })),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(['CONSENTED', 'DECLINED', 'EXPIRED']).toContain((await read(id)).status);
  });

  it('FR-303: several from-states are accepted for EXPIRED, and the anchor is set', async () => {
    const id = await sessionIn('VERIFIED');
    await inOrg(() =>
      service.transition({
        sessionId: id,
        from: ['INVITED', 'OPENED', 'CONSENTED', 'VERIFIED'],
        to: 'EXPIRED',
      }),
    );
    const row = await read(id);
    expect(row.status).toBe('EXPIRED');
    expect(row.retentionAnchorAt).not.toBeNull();
    await expect(
      inOrg(() =>
        service.transition({ sessionId: id, from: ['INVITED', 'IN_PROGRESS'], to: 'EXPIRED' }),
      ),
    ).rejects.toBeInstanceOf(IllegalTransitionError);
  });

  it('FR-505: the start patch is written with the status in one statement; the caller cannot set the anchor', async () => {
    const id = await sessionIn('VERIFIED');
    const startedAt = new Date('2026-10-05T12:00:00.000Z');
    const deadlineAt = new Date('2026-10-05T13:00:00.000Z');
    await inOrg(() =>
      service.transition({
        sessionId: id,
        from: 'VERIFIED',
        to: 'IN_PROGRESS',
        now: startedAt,
        patch: { startedAt, deadlineAt, hmacKeyEnc: 'v1:k1:x:y' },
      }),
    );
    const row = await read(id);
    expect(row.status).toBe('IN_PROGRESS');
    expect(row.startedAt?.toISOString()).toBe(startedAt.toISOString());
    expect(row.deadlineAt?.toISOString()).toBe(deadlineAt.toISOString());
    expect(row.hmacKeyEnc).toBe('v1:k1:x:y');
    expect(row.retentionAnchorAt).toBeNull();
  });

  it('FR-106: a transaction that fails after the status change rolls the status back', async () => {
    const id = await sessionIn('OPENED');
    await expect(
      inOrg(() =>
        prisma.client.$transaction(async (tx) => {
          await service.transition({ sessionId: id, from: 'OPENED', to: 'CONSENTED', db: tx });
          throw new Error('later step failed');
        }),
      ),
    ).rejects.toThrow('later step failed');
    expect((await read(id)).status).toBe('OPENED');
  });

  it('TC-008: a session of another org is not found: the transition is a conflict, nothing changes', async () => {
    const other = await createTenant(owner, 'state-other');
    const foreign = (await createInvitation(owner, other, { status: 'OPENED' })).sessionId;
    const error: unknown = await inOrg(() =>
      service.transition({ sessionId: foreign, from: 'OPENED', to: 'CONSENTED' }),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SessionStateConflictError);
    expect((await read(foreign)).status).toBe('OPENED');
    await expect(
      inOrg(() => service.transition({ sessionId: randomUUID(), from: 'OPENED', to: 'CONSENTED' })),
    ).rejects.toBeInstanceOf(SessionStateConflictError);
  });

  it('ADR 0002 Q-01: createInvited makes the INVITED row and nothing else may', async () => {
    const inv = await createInvitation(owner, tenant, { status: 'INVITED' });
    await owner.session.delete({ where: { id: inv.sessionId } });
    const created = await inOrg(() =>
      service.createInvited({ orgId: tenant.orgId, invitationId: inv.invitationId }),
    );
    expect((await read(created.id)).status).toBe('INVITED');
  });
});
