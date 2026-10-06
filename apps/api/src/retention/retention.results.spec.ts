// R-10, the results tier (FR-704, NFR-05, TC-072; ADR 0004 9.4; C-26, C-17, OQ-12, OQ-20) and the
// accommodation redactions (ADR 0015 section 7). A real Postgres 16 with the real migrations and
// app_user, an in-memory object store. Docker is required. Synthetic data only.
import { Logger } from '@nestjs/common';
import type { TenantFixture } from '../database/testing/tenant-fixtures';
import { NOW, daysAgo, useRetentionDatabase } from '../test/retention/retention-harness';
import { reduceAccommodations } from './accommodations';

describe('RetentionService: results tier R-10 (FR-704, NFR-05, TC-072)', () => {
  const { h, build, setup, keys, sessionIdOf, markers } = useRetentionDatabase();

  /** Everything R-10 needs, for calling the repository directly. */
  const complete = (t: TenantFixture, over: Record<string, unknown> = {}) => {
    const { repo } = build();
    return repo.inOrg(t.orgId, () =>
      repo.completeResults({
        orgId: t.orgId,
        sessionId: sessionIdOf(t),
        reduceAccommodationsOnRun: true,
        clock: 'anchor',
        now: NOW,
        runId: 'run-test',
        ...over,
      }),
    );
  };

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
    h.store.put(keys(h.A).consentPdf);
    await build().service.runDaily(NOW);
    expect(await h.owner.consent.count({ where: { sessionId: sessionIdOf(h.A) } })).toBe(1);
    expect(h.store.keys.has(keys(h.A).consentPdf)).toBe(true); // the PDF is outside the session prefix
  });

  it('ADR 0004 9.3: R-10 never deletes the sessions row', async () => {
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

    it('B2: with the OQ-12 switch off, R-10 keeps the notes but still removes the waiver reason', async () => {
      await due(h.A);
      await h.owner.invitation.updateMany({
        where: { orgId: h.A.orgId },
        data: { accommodations: waiver },
      });
      await build({ RETENTION_REDUCE_ACCOMMODATIONS: 'false' }).service.runDaily(NOW);
      expect(await accommodationsOf(h.A)).toEqual({
        extraTimePct: 25,
        disabledDetectors: ['GAZE'],
        notes: 'free text',
        identityCheckWaived: true,
      });
    });

    it('S3: the compare-and-set really rejects a changed value: a PATCH between the read and the write survives and is then reduced', async () => {
      await due(h.A);
      await h.owner.invitation.updateMany({
        where: { orgId: h.A.orgId },
        data: { accommodations: waiver },
      });
      const { repo, prisma } = build();
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      let raced = false;
      await repo.inOrg(h.A.orgId, () =>
        prisma.client.$transaction(async (tx) => {
          await repo.casAccommodations(tx, sessionIdOf(h.A), async (value) => {
            if (!raced) {
              raced = true;
              // A PATCH commits after the job read the value.
              await h.owner.invitation.updateMany({
                where: { orgId: h.A.orgId },
                data: { accommodations: { extraTimePct: 99, notes: 'patched' } },
              });
            }
            return reduceAccommodations(value);
          });
        }),
      );
      const logged = warn.mock.calls.map((c) => String(c[0])).join();
      warn.mockRestore();
      expect(logged).toContain('compare-and-set'); // the lost race is reported (ids only)
      expect(await accommodationsOf(h.A)).toEqual({ extraTimePct: 99 }); // the PATCH value, then reduced; never the stale one
    });

    it('S3 (ADR 0015): stored keys in another order plus a legacy key still match and are reduced', async () => {
      await due(h.A);
      await h.owner.$executeRawUnsafe(
        `UPDATE invitations SET accommodations = '{"legacy": 1, "notes": "x", "extraTimePct": 10}'::jsonb WHERE org_id = '${h.A.orgId}'`,
      );
      await build().service.runDaily(NOW);
      expect(await accommodationsOf(h.A)).toEqual({ extraTimePct: 10 });
    });
  });

  it('B1: results and the candidate row change in ONE transaction: a failing anonymisation rolls everything back, and the next run completes both', async () => {
    await due(h.A);
    await h.owner.$executeRawUnsafe(
      `CREATE OR REPLACE FUNCTION fail_anonymise() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated failure'; END $$`,
    );
    await h.owner.$executeRawUnsafe(
      `CREATE TRIGGER fail_anonymise_trigger BEFORE UPDATE OF full_name ON candidates FOR EACH ROW WHEN (NEW.full_name = 'Erased') EXECUTE FUNCTION fail_anonymise()`,
    );
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      expect((await build().service.runDaily(NOW)).results).toMatchObject({
        completed: 0,
        retryLater: 1,
      });
    } finally {
      warn.mockRestore();
      await h.owner.$executeRawUnsafe('DROP TRIGGER fail_anonymise_trigger ON candidates');
      await h.owner.$executeRawUnsafe('DROP FUNCTION fail_anonymise()');
    }
    // Nothing happened: the results are still there and there is no marker, so tomorrow's run still selects it.
    expect(
      await h.owner.submission.count({
        where: { sessionQuestion: { sessionId: sessionIdOf(h.A) } },
      }),
    ).toBeGreaterThan(0);
    expect((await markers(h.A)).map((m) => m.action)).not.toContain('RETENTION_RESULTS_DONE');
    const summary = await build().service.runDaily(NOW);
    expect(summary.results.completed).toBe(1);
    expect(summary.candidatesAnonymised).toBe(1);
  });

  it('B1: the daily backstop anonymises a candidate whose sessions all have the marker but who was never anonymised', async () => {
    await due(h.A);
    const owner = await h.owner.session.findUniqueOrThrow({
      where: { id: sessionIdOf(h.A) },
      select: { invitation: { select: { candidateId: true } } },
    });
    const id = owner.invitation.candidateId;
    // The state an older run (or a late-added session) could leave: a marker, an un-anonymised candidate.
    await h.owner.auditLog.create({
      data: {
        orgId: h.A.orgId,
        action: 'RETENTION_RESULTS_DONE',
        entityType: 'session',
        entityId: sessionIdOf(h.A),
      },
    });
    const summary = await build().service.runDaily(NOW);
    expect(summary.candidatesAnonymised).toBe(1);
    expect((await h.owner.candidate.findUniqueOrThrow({ where: { id } })).fullName).toBe('Erased');
    const row = await h.owner.auditLog.findFirstOrThrow({
      where: { action: 'CANDIDATE_ANONYMISED', entityId: id },
    });
    expect(Object.keys(row.metadata as object)).toEqual(['runId']); // ids only
  });

  it('S1: the holds are read again inside the transaction: an appeal opened after selection stops R-10 with nothing changed', async () => {
    await due(h.A);
    const reviewOf = { sessionReview: { sessionId: sessionIdOf(h.A) } };
    await h.owner.appeal.updateMany({ where: reviewOf, data: { status: 'OPEN' } });
    expect(await complete(h.A)).toEqual({ kind: 'notEligible' });
    await h.owner.appeal.updateMany({ where: reviewOf, data: { status: 'UPHELD' } });
    await h.owner.session.update({ where: { id: sessionIdOf(h.A) }, data: { status: 'APPEALED' } });
    expect(await complete(h.A)).toEqual({ kind: 'notEligible' });
    // An anchor cleared and set again after selection must not make results go early.
    await h.owner.session.update({
      where: { id: sessionIdOf(h.A) },
      data: { status: 'COMPLETED', retentionAnchorAt: daysAgo(10) },
    });
    expect(await complete(h.A)).toEqual({ kind: 'notEligible' });
    expect(
      await h.owner.submission.count({
        where: { sessionQuestion: { sessionId: sessionIdOf(h.A) } },
      }),
    ).toBeGreaterThan(0);
    expect(await markers(h.A)).toHaveLength(0);
    await h.owner.session.update({
      where: { id: sessionIdOf(h.A) },
      data: { retentionAnchorAt: daysAgo(400) },
    });
    expect(await complete(h.A)).toMatchObject({ kind: 'done' });
  });

  it('S4, OQ-20: with the submitted clock, a session that was never submitted falls back to its anchor and is still purged', async () => {
    await due(h.A, { submittedDaysAgo: null, anchorDaysAgo: 400, status: 'EXPIRED' });
    expect(
      (await build({ RETENTION_RESULTS_CLOCK: 'submitted' }).service.runDaily(NOW)).results
        .completed,
    ).toBe(1);
  });

  it('S7: the year is a calendar year: across a leap day, 365 days later is not yet due', async () => {
    await due(h.A, { submittedDaysAgo: 800, anchorDaysAgo: 800 });
    const anchor = new Date('2024-02-28T12:00:00.000Z');
    await h.owner.session.update({
      where: { id: sessionIdOf(h.A) },
      data: { retentionAnchorAt: anchor, submittedAt: anchor },
    });
    expect((await build().service.runDaily(new Date('2025-02-27T12:00:00.000Z'))).results.due).toBe(
      0,
    ); // 365 days
    expect(
      (await build().service.runDaily(new Date('2025-02-28T12:00:00.000Z'))).results.completed,
    ).toBe(1);
  });

  it('S2: R-10 checks the clock date BEFORE deleting anything: a stale selection leaves the report and every row alone', async () => {
    await due(h.A, { anchorDaysAgo: 10 }); // not due: the anchor was cleared and set again after selection
    const { repo, service } = build();
    jest.spyOn(repo, 'findDueResults').mockResolvedValueOnce([
      {
        sessionId: sessionIdOf(h.A),
        orgId: h.A.orgId,
        createdAtCursor: '2020-01-01T00:00:00.000000Z',
      },
    ]);
    const summary = await service.runDaily(NOW);
    expect(summary.results).toMatchObject({ due: 1, completed: 0, retryLater: 1 });
    expect(h.store.keys.has(keys(h.A).report)).toBe(true); // reports/ is R-10's, and it is not due
    expect(
      await h.owner.submission.count({
        where: { sessionQuestion: { sessionId: sessionIdOf(h.A) } },
      }),
    ).toBeGreaterThan(0);
  });

  it('OQ-10: the candidate backstop honours the legal hold: a held candidate is not anonymised', async () => {
    await due(h.A);
    const id = (
      await h.owner.session.findUniqueOrThrow({
        where: { id: sessionIdOf(h.A) },
        select: { invitation: { select: { candidateId: true } } },
      })
    ).invitation.candidateId;
    await h.owner.auditLog.create({
      data: {
        orgId: h.A.orgId,
        action: 'RETENTION_RESULTS_DONE',
        entityType: 'session',
        entityId: sessionIdOf(h.A),
      },
    });
    const held = { isHeld: jest.fn().mockResolvedValue(true) };
    const summary = await build({ RETENTION_LEGAL_HOLD: 'true' }, held).service.runDaily(NOW);
    expect(summary.candidatesAnonymised).toBe(0);
    expect((await h.owner.candidate.findUniqueOrThrow({ where: { id } })).erasedAt).toBeNull();
    held.isHeld.mockRejectedValue(new Error('down')); // an unreadable hold counts as held
    expect(
      (await build({ RETENTION_LEGAL_HOLD: 'true' }, held).service.runDaily(NOW))
        .candidatesAnonymised,
    ).toBe(0);
  });

  it("S3: a duplicate marker on one session does not stand in for another session's marker", async () => {
    await due(h.A);
    const id = (
      await h.owner.session.findUniqueOrThrow({
        where: { id: sessionIdOf(h.A) },
        select: { invitation: { select: { candidateId: true } } },
      })
    ).invitation.candidateId;
    const inv = await h.owner.invitation.findFirstOrThrow({ where: { candidateId: id } });
    const second = await h.owner.invitation.create({
      data: {
        orgId: h.A.orgId,
        testId: inv.testId,
        candidateId: id,
        tokenHash: `dup-${id}`,
        windowStart: daysAgo(500),
        windowEnd: daysAgo(499),
      },
    });
    await h.owner.session.create({
      data: { orgId: h.A.orgId, invitationId: second.id, status: 'COMPLETED' },
    });
    for (let i = 0; i < 2; i++) {
      await h.owner.auditLog.create({
        data: {
          orgId: h.A.orgId,
          action: 'RETENTION_RESULTS_DONE',
          entityType: 'session',
          entityId: sessionIdOf(h.A),
        },
      });
    }
    const { repo } = build();
    const did = await repo.inOrg(h.A.orgId, () =>
      repo.anonymiseCandidateIfDone({
        orgId: h.A.orgId,
        candidateId: id,
        now: NOW,
        runId: 'run-test',
      }),
    );
    expect(did).toBe(false); // the second session has no marker
    expect((await h.owner.candidate.findUniqueOrThrow({ where: { id } })).erasedAt).toBeNull();
  });

  it('S7: a 29 February anchor clamps to 28 February in SQL and in JS alike', async () => {
    await due(h.A, { submittedDaysAgo: 800, anchorDaysAgo: 800 });
    const anchor = new Date('2024-02-29T12:00:00.000Z');
    await h.owner.session.update({
      where: { id: sessionIdOf(h.A) },
      data: { retentionAnchorAt: anchor, submittedAt: anchor },
    });
    expect((await build().service.runDaily(new Date('2025-02-27T12:00:00.000Z'))).results.due).toBe(
      0,
    );
    expect(
      (await build().service.runDaily(new Date('2025-02-28T12:00:00.000Z'))).results.completed,
    ).toBe(1);
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

  it("FR-103: with both orgs due, each org's rows, objects and marker are handled once, in its own org", async () => {
    await due(h.A);
    await due(h.B);
    const summary = await build().service.runDaily(NOW);
    expect(summary.results).toMatchObject({ due: 2, completed: 2 });
    for (const t of [h.A, h.B]) {
      expect([...h.store.keys].filter((key) => key.startsWith(keys(t).root))).toEqual([]);
      const found = (await markers(t)).filter((m) => m.action === 'RETENTION_RESULTS_DONE');
      expect(found).toHaveLength(1);
      expect(found[0]?.orgId).toBe(t.orgId);
      expect(
        (await h.owner.session.findUniqueOrThrow({ where: { id: sessionIdOf(t) } })).totalScore,
      ).toBeNull();
    }
  });
});
