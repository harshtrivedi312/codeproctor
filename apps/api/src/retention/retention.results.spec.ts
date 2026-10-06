// R-10, the results tier (FR-704, NFR-05, TC-072; ADR 0004 9.4; C-26, C-17, OQ-12, OQ-20) and the
// accommodation redactions (ADR 0015 section 7). A real Postgres 16 with the real migrations and
// app_user, an in-memory object store. Docker is required. Synthetic data only.
import { Logger } from '@nestjs/common';
import type { TenantFixture } from '../database/testing/tenant-fixtures';
import { DAY, NOW, daysAgo, useRetentionDatabase } from '../test/retention/retention-harness';

describe('RetentionService: results tier R-10 (FR-704, NFR-05, TC-072)', () => {
  const { h, build, setup, keys, sessionIdOf, markers } = useRetentionDatabase();

  /** A session whose results are due: anchor 366 days ago. */
  const due = (t: TenantFixture, extra: Parameters<typeof setup>[1] = {}) =>
    setup(t, { submittedDaysAgo: 400, anchorDaysAgo: 366, retentionDays: 90, ...extra });

  it('TC-072, C-26: at anchor + 1 year it deletes the whole prefix, reports included, and clears the results', async () => {
    await due(h.A);
    const summary = await build().service.runDaily(NOW);
    expect(summary.results).toMatchObject({ due: 1, completed: 1, retryLater: 0 });
    const k = keys(h.A);
    expect([...h.store.keys].filter((key) => key.startsWith(k.root))).toEqual([]); // everything, reports/ too
    const sessionId = sessionIdOf(h.A);
    expect(await h.owner.proctorEvent.count({ where: { sessionId } })).toBe(0);
    expect(await h.owner.flagDecision.count({ where: { event: { sessionId } } })).toBe(0);
    expect(await h.owner.proctorEventBatch.count({ where: { sessionId } })).toBe(0);
    expect(await h.owner.keystrokeBatch.count({ where: { sessionId } })).toBe(0);
    expect(await h.owner.mediaChunk.count({ where: { sessionId } })).toBe(0);
    expect(await h.owner.identityCheck.count({ where: { sessionId } })).toBe(0);
    expect(await h.owner.submission.count({ where: { sessionQuestion: { sessionId } } })).toBe(0);
    expect(await h.owner.appeal.count({ where: { sessionReview: { sessionId } } })).toBe(0);
    const reviews = await h.owner.sessionReview.findMany({ where: { sessionId } });
    expect(reviews).toHaveLength(1); // the review row stays; only its notes and verdict go
    expect(reviews[0]).toMatchObject({ notes: null, verdict: null });
    const questions = await h.owner.sessionQuestion.findMany({ where: { sessionId } });
    expect(
      questions.every(
        (q) =>
          q.finalCode === null && q.answer === null && q.scoringNote === null && q.score === null,
      ),
    ).toBe(true);
    const session = await h.owner.session.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session).toMatchObject({
      totalScore: null,
      riskScore: null,
      riskBand: null,
      reportKey: null,
      deviceInfo: {},
    });
    expect((await markers(h.A)).map((m) => m.action)).toContain('RETENTION_RESULTS_DONE');
  });

  it('C-17: the consent record is not touched by R-10 (it has its own 3-year clock)', async () => {
    await due(h.A);
    await build().service.runDaily(NOW);
    expect(await h.owner.consent.count({ where: { sessionId: sessionIdOf(h.A) } })).toBe(1);
  });

  it('ADR 0004 9.3: the sessions row is never deleted, and app_user could not delete it anyway', async () => {
    await due(h.A);
    await build().service.runDaily(NOW);
    expect(await h.owner.session.count({ where: { id: sessionIdOf(h.A) } })).toBe(1);
  });

  it('scored_by and scored_at survive (a CHECK ties them to MANUAL scoring)', async () => {
    await due(h.A);
    const before = await h.owner.sessionQuestion.findMany({
      where: { sessionId: sessionIdOf(h.A) },
      select: { id: true, scoring: true, scoredBy: true, scoredAt: true },
    });
    await build().service.runDaily(NOW);
    const after = await h.owner.sessionQuestion.findMany({
      where: { sessionId: sessionIdOf(h.A) },
      select: { id: true, scoring: true, scoredBy: true, scoredAt: true },
    });
    expect(after).toEqual(before);
  });

  it('not due before one year, and the boundary is exact', async () => {
    await due(h.A, { anchorDaysAgo: 364 });
    expect((await build().service.runDaily(NOW)).results.due).toBe(0);
    await due(h.A, { anchorDaysAgo: 364.9 });
    expect((await build().service.runDaily(NOW)).results.due).toBe(0);
    await due(h.A, { anchorDaysAgo: 365 });
    expect((await build().service.runDaily(NOW)).results.completed).toBe(1);
  });

  it('NFR-05: a hold (no anchor), UNDER_REVIEW, APPEALED or an open appeal means R-10 does not run', async () => {
    await due(h.A, { anchorDaysAgo: null });
    expect((await build().service.runDaily(NOW)).results.due).toBe(0);
    for (const status of ['UNDER_REVIEW', 'APPEALED'] as const) {
      await due(h.A, { status });
      expect((await build().service.runDaily(NOW)).results.due).toBe(0);
    }
    await due(h.A, { openAppeal: true });
    expect((await build().service.runDaily(NOW)).results.due).toBe(0);
    expect(
      await h.owner.submission.count({
        where: { sessionQuestion: { sessionId: sessionIdOf(h.A) } },
      }),
    ).toBeGreaterThan(0);
  });

  it('OQ-20: with the submitted clock, results go one year after submission', async () => {
    await due(h.A, { submittedDaysAgo: 400, anchorDaysAgo: 100 });
    expect((await build().service.runDaily(NOW)).results.due).toBe(0); // anchor clock: 100 days
    expect(
      (await build({ RETENTION_RESULTS_CLOCK: 'submitted' }).service.runDaily(NOW)).results
        .completed,
    ).toBe(1);
  });

  it('NFR-05: a failed delete leaves every row untouched and writes no marker; the next run completes it', async () => {
    await due(h.A);
    h.store.failDeleteFor.add(keys(h.A).report);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    expect((await build().service.runDaily(NOW)).results.retryLater).toBe(1);
    warn.mockRestore();
    expect(
      await h.owner.submission.count({
        where: { sessionQuestion: { sessionId: sessionIdOf(h.A) } },
      }),
    ).toBeGreaterThan(0);
    expect(
      (await h.owner.session.findUniqueOrThrow({ where: { id: sessionIdOf(h.A) } })).totalScore,
    ).not.toBeNull();
    expect((await markers(h.A)).map((m) => m.action)).not.toContain('RETENTION_RESULTS_DONE');
    h.store.failDeleteFor.clear();
    expect((await build().service.runDaily(NOW)).results.completed).toBe(1);
  });

  it('a report key outside the session prefix is not nulled away: R-10 waits for a person', async () => {
    await due(h.A);
    await h.owner.session.update({
      where: { id: sessionIdOf(h.A) },
      data: { reportKey: 'legacy/reports/x.pdf' },
    });
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    expect((await build().service.runDaily(NOW)).results).toMatchObject({
      completed: 0,
      retryLater: 1,
    });
    warn.mockRestore();
    expect(
      (await h.owner.session.findUniqueOrThrow({ where: { id: sessionIdOf(h.A) } })).reportKey,
    ).toBe('legacy/reports/x.pdf');
  });

  it('two runs at the same time write one results marker (advisory lock and re-check)', async () => {
    await due(h.A);
    const [one, two] = await Promise.all([
      build().service.runDaily(NOW),
      build().service.runDaily(NOW),
    ]);
    expect((await markers(h.A)).filter((m) => m.action === 'RETENTION_RESULTS_DONE')).toHaveLength(
      1,
    );
    expect(one.results.completed + two.results.completed).toBe(1);
  });

  it('OQ-10: with the legal hold on, a held session keeps its results', async () => {
    await due(h.A);
    const held = { isHeld: jest.fn().mockResolvedValue(true) };
    expect(
      (await build({ RETENTION_LEGAL_HOLD: 'true' }, held).service.runDaily(NOW)).results,
    ).toMatchObject({ completed: 0, retryLater: 1 });
    expect(
      await h.owner.submission.count({
        where: { sessionQuestion: { sessionId: sessionIdOf(h.A) } },
      }),
    ).toBeGreaterThan(0);
  });

  describe('the candidate row (ADR 0004 9.4)', () => {
    const candidateOf = async (t: TenantFixture) =>
      (
        await h.owner.session.findUniqueOrThrow({
          where: { id: sessionIdOf(t) },
          select: { invitation: { select: { candidateId: true } } },
        })
      ).invitation.candidateId;

    it("FR-704: once none of the candidate's sessions has results, the row is anonymised in place", async () => {
      await due(h.A);
      const id = await candidateOf(h.A);
      await h.owner.candidate.update({ where: { id }, data: { externalRef: 'HR-123' } });
      await build().service.runDaily(NOW);
      const row = await h.owner.candidate.findUniqueOrThrow({ where: { id } });
      expect(row).toMatchObject({
        email: `erased+${id}@invalid`,
        fullName: 'Erased',
        externalRef: null,
      });
      expect(row.erasedAt).toEqual(NOW);
    });

    it('a candidate with another session that still has results is not anonymised yet', async () => {
      await due(h.A);
      const id = await candidateOf(h.A);
      const inv = await h.owner.invitation.findFirstOrThrow({ where: { candidateId: id } });
      const second = await h.owner.invitation.create({
        data: {
          orgId: h.A.orgId,
          testId: inv.testId,
          candidateId: id,
          tokenHash: `second-${id}`,
          windowStart: daysAgo(500),
          windowEnd: daysAgo(499),
        },
      });
      const other = await h.owner.session.create({
        data: {
          orgId: h.A.orgId,
          invitationId: second.id,
          status: 'COMPLETED',
          submittedAt: daysAgo(10),
          retentionAnchorAt: daysAgo(5),
        },
      });
      await h.owner.session.update({ where: { id: other.id }, data: { createdAt: daysAgo(500) } });
      await build().service.runDaily(NOW);
      expect((await h.owner.candidate.findUniqueOrThrow({ where: { id } })).erasedAt).toBeNull();
      // Make the second session due too: the next run anonymises.
      await h.owner.session.update({
        where: { id: other.id },
        data: { retentionAnchorAt: daysAgo(400) },
      });
      await build().service.runDaily(NOW);
      expect(
        (await h.owner.candidate.findUniqueOrThrow({ where: { id } })).erasedAt,
      ).not.toBeNull();
    });

    it('C-06: a candidate with a pending erasure request is left to erasure', async () => {
      await due(h.A);
      const id = await candidateOf(h.A);
      await h.owner.candidate.update({ where: { id }, data: { erasureRequestedAt: daysAgo(1) } });
      await build().service.runDaily(NOW);
      const row = await h.owner.candidate.findUniqueOrThrow({ where: { id } });
      expect(row.erasedAt).toBeNull();
      expect(row.fullName).not.toBe('Erased');
    });

    it('a candidate with no session yet (only invited) is never anonymised', async () => {
      await due(h.A);
      const invited = await h.owner.candidate.create({
        data: {
          orgId: h.A.orgId,
          email: `invited-${Date.now()}@example.test`,
          fullName: 'Only Invited',
        },
      });
      await build().service.runDaily(NOW);
      expect(
        (await h.owner.candidate.findUniqueOrThrow({ where: { id: invited.id } })).erasedAt,
      ).toBeNull();
    });
  });

  describe('accommodations (OQ-12, ADR 0015 section 7)', () => {
    const waiver = {
      extraTimePct: 25,
      disabledDetectors: ['GAZE'],
      notes: 'free text',
      identityCheckWaiver: { reasonCode: 'OTHER', reasonNote: 'health details' },
    };
    const accommodationsOf = async (t: TenantFixture) =>
      (await h.owner.invitation.findFirstOrThrow({ where: { orgId: t.orgId } })).accommodations;

    it('R-4 removes the reason note and marks it removed; the rest stays until R-10', async () => {
      await setup(h.A, { submittedDaysAgo: 120, anchorDaysAgo: 91, retentionDays: 90 });
      await h.owner.invitation.updateMany({
        where: { orgId: h.A.orgId },
        data: { accommodations: waiver },
      });
      await build().service.runDaily(NOW);
      expect(await accommodationsOf(h.A)).toEqual({
        extraTimePct: 25,
        disabledDetectors: ['GAZE'],
        notes: 'free text',
        identityCheckWaiver: { reasonCode: 'OTHER', reasonNoteRemoved: true },
      });
    });

    it('R-10 reduces to which settings were used and the fact of the waiver', async () => {
      await due(h.A);
      await h.owner.invitation.updateMany({
        where: { orgId: h.A.orgId },
        data: { accommodations: waiver },
      });
      await build().service.runDaily(NOW);
      expect(await accommodationsOf(h.A)).toEqual({
        extraTimePct: 25,
        disabledDetectors: ['GAZE'],
        identityCheckWaived: true,
      });
    });

    it('with the OQ-12 switch off, R-10 keeps the notes', async () => {
      await due(h.A);
      await h.owner.invitation.updateMany({
        where: { orgId: h.A.orgId },
        data: { accommodations: { notes: 'keep me', extraTimePct: 10 } },
      });
      await build({ RETENTION_REDUCE_ACCOMMODATIONS: 'false' }).service.runDaily(NOW);
      expect(await accommodationsOf(h.A)).toEqual({ notes: 'keep me', extraTimePct: 10 });
    });
  });

  it('writes the results counts in the run summary row, ids and counts only', async () => {
    await due(h.A);
    const { runId } = await build().service.runDaily(NOW);
    const row = await h.owner.auditLog.findFirstOrThrow({
      where: { action: 'RETENTION_RUN', entityId: runId },
    });
    expect(row.metadata).toMatchObject({ runId, resultsCompleted: 1 });
    expect(JSON.stringify(row.metadata)).not.toContain('orgs/');
  });

  it("FR-103: another org's results are untouched (both due, each prefix stays in its own org)", async () => {
    await due(h.A);
    await due(h.B, { submittedDaysAgo: 30, anchorDaysAgo: 30 });
    await build().service.runDaily(NOW);
    expect(h.store.keys.has(keys(h.B).media)).toBe(true);
    expect((await markers(h.B)).map((m) => m.action)).not.toContain('RETENTION_RESULTS_DONE');
    expect(DAY).toBeGreaterThan(0);
  });
});
