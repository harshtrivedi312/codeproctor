// SessionStateService against a real Postgres 16 (Testcontainers, real migrations, connecting as
// app_user): every allowed transition, every forbidden one, the timestamps each one stamps, and the
// compare-and-set under concurrency (FR-106, ADR 0002, C-28).
import { hasPermission } from '@codeproctor/shared';
import { OrgContextMissingError } from '../database/errors';
import { ConfigService } from '@nestjs/config';
import { Client } from 'pg';
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
import {
  SessionLockPort,
  SessionLockRetryError,
  SessionNotFoundError,
  type SessionLockState,
  type SessionTx,
} from './session-lock.port';
import { IllegalTransitionError, SessionStateConflictError } from './session-state.errors';
import { SessionStateService } from './session-state.service';
import { SESSION_STATUSES, TRANSITIONS } from './session-transitions';

class TestLock extends SessionLockPort {
  next: SessionLockState | Error = 'LIVE';
  /** When true, the double looks the row up through the (org-filtered) transaction client first. */
  orgFiltered = false;
  async guardLive(tx?: SessionTx, sessionId?: string): Promise<SessionLockState> {
    if (this.orgFiltered && tx !== undefined && sessionId !== undefined) {
      const row = await tx.session.findUnique({ where: { id: sessionId }, select: { id: true } });
      if (row === null) throw new SessionNotFoundError();
    }
    return this.next instanceof Error ? Promise.reject(this.next) : Promise.resolve(this.next);
  }
  lockAnySession(): Promise<SessionLockState> {
    return this.guardLive();
  }
  lockForAccommodation(): Promise<SessionStatus> {
    return Promise.reject(new Error('unused'));
  }
}

