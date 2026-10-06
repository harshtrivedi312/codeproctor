// Erasure on request against a real Postgres 16 (ADR 0004 9.5; FR-704, C-06, C-17). The fence is a fake
// that does what BE-07's SessionStateService does to the row (status ERASED, auth_epoch bump, anchor
// kept or set, open appeal closed on request); the rest is the real service and repository.
import { SessionStatus } from '../../generated/prisma/enums.js';
import { RETENTION_MARKER_ACTIONS, sessionPrefix } from '../retention.constants';
import { ErasureRepository, requestIdOf } from './erasure.repository';
import { ErasureService } from './erasure.service';
import {
  ErasureAlertPort,
  ErasureNoticePort,
  ErasureSchedulerPort,
  SessionFencePort,
} from './erasure.ports';
import type { ErasureAlertKind, FenceResult } from './erasure.ports';
import { NOW, daysAgo, useRetentionDatabase } from '../../test/retention/retention-harness';
import type { PrismaClient } from '../../generated/prisma/client.js';

class FakeFence extends SessionFencePort {
  calls: Array<{ sessionId: string; closeOpenAppeal: boolean }> = [];
  constructor(private readonly owner: PrismaClient) {
    super();
  }
  async fence(a: {
    orgId: string;
    sessionId: string;
    closeOpenAppeal: boolean;
  }): Promise<FenceResult> {
    this.calls.push({ sessionId: a.sessionId, closeOpenAppeal: a.closeOpenAppeal });
    const s = await this.owner.session.findUniqueOrThrow({ where: { id: a.sessionId } });
    if (s.status === SessionStatus.ERASED) return 'alreadyErased';
    const open = await this.owner.appeal.count({
      where: { status: 'OPEN', sessionReview: { sessionId: a.sessionId } },
    });
    if ((s.status === 'UNDER_REVIEW' || s.status === 'APPEALED' || open > 0) && !a.closeOpenAppeal)
      return 'held';
    if (open > 0)
      await this.owner.appeal.updateMany({
        where: { status: 'OPEN', sessionReview: { sessionId: a.sessionId } },
        data: { status: 'CLOSED_ERASED' },
      });
    await this.owner.session.update({
      where: { id: a.sessionId },
      data: {
        status: SessionStatus.ERASED,
        authEpoch: { increment: 1 },
        retentionAnchorAt: s.retentionAnchorAt ?? NOW,
      },
    });
    return 'fenced';
  }
}
class FakeScheduler extends ErasureSchedulerPort {
  jobs: Date[] = [];
  scheduleRerun(a: { runAt: Date }): Promise<void> {
    this.jobs.push(a.runAt);
    return Promise.resolve();
  }
}
class FakeNotice extends ErasureNoticePort {
  completed = 0;
  delayed = 0;
  enqueueCompleted(): Promise<void> {
    this.completed++;
    return Promise.resolve();
  }
  enqueueDelayed(): Promise<void> {
    this.delayed++;
    return Promise.resolve();
  }
}
class FakeAlert extends ErasureAlertPort {
  raised: ErasureAlertKind[] = [];
  raise(a: { kind: ErasureAlertKind }): Promise<void> {
    this.raised.push(a.kind);
    return Promise.resolve();
  }
}

