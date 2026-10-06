// Verified deletion and the versioning gate (FR-704, NFR-05, TC-072; ADR 0004 9.2).
import { REPORTS_SUBPREFIX } from './retention.constants';
import {
  assertVersioningSafe,
  deleteVerified,
  versioningIsSafe,
  VersioningUnsafeError,
} from './verified-delete';
import { InMemoryObjectStore } from '../test/retention/in-memory-object-store';

const P = 'orgs/o1/sessions/s1/';
const keep = (key: string): boolean => key.startsWith(`${P}${REPORTS_SUBPREFIX}`);

describe('deleteVerified (ADR 0004 9.2)', () => {
  it('TC-072: deletes every page and verifies with a fresh listing', async () => {
    const store = new InMemoryObjectStore();
    store.pageSize = 3;
    for (let i = 0; i < 10; i++)
      store.put(`${P}media/webcam/000000/${String(i).padStart(8, '0')}.webm`);
    store.put('orgs/o1/sessions/s2/media/other.webm');
    expect(await deleteVerified(store, [P])).toEqual({ verified: true, deleted: 10 });
    expect([...store.keys]).toEqual(['orgs/o1/sessions/s2/media/other.webm']);
  });

  it('keeps what `keep` names (the media tier keeps reports/) and still verifies', async () => {
    const store = new InMemoryObjectStore();
    store.put(`${P}reports/a.pdf`, `${P}media/x.webm`, `${P}live/t.jpg`);
    expect(await deleteVerified(store, [P], keep)).toEqual({ verified: true, deleted: 2 });
    expect([...store.keys]).toEqual([`${P}reports/a.pdf`]);
  });

  it('an empty prefix is verified with nothing deleted', async () => {
    expect(await deleteVerified(new InMemoryObjectStore(), [P])).toEqual({
      verified: true,
      deleted: 0,
    });
  });

  it('NFR-05: a DeleteObjects error means not verified, and the run stops there', async () => {
    const store = new InMemoryObjectStore();
    store.put(`${P}a`, `${P}b`);
    store.failDeleteFor.add(`${P}a`);
    expect((await deleteVerified(store, [P])).verified).toBe(false);
  });

  it('NFR-05: an object that is still listed after the delete means not verified', async () => {
    const store = new InMemoryObjectStore();
    store.put(`${P}a`, `${P}b`);
    store.resurrect.add(`${P}b`);
    expect((await deleteVerified(store, [P])).verified).toBe(false);
  });

  it('NFR-05: a listing error is not verified, and the error never carries a key', async () => {
    const store = new InMemoryObjectStore();
    store.put(`${P}a`);
    store.failList = true;
    await expect(deleteVerified(store, [P])).resolves.toEqual({ verified: false, deleted: 0 });
  });

  it('deletes in batches of at most 1000 keys', async () => {
    const store = new InMemoryObjectStore();
    for (let i = 0; i < 2500; i++) store.put(`${P}k${i}`);
    expect((await deleteVerified(store, [P])).verified).toBe(true);
    expect(store.deleteCalls).toBe(3);
  });

  it('handles several prefixes (the face tier: identity/ and evidence/sealed/)', async () => {
    const store = new InMemoryObjectStore();
    store.put(`${P}identity/1/sealed/id.jpg`, `${P}evidence/sealed/e.jpg`, `${P}evidence/e2.jpg`);
    const result = await deleteVerified(store, [`${P}identity/`, `${P}evidence/sealed/`]);
    expect(result).toEqual({ verified: true, deleted: 2 });
    expect([...store.keys]).toEqual([`${P}evidence/e2.jpg`]);
  });
});

describe('versioning gate (ADR 0004 9.2, pilot gate)', () => {
  it('is safe only if versioning never was on, or old versions expire within a day', () => {
    expect(versioningIsSafe({ kind: 'never-enabled' })).toBe(true);
    expect(versioningIsSafe({ kind: 'versioned', noncurrentExpireDays: 1 })).toBe(true);
    expect(versioningIsSafe({ kind: 'versioned', noncurrentExpireDays: 2 })).toBe(false);
    expect(versioningIsSafe({ kind: 'versioned', noncurrentExpireDays: null })).toBe(false);
    expect(versioningIsSafe({ kind: 'unsupported' })).toBe(false);
  });

  it('fails closed when the check is enforced and the store is unsafe, unsupported or errors', async () => {
    const store = new InMemoryObjectStore();
    store.versioningState = { kind: 'versioned', noncurrentExpireDays: 30 };
    await expect(
      assertVersioningSafe(store, { RETENTION_VERSIONING_CHECK: 'enforce' }),
    ).rejects.toBeInstanceOf(VersioningUnsafeError);
    store.versioningState = { kind: 'unsupported' };
    await expect(
      assertVersioningSafe(store, { RETENTION_VERSIONING_CHECK: 'enforce' }),
    ).rejects.toBeInstanceOf(VersioningUnsafeError);
    jest.spyOn(store, 'versioning').mockRejectedValue(new Error('x'));
    await expect(
      assertVersioningSafe(store, { RETENTION_VERSIONING_CHECK: 'enforce' }),
    ).rejects.toBeInstanceOf(VersioningUnsafeError);
  });

  it('staging may skip the check by configuration; a safe store passes', async () => {
    const store = new InMemoryObjectStore();
    store.versioningState = { kind: 'unsupported' };
    await expect(
      assertVersioningSafe(store, { RETENTION_VERSIONING_CHECK: 'skip' }),
    ).resolves.toBeUndefined();
    store.versioningState = { kind: 'never-enabled' };
    await expect(
      assertVersioningSafe(store, { RETENTION_VERSIONING_CHECK: 'enforce' }),
    ).resolves.toBeUndefined();
  });
});