describe('SessionStateService (FR-106, ADR 0002, C-28)', () => {
  const lock = new TestLock();
  const redis = { status: 'ready', expire: jest.fn(() => Promise.resolve(1)) };
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
    service = new SessionStateService(
      prisma,
      orgContext,
      lock,
      { get: () => 300 } as never,
      redis as never,
    );
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

  it('FR-106, ADR 0013 CS-4.4a: a smuggled id or status in alsoWhere can only narrow the update, never widen it', async () => {
    const a = await sessionIn('OPENED');
    const b = await sessionIn('OPENED');
    // alsoWhere is typed to two fields, but a caller could still pass more at run time.
    const smuggled = {
      id: { not: a },
      status: { in: ['OPENED', 'CONSENTED'] },
      pauseReasons: { equals: [] },
    };
    await expect(
      inOrg(() =>
        service.transition({
          sessionId: a,
          from: 'OPENED',
          to: 'CONSENTED',
          alsoWhere: smuggled,
        }),
      ),
    ).rejects.toBeInstanceOf(SessionStateConflictError);
    expect((await read(a)).status).toBe('OPENED');
    expect((await read(b)).status).toBe('OPENED');
    // A legitimate extra condition still lets the update through.
    await inOrg(() =>
      service.transition({
        sessionId: a,
        from: 'OPENED',
        to: 'CONSENTED',
        alsoWhere: { pauseReasons: { equals: [] } },
      }),
    );
    expect((await read(a)).status).toBe('CONSENTED');
    expect((await read(b)).status).toBe('OPENED');
  });

  // ---------- proctorResume (ADR 0002 P-3, ADR 0013 section 5.7, FR-903, TC-079) ----------

  describe('proctorResume (ADR 0002 P-3, TC-079)', () => {
    const MIN = 60_000;
    const asStaff = <T>(fn: () => Promise<T>): Promise<T> =>
      orgContext.runAsUser(
        { orgId: tenant.orgId, userId: tenant.staffUserId, role: 'REVIEWER' },
        fn,
      );

    async function paused(
      over: {
        reasons?: Array<'PROCTOR' | 'SCREEN_SHARE_STOPPED'>;
        pausedMs?: bigint;
        minutesAgo?: number;
      } = {},
    ) {
      const now = Date.now();
      const inv = await createInvitation(owner, tenant, {
        status: 'PAUSED',
        session: {
          startedAt: new Date(now - 30 * MIN),
          deadlineAt: new Date(now + 30 * MIN),
          pauseReasons: over.reasons ?? ['PROCTOR'],
          authEpoch: 2,
        },
      });
      const pausedAt = new Date(now - (over.minutesAgo ?? 10) * MIN);
      await owner.session.update({
        where: { id: inv.sessionId },
        data: { proctorPausedAt: pausedAt, pausedMs: over.pausedMs ?? 0n },
      });
      const sectionStart = new Date(now - 25 * MIN);
      await owner.sessionSection.create({
        data: {
          sessionId: inv.sessionId,
          sectionId: tenant.test.sectionIds[0],
          position: 1,
          startedAt: sectionStart,
          deadlineAt: new Date(now + 5 * MIN),
        },
      });
      return { ...inv, now, pausedAt };
    }
    const snapshot = async (id: string) => ({
      session: await owner.session.findUniqueOrThrow({ where: { id } }),
      sections: await owner.sessionSection.findMany({ where: { sessionId: id } }),
      events: await owner.proctorEvent.count({ where: { sessionId: id } }),
    });

    beforeEach(() => {
      lock.next = 'LIVE';
      redis.expire.mockClear();
    });

    it('TC-079, P-3: on resume the PROCTOR reason goes, PAUSED becomes IN_PROGRESS and the credit moves paused_ms, deadline_at and the open section', async () => {
      const p = await paused();
      const before = await snapshot(p.sessionId);
      const now = new Date(p.now);
      const result = await asStaff(() => service.proctorResume({ sessionId: p.sessionId, now }));
      expect(result).toMatchObject({
        sessionId: p.sessionId,
        status: 'IN_PROGRESS',
        creditedMs: 10 * MIN,
      });
      const after = await snapshot(p.sessionId);
      expect(after.session).toMatchObject({
        status: 'IN_PROGRESS',
        pauseReasons: [],
        proctorPausedAt: null,
      });
      expect(Number(after.session.pausedMs)).toBe(10 * MIN);
      expect(
        (after.session.deadlineAt?.getTime() ?? 0) - (before.session.deadlineAt?.getTime() ?? 0),
      ).toBe(10 * MIN);
      expect(
        (after.sections[0]?.deadlineAt?.getTime() ?? 0) -
          (before.sections[0]?.deadlineAt?.getTime() ?? 0),
      ).toBe(10 * MIN);
      expect(result.deadlineAt.getTime()).toBe(after.session.deadlineAt?.getTime());
      const event = await owner.proctorEvent.findFirstOrThrow({
        where: { sessionId: p.sessionId, type: 'PROCTOR_RESUME' },
      });
      expect(event).toMatchObject({
        severity: 'LOW',
        source: 'SERVER',
        payload: { proctorUserId: tenant.staffUserId },
      });
      // The markers that live until the deadline get their TTL set again (current epoch only for pkey).
      expect(redis.expire.mock.calls.map((c) => (c as unknown as [string])[0]).sort()).toEqual(
        [`etag:${p.sessionId}`, `evidence:${p.sessionId}`, `pkey:${p.sessionId}:2`].sort(),
      );
      for (const call of redis.expire.mock.calls)
        expect((call as unknown as [string, number])[1]).toBeGreaterThan(3600);
    });

    it('P-3: the credit stops at what is left of the org allowance (cap 30 minutes, 25 already used)', async () => {
      const p = await paused({ pausedMs: BigInt(25 * MIN), minutesAgo: 20 });
      const result = await asStaff(() =>
        service.proctorResume({
          sessionId: p.sessionId,
          now: new Date(p.now),
        }),
      );
      expect(result.creditedMs).toBe(5 * MIN);
      expect(
        Number((await owner.session.findUniqueOrThrow({ where: { id: p.sessionId } })).pausedMs),
      ).toBe(30 * MIN);
    });

    it('P-1, P-3: another pause reason keeps the session PAUSED; only PROCTOR is removed and the credit is still paid', async () => {
      const p = await paused({ reasons: ['PROCTOR', 'SCREEN_SHARE_STOPPED'] });
      const result = await asStaff(() =>
        service.proctorResume({
          sessionId: p.sessionId,
          now: new Date(p.now),
        }),
      );
      expect(result.status).toBe('PAUSED');
      const row = await owner.session.findUniqueOrThrow({ where: { id: p.sessionId } });
      expect(row).toMatchObject({
        status: 'PAUSED',
        pauseReasons: ['SCREEN_SHARE_STOPPED'],
        proctorPausedAt: null,
      });
      expect(Number(row.pausedMs)).toBe(10 * MIN);
    });

    it('ADR 0013 5.7: an ERASED session writes nothing, resets no TTL, emits no event and answers 409 SESSION_ERASED', async () => {
      const p = await paused();
      lock.next = 'ERASED';
      const before = await snapshot(p.sessionId);
      const error: unknown = await asStaff(() =>
        service.proctorResume({
          sessionId: p.sessionId,
          now: new Date(p.now),
        }),
      ).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: 'SESSION_ERASED' });
      expect((error as { getStatus(): number }).getStatus()).toBe(409);
      expect(await snapshot(p.sessionId)).toEqual(before);
      expect(redis.expire).not.toHaveBeenCalled();
    });

    it('ADR 0013 5.7: a busy lock (retry error, 55P03, 40P01, P2034, wrapped or not) is 503 LOCK_BUSY with Retry-After, never 409 or 500, and writes nothing', async () => {
      const p = await paused();
      const before = await snapshot(p.sessionId);
      const busy: Error[] = [
        new SessionLockRetryError(),
        Object.assign(new Error('x'), { code: '55P03' }),
        Object.assign(new Error('x'), { cause: Object.assign(new Error('pg'), { code: '40P01' }) }),
        Object.assign(new Error('x'), { code: 'P2034' }),
      ];
      for (const e of busy) {
        lock.next = e;
        const error: unknown = await asStaff(() =>
          service.proctorResume({
            sessionId: p.sessionId,
            now: new Date(p.now),
          }),
        ).catch((x: unknown) => x);
        expect((error as { getStatus(): number }).getStatus()).toBe(503);
        expect(error).toMatchObject({ code: 'LOCK_BUSY', extensions: { retryAfterSeconds: 2 } });
      }
      expect(await snapshot(p.sessionId)).toEqual(before);
      expect(redis.expire).not.toHaveBeenCalled();
      // Another error is not turned into 503.
      lock.next = new Error('unrelated');
      await expect(
        asStaff(() => service.proctorResume({ sessionId: p.sessionId })),
      ).rejects.toThrow('unrelated');
    });

    it('P-3: a session that is not paused by a proctor is 409 SESSION_STATE_CONFLICT, a missing or foreign one is 404', async () => {
      const running = await createInvitation(owner, tenant, {
        status: 'IN_PROGRESS',
        session: { startedAt: new Date(), deadlineAt: new Date(Date.now() + 60_000) },
      });
      await expect(
        asStaff(() =>
          service.proctorResume({
            sessionId: running.sessionId,
          }),
        ),
      ).rejects.toMatchObject({ code: 'SESSION_STATE_CONFLICT' });
      const other = await createTenant(owner, 'resume-other');
      const theirs = await createInvitation(owner, other, {
        status: 'PAUSED',
        session: { pauseReasons: ['PROCTOR'], deadlineAt: new Date(Date.now() + 60_000) },
      });
      // The test lock does not look at the row: the 404 comes from the service's own scoped read.
      lock.next = 'LIVE';
      await expect(
        asStaff(() => service.proctorResume({ sessionId: theirs.sessionId })),
      ).rejects.toMatchObject({ status: 404 });
    });

    it('P-3, S-4: a section opened during the pause is credited only from when it opened', async () => {
      const p = await paused();
      await owner.sessionSection.deleteMany({ where: { sessionId: p.sessionId } });
      const opened = new Date(p.now - 4 * MIN);
      await owner.sessionSection.create({
        data: {
          sessionId: p.sessionId,
          sectionId: tenant.test.sectionIds[0],
          position: 1,
          startedAt: opened,
          deadlineAt: new Date(p.now + 20 * MIN),
        },
      });
      const result = await asStaff(() =>
        service.proctorResume({ sessionId: p.sessionId, now: new Date(p.now) }),
      );
      expect(result.creditedMs).toBe(10 * MIN);
      expect(result.sectionDeadlineAt?.getTime()).toBe(p.now + 24 * MIN);
    });

    it('NFR-04, ADR 0013 5.7: only a staff user may resume: no scope, a system scope, a candidate scope, a session-job scope and a plain org scope are all refused and nothing changes', async () => {
      const p = await paused();
      const before = await snapshot(p.sessionId);
      const call = (): Promise<unknown> =>
        service.proctorResume({ sessionId: p.sessionId, now: new Date(p.now) });
      await expect(call()).rejects.toBeInstanceOf(OrgContextMissingError);
      await expect(orgContext.runSystem('BACKGROUND_JOB', call)).rejects.toBeInstanceOf(
        OrgContextMissingError,
      );
      await expect(orgContext.runInOrg(tenant.orgId, call)).rejects.toBeInstanceOf(
        OrgContextMissingError,
      );
      await expect(
        orgContext.runAsCandidate(tenant.orgId, p.sessionId, call),
      ).rejects.toBeInstanceOf(OrgContextMissingError);
      await expect(
        orgContext.runAsSessionJob(tenant.orgId, p.sessionId, call),
      ).rejects.toBeInstanceOf(OrgContextMissingError);
      expect(await snapshot(p.sessionId)).toEqual(before);
      expect(redis.expire).not.toHaveBeenCalled();
    });

    it('FR-903, NFR-04: a staff role without live:pause is refused (403), one with it resumes, and the event names the scope user', async () => {
      const p = await paused();
      const without = (['RECRUITER', 'AUTHOR'] as const).find(
        (r) => !hasPermission(r, 'live:pause'),
      );
      expect(without).toBeDefined();
      await expect(
        orgContext.runAsUser(
          { orgId: tenant.orgId, userId: randomUUID(), role: without ?? 'AUTHOR' },
          () => service.proctorResume({ sessionId: p.sessionId, now: new Date(p.now) }),
        ),
      ).rejects.toMatchObject({ status: 403 });
      expect((await owner.session.findUniqueOrThrow({ where: { id: p.sessionId } })).status).toBe(
        'PAUSED',
      );
      const reviewer = randomUUID();
      await orgContext.runAsUser({ orgId: tenant.orgId, userId: reviewer, role: 'REVIEWER' }, () =>
        service.proctorResume({ sessionId: p.sessionId, now: new Date(p.now) }),
      );
      const event = await owner.proctorEvent.findFirstOrThrow({
        where: { sessionId: p.sessionId, type: 'PROCTOR_RESUME' },
      });
      expect(event.payload).toEqual({ proctorUserId: reviewer });
    });

    it('P-3, TC-079: concurrent resumes with another reason still active credit exactly once (real compare-and-set)', async () => {
      const p = await paused({ reasons: ['PROCTOR', 'SCREEN_SHARE_STOPPED'] });
      const results = await Promise.allSettled(
        Array.from({ length: 4 }, () =>
          asStaff(() => service.proctorResume({ sessionId: p.sessionId, now: new Date(p.now) })),
        ),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const row = await owner.session.findUniqueOrThrow({ where: { id: p.sessionId } });
      expect(Number(row.pausedMs)).toBe(10 * MIN);
      expect(row.pauseReasons).toEqual(['SCREEN_SHARE_STOPPED']);
      expect(
        await owner.proctorEvent.count({
          where: { sessionId: p.sessionId, type: 'PROCTOR_RESUME' },
        }),
      ).toBe(1);
    });

    it('ADR 0013 5.7: a resume that waits on a locked sessions row answers 503 LOCK_BUSY and changes nothing (a real FOR UPDATE held by a second connection; the test lock itself does not lock)', async () => {
      const p = await paused();
      const before = await snapshot(p.sessionId);
      const holder = new Client({ connectionString: db.ownerUrl });
      await holder.connect();
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM sessions WHERE id = $1 FOR UPDATE', [p.sessionId]);
      try {
        const error: unknown = await asStaff(() =>
          service.proctorResume({ sessionId: p.sessionId, now: new Date(p.now) }),
        ).catch((e: unknown) => e);
        expect((error as { getStatus(): number }).getStatus()).toBe(503);
        expect(error).toMatchObject({ code: 'LOCK_BUSY' });
      } finally {
        await holder.query('ROLLBACK');
        await holder.end();
      }
      expect(await snapshot(p.sessionId)).toEqual(before);
      // With the row free again the same resume succeeds.
      await asStaff(() => service.proctorResume({ sessionId: p.sessionId, now: new Date(p.now) }));
    }, 60_000);

    it('P-3, TC-079: a pause reason added or removed between the read and the write is never overwritten (exact compare-and-set, both write paths)', async () => {
      const cases: Array<
        [
          string,
          Array<'PROCTOR' | 'SCREEN_SHARE_STOPPED'>,
          Array<'PROCTOR' | 'SCREEN_SHARE_STOPPED'>,
        ]
      > = [
        [
          'a reason is added meanwhile (transition path)',
          ['PROCTOR'],
          ['PROCTOR', 'SCREEN_SHARE_STOPPED'],
        ],
        [
          'a reason is removed meanwhile (update path)',
          ['PROCTOR', 'SCREEN_SHARE_STOPPED'],
          ['PROCTOR'],
        ],
        [
          'a reason is added meanwhile (update path)',
          ['PROCTOR', 'SCREEN_SHARE_STOPPED'],
          ['PROCTOR', 'SCREEN_SHARE_STOPPED', 'SIDE_CAMERA_LOST'] as never,
        ],
      ];
      for (const [label, start, changed] of cases) {
        const p = await paused({ reasons: start });
        const original = prisma.client.$transaction.bind(prisma.client);
        // Run the other writer's change just before the service's write, inside the transaction.
        const spy = jest.spyOn(prisma.client, '$transaction').mockImplementation(((
          fn: (tx: never) => Promise<unknown>,
          opts: never,
        ) =>
          original(
            (async (tx: { session: object }) =>
              fn(
                new Proxy(tx, {
                  get(t, k, r) {
                    if (k !== 'session') return Reflect.get(t, k, r) as unknown;
                    return new Proxy(t.session, {
                      get(sess, m, rr) {
                        if (m !== 'updateMany') return Reflect.get(sess, m, rr) as unknown;
                        return async (args: unknown) => {
                          await owner.session.update({
                            where: { id: p.sessionId },
                            data: { pauseReasons: changed },
                          });
                          return (sess as { updateMany(a: unknown): Promise<unknown> }).updateMany(
                            args,
                          );
                        };
                      },
                    });
                  },
                }) as never,
              )) as never,
            opts,
          )) as never);
        try {
          const error: unknown = await asStaff(() =>
            service.proctorResume({ sessionId: p.sessionId, now: new Date(p.now) }),
          ).catch((e: unknown) => e);
          expect([label, (error as { code?: string }).code]).toEqual([
            label,
            'SESSION_STATE_CONFLICT',
          ]);
        } finally {
          spy.mockRestore();
        }
        const row = await owner.session.findUniqueOrThrow({ where: { id: p.sessionId } });
        expect([label, row.pauseReasons]).toEqual([label, changed]);
        expect([label, Number(row.pausedMs)]).toEqual([label, 0]);
        expect([
          label,
          await owner.proctorEvent.count({ where: { sessionId: p.sessionId } }),
        ]).toEqual([label, 0]);
      }
    });

    it('ADR 0013 5.7 (when #208 binds, FU-BEB-121): a foreign session that is ERASED answers 404, not 409 SESSION_ERASED (no cross-org existence oracle)', async () => {
      // A lock double that, like the real core, finds the row through the org-filtered client.
      const other = await createTenant(owner, 'resume-oracle');
      const theirs = await createInvitation(owner, other, {
        status: 'PAUSED',
        session: { pauseReasons: ['PROCTOR'], deadlineAt: new Date(Date.now() + 60_000) },
      });
      lock.orgFiltered = true;
      lock.next = 'ERASED';
      try {
        const error: unknown = await asStaff(() =>
          service.proctorResume({ sessionId: theirs.sessionId }),
        ).catch((e: unknown) => e);
        expect((error as { getStatus(): number }).getStatus()).toBe(404);
        // The same ERASED answer for a session of the caller's own org is the 409.
        const mine = await paused();
        const own: unknown = await asStaff(() =>
          service.proctorResume({ sessionId: mine.sessionId }),
        ).catch((e: unknown) => e);
        expect(own).toMatchObject({ code: 'SESSION_ERASED' });
      } finally {
        lock.orgFiltered = false;
      }
    });

    it('P-3: two resumes at once credit once: one succeeds and the other is a 409 conflict', async () => {
      const p = await paused();
      const results = await Promise.allSettled(
        Array.from({ length: 4 }, () =>
          asStaff(() =>
            service.proctorResume({
              sessionId: p.sessionId,
              now: new Date(p.now),
            }),
          ),
        ),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(
        Number((await owner.session.findUniqueOrThrow({ where: { id: p.sessionId } })).pausedMs),
      ).toBe(10 * MIN);
      expect(
        await owner.proctorEvent.count({
          where: { sessionId: p.sessionId, type: 'PROCTOR_RESUME' },
        }),
      ).toBe(1);
    });
  });
});