describe('erasure on request (FR-704, C-06, C-17)', () => {
  const { h, build, setup, keys, sessionIdOf } = useRetentionDatabase();

  function service(overrides: Record<string, string> = {}) {
    const b = build(overrides);
    const fence = new FakeFence(h.owner);
    const scheduler = new FakeScheduler();
    const notices = new FakeNotice();
    const alerts = new FakeAlert();
    const repo = new ErasureRepository(b.prisma, b.orgContext, b.repo);
    const svc = new ErasureService(repo, h.store, fence, scheduler, notices, alerts, b.config);
    return { svc, fence, scheduler, notices, alerts };
  }
  const candidateOf = (t: typeof h.A): Promise<string> =>
    Promise.resolve((t.rows.Candidate.unique as { id: string }).id);
  const completedRows = (candidateId: string) =>
    h.owner.auditLog.findMany({ where: { action: 'ERASURE_COMPLETED', entityId: candidateId } });

  it('TC-ERASE-01 FR-704 C-06: fences, deletes every object, purges rows, keeps scores, writes ERASURE_COMPLETED once and no RETENTION marker', async () => {
    await setup(h.A, { submittedDaysAgo: 3, anchorDaysAgo: 3 });
    const sid = sessionIdOf(h.A);
    const cid = await candidateOf(h.A);
    const { svc, scheduler, notices } = service();
    const r = await svc.requestErasure({
      orgId: h.A.orgId,
      candidateId: cid,
      actorId: null,
      now: NOW,
    });
    expect(r.status).toBe('completed');
    expect(scheduler.jobs).toHaveLength(1);
    expect(notices.completed).toBe(1);
    expect([...h.store.keys].filter((x) => x.startsWith(sessionPrefix(h.A.orgId, sid)))).toEqual(
      [],
    );
    const s = await h.owner.session.findUniqueOrThrow({ where: { id: sid } });
    expect(s.status).toBe('ERASED');
    expect(s.totalScore).not.toBeNull();
    expect(s.riskBand).toBe('MEDIUM');
    expect(s.reportKey).toBeNull();
    expect(s.deviceInfo).toEqual({});
    expect(await h.owner.proctorEvent.count({ where: { sessionId: sid } })).toBe(0);
    expect(await h.owner.mediaChunk.count({ where: { sessionId: sid } })).toBe(0);
    expect(await h.owner.identityCheck.count({ where: { sessionId: sid } })).toBe(0);
    expect(await h.owner.keystrokeBatch.count({ where: { sessionId: sid } })).toBe(0);
    const q = await h.owner.sessionQuestion.findFirstOrThrow({ where: { sessionId: sid } });
    expect(q.finalCode).toBeNull();
    expect(q.scoringNote).toBeNull();
    expect(q.score).not.toBeNull();
    const rev = await h.owner.sessionReview.findFirstOrThrow({ where: { sessionId: sid } });
    expect(rev.notes).toBeNull();
    expect(rev.verdict).toBe('CLEAN');
    expect(await completedRows(cid)).toHaveLength(1);
    // A second run changes nothing and writes no second completion.
    await svc.run(h.A.orgId, cid, NOW);
    expect(await completedRows(cid)).toHaveLength(1);
    const markers = await h.owner.auditLog.count({
      where: { entityId: sid, action: { in: Object.values(RETENTION_MARKER_ACTIONS) } },
    });
    expect(markers).toBe(0);
  });

  it('TC-ERASE-02 C-17: the consent row is untouched and the candidate stays until a notice or day 28', async () => {
    await setup(h.A, { submittedDaysAgo: 3, anchorDaysAgo: 3 });
    const cid = await candidateOf(h.A);
    const consentsBefore = await h.owner.consent.count({ where: { sessionId: sessionIdOf(h.A) } });
    const { svc } = service();
    const r = await svc.requestErasure({
      orgId: h.A.orgId,
      candidateId: cid,
      actorId: null,
      now: NOW,
    });
    expect(r.anonymised).toBe(false);
    expect(await h.owner.consent.count({ where: { sessionId: sessionIdOf(h.A) } })).toBe(
      consentsBefore,
    );
    expect((await h.owner.candidate.findUniqueOrThrow({ where: { id: cid } })).erasedAt).toBeNull();
  });

  it('TC-ERASE-03: a recorded manual notice anonymises the candidate (audited)', async () => {
    await setup(h.A, { submittedDaysAgo: 3, anchorDaysAgo: 3 });
    const cid = await candidateOf(h.A);
    const { svc } = service();
    await svc.requestErasure({ orgId: h.A.orgId, candidateId: cid, actorId: null, now: NOW });
    const r = await svc.recordManualNotice({
      orgId: h.A.orgId,
      candidateId: cid,
      actorId: (h.A.rows.User.unique as { id: string }).id,
      now: NOW,
    });
    expect(r.anonymised).toBe(true);
    const c = await h.owner.candidate.findUniqueOrThrow({ where: { id: cid } });
    expect(c.email).toBe(`erased+${cid}@invalid`);
    expect(c.fullName).toBe('Erased');
    expect(c.externalRef).toBeNull();
    expect(c.erasedAt).not.toBeNull();
    expect(
      await h.owner.auditLog.count({ where: { action: 'ERASURE_NOTICE_RECORDED', entityId: cid } }),
    ).toBe(1);
  });

  it('TC-ERASE-04 C-06: day 25 without a notice raises one alert, day 28 anonymises anyway', async () => {
    await setup(h.A, { submittedDaysAgo: 3, anchorDaysAgo: 3 });
    const cid = await candidateOf(h.A);
    const { svc, alerts } = service();
    await svc.requestErasure({ orgId: h.A.orgId, candidateId: cid, actorId: null, now: NOW });
    const later = (d: number) => new Date(NOW.getTime() + d * 86_400_000);
    await svc.run(h.A.orgId, cid, later(26));
    await svc.run(h.A.orgId, cid, later(27));
    expect(alerts.raised.filter((x) => x === 'ERASURE_DAY_25_NO_NOTICE')).toHaveLength(1);
    expect((await h.owner.candidate.findUniqueOrThrow({ where: { id: cid } })).erasedAt).toBeNull();
    const r = await svc.run(h.A.orgId, cid, later(28));
    expect(r.anonymised).toBe(true);
  });

  it('TC-ERASE-05: the hold (default on) skips an open appeal, tells the candidate once, and erases after it closes', async () => {
    await setup(h.A, {
      submittedDaysAgo: 3,
      anchorDaysAgo: 3,
      openAppeal: true,
      status: 'APPEALED',
    });
    const sid = sessionIdOf(h.A);
    const cid = await candidateOf(h.A);
    const { svc, fence, notices } = service();
    const r1 = await svc.requestErasure({
      orgId: h.A.orgId,
      candidateId: cid,
      actorId: null,
      now: NOW,
    });
    expect(r1.status).toBe('held');
    await svc.run(h.A.orgId, cid, NOW);
    expect(notices.delayed).toBe(1);
    expect(fence.calls).toHaveLength(0);
    expect((await h.owner.session.findUniqueOrThrow({ where: { id: sid } })).status).toBe(
      'APPEALED',
    );
    expect(h.store.keys.has(keys(h.A).media)).toBe(true);
    await h.owner.appeal.updateMany({
      where: { sessionReview: { sessionId: sid } },
      data: { status: 'UPHELD' },
    });
    await h.owner.session.update({ where: { id: sid }, data: { status: 'COMPLETED' } });
    const r2 = await svc.run(h.A.orgId, cid, NOW);
    expect(r2.status).toBe('completed');
  });

  it('TC-ERASE-06: with the hold switched off the fence closes the open appeal (CLOSED_ERASED) and the appeal text is blanked', async () => {
    await setup(h.A, {
      submittedDaysAgo: 3,
      anchorDaysAgo: 3,
      openAppeal: true,
      status: 'APPEALED',
    });
    const sid = sessionIdOf(h.A);
    const cid = await candidateOf(h.A);
    await h.owner.organization.update({
      where: { id: h.A.orgId },
      data: { settings: { erasure: { holdWhileReviewOrAppealOpen: false } } },
    });
    const { svc, fence } = service();
    const r = await svc.requestErasure({
      orgId: h.A.orgId,
      candidateId: cid,
      actorId: null,
      now: NOW,
    });
    expect(r.status).toBe('completed');
    expect(fence.calls[0]?.closeOpenAppeal).toBe(true);
    const a = await h.owner.appeal.findFirstOrThrow({
      where: { sessionReview: { sessionId: sid } },
    });
    expect(a.status).toBe('CLOSED_ERASED');
    expect(a.reason).toBe('Erased');
    expect(a.resolutionNote).toBeNull();
  });

  it('TC-ERASE-07: an invalid hold setting counts as on (fail toward the hold)', async () => {
    await setup(h.A, {
      submittedDaysAgo: 3,
      anchorDaysAgo: 3,
      openAppeal: true,
      status: 'APPEALED',
    });
    const cid = await candidateOf(h.A);
    await h.owner.organization.update({
      where: { id: h.A.orgId },
      data: { settings: { erasure: { holdWhileReviewOrAppealOpen: 'no' } } },
    });
    const { svc, fence } = service();
    const r = await svc.requestErasure({
      orgId: h.A.orgId,
      candidateId: cid,
      actorId: null,
      now: NOW,
    });
    expect(r.status).toBe('held');
    expect(fence.calls).toHaveLength(0);
  });

  it('TC-ERASE-08 C-06: an object that cannot be deleted blocks the rows and the completion, and a later run finishes', async () => {
    await setup(h.A, { submittedDaysAgo: 3, anchorDaysAgo: 3 });
    const sid = sessionIdOf(h.A);
    const cid = await candidateOf(h.A);
    const k = keys(h.A);
    h.store.failDeleteFor.add(k.media);
    const { svc } = service();
    const r = await svc.requestErasure({
      orgId: h.A.orgId,
      candidateId: cid,
      actorId: null,
      now: NOW,
    });
    expect(r.status).toBe('inProgress');
    expect(await completedRows(cid)).toHaveLength(0);
    expect(await h.owner.mediaChunk.count({ where: { sessionId: sid } })).toBeGreaterThan(0);
    h.store.failDeleteFor.clear();
    const r2 = await svc.run(h.A.orgId, cid, NOW);
    expect(r2.status).toBe('completed');
  });

  it('TC-ERASE-09 NFR-05: another tenant is untouched and a cross-org candidate id is not found', async () => {
    await setup(h.A, { submittedDaysAgo: 3, anchorDaysAgo: 3 });
    await setup(h.B, { submittedDaysAgo: 3, anchorDaysAgo: 3 });
    const cidA = await candidateOf(h.A);
    const { svc } = service();
    expect(
      (await svc.requestErasure({ orgId: h.B.orgId, candidateId: cidA, actorId: null, now: NOW }))
        .status,
    ).toBe('notFound');
    await svc.requestErasure({ orgId: h.A.orgId, candidateId: cidA, actorId: null, now: NOW });
    expect(h.store.keys.has(keys(h.B).media)).toBe(true);
    expect(
      await h.owner.mediaChunk.count({ where: { sessionId: sessionIdOf(h.B) } }),
    ).toBeGreaterThan(0);
  });

  it('TC-ERASE-10: runDue picks up an open request and skips a completed one', async () => {
    await setup(h.A, { submittedDaysAgo: 3, anchorDaysAgo: 3 });
    const cid = await candidateOf(h.A);
    await h.owner.candidate.update({
      where: { id: cid },
      data: { erasureRequestedAt: daysAgo(1) },
    });
    const { svc } = service();
    const r = await svc.runDue(NOW);
    expect(r.failed).toBe(0);
    expect(await completedRows(cid)).toHaveLength(1);
    expect(requestIdOf(cid, daysAgo(1))).toContain(cid);
  });
});
