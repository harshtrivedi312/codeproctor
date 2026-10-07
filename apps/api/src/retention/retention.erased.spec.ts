// How retention treats the ERASED session status and the CLOSED_ERASED appeal status (ADR 0004 9.3,
// 9.5; FR-704, TC-094). An erased session still reaches the media tier and R-10; a closed-by-erasure
// appeal never holds a tier. A real Postgres 16, an in-memory object store. Synthetic data only.
import { NOW, useRetentionDatabase } from '../test/retention/retention-harness';

describe('RetentionService with ERASED sessions and CLOSED_ERASED appeals (FR-704, TC-094)', () => {
  const { h, build, setup, sessionIdOf, markers } = useRetentionDatabase();

  it('TC-094: an ERASED session with an anchor is selected by the face, media and results tiers', async () => {
    await setup(h.A, {
      submittedDaysAgo: 400,
      anchorDaysAgo: 366,
      retentionDays: 90,
      status: 'ERASED',
    });
    const summary = await build().service.runDaily(NOW);
    expect(summary.face).toMatchObject({ due: 1, completed: 1 });
    expect(summary.media).toMatchObject({ due: 1, completed: 1 });
    expect(summary.results).toMatchObject({ due: 1, completed: 1 });
    expect((await markers(h.A)).map((m) => m.action).sort()).toEqual([
      'RETENTION_FACE_DONE',
      'RETENTION_MEDIA_DONE',
      'RETENTION_RESULTS_DONE',
    ]);
  });

  it('TC-094: a CLOSED_ERASED appeal does not hold the media or results tier', async () => {
    await setup(h.A, { submittedDaysAgo: 400, anchorDaysAgo: 366, retentionDays: 90 });
    const closed = await h.owner.appeal.updateMany({
      where: { sessionReview: { sessionId: sessionIdOf(h.A) } },
      data: { status: 'CLOSED_ERASED' },
    });
    expect(closed.count).toBe(1);
    const summary = await build().service.runDaily(NOW);
    expect(summary.media).toMatchObject({ due: 1, completed: 1 });
    expect(summary.results).toMatchObject({ due: 1, completed: 1 });
  });

  it('TC-094: an OPEN appeal still holds the tiers (the contrast case)', async () => {
    await setup(h.A, {
      submittedDaysAgo: 400,
      anchorDaysAgo: 366,
      retentionDays: 90,
      openAppeal: true,
    });
    const summary = await build().service.runDaily(NOW);
    expect(summary.media.completed).toBe(0);
    expect(summary.results.completed).toBe(0);
  });
});
