// R-9, consent records (FR-704, NFR-05; ADR 0004 9.3; C-04, C-17, OQ-11, OQ-10). A real Postgres 16
// with the real migrations and app_user, an in-memory object store. Docker is required. Synthetic data only.
import { Logger } from '@nestjs/common';
import type { TenantFixture } from '../database/testing/tenant-fixtures';
import { NOW, daysAgo, useRetentionDatabase } from '../test/retention/retention-harness';

const THREE_YEARS_AGO = new Date('2023-10-05T12:00:00.000Z'); // exactly 3 years before NOW

describe('RetentionService: consent records R-9 (FR-704, NFR-05)', () => {
  const { h, build, setup, keys, sessionIdOf } = useRetentionDatabase();

  const consentOf = (t: TenantFixture) =>
    h.owner.consent.findMany({ where: { sessionId: sessionIdOf(t) } });

  /** A consent record signed at `signedAt` with its PDF in the store. */
  async function sign(t: TenantFixture, signedAt: Date): Promise<void> {
    await setup(t, { submittedDaysAgo: 30, anchorDaysAgo: 30 });
    await h.owner.consent.updateMany({
      where: { sessionId: sessionIdOf(t) },
      data: { signedAt, declinedAt: null, pdfKey: keys(t).consentPdf },
    });
    h.store.put(keys(t).consentPdf);
  }

  it('C-04, C-17: 3 years after signing it deletes the PDF prefix and the row, and writes an ids-only audit row', async () => {
    await sign(h.A, THREE_YEARS_AGO);
    const summary = await build().service.runDaily(NOW);
    expect(summary.consent).toMatchObject({ due: 1, completed: 1, retryLater: 0 });
    expect(h.store.keys.has(keys(h.A).consentPdf)).toBe(false);
    expect(await consentOf(h.A)).toHaveLength(0);
    expect(await h.owner.session.count({ where: { id: sessionIdOf(h.A) } })).toBe(1); // the session row stays
    const rows = await h.owner.auditLog.findMany({
      where: { action: 'CONSENT_RECORD_DELETED', entityId: sessionIdOf(h.A) },
    });
    expect(rows).toHaveLength(1);
    expect(Object.keys((rows[0]?.metadata ?? {}) as object).sort()).toEqual(['consentId', 'runId']);
    expect(JSON.stringify(rows[0]?.metadata)).not.toMatch(/Candidate|orgs\//); // no name, no key
  });

  it('not due one second before the 3-year mark', async () => {
    await sign(h.A, new Date(THREE_YEARS_AGO.getTime() + 1000));
    expect((await build().service.runDaily(NOW)).consent.due).toBe(0);
    expect(await consentOf(h.A)).toHaveLength(1);
    expect(h.store.keys.has(keys(h.A).consentPdf)).toBe(true);
  });

  it('C-17: the other session objects are not touched (the consent prefix is outside the session prefix)', async () => {
    await sign(h.A, THREE_YEARS_AGO);
    await build().service.runDaily(NOW);
    expect(h.store.keys.has(keys(h.A).media)).toBe(true); // the session media stays until its own clock
  });

  it('OQ-11: a declined consent follows the same clock by default, and is kept when the switch is off', async () => {
    await sign(h.A, NOW);
    await h.owner.consent.updateMany({
      where: { sessionId: sessionIdOf(h.A) },
      data: { signedAt: null, signedName: null, declinedAt: THREE_YEARS_AGO },
    });
    expect(
      (await build({ RETENTION_DECLINED_CONSENTS_EXPIRE: 'false' }).service.runDaily(NOW)).consent
        .due,
    ).toBe(0);
    expect(await consentOf(h.A)).toHaveLength(1);
    expect((await build().service.runDaily(NOW)).consent.completed).toBe(1);
    expect(await consentOf(h.A)).toHaveLength(0);
  });

  it('ADR 0004 9.3 "Skip": a record whose session is UNDER_REVIEW or APPEALED, or has an open appeal, is kept', async () => {
    await sign(h.A, THREE_YEARS_AGO);
    for (const status of ['UNDER_REVIEW', 'APPEALED'] as const) {
      await h.owner.session.update({ where: { id: sessionIdOf(h.A) }, data: { status } });
      expect((await build().service.runDaily(NOW)).consent.due).toBe(0);
    }
    await h.owner.session.update({
      where: { id: sessionIdOf(h.A) },
      data: { status: 'COMPLETED' },
    });
    await h.owner.appeal.updateMany({
      where: { sessionReview: { sessionId: sessionIdOf(h.A) } },
      data: { status: 'OPEN' },
    });
    expect((await build().service.runDaily(NOW)).consent.due).toBe(0);
    expect(await consentOf(h.A)).toHaveLength(1);
    await h.owner.appeal.updateMany({
      where: { sessionReview: { sessionId: sessionIdOf(h.A) } },
      data: { status: 'UPHELD' },
    });
    expect((await build().service.runDaily(NOW)).consent.completed).toBe(1);
  });

  it('a session stuck in a non-terminal state does not block R-9 (the skip is only for a review or appeal)', async () => {
    await sign(h.A, THREE_YEARS_AGO);
    await h.owner.session.update({
      where: { id: sessionIdOf(h.A) },
      data: { status: 'IN_PROGRESS' },
    });
    expect((await build().service.runDaily(NOW)).consent.completed).toBe(1);
  });

  it('NFR-05: a failed delete keeps the row (its only pointer to the prefix) and writes no audit row; the next run completes it', async () => {
    await sign(h.A, THREE_YEARS_AGO);
    h.store.failDeleteFor.add(keys(h.A).consentPdf);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    expect((await build().service.runDaily(NOW)).consent).toMatchObject({
      completed: 0,
      retryLater: 1,
    });
    expect(warn.mock.calls.map((c) => String(c[0])).join()).not.toContain('orgs/');
    warn.mockRestore();
    expect(await consentOf(h.A)).toHaveLength(1);
    expect(
      await h.owner.auditLog.count({
        where: { action: 'CONSENT_RECORD_DELETED', entityId: sessionIdOf(h.A) },
      }),
    ).toBe(0);
    h.store.failDeleteFor.clear();
    expect((await build().service.runDaily(NOW)).consent.completed).toBe(1);
  });

  it('an object that survives the delete is not verified: the row stays', async () => {
    await sign(h.A, THREE_YEARS_AGO);
    h.store.resurrect.add(keys(h.A).consentPdf);
    expect((await build().service.runDaily(NOW)).consent.retryLater).toBe(1);
    expect(await consentOf(h.A)).toHaveLength(1);
  });

  it('a PDF key outside the consent prefix keeps the row: deleting it would orphan the object', async () => {
    await sign(h.A, THREE_YEARS_AGO);
    await h.owner.consent.updateMany({
      where: { sessionId: sessionIdOf(h.A) },
      data: { pdfKey: 'legacy/consents/x.pdf' },
    });
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    expect((await build().service.runDaily(NOW)).consent.retryLater).toBe(1);
    warn.mockRestore();
    expect(await consentOf(h.A)).toHaveLength(1);
  });

  it('a record with no PDF yet (a decline, or generation pending) is deleted once the prefix is verified empty', async () => {
    await sign(h.A, THREE_YEARS_AGO);
    h.store.keys.delete(keys(h.A).consentPdf);
    await h.owner.consent.updateMany({
      where: { sessionId: sessionIdOf(h.A) },
      data: { pdfKey: null },
    });
    expect((await build().service.runDaily(NOW)).consent.completed).toBe(1);
  });

  it('OQ-10: with the legal hold on, a held session keeps its consent record', async () => {
    await sign(h.A, THREE_YEARS_AGO);
    const held = { isHeld: jest.fn().mockResolvedValue(true) };
    expect(
      (await build({ RETENTION_LEGAL_HOLD: 'true' }, held).service.runDaily(NOW)).consent,
    ).toMatchObject({ completed: 0, retryLater: 1 });
    expect(await consentOf(h.A)).toHaveLength(1);
  });

  it("FR-103: it deletes only the due record; another org's young record stays", async () => {
    await sign(h.A, THREE_YEARS_AGO);
    await sign(h.B, daysAgo(400));
    await build().service.runDaily(NOW);
    expect(await consentOf(h.A)).toHaveLength(0);
    expect(await consentOf(h.B)).toHaveLength(1);
    expect(h.store.keys.has(keys(h.B).consentPdf)).toBe(true);
  });

  it('paging: more due records than one page are all processed, each once', async () => {
    await sign(h.A, THREE_YEARS_AGO);
    await sign(h.B, new Date(THREE_YEARS_AGO.getTime() - 5)); // a hair apart
    const summary = await build({ RETENTION_BATCH_SIZE: '1' }).service.runDaily(NOW);
    expect(summary.consent).toMatchObject({ due: 2, completed: 2 });
  });

  it('a second run does nothing', async () => {
    await sign(h.A, THREE_YEARS_AGO);
    await build().service.runDaily(NOW);
    expect((await build().service.runDaily(NOW)).consent.due).toBe(0);
  });
});
