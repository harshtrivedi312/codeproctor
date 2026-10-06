// guardLive when the generated `SessionStatus` enum has NO `ERASED` (main today, before PR #91, ADR 0004
// section 9). The generated enums module is replaced by one with ERASED removed, so the spec means the same
// after #91 lands, and the real `guardLive` export is run, not the injectable inner function: the
// load-time detection leaves the exclusion and the ERASED checks out. No row can be ERASED on such a
// database, so the behaviour is equivalent. Its twin session-locks-enum-erased.spec.ts covers the other
// mode. Fake transaction, no database. FR-704, NFR-04, TC-008.
import { SessionStatus } from '../generated/prisma/enums.js';
import { guardLive, lockAnySession, lockForAccommodation } from './session-locks';
import type { SessionLockTx, SessionLockWhere } from './session-locks';

jest.mock('../generated/prisma/enums.js', () => {
  const actual = jest.requireActual<typeof import('../generated/prisma/enums.js')>(
    '../generated/prisma/enums.js',
  );
  const withoutErased = Object.fromEntries(
    Object.entries(actual.SessionStatus).filter(([name]) => name !== 'ERASED'),
  );
  return { ...actual, SessionStatus: withoutErased };
});

const SID = '33333333-3333-4333-8333-333333333333';

function fakeTx(reads: readonly SessionStatus[], counts: readonly number[]) {
  const wheres: SessionLockWhere[] = [];
  let r = 0;
  let u = 0;
  const tx: SessionLockTx = {
    session: {
      findUnique: () => {
        const status = reads[Math.min(r, reads.length - 1)] as SessionStatus;
        r += 1;
        return Promise.resolve({ status });
      },
      updateMany: (args) => {
        wheres.push(args.where);
        const count = counts[u] ?? 0;
        u += 1;
        return Promise.resolve({ count });
      },
    },
  };
  return { tx, wheres };
}

describe('guardLive with an enum that has no ERASED (the real export, ADR 0013 section 5.7)', () => {
  it('TC-008 the mocked enum really has no ERASED (the premise of this spec)', () => {
    expect(Object.hasOwn(SessionStatus, 'ERASED')).toBe(false);
    expect(Object.values(SessionStatus)).toContain('IN_PROGRESS');
  });

  it('TC-008 the update has no exclusion: the where is { id, status } and nothing else', async () => {
    const { tx, wheres } = fakeTx(['IN_PROGRESS'], [1]);
    await expect(guardLive(tx, SID)).resolves.toBe('LIVE');
    expect(wheres).toEqual([{ id: SID, status: 'IN_PROGRESS' }]);
    expect(Object.hasOwn(wheres[0] ?? {}, 'NOT')).toBe(false);
  });

  it('TC-008 every status that exists is locked and returns LIVE', async () => {
    for (const status of Object.values(SessionStatus)) {
      const { tx, wheres } = fakeTx([status], [1]);
      await expect(guardLive(tx, SID)).resolves.toBe('LIVE');
      expect(wheres).toEqual([{ id: SID, status }]);
    }
  });

  it('TC-008 0 rows, then the re-read: retries on the new status and returns LIVE, never ERASED', async () => {
    const { tx, wheres } = fakeTx(['OPENED', 'CONSENTED'], [0, 1]);
    await expect(guardLive(tx, SID)).resolves.toBe('LIVE');
    expect(wheres.map((w) => w.status)).toEqual(['OPENED', 'CONSENTED']);
  });

  it.each([
    ['lockForAccommodation', lockForAccommodation],
    ['lockAnySession', lockAnySession],
  ] as const)('TC-008 %s has the same where as guardLive here', async (_name, lock) => {
    const { tx, wheres } = fakeTx(['COMPLETED'], [1]);
    await expect(lock(tx, SID)).resolves.toBe('COMPLETED');
    expect(wheres).toEqual([{ id: SID, status: 'COMPLETED' }]);
  });
});
